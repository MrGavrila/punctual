/**
 * The calendar-sync handler, which now owns confirmation dispatch.
 *
 * `syncCalendar` had NO test coverage at all before this. That was tolerable
 * while it only wrote calendar events; it is not now that a guest's
 * confirmation email — and the meeting link inside it — depends on this code
 * path running and reaching its end.
 *
 * The properties worth pinning are the ones that were argued about while
 * designing the move:
 *   - the link the provider minted is captured and persisted
 *   - the confirmation is dispatched exactly once, even though Queues is
 *     at-least-once and redelivers this very handler
 *   - a transient calendar outage follows the bounded retry schedule, while a
 *     final attempt and a host with no writable connection still dispatch
 */

import { describe, expect, it, vi } from 'vitest'
import type { Booking, CalendarConnection, EventType, EventTypeHost, User } from '../../src/core/domain/types.js'
import type { EnginePorts, QueueMessage } from '../../src/ports.js'
import { CalendarApiError } from '../../src/adapters/oauth.js'
import { dispatchConfirmation, handleOne, handleQueueBatch } from '../../src/adapters/queue/consumer.js'

const MEET = 'https://meet.google.com/abc-defg-hij'

const host: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'UTC',
  slug: 'grace',
  avatarKey: null,
  company: null,
  jobTitle: null,
  companyUrl: null,
  role: 'member',
  createdAt: 0,
}

const eventType: EventType = {
  id: 'et_1',
  ownerUserId: 'u_host',
  ownerTeamId: null,
  schedulingType: 'personal',
  slug: 'intro',
  title: 'Intro call',
  description: '',
  durationMinutes: 30,
  slotIntervalMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxHorizonDays: 60,
  maxPerDay: null,
  locationType: 'google_meet',
  locationValue: null,
  questions: [],
  active: true,
  createdAt: 0,
  scheduleId: null,
}

function connection(over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn_1',
    userId: 'u_host',
    provider: 'google',
    providerAccountEmail: 'grace@example.com',
    encryptedTokens: 'x',
    keyVersion: 1,
    calendarIdsRead: ['primary'],
    calendarIdWrite: 'primary',
    syncStatus: 'ok',
    createdAt: 0,
    ...over,
  }
}

interface HarnessOptions {
  connections?: CalendarConnection[]
  createEvent?: () => Promise<{ id: string; conferenceUrl?: string }>
  bookingPatch?: Partial<Booking>
  /** Extra users beyond `host`, by id — a team booking's co-hosts. */
  users?: User[]
  /** Connections per user id; a user absent here falls back to `connections`. */
  connectionsByUser?: Record<string, CalendarConnection[]>
  eventTypePatch?: Partial<EventType>
  /** The event type's explicit host set (optional flags). */
  hostRows?: EventTypeHost[]
}

/**
 * Only the ports this handler touches. Anything else throws rather than
 * returning a plausible empty value, matching `testing/fakes.ts`'s rule that
 * a silently-succeeding stub turns a real bug into a passing test.
 */
