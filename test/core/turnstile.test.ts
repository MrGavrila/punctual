import { describe, expect, it, vi } from 'vitest'
import { createTurnstileVerifier } from '../../src/adapters/turnstile.js'

const TEST_SITE_KEY = '1x00000000000000000000AA'
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA'
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

function verifier(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof createTurnstileVerifier>[0]> = {},
) {
  return createTurnstileVerifier({
    enabled: true,
    siteKey: TEST_SITE_KEY,
    secretKey: TEST_SECRET_KEY,
    expectedHostname: 'book.example.com',
    expectedAction: 'booking_create',
    fetch,
    ...overrides,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Turnstile verifier', () => {
  it('accepts only a successful response with the expected hostname and action', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        hostname: 'book.example.com',
        action: 'booking_create',
        'error-codes': [],
      }),
    )
    const turnstile = verifier(fetch)

    await expect(turnstile.verify({ token: DUMMY_TOKEN, remoteIp: '203.0.113.10' })).resolves.toEqual({ ok: true })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' })
    expect(String(init?.body)).toContain(`secret=${encodeURIComponent(TEST_SECRET_KEY)}`)
    expect(String(init?.body)).toContain(`response=${encodeURIComponent(DUMMY_TOKEN)}`)
    expect(String(init?.body)).toContain('remoteip=203.0.113.10')
  })

  it.each([
    ['a failed challenge', { success: false, 'error-codes': ['invalid-input-response'] }],
    ['an expired or reused token', { success: false, 'error-codes': ['timeout-or-duplicate'] }],
    ['a wrong hostname', { success: true, hostname: 'attacker.example', action: 'booking_create' }],
    ['a wrong action', { success: true, hostname: 'book.example.com', action: 'login' }],
  ])('rejects %s without exposing provider details', async (_label, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(body))

    await expect(verifier(fetch).verify({ token: DUMMY_TOKEN, remoteIp: '203.0.113.10' })).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it.each([
    ['an internal provider error', { success: false, 'error-codes': ['internal-error'] }, 'unavailable'],
    ['a missing secret', { success: false, 'error-codes': ['missing-input-secret'] }, 'misconfigured'],
    ['an invalid secret', { success: false, 'error-codes': ['invalid-input-secret'] }, 'misconfigured'],
    ['a malformed Siteverify request', { success: false, 'error-codes': ['bad-request'] }, 'misconfigured'],
    ['an unclassified failure response', { success: false }, 'unavailable'],
  ] as const)('classifies %s correctly', async (_label, body, reason) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(body))

    await expect(verifier(fetch).verify({ token: DUMMY_TOKEN, remoteIp: '203.0.113.10' })).resolves.toEqual({
      ok: false,
      reason,
    })
  })

  it.each(['', 'x'.repeat(2049)])('rejects a missing or oversized token before calling Siteverify', async (token) => {
    const fetch = vi.fn<typeof globalThis.fetch>()

    await expect(verifier(fetch).verify({ token, remoteIp: '203.0.113.10' })).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['a provider HTTP failure', vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({}, 503))],
    ['a malformed provider response', vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ success: true }))],
    ['a provider network failure', vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('network down'))],
  ])('fails closed when Siteverify has %s', async (_label, fetch) => {
    await expect(verifier(fetch).verify({ token: DUMMY_TOKEN, remoteIp: '203.0.113.10' })).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('aborts Siteverify after the configured timeout and fails closed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    )

    await expect(
      verifier(fetch, { timeoutMs: 10 }).verify({ token: DUMMY_TOKEN, remoteIp: '203.0.113.10' }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps incomplete enabled configuration local to public booking verification', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const turnstile = verifier(fetch, { secretKey: undefined })

    expect(turnstile.enabled).toBe(true)
    expect(turnstile.configured).toBe(false)
    await expect(turnstile.verify({ token: DUMMY_TOKEN, remoteIp: '203.0.113.10' })).resolves.toEqual({
      ok: false,
      reason: 'misconfigured',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does no verification when explicitly disabled', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const turnstile = verifier(fetch, { enabled: false })

    expect(turnstile.enabled).toBe(false)
    expect(turnstile.siteKey).toBeNull()
    await expect(turnstile.verify({ token: '', remoteIp: '203.0.113.10' })).resolves.toEqual({
      ok: true,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
