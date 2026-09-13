/**
 * Queue consumer: emails, webhooks, calendar sync.
 *
 * Everything here happens AFTER a booking is committed (ADR-0002 §2), so a
 * failure means a missing email or a delayed calendar entry — never a lost
 * booking. That is why each message is acked or retried individually rather
 * than failing the whole batch.
 */

import type { EnginePorts, ExternalEvent, QueueMessage, Repositories } from '../../ports.js'
import type { Booking, CalendarConnection, EventType, User } from '../../core/domain/types.js'
import { calendarDescription, calendarTitle, participantsFor, type Participant } from '../../core/domain/calendar-text.js'
import { hostSettings } from '../../core/domain/hosts.js'
import { CalendarApiError, needsReconnect } from '../oauth.js'
import { notifyBookingCreated, notifyBookingRescheduled } from '../notify.js'

// Attempts happen at t=0, 2m, 5m, 30m and 2h. Values are the delay from
// each failed delivery to the next one, not absolute times from the booking.
const CALENDAR_CREATE_RETRY_DELAYS_SECONDS = [120, 180, 1_500, 5_400] as const

class RetryableCalendarSyncError extends Error {
  constructor() {
    super('calendar synchronization requires another attempt')
    this.name = 'RetryableCalendarSyncError'
  }
}

class ConfirmationBusyError extends Error {}

export async function handleQueueBatch(batch: MessageBatch, ports: EnginePorts): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleOne(message.body as QueueMessage, ports, message.attempts)
      message.ack()
    } catch (err) {
      // Retry individually: one bad webhook endpoint must not hold up
      // everyone else's confirmation emails.
      console.error('[punctual] queue message failed', err)
      const delaySeconds = err instanceof ConfirmationBusyError ? 300 :
        err instanceof RetryableCalendarSyncError
          ? CALENDAR_CREATE_RETRY_DELAYS_SECONDS[message.attempts - 1]
          : undefined
      if (delaySeconds === undefined) message.retry()
      else message.retry({ delaySeconds })
    }
  }
}

export async function handleOne(
  msg: QueueMessage,
  ports: EnginePorts,
  // Zero means an inline/fallback call with no delayed queue available.
  deliveryAttempt = 0,
): Promise<void> {
  switch (msg.kind) {
    case 'email':
      await ports.email.send(msg.message)
      return

    case 'webhook':
      await deliverWebhook(msg, ports)
      return

    case 'calendar.sync':
      await syncCalendar(msg, ports, deliveryAttempt)
      return
  }
}

/**
 * Deliver a webhook with an HMAC signature.
 *
 * The signature covers `timestamp.body` rather than the body alone, so a
 * captured payload cannot be replayed indefinitely — the receiver rejects an
 * old timestamp even though the signature is valid.
 */
async function deliverWebhook(
  msg: Extract<QueueMessage, { kind: 'webhook' }>,
  ports: EnginePorts,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'unconstrained' })
  const webhook = await repos.webhooks.byId(msg.webhookId)
  if (!webhook || !webhook.active) return

  const body = JSON.stringify({ event: msg.event, data: msg.payload })
  const timestamp = Math.floor(ports.clock.now() / 1000)
  const signature = await hmacHex(webhook.secret, `${timestamp}.${body}`)

  const res = await fetch(webhook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-punctual-event': msg.event,
      'x-punctual-timestamp': String(timestamp),
      'x-punctual-signature': `sha256=${signature}`,
    },
    body,
  })

  if (!res.ok) {
    throw new Error(`webhook ${webhook.url} returned ${res.status}`)
  }
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Push the booking to the hosts' external calendars.
 *
 * ONE event per booking per provider (ADR-0011). For each provider, the
 * first host in booking order with a writable, healthy connection is the
 * organizer: their connection creates the event, and every host who belongs
 * on that provider is an attendee of it — so co-hosts see each other and
 * each other's responses on one shared event, instead of N events each
 * inviting the other N-1. A host with connections only on the other
 * provider is an attendee there instead; a host with no connection at all
 * is listed on the primary provider's event by address — which lands on
 * their calendar only if that address is an account there (Google sends
 * no email under sendUpdates=none), so it is a courtesy rather than the
 * delivery path. Optional hosts are flagged optional in the invite.
 *
 * Per-provider failure is tolerated: the organizer's expired Google token
 * must not stop the event landing in Outlook.
 *
 * `externalEventIds` stays keyed by connection id. Cancel and reschedule
 * walk the STORED ids rather than re-deriving the plan, so bookings written
 * before this change — one event per host connection — still cancel and
 * move correctly.
 */