function harness(opts: HarnessOptions = {}) {
  const booking: Booking = {
    id: 'bk_1',
    eventTypeId: 'et_1',
    hostUserId: 'u_host',
    hostUserIds: ['u_host'],
    guestName: 'Ada',
    guestEmail: 'ada@example.com',
    guestTimezone: 'UTC',
    startUtc: Date.UTC(2026, 8, 10, 9, 0),
    endUtc: Date.UTC(2026, 8, 10, 9, 30),
    localDate: '2026-09-10',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    conferenceUrl: null,
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'hash',
    cancelledAt: null,
    createdAt: Date.UTC(2026, 8, 1),
    ...opts.bookingPatch,
  }

  const store: { booking: Booking; previous: Booking | null } = { booking, previous: null }
  let claimed = false
  const recipients = new Set<string>()
  const calendarTargets = new Map<string, { connectionId: string; calendarId: string; uncertain: boolean }>()
  let rotated = false
  const queued: QueueMessage[] = []

  const createEvent = vi.fn(opts.createEvent ?? (async () => ({ id: 'evt_1', conferenceUrl: MEET })))
  const deleteEvent = vi.fn(async () => {})
  const deleteEventByBookingId = vi.fn(async (_conn: CalendarConnection, _bookingId: string) => {})
  const updateEvent = vi.fn(async () => {})

  const ports = {
    clock: { now: () => Date.UTC(2026, 8, 1) },
    crypto: { randomToken: (n = 16) => 'r'.repeat(n), hash: async (v: string) => `h:${v}`, sign: async () => 'sig' },
    config: { baseUrl: 'https://punctual.test', brandName: 'Punctual', supportEmail: 'help@punctual.test' },
    calendars: { get: () => ({ createEvent, updateEvent, deleteEvent, deleteEventByBookingId }) },
    queue: { send: async (m: QueueMessage) => void queued.push(m) },
    repositories: () => ({
      bookings: {
        async byId(id: string) {
          if (id === store.booking.id) return store.booking
          return store.previous && id === store.previous.id ? store.previous : null
        },
        async setSyncResult(_id: string, ids: Record<string, string>, conferenceUrl: string | null) {
          store.booking = { ...store.booking, externalEventIds: ids, conferenceUrl }
        },
        async setExternalEventIds(_id: string, ids: Record<string, string>) {
          store.booking = { ...store.booking, externalEventIds: ids }
        },
        async claimConfirmation() {
          if (claimed) return false
          claimed = true
          return true
        },
        async rotateManageToken() { rotated = true },
        async releaseConfirmationClaim() { claimed = false },
        async completeConfirmation() {},
        async confirmationRecipientQueued(_id: string, audience: string) { return recipients.has(audience) },
        async markConfirmationRecipientQueued(_id: string, audience: string) { recipients.add(audience) },
        async calendarTargets() { return [...calendarTargets.values()].map((t) => ({ ...t })) },
        async rememberCalendarTarget(_id: string, connectionId: string, calendarId: string) {
          calendarTargets.set(connectionId, { connectionId, calendarId: calendarTargets.get(connectionId)?.calendarId ?? calendarId, uncertain: true })
        },
        async rejectCalendarTarget(_id: string, connectionId: string) {
          const target = calendarTargets.get(connectionId)
          if (target) target.uncertain = false
        },
      },
      eventTypes: { async byId() { return { ...eventType, ...opts.eventTypePatch } } },
      eventTypeHosts: { async forEventType() { return opts.hostRows ?? [] } },
      users: {
        async byId(id: string) {
          if (id === host.id) return host
          return opts.users?.find((u) => u.id === id) ?? null
        },
      },
      connections: {
        async listForUser(userId: string) {
          return opts.connectionsByUser?.[userId] ?? (userId === host.id ? (opts.connections ?? [connection()]) : [])
        },
        async byId(id: string) {
          const all = [...(opts.connections ?? [connection()]), ...Object.values(opts.connectionsByUser ?? {}).flat()]
          return all.find((c) => c.id === id) ?? null
        },
        async updateSyncStatus() {},
      },
      webhooks: { async listForUser() { return [] } },
    }),
  } as unknown as EnginePorts

  const sync = { kind: 'calendar.sync', bookingId: 'bk_1', action: 'create', manageToken: 'tok_from_coordinator' } as const
  return {
    ports,
    store,
    queued,
    createEvent,
    sync,
    wasRotated: () => rotated,
    deleteEvent,
    deleteEventByBookingId,
    updateEvent,
    setPrevious: (b: Booking) => {
      store.previous = b
    },
    emails: () => queued.filter((m) => m.kind === 'email'),
  }
}

/** A bare harness, only for borrowing its default booking shape. */
function h0() {
  return harness()
}

const bob: User = { ...host, id: 'u_bob', email: 'bob@example.com', name: 'Bob Chen', slug: 'bob', tz: 'Europe/Kyiv' }
const carol: User = { ...host, id: 'u_carol', email: 'carol@example.com', name: 'Carol Diaz', slug: 'carol' }
const teamPatch: Partial<EventType> = { ownerUserId: null, ownerTeamId: 't_1', schedulingType: 'collective' }
type Attendee = { email: string; name?: string; optional?: boolean }
const attendeesOf = (call: unknown[]) => (call[1] as { attendees: Attendee[] }).attendees

