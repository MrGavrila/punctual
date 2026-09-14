import { describe, expect, it } from 'vitest'
import { BASE_CSS, BOOKING_THEME_CSS, LANDING_CSS, pageCss, TOKENS } from '../../src/http/styles.js'

/**
 * These CSS blocks are plain template-string literals — nothing checks them
 * at build time the way TypeScript checks code. Writing two token names
 * separated by a slash inside a prose comment (e.g. "ink dash star, then a
 * slash, then green dash star") can accidentally spell the comment's own
 * closing delimiter, closing it early and silently corrupting every
 * declaration until the next accidental close, with no error anywhere in the
 * toolchain — this caught a real instance of exactly that bug.
 * `unbalancedComment` is a standalone scanner, not the actual CSS parser,
 * but a stray early close is the one failure mode worth guarding here.
 */
function unbalancedComment(css: string): boolean {
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('/*', i)) {
      depth++
      i++
    } else if (css.startsWith('*/', i)) {
      if (depth === 0) return true
      depth--
      i++
    }
  }
  return depth !== 0
}

describe('the generated CSS blocks', () => {
  it('never contain a stray or unbalanced /* */ comment marker', () => {
    for (const [name, css] of [
      ['TOKENS', TOKENS],
      ['BASE_CSS', BASE_CSS],
      ['LANDING_CSS', LANDING_CSS],
      ['pageCss()', pageCss()],
    ] as const) {
      expect({ name, unbalanced: unbalancedComment(css) }).toEqual({ name, unbalanced: false })
    }
  })

  it('applies the Kisielowa theme to every remaining application page', () => {
    const css = pageCss()
    expect(BOOKING_THEME_CSS).toContain('body{')
    expect(BOOKING_THEME_CSS).not.toContain('body.pu-booking-theme')
    expect(css).toContain('--pu-surface-canvas:#f5f5f5')
    expect(css).toContain('--pu-surface-raised:#fff')
    expect(css).toContain('--pu-text-primary:#111')
    expect(css).toContain('--pu-radius:2px')
    expect(css).toContain(':root[data-theme="dark"] body{')
    expect(css).toContain('--pu-surface-canvas:#111')
    expect(css).toContain('--pu-surface-raised:#1c1c1c')
    expect(css).toContain('--pu-text-primary:#f5f5f5')
  })

  it('keeps semantic status colours while making the public booking controls graphite', () => {
    const css = pageCss()
    expect(css).toContain('--pu-status-success:#0E7C4C')
    expect(css).toContain('--pu-green-fill:#333')
    expect(css).toContain('--pu-green-fill-hover:#111')
    expect(css).toContain('body .pu-meta .pu-dot{background:#333}')
    expect(css).toContain('@media(hover:hover) and (pointer:fine)')
  })
})