async function syncCalendar(
  msg: Extract<QueueMessage, { kind: 'calendar.sync' }>,
  ports: EnginePorts,
  deliveryAttempt: number,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const booking = await repos.bookings.byId(msg.bookingId)
  if (!booking) return
  // Never POST for an abandoned booking, including retries of ambiguous writes.
  if (msg.action === 'delete' || booking.status !== 'confirmed') {
    await removeCalendarEvents(booking, repos, ports)
    return
  }
  // Looked up here, not earlier: a DELETE needs only externalEventIds, and
  // bailing on a missing event type meant deleting an event type stranded its
  // bookings' calendar entries forever.
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return
  // Accumulated across every provider, then persisted once.
  const createdIds: Record<string, string> = { ...booking.externalEventIds }

  const plan = await planInvites(repos, booking, eventType)
  const priorTargets = await repos.bookings.calendarTargets(booking.id)
  let unavailableTarget = false
  // A settings change must not move a retry to a different calendar and leave
  // the original, possibly committed write behind.
  const savedEvents: typeof plan.events = []
  for (const target of priorTargets) {
    const conn = await repos.connections.byId(target.connectionId)
    if (!conn) { unavailableTarget = true; continue }
    const attendees = plan.events.find((e) => e.conn.provider === conn.provider)?.attendees
      ?? await legacyAttendees(repos, booking, conn)
    savedEvents.push({ conn: { ...conn, calendarIdWrite: target.calendarId }, attendees })
  }
  const targets = [
    ...savedEvents,
    ...plan.events.filter((e) => !unavailableTarget && !savedEvents.some((s) => s.conn.provider === e.conn.provider)),
  ]

  // The first conference link any provider minted. One per booking, not per
  // event: it is the link the GUEST is told to join, and a guest has one
  // meeting to attend however many calendars it was written to.
  let conferenceUrl: string | null = booking.conferenceUrl
  // Tracked separately from `conferenceUrl`: a room that is still being
  // provisioned returns no URL yet, and keying only on the URL meant the next
  // event asked for a SECOND room — so two hosts ended up in different
  // meetings once both resolved. Asked-once is the invariant, not
  // captured-once.
  let conferenceRequested = booking.conferenceUrl !== null
  // Kept so a cancel that raced this pass can be cleaned up below. Waiting
  // for Google to provision a Meet room added up to a second between the
  // event existing in the provider and its id being persisted — long enough
  // for a delete sync to run against a still-empty id map, delete nothing,
  // and leave a real calendar event nothing can ever remove.
  const freshlyCreated: Array<{ conn: CalendarConnection; externalId: string }> = []
  let retryableCreateFailure = unavailableTarget

  // One title and one description for every copy of this meeting, naming
  // the people and their companies (core/domain/calendar-text.ts).
  const title = calendarTitle(eventType, plan.participants)
  const description = calendarDescription(eventType, booking, plan.participants)
  const externalFor = (conn: CalendarConnection, attendees: ExternalEvent['attendees']): ExternalEvent => {
    // The connection's account owns the provider event already. Listing that
    // same address as an attendee makes Google propagate a second copy to the
    // account's primary calendar when the organizer calendar is secondary.
    const ownerEmail = conn.providerAccountEmail.trim().toLowerCase()
    const providerAttendees = attendees.filter((attendee) => attendee.email.trim().toLowerCase() !== ownerEmail)
    return {
      title,
      description,
      start: booking.startUtc,
      end: booking.endUtc,
      idempotencyKey: booking.id,
      attendees: providerAttendees,
      timezone: plan.organizerTz.get(conn.id) ?? booking.guestTimezone,
      // Mint a conference only until ONE exists for this booking; every later
      // event reuses it as the location instead.
      createConference: eventType.locationType === 'google_meet' && !conferenceRequested,
      location:
        eventType.locationType === 'in_person'
          ? (eventType.locationValue ?? undefined)
          : (conferenceUrl ?? undefined),
    }
  }

  /**
   * Create the events a plan calls for that do not exist yet, keeping their
   * ids and the conference link. Shared by create and update: a host put
   * on a booking after the fact (core/domain/booking-hosts.ts) can be the
   * first host with a calendar on their provider, and that provider then
   * needs its one event just as it would have at booking time.
   */
  const createMissing = async (targets: typeof plan.events): Promise<void> => {
    for (const target of targets) {
      const { conn, attendees } = target
      // Queues is at-least-once, so this message can arrive twice. Without
      // this guard a redelivery creates a SECOND real calendar event and
      // overwrites the first id, leaving it unreachable by every delete
      // path — a permanent phantom on the host's calendar.
      if (booking.externalEventIds[conn.id]) continue
      // A definitive rejection remains final when only email delivery retries.
      // Recreating here could duplicate the host's already-enqueued fallback ICS.
      if (msg.action === 'create' && priorTargets.some((t) => t.connectionId === conn.id && !t.uncertain)) continue
      // Queue delays are approximate: check this delivery, not only the next retry.
      if (ports.clock.now() >= booking.startUtc) continue
      // A sixth queue delivery can be an EMAIL retry after the fifth calendar
      // attempt. It must not silently restart the exhausted calendar schedule.
      if (msg.action === 'create' && deliveryAttempt > 5) {
        retryableCreateFailure = true
        continue
      }
      // If persistence fails, do not call the provider: cancellation needs
      // this intent even when POST commits but its response disappears.
      await repos.bookings.rememberCalendarTarget(booking.id, conn.id, conn.calendarIdWrite!)
      try {
        const external = externalFor(conn, attendees)
        if (external.createConference === true) conferenceRequested = true
        const result = await ports.calendars.get(conn.provider).createEvent(conn, external)
        // Keep the id: reschedule and cancel need it, and without it a
        // cancelled meeting stays on the host's real calendar forever.
        createdIds[conn.id] = result.id
        freshlyCreated.push({ conn, externalId: result.id })
        // Captured on the first event that mints one; `createConference`
        // above is false from here on, so nothing re-mints.
        if (!conferenceUrl && result.conferenceUrl) conferenceUrl = result.conferenceUrl
      } catch (err) {
        console.error(`[punctual] calendar sync failed for connection ${conn.id}`, err)
        // A revoked grant will fail every future sync too; record it so the
        // host is prompted rather than quietly losing calendar writes.
        if (needsReconnect(err)) {
          await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
        }
        if (isRetryableCalendarError(err)) retryableCreateFailure = true
        else if (!priorTargets.some((t) => t.connectionId === conn.id && t.uncertain)) {
          await repos.bookings.rejectCalendarTarget(booking.id, conn.id)
        }
      }
    }
  }

  /**
   * Re-read before persisting: the booking may have been cancelled while
   * this pass was talking to the provider. Persisting ids onto a cancelled
   * booking is worse than useless — the delete sync has already run and
   * found nothing, so nothing would ever remove these events. Removes what
   * this pass created and reports true when that happened.
   */
  const abandonedIfCancelled = async (): Promise<boolean> => {
    const current = await repos.bookings.byId(booking.id)
    if (!current || current.status === 'confirmed') return false
    // Keep discovered ids BEFORE deletion. A failing DELETE must retain a
    // recoverable task rather than ACK a stranded event.
    await repos.bookings.setExternalEventIds(booking.id, createdIds)
    await removeCalendarEvents({ ...current, externalEventIds: createdIds }, repos, ports)
    return true
  }

  if (msg.action === 'update') {
    const stored: Array<{ conn: CalendarConnection; externalId: string }> = []
    for (const [connId, externalId] of Object.entries(booking.externalEventIds)) {
      const conn = await repos.connections.byId(connId)
      if (conn) stored.push({ conn, externalId })
    }

    // Which stored event is each provider's ONE event (ADR-0011). Normally
    // the plan's organizer connection holds it. After a host change the
    // organizer may have left the booking: their event STAYS — the guest and
    // the remaining hosts are on it, and deleting it would pull the meeting
    // off every calendar it reached — and is adopted as that provider's
    // event, updated with the new attendee list through the departed host's
    // connection, which is still theirs. They keep a copy on their own
    // calendar and are told to decline it. Only a provider with no event at
    // all gets one created, which is also what makes a redelivered update
    // idempotent: the second pass finds the anchor and updates it.
    //
    // Any other stored event is a legacy per-host one (written before
    // ADR-0011) and keeps its own host and the guest, so an old booking's
    // reschedule does not start multiplying invitations.
    const anchor = new Map<CalendarConnection['provider'], string>()
    for (const target of plan.events) {
      const own =
        stored.find((s) => s.conn.id === target.conn.id) ??
        stored.find((s) => s.conn.provider === target.conn.provider)
      if (own) anchor.set(target.conn.provider, own.conn.id)
    }
    for (const { conn, externalId } of stored) {
      try {
        const planned =
          anchor.get(conn.provider) === conn.id
            ? plan.events.find((e) => e.conn.provider === conn.provider)?.attendees
            : undefined
        const attendees = planned ?? (await legacyAttendees(repos, booking, conn))
        await ports.calendars.get(conn.provider).updateEvent(conn, externalId, externalFor(conn, attendees))
      } catch (err) {
        console.error(`[punctual] calendar update failed for connection ${conn.id}`, err)
        if (needsReconnect(err)) {
          await repos.connections.updateSyncStatus(conn.id, 'needs_reconnect').catch(() => {})
        }
      }
    }

    await createMissing(targets.filter((t) => !anchor.has(t.conn.provider)))
    if (freshlyCreated.length === 0) return
    if (await abandonedIfCancelled()) return
    await repos.bookings.setSyncResult(booking.id, createdIds, conferenceUrl)
    return
  }

  // ---- create: one event per provider ----
  await createMissing(targets)
  // Persist whatever succeeded. Partial success is normal — one host's expired
  // token must not discard another host's event id.
  if (msg.action === 'create') {
    if (await abandonedIfCancelled()) return

    // Compare by VALUE, not key count. Counting keys meant a second create for
    // the same connection (same key, new id) looked unchanged, so the newer
    // event id was never stored and the event became undeletable.
    const changed =
      JSON.stringify(createdIds) !== JSON.stringify(booking.externalEventIds) ||
      conferenceUrl !== booking.conferenceUrl
    if (changed) await repos.bookings.setSyncResult(booking.id, createdIds, conferenceUrl)

    const retryDelaySeconds = CALENDAR_CREATE_RETRY_DELAYS_SECONDS[deliveryAttempt - 1]
    if (
      retryableCreateFailure &&
      retryDelaySeconds !== undefined &&
      ports.clock.now() + retryDelaySeconds * 1_000 < booking.startUtc
    ) {
      throw new RetryableCalendarSyncError()
    }

    // The confirmation is dispatched HERE, not by the coordinator, because
    // this is the first point that knows the conference link — and the email
    // body is rendered at enqueue time, so sending it any earlier bakes in a
    // "link to follow" that never gets followed up.
    //
    // Reached after a successful write, a permanent rejection, or the bounded
    // retry schedule. Transient failures delay confirmation until the next
    // 2m/5m/30m/2h checkpoint; after the last attempt the host gets an explicit
    // warning without a duplicate-prone .ics because the remote outcome is
    // still uncertain.
    // Throws on failure so `handleQueueBatch` retries rather than acking —
    // the calendar work above is idempotent (guarded by `externalEventIds`),
    // so redelivery is safe. Releasing the claim is `dispatchConfirmation`'s
    // job, because only it knows whether THIS attempt won one.
    const pendingTargets = await repos.bookings.calendarTargets(booking.id)
    const uncertain = retryableCreateFailure || pendingTargets.some((t) => t.uncertain && !createdIds[t.connectionId])
    await dispatchConfirmation(booking.id, ports, msg.manageToken, uncertain)
  }
}

