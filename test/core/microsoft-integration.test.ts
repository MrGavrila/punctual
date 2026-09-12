import { describe, expect, it } from 'vitest'
import { createMicrosoftProvider } from '../../src/adapters/microsoft/provider.js'
import { createEnvOAuthCredentials } from '../../src/adapters/oauth.js'
import type { CalendarConnection, OAuthTokens } from '../../src/core/domain/types.js'

const tokens: OAuthTokens = {
  accessToken: 'graph.valid',
  refreshToken: 'graph.refresh',
  expiresAt: Date.now() + 3_600_000,
  scope: 'Calendars.ReadWrite',
}

const connection: CalendarConnection = {
  id: 'conn_ms',
  userId: 'u1',
  provider: 'microsoft',
  providerAccountEmail: 'host@example.com',
  encryptedTokens: 'unused-in-this-test',
  keyVersion: 1,
  calendarIdsRead: ['host@example.com'],
  calendarIdWrite: 'primary',
  syncStatus: 'ok',
  createdAt: 0,
}

describe('creating an event through Microsoft Graph', () => {
  it('uses the booking id as the stable Graph transaction id', async () => {
    let body: Record<string, unknown> | undefined
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'evt_ms' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    const provider = createMicrosoftProvider({
      oauth: createEnvOAuthCredentials(
        { MICROSOFT_CLIENT_ID: 'cid', MICROSOFT_CLIENT_SECRET: 'csec' },
        'https://punctual.test',
      ),
      crypto: {
        decrypt: async () => JSON.stringify(tokens),
        randomToken: (n = 16) => 'r'.repeat(n),
      },
      clock: { now: () => Date.now() },
      onTokensRefreshed: async () => {},
      fetch: fetchImpl,
    })

    await provider.createEvent(connection, {
      title: 'Intro call',
      description: 'Calendar retry verification',
      start: Date.UTC(2026, 8, 14, 9),
      end: Date.UTC(2026, 8, 14, 9, 30),
      timezone: 'Europe/Vienna',
      attendees: [{ email: 'guest@example.com', name: 'Guest' }],
      createConference: false,
      idempotencyKey: 'booking-123',
    })

    expect(body?.['transactionId']).toBe('booking-123')
  })
})
