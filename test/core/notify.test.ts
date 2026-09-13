import { describe, expect, it } from 'vitest'
import type { Booking, CalendarConnection, EventType, User } from '../../src/core/domain/types.js'
import {
  notifyBookingCancelled,
  notifyBookingCreated,
  notifyBookingRescheduled,
} from '../../src/adapters/notify.js'
import type { EnginePorts, QueueMessage } from '../../src/ports.js'

/**
 * Regression coverage for the reschedule/cancel .ics collision: a booking
 * that a reschedule has SUPERSEDED (`rescheduledTo` set) must never get a
 * CANCEL .ics attached to its cancellation email, because that CANCEL would
 * share a UID with the replacement's REQUEST and the two SEQUENCE numbers
 * cannot be made to reliably agree on which one is stale — see the design
 * note on `icsCancelSuppressed` in src/core/ics.ts.
 *
 * These tests exercise `notifyBookingCancelled` itself (not just the pure
 * `ics.ts` helpers) so a future call site that starts invoking it on a
 * superseded booking is caught here, not just in the primitives.
 */

const START = Date.UTC(2026, 7, 14, 9, 0, 0)

const host: User = {
  id: 'u_host',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  tz: 'America/New_York',
  slug: 'grace',
  avatarKey: null,
  company: null,
  jobTitle: null,
  companyUrl: null,
  role: 'member',
  createdAt: 0,
}

function eventType(patch: Partial<EventType> = {}): EventType {
  return {
    id: 'et_1',
    ownerUserId: 'u_host',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: 'intro',
    title: 'Intro call',
    description: 'A short chat.',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 60,
    maxHorizonDays: 60,
    maxPerDay: null,
    locationType: 'google_meet',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    scheduleId: null,
    ...patch,
  }
}

function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1',
    eventTypeId: 'et_1',
    hostUserId: 'u_host',
    hostUserIds: ['u_host'],
    guestName: 'Ada Lovelace',
    guestEmail: 'ada@example.com',
    guestTimezone: 'Europe/Kyiv',
    startUtc: START,
    endUtc: START + 30 * 60_000,
    localDate: '2026-08-14',
    status: 'confirmed',
    answers: {},
    externalEventIds: {},
    conferenceUrl: null,
    rescheduleOf: null,
    rescheduledTo: null,
    manageTokenHash: 'hash',
    cancelledAt: null,
    createdAt: Date.UTC(2026, 7, 10, 12, 0, 0),
    ...patch,
  }
}

/** Only what the notification functions actually touch. */
function fakePorts(
  sent: QueueMessage[],
  options: {
    bookings?: Record<string, Booking>
    connectionOwners?: Record<string, string>
  } = {},
): EnginePorts {
  return {
    repositories: () =>
      ({
        webhooks: { listForUser: async () => [] },
        bookings: { byId: async (id: string) => options.bookings?.[id] ?? null },
        connections: {
          byId: async (id: string) => {
            const userId = options.connectionOwners?.[id]
            if (!userId) return null
            return {
              id,
              userId,
              provider: 'google',
              providerAccountEmail: host.email,
              encryptedTokens: 'encrypted-test-token',
              keyVersion: 1,
              calendarIdsRead: ['primary'],
              calendarIdWrite: 'primary',
              syncStatus: 'ok',
              createdAt: 0,
            } satisfies CalendarConnection
          },
        },
      }) as unknown as ReturnType<EnginePorts['repositories']>,
    queue: {
      send: async (message: QueueMessage) => {
        sent.push(message)
      },
      sendBatch: async (messages: QueueMessage[]) => {
        sent.push(...messages)
      },
    },
    config: {
      baseUrl: 'https://punctual.example',
      brandName: 'Punctual',
      supportEmail: 'help@punctual.example',
      fromEmail: 'noreply@punctual.example',
      fromName: 'Punctual',
      telemetryEnabled: false,
    },
  } as unknown as EnginePorts
}

function emailTo(sent: QueueMessage[], recipient: string): Extract<QueueMessage, { kind: 'email' }> {
  const email = sent.find(
    (message): message is Extract<QueueMessage, { kind: 'email' }> =>
      message.kind === 'email' && message.message.to === recipient,
  )
  if (!email) throw new Error(`No email queued for ${recipient}`)
  return email
}

function emailAttachments(sent: QueueMessage[]): Array<
  Array<{ filename: string; content: string; contentType: string }> | undefined
> {
  return sent
    .filter((m): m is Extract<QueueMessage, { kind: 'email' }> => m.kind === 'email')
    .map((m) => m.message.attachments)
}