describe('one event per booking per provider (ADR-0011)', () => {
  it('does not invite the organizing account to its own provider event', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)

    expect(h.createEvent).toHaveBeenCalledTimes(1)
    expect(attendeesOf(h.createEvent.mock.calls[0] as unknown[]).map((a) => a.email)).toEqual([
      'ada@example.com',
    ])
  })

  it('passes the booking id as the provider create idempotency key', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)

    const event = (h.createEvent.mock.calls[0] as unknown[])[1] as { idempotencyKey?: string }
    expect(event.idempotencyKey).toBe('bk_1')
  })

  it('three hosts on one provider: ONE event, with the guest and every other host on it', async () => {
    const h = harness({
      users: [bob, carol],
      connectionsByUser: {
        u_host: [connection()],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', providerAccountEmail: 'bob@example.com' })],
        u_carol: [connection({ id: 'conn_carol', userId: 'u_carol', providerAccountEmail: 'carol@example.com' })],
      },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob', 'u_carol'] },
      eventTypePatch: teamPatch,
    })
    await handleOne(h.sync, h.ports)

    expect(h.createEvent).toHaveBeenCalledTimes(1)
    const [conn] = h.createEvent.mock.calls[0]! as unknown as [CalendarConnection]
    expect(conn.id).toBe('conn_1')
    expect(attendeesOf(h.createEvent.mock.calls[0] as unknown[]).map((a) => a.email)).toEqual([
      'ada@example.com',
      'bob@example.com',
      'carol@example.com',
    ])
    expect(Object.keys(h.store.booking.externalEventIds)).toEqual(['conn_1'])
  })

  it("hosts split across providers: one event each, every host on their own provider's event only", async () => {
    const h = harness({
      users: [bob, carol],
      connectionsByUser: {
        u_host: [connection()],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', provider: 'microsoft', providerAccountEmail: 'bob@example.com' })],
        u_carol: [], // no calendar at all — rides on the primary provider's event
      },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob', 'u_carol'] },
      eventTypePatch: teamPatch,
    })
    await handleOne(h.sync, h.ports)

    expect(h.createEvent).toHaveBeenCalledTimes(2)
    const google = h.createEvent.mock.calls.find((c) => ((c as unknown[])[0] as CalendarConnection).provider === 'google')! as unknown[]
    const microsoft = h.createEvent.mock.calls.find((c) => ((c as unknown[])[0] as CalendarConnection).provider === 'microsoft')! as unknown[]
    expect(attendeesOf(google).map((a) => a.email)).toEqual(['ada@example.com', 'carol@example.com'])
    expect(attendeesOf(microsoft).map((a) => a.email)).toEqual(['ada@example.com'])
    expect((microsoft[1] as { timezone: string }).timezone).toBe('Europe/Kyiv')
  })

  it("an optional host is flagged optional; a host's second account on the same provider is an attendee by its email", async () => {
    const h = harness({
      users: [bob],
      connectionsByUser: {
        u_host: [connection(), connection({ id: 'conn_1b', providerAccountEmail: 'grace.work@example.com' })],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', providerAccountEmail: 'bob@example.com' })],
      },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob'] },
      eventTypePatch: teamPatch,
      hostRows: [
        { eventTypeId: 'et_1', userId: 'u_host', required: true, scheduleId: null, rrWeight: null, position: 0 },
        { eventTypeId: 'et_1', userId: 'u_bob', required: false, scheduleId: null, rrWeight: null, position: 1 },
      ],
    })
    await handleOne(h.sync, h.ports)

    expect(h.createEvent).toHaveBeenCalledTimes(1)
    const attendees = attendeesOf(h.createEvent.mock.calls[0] as unknown[])
    expect(attendees.map((a) => [a.email, a.optional ?? false])).toEqual([
      ['ada@example.com', false],
      ['grace.work@example.com', false],
      ['bob@example.com', true],
    ])
  })

  it('cancelling a booking written before this change (one event per host connection) still removes both', async () => {
    const h = harness({
      users: [bob],
      connectionsByUser: {
        u_host: [connection()],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', providerAccountEmail: 'bob@example.com' })],
      },
      bookingPatch: {
        hostUserIds: ['u_host', 'u_bob'],
        status: 'cancelled',
        externalEventIds: { conn_1: 'evt_a', conn_bob: 'evt_b' },
      },
      eventTypePatch: teamPatch,
    })
    await handleOne({ ...h.sync, action: 'delete' }, h.ports)

    expect(h.deleteEvent).toHaveBeenCalledTimes(2)
    expect(h.deleteEvent.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['evt_a', 'evt_b'])
    expect(h.store.booking.externalEventIds).toEqual({})
  })

  it('a reschedule updates each legacy per-host event without inviting its calendar owner', async () => {
    const h = harness({
      users: [bob],
      connectionsByUser: {
        u_host: [connection()],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', providerAccountEmail: 'bob@example.com' })],
      },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob'], externalEventIds: { conn_1: 'evt_a', conn_bob: 'evt_b' } },
      eventTypePatch: teamPatch,
    })
    await handleOne({ ...h.sync, action: 'update' }, h.ports)

    expect(h.updateEvent).toHaveBeenCalledTimes(2)
    // updateEvent(conn, externalId, event): the event is the THIRD argument.
    const byConn = new Map(h.updateEvent.mock.calls.map((c) => [((c as unknown[])[0] as CalendarConnection).id, ((c as unknown[])[2] as { attendees: Attendee[] }).attendees]))
    expect(byConn.get('conn_1')!.map((a) => a.email)).toEqual(['ada@example.com', 'bob@example.com'])
    expect(byConn.get('conn_bob')!.map((a) => a.email)).toEqual(['ada@example.com'])
  })

  it('a redelivered create makes no second event', async () => {
    const h = harness({ bookingPatch: { externalEventIds: { conn_1: 'evt_existing' } } })
    await handleOne(h.sync, h.ports)
    expect(h.createEvent).not.toHaveBeenCalled()
  })
})

