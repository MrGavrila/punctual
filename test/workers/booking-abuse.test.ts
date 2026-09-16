import { env, createExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildPorts } from '../../src/index.js'
import { createEngine } from '../../src/engine.js'
import { createTurnstileVerifier } from '../../src/adapters/turnstile.js'
import { createCoordinator } from '../../src/adapters/coordinator.js'
import type { QueueMessage } from '../../src/ports.js'

const HOUR = 3_600_000
let sequence = 0

/** Real coordinator, D1, tokens and HTTP routes; only downstream delivery is captured. */
async function fixture() {
  const n = ++sequence
  const ports = buildPorts({ ...env, TURNSTILE_ENABLED: '0' })
  let now = ports.clock.now()
  ports.clock = { now: () => now }
  const queued: QueueMessage[] = []
  ports.queue = { async send(message) { queued.push(message) }, async sendBatch(messages) { queued.push(...messages) } }
  const repos = ports.repositories({ consistency: 'bookmark' })
  const user = await repos.users.create({
    id: `abuse-host-${n}`, email: `host${n}@example.test`, name: 'Host', tz: 'UTC',
    slug: `abuse-${n}`, role: 'member', avatarKey: null, company: null, jobTitle: null, companyUrl: null,
  })
  if (!user) throw new Error('fixture user failed')
  const windows = [{ startMinute: 0, endMinute: 1440 }]
  await repos.availability.create(user.id, {
    id: `abuse-schedule-${n}`, userId: user.id, name: 'All day', timezone: 'UTC', isDefault: true,
    weekly: [windows, windows, windows, windows, windows, windows, windows], overrides: [],
  })
  const event = await repos.eventTypes.create({
    id: `abuse-event-${n}`, ownerUserId: user.id, ownerTeamId: null, schedulingType: 'personal',
    slug: 'intro', title: 'Intro', description: '', durationMinutes: 30, slotIntervalMinutes: null,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 0, maxHorizonDays: 60,
    maxPerDay: null, locationType: 'custom_link', locationValue: 'https://example.test/meeting',
    questions: [], active: true, scheduleId: null,
  })
  ports.config.singleActiveBookingEventTypeId = event.id
  const start = Math.ceil((now + 24 * HOUR) / HOUR) * HOUR
  const engine = createEngine(ports)
  const request = (path: string, fields: Record<string, string>) => engine.fetch(new Request(`https://punctual.test${path}`, {
    method: 'POST', headers: { 'cf-connecting-ip': `192.0.2.${n}` }, body: new URLSearchParams(fields),
  }), env, createExecutionContext())
  const book = (at: number) => ports.coordinator.book(user.id, {
    eventTypeId: event.id, hostUserIds: [user.id], start: at, end: at + HOUR / 2,
    guestName: 'Guest', guestEmail: 'guest@example.test', guestTimezone: 'UTC', answers: {},
  })
  const active = () => env.DB.prepare(
    "SELECT id FROM bookings WHERE event_type_id = ? AND status = 'confirmed' AND end_utc > ? ORDER BY id",
  ).bind(event.id, now).all<{ id: string }>()
  const locks = (id: string) => env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = ?').bind(id).first<number>('n')
  const original = await book(start)
  if (!original.ok || !original.manageToken) throw new Error('fixture booking failed')
  queued.length = 0
  const move = (at: number) => request(`/booking/${original.booking.id}/reschedule`, { token: original.manageToken!, start: String(at) })
  return { ports, repos, user, event, start, original, book, move, request, active, locks, queued, setNow: (at: number) => { now = at } }
}

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('single-active booking lifecycle', () => {
  it.each([0, 1])('rejects the old guest link at/after the end boundary (%s ms) without new side effects', async (offset) => {
    const f = await fixture()
    f.setNow(f.original.booking.endUtc + offset)
    const next = await f.book(f.start + HOUR)
    if (!next.ok) throw new Error('new booking should be allowed after the end')
    f.queued.length = 0
    expect((await f.move(f.start + 2 * HOUR)).status).toBe(400)
    expect((await f.active()).results).toEqual([{ id: next.booking.id }])
    expect((await f.repos.bookings.byId(f.original.booking.id))?.status).toBe('confirmed')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ?').bind(f.event.id).first('n')).toBe(2)
    expect(f.queued).toEqual([])
  })

  it('rejects an ended source through the shared coordinator as well', async () => {
    const f = await fixture()
    f.setNow(f.original.booking.endUtc)
    const outcome = await f.ports.coordinator.book(f.user.id, {
      eventTypeId: f.event.id, hostUserIds: [f.user.id], start: f.start + HOUR, end: f.start + 1.5 * HOUR,
      guestName: 'Guest', guestEmail: 'guest@example.test', guestTimezone: 'UTC', answers: {},
      rescheduleOf: f.original.booking.id,
    })
    expect(outcome.ok).toBe(false)
    expect((await f.active()).results).toEqual([])
    expect(f.queued).toEqual([])
  })

  it.each(['ended', 'missing', 'email', 'event', 'cancelled'])(
    'rejects an invalid replacement source at the atomic INSERT boundary (%s)', async (invalid) => {
      const f = await fixture()
      const now = invalid === 'ended' ? f.original.booking.endUtc : f.start - HOUR
      if (invalid === 'cancelled') await f.repos.bookings.cancelWithLockRelease(f.original.booking.id, now)
      const replacement = {
        ...f.original.booking, id: `replacement-${f.original.booking.id}`,
        startUtc: f.start + 2 * HOUR, endUtc: f.start + 2.5 * HOUR,
        rescheduleOf: invalid === 'missing' ? 'not-a-booking' : f.original.booking.id,
        guestEmail: invalid === 'email' ? 'different@example.test' : 'guest@example.test',
        eventTypeId: invalid === 'event' ? 'not-this-event' : f.event.id,
      }
      const buckets = Array.from({ length: 6 }, (_, i) => ({ hostUserId: f.user.id, bucketStart: replacement.startUtc + i * 300_000 }))
      expect(await f.repos.bookings.createWithLocks(replacement, buckets, { enforceSingleActiveEmail: true, now })).toBeNull()
      expect(await f.repos.bookings.byId(replacement.id)).toBeNull()
      expect(await f.locks(replacement.id)).toBe(0)
      expect(await f.locks(f.original.booking.id)).toBe(invalid === 'cancelled' ? 0 : 6)
    },
  )

  it('rolls back the replacement if the source ends between creation and finalization', async () => {
    const f = await fixture()
    const realBook = f.ports.coordinator.book.bind(f.ports.coordinator)
    let replacementId = ''
    f.ports.coordinator.book = async (...args) => {
      const result = await realBook(...args)
      if (result.ok) replacementId = result.booking.id
      f.setNow(f.original.booking.endUtc)
      return result
    }
    expect((await f.move(f.start + HOUR)).status).toBe(409)
    expect((await f.active()).results).toEqual([])
    expect((await f.repos.bookings.byId(replacementId))?.status).toBe('cancelled')
    expect(await f.locks(replacementId)).toBe(0)
    expect(await f.locks(f.original.booking.id)).toBe(6)
    expect((await f.repos.bookings.byId(f.original.booking.id))?.status).toBe('confirmed')
    expect(f.queued.filter((m) => m.kind !== 'calendar.sync' || m.action !== 'delete')).toEqual([])
  })

  it('uses fresh time at the INSERT after availability reads cross the source end', async () => {
    const f = await fixture()
    f.ports.coordinator = createCoordinator({
      ports: f.ports, hostCalendarNamespace: env.HOST_CALENDAR,
      repositories: () => ({
        ...f.repos,
        connections: {
          ...f.repos.connections,
          async listForUser(userId) {
            const connections = await f.repos.connections.listForUser(userId)
            // Simulate the source ending while availability is being fetched.
            f.setNow(f.original.booking.endUtc)
            return connections
          },
        },
      }),
    })
    expect((await f.move(f.start + HOUR)).status).toBe(409)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ?').bind(f.event.id).first('n')).toBe(1)
    expect(await f.locks(f.original.booking.id)).toBe(6)
    expect(f.queued).toEqual([])
  })

  it('rejects a new create while a legitimate replacement is being finalized', async () => {
    const f = await fixture()
    const ready = latch()
    const resume = latch()
    const realBook = f.ports.coordinator.book.bind(f.ports.coordinator)
    f.ports.coordinator.book = async (...args) => {
      const result = await realBook(...args)
      if (args[1].rescheduleOf) { ready.release(); await resume.promise }
      return result
    }
    const moving = f.move(f.start + HOUR)
    await ready.promise
    try {
      expect(await f.book(f.start + 2 * HOUR)).toMatchObject({ ok: false, reason: 'active_booking_exists' })
    } finally { resume.release() }
    expect((await moving).status).toBe(302)
    const active = (await f.active()).results
    expect(active).toHaveLength(1)
    expect(await f.locks(active[0]!.id)).toBe(6)
    expect(await f.locks(f.original.booking.id)).toBe(0)
  })

  it('cancellation wins against an unfinished move without leaving a replacement or locks', async () => {
    const f = await fixture()
    const ready = latch()
    const resume = latch()
    const realBook = f.ports.coordinator.book.bind(f.ports.coordinator)
    let replacementId = ''
    f.ports.coordinator.book = async (...args) => {
      const result = await realBook(...args)
      if (result.ok) replacementId = result.booking.id
      ready.release()
      await resume.promise
      return result
    }
    const moving = f.move(f.start + HOUR)
    await ready.promise
    try {
      expect((await f.request(`/booking/${f.original.booking.id}/cancel`, { token: f.original.manageToken! })).status).toBe(200)
    } finally { resume.release() }
    expect((await moving).status).toBe(409)
    expect((await f.active()).results).toEqual([])
    expect((await f.repos.bookings.byId(replacementId))?.status).toBe('cancelled')
    expect(await f.locks(replacementId)).toBe(0)
    expect(await f.locks(f.original.booking.id)).toBe(0)
    expect(f.queued.filter((m) => m.kind === 'calendar.sync' && m.action === 'create')).toEqual([])
  })

  it('two concurrent moves leave only the winning replacement and its locks', async () => {
    const f = await fixture()
    const ready = latch()
    const realBook = f.ports.coordinator.book.bind(f.ports.coordinator)
    const replacements: string[] = []
    f.ports.coordinator.book = async (...args) => {
      const result = await realBook(...args)
      if (result.ok) replacements.push(result.booking.id)
      if (replacements.length === 2) ready.release()
      await ready.promise
      return result
    }
    const results = await Promise.all([f.move(f.start + HOUR), f.move(f.start + 2 * HOUR)])
    expect(results.map((r) => r.status).sort()).toEqual([302, 409])
    const active = (await f.active()).results
    expect(active).toHaveLength(1)
    const winner = active[0]!.id
    const loser = replacements.find((id) => id !== winner)!
    expect((await f.repos.bookings.byId(f.original.booking.id))?.rescheduledTo).toBe(winner)
    expect((await f.repos.bookings.byId(loser))?.status).toBe('cancelled')
    expect(await f.locks(winner)).toBe(6)
    expect(await f.locks(loser)).toBe(0)
    expect(await f.locks(f.original.booking.id)).toBe(0)
    expect(f.queued.flatMap((m) => m.kind === 'calendar.sync' && m.action === 'create' ? [m.bookingId] : [])).toEqual([winner])
  })

  it.each(['source', 'other'])('preserves legacy duplicate management when the email key belongs to %s', async (keyOwner) => {
    const f = await fixture()
    f.ports.config.singleActiveBookingEventTypeId = undefined
    const other = await f.book(f.start + HOUR)
    if (!other.ok) throw new Error('legacy booking fixture failed')
    if (keyOwner === 'other') {
      // Model a legacy source without a key while another active booking owns it.
      await env.DB.batch([
        env.DB.prepare('UPDATE bookings SET active_email_key = NULL WHERE id = ?').bind(f.original.booking.id),
        env.DB.prepare('UPDATE bookings SET active_email_key = ? WHERE id = ?').bind(`${f.event.id}\u0000guest@example.test`, other.booking.id),
      ])
    }
    f.ports.config.singleActiveBookingEventTypeId = f.event.id
    expect((await f.move(f.start + 2 * HOUR)).status).toBe(302)
    expect((await f.active()).results).toHaveLength(2)
    expect(await f.book(f.start + 3 * HOUR)).toMatchObject({ ok: false, reason: 'active_booking_exists' })
  })
})