describe('notifyBookingCancelled — CANCEL suppressed for a superseded leg', () => {
  it('attaches no .ics when the cancelled booking has been superseded by a reschedule', async () => {
    const sent: QueueMessage[] = []
    const superseded = booking({
      status: 'cancelled',
      rescheduledTo: 'bk_2',
      cancelledAt: START,
    })

    await notifyBookingCancelled({
      ports: fakePorts(sent),
      booking: superseded,
      eventType: eventType(),
      host,
      cancelledBy: 'guest',
    })

    const attachments = emailAttachments(sent)
    expect(attachments).toHaveLength(2) // guest + host
    for (const a of attachments) expect(a).toBeUndefined()
  })

  it('still attaches a .ics CANCEL for a genuine, terminal cancellation', async () => {
    const sent: QueueMessage[] = []
    const trulyCancelled = booking({
      status: 'cancelled',
      rescheduledTo: null,
      cancelledAt: START,
    })

    await notifyBookingCancelled({
      ports: fakePorts(sent),
      booking: trulyCancelled,
      eventType: eventType(),
      host,
      cancelledBy: 'guest',
    })

    const attachments = emailAttachments(sent)
    expect(attachments).toHaveLength(2)
    for (const a of attachments) {
      expect(a).toBeDefined()
      expect(a?.[0]?.contentType).toContain('method=CANCEL')
    }
  })
})