describe('calendar sync captures the conference link', () => {
  it('persists the link the provider minted', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    expect(h.store.booking.conferenceUrl).toBe(MEET)
    expect(h.store.booking.externalEventIds).toEqual({ conn_1: 'evt_1' })
  })

  it('mints ONE room for a booking, whatever number of calendars it is written to', async () => {
    // Caught by review. A collective booking with two writable calendars
    // minted two Meet links: the guest was confidently sent to the first
    // while the second host sat in the other room. Every connection after
    // the first must reuse the room, not create one.
    let minted = 0
    const h = harness({
      users: [bob],
      connectionsByUser: { u_host: [connection()], u_bob: [connection({ id: 'conn_2', userId: 'u_bob', provider: 'microsoft' })] },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob'] },
      createEvent: async () => {
        minted += 1
        return { id: `evt_${minted}`, conferenceUrl: `https://meet.google.com/room-${minted}` }
      },
    })
    await handleOne(h.sync, h.ports)

    expect(h.createEvent).toHaveBeenCalledTimes(2)
    // Only the FIRST call may ask for a conference.
    const args = h.createEvent.mock.calls.map(
      (c) => (c as unknown[])[1] as { createConference?: boolean; location?: string },
    )
    const asked = args.map((a) => a.createConference)
    expect(asked).toEqual([true, false])
    // And the second event points at the room the first one minted.
    expect(args[1]!.location).toBe('https://meet.google.com/room-1')
    expect(h.store.booking.conferenceUrl).toBe('https://meet.google.com/room-1')
  })

  it('removes an event it just created if the booking was cancelled meanwhile', async () => {
    // Waiting for Google to provision a Meet room widened the gap between
    // the event existing at the provider and its id being persisted. A
    // cancel landing in that gap runs its delete sync against a still-empty
    // id map, deletes nothing, and would otherwise leave a real calendar
    // event that nothing can ever remove.
    const h = harness()
    const realRepos = h.ports.repositories
    let reads = 0
    h.ports.repositories = ((scope) => {
      const repos = realRepos(scope)
      return {
        ...repos,
        bookings: {
          ...repos.bookings,
          async byId(id: string) {
            reads += 1
            const b = await repos.bookings.byId(id)
            // Confirmed when the pass starts; cancelled by the re-read.
            return b && reads > 1 ? { ...b, status: 'cancelled' as const } : b
          },
        },
      }
    }) as typeof h.ports.repositories

    await handleOne(h.sync, h.ports)

    expect(h.createEvent).toHaveBeenCalledTimes(1)
    expect(h.deleteEvent).toHaveBeenCalledTimes(1)
    // And nothing was written onto the cancelled booking.
    expect(h.store.booking.externalEventIds).toEqual({})
    expect(h.emails()).toHaveLength(0)
  })

  it('never asks for a second room, even when the first one is still pending', async () => {
    // Keying on the captured URL was not enough: a room Google is still
    // provisioning returns no URL, so the next connection asked for its OWN
    // room and the two hosts ended up in different meetings once both
    // resolved. Asked-once is the invariant, not captured-once.
    const h = harness({
      users: [bob],
      connectionsByUser: { u_host: [connection()], u_bob: [connection({ id: 'conn_2', userId: 'u_bob', provider: 'microsoft' })] },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob'] },
      createEvent: async () => ({ id: 'evt_pending' }), // provisioned, but no link yet
    })
    await handleOne(h.sync, h.ports)

    const asked = h.createEvent.mock.calls.map(
      (c) => ((c as unknown[])[1] as { createConference?: boolean }).createConference,
    )
    expect(asked).toEqual([true, false])
  })

  it('leaves it null when the provider minted none', async () => {
    const h = harness({ createEvent: async () => ({ id: 'evt_1' }) })
    await handleOne(h.sync, h.ports)
    expect(h.store.booking.conferenceUrl).toBeNull()
  })
})

