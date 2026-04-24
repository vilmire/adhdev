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
  it('keeps safe-area top padding off the document body and on app surfaces instead', () => {
    const standaloneCss = readStandalonePwaSlice()

    expect(standaloneCss).not.toContain('body {\n            -webkit-user-select: none;\n            user-select: none;\n            padding-top: env(safe-area-inset-top, 0px);')
    expect(standaloneCss).toContain('.main-content {')
    expect(standaloneCss).toContain('padding-top: env(safe-area-inset-top, 0px);')
  })
})
