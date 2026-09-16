import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import { prepareBooking } from '../../src/core/domain/booking-service.js'
import type { HostAvailabilityInput } from '../../src/core/slots/engine.js'
import type { Availability, EventType, WeeklySchedule } from '../../src/core/domain/types.js'

/**
 * The anti-double-booking invariant, exercised through the real repository
 * against a real D1 (ADR-0002 §1).
 *
 * Verified against production D1 on 2026-08-14 with five concurrent HTTP
 * bookings: exactly one won, four received 409, and zero orphan locks were
 * left behind. These tests keep that property from regressing silently.
 */

const DAY = 86_400_000

function weeklyAllDay(): WeeklySchedule {
  const w = [{ startMinute: 0, endMinute: 1440 }]
  return [w, w, w, w, w, w, w] as WeeklySchedule
}

function availability(userId: string, tz = 'UTC'): Availability {
  return { userId, timezone: tz, weekly: weeklyAllDay(), overrides: [] }
}

function eventType(over: Partial<EventType> = {}): EventType {
  return {
    id: 'et1',
    ownerUserId: 'h1',
    ownerTeamId: null,
    schedulingType: 'personal',
    slug: '30min',
    title: '30 min',
    description: '',
    durationMinutes: 30,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxHorizonDays: 365,
    maxPerDay: null,
    locationType: 'phone',
    locationValue: null,
    questions: [],
    active: true,
    createdAt: 0,
    scheduleId: null,
    ...over,
  }
}

function host(id: string, tz = 'UTC'): HostAvailabilityInput {
  return { hostUserId: id, availability: availability(id, tz), busy: [] }
}

const repos = () => createD1Repositories(env.DB, { consistency: 'bookmark' })

/** A start well in the future, aligned to the 5-minute bucket grid. */
const START = Math.ceil((Date.now() + 7 * DAY) / 300_000) * 300_000
const NOW = Date.now()

describe('durable calendar and confirmation recovery', () => {
  let bookingId: string
  let counter = 0
  beforeEach(async () => {
    bookingId = `recovery_${++counter}`
    const prepared = prepareBooking({
      eventType: eventType(), hosts: [host('h1')], start: START + counter * DAY,
      guestName: 'Recovery', guestEmail: 'recovery@example.com', guestTimezone: 'UTC',
      answers: {}, now: NOW, bookingId, manageTokenHash: `test-${bookingId}`,
    })
    if (!prepared.ok) throw new Error('failed to prepare recovery fixture')
    expect(await repos().bookings.createWithLocks(prepared.booking, [])).not.toBeNull()
  })

  it('retains each recipient checkpoint across repository instances and claim retries', async () => {
    expect(await repos().bookings.claimConfirmation(bookingId, NOW)).toBe(true)
    await repos().bookings.markConfirmationRecipientQueued(bookingId, 'guest', NOW)
    await repos().bookings.releaseConfirmationClaim(bookingId, NOW)
    expect(await repos().bookings.claimConfirmation(bookingId, NOW + 1)).toBe(true)
    expect(await repos().bookings.confirmationRecipientQueued(bookingId, 'guest')).toBe(true)
    expect(await repos().bookings.confirmationRecipientQueued(bookingId, 'host')).toBe(false)
    await repos().bookings.markConfirmationRecipientQueued(bookingId, 'host', NOW + 1)
    await repos().bookings.completeConfirmation(bookingId, NOW + 1)
    expect(await repos().bookings.claimConfirmation(bookingId, NOW + 600_000)).toBe(false)
  })

  it('recovers a crashed dispatch lease and ignores the expired owner releasing it', async () => {
    expect(await repos().bookings.claimConfirmation(bookingId, NOW)).toBe(true)
    expect(await repos().bookings.claimConfirmation(bookingId, NOW + 1)).toBe('busy')
    expect(await repos().bookings.claimConfirmation(bookingId, NOW + 300_000)).toBe(true)
    await repos().bookings.releaseConfirmationClaim(bookingId, NOW)
    expect(await repos().bookings.claimConfirmation(bookingId, NOW + 300_001)).toBe('busy')
  })

  it('preserves completed historical confirmations without sending them again', async () => {
    await env.DB.prepare('UPDATE bookings SET confirmation_queued_at = ? WHERE id = ?').bind(NOW, bookingId).run()
    expect(await repos().bookings.claimConfirmation(bookingId, NOW + 600_000)).toBe(false)
  })

  it('persists the original target and uncertainty independently of event ids', async () => {
    await repos().bookings.rememberCalendarTarget(bookingId, 'conn-recovery', 'original')
    await repos().bookings.rejectCalendarTarget(bookingId, 'conn-recovery')
    expect(await repos().bookings.calendarTargets(bookingId)).toEqual([
      { connectionId: 'conn-recovery', calendarId: 'original', uncertain: false },
    ])
    await repos().bookings.rememberCalendarTarget(bookingId, 'conn-recovery', 'replacement')
    expect(await repos().bookings.calendarTargets(bookingId)).toEqual([
      { connectionId: 'conn-recovery', calendarId: 'original', uncertain: true },
    ])
  })
})

