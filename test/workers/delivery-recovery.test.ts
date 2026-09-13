import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { createD1Repositories } from '../../src/adapters/d1/repositories.js'
import type { DeliveryTaskDraft } from '../../src/ports.js'

const NOW = Date.UTC(2026, 8, 13, 10, 0, 0)
const START = NOW + 60 * 60_000

const repos = () => createD1Repositories(env.DB, { consistency: 'bookmark' })

function emailTask(audience: 'guest' | 'host'): DeliveryTaskDraft {
  return {
    id: `booking/bk_1/cancelled/${audience}`,
    bookingId: 'bk_1',
    actionVersion: 'cancelled',
    audience,
    kind: 'email',
    payload: {
      to: audience === 'guest' ? 'guest@example.test' : 'host@example.test',
      subject: 'Cancelled',
      html: '<p>Cancelled</p>',
      text: 'Cancelled',
      delivery: {
        bookingId: 'bk_1',
        action: 'cancelled',
        key: `booking/bk_1/cancelled/${audience}/hash`,
        preparedAt: NOW,
        deadlineAt: START,
        round: 0,
      },
    },
    deadlineAt: START,
    createdAt: NOW,
  }
}

function deleteTask(bookingId = 'bk_1', actionVersion = 'cancelled'): DeliveryTaskDraft {
  return {
    id: `booking/${bookingId}/${actionVersion}/calendar-delete`,
    bookingId,
    actionVersion,
    audience: null,
    kind: 'calendar_delete',
    payload: { bookingId },
    deadlineAt: null,
    createdAt: NOW,
  }
}

async function seedBooking(id: string, status = 'confirmed', start = START): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bookings
      (id,event_type_id,host_user_id,host_user_ids_json,guest_name,guest_email,guest_timezone,
       start_utc,end_utc,local_date,status,answers_json,external_event_ids_json,reschedule_of,
       rescheduled_to,manage_token_hash,cancelled_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, 'et_1', 'u_host', '["u_host"]', 'Guest', 'guest@example.test', 'UTC',
    start, start + 30 * 60_000, '2026-09-13', status, '{}', '{}', null,
    null, `hash_${id}`, null, NOW,
  ).run()
  await env.DB.prepare(
    'INSERT INTO slot_locks (host_user_id,bucket_start,booking_id) VALUES (?,?,?)',
  ).bind('u_host', start, id).run()
}

