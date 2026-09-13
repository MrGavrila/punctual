import type { EmailMessage, EnginePorts } from '../ports.js'
import { EmailDeliveryError } from './email/index.js'
import { CalendarApiError, needsReconnect } from './oauth.js'

const MINUTE = 60_000
const RETRY_OFFSETS_MS = [0, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE, 120 * MINUTE] as const
const FINAL_GRACE_MS = 5 * MINUTE
const DISPATCH_RECOVERY_MS = 5 * MINUTE
const EXECUTION_LEASE_MS = 60_000
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * MINUTE

export interface DeliveryTaskEffects {
  deleteCalendar(bookingId: string): Promise<void>
}

export async function dispatchDeliveryTask(taskId: string, ports: EnginePorts): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const task = await repos.deliveryTasks.byId(taskId)
  if (!task) return
  const now = ports.clock.now()
  const expiredLease = task.status === 'leased' && task.leaseExpiresAt !== null && task.leaseExpiresAt <= now
  if (task.status !== 'pending' && !expiredLease) return
  if (task.nextAttemptAt > now || (task.status === 'pending' && task.dispatchAfter > now)) return
  const reserved = await repos.deliveryTasks.reserveDispatch(
    task.id,
    task.round,
    now,
    now + DISPATCH_RECOVERY_MS,
  )
  if (!reserved) return
  const finalStart = task.createdAt + RETRY_OFFSETS_MS[RETRY_OFFSETS_MS.length - 1]!
  if (now > finalStart + FINAL_GRACE_MS) {
    await repos.deliveryTasks.needsAttentionPending(task.id, task.round, now, 'retry_window_elapsed')
    return
  }
  if (task.kind === 'email' && task.deadlineAt !== null && now >= task.deadlineAt) {
    await repos.deliveryTasks.needsAttentionPending(task.id, task.round, now, 'deadline_elapsed')
    return
  }

  try {
    await ports.queue.send({ kind: 'delivery.task', taskId: task.id, round: task.round })
  } catch (err) {
    const nextRound = nextRoundAfter(task.round, task.createdAt, now)
    if (nextRound === null) {
      await repos.deliveryTasks.needsAttentionPending(task.id, task.round, now, 'queue_rounds_exhausted')
    } else {
      const nextAttemptAt = task.createdAt + RETRY_OFFSETS_MS[nextRound]!
      if (task.kind === 'email' && task.deadlineAt !== null && nextAttemptAt >= task.deadlineAt) {
        await repos.deliveryTasks.needsAttentionPending(task.id, task.round, now, 'deadline_elapsed')
      } else {
        await repos.deliveryTasks.scheduleDispatchRetry(
          task.id,
          task.round,
          nextRound,
          nextAttemptAt,
          'queue_publication_failed',
        )
      }
    }
    throw err
  }
}

export async function recoverDueDeliveryTasks(ports: EnginePorts, now: number, limit = 5): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const due = await repos.deliveryTasks.due(now, Math.min(5, Math.max(0, limit)))
  for (const task of due) {
    await dispatchDeliveryTask(task.id, ports).catch((err) => {
      console.error('[punctual] delivery task publication failed', safeErrorCategory(err))
    })
  }
}

