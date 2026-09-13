import { describe, expect, it, vi } from 'vitest'
import { runScheduledTasks } from '../../src/adapters/scheduled.js'
import type { DeliveryTask, EnginePorts, QueueMessage } from '../../src/ports.js'

const NOW = Date.UTC(2026, 8, 13, 10, 0, 0)

describe('scheduled delivery recovery', () => {
  it('publishes at most the due recovery batch alongside the existing cron work', async () => {
    const task = {
      id: 'booking/bk_1/cancelled/guest',
      bookingId: 'bk_1',
      actionVersion: 'cancelled',
      audience: 'guest',
      kind: 'email',
      payload: {},
      deadlineAt: NOW + 60_000,
      createdAt: NOW,
      status: 'pending',
      round: 0,
      nextAttemptAt: NOW,
      dispatchAfter: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      firstAttemptAt: null,
      completedAt: null,
      errorCategory: null,
    } satisfies DeliveryTask
    const expireHolds = vi.fn(async () => 0)
    const pruneLocksBefore = vi.fn(async () => 0)
    const due = vi.fn(async (_now: number, limit: number) => limit === 5 ? [task] : [])
    const reserveDispatch = vi.fn(async () => true)
    const queued: QueueMessage[] = []
    const repositories = {
      slotLocks: { expireHolds, pruneLocksBefore },
      bookings: { dueBetween: async () => [] },
      deliveryTasks: {
        due,
        byId: async () => task,
        reserveDispatch,
      },
    }
    const ports = {
      config: { telemetryEnabled: false },
      repositories: () => repositories,
      queue: { send: async (message: QueueMessage) => { queued.push(message) } },
      clock: { now: () => NOW },
    } as unknown as EnginePorts

    await runScheduledTasks(ports, NOW)

    expect(expireHolds).toHaveBeenCalledWith(NOW)
    expect(pruneLocksBefore).toHaveBeenCalledWith(NOW - 7 * 24 * 60 * 60_000)
    expect(due).toHaveBeenCalledWith(NOW, 5)
    expect(reserveDispatch).toHaveBeenCalledOnce()
    expect(queued).toEqual([{ kind: 'delivery.task', taskId: task.id, round: 0 }])
  })
})