/** Delete known and possibly committed events; retain failed work for redelivery/DLQ. */
async function removeCalendarEvents(booking: Booking, repos: Repositories, ports: EnginePorts): Promise<void> {
  const targets = await repos.bookings.calendarTargets(booking.id)
  const ids = { ...booking.externalEventIds }
  const connections = new Set([...Object.keys(ids), ...targets.map((t) => t.connectionId)])
  let failed = false
  for (const connectionId of connections) {
    const target = targets.find((t) => t.connectionId === connectionId)
    try {
      if (ids[connectionId] || target?.uncertain) {
        const live = await repos.connections.byId(connectionId)
        if (!live) throw new Error(`calendar connection ${connectionId} is unavailable for cleanup`)
        const conn = target ? { ...live, calendarIdWrite: target.calendarId } : live
        const provider = ports.calendars.get(conn.provider)
        if (ids[connectionId]) {
          await provider.deleteEvent(conn, ids[connectionId]!)
          await repos.bookings.rejectCalendarTarget(booking.id, connectionId)
        }
        else if (provider.deleteEventByBookingId) await provider.deleteEventByBookingId(conn, booking.id)
        else throw new Error(`provider ${conn.provider} needs manual cleanup of ambiguous booking ${booking.id}`)
      }
      delete ids[connectionId]
      await repos.bookings.setExternalEventIds(booking.id, ids)
      // Keep the destination as a tombstone. A create may still be in flight
      // while this deletion runs; forgetting its intent here would make a
      // later lost-response cleanup blind. Known deletions are marked settled
      // above; ambiguous Google targets can safely be deleted again.
    } catch (err) {
      failed = true
      console.error(`[punctual] calendar cleanup failed for connection ${connectionId}`, err)
      if (needsReconnect(err)) await repos.connections.updateSyncStatus(connectionId, 'needs_reconnect').catch(() => {})
    }
  }
  if (failed) throw new RetryableCalendarSyncError()
}

