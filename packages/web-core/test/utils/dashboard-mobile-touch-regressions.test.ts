import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string) => fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')

describe('dashboard mobile/touch regressions', () => {
  it('does not force the document back to the top when the chat input blurs', () => {
    const source = readSource('components/dashboard/ChatInputBar.tsx')

    expect(source).not.toContain('document.documentElement.scrollTop = 0')
    expect(source).not.toContain('window.scrollTo(0, 0)')
  })

  it('makes dashboard tab drag handles non-text-selectable on touch devices', () => {
    const css = readSource('index.css')

    expect(css).toContain('.adhdev-dockview .dv-tab,')
    expect(css).toContain('.adhdev-dockview-tab {')
    expect(css).toContain('-webkit-user-select: none;')
    expect(css).toContain('user-select: none;')
    expect(css).toContain('-webkit-touch-callout: none;')
    expect(css).toContain('touch-action: manipulation;')
  })
})
