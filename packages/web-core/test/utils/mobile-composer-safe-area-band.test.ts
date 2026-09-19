import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Owner-reported on an installed iOS PWA: a ~34px empty white band sat below the
// mobile chat composer. Cause: the composer stacked the whole
// env(safe-area-inset-bottom) as *content* padding on a box whose background is
// --surface-primary (#ffffff in light theme) over a --bg-primary (#f4f6f8) page,
// so the reserved inset rendered as a flat slab of the bar's own colour.
//
// The bar must still span to the physical screen edge (otherwise the page shows
// through beneath it) and still clear the home indicator, so the inset itself is
// correct — only its *paint* was wrong. The fix paints the inset band in the page
// colour via a background gradient.
//
// jsdom implements neither env() nor gradient painting, so this file deliberately
// does NOT try to assert rendered geometry — that was verified in a real browser
// against a harness replicating the full index.css chain. What is asserted here is
// the one invariant that silently reintroduces the defect if a later edit "tidies"
// it: the band must be painted in a DIFFERENT token than the bar's own surface.

function readComposerRule(): string {
  const css = fs.readFileSync(path.join(import.meta.dirname, '../../src/index.css'), 'utf8')
  const start = css.indexOf('.dashboard-input-area {')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

describe('mobile chat composer safe-area band', () => {
  it('reserves the bottom inset so the composer clears the home indicator', () => {
    // Dropping this reintroduces a composer that sits under the iOS home indicator.
    expect(readComposerRule()).toContain('env(safe-area-inset-bottom, 0px)')
  })

  it('paints the reserved inset in the page colour, not the composer surface', () => {
    const rule = readComposerRule()

    // ChatInputBar gives this element `bg-[var(--surface-primary)]`. The inset band
    // must be overpainted with the page background, or the band reads as unused
    // empty space again (the owner-reported symptom).
    expect(rule).toContain('var(--bg-primary)')
    expect(rule).not.toContain('var(--surface-primary)')
  })

  it('carries the band on the background rather than a border', () => {
    // ChatInputBar collapses this bar with `max-height: 0` when the composer is
    // inactive. max-height does not shrink borders, so a border-based band would
    // leave a stuck ~34px strip while hidden; a background is clipped with the box.
    const rule = readComposerRule()
    expect(rule).toContain('background-image')
    expect(rule).not.toMatch(/border-bottom:\s*env\(safe-area-inset-bottom/)
  })
})
