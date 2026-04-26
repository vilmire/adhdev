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

  it('keeps mobile chat header metadata on one non-truncated scroll row', () => {
    const css = readSource('index.css')
    const roomSource = readSource('components/dashboard/DashboardMobileChatRoom.tsx')

    expect(roomSource).toContain('className="min-w-0 flex-1 flex flex-col gap-0.5"')
    expect(roomSource).toContain('className="min-w-0 max-w-full text-xs text-text-secondary"')
    expect(css).toContain('.conversation-meta-chips.is-mobile-header {')
    expect(css).toContain('overflow-x: auto;')
    expect(css).toContain('-webkit-overflow-scrolling: touch;')
    expect(css).toContain('.conversation-meta-chips.is-mobile-header::-webkit-scrollbar')
    expect(css).toContain('.conversation-meta-chips.is-mobile-header .conversation-meta-chip span {')
    expect(css).toContain('overflow: visible;')
    expect(css).toContain('text-overflow: clip;')
  })

  it('keeps mobile inbox reconnect empty-state copy compact', () => {
    const source = readSource('components/dashboard/DashboardMobileChatInbox.tsx')

    expect(source).toContain("'Reconnecting'")
    expect(source).toContain("'Restoring the server connection…'")
    expect(source).not.toContain('Connecting to server')
    expect(source).not.toContain('Establishing connection to the server')
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
