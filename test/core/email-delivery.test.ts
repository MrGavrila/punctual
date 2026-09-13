import { describe, expect, it, vi } from 'vitest'
import { EmailDeliveryError } from '../../src/adapters/email/index.js'
import { handleOne, handleQueueBatch } from '../../src/adapters/queue/consumer.js'
import type { EmailMessage, EnginePorts, QueueMessage, QueueSendOptions } from '../../src/ports.js'

const MINUTE = 60_000
const PREPARED = Date.UTC(2026, 8, 13, 10, 0, 0)

function message(round = 0): Extract<QueueMessage, { kind: 'email' }> {
  return {
    kind: 'email',
    message: {
      to: 'guest@example.test',
      subject: 'Booked',
      html: '<p>Booked</p>',
      text: 'Booked',
      delivery: {
        key: 'booking/bk_1/confirmed/guest/aaaaaaaaaaaaaaaa',
        preparedAt: PREPARED,
        deadlineAt: PREPARED + 4 * 60 * MINUTE,
        round,
      },
    },
  }
}

function harness(now: number, failure?: unknown) {
  const sent: Array<{ message: QueueMessage; options?: QueueSendOptions }> = []
  const email = vi.fn(async (_message: EmailMessage) => {
    if (failure) throw failure
  })
  const ports = {
    clock: { now: () => now },
    email: { send: email },
    queue: {
      send: async (queued: QueueMessage, options?: QueueSendOptions) => { sent.push({ message: queued, options }) },
      sendBatch: async () => {},
    },
  } as unknown as EnginePorts
  return { ports, email, sent }
}

describe('bounded booking email delivery', () => {
  it('requeues a temporary failure for the next absolute round with the same payload and key', async () => {
    const h = harness(PREPARED, new EmailDeliveryError('temporary', true, 503))
    const original = message()

    await handleOne(original, h.ports)

    expect(h.email).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([{
      message: { ...original, message: { ...original.message, delivery: { ...original.message.delivery!, round: 1 } } },
      options: { delaySeconds: 120 },
    }])
  })

  it('uses the current broker message with the bounded delay if publishing its replacement fails', async () => {
    const h = harness(PREPARED, new EmailDeliveryError('temporary', true, 503))
    h.ports.queue.send = async () => { throw new Error('queue unavailable') }
    const ack = vi.fn()
    const retry = vi.fn()

    await handleQueueBatch({
      messages: [{ body: message(), attempts: 1, ack, retry }],
    } as unknown as MessageBatch, h.ports)

    expect(ack).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 120 })
  })

  it('skips missed rounds instead of executing a catch-up burst', async () => {
    const h = harness(PREPARED + 8 * MINUTE)
    const original = message()

    await handleOne(original, h.ports)

    expect(h.email).not.toHaveBeenCalled()
    expect(h.sent[0]?.message.kind).toBe('email')
    expect((h.sent[0]?.message as Extract<QueueMessage, { kind: 'email' }>).message.delivery?.round).toBe(2)
    expect(h.sent[0]?.options).toEqual({ delaySeconds: 120 })
  })

  it('does not retry a permanent rejection', async () => {
    const h = harness(PREPARED, new EmailDeliveryError('permanent', false, 400))
    await handleOne(message(), h.ports)
    expect(h.email).toHaveBeenCalledTimes(1)
    expect(h.sent).toEqual([])
  })

  it('does not start at or after the meeting deadline', async () => {
    const h = harness(PREPARED + 4 * 60 * MINUTE)
    await handleOne(message(), h.ports)
    expect(h.email).not.toHaveBeenCalled()
    expect(h.sent).toEqual([])
  })

  it('stops after the final 120-minute round and the five-minute scheduling allowance', async () => {
    const final = harness(PREPARED + 120 * MINUTE, new EmailDeliveryError('temporary', true, 503))
    await handleOne(message(4), final.ports)
    expect(final.email).toHaveBeenCalledTimes(1)
    expect(final.sent).toEqual([])

    const expired = harness(PREPARED + 126 * MINUTE)
    await handleOne(message(4), expired.ports)
    expect(expired.email).not.toHaveBeenCalled()
    expect(expired.sent).toEqual([])
  })
})
