import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Third round on this band. Round 1 (pwa-app-shell-viewport-gap.test.ts) grew
// the document to span the physical screen, so the band stopped rendering as
// browser-default white. Round 2 made the inset a FLOOR (`max(base, inset)`)
// because stacking a 6-10px design pad on top of the inset read as too tall
// (40-44px notched vs 6-10px flat). Round 3 (this one): the owner compared the
// `max()` result against the OTHER edge — the standalone top total is
// inset-top (59px) + the header's own top padding (10px, `.dashboard-header`
// mobile rule) = 69px — and reported the bottom, pinned at the bare 34px
// inset under `max()`, now read as too tight by comparison.
//
// Measured in a harness that models the iOS geometry (screen 844, layout viewport
// 844 - inset-top, inset-top 59, inset-bottom 34), because desktop Chrome cannot
// produce real safe-area insets and guessing at them is what made the first
// investigation blame the wrong element:
//
//   screen        formula                        reserved below the last UI row
//   ------------  -----------------------------  ------------------------------
//   Chats list    calc(10px + inset)  (round 1)  44px
//   Chats list    max(10px, inset)    (round 2)  34px
//   Chats list    calc(20px + inset)  (round 3)  54px
//   Chat          calc(6px + inset)   (round 1)  40px
//   Chat          max(6px, inset)     (round 2)  34px
//   Chat          calc(16px + inset)  (round 3)  50px
//   flat device   round 1 base -> round 3 base   10/6px -> 20/16px
//
// There was NO duplicate reservation to remove: in standalone the Chats column
// reserves the inset exactly once (on the nav) and the chat column exactly once
// (on the composer). Round 3 is back to the additive `calc()` form, with the
// design pad enlarged and sized against the 69px top reference instead of the
// original 6-10px. Flat form factors — desktop, Android without a gesture bar,
// non-notched iPads, browser tabs — take the new, larger pad directly (there is
// no inset to add), which is a deliberate, accepted change from round 1's
// 10px/6px: the owner traded flat-device padding growth for notched/flat
// top-bottom balance.
//
// jsdom implements neither env() nor min/max resolution, so this file asserts the
// FORMULA rather than rendered geometry — specifically that the design pad is
// ADDED to the inset (round 3's property), which is what silently reintroduces
// the round-2 "too tight" defect if a later edit "restores" the `max()` form.

const WEB_CORE = path.join(import.meta.dirname, '../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(WEB_CORE, rel), 'utf8')
}

function composerRule(): string {
  const css = read('src/index.css')
  const start = css.indexOf('.dashboard-input-area {')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

function bottomNavClassName(): string {
  const tsx = read('src/components/dashboard/DashboardMobileBottomNav.tsx')
  // The single root <div> of the component carries the bar's own padding.
  const m = tsx.match(/<div className="([^"]*border-t[^"]*shrink-0)"/)
  expect(m, 'bottom-nav root div className not found').not.toBeNull()
  return m![1]
}

/**
 * Every in-flow surface that is the LAST element above the bottom screen edge on
 * a mobile PWA screen, and therefore owns the home-indicator clearance.
 */
const BOTTOM_SURFACES: Array<{ name: string; base: string; read: () => string }> = [
  { name: 'mobile bottom nav (Chats list / Machines)', base: '20px', read: bottomNavClassName },
  { name: 'mobile chat composer', base: '16px', read: composerRule },
]

describe('PWA bottom inset is additive, sized against the top reference', () => {
  it.each(BOTTOM_SURFACES)('$name reserves base + inset rather than max(base, inset)', ({ base, read: readSurface }) => {
    const surface = readSurface()

    // The property that matters: the notched reservation grows past the bare
    // inset by the full design pad, instead of being capped at the inset.
    expect(surface).toMatch(
      new RegExp(`calc\\(\\s*${base}\\s*\\+\\s*env\\(safe-area-inset-bottom`),
    )

    // And the floor form is gone. This is the assertion that fails if someone
    // rewrites calc() back to max(), which looks equally valid and is not —
    // it silently reintroduces the round-2 "too tight against the top" defect.
    expect(surface).not.toMatch(
      new RegExp(`max\\(\\s*${base}\\s*,\\s*env\\(safe-area-inset-bottom`),
    )
  })

  it.each(BOTTOM_SURFACES)('$name still reserves the full inset so the home indicator stays clear', ({ read: readSurface }) => {
    // The design pad is ADDED on top of the inset, never substituted for it —
    // shrinking the reservation below the inset would slide the tap targets
    // under the iOS home indicator, a separate and worse defect than tightness.
    const surface = readSurface()
    expect(surface).toContain('env(safe-area-inset-bottom')
    expect(surface).not.toMatch(/env\(safe-area-inset-bottom[^)]*\)\s*(\/|\*)\s*\d/)
  })

  it('gives a zero-inset form factor exactly the new design pad, and nothing extra', () => {
    // calc(base + 0px) === base, so desktop, Android without a gesture bar,
    // iPads without a notch and every browser tab get exactly the enlarged pad
    // — not the inset, and not the old round-1 base. This is the one place the
    // owner accepted flat-device padding growth as the cost of top/bottom
    // balance on notched devices; a regression here would either erase that
    // balance (falling back to the old 10px/6px) or silently double-count the
    // inset on flat devices (a positive env() fallback).
    for (const { base, read: readSurface } of BOTTOM_SURFACES) {
      const m = readSurface().match(/calc\(\s*(\d+px)\s*\+\s*env\(safe-area-inset-bottom,\s*(0px)\s*\)\s*\)/)
      expect(m, 'expected calc(<base> + env(safe-area-inset-bottom, 0px))').not.toBeNull()
      expect(m![1]).toBe(base)
      // The env() fallback must be 0px: on user agents without safe-area
      // support the rule must collapse to exactly the base padding.
      expect(m![2]).toBe('0px')
    }
  })

  it('does not reserve the bottom inset twice in one standalone column', () => {
    // The Chats column is <inbox root> > [scroller, bottom nav]. The scroller also
    // carries an inset-bottom padding, but only on the non-standalone branch — in
    // the installed PWA it must fall back to a plain padding, or the column pays
    // for the home indicator twice and the surplus returns by another route.
    const inbox = read('src/components/dashboard/DashboardMobileChatInbox.tsx')
    const m = inbox.match(/isStandalone\s*\?\s*'([^']*)'\s*:\s*'([^']*safe-area-inset-bottom[^']*)'/)
    expect(m, 'expected the scroller padding to branch on isStandalone').not.toBeNull()
    expect(m![1]).not.toContain('safe-area-inset-bottom')
  })

  it('keeps the app-shell viewport fix that closed the white band', () => {
    // The round-1 fix is what makes the document span the physical screen at
    // all; without it the band is white again regardless of its height.
    // Rebalancing the height must not have undone it.
    const css = read('src/index.css')
    expect(css).toContain('min-height: calc(100% + env(safe-area-inset-top, 0px));')
    expect(css).toContain('padding-top: env(safe-area-inset-top, 0px);')
  })

  it('leaves the composer band unpainted so it matches the bar surface (round 4)', () => {
    // Round 4 (2026-09-19, owner-reported): the --bg-primary overpaint from
    // round 3 created a visible colour seam between the composer and its own
    // safe-area band. The gradient repaint layer is gone; ChatInputBar's own
    // `bg-[var(--surface-primary)]` now fills the inset band too, matching
    // DashboardMobileBottomNav's tabbar, which never had a repaint layer.
    // Enlarging the design pad in this round must not reintroduce that layer.
    const rule = composerRule()
    expect(rule).not.toContain('background')
  })
})
