import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Owner-reported on an installed iOS PWA: a white band along the bottom edge of
// the screen, present on the chat view AND on the Chats list (which has no
// composer at all), and absent while the software keyboard is up.
//
// Cause: iOS standalone with `apple-mobile-web-app-status-bar-style:
// black-translucent` + `viewport-fit=cover` gives the document a layout viewport
// that is SHORTER than the screen by env(safe-area-inset-top). The window covers
// the screen, but the document does not, so every `height: 100%` in the shell
// chain (html / body / #root / .app-layout) resolves short and the last
// ~inset-top pixels of the screen fall outside the document. Nothing paints
// there and the browser's default white shows through.
//
// The three observed properties are what identify the cause, and are what
// distinguish it from the composer's own inset-bottom band (a separate concern
// covered by mobile-composer-safe-area-band.test.ts):
//   - it appears on screens with no composer;
//   - it measures inset-TOP (~47-59px), not the 34px home-indicator inset;
//   - the keyboard fills that screen region, hiding it.
//
// jsdom implements neither env() nor iOS's viewport inset, so this file does not
// assert rendered geometry. That was verified in a real browser against a
// harness replicating the full index.css chain, which reproduced a 59px white
// band and showed it closing to 0px under this fix. What is asserted here is the
// structural invariant that a later "tidy-up" would silently break.

function readStandalonePwaSlice(): string {
  const css = fs.readFileSync(path.join(import.meta.dirname, '../../src/index.css'), 'utf8')
  const start = css.indexOf('@media (display-mode: standalone)')
  const end = css.indexOf('@media (hover: none)')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

function readRootRule(): string {
  const slice = readStandalonePwaSlice()
  const start = slice.indexOf('html {')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = slice.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return slice.slice(start, end)
}

describe('standalone PWA app-shell viewport gap', () => {
  it('grows the document by the top inset so it spans the physical screen', () => {
    // Without this the document is short by exactly inset-top and the uncovered
    // strip renders as browser-default white along the bottom edge.
    expect(readRootRule()).toContain('min-height: calc(100% + env(safe-area-inset-top, 0px));')
  })

  it('reserves the same inset as padding so content clears the status bar', () => {
    // Growing the box alone would slide the whole UI up under the status bar.
    expect(readRootRule()).toContain('padding-top: env(safe-area-inset-top, 0px);')
  })

  it('uses border-box so the padding does not add a second inset of height', () => {
    // With content-box the element would be (100% + inset) TALL PLUS the padding,
    // overshooting the screen by a second inset and reintroducing a gap-like
    // offset in the other direction.
    expect(readRootRule()).toContain('box-sizing: border-box;')
  })

  it('reserves the top inset exactly once across the in-flow shell', () => {
    // .main-content and .landing previously each carried `padding-top: inset-top`.
    // The root now reserves it for the whole in-flow tree; repeating it on a
    // descendant indents that surface by two status bars.
    const slice = readStandalonePwaSlice()
    for (const selector of ['.main-content {', '.landing {']) {
      expect(slice).not.toContain(selector)
    }
  })

  it('scopes the growth to standalone so browser tabs are untouched', () => {
    // In a normal Safari tab the layout viewport is already correct. Growing it
    // there would make the page scroll by the inset. The rule must live inside
    // the standalone media query and nowhere else.
    const css = fs.readFileSync(path.join(import.meta.dirname, '../../src/index.css'), 'utf8')
    const occurrences = css.split('min-height: calc(100% + env(safe-area-inset-top, 0px));').length - 1
    expect(occurrences).toBe(1)
    expect(readStandalonePwaSlice()).toContain('min-height: calc(100% + env(safe-area-inset-top, 0px));')
  })

  it('leaves the base height:100% shell chain intact', () => {
    // The fix is additive: it overrides the root's used height via min-height and
    // must not require rewriting the shared shell sizing, which desktop and
    // tablet layouts depend on.
    const css = fs.readFileSync(path.join(import.meta.dirname, '../../src/index.css'), 'utf8')
    expect(css).toContain('html,\n    body,\n    #root {\n        height: 100%;')
    expect(css).toContain('.app-layout {\n        display: flex;\n        height: 100%;')
  })
})
