import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
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

function declarations(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!.replace(/\s+/g, ' ').trim(),
    ]),
  )
}

function tokenBlocks(css: string): Record<string, Record<string, string>> {
  const light = css.match(/:root\{([\s\S]*?)\n\}/)?.[1]
  const automaticDark = css.match(/:root:not\(\[data-theme=light\]\)\{([\s\S]*?)\n\s*\}/)?.[1]
  const forcedDark = css.match(/:root\[data-theme=dark\]\{([\s\S]*?)\n\}/)?.[1]
  if (!light || !automaticDark || !forcedDark) throw new Error('Expected light and dark token blocks')
  return {
    light: declarations(light),
    automaticDark: declarations(automaticDark),
    forcedDark: declarations(forcedDark),
  }
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

  it('keeps the static semantic-token reference aligned with runtime tokens', () => {
    const reference = readFileSync(new URL('../../docs/semantic-tokens.html', import.meta.url), 'utf8')
    expect(tokenBlocks(reference)).toEqual(tokenBlocks(TOKENS))
  })

  it('applies the Kisielowa theme to every remaining application page', () => {
    const css = pageCss()
    expect(BOOKING_THEME_CSS).not.toContain('body.pu-booking-theme')
    expect(css).not.toMatch(/#fafaf7/i)
    expect(css).toContain('--pu-paper:#fff')
    expect(css).toContain('--pu-paper-dim:#eee')
    expect(css).toContain('--pu-line:#ddd')
    expect(css).toContain('--pu-surface-canvas:#f5f5f5')
    expect(css).toContain('--pu-surface-raised:#fff')
    expect(css).toContain('--pu-text-primary:#111')
    expect(css).toContain('--pu-radius:2px')
    expect(css).toContain('--pu-font-display:var(--pu-font-ui)')
    expect(css).toContain('--pu-field-border:var(--pu-border-strong)')
    expect(css).toContain(':root[data-theme=dark]{')
    expect(css).toContain('--pu-surface-canvas:#111')
    expect(css).toContain('--pu-surface-raised:#1c1c1c')
    expect(css).toContain('--pu-text-primary:#f5f5f5')
    expect(css).toContain('--pu-text-on-accent:#111')
    expect(LANDING_CSS).toContain('.pu-embed-frame iframe{border-radius:var(--pu-radius)}')
    expect(LANDING_CSS).not.toContain('calc(var(--pu-radius-lg) - .5rem)')
    expect(LANDING_CSS).toContain('background:var(--pu-green-fill);color:var(--pu-text-on-accent)')
    expect(css).toContain('.pu-mark span{color:inherit}')
    expect(css).toContain('.pu-ring-dot{fill:currentColor}')
    expect(css).toContain('overflow-wrap:anywhere')
    expect(css).not.toContain('%235C6660')
  })

  it('keeps semantic status colours while making neutral booking controls graphite', () => {
    const css = pageCss()
    expect(css).toContain('--pu-status-success:#0E7C4C')
    expect(css).toContain('--pu-green-fill:#333')
    expect(css).toContain('--pu-green-fill-hover:#111')
    expect(css).toContain('body .pu-meta .pu-dot{background:currentColor}')
    expect(css).toContain('.pu-badge-success{background:var(--pu-status-success-bg);color:var(--pu-status-success)}')
    expect(css).toContain('.pu-badge-dot{background:var(--pu-status-success-bg);color:var(--pu-status-success)}')
    expect(css).toContain('.pu-event-header h1,.pu-event-header>p{overflow-wrap:anywhere;word-break:break-word}')
    expect(css).toContain('body .pu-booking-detail h1,\nbody .pu-booking-detail p{overflow-wrap:anywhere;word-break:break-word}')
    expect(css).toContain('.pu-host>div{min-width:0}')
    expect(css).toContain('.pu-hosts-text{min-width:0')
    expect(css).toContain('overflow-wrap:anywhere;word-break:break-word')
    expect(css).toContain('@media(hover:hover) and (pointer:fine)')
  })
})
