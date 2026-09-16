import { env, createExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildPorts } from '../../src/index.js'
import { createEngine } from '../../src/engine.js'
import { createTurnstileVerifier } from '../../src/adapters/turnstile.js'
import { createCoordinator } from '../../src/adapters/coordinator.js'
import { localDateString } from '../../src/core/time/zone.js'
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
  const get = (path: string) => engine.fetch(new Request(`https://punctual.test${path}`), env, createExecutionContext())
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
  return { ports, repos, user, event, start, original, book, move, request, get, active, locks, queued, setNow: (at: number) => { now = at } }
}

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function resultAction(html: string, label: string): string {
  const href = new RegExp(`href="([^"]+)">${label}</a>`).exec(html)?.[1]
  if (!href) throw new Error(`Missing result action: ${label}`)
  return href.replace(/&amp;/g, '&')
}

describe('single-active booking lifecycle', () => {
  it('follows a guest reschedule to the new booking, confirms success, and invalidates the old link', async () => {
    const f = await fixture()
    const oldPath = `/booking/${f.original.booking.id}?token=${encodeURIComponent(f.original.manageToken!)}`
    expect((await f.get(oldPath)).status).toBe(200)

    const moved = await f.move(f.start + HOUR)
    expect(moved.status).toBe(302)
    const location = new URL(moved.headers.get('location')!, 'https://punctual.test')
    const active = (await f.active()).results
    expect(active).toHaveLength(1)
    const newId = active[0]!.id
    expect(newId).not.toBe(f.original.booking.id)
    expect(location.pathname).toBe(`/booking/${newId}`)
    const newToken = location.searchParams.get('token')!
    expect(newToken).toBeTruthy()
    expect(newToken).not.toBe(f.original.manageToken)
    expect(f.queued).toContainEqual({ kind: 'calendar.sync', action: 'create', bookingId: newId, manageToken: newToken })

    const landing = await f.get(location.pathname + location.search)
    expect(landing.status).toBe(200)
    const html = await landing.text()
    expect(html).toContain('Your meeting has been rescheduled')
    expect(html).toContain('role="status"')
    expect(html).toContain('pu-card pu-confirm')
    expect(html).not.toContain('Pick a new time')
    expect(html).not.toContain('<form')
    expect(html).toContain('use the links in your latest confirmation email')
    expect(html).toContain('check your spam folder')
    expect(html).toContain('You can close this page')
    expect(html).not.toContain('Reschedule or cancel')
    expect(html).not.toContain('<a class="pu-btn')
    expect(html).not.toContain(newToken)
    expect(html).not.toContain('This link is not valid')
    expect((await f.repos.bookings.byId(newId))?.startUtc).toBe(f.start + HOUR)

    // Email links and subsequent navigation open the ordinary manage page.
    const managePath = `${location.pathname}?token=${encodeURIComponent(newToken)}`
    const emailPage = await f.get(managePath)
    expect(emailPage.status).toBe(200)
    const manageHtml = await emailPage.text()
    expect(manageHtml).not.toContain('Your meeting has been rescheduled')
    expect(manageHtml).toContain('Pick a new time')
    expect(manageHtml).toContain(`/booking/${newId}/cancel`)
    expect((await f.get(oldPath)).status).toBe(400)
    expect((await f.move(f.start + 2 * HOUR)).status).toBe(400)
    expect((await f.active()).results).toEqual(active)
    expect(await f.locks(f.original.booking.id)).toBe(0)
    expect(await f.locks(newId)).toBe(6)
    expect((await f.get(`${location.pathname}?moved=1`)).status).toBe(400)
  })

  it('does not announce a move for an original or inactive booking merely because moved=1 is supplied', async () => {
    const f = await fixture()
    const original = await f.get(`/booking/${f.original.booking.id}?token=${encodeURIComponent(f.original.manageToken!)}&moved=1`)
    expect(original.status).toBe(200)
    expect(await original.text()).not.toContain('Your meeting has been rescheduled')
    const moved = await f.move(f.start + HOUR)
    const location = new URL(moved.headers.get('location')!, 'https://punctual.test')
    const newId = location.pathname.split('/').pop()!
    // Preserve the token deliberately to exercise the rendering guard, too.
    await f.repos.bookings.cancelWithLockRelease(newId, f.ports.clock.now())
    const cancelled = await f.get(location.pathname + location.search)
    expect(cancelled.status).toBe(200)
    expect(await cancelled.text()).not.toContain('Your meeting has been rescheduled')
  })

  it('allows another deliberate move through the current replacement credentials', async () => {
    const f = await fixture()
    const first = await f.move(f.start + HOUR)
    const firstLocation = new URL(first.headers.get('location')!, 'https://punctual.test')
    const firstToken = firstLocation.searchParams.get('token')!
    const manage = `${firstLocation.pathname}?token=${encodeURIComponent(firstToken)}`
    const nextStart = f.start + 24 * HOUR
    const confirmation = await f.get(`${manage}&start=${nextStart}`)
    const html = await confirmation.text()
    expect(html).toContain('Confirm new time')
    const action = /<form method="post" action="([^"]+\/reschedule)">/.exec(html)![1]!
    const token = /name="token" value="([^"]+)"/.exec(html)![1]!
    const second = await f.request(action, { token, start: String(nextStart) })
    expect(second.status).toBe(302)
    expect(second.headers.get('location')).not.toBe(first.headers.get('location'))
    expect(await (await f.get(second.headers.get('location')!)).text()).toContain('Your meeting has been rescheduled')
    expect((await f.get(manage)).status).toBe(400)
    const active = (await f.active()).results
    expect(active).toHaveLength(1)
    expect((await f.repos.bookings.byId(active[0]!.id))?.startUtc).toBe(nextStart)
  })

  it('shows a terminal cancellation result with meeting details and no management controls', async () => {
    const f = await fixture()
    const response = await f.request(`/booking/${f.original.booking.id}/cancel`, { token: f.original.manageToken! })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('Your booking has been cancelled')
    expect(html).toContain('pu-card pu-confirm')
    expect(html).toContain('Intro')
    expect(html).toContain('UTC')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Reschedule or cancel')
    expect(html).not.toContain(f.original.manageToken)
    expect((await f.active()).results).toEqual([])
    expect(await f.locks(f.original.booking.id)).toBe(0)
    expect((await f.get(`/booking/${f.original.booking.id}?token=${encodeURIComponent(f.original.manageToken!)}`)).status).toBe(400)
  })

  it('offers a GET back to the selected day after a slot conflict, without changing the original', async () => {
    const f = await fixture()
    const start = f.start + 24 * HOUR
    const other = await f.ports.coordinator.book(f.user.id, {
      eventTypeId: f.event.id, hostUserIds: [f.user.id], start, end: start + HOUR / 2,
      guestName: 'Other', guestEmail: 'other@example.test', guestTimezone: 'UTC', answers: {},
    })
    expect(other.ok).toBe(true)
    const response = await f.move(start)
    expect(response.status).toBe(409)
    const html = await response.text()
    expect(html).toContain('That time is no longer available')
    expect(html).not.toContain('<form')
    const retryPath = resultAction(html, 'Choose another time')
    const retryUrl = new URL(retryPath, 'https://punctual.test')
    expect(retryUrl.searchParams.get('date')).toBe(localDateString(start, 'UTC'))
    expect(retryUrl.searchParams.has('start')).toBe(false)
    const picker = await f.get(retryPath)
    expect(picker.status).toBe(200)
    expect(await picker.text()).toContain(`value="${localDateString(start, 'UTC')}"`)
    expect((await f.repos.bookings.byId(f.original.booking.id))?.status).toBe('confirmed')
    expect((await f.repos.bookings.byId(f.original.booking.id))?.startUtc).toBe(f.start)
  })

  it.each(['cancel', 'reschedule'] as const)('does not claim failure or offer POST retry when %s throws after the status write', async (action) => {
    const f = await fixture()
    const repositories = f.ports.repositories.bind(f.ports)
    f.ports.repositories = (scope) => {
      const repos = repositories(scope)
      repos.bookings.rotateManageToken = async () => { throw new Error('simulated post-write failure') }
      return repos
    }
    const response = await f.request(`/booking/${f.original.booking.id}/${action}`, {
      token: f.original.manageToken!, start: String(f.start + HOUR),
    })
    expect(response.status).toBe(500)
    const html = await response.text()
    expect(html).toContain('We could not verify the result')
    expect(html).toContain('The change may already have completed')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Choose another time')
    expect(html).not.toContain('simulated post-write failure')
    expect((await f.repos.bookings.byId(f.original.booking.id))?.status).toBe(action === 'cancel' ? 'cancelled' : 'rescheduled')
  })

  it('uses an informational result for a public booking with an uncertain write result', async () => {
    const f = await fixture()
    f.ports.coordinator.book = async () => { throw new Error('simulated connection failure') }
    const response = await f.request(`/${f.user.slug}/${f.event.slug}/confirm`, {
      name: 'Guest', email: 'new@example.test', start: String(f.start + HOUR), tz: 'UTC',
    })
    expect(response.status).toBe(500)
    const html = await response.text()
    expect(html).toContain('We could not verify the result')
    expect(html).toContain('Your booking may already have been created')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('simulated connection failure')
  })

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