describe('booking notifications — host calendar attachment fallback', () => {
  it('keeps one guest ICS identity across creation, reschedule and cancellation without inviting its organizer', async () => {
    const sent: QueueMessage[] = []
    const original = booking({ externalEventIds: { conn_google: 'google_event_1' } })
    const moved = booking({
      id: 'bk_2', rescheduleOf: original.id,
      startUtc: START + 3_600_000, endUtc: START + 5_400_000,
      externalEventIds: original.externalEventIds,
    })
    const ports = fakePorts(sent, {
      bookings: { [original.id]: original }, connectionOwners: { conn_google: host.id },
    })
    await notifyBookingCreated({ ports, booking: original, eventType: eventType(), host })
    await notifyBookingRescheduled({ ports, booking: moved, previous: original, eventType: eventType(), host })
    await notifyBookingCancelled({
      ports, booking: { ...moved, status: 'cancelled', cancelledAt: START },
      eventType: eventType(), host, cancelledBy: 'guest',
    })

    const emails = sent.filter((m) => m.kind === 'email')
    expect(emails).toHaveLength(6) // one per recipient, per action
    const guests = emails.filter((m) => m.message.to === original.guestEmail)
    expect(guests).toHaveLength(3)
    for (const [index, message] of guests.entries()) {
      expect(message.message.attachments).toHaveLength(1)
      const ics = atob(message.message.attachments![0]!.content).replace(/\r\n[ \t]/g, '')
      expect(ics).toContain('UID:bk_1@punctual\r\n')
      expect(ics).toContain(`SEQUENCE:${index}\r\n`)
      expect(ics).toContain(`METHOD:${index === 2 ? 'CANCEL' : 'REQUEST'}\r\n`)
      expect(ics).toContain(`ORGANIZER;CN=Grace Hopper:mailto:${host.email}`)
      const attendees = ics.split('\r\n').filter((line) => line.startsWith('ATTENDEE;'))
      expect(attendees).toHaveLength(1)
      expect(attendees[0]).toContain(`mailto:${original.guestEmail}`)
    }
    const owners = emails.filter((m) => m.message.to === host.email)
    expect(owners).toHaveLength(3)
    for (const owner of owners) expect(owner.message.attachments).toBeUndefined()
  })

  it('keeps the REQUEST for the guest but omits it from a host whose calendar event synced', async () => {
    const sent: QueueMessage[] = []
    const synced = booking({ externalEventIds: { conn_google: 'google_event_1' } })

    await notifyBookingCreated({
      ports: fakePorts(sent, { connectionOwners: { conn_google: host.id } }),
      booking: synced,
      eventType: eventType(),
      host,
    })

    expect(emailTo(sent, synced.guestEmail).message.attachments?.[0]?.contentType).toContain('method=REQUEST')
    const hostEmail = emailTo(sent, host.email).message
    expect(hostEmail.attachments).toBeUndefined()
    expect(hostEmail.text).toContain('It is already on your calendar.')
    expect(hostEmail.text).not.toContain('the invite is attached')
  })

  it('does not warn the host when their event synced but another provider remained uncertain', async () => {
    const sent: QueueMessage[] = []
    const partiallySynced = booking({ externalEventIds: { conn_google: 'google_event_1' } })

    await notifyBookingCreated({
      ports: fakePorts(sent, { connectionOwners: { conn_google: host.id } }),
      booking: partiallySynced,
      eventType: eventType(),
      host,
      calendarSyncUncertain: true,
    })

    const hostEmail = emailTo(sent, host.email).message
    expect(hostEmail.text).toContain('It is already on your calendar.')
    expect(hostEmail.text).not.toContain('could not confirm whether it reached')
  })

  it('keeps the updated REQUEST for the guest but omits it from a synced host on reschedule', async () => {
    const sent: QueueMessage[] = []
    const previous = booking({ id: 'bk_previous', status: 'rescheduled', rescheduledTo: 'bk_1' })
    const moved = booking({
      rescheduleOf: previous.id,
      startUtc: START + 24 * 60 * 60_000,
      endUtc: START + 24 * 60 * 60_000 + 30 * 60_000,
      externalEventIds: { conn_google: 'google_event_2' },
    })

    await notifyBookingRescheduled({
      ports: fakePorts(sent, {
        bookings: { [previous.id]: previous },
        connectionOwners: { conn_google: host.id },
      }),
      booking: moved,
      previous,
      eventType: eventType(),
      host,
    })

    expect(emailTo(sent, moved.guestEmail).message.attachments?.[0]?.contentType).toContain('method=REQUEST')
    const hostEmail = emailTo(sent, host.email).message
    expect(hostEmail.attachments).toBeUndefined()
    expect(hostEmail.text).toContain('Your calendar has been updated automatically.')
    expect(hostEmail.text).not.toContain('the updated invite is attached')
  })

  it('keeps the CANCEL for the guest but omits it from a host whose calendar event synced', async () => {
    const sent: QueueMessage[] = []
    const cancelled = booking({
      status: 'cancelled',
      cancelledAt: START,
      externalEventIds: { conn_google: 'google_event_3' },
    })

    await notifyBookingCancelled({
      ports: fakePorts(sent, { connectionOwners: { conn_google: host.id } }),
      booking: cancelled,
      eventType: eventType(),
      host,
      cancelledBy: 'guest',
    })

    expect(emailTo(sent, cancelled.guestEmail).message.attachments?.[0]?.contentType).toContain('method=CANCEL')
    expect(emailTo(sent, host.email).message.attachments).toBeUndefined()
  })

  it('keeps the host REQUEST as a fallback when no host calendar event synced', async () => {
    const sent: QueueMessage[] = []
    const unsynced = booking({ externalEventIds: {} })

    await notifyBookingCreated({
      ports: fakePorts(sent),
      booking: unsynced,
      eventType: eventType(),
      host,
    })

    expect(emailTo(sent, unsynced.guestEmail).message.attachments?.[0]?.contentType).toContain('method=REQUEST')
    const hostEmail = emailTo(sent, host.email).message
    expect(hostEmail.attachments?.[0]?.contentType).toContain('method=REQUEST')
    expect(hostEmail.text).toContain('could not be added to your connected calendar automatically')
  })

  it('does not claim an unsynced event is already on the calendar when the fallback is too large', async () => {
    const sent: QueueMessage[] = []
    const unsynced = booking({ externalEventIds: {} })

    await notifyBookingCreated({
      ports: fakePorts(sent),
      booking: unsynced,
      eventType: eventType({ description: 'x'.repeat(40_000) }),
      host,
    })

    const hostEmail = emailTo(sent, host.email).message
    expect(hostEmail.attachments).toBeUndefined()
    expect(hostEmail.text).toContain('fallback invite could not be attached')
    expect(hostEmail.text).not.toContain('already on your calendar')
  })

  it('explains the attachment fallback when a reschedule did not sync', async () => {
    const sent: QueueMessage[] = []
    const previous = booking({ id: 'bk_previous', status: 'rescheduled', rescheduledTo: 'bk_1' })
    const moved = booking({
      rescheduleOf: previous.id,
      startUtc: START + 24 * 60 * 60_000,
      endUtc: START + 24 * 60 * 60_000 + 30 * 60_000,
      externalEventIds: {},
    })

    await notifyBookingRescheduled({
      ports: fakePorts(sent, { bookings: { [previous.id]: previous } }),
      booking: moved,
      previous,
      eventType: eventType(),
      host,
    })

    const hostEmail = emailTo(sent, host.email).message
    expect(hostEmail.attachments?.[0]?.contentType).toContain('method=REQUEST')
    expect(hostEmail.text).toContain('could not be updated automatically')
  })
})