describe('confirmation dispatch', () => {
  it('sends the confirmation once the link is known', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  it('sends exactly once across a redelivery of the same message', async () => {
    // Queues is at-least-once and retries THIS handler. Without the
    // claim, the guest gets a second confirmation for one booking.
    const h = harness()
    await handleOne(h.sync, h.ports)
    const afterFirst = h.emails().length
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBe(afterFirst)
  })

  it('still dispatches when the host has no writable connection', async () => {
    // Nothing to sync at all — the loop body never runs. The guest must
    // still be told their meeting is confirmed.
    const h = harness({ connections: [] })
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
    expect(h.store.booking.conferenceUrl).toBeNull()
  })

  it('still dispatches when every calendar write throws', async () => {
    // Direct/inline handling has no delayed queue to retry through, so it is a
    // final attempt: a calendar outage must not become an email outage.
    const h = harness({
      createEvent: async () => {
        throw new Error('google is down')
      },
    })
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  /**
   * Caught by review. The coordinator hands the SAME raw token to the
   * just-booked page, whose "Reschedule or cancel" button embeds it. Rotating
   * the stored hash here killed that button seconds after the guest was shown
   * it — a link dead on arrival in the browser they are still looking at.
   */
  it('does not rotate the manage token the guest is already holding', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    expect(h.wasRotated()).toBe(false)
  })

  it('uses the token the coordinator issued, so the emailed link matches the on-screen one', async () => {
    const h = harness()
    await handleOne(h.sync, h.ports)
    const body = JSON.stringify(h.emails())
    expect(body).toContain('tok_from_coordinator')
  })

  it('releases the claim when dispatch throws, so a retry can still send', async () => {
    // Claim-before-send is what makes redelivery safe, but without a release
    // any failure after the claim strands the booking as "queued" with
    // nothing ever sent — silent non-delivery, the exact shape this area is
    // meant to be rid of.
    //
    // The failure injected here is a D1 read, because that is what actually
    // propagates. Note the limit of this guard: `notifyBookingCreated`
    // swallows individual `queue.send` failures internally
    // (notify.ts's `.catch`), so a mail provider outage is invisible to the
    // claim and is NOT recovered by it — pre-existing behaviour, worth
    // knowing rather than assuming away.
    const h = harness()
    // `syncCalendar` reads the event type first, then `dispatchConfirmation`
    // reads it again — so failing the SECOND call targets dispatch
    // specifically, after the claim has been taken.
    let calls = 0
    const realRepos = h.ports.repositories
    h.ports.repositories = ((scope) => {
      const repos = realRepos(scope)
      return {
        ...repos,
        eventTypes: {
          async byId(id: string) {
            calls += 1
            if (calls === 2) throw new Error('D1 unavailable')
            return repos.eventTypes.byId(id)
          },
        },
      }
    }) as typeof h.ports.repositories

    // Rethrows, so `handleQueueBatch` retries the message rather than acking
    // it — releasing the claim without rethrowing would have left the
    // confirmation lost exactly as silently as before.
    await expect(handleOne(h.sync, h.ports)).rejects.toThrow('D1 unavailable')
    expect(h.emails()).toHaveLength(0)

    // The retry finds the claim released and sends for real.
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  /**
   * The reschedule guard vs the inline (no-TASKS) queue path.
   *
   * Inline, `queue.send` runs the handler synchronously inside
   * `coordinator.book` — i.e. BEFORE the route calls `markRescheduled`. So
   * the first pass legitimately sees `rescheduledTo` unset and must decline
   * to mail, and the route's second pass (fired after the mark lands) is what
   * actually notifies. Getting only the first half of that shipped meant no
   * reschedule email at all on the free tier.
   */
  it('declines to mail a replacement until the reschedule has actually landed', async () => {
    const previous: Booking = { ...h0().store.booking, id: 'bk_old', rescheduledTo: null }
    const h = harness({ bookingPatch: { id: 'bk_1', rescheduleOf: 'bk_old' } })
    h.setPrevious(previous)

    await handleOne(h.sync, h.ports)
    expect(h.emails()).toHaveLength(0)

    // The route marks the move, then enqueues the replacement's create-sync
    // — one message, ordered after the mark, so it both writes the calendar
    // and mails with the link it just captured.
    h.setPrevious({ ...previous, rescheduledTo: 'bk_1' })
    await handleOne(h.sync, h.ports)
    expect(h.emails().length).toBeGreaterThan(0)
  })

  it('a failure before the claim never clears someone else\'s claim', async () => {
    // Including the claim the migration backfilled for a booking the OLD code
    // path already confirmed — clearing that would send the guest a second
    // confirmation for a meeting they already know about.
    const h = harness()
    let alreadyClaimed = true
    const realRepos = h.ports.repositories
    let released = false
    h.ports.repositories = ((scope) => {
      const repos = realRepos(scope)
      return {
        ...repos,
        bookings: {
          ...repos.bookings,
          async byId() {
            throw new Error('D1 unavailable')
          },
          async claimConfirmation() {
            return !alreadyClaimed
          },
          async releaseConfirmationClaim() {
            released = true
          },
        },
      }
    }) as typeof h.ports.repositories

    await expect(
      handleOne(h.sync, h.ports),
    ).rejects.toThrow('D1 unavailable')
    expect(released).toBe(false)
    expect(alreadyClaimed).toBe(true)
  })

  it('does not dispatch for a booking that is no longer confirmed', async () => {
    const h = harness({ bookingPatch: { status: 'cancelled' } })
    await handleOne(h.sync, h.ports)
    expect(h.emails()).toHaveLength(0)
  })

  it('the claim itself refuses a booking cancelled after the status read', async () => {
    // The status is read first, but a cancel landing between that read and
    // the claim would otherwise send "your meeting is confirmed" for a
    // booking that no longer exists. The condition lives in the UPDATE.
    const h = harness()
    const realRepos = h.ports.repositories
    h.ports.repositories = ((scope) => {
      const repos = realRepos(scope)
      return {
        ...repos,
        bookings: {
          ...repos.bookings,
          // Confirmed at read time, cancelled by the time the claim runs.
          async claimConfirmation() {
            return false
          },
        },
      }
    }) as typeof h.ports.repositories

    await handleOne(h.sync, h.ports)
    expect(h.emails()).toHaveLength(0)
  })
})

describe('calendar create retry schedule', () => {
  it('does not make a sixth calendar attempt when retrying final-warning email dispatch', async () => {
    const h = harness({ createEvent: async () => { throw new Error('provider unavailable') } })
    const send = h.ports.queue.send
    h.ports.queue.send = async (message) => {
      if (message.kind === 'email' && message.message.to === host.email) throw new Error('queue unavailable')
      await send(message)
    }
    await expect(handleOne(h.sync, h.ports, 5)).rejects.toThrow('queue unavailable')
    h.ports.queue.send = send
    await handleOne(h.sync, h.ports, 6)
    expect(h.createEvent).toHaveBeenCalledTimes(1)
    expect(h.emails()).toHaveLength(2)
  })
  it('does not attach a host ICS when the initial sync enqueue outcome is unknown', async () => {
    const h = harness()
    await dispatchConfirmation('bk_1', h.ports, 'token')
    expect(h.emails().find((m) => m.message.to === host.email)?.message.attachments).toBeUndefined()
  })
  it('retries only the failed email recipient after a partial queue failure', async () => {
    const h = harness()
    const send = h.ports.queue.send
    let failHost = true
    h.ports.queue.send = async (message) => {
      if (message.kind === 'email' && message.message.to === host.email && failHost) throw new Error('queue unavailable')
      await send(message)
    }
    await expect(handleOne(h.sync, h.ports, 1)).rejects.toThrow('queue unavailable')
    expect(h.emails().map((m) => m.message.to)).toEqual(['ada@example.com'])
    failHost = false
    await handleOne(h.sync, h.ports, 2)
    expect(h.emails().map((m) => m.message.to)).toEqual(['ada@example.com', host.email])
    expect(h.createEvent).toHaveBeenCalledTimes(1)
  })

  it('retains uncertainty when a later attempt is rejected permanently', async () => {
    const h = harness({ createEvent: async () => { throw new Error('lost response') } })
    await expect(handleOne(h.sync, h.ports, 1)).rejects.toThrow()
    h.createEvent.mockRejectedValue(new CalendarApiError('google', 'forbidden', { status: 403 }))
    await handleOne(h.sync, h.ports, 2)
    expect(h.emails().find((m) => m.message.to === host.email)?.message.attachments).toBeUndefined()
    expect(h.emails().find((m) => m.message.to === host.email)?.message.text).toContain('could not confirm whether')
  })

  it('keeps the original calendar for cleanup after settings change and retries failed DELETE', async () => {
    const conn = connection({ calendarIdWrite: 'original' })
    const h = harness({ connections: [conn], createEvent: async () => { throw new Error('lost response') } })
    await expect(handleOne(h.sync, h.ports, 1)).rejects.toThrow()
    conn.calendarIdWrite = 'replacement'
    h.store.booking.status = 'cancelled'
    h.deleteEventByBookingId.mockRejectedValueOnce(new Error('delete unavailable'))
    await expect(handleOne(h.sync, h.ports, 2)).rejects.toThrow()
    await handleOne(h.sync, h.ports, 3)
    expect(h.createEvent).toHaveBeenCalledTimes(1)
    expect(h.deleteEventByBookingId).toHaveBeenCalledTimes(2)
    expect(h.deleteEventByBookingId).toHaveBeenLastCalledWith(expect.objectContaining({ calendarIdWrite: 'original' }), 'bk_1')
    expect(await h.ports.repositories({ consistency: 'bookmark' }).bookings.calendarTargets('bk_1')).toEqual([
      { connectionId: 'conn_1', calendarId: 'original', uncertain: true },
    ])
  })

  it('retains a discovered event id if cancellation cleanup fails during creation', async () => {
    const h = harness()
    h.createEvent.mockImplementation(async () => {
      h.store.booking.status = 'cancelled'
      return { id: 'created-before-cancel', conferenceUrl: MEET }
    })
    h.deleteEvent.mockRejectedValueOnce(new Error('delete unavailable'))
    await expect(handleOne(h.sync, h.ports, 1)).rejects.toThrow()
    expect(h.store.booking.externalEventIds).toEqual({ conn_1: 'created-before-cancel' })
    await handleOne(h.sync, h.ports, 2)
    expect(h.createEvent).toHaveBeenCalledTimes(1)
    expect(h.store.booking.externalEventIds).toEqual({})
    expect(h.emails()).toEqual([])
  })
  it.each([
    [1, 120],
    [2, 180],
    [3, 1_500],
    [4, 5_400],
  ])('retries transient delivery attempt %i after %i seconds without dispatching confirmation', async (attempt, delaySeconds) => {
    const h = harness({
      createEvent: async () => {
        throw new CalendarApiError('google', 'events.insert failed', { status: 503 })
      },
    })
    const ack = vi.fn()
    const retry = vi.fn()
    const message = { body: h.sync, attempts: attempt, ack, retry }

    await handleQueueBatch({ messages: [message] } as unknown as MessageBatch, h.ports)

    expect(retry).toHaveBeenCalledWith({ delaySeconds })
    expect(ack).not.toHaveBeenCalled()
    expect(h.emails()).toHaveLength(0)
  })

  it('dispatches once without a host ICS after a later attempt creates the calendar event', async () => {
    let createAttempt = 0
    const h = harness({
      createEvent: async () => {
        createAttempt += 1
        if (createAttempt === 1) {
          throw new CalendarApiError('google', 'events.insert failed', { status: 503 })
        }
        return { id: 'evt_after_retry', conferenceUrl: MEET }
      },
    })
    const firstAck = vi.fn()
    const firstRetry = vi.fn()

    await handleQueueBatch(
      { messages: [{ body: h.sync, attempts: 1, ack: firstAck, retry: firstRetry }] } as unknown as MessageBatch,
      h.ports,
    )

    expect(firstRetry).toHaveBeenCalledWith({ delaySeconds: 120 })
    expect(firstAck).not.toHaveBeenCalled()
    expect(h.emails()).toHaveLength(0)

    const secondAck = vi.fn()
    const secondRetry = vi.fn()
    await handleQueueBatch(
      { messages: [{ body: h.sync, attempts: 2, ack: secondAck, retry: secondRetry }] } as unknown as MessageBatch,
      h.ports,
    )

    expect(secondRetry).not.toHaveBeenCalled()
    expect(secondAck).toHaveBeenCalledOnce()
    expect(h.createEvent).toHaveBeenCalledTimes(2)
    expect(h.store.booking.externalEventIds).toEqual({ conn_1: 'evt_after_retry' })
    expect(h.store.booking.conferenceUrl).toBe(MEET)
    expect(h.emails()).toHaveLength(2)
    const hostEmail = h.emails().find(
      (queued) => queued.kind === 'email' && queued.message.to === host.email,
    )
    expect(hostEmail?.kind === 'email' ? hostEmail.message.attachments : undefined).toBeUndefined()
  })

  it('removes an ambiguous event without creating it when the booking is cancelled before a retry', async () => {
    let createAttempt = 0
    const h = harness({
      createEvent: async () => {
        createAttempt += 1
        if (createAttempt === 1) {
          throw new CalendarApiError('google', 'events.insert failed', { status: 503 })
        }
        return { id: 'evt_created_before_cancel' }
      },
    })

    await handleQueueBatch(
      {
        messages: [{ body: h.sync, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
      } as unknown as MessageBatch,
      h.ports,
    )
    h.store.booking = {
      ...h.store.booking,
      status: 'cancelled',
      cancelledAt: Date.UTC(2026, 8, 1, 0, 1),
    }
    const retryAck = vi.fn()

    await handleQueueBatch(
      {
        messages: [{ body: h.sync, attempts: 2, ack: retryAck, retry: vi.fn() }],
      } as unknown as MessageBatch,
      h.ports,
    )

    expect(h.createEvent).toHaveBeenCalledTimes(1)
    expect(h.deleteEventByBookingId).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn_1' }),
      'bk_1',
    )
    expect(retryAck).toHaveBeenCalledOnce()
    expect(h.emails()).toHaveLength(0)
  })

  it('does not create an event when the first delivery sees an already-cancelled booking', async () => {
    const h = harness({ bookingPatch: { status: 'cancelled', cancelledAt: Date.UTC(2026, 8, 1) } })

    await handleQueueBatch(
      {
        messages: [{ body: h.sync, attempts: 1, ack: vi.fn(), retry: vi.fn() }],
      } as unknown as MessageBatch,
      h.ports,
    )

    expect(h.createEvent).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP 429', new CalendarApiError('google', 'events.insert failed', { status: 429 })],
    [
      'Google user rate limit',
      new CalendarApiError('google', 'events.insert failed', {
        status: 403,
        body: '{"reason":"userRateLimitExceeded"}',
      }),
    ],
  ])('retries %s as a transient provider failure', async (_label, providerError) => {
    const h = harness({
      createEvent: async () => {
        throw providerError
      },
    })
    const retry = vi.fn()

    await handleQueueBatch(
      { messages: [{ body: h.sync, attempts: 1, ack: vi.fn(), retry }] } as unknown as MessageBatch,
      h.ports,
    )

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 120 })
    expect(h.emails()).toHaveLength(0)
  })

  it('stops retrying before the meeting starts and warns without a duplicate-prone attachment', async () => {
    const now = Date.UTC(2026, 8, 1)
    const h = harness({
      bookingPatch: { startUtc: now + 60_000, endUtc: now + 31 * 60_000 },
      createEvent: async () => {
        throw new CalendarApiError('google', 'events.insert failed', { status: 503 })
      },
    })
    const ack = vi.fn()
    const retry = vi.fn()
    const message = { body: h.sync, attempts: 1, ack, retry }

    await handleQueueBatch({ messages: [message] } as unknown as MessageBatch, h.ports)

    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledOnce()
    const hostEmail = h.emails().find(
      (queued) => queued.kind === 'email' && queued.message.to === host.email,
    )
    const guestEmail = h.emails().find(
      (queued) => queued.kind === 'email' && queued.message.to === h.store.booking.guestEmail,
    )
    expect(hostEmail?.kind === 'email' ? hostEmail.message.attachments : undefined).toBeUndefined()
    expect(guestEmail?.kind === 'email' ? guestEmail.message.attachments?.[0]?.contentType : undefined)
      .toContain('method=REQUEST')
    expect(hostEmail?.kind === 'email' ? hostEmail.message.text : '').toContain(
      'could not confirm whether it reached your connected calendar',
    )
  })

  it('finishes after the fifth transient failure and warns without a duplicate-prone attachment', async () => {
    const h = harness({
      createEvent: async () => {
        throw new CalendarApiError('google', 'events.insert failed', { status: 503 })
      },
    })
    const ack = vi.fn()
    const retry = vi.fn()

    await handleQueueBatch(
      { messages: [{ body: h.sync, attempts: 5, ack, retry }] } as unknown as MessageBatch,
      h.ports,
    )

    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledOnce()
    const hostEmail = h.emails().find(
      (queued) => queued.kind === 'email' && queued.message.to === host.email,
    )
    expect(hostEmail?.kind === 'email' ? hostEmail.message.attachments : undefined).toBeUndefined()
    expect(hostEmail?.kind === 'email' ? hostEmail.message.text : '').toContain(
      'could not confirm whether it reached your connected calendar',
    )
  })

  it('does not retry a permanent provider error', async () => {
    const h = harness({
      createEvent: async () => {
        throw new CalendarApiError('google', 'events.insert failed', { status: 400 })
      },
    })
    const ack = vi.fn()
    const retry = vi.fn()

    await handleQueueBatch(
      { messages: [{ body: h.sync, attempts: 1, ack, retry }] } as unknown as MessageBatch,
      h.ports,
    )

    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledOnce()
    const hostEmail = h.emails().find(
      (queued) => queued.kind === 'email' && queued.message.to === host.email,
    )
    expect(hostEmail?.kind === 'email' ? hostEmail.message.attachments?.[0]?.contentType : undefined)
      .toContain('method=REQUEST')
  })
})

describe('an update after a host change (booking-hosts.ts)', () => {
  it('creates the missing provider event for a host added on a provider that had none', async () => {
    // Grace (Google) booked alone; Bob (Microsoft) was added afterwards.
    // Google's event is updated; Microsoft has no event yet and gets one.
    const h = harness({
      users: [bob],
      connectionsByUser: {
        u_host: [connection()],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', provider: 'microsoft', providerAccountEmail: 'bob@example.com' })],
      },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob'], externalEventIds: { conn_1: 'evt_g' }, conferenceUrl: MEET },
      eventTypePatch: teamPatch,
      createEvent: async () => ({ id: 'evt_m' }),
    })
    await handleOne({ ...h.sync, action: 'update' }, h.ports)

    expect(h.updateEvent).toHaveBeenCalledTimes(1)
    expect(((h.updateEvent.mock.calls[0] as unknown[])[2] as { attendees: Attendee[] }).attendees.map((a) => a.email)).toEqual([
      'ada@example.com',
    ])
    expect(h.createEvent).toHaveBeenCalledTimes(1)
    const [conn, event] = h.createEvent.mock.calls[0] as unknown as [CalendarConnection, { attendees: Attendee[]; location?: string; createConference: boolean }]
    expect(conn.id).toBe('conn_bob')
    expect(event.attendees.map((a) => a.email)).toEqual(['ada@example.com'])
    // The room already exists; the new event points at it rather than minting another.
    expect(event.createConference).toBe(false)
    expect(event.location).toBe(MEET)
    expect(h.store.booking.externalEventIds).toEqual({ conn_1: 'evt_g', conn_bob: 'evt_m' })
  })

  it("a departed organizer's event stays, gets the remaining hosts, and no second event is made", async () => {
    // Grace organized the Google event, then left the booking. Bob (Google)
    // is now the first host, but the provider already has its one event.
    const h = harness({
      users: [bob],
      connectionsByUser: {
        u_host: [connection()],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', providerAccountEmail: 'bob@example.com' })],
      },
      bookingPatch: { hostUserId: 'u_bob', hostUserIds: ['u_bob'], externalEventIds: { conn_1: 'evt_g' } },
      eventTypePatch: teamPatch,
    })
    await handleOne({ ...h.sync, action: 'update' }, h.ports)

    expect(h.createEvent).not.toHaveBeenCalled()
    expect(h.deleteEvent).not.toHaveBeenCalled()
    expect(h.updateEvent).toHaveBeenCalledTimes(1)
    const [conn, externalId, event] = h.updateEvent.mock.calls[0] as unknown as [CalendarConnection, string, { attendees: Attendee[] }]
    expect(conn.id).toBe('conn_1')
    expect(externalId).toBe('evt_g')
    expect(event.attendees.map((a) => a.email)).toEqual(['ada@example.com', 'bob@example.com'])
  })

  it('a redelivered update creates nothing twice', async () => {
    const h = harness({
      users: [bob],
      connectionsByUser: {
        u_host: [connection()],
        u_bob: [connection({ id: 'conn_bob', userId: 'u_bob', provider: 'microsoft', providerAccountEmail: 'bob@example.com' })],
      },
      bookingPatch: { hostUserIds: ['u_host', 'u_bob'], externalEventIds: { conn_1: 'evt_g' } },
      eventTypePatch: teamPatch,
      createEvent: async () => ({ id: 'evt_m' }),
    })
    await handleOne({ ...h.sync, action: 'update' }, h.ports)
    await handleOne({ ...h.sync, action: 'update' }, h.ports)
    expect(h.createEvent).toHaveBeenCalledTimes(1)
    expect(h.updateEvent).toHaveBeenCalledTimes(3)
  })
})
