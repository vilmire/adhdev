import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('CLI terminal measured layout plumbing', () => {
  it('passes sizingMode through the lazy CliTerminal wrapper', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/CliTerminal.tsx'), 'utf8')
    expect(source.includes("sizingMode = 'measured'" ) || source.includes("sizingMode='measured'" )).toBe(true)
    expect(source.includes('sizingMode={sizingMode}')).toBe(true)
  })

  it('reuses the shared ChatInputBar in CliTerminalPane so terminal/chat input height stays aligned', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes("import ChatInputBar from './ChatInputBar'" ) || source.includes("import ChatInputBar from \"./ChatInputBar\"" )).toBe(true)
    expect(source.includes('<ChatInputBar')).toBe(true)
    expect(source.includes('isActive={isInputActive && isVisible}')).toBe(true)
  })

  it('switches narrow mobile panes to fit sizing and centers measured scaling from the top', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('shouldPreferFitCliTerminal')).toBe(true)
    expect(source.includes("effectiveTerminalSizingMode === 'fit'" )).toBe(true)
    expect(source.includes("transformOrigin: 'top left'" )).toBe(true)
    expect(source.includes("flex justify-center" )).toBe(true)
  })

  it('routes terminal-mode sends through the same handleSendChat path as chat mode', () => {
    const terminalSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    const chatSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/ChatPane.tsx'), 'utf8')
    expect(chatSource.includes('onSend={handleSendChat}')).toBe(true)
    expect(terminalSource.includes('return handleSendChat(message);')).toBe(true)
    expect(terminalSource.includes('if (!runtimeReady || sendBlockMessage) return false;')).toBe(true)
  })

  it('avoids a second outer vertical scrollbar in CliTerminalPane', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('overflow-auto rounded-lg')).toBe(false)
    expect(source.includes('overflow-x-auto overflow-y-hidden rounded-lg')).toBe(true)
  })

  it('tunes xterm scrolling instead of relying on outer container scrolling', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes('scrollSensitivity:')).toBe(true)
    expect(source.includes('fastScrollSensitivity:')).toBe(true)
    expect(source.includes('smoothScrollDuration:')).toBe(true)
    expect(source.includes('scrollOnUserInput:')).toBe(true)
  })

  it('adds terminal chrome polish for cursor, padding, and scrollbar styling', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes('cursorWidth:')).toBe(true)
    expect(source.includes('padding:')).toBe(true)
    expect(source.includes('scrollbar-width: thin')).toBe(true)
    expect(source.includes('::-webkit-scrollbar-thumb')).toBe(true)
  })
})
