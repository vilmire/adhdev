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

  it('keeps dashboard terminal panes in measured sizing without fit fallbacks and drives zoom through renderer font-size feedback instead of pane CSS zoom', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('shouldPreferFitCliTerminal')).toBe(false)
    expect(source.includes("effectiveTerminalSizingMode === 'fit'")).toBe(false)
    expect(source.includes('zoom: terminalScale')).toBe(false)
    expect(source.includes('transform: `scale(${terminalScale})`')).toBe(false)
    expect(source.includes('fontSize={terminalFontSize}')).toBe(true)
    expect(source.includes('const terminalFontSize = Number((13 * terminalScale).toFixed(2));')).toBe(true)
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

  it('uses measured renderer overflow to decide pan/scroll ownership, centers non-overflow terminal slack intentionally, exposes horizontal pan when needed, sizes the pan surface from rendered terminal dimensions, and never shrinks below the fitted scale', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')
    expect(source.includes('const fittedTerminalScale = getAutoTerminalScale();')).toBe(true)
    expect(source.includes('const safeTerminalScale = Number.isFinite(terminalScale) && terminalScale > 0 ? terminalScale : 1;')).toBe(true)
    expect(source.includes('const isManualZoomedIn = terminalScaleTouchedRef.current && terminalScale > fittedTerminalScale;')).toBe(true)
    expect(source.includes('const hasOverflowedTerminalSurface = terminalIntrinsicViewport.width > terminalViewport.width + 1')).toBe(true)
    expect(source.includes('const shouldCenterTerminalSurface = !hasOverflowedTerminalSurface')).toBe(true)
    expect(source.includes("hasOverflowedTerminalSurface ? 'w-full h-full overflow-x-auto overflow-y-hidden rounded-lg overscroll-contain' : 'w-full h-full overflow-hidden rounded-lg overscroll-contain'")).toBe(true)
    expect(source.includes("display: shouldCenterTerminalSurface ? 'flex' : 'block'")).toBe(true)
    expect(source.includes("justifyContent: shouldCenterTerminalSurface ? 'center' : undefined")).toBe(true)
    expect(source.includes('const renderedTerminalWidth = terminalIntrinsicViewport.width > 0')).toBe(true)
    expect(source.includes('const renderedTerminalHeight = terminalIntrinsicViewport.height > 0')).toBe(true)
    expect(source.includes('const terminalSurfaceWidth = terminalIntrinsicViewport.width > 0')).toBe(true)
    expect(source.includes('const terminalSurfaceHeight = terminalIntrinsicViewport.height > 0')).toBe(true)
    expect(source.includes("minWidth: shouldCenterTerminalSurface ? `${terminalSurfaceWidth}px` : '100%'")).toBe(true)
    expect(source.includes("minHeight: shouldCenterTerminalSurface ? `${terminalSurfaceHeight}px` : '100%'")).toBe(true)
    expect(source.includes("maxWidth: shouldCenterTerminalSurface ? '100%' : 'none'")).toBe(true)
    expect(source.includes('scrollTop = scroller.scrollHeight - scroller.clientHeight')).toBe(true)
    expect(source.includes('const nextScale = Math.max(fittedTerminalScale, Number((scale - 0.1).toFixed(2)));')).toBe(true)
    expect(source.includes('const nextScale = Math.max(MIN_TERMINAL_SCALE, Number((scale - 0.1).toFixed(2)));')).toBe(false)
  })

  it('updates xterm font size in place so zoom changes do not rebuild the live terminal surface and avoids WebGL in detached popout documents', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes('term.options.fontSize = fontSize')).toBe(true)
    expect(source.includes('term.refresh(0, Math.max(0, term.rows - 1));')).toBe(true)
    expect(source.includes('}, [fontSize, sizingMode]);')).toBe(false)
    expect(source.includes('}, [sizingMode]);')).toBe(true)
    expect(source.includes('const ownerWindow = containerRef.current?.ownerDocument?.defaultView')).toBe(true)
    expect(source.includes("const isDetachedPopoutWindow = ownerWindow?.location?.pathname === '/popout.html'")).toBe(true)
    expect(source.includes("|| ownerWindow?.location?.pathname?.endsWith('/popout.html')")).toBe(true)
    expect(source.includes('|| !!ownerWindow?.opener;')).toBe(true)
    expect(source.includes('if (!isDetachedPopoutWindow) {')).toBe(true)
    expect(source.includes('const webglAddon = new WebglAddon();')).toBe(true)
  })

  it('tunes xterm scrolling instead of relying on outer container scrolling', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes('scrollSensitivity:')).toBe(true)
    expect(source.includes('fastScrollSensitivity:')).toBe(true)
    expect(source.includes('smoothScrollDuration:')).toBe(true)
    expect(source.includes('scrollOnUserInput:')).toBe(true)
  })

  it('adds terminal chrome polish for cursor, wrapper padding, and scrollbar styling without making xterm measure against the padded box', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    expect(source.includes('cursorWidth:')).toBe(true)
    expect(source.includes("className=\"adhdev-terminal-renderer-mount h-full w-full\"")).toBe(true)
    expect(source.includes('padding:')).toBe(true)
    expect(source.includes('ref={containerRef}')).toBe(true)
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

  it('reports measured xterm viewport dimensions back to the dashboard so autoscale can fit the real terminal surface without feeding back through already-scaled dimensions', () => {
    const terminalSource = fs.readFileSync(path.join(import.meta.dirname, '../../../terminal-render-web/src/index.tsx'), 'utf8')
    const paneSource = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/CliTerminalPane.tsx'), 'utf8')

    expect(terminalSource.includes('onViewportMetrics?: (metrics: { width: number; height: number }) => void')).toBe(true)
    expect(terminalSource.includes("containerRef.current?.querySelector('.xterm-screen')")).toBe(true)
    expect(terminalSource.includes("containerRef.current?.querySelector('.xterm-viewport')")).toBe(true)
    expect(terminalSource.includes('TERMINAL_CHROME_PADDING_X')).toBe(true)
    expect(terminalSource.includes('TERMINAL_CHROME_PADDING_Y')).toBe(true)
    expect(terminalSource.includes('let width = Math.max(target.clientWidth || 0, target.scrollWidth || 0)')).toBe(true)
    expect(terminalSource.includes('let height = Math.max(target.clientHeight || 0, target.scrollHeight || 0)')).toBe(true)
    expect(terminalSource.includes('width += TERMINAL_CHROME_PADDING_X * 2')).toBe(true)
    expect(terminalSource.includes('height += TERMINAL_CHROME_PADDING_Y * 2')).toBe(true)
    expect(terminalSource.includes('onViewportMetricsRef.current?.({ width, height })')).toBe(true)

    expect(paneSource.includes('const [terminalIntrinsicViewport, setTerminalIntrinsicViewport]')).toBe(true)
    expect(paneSource.includes('const renderedWidth = terminalIntrinsicViewport.width > 0 ? Math.max(terminalViewport.width, Math.round(terminalIntrinsicViewport.width)) : terminalViewport.width')).toBe(true)
    expect(paneSource.includes('const renderedHeight = terminalIntrinsicViewport.height > 0 ? Math.max(terminalViewport.height, Math.round(terminalIntrinsicViewport.height)) : terminalViewport.height')).toBe(true)
    expect(paneSource.includes('const unscaledWidth = renderedWidth / safeTerminalScale')).toBe(true)
    expect(paneSource.includes('const unscaledHeight = renderedHeight / safeTerminalScale')).toBe(true)
    expect(paneSource.includes('const widthRatio = terminalViewport.width / intrinsicWidth')).toBe(false)
    expect(paneSource.includes('const heightRatio = terminalViewport.height / intrinsicHeight')).toBe(false)
    expect(paneSource.includes('onViewportMetrics={setTerminalIntrinsicViewport}')).toBe(true)
  })
})
