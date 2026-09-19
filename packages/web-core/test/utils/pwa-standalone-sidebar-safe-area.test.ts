import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readIndexCss(): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src/index.css'), 'utf8')
}

function readStandalonePwaSlice(): string {
  const css = readIndexCss()
  const start = css.indexOf('@media (display-mode: standalone)')
  const end = css.indexOf('@media (hover: none)')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

describe('standalone PWA sidebar safe-area handling', () => {
  it('keeps safe-area top padding off the document body', () => {
    const standaloneCss = readStandalonePwaSlice()

    expect(standaloneCss).not.toContain('body {\n            -webkit-user-select: none;\n            user-select: none;\n            padding-top: env(safe-area-inset-top, 0px);')
    expect(standaloneCss).toContain('padding-top: env(safe-area-inset-top, 0px);')
  })

  it('keeps the fixed sidebar carrying its own top inset', () => {
    // The sidebar is position:fixed, so it anchors to the viewport rather than to
    // the root's padding box — the root-level inset reservation does not move it
    // and it still needs its own offset. Verified in a real browser: a fixed
    // child of a padded root reports top=0, an in-flow child reports top=inset.
    expect(readStandalonePwaSlice()).toContain('.sidebar {\n            padding-top: calc(24px + env(safe-area-inset-top, 0px));')
  })
})
