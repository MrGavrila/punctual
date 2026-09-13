import { describe, expect, it, vi } from 'vitest'
import { EmailDeliveryError } from '../../src/adapters/email/index.js'
import {
  dispatchDeliveryTask,
  executeDeliveryTask,
  recoverDueDeliveryTasks,
} from '../../src/adapters/delivery-recovery.js'
import type { Booking } from '../../src/core/domain/types.js'
import type { DeliveryTask, EmailMessage, EnginePorts, QueueMessage, QueueSendOptions } from '../../src/ports.js'

const MINUTE = 60_000
const NOW = Date.UTC(2026, 8, 13, 10, 0, 0)
const START = NOW + 30 * MINUTE

function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1', eventTypeId: 'et_1', hostUserId: 'u_1', hostUserIds: ['u_1'],
    guestName: 'Guest', guestEmail: 'guest@example.test', guestTimezone: 'UTC',
    startUtc: START, endUtc: START + 30 * MINUTE, localDate: '2026-09-13',
    status: 'cancelled', answers: {}, externalEventIds: { conn_1: 'evt_1' }, conferenceUrl: null,
    rescheduleOf: null, rescheduledTo: null, manageTokenHash: 'hash', cancelledAt: NOW, createdAt: NOW,
    ...patch,
  }
}

function emailTask(patch: Partial<DeliveryTask> = {}): DeliveryTask {
  return {
    id: 'booking/bk_1/cancelled/guest', bookingId: 'bk_1', actionVersion: 'cancelled', audience: 'guest',
    kind: 'email',
    payload: {
      to: 'guest@example.test', subject: 'Cancelled', html: '<p>Cancelled</p>', text: 'Cancelled',
      delivery: { key: 'booking/bk_1/cancelled/guest/hash', preparedAt: NOW, deadlineAt: START, round: 0 },
    },
    deadlineAt: START, createdAt: NOW, status: 'pending', round: 0, nextAttemptAt: NOW,
    dispatchAfter: 0, leaseToken: null, leaseExpiresAt: null, firstAttemptAt: null,
    completedAt: null, errorCategory: null,
    ...patch,
  }
}

function calendarTask(patch: Partial<DeliveryTask> = {}): DeliveryTask {
  return {
    ...emailTask(), id: 'booking/bk_1/cancelled/calendar-delete', audience: null,
    kind: 'calendar_delete', payload: { bookingId: 'bk_1' }, deadlineAt: null,
    ...patch,
  }
}