function isRetryableCalendarError(err: unknown): boolean {
  if (needsReconnect(err)) return false
  if (!(err instanceof CalendarApiError)) return true
  if (err.status === undefined) return true
  if (err.status === 408 || err.status === 429 || err.status >= 500) return true
  return err.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(err.body ?? '')
}

/**
 * Which connection creates each provider's event, and who is on it
 * (ADR-0011). Hosts in booking order; the first with a writable, healthy
 * connection on a provider is that provider's organizer. Attendees of a
 * provider's event: the guest, every host with a writable connection on
 * that provider (by their account email too, so a second account of theirs
 * gets the invitation as well), and — on the primary provider only — every
 * host with no writable connection anywhere, by address. Optional hosts
 * carry the flag from `event_type_hosts` as it stands now.
 *
 * The update path (a host change, or a test) matches stored events to
 * this plan by provider — see `syncCalendar` for how an event whose
 * organizer has left the booking is handled.
 */
async function planInvites(
  repos: Repositories,
  booking: Booking,
  eventType: EventType,
): Promise<{
  events: Array<{ conn: CalendarConnection; attendees: ExternalEvent['attendees'] }>
  organizerTz: Map<string, string>
  /** Everyone on the meeting — the guest, then the hosts in booking order — for the event's title and description. */
  participants: Participant[]
}> {
  const settings = await hostSettings(repos, eventType)
  const hosts: Array<{ user: User; writable: CalendarConnection[] }> = []
  for (const id of booking.hostUserIds) {
    const user = await repos.users.byId(id)
    if (!user) continue
    const writable = (await repos.connections.listForUser(id)).filter((c) => c.calendarIdWrite && c.syncStatus === 'ok')
    hosts.push({ user, writable })
  }
  const participants = participantsFor(
    eventType,
    booking,
    hosts.map((h) => ({ user: h.user, optional: settings.get(h.user.id)?.required === false })),
  )
  const providers = [...new Set(hosts.flatMap((h) => h.writable.map((c) => c.provider)))]
  const unconnected = hosts.filter((h) => h.writable.length === 0)
  const events: Array<{ conn: CalendarConnection; attendees: ExternalEvent['attendees'] }> = []
  const organizerTz = new Map<string, string>()
  providers.forEach((provider, index) => {
    const organizer = hosts.find((h) => h.writable.some((c) => c.provider === provider))
    if (!organizer) return
    const conn = organizer.writable.find((c) => c.provider === provider)!
    const attendees: ExternalEvent['attendees'] = [{ email: booking.guestEmail, name: booking.guestName }]
    const seen = new Set<string>([booking.guestEmail.toLowerCase()])
    const add = (email: string, name: string, optional: boolean) => {
      const key = email.toLowerCase()
      if (!email || seen.has(key)) return
      seen.add(key)
      attendees.push({ email, name, ...(optional ? { optional: true } : {}) })
    }
    for (const h of hosts) {
      const optional = settings.get(h.user.id)?.required === false
      const onThisProvider = h.writable.filter((c) => c.provider === provider)
      if (onThisProvider.length > 0) {
        // The organizer already owns the provider event. Their profile email
        // may be an alias of a differently named connected account; inviting
        // that alias makes Google mirror the same meeting onto the primary
        // calendar when the write target is a secondary calendar.
        if (h.user.id !== organizer.user.id) add(h.user.email, h.user.name || h.user.slug, optional)
        for (const c of onThisProvider) add(c.providerAccountEmail, h.user.name || h.user.slug, optional)
      } else if (index === 0 && unconnected.includes(h)) {
        add(h.user.email, h.user.name || h.user.slug, optional)
      }
    }
    events.push({ conn, attendees })
    organizerTz.set(conn.id, organizer.user.tz)
  })
  return { events, organizerTz, participants }
}

