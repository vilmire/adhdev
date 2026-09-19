import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Owner-reported on an installed iOS PWA (2026-09-19): the safe-area band below
// the mobile chat composer read as a visible colour seam — the bar was
// --surface-primary above the seam and a prior revision's --bg-primary overpaint
// below it, right where the composer and tabbar should look like one continuous
// bottom bar. The owner asked for the band to match the composer's own colour
// instead, which is also the standard iOS PWA convention (the bar's surface
// extends into the safe area) and matches DashboardMobileBottomNav's tabbar,
// which never had a repaint layer.
//
// The bar must still span to the physical screen edge (otherwise the page shows
// through beneath it) and still clear the home indicator, so the inset itself is
// unchanged — only the paint changed: there is no separate repaint layer, so
// ChatInputBar's own `bg-[var(--surface-primary)]` fills the inset band too.
//
// jsdom implements neither env() nor gradient painting, so this file deliberately
// does NOT try to assert rendered geometry — that was verified in a real browser
// against a harness replicating the full index.css chain. What is asserted here is
// the one invariant that silently reintroduces the colour-seam defect if a later
// edit "tidies" it: the rule must NOT paint the band in a token different from the
// bar's own surface (no background-image repaint layer at all).

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

  it('leaves the inset band unpainted so the composer surface shows through', () => {
    const rule = readComposerRule()

    // ChatInputBar gives this element `bg-[var(--surface-primary)]`. The rule here
    // must not add its own background/background-image layer — doing so would
    // recreate a colour seam between the bar and its own safe-area band (the
    // owner-reported symptom), whether the repaint token matches the page or not.
    expect(rule).not.toContain('background')
  })

  it('does not reserve the band via a border', () => {
    // ChatInputBar collapses this bar with `max-height: 0` when the composer is
    // inactive. A border-based band would not shrink with max-height and would
    // leave a stuck strip while hidden.
    const rule = readComposerRule()
    expect(rule).not.toMatch(/border-bottom:\s*env\(safe-area-inset-bottom/)
  })
})
