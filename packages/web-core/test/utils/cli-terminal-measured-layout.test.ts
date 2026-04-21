import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('CLI terminal measured layout plumbing', () => {
  it('passes sizingMode through the lazy CliTerminal wrapper', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/CliTerminal.tsx'), 'utf8')
    expect(source.includes("sizingMode = 'measured'") || source.includes("sizingMode='measured'")).toBe(true)
    expect(source.includes('sizingMode={sizingMode}')).toBe(true)
  })

  it('reuses the shared ChatInputBar in CliTerminalPane so terminal/chat input height stays aligned', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes("import ChatInputBar from './ChatInputBar'") || source.includes("import ChatInputBar from \"./ChatInputBar\"")).toBe(true)
    expect(source.includes('<ChatInputBar')).toBe(true)
    expect(source.includes('isActive={isInputActive && isVisible}')).toBe(true)
  })

  it('keeps dashboard terminal panes in measured sizing without fit fallbacks and top-left aligns the scaled surface', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('shouldPreferFitCliTerminal')).toBe(false)
    expect(source.includes("effectiveTerminalSizingMode === 'fit'")).toBe(false)
    expect(source.includes("transformOrigin: 'top left'")).toBe(true)
    expect(source.includes('flex justify-center')).toBe(false)
    expect(source.includes('overflow-x-auto overflow-y-hidden rounded-lg overscroll-contain flex justify-center')).toBe(false)
    expect(source.includes("'w-full h-full overflow-hidden rounded-lg'" ) || source.includes('w-full h-full overflow-hidden rounded-lg')).toBe(true)
  })

  it('always requests a fresh runtime snapshot after replaying a hidden buffered snapshot on visibility restore', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('const pendingSnapshot = pendingHiddenSnapshotRef.current;')).toBe(true)
    expect(source.includes('seedTerminal(pendingSnapshot.text, pendingSnapshot.seq, pendingSnapshot.cols, pendingSnapshot.rows);')).toBe(true)
    expect(source.includes('connectionManager.requestRuntimeSnapshot?.(daemonRouteId, sessionId).catch(() => {});')).toBe(true)
    expect(source.includes('} else if (daemonRouteId && connectionManager.getState?.(daemonRouteId) === \'connected\') {')).toBe(false)
  })

  it('routes terminal-mode sends through the same handleSendChat path as chat mode', () => {
    const terminalSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    const chatSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/ChatPane.tsx'), 'utf8')
    expect(chatSource.includes('onSend={handleSendChat}')).toBe(true)
    expect(terminalSource.includes('return handleSendChat(message);')).toBe(true)
    expect(terminalSource.includes('if (!runtimeReady || sendBlockMessage) return false;')).toBe(true)
  })

  it('avoids outer terminal pane scrolling so xterm viewport remains the only scrollbar owner', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('overflow-auto rounded-lg')).toBe(false)
    expect(source.includes('overflow-x-auto overflow-y-hidden')).toBe(false)
    expect(source.includes('overflow-hidden rounded-lg')).toBe(true)
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