/** A pre-ADR-0011 event's attendee list: the guest and the connection's own host. */
async function legacyAttendees(
  repos: Repositories,
  booking: Booking,
  conn: CalendarConnection,
): Promise<ExternalEvent['attendees']> {
  const host = await repos.users.byId(conn.userId)
  return [
    { email: booking.guestEmail, name: booking.guestName },
    ...(host ? [{ email: host.email, name: host.name || host.slug }] : []),
  ]
}

/**
 * Queue this booking's confirmation after calendar sync. Durable recipient
 * checkpoints avoid resending a successfully enqueued sibling on retry.
 * Queue acceptance and D1 checkpointing are not a distributed transaction:
 * an acknowledgement lost in that narrow window can still duplicate email.
 *
 * Ownership of this moved out of the coordinator: the coordinator
 * fires immediately after commit, which is BEFORE any calendar event exists,
 * and the email body is rendered at enqueue time — so the link could never
 * make it in from there no matter how the queue happened to interleave.
 *
 * Exported so a route can fall back to it directly when its queue send
 * fails: for a reschedule that message is now the ONLY one, so losing it
 * would cost the guest both the calendar event and the email. The claim
 * inside makes the fallback and a later redelivery mutually exclusive.
 *
 * The manage token arrives on the message rather than being re-issued here.
 * Re-issuing looks safer — only the hash is stored, so the raw token is
 * otherwise unrecoverable — but it is actively wrong: the coordinator hands
 * that same token to the just-booked page, whose "Reschedule or cancel"
 * button embeds it, so rotating the stored hash kills a link the guest is
 * already looking at, seconds after they were shown it. And carrying it adds
 * no exposure: the rendered confirmation email already contains this token
 * and is itself a queue message.
 */