async function taskRows(): Promise<Array<{ id: string; kind: string; audience: string | null; status: string }>> {
  const result = await env.DB.prepare(
    'SELECT id, kind, audience, status FROM booking_delivery_tasks ORDER BY id',
  ).all<{ id: string; kind: string; audience: string | null; status: string }>()
  return result.results
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM booking_delivery_tasks'),
    env.DB.prepare('DELETE FROM slot_locks'),
    env.DB.prepare('DELETE FROM bookings'),
    env.DB.prepare('DELETE FROM event_types'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare(
      'INSERT INTO users (id,email,name,tz,slug,role,created_at) VALUES (?,?,?,?,?,?,?)',
    ).bind('u_host', 'host@example.test', 'Host', 'UTC', 'host', 'member', NOW),
    env.DB.prepare(
      `INSERT INTO event_types
       (id,owner_user_id,owner_team_id,scheduling_type,slug,title,description,duration_minutes,
        slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,
        max_horizon_days,max_per_day,location_type,location_value,questions_json,active,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      'et_1', 'u_host', null, 'personal', 'intro', 'Intro', '', 30,
      null, 0, 0, 0, 60, null, 'google_meet', null, '[]', 1, NOW,
    ),
  ])
})

describe('atomic booking delivery intents', () => {
  it('commits cancellation, lock release and exactly three logical effects together', async () => {
    await seedBooking('bk_1')
    const tasks = [emailTask('guest'), emailTask('host'), deleteTask()]

    expect(await repos().bookings.cancelWithLockRelease('bk_1', NOW, tasks)).toBe(true)
    expect(await taskRows()).toEqual([
      { id: 'booking/bk_1/cancelled/calendar-delete', kind: 'calendar_delete', audience: null, status: 'pending' },
      { id: 'booking/bk_1/cancelled/guest', kind: 'email', audience: 'guest', status: 'pending' },
      { id: 'booking/bk_1/cancelled/host', kind: 'email', audience: 'host', status: 'pending' },
    ])
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = ?').bind('bk_1').first<{ n: number }>())?.n).toBe(0)

    expect(await repos().bookings.cancelWithLockRelease('bk_1', NOW, tasks)).toBe(false)
    expect(await taskRows()).toHaveLength(3)
  })

  it('rolls the cancellation back when one task cannot be inserted', async () => {
    await seedBooking('bk_1')
    const invalid = { ...deleteTask(), id: 'invalid', kind: 'not_supported' } as unknown as DeliveryTaskDraft

    await expect(repos().bookings.cancelWithLockRelease('bk_1', NOW, [emailTask('guest'), invalid])).rejects.toThrow()
    expect((await repos().bookings.byId('bk_1'))?.status).toBe('confirmed')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM slot_locks WHERE booking_id = ?').bind('bk_1').first<{ n: number }>())?.n).toBe(1)
    expect(await taskRows()).toEqual([])
  })

  it('records only old-event deletion for a successful reschedule and none for internal rollback', async () => {
    await seedBooking('bk_1')
    await seedBooking('bk_2', 'confirmed', START + 60 * 60_000)
    const cleanup = deleteTask('bk_1', 'rescheduled:bk_2')

    expect(await repos().bookings.markRescheduled('bk_1', 'bk_2', [cleanup])).toBe(true)
    expect(await taskRows()).toEqual([
      { id: 'booking/bk_1/rescheduled:bk_2/calendar-delete', kind: 'calendar_delete', audience: null, status: 'pending' },
    ])

    expect(await repos().bookings.cancelWithLockRelease('bk_2', NOW)).toBe(true)
    expect(await taskRows()).toHaveLength(1)
  })

  it('does not persist effects from a transition that lost a concurrent race', async () => {
    await seedBooking('bk_1')
    await seedBooking('bk_2', 'confirmed', START + 60 * 60_000)
    await seedBooking('bk_3', 'confirmed', START + 120 * 60_000)

    const winner = deleteTask('bk_1', 'rescheduled:bk_2')
    const loser = deleteTask('bk_1', 'rescheduled:bk_3')
    expect(await repos().bookings.markRescheduled('bk_1', 'bk_2', [winner])).toBe(true)
    expect(await repos().bookings.markRescheduled('bk_1', 'bk_3', [loser])).toBe(false)
    expect(await repos().bookings.cancelWithLockRelease('bk_1', NOW, [
      emailTask('guest'),
      emailTask('host'),
      deleteTask(),
    ])).toBe(false)

    expect(await taskRows()).toEqual([
      { id: 'booking/bk_1/rescheduled:bk_2/calendar-delete', kind: 'calendar_delete', audience: null, status: 'pending' },
    ])
  })

  it('leases a task once and recovers it only after the lease expires', async () => {
    await seedBooking('bk_1')
    const task = emailTask('guest')
    expect(await repos().bookings.cancelWithLockRelease('bk_1', NOW, [task])).toBe(true)
    const deliveryTasks = repos().deliveryTasks

    const claims = await Promise.all([
      deliveryTasks.claimExecution(task.id, 0, NOW, 'lease_a', NOW + 60_000),
      deliveryTasks.claimExecution(task.id, 0, NOW, 'lease_b', NOW + 60_000),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await deliveryTasks.claimExecution(task.id, 0, NOW + 59_999, 'lease_c', NOW + 120_000)).toBeNull()
    expect(await deliveryTasks.due(NOW + 60_000, 5)).toEqual([
      expect.objectContaining({ id: task.id, status: 'leased' }),
    ])
    expect(await deliveryTasks.claimExecution(task.id, 0, NOW + 60_000, 'lease_d', NOW + 120_000))
      .toMatchObject({ status: 'leased', leaseToken: 'lease_d' })
  })

  it('durably advances a failed queue publication without resetting its budget', async () => {
    await seedBooking('bk_1')
    const task = emailTask('guest')
    expect(await repos().bookings.cancelWithLockRelease('bk_1', NOW, [task])).toBe(true)
    const deliveryTasks = repos().deliveryTasks

    expect(await deliveryTasks.reserveDispatch(task.id, 0, NOW, NOW + 5 * 60_000)).toBe(true)
    expect(await deliveryTasks.scheduleDispatchRetry(
      task.id,
      0,
      1,
      NOW + 2 * 60_000,
      'queue_publication_failed',
    )).toBe(true)
    expect(await deliveryTasks.byId(task.id)).toMatchObject({
      status: 'pending',
      round: 1,
      nextAttemptAt: NOW + 2 * 60_000,
      dispatchAfter: NOW + 2 * 60_000,
      errorCategory: 'queue_publication_failed',
    })
    expect(await deliveryTasks.scheduleDispatchRetry(task.id, 0, 2, NOW + 10 * 60_000, 'stale')).toBe(false)
  })
})