function harness(initial: DeliveryTask[], now = NOW, bookingState = booking()) {
  const tasks = new Map(initial.map((task) => [task.id, { ...task }]))
  const queued: Array<{ message: QueueMessage; options?: QueueSendOptions }> = []
  const email = vi.fn(async (_message: EmailMessage) => {})
  const deleteCalendar = vi.fn(async () => {})
  let clock = now
  let loseCompletion = false
  const repo = {
    byId: async (id: string) => tasks.get(id) ?? null,
    due: async (at: number, limit: number) => [...tasks.values()]
      .filter((task) => (
        task.status === 'pending' && task.nextAttemptAt <= at && task.dispatchAfter <= at
      ) || (
        task.status === 'leased' && (task.leaseExpiresAt ?? Infinity) <= at
      ))
      .slice(0, limit),
    reserveDispatch: async (id: string, round: number, at: number, recoverAfter: number) => {
      const task = tasks.get(id)
      const available = task && (
        (task.status === 'pending' && task.dispatchAfter <= at) ||
        (task.status === 'leased' && (task.leaseExpiresAt ?? Infinity) <= at)
      )
      if (!task || !available || task.round !== round || task.nextAttemptAt > at) return false
      tasks.set(id, {
        ...task,
        status: 'pending',
        dispatchAfter: recoverAfter,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      return true
    },
    claimExecution: async (id: string, round: number, at: number, token: string, expires: number) => {
      const task = tasks.get(id)
      if (!task || task.round !== round || task.nextAttemptAt > at) return null
      if (task.status !== 'pending' && !(task.status === 'leased' && (task.leaseExpiresAt ?? Infinity) <= at)) return null
      const claimed = { ...task, status: 'leased' as const, leaseToken: token, leaseExpiresAt: expires, firstAttemptAt: task.firstAttemptAt ?? at }
      tasks.set(id, claimed)
      return claimed
    },
    scheduleRetry: async (id: string, token: string, round: number, next: number, category: string) => {
      const task = tasks.get(id)
      if (!task || task.status !== 'leased' || task.leaseToken !== token) return false
      tasks.set(id, { ...task, status: 'pending', round, nextAttemptAt: next, dispatchAfter: next, leaseToken: null, leaseExpiresAt: null, errorCategory: category })
      return true
    },
    scheduleDispatchRetry: async (id: string, currentRound: number, round: number, next: number, category: string) => {
      const task = tasks.get(id)
      if (!task || task.status !== 'pending' || task.round !== currentRound) return false
      tasks.set(id, {
        ...task,
        round,
        nextAttemptAt: next,
        dispatchAfter: next,
        errorCategory: category,
      })
      return true
    },
    needsAttentionPending: async (id: string, round: number, at: number, category: string) => {
      const task = tasks.get(id)
      if (!task || task.status !== 'pending' || task.round !== round) return false
      tasks.set(id, { ...task, status: 'needs_attention', completedAt: at, errorCategory: category })
      return true
    },
    complete: async (id: string, token: string, at: number) => {
      if (loseCompletion) return false
      return finish(id, token, at, 'done', null)
    },
    skip: async (id: string, token: string, at: number, category: string) => finish(id, token, at, 'skipped', category),
    needsAttention: async (id: string, token: string, at: number, category: string) => finish(id, token, at, 'needs_attention', category),
  }
  function finish(id: string, token: string, at: number, status: DeliveryTask['status'], category: string | null) {
    const task = tasks.get(id)
    if (!task || task.status !== 'leased' || task.leaseToken !== token) return false
    tasks.set(id, { ...task, status, completedAt: at, errorCategory: category, leaseToken: null, leaseExpiresAt: null })
    return true
  }
  const ports = {
    clock: { now: () => clock },
    crypto: { randomToken: () => `lease_${clock}` },
    email: { send: email },
    queue: {
      send: async (message: QueueMessage, options?: QueueSendOptions) => { queued.push({ message, options }) },
      sendBatch: async () => {},
    },
    repositories: () => ({ deliveryTasks: repo, bookings: { byId: async () => bookingState } }),
  } as unknown as EnginePorts
  return {
    ports, tasks, queued, email, deleteCalendar,
    setNow(value: number) { clock = value },
    loseCompletion(value = true) { loseCompletion = value },
  }
}

describe('durable delivery recovery', () => {
  it('reserves accepted dispatch and lets Cron republish it after five minutes without execution', async () => {
    const task = emailTask()
    const h = harness([task])
    await dispatchDeliveryTask(task.id, h.ports)
    expect((h.tasks.get(task.id)?.dispatchAfter ?? 0) - NOW).toBe(5 * MINUTE)

    h.setNow(NOW + 5 * MINUTE)
    await recoverDueDeliveryTasks(h.ports, NOW + 5 * MINUTE, 5)
    expect(h.queued).toEqual([
      { message: { kind: 'delivery.task', taskId: task.id, round: 0 }, options: undefined },
      { message: { kind: 'delivery.task', taskId: task.id, round: 0 }, options: undefined },
    ])
  })

  it('consumes a round when queue publication fails instead of retrying that round every Cron tick', async () => {
    const task = emailTask()
    const h = harness([task])
    h.ports.queue.send = async () => { throw new Error('queue unavailable') }

    await expect(dispatchDeliveryTask(task.id, h.ports)).rejects.toThrow('queue unavailable')

    expect(h.tasks.get(task.id)).toMatchObject({
      status: 'pending',
      round: 1,
      nextAttemptAt: NOW + 2 * MINUTE,
      dispatchAfter: NOW + 2 * MINUTE,
      errorCategory: 'queue_publication_failed',
    })
  })

  it('allows only one concurrent consumer to execute a live task', async () => {
    const task = emailTask()
    const h = harness([task])
    await Promise.all([
      executeDeliveryTask(task.id, 0, h.ports, { deleteCalendar: h.deleteCalendar }),
      executeDeliveryTask(task.id, 0, h.ports, { deleteCalendar: h.deleteCalendar }),
    ])
    expect(h.email).toHaveBeenCalledTimes(1)
    expect(h.tasks.get(task.id)?.status).toBe('done')
  })

  it('lets Cron republish work after an execution lease expires', async () => {
    const task = emailTask({
      status: 'leased',
      leaseToken: 'abandoned',
      leaseExpiresAt: NOW - 1,
      dispatchAfter: NOW + 5 * MINUTE,
    })
    const h = harness([task])

    await recoverDueDeliveryTasks(h.ports, NOW, 5)

    expect(h.queued).toEqual([{
      message: { kind: 'delivery.task', taskId: task.id, round: 0 },
      options: undefined,
    }])
  })

  it('recovers an expired execution lease', async () => {
    const task = emailTask({ status: 'leased', leaseToken: 'dead', leaseExpiresAt: NOW - 1 })
    const h = harness([task])
    await executeDeliveryTask(task.id, 0, h.ports, { deleteCalendar: h.deleteCalendar })
    expect(h.email).toHaveBeenCalledTimes(1)
    expect(h.tasks.get(task.id)?.status).toBe('done')
  })

  it('persists the next absolute round before arranging delayed delivery', async () => {
    const task = emailTask()
    const h = harness([task])
    h.email.mockRejectedValueOnce(new EmailDeliveryError('temporary', true, 503))
    await executeDeliveryTask(task.id, 0, h.ports, { deleteCalendar: h.deleteCalendar })
    expect(h.tasks.get(task.id)).toMatchObject({ status: 'pending', round: 1, nextAttemptAt: NOW + 2 * MINUTE })
    expect(h.queued).toEqual([{
      message: { kind: 'delivery.task', taskId: task.id, round: 1 },
      options: { delaySeconds: 120 },
    }])
  })

  it('stops permanent failures and email work at the meeting deadline', async () => {
    const permanent = emailTask()
    const h1 = harness([permanent])
    h1.email.mockRejectedValueOnce(new EmailDeliveryError('invalid recipient', false, 400))
    await executeDeliveryTask(permanent.id, 0, h1.ports, { deleteCalendar: h1.deleteCalendar })
    expect(h1.tasks.get(permanent.id)).toMatchObject({ status: 'needs_attention', errorCategory: 'email_permanent' })
    expect(h1.queued).toEqual([])

    const late = emailTask({ nextAttemptAt: START })
    const h2 = harness([late], START)
    await executeDeliveryTask(late.id, 0, h2.ports, { deleteCalendar: h2.deleteCalendar })
    expect(h2.email).not.toHaveBeenCalled()
    expect(h2.tasks.get(late.id)).toMatchObject({ status: 'needs_attention', errorCategory: 'deadline_elapsed' })
  })

  it('keeps native deletion eligible after the meeting starts', async () => {
    const task = calendarTask({ nextAttemptAt: START + MINUTE })
    const h = harness([task], START + MINUTE)
    await executeDeliveryTask(task.id, 0, h.ports, { deleteCalendar: h.deleteCalendar })
    expect(h.deleteCalendar).toHaveBeenCalledWith('bk_1')
    expect(h.tasks.get(task.id)?.status).toBe('done')
  })

  it('reuses the frozen email payload and key if completion persistence was lost', async () => {
    const task = emailTask()
    const h = harness([task])
    h.loseCompletion()
    await executeDeliveryTask(task.id, 0, h.ports, { deleteCalendar: h.deleteCalendar })
    h.loseCompletion(false)
    h.setNow(NOW + 61_000)
    await executeDeliveryTask(task.id, 0, h.ports, { deleteCalendar: h.deleteCalendar })
    expect(h.email).toHaveBeenCalledTimes(2)
    expect(h.email.mock.calls[0]?.[0]).toEqual(h.email.mock.calls[1]?.[0])
    expect((h.email.mock.calls[1]?.[0] as { delivery?: { key: string } }).delivery?.key).toBe('booking/bk_1/cancelled/guest/hash')
  })

  it('skips a superseded cancellation email but still removes the old event', async () => {
    const email = emailTask()
    const calendar = calendarTask()
    const h = harness([email, calendar], NOW, booking({ status: 'rescheduled', rescheduledTo: 'bk_2' }))
    await executeDeliveryTask(email.id, 0, h.ports, { deleteCalendar: h.deleteCalendar })
    await executeDeliveryTask(calendar.id, 0, h.ports, { deleteCalendar: h.deleteCalendar })
    expect(h.email).not.toHaveBeenCalled()
    expect(h.tasks.get(email.id)).toMatchObject({ status: 'skipped', errorCategory: 'superseded' })
    expect(h.deleteCalendar).toHaveBeenCalledWith('bk_1')
  })
})
