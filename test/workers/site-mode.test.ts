import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import worker, { type Env } from '../../src/index.js'

const BOOKING_PATH = '/dr-kisielowa/introductory-call'

function bookingOnlyEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    PUBLIC_SITE_MODE: 'booking-only',
    DEMO_BOOKING_PATH: BOOKING_PATH,
    REST_API_ENABLED: '0',
    MCP_ENABLED: '0',
    BRAND_NAME: 'Dr. Kisielowa',
    ...overrides,
  } as Env
}

function request(path: string, init?: RequestInit, overrides?: Partial<Env>): Promise<Response> {
  return worker.fetch(
    new Request(`https://book.kisielowa.com${path}`, init),
    bookingOnlyEnv(overrides),
    createExecutionContext(),
  )
}

describe('booking-only public site mode', () => {
  it('redirects the root to the configured booking page', async () => {
    const response = await request('/')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(BOOKING_PATH)
  })

  it.each([
    ['GET', '/docs'],
    ['POST', '/docs'],
    ['GET', '/docs/self-hosting'],
    ['GET', '/docs/api'],
    ['GET', '/docs/mcp'],
    ['GET', '/calendly-alternative'],
  ])('returns 404 for disabled marketing route %s %s', async (method, path) => {
    const response = await request(path, { method })

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('https://punctual.sh')
  })

  it.each(['/docs/self-hosting', '/dr-kisielowa/dashboard'])(
    'uses Kisielowa branding on not-found page %s',
    async (path) => {
      const response = await request(path)
      const html = await response.text()

      expect(response.status).toBe(404)
      expect(html).toContain(
        '<link rel="icon" href="https://kisielowa.com/assets/favicon.svg" type="image/svg+xml">',
      )
      expect(html).not.toContain('<link rel="icon" href="/favicon.svg"')
    },
  )

  it('uses the Kisielowa favicon on the owner sign-in page', async () => {
    const response = await request('/login')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain(
      '<link rel="icon" href="https://kisielowa.com/assets/favicon.svg" type="image/svg+xml">',
    )
    expect(html).not.toContain('<link rel="icon" href="/favicon.svg"')
  })

  it('keeps owner, guest-support and legal routes available', async () => {
    for (const path of ['/login', '/privacy', '/terms', '/health', '/robots.txt']) {
      const response = await request(path)
      expect({ path, status: response.status }).toEqual({ path, status: 200 })
    }

    const dashboard = await request('/dashboard')
    expect(dashboard.status).toBe(302)
    expect(dashboard.headers.get('location')).toContain('/login')
  })

  it('does not expose Punctual attribution on guest management errors', async () => {
    const response = await request('/booking/not-a-booking?token=invalid')
    const html = await response.text()

    expect(response.status).toBe(400)
    expect(html).not.toContain('https://punctual.sh')
    expect(html).toContain(
      '<link rel="icon" href="https://kisielowa.com/assets/favicon.svg" type="image/svg+xml">',
    )
    expect(html).not.toContain('<link rel="icon" href="/favicon.svg"')
  })

  it('does not expose Punctual attribution on authentication errors', async () => {
    const response = await request('/auth/google/callback?purpose=identity')

    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('https://punctual.sh')
  })

  it.each([
    ['GET', '/api/v1'],
    ['GET', '/api/v1/event-types'],
    ['POST', '/api/v1/event-types'],
    ['GET', '/mcp'],
    ['POST', '/mcp'],
    ['POST', '/mcp/anything'],
    ['GET', '/dashboard/api-keys'],
    ['POST', '/dashboard/api-keys'],
    ['GET', '/dashboard/api-keys/key_1/revoke'],
    ['POST', '/dashboard/api-keys/key_1/delete'],
  ])('returns 404 for disabled programmatic surface %s %s', async (method, path) => {
    const response = await request(path, { method })

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('https://punctual.sh')
  })

  it('refuses booking-only mode without a safe local booking path', async () => {
    await expect(request('/', undefined, { DEMO_BOOKING_PATH: undefined })).rejects.toThrow(
      'DEMO_BOOKING_PATH',
    )
    await expect(request('/', undefined, { DEMO_BOOKING_PATH: '//example.com/escape' })).rejects.toThrow(
      'DEMO_BOOKING_PATH',
    )
  })

  it('refuses ambiguous API and MCP feature flags', async () => {
    await expect(request('/', undefined, { REST_API_ENABLED: 'yes' })).rejects.toThrow(
      'REST_API_ENABLED',
    )
    await expect(request('/', undefined, { MCP_ENABLED: 'false' })).rejects.toThrow('MCP_ENABLED')
  })

  it('can re-enable REST and MCP independently without changing site mode', async () => {
    const api = await request('/api/v1/event-types', undefined, { REST_API_ENABLED: '1' })
    expect(api.status).toBe(401)

    const mcpStillDisabled = await request('/mcp', { method: 'POST' }, { REST_API_ENABLED: '1' })
    expect(mcpStillDisabled.status).toBe(404)

    const mcp = await request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      },
      { MCP_ENABLED: '1' },
    )
    expect(mcp.status).toBe(401)

    const apiStillDisabled = await request('/api/v1/event-types', undefined, { MCP_ENABLED: '1' })
    expect(apiStillDisabled.status).toBe(404)
  })

  it('fails closed when booking-only API feature flags are omitted', async () => {
    const overrides = { REST_API_ENABLED: undefined, MCP_ENABLED: undefined }

    expect((await request('/api/v1/event-types', undefined, overrides)).status).toBe(404)
    expect((await request('/mcp', { method: 'POST' }, overrides)).status).toBe(404)
    expect((await request('/dashboard/api-keys', undefined, overrides)).status).toBe(404)
  })
})