export async function dispatchConfirmation(
  bookingId: string,
  ports: EnginePorts,
  manageToken: string | undefined,
  // A route fallback after a failed enqueue cannot prove the queue rejected
  // the sync. Only syncCalendar supplies a definitive false explicitly.
  calendarSyncUncertain = true,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })

  const booking = await repos.bookings.byId(bookingId)
  if (!booking || booking.status !== 'confirmed') return
  const eventType = await repos.eventTypes.byId(booking.eventTypeId)
  if (!eventType) return
  const host = await repos.users.byId(booking.hostUserId)
  if (!host) return
  const hosts = (await Promise.all(booking.hostUserIds.map((id) => repos.users.byId(id)))).filter(
    (u): u is NonNullable<typeof u> => u !== null,
  )

  // A reschedule's replacement leg gets the "Rescheduled" mail, not
  // "Confirmed" — `notifyBookingCreated` early-returns on `rescheduleOf` for
  // exactly this reason, so branching here is what makes the new leg's link
  // reach the guest at all.
  let previous: Booking | null = null
  if (booking.rescheduleOf) {
    previous = await repos.bookings.byId(booking.rescheduleOf)
    if (!previous) return
    // Only the reschedule that actually WON may mail, and only once the win
    // is recorded. Two racing reschedules both create a replacement, but
    // `markRescheduled` lets exactly one point the original at its
    // replacement; the loser is cancelled moments later by its own route.
    //
    // This is ALSO not-yet-landed on the first pass: on the inline
    // (no-TASKS) path the sync runs synchronously inside `coordinator.book`,
    // before the route has marked anything. Declining here — crucially
    // WITHOUT claiming — is what lets the route's second pass do the real
    // notification. Claiming first would burn the one claim on a pass that
    // deliberately sends nothing, and the reschedule mail would never go out.
    if (previous.rescheduledTo !== booking.id) return
  }

  // Claimed as late as possible, but still before sending: Queues is
  // at-least-once, so a redelivery must not send a second confirmation.
  const claimAt = ports.clock.now()
  const claim = await repos.bookings.claimConfirmation(bookingId, claimAt)
  if (claim === 'busy') throw new ConfirmationBusyError('confirmation dispatch is leased by another delivery')
  if (!claim) return
  const enqueueConfirmation = async (audience: 'guest' | 'host', message: QueueMessage) => {
    if (await repos.bookings.confirmationRecipientQueued(bookingId, audience)) return
    await ports.queue.send(message)
    await repos.bookings.markConfirmationRecipientQueued(bookingId, audience, ports.clock.now())
  }

  // Released ONLY on a claim this attempt won. Releasing from an outer catch
  // was wrong in a way that undoes the migration backfill: an attempt that
  // threw BEFORE claiming would clear a claim someone else holds — including
  // the one the backfill wrote for a booking the old code path had already
  // confirmed — and the retry would then send that guest a second
  // confirmation for a meeting they already know about.
  try {
    if (previous) {
      await notifyBookingRescheduled({
        ports,
        booking,
        previous,
        eventType,
        host,
        hosts,
        enqueueConfirmation,
        ...(manageToken ? { manageToken } : {}),
        ...(calendarSyncUncertain ? { calendarSyncUncertain: true } : {}),
      })
      await repos.bookings.completeConfirmation(bookingId, claimAt)
      return
    }
    await notifyBookingCreated({
      ports,
      booking,
      eventType,
      host,
      hosts,
      enqueueConfirmation,
      ...(manageToken ? { manageToken } : {}),
      ...(calendarSyncUncertain ? { calendarSyncUncertain: true } : {}),
    })
    await repos.bookings.completeConfirmation(bookingId, claimAt)
  } catch (err) {
    await repos.bookings.releaseConfirmationClaim(bookingId, claimAt).catch(() => {})
    throw err
  }
}