describe('Turnstile at the public booking boundary', () => {
  const keys = { siteKey: '1x00000000000000000000AA', secretKey: '1x0000000000000000000000000000000AA' }
  const fields = (start: number) => ({ start: String(start), tz: 'UTC', name: 'Preserved Guest', email: 'guest@example.test', q_agenda: 'Preserved answer' })

  it.each(['missing-token', 'wrong-host', 'wrong-action', 'expired', 'network', 'timeout', 'missing-secret'])(
    'preserves the form and produces no booking effects for %s with the real verifier', async (failure) => {
      const f = await fixture()
      await f.repos.bookings.cancelWithLockRelease(f.original.booking.id, f.ports.clock.now())
      f.ports.turnstile = createTurnstileVerifier({
        ...keys, enabled: true, secretKey: failure === 'missing-secret' ? undefined : keys.secretKey,
        expectedHostname: 'punctual.test', expectedAction: 'booking_create', timeoutMs: 10,
        fetch: async (_input, init) => {
          if (failure === 'network') throw new Error('simulated outage')
          if (failure === 'timeout') return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          })
          if (failure === 'expired') return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] })
          return Response.json({ success: true, hostname: failure === 'wrong-host' ? 'wrong.example' : 'punctual.test', action: failure === 'wrong-action' ? 'login' : 'booking_create' })
        },
      })
      const response = await f.request(`/${f.user.slug}/intro/confirm`, {
        ...fields(f.start + HOUR), ...(failure === 'missing-token' ? {} : { 'cf-turnstile-response': 'unverified' }),
      })
      expect(response.status).toBe(['network', 'timeout', 'missing-secret'].includes(failure) ? 503 : 400)
      const html = await response.text()
      expect(html).toContain('Preserved Guest')
      expect(html).toContain('guest@example.test')
      expect(html).toContain('Preserved answer')
      expect((await f.active()).results).toEqual([])
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ?').bind(f.event.id).first('n')).toBe(1)
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks WHERE host_user_id = ?').bind(f.user.id).first('n')).toBe(0)
      expect(f.queued).toEqual([])
    },
  )

  it('supports explicit disable/re-enable while retaining the email and IP limits', async () => {
    const f = await fixture()
    const path = `/${f.user.slug}/intro/confirm`
    const setEnabled = (enabled: boolean) => {
      f.ports.turnstile = createTurnstileVerifier({
        ...keys, enabled, expectedHostname: 'punctual.test', expectedAction: 'booking_create',
        fetch: async () => Response.json({ success: true, hostname: 'punctual.test', action: 'booking_create' }),
      })
    }
    await f.repos.bookings.cancelWithLockRelease(f.original.booking.id, f.ports.clock.now())
    setEnabled(true)
    expect((await f.request(path, fields(f.start))).status).toBe(400)
    setEnabled(false)
    expect((await f.request(path, fields(f.start))).status).toBe(200)
    expect((await f.request(path, fields(f.start + HOUR))).status).toBe(409)
    const active = (await f.active()).results[0]!
    await f.repos.bookings.cancelWithLockRelease(active.id, f.ports.clock.now())
    setEnabled(true)
    expect((await f.request(path, fields(f.start + HOUR))).status).toBe(400)
    expect((await f.request(path, { ...fields(f.start + HOUR), 'cf-turnstile-response': 'fresh' })).status).toBe(200)
    setEnabled(false)
    for (let i = 0; i < 5; i++) expect((await f.request(path, fields(f.start + 2 * HOUR))).status).toBe(409)
    expect((await f.request(path, fields(f.start + 2 * HOUR))).status).toBe(429)
    expect((await f.active()).results).toHaveLength(1)
  })

  it('keeps real guest reschedule and cancellation operational with incomplete Turnstile configuration', async () => {
    const f = await fixture()
    f.ports.turnstile = buildPorts({ ...env, TURNSTILE_ENABLED: '1' }).turnstile
    const moved = await f.move(f.start + HOUR)
    expect(moved.status).toBe(302)
    const location = new URL(moved.headers.get('location')!, 'https://punctual.test')
    expect((await f.request(`${location.pathname}/cancel`, { token: location.searchParams.get('token')! })).status).toBe(200)
    expect((await f.active()).results).toEqual([])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks WHERE host_user_id = ?').bind(f.user.id).first('n')).toBe(0)
  })
})
