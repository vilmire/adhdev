import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Follow-up to pwa-app-shell-viewport-gap.test.ts. That fix grew the document to
// span the physical screen, so the band along the bottom edge stopped rendering
// as browser-default white — but the owner then reported the band was still too
// TALL. Right colour, wrong height.
//
// Measured in a harness that models the iOS geometry (screen 844, layout viewport
// 844 - inset-top, inset-top 59, inset-bottom 34), because desktop Chrome cannot
// produce real safe-area insets and guessing at them is what made the first
// investigation blame the wrong element:
//
//   screen        formula                       reserved below the last UI row
//   ------------  ----------------------------  ------------------------------
//   Chats list    calc(10px + inset)  (before)  44px
//   Chats list    max(10px, inset)    (after)   34px
//   Chat          calc(6px + inset)   (before)  40px
//   Chat          max(6px, inset)     (after)   34px
//   flat device   either                        10px / 6px  (identical)
//
// There was NO duplicate reservation to remove: in standalone the Chats column
// reserves the inset exactly once (on the nav) and the chat column exactly once
// (on the composer). The surplus was the design padding being ADDED to the inset.
// A 34px home-indicator inset is already more breathing room than a 6-10px design
// padding asks for, so `max` treats the inset as a FLOOR: it stays fully reserved
// (the indicator is never covered) and the design padding applies only where the
// inset does not already exceed it, leaving flat form factors bit-identical.
//
// jsdom implements neither env() nor min/max resolution, so this file asserts the
// FORMULA rather than rendered geometry — specifically the property that the inset
// is never an addend, which is what silently reintroduces the surplus if a later
// edit "restores" the more familiar calc() form.

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
  { name: 'mobile bottom nav (Chats list / Machines)', base: '10px', read: bottomNavClassName },
  { name: 'mobile chat composer', base: '6px', read: composerRule },
]

describe('PWA bottom inset is a floor, not an addend', () => {
  it.each(BOTTOM_SURFACES)('$name reserves max(base, inset) rather than base + inset', ({ base, read: readSurface }) => {
    const surface = readSurface()

    // The property that matters: the reserved space equals the inset once the
    // inset exceeds the base, instead of growing past it.
    expect(surface).toMatch(
      new RegExp(`max\\(\\s*${base}\\s*,\\s*env\\(safe-area-inset-bottom`),
    )

    // And the additive form is gone. This is the assertion that fails if someone
    // rewrites max() back to calc(), which looks equivalent and is not.
    expect(surface).not.toMatch(
      new RegExp(`calc\\(\\s*${base}\\s*\\+\\s*env\\(safe-area-inset-bottom`),
    )
  })

  it.each(BOTTOM_SURFACES)('$name still reserves the full inset so the home indicator stays clear', ({ read: readSurface }) => {
    // Shrinking the reservation below the inset would slide the tap targets under
    // the iOS home indicator — the opposite defect, and the reason the surplus was
    // trimmed by absorbing the base padding rather than by lowering the inset.
    const surface = readSurface()
    expect(surface).toContain('env(safe-area-inset-bottom')
    expect(surface).not.toMatch(/env\(safe-area-inset-bottom[^)]*\)\s*(\/|\*)\s*\d/)
  })

  it('leaves a zero-inset form factor completely unchanged', () => {
    // max(base, 0px) === base, so desktop, Android without a gesture bar, iPads
    // without a notch and every browser tab render exactly as before. A fix that
    // only reads correctly on a notched iPhone is not acceptable here.
    for (const { base, read: readSurface } of BOTTOM_SURFACES) {
      const m = readSurface().match(/max\(\s*(\d+px)\s*,\s*env\(safe-area-inset-bottom,\s*(0px)\s*\)\s*\)/)
      expect(m, 'expected max(<base>, env(safe-area-inset-bottom, 0px))').not.toBeNull()
      expect(m![1]).toBe(base)
      // The env() fallback must be 0px: it is what makes the rule collapse to the
      // base padding on user agents that do not support safe-area insets at all.
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
    // The previous fix is what makes the document span the physical screen at all;
    // without it the band is white again regardless of how tall it is. Trimming the
    // surplus must not have been done by undoing it.
    const css = read('src/index.css')
    expect(css).toContain('min-height: calc(100% + env(safe-area-inset-top, 0px));')
    expect(css).toContain('padding-top: env(safe-area-inset-top, 0px);')
  })

  it('keeps the composer band painted in the page colour', () => {
    // The composer's reserved inset is overpainted in --bg-primary so it reads as
    // page rather than as a slab of the bar's own --surface-primary. Shrinking the
    // padding must not have dropped that gradient.
    const rule = composerRule()
    expect(rule).toContain('background-image')
    expect(rule).toContain('var(--bg-primary)')
    expect(rule).not.toContain('var(--surface-primary)')
  })
})