describe('slot_locks is the invariant', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM slot_locks'),
      env.DB.prepare('DELETE FROM bookings'),
    ])
  })

  it('commits a booking with one lock per five-minute bucket', async () => {
    const prepared = prepareBooking({
      eventType: eventType(),
      hosts: [host('h1')],
      start: START,
      guestName: 'A',
      guestEmail: 'a@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_a',
      manageTokenHash: 'hash_a',
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    // A 30-minute event with no buffers is exactly 6 buckets.
    expect(prepared.buckets).toHaveLength(6)

    const written = await repos().bookings.createWithLocks(prepared.booking, prepared.buckets)
    expect(written).not.toBeNull()

    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(n?.n).toBe(6)
  })

  it('a second booking of the same slot loses, and leaves NO ghost locks', async () => {
    const mk = (id: string, start: number) => {
      const p = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: `${id}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return p
    }

    const first = mk('first', START)
    expect(await repos().bookings.createWithLocks(first.booking, first.buckets)).not.toBeNull()

    // Overlaps the first by one bucket, and would otherwise claim five new ones.
    const second = mk('second', START + 25 * 60_000)
    expect(await repos().bookings.createWithLocks(second.booking, second.buckets)).toBeNull()

    const ghosts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = 'bk_second'",
    ).first<{ n: number }>()
    expect(ghosts?.n).toBe(0)

    // And the loser's booking row must not exist either — the batch is atomic.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE id = 'bk_second'",
    ).first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('exactly one of five concurrent attempts on the same slot wins', async () => {
    const attempts = Array.from({ length: 5 }, (_, i) => {
      const p = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start: START,
        guestName: `racer${i}`,
        guestEmail: `racer${i}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_racer${i}`,
        manageTokenHash: `hash_racer${i}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return repos().bookings.createWithLocks(p.booking, p.buckets)
    })

    const results = await Promise.all(attempts)
    expect(results.filter((r) => r !== null)).toHaveLength(1)

    const confirmed = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM bookings WHERE start_utc = ?',
    )
      .bind(START)
      .first<{ n: number }>()
    expect(confirmed?.n).toBe(1)

    // Six buckets total: the four losers contributed nothing.
    const locks = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(locks?.n).toBe(6)
  })

  it('allows only one concurrent future booking for the same normalized email when the policy is enabled', async () => {
    const attempts = Array.from({ length: 5 }, (_, i) => {
      const prepared = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start: START + i * 60 * 60_000,
        guestName: `Email racer ${i}`,
        guestEmail: i % 2 === 0 ? 'GUEST@example.com' : 'guest@example.com',
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_email_racer${i}`,
        manageTokenHash: `hash_email_racer${i}`,
      })
      if (!prepared.ok) throw new Error('prepare failed')
      return repos().bookings.createWithLocks(prepared.booking, prepared.buckets, {
        enforceSingleActiveEmail: true,
        now: NOW,
      })
    })

    const results = await Promise.all(attempts)
    const confirmed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE LOWER(TRIM(guest_email)) = 'guest@example.com' AND status = 'confirmed'",
    ).first<{ n: number }>()
    expect(confirmed?.n).toBe(1)
    expect(results.filter((result) => result !== null)).toHaveLength(1)
  })

  it('transfers the email allowance on reschedule and releases it when the replacement is cancelled', async () => {
    const make = (id: string, start: number, rescheduleOf: string | null = null) => {
      const prepared = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: 'guest@example.com',
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: id,
        manageTokenHash: `hash_${id}`,
        rescheduleOf,
      })
      if (!prepared.ok) throw new Error('prepare failed')
      return prepared
    }
    const policy = { enforceSingleActiveEmail: true, now: NOW }
    const original = make('bk_email_original', START)
    expect(await repos().bookings.createWithLocks(original.booking, original.buckets, policy)).not.toBeNull()

    const replacement = make('bk_email_replacement', START + 60 * 60_000, original.booking.id)
    expect(await repos().bookings.createWithLocks(replacement.booking, replacement.buckets, policy)).not.toBeNull()
    expect(await repos().bookings.markRescheduled(original.booking.id, replacement.booking.id, [], true)).toBe(true)
    expect(await repos().bookings.cancelWithLockRelease(replacement.booking.id, NOW)).toBe(true)

    const next = make('bk_email_after_cancel', START + 2 * 60 * 60_000)
    expect(await repos().bookings.createWithLocks(next.booking, next.buckets, policy)).not.toBeNull()
  })

  it('does not attach an active email key when the policy is disabled during reschedule', async () => {
    const make = (id: string, start: number, rescheduleOf: string | null = null) => {
      const prepared = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: 'guest@example.com',
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: id,
        manageTokenHash: `hash_${id}`,
        rescheduleOf,
      })
      if (!prepared.ok) throw new Error('prepare failed')
      return prepared
    }
    const original = make('bk_unscoped_original', START)
    const replacement = make('bk_unscoped_replacement', START + 60 * 60_000, original.booking.id)
    expect(await repos().bookings.createWithLocks(original.booking, original.buckets)).not.toBeNull()
    expect(await repos().bookings.createWithLocks(replacement.booking, replacement.buckets)).not.toBeNull()
    expect(await repos().bookings.markRescheduled(original.booking.id, replacement.booking.id)).toBe(true)

    const row = await env.DB.prepare(
      'SELECT active_email_key FROM bookings WHERE id = ?',
    ).bind(replacement.booking.id).first<{ active_email_key: string | null }>()
    expect(row?.active_email_key).toBeNull()
  })

  it('blocks a new booking when a legacy active row has no policy key', async () => {
    const make = (id: string, start: number) => {
      const prepared = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: id === 'legacy' ? ' Guest@Example.com ' : 'guest@example.com',
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!prepared.ok) throw new Error('prepare failed')
      return prepared
    }

    const legacy = make('legacy', START)
    expect(await repos().bookings.createWithLocks(legacy.booking, legacy.buckets)).not.toBeNull()
    const attempted = make('new', START + 60 * 60_000)
    expect(await repos().bookings.createWithLocks(attempted.booking, attempted.buckets, {
      enforceSingleActiveEmail: true,
      now: NOW,
    })).toBeNull()
  })

  it('releases the policy at the exact end time and scopes it to one event type', async () => {
    const make = (id: string, start: number, type: EventType) => {
      const prepared = prepareBooking({
        eventType: type,
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: 'guest@example.com',
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!prepared.ok) throw new Error('prepare failed')
      return prepared
    }
    const policy = { enforceSingleActiveEmail: true, now: NOW }
    const first = make('boundary_first', START, eventType())
    expect(await repos().bookings.createWithLocks(first.booking, first.buckets, policy)).not.toBeNull()

    const otherEvent = make('other_event', START + 60 * 60_000, eventType({ id: 'et2' }))
    expect(await repos().bookings.createWithLocks(otherEvent.booking, otherEvent.buckets, policy)).not.toBeNull()

    const afterEnd = make('after_end', START + 2 * 60 * 60_000, eventType())
    expect(await repos().bookings.createWithLocks(afterEnd.booking, afterEnd.buckets, {
      enforceSingleActiveEmail: true,
      now: first.booking.endUtc,
    })).not.toBeNull()
  })

  it('adjacent bookings do not collide — half-open intervals', async () => {
    const mk = (id: string, start: number) => {
      const p = prepareBooking({
        eventType: eventType(),
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: `${id}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return p
    }

    const a = mk('a', START)
    const b = mk('b', START + 30 * 60_000) // starts exactly when A ends

    expect(await repos().bookings.createWithLocks(a.booking, a.buckets)).not.toBeNull()
    expect(await repos().bookings.createWithLocks(b.booking, b.buckets)).not.toBeNull()

    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks').first<{ n: number }>()
    expect(n?.n).toBe(12)
  })

  it('buffers extend the claimed footprint, so back-to-back now conflicts', async () => {
    const et = eventType({ bufferAfterMinutes: 15, bufferBeforeMinutes: 15 })
    const mk = (id: string, start: number) => {
      const p = prepareBooking({
        eventType: et,
        hosts: [host('h1')],
        start,
        guestName: id,
        guestEmail: `${id}@example.com`,
        guestTimezone: 'UTC',
        answers: {},
        now: NOW,
        bookingId: `bk_${id}`,
        manageTokenHash: `hash_${id}`,
      })
      if (!p.ok) throw new Error('prepare failed')
      return p
    }

    const a = mk('a', START)
    expect(a.buckets).toHaveLength(12) // 15 + 30 + 15 minutes
    expect(await repos().bookings.createWithLocks(a.booking, a.buckets)).not.toBeNull()

    // Starting exactly when A's meeting ends is now a conflict, because A's
    // trailing buffer and B's leading buffer both claim that ground
    // (ADR-0004 §4: buffers are additive by design).
    const b = mk('b', START + 30 * 60_000)
    expect(await repos().bookings.createWithLocks(b.booking, b.buckets)).toBeNull()
  })

  it('a collective booking claims buckets for every host, atomically', async () => {
    const et = eventType({ schedulingType: 'collective', ownerTeamId: 't1', ownerUserId: null })
    const p = prepareBooking({
      eventType: et,
      hosts: [host('h1'), host('h2'), host('h3')],
      start: START,
      guestName: 'C',
      guestEmail: 'c@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_c',
      manageTokenHash: 'hash_c',
    })
    expect(p.ok).toBe(true)
    if (!p.ok) return

    expect(p.buckets).toHaveLength(18) // 3 hosts x 6 buckets
    expect(await repos().bookings.createWithLocks(p.booking, p.buckets)).not.toBeNull()

    const perHost = await env.DB.prepare(
      'SELECT host_user_id, COUNT(*) AS n FROM slot_locks GROUP BY host_user_id ORDER BY host_user_id',
    ).all<{ host_user_id: string; n: number }>()
    expect(perHost.results).toEqual([
      { host_user_id: 'h1', n: 6 },
      { host_user_id: 'h2', n: 6 },
      { host_user_id: 'h3', n: 6 },
    ])
  })

  it('a collective booking fails ENTIRELY when one host is already busy', async () => {
    // h2 is booked personally at this time.
    const solo = prepareBooking({
      eventType: eventType(),
      hosts: [host('h2')],
      start: START,
      guestName: 'solo',
      guestEmail: 'solo@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_solo',
      manageTokenHash: 'hash_solo',
    })
    if (!solo.ok) throw new Error('prepare failed')
    expect(await repos().bookings.createWithLocks(solo.booking, solo.buckets)).not.toBeNull()

    const et = eventType({ schedulingType: 'collective', ownerTeamId: 't1', ownerUserId: null })
    const p = prepareBooking({
      eventType: et,
      hosts: [host('h1'), host('h2'), host('h3')],
      start: START,
      guestName: 'C',
      guestEmail: 'c@example.com',
      guestTimezone: 'UTC',
      answers: {},
      now: NOW,
      bookingId: 'bk_c',
      manageTokenHash: 'hash_c',
    })
    if (!p.ok) throw new Error('prepare failed')

    expect(await repos().bookings.createWithLocks(p.booking, p.buckets)).toBeNull()

    // h1 and h3 must have NOTHING: a partial collective booking would put a
    // meeting on two calendars that the third person never agreed to.
    const stray = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM slot_locks WHERE host_user_id IN ('h1','h3')",
    ).first<{ n: number }>()
    expect(stray?.n).toBe(0)
  })
})