export async function executeDeliveryTask(
  taskId: string,
  expectedRound: number,
  ports: EnginePorts,
  effects: DeliveryTaskEffects,
): Promise<void> {
  const repos = ports.repositories({ consistency: 'bookmark' })
  const now = ports.clock.now()
  const leaseToken = ports.crypto.randomToken(18)
  const task = await repos.deliveryTasks.claimExecution(
    taskId,
    expectedRound,
    now,
    leaseToken,
    now + EXECUTION_LEASE_MS,
  )
  if (!task) return

  const booking = await repos.bookings.byId(task.bookingId)
  if (!booking) {
    await repos.deliveryTasks.skip(task.id, leaseToken, now, 'booking_missing')
    return
  }

  if (task.kind === 'email') {
    if (task.actionVersion === 'cancelled' && (booking.status !== 'cancelled' || booking.rescheduledTo !== null)) {
      await repos.deliveryTasks.skip(task.id, leaseToken, now, 'superseded')
      return
    }
    if (task.deadlineAt !== null && now >= task.deadlineAt) {
      await repos.deliveryTasks.needsAttention(task.id, leaseToken, now, 'deadline_elapsed')
      return
    }
    if (task.firstAttemptAt !== null && now - task.firstAttemptAt >= RESEND_IDEMPOTENCY_WINDOW_MS) {
      await repos.deliveryTasks.needsAttention(task.id, leaseToken, now, 'idempotency_window_elapsed')
      return
    }
  }

  if (now > task.createdAt + RETRY_OFFSETS_MS[RETRY_OFFSETS_MS.length - 1]! + FINAL_GRACE_MS) {
    await repos.deliveryTasks.needsAttention(task.id, leaseToken, now, 'retry_window_elapsed')
    return
  }

  try {
    if (task.kind === 'email') {
      await ports.email.send(task.payload as EmailMessage)
    } else {
      await effects.deleteCalendar(task.bookingId)
    }
    await repos.deliveryTasks.complete(task.id, leaseToken, ports.clock.now())
  } catch (err) {
    if (!isRetryable(err)) {
      await repos.deliveryTasks.needsAttention(
        task.id,
        leaseToken,
        ports.clock.now(),
        task.kind === 'email' ? 'email_permanent' : 'calendar_permanent',
      )
      return
    }

    const failedAt = ports.clock.now()
    const nextRound = nextRoundAfter(task.round, task.createdAt, failedAt)
    if (nextRound === null) {
      await repos.deliveryTasks.needsAttention(task.id, leaseToken, failedAt, 'retry_rounds_exhausted')
      return
    }
    const nextAttemptAt = task.createdAt + RETRY_OFFSETS_MS[nextRound]!
    if (nextAttemptAt > task.createdAt + RETRY_OFFSETS_MS[RETRY_OFFSETS_MS.length - 1]! + FINAL_GRACE_MS) {
      await repos.deliveryTasks.needsAttention(task.id, leaseToken, failedAt, 'retry_window_elapsed')
      return
    }
    if (task.kind === 'email' && task.deadlineAt !== null && nextAttemptAt >= task.deadlineAt) {
      await repos.deliveryTasks.needsAttention(task.id, leaseToken, failedAt, 'deadline_elapsed')
      return
    }

    const scheduled = await repos.deliveryTasks.scheduleRetry(
      task.id,
      leaseToken,
      nextRound,
      nextAttemptAt,
      safeErrorCategory(err),
    )
    if (!scheduled) return

    try {
      await ports.queue.send(
        { kind: 'delivery.task', taskId: task.id, round: nextRound },
        { delaySeconds: Math.max(1, Math.ceil((nextAttemptAt - failedAt) / 1_000)) },
      )
      // The delayed message is expected at nextAttemptAt. Cron intervenes
      // only if it still has not run five minutes later.
      await repos.deliveryTasks.reserveDispatch(
        task.id,
        nextRound,
        nextAttemptAt,
        nextAttemptAt + DISPATCH_RECOVERY_MS,
      )
    } catch (publishError) {
      // scheduleRetry left dispatch_after at nextAttemptAt, so Cron remains
      // the recovery path if this delayed publication was not accepted.
      console.error('[punctual] delivery task retry publication failed', safeErrorCategory(publishError))
    }
  }
}

function nextRoundAfter(currentRound: number, createdAt: number, now: number): number | null {
  for (let round = currentRound + 1; round < RETRY_OFFSETS_MS.length; round += 1) {
    if (createdAt + RETRY_OFFSETS_MS[round]! > now) return round
  }
  return null
}

function isRetryable(err: unknown): boolean {
  if (err instanceof EmailDeliveryError) return err.retryable
  if (hasRetryableFlag(err)) return err.retryable
  if (needsReconnect(err)) return false
  if (!(err instanceof CalendarApiError)) return true
  if (err.status === undefined || err.status === 408 || err.status === 429 || err.status >= 500) return true
  return err.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(err.body ?? '')
}

function safeErrorCategory(err: unknown): string {
  if (err instanceof EmailDeliveryError) return err.retryable ? 'email_temporary' : 'email_permanent'
  if (hasRetryableFlag(err)) return err.retryable ? 'calendar_temporary' : 'calendar_permanent'
  if (needsReconnect(err)) return 'calendar_reconnect_required'
  if (err instanceof CalendarApiError) return isRetryable(err) ? 'calendar_temporary' : 'calendar_permanent'
  return 'temporary_failure'
}

function hasRetryableFlag(err: unknown): err is { retryable: boolean } {
  return typeof err === 'object' && err !== null && typeof Reflect.get(err, 'retryable') === 'boolean'
}
