import type { Turnstile, TurnstileVerification } from '../ports.js'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TOKEN_LENGTH = 2_048

interface SiteverifyResponse {
  success?: unknown
  hostname?: unknown
  action?: unknown
  'error-codes'?: unknown
}

export interface TurnstileVerifierOptions {
  enabled: boolean
  siteKey?: string
  secretKey?: string
  expectedHostname?: string
  expectedAction: string
  fetch?: typeof globalThis.fetch
  /** Production uses five seconds. Tests may shorten the deadline. */
  timeoutMs?: number
}

/**
 * Cloudflare Turnstile's server-side boundary.
 *
 * The secret remains closed over in this adapter and is never exposed through
 * the port. Incomplete configuration does not prevent the Worker from
 * starting; only the protected public write fails closed.
 */
export function createTurnstileVerifier(options: TurnstileVerifierOptions): Turnstile {
  const siteKey = options.siteKey?.trim() || null
  const secretKey = options.secretKey?.trim() || null
  const expectedHostname = options.expectedHostname?.trim().toLowerCase() || null
  const expectedAction = options.expectedAction.trim()
  const configured = Boolean(siteKey && secretKey && expectedHostname && expectedAction)
  const fetch_ = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    enabled: options.enabled,
    siteKey: options.enabled ? siteKey : null,
    configured: options.enabled && configured,
    async verify({ token, remoteIp }): Promise<TurnstileVerification> {
      if (!options.enabled) return { ok: true }
      if (!configured) return { ok: false, reason: 'misconfigured' }
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: 'invalid' }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const body = new URLSearchParams({
          secret: secretKey!,
          response: token,
          ...(remoteIp && remoteIp !== 'unknown' ? { remoteip: remoteIp } : {}),
        })
        const response = await fetch_(SITEVERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        })
        if (!response.ok) return { ok: false, reason: 'unavailable' }

        let result: SiteverifyResponse
        try {
          result = (await response.json()) as SiteverifyResponse
        } catch {
          return { ok: false, reason: 'unavailable' }
        }

        if (result.success !== true) {
          const rawErrorCodes = result['error-codes']
          const errorCodes =
            Array.isArray(rawErrorCodes) && rawErrorCodes.every((code) => typeof code === 'string')
              ? rawErrorCodes
              : null
          if (!errorCodes || errorCodes.length === 0) return { ok: false, reason: 'unavailable' }
          if (
            errorCodes.some((code) =>
              ['missing-input-secret', 'invalid-input-secret', 'bad-request'].includes(code),
            )
          ) {
            return { ok: false, reason: 'misconfigured' }
          }
          if (errorCodes.includes('internal-error')) return { ok: false, reason: 'unavailable' }
          if (
            errorCodes.some((code) =>
              ['missing-input-response', 'invalid-input-response', 'timeout-or-duplicate'].includes(code),
            )
          ) {
            return { ok: false, reason: 'invalid' }
          }
          return { ok: false, reason: 'unavailable' }
        }
        if (typeof result.hostname !== 'string' || typeof result.action !== 'string') {
          return { ok: false, reason: 'unavailable' }
        }
        if (result.hostname.toLowerCase() !== expectedHostname || result.action !== expectedAction) {
          return { ok: false, reason: 'invalid' }
        }
        return { ok: true }
      } catch {
        return { ok: false, reason: 'unavailable' }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
