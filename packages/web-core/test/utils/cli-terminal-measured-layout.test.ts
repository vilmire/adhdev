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

  it('keeps dashboard terminal panes in measured sizing without fit fallbacks and keeps zoom in the pane wrapper instead of xterm font-size feedback', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('shouldPreferFitCliTerminal')).toBe(false)
    expect(source.includes("effectiveTerminalSizingMode === 'fit'")).toBe(false)
    expect(source.includes('zoom: terminalScale')).toBe(true)
    expect(source.includes('transform: `scale(${terminalScale})`')).toBe(false)
    expect(source.includes('fontSize={terminalFontSize}')).toBe(false)
    expect(source.includes('const terminalFontSize = Number((13 * terminalScale).toFixed(2));')).toBe(false)
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

  it('uses measured renderer viewport overflow only when manually zoomed in, sizes the pan surface from scaled intrinsic dimensions, and never shrinks below the fitted scale', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('const fittedTerminalScale = getAutoTerminalScale();')).toBe(true)
    expect(source.includes('const isManualZoomedIn = terminalScaleTouchedRef.current && terminalScale > fittedTerminalScale;')).toBe(true)
    expect(source.includes("isManualZoomedIn ? 'w-full h-full overflow-auto rounded-lg overscroll-contain' : 'w-full h-full overflow-hidden rounded-lg overscroll-contain'")).toBe(true)
    expect(source.includes('const scaledTerminalWidth = Number.isFinite(terminalIntrinsicViewport.width) && terminalIntrinsicViewport.width > 0')).toBe(true)
    expect(source.includes('const scaledTerminalHeight = Number.isFinite(terminalIntrinsicViewport.height) && terminalIntrinsicViewport.height > 0')).toBe(true)
    expect(source.includes('scrollTop = scroller.scrollHeight - scroller.clientHeight')).toBe(true)
    expect(source.includes('const nextScale = Math.max(fittedTerminalScale, Number((scale - 0.1).toFixed(2)));')).toBe(true)
    expect(source.includes('const nextScale = Math.max(MIN_TERMINAL_SCALE, Number((scale - 0.1).toFixed(2)));')).toBe(false)
  })

  it('updates xterm font size in place so zoom changes do not rebuild the live terminal surface', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes('term.options.fontSize = fontSize')).toBe(true)
    expect(source.includes('term.refresh(0, Math.max(0, term.rows - 1));')).toBe(true)
    expect(source.includes('}, [fontSize, sizingMode]);')).toBe(false)
    expect(source.includes('}, [sizingMode]);')).toBe(true)
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

  it('marks the xterm viewport as touch-scrollable on mobile instead of requiring scrollbar dragging', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes('-webkit-overflow-scrolling: touch')).toBe(true)
    expect(source.includes('touch-action: pan-y')).toBe(true)
  })

  it('uses shared terminal size constants and boots the browser terminal at 80x32', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes("DEFAULT_SESSION_HOST_COLS")).toBe(true)
    expect(source.includes("DEFAULT_SESSION_HOST_ROWS")).toBe(true)
    expect(source.includes("const DEFAULT_TERMINAL_ROWS = 24;")).toBe(false)
    expect(source.includes("const DEFAULT_TERMINAL_COLS = 80;")).toBe(false)
    expect(source.includes('rows: DEFAULT_SESSION_HOST_ROWS')).toBe(true)
    expect(source.includes('cols: DEFAULT_SESSION_HOST_COLS')).toBe(true)
  })

  it('reports measured xterm viewport dimensions back to the dashboard so autoscale can fit the real terminal surface without feeding back through current font size', () => {
    const terminalSource = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    const paneSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')

    expect(terminalSource.includes('onViewportMetrics?: (metrics: { width: number; height: number }) => void')).toBe(true)
    expect(terminalSource.includes("containerRef.current?.querySelector('.xterm-viewport')")).toBe(true)
    expect(terminalSource.includes('onViewportMetricsRef.current?.({ width, height })')).toBe(true)

    expect(paneSource.includes('const [terminalIntrinsicViewport, setTerminalIntrinsicViewport]')).toBe(true)
    expect(paneSource.includes('const intrinsicWidth = terminalIntrinsicViewport.width')).toBe(true)
    expect(paneSource.includes('const intrinsicHeight = terminalIntrinsicViewport.height')).toBe(true)
    expect(paneSource.includes('const widthRatio = terminalViewport.width / intrinsicWidth')).toBe(true)
    expect(paneSource.includes('const heightRatio = terminalViewport.height / intrinsicHeight')).toBe(true)
    expect(paneSource.includes('const unscaledWidth = renderedWidth / safeTerminalScale')).toBe(false)
    expect(paneSource.includes('const unscaledHeight = renderedHeight / safeTerminalScale')).toBe(false)
    expect(paneSource.includes('onViewportMetrics={setTerminalIntrinsicViewport}')).toBe(true)
  })
})
