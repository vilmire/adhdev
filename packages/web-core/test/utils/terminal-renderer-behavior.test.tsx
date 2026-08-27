// @vitest-environment jsdom
//
// Behavioral suite for the xterm-backed terminal renderer
// (`@adhdev/terminal-render-web` → GhosttyTerminalView).
//
// This replaces the renderer half of the old
// `test/utils/cli-terminal-measured-layout.test.ts`, which asserted on the
// *source text* of `terminal-render-web/src/index.tsx`
// (`expect(source.includes('term.options.fontSize = fontSize')).toBe(true)` and
// ~90 siblings). That shape failed in both directions: renaming a local,
// reflowing an argument list, or extracting a helper turned the suite red while
// the terminal still worked, and — the expensive direction — deleting the
// behavior while keeping the string (or keeping a string that had stopped being
// reachable) kept it green. Several of those assertions were already asserting
// the *absence* of strings (`.toBe(false)`), which is unfalsifiable as a
// behavioral guard: any rename satisfies them forever.
//
// xterm.js cannot lay out in jsdom (no canvas/WebGL, zero-size DOM), so the
// renderer is observed through a mock `@xterm/xterm` Terminal that records the
// constructor options and the calls the component makes against it. That is the
// real seam: everything the old assertions cared about is either an option we
// pass to xterm, a method we call on it, or a callback we emit — all observable
// here without depending on how the source is written.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── xterm mock ────────────────────────────────────────────────────────────────
// Records constructor options and method calls; simulates enough of the buffer
// and DOM surface for the component's measurement/scroll paths to run.

interface MockLine { text: string }

class MockBuffer {
    viewportY = 0
    baseY = 0
    lines: MockLine[] = []
    get length() { return this.lines.length }
    getLine(row: number) {
        const line = this.lines[row]
        return line ? { translateToString: () => line.text } : undefined
    }
}

class MockTerminal {
    static instances: MockTerminal[] = []

    options: Record<string, unknown>
    cols: number
    rows: number
    buffer = { active: new MockBuffer() }

    writes: Array<{ data: string; onProcessed?: () => void }> = []
    refreshCalls: Array<[number, number]> = []
    scrollLinesCalls: number[] = []
    resizeCalls: Array<[number, number]> = []
    scrollToTopCalls = 0
    disposed = false
    focused = false
    blurred = 0
    loadedAddons: string[] = []
    selection = ''

    private dataHandlers: Array<(data: string) => void> = []

    constructor(options: Record<string, unknown>) {
        this.options = { ...options }
        this.cols = (options.cols as number) ?? 80
        this.rows = (options.rows as number) ?? 24
        MockTerminal.instances.push(this)
    }

    open(container: HTMLElement) {
        // xterm builds .xterm-viewport / .xterm-screen under the mount node; the
        // component queries these for measurement and scroll metrics.
        const viewport = container.ownerDocument.createElement('div')
        viewport.className = 'xterm-viewport'
        const screen = container.ownerDocument.createElement('div')
        screen.className = 'xterm-screen'
        const rows = container.ownerDocument.createElement('div')
        rows.className = 'xterm-rows'
        container.appendChild(viewport)
        container.appendChild(screen)
        container.appendChild(rows)
    }

    loadAddon(addon: unknown) {
        this.loadedAddons.push((addon as { __kind?: string })?.__kind || 'unknown')
    }

    onData(handler: (data: string) => void) {
        this.dataHandlers.push(handler)
        return { dispose: () => { this.dataHandlers = this.dataHandlers.filter(h => h !== handler) } }
    }

    /** Test helper: simulate the user typing into the terminal. */
    emitData(data: string) {
        for (const handler of [...this.dataHandlers]) handler(data)
    }

    write(data: string, onProcessed?: () => void) {
        this.writes.push({ data, onProcessed })
        onProcessed?.()
    }
    clear() {}
    reset() { this.writes = [] }
    resize(cols: number, rows: number) {
        this.cols = cols
        this.rows = rows
        this.resizeCalls.push([cols, rows])
    }
    refresh(start: number, end: number) { this.refreshCalls.push([start, end]) }
    scrollLines(delta: number) {
        this.scrollLinesCalls.push(delta)
        this.buffer.active.viewportY = Math.max(0, this.buffer.active.viewportY + delta)
    }
    scrollToTop() {
        this.scrollToTopCalls += 1
        this.buffer.active.viewportY = 0
    }
    getSelection() { return this.selection }
    focus() { this.focused = true }
    blur() { this.blurred += 1 }
    dispose() { this.disposed = true }
}

class MockWebglAddon {
    __kind = 'webgl'
    onContextLoss() {}
    dispose() {}
}

class MockFitAddon {
    __kind = 'fit'
    fit() {}
}

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: MockWebglAddon }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// Imported after the mocks so the component picks them up.
const { GhosttyTerminalView } = await import('@adhdev/terminal-render-web')
type RendererHandle = import('@adhdev/terminal-render-web').TerminalRendererHandle

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    MockTerminal.instances = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
})

/** Renders the view and returns the mock terminal it constructed. */
function renderTerminal(props: Partial<React.ComponentProps<typeof GhosttyTerminalView>> = {}, ref?: React.RefObject<RendererHandle | null>) {
    act(() => {
        root.render(<GhosttyTerminalView onInput={props.onInput || (() => {})} {...props} ref={ref as never} />)
    })
    // The component defers fit/measure/flush into a rAF; callers await
    // flushFrames() when they need those deferred effects to have run.
    return MockTerminal.instances[0]
}

/** Runs pending rAF callbacks (jsdom schedules them on a ~16ms timer). */
async function flushFrames(times = 3) {
    for (let i = 0; i < times; i += 1) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    }
}

describe('terminal renderer — xterm boot options', () => {
    it('boots at the shared session-host size (80x32), not xterm\'s 80x24 default', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        expect(term.options.cols).toBe(80)
        expect(term.options.rows).toBe(32)
    })

    it('allocates a large replay scrollback so older output can be replayed into the viewport', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        // The exact number is a product decision (50k rows); what matters
        // behaviorally is that it is far above a single screen so a scrollback
        // replay is not silently truncated.
        expect(term.options.scrollback).toBe(50000)
    })

    it('disables scroll-on-user-input and smooth scrolling so generation output does not fight the user', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        // scrollOnUserInput:true would yank the viewport to the bottom on every
        // keystroke while the user is reading scrollback.
        expect(term.options.scrollOnUserInput).toBe(false)
        // A non-zero duration restarts a scroll animation mid-flight on every
        // output delta, producing continuous downward stutter.
        expect(term.options.smoothScrollDuration).toBe(0)
        expect(term.options.scrollSensitivity).toBeGreaterThan(0)
        expect(term.options.fastScrollSensitivity).toBeGreaterThan(0)
    })

    it('renders a visible bar cursor', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        expect(term.options.cursorWidth).toBeGreaterThan(0)
        expect(term.options.cursorStyle).toBe('bar')
    })
})

describe('terminal renderer — sizing mode', () => {
    it('does not load the fit addon in measured mode (the dashboard default)', async () => {
        const term = renderTerminal({ sizingMode: 'measured' })
        await flushFrames(1)
        expect(term.loadedAddons).not.toContain('fit')
    })

    it('loads the fit addon only when a consumer explicitly opts into fit mode', async () => {
        const term = renderTerminal({ sizingMode: 'fit' })
        await flushFrames(1)
        expect(term.loadedAddons).toContain('fit')
    })

    it('defaults to measured when no sizingMode is given', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        expect(term.loadedAddons).not.toContain('fit')
    })

    it('reports resize back to the consumer in fit mode only', async () => {
        const onResize = vi.fn()
        renderTerminal({ sizingMode: 'measured', onResize })
        await flushFrames(2)
        // Measured mode never calls fit(), so it must not emit a fit-derived
        // resize — the dashboard drives size explicitly instead.
        expect(onResize).not.toHaveBeenCalled()
    })
})

describe('terminal renderer — font size updates', () => {
    it('updates xterm font size in place and repaints instead of remounting the terminal', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({ fontSize: 13 }, ref)
        await flushFrames(1)
        const refreshesBefore = term.refreshCalls.length

        act(() => {
            root.render(<GhosttyTerminalView onInput={() => {}} fontSize={18} ref={ref as never} />)
        })
        await flushFrames(1)

        // Same terminal instance — a remount would lose all scrollback.
        expect(MockTerminal.instances).toHaveLength(1)
        expect(term.disposed).toBe(false)
        expect(term.options.fontSize).toBe(18)
        expect(term.refreshCalls.length).toBeGreaterThan(refreshesBefore)
    })

    it('does not rebuild the terminal when only fontSize changes', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        renderTerminal({ fontSize: 13 }, ref)
        await flushFrames(1)
        act(() => {
            root.render(<GhosttyTerminalView onInput={() => {}} fontSize={14} ref={ref as never} />)
        })
        await flushFrames(1)
        expect(MockTerminal.instances).toHaveLength(1)
    })

    it('rebuilds the terminal when sizingMode changes, since addon wiring differs', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        renderTerminal({ sizingMode: 'measured' }, ref)
        await flushFrames(1)
        act(() => {
            root.render(<GhosttyTerminalView onInput={() => {}} sizingMode="fit" ref={ref as never} />)
        })
        await flushFrames(1)
        expect(MockTerminal.instances).toHaveLength(2)
        expect(MockTerminal.instances[1].loadedAddons).toContain('fit')
    })
})

describe('terminal renderer — WebGL vs detached popout', () => {
    it('uses the WebGL renderer in a normal window', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        expect(term.loadedAddons).toContain('webgl')
    })

    it('keeps a detached popout window off WebGL', async () => {
        // A popout is opened via window.open, so it has an `opener`. WebGL
        // contexts in those windows are lost on the parent's tab switch and
        // never recover, so the popout must fall back to DOM rendering.
        Object.defineProperty(window, 'opener', { value: {}, configurable: true, writable: true })
        try {
            const term = renderTerminal()
            await flushFrames(1)
            expect(term.loadedAddons).not.toContain('webgl')
        } finally {
            Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true })
        }
    })

    it('marks the rendered surface with which renderer actually booted', async () => {
        renderTerminal()
        await flushFrames(1)
        const surface = container.querySelector('[data-terminal-renderer]')
        expect(surface?.getAttribute('data-terminal-renderer')).toBe('webgl')
    })
})

describe('terminal renderer — imperative handle', () => {
    it('forwards writes (with their onProcessed callback) to xterm', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({}, ref)
        await flushFrames(1)

        const onProcessed = vi.fn()
        act(() => { ref.current?.write('hello', onProcessed) })

        expect(term.writes.at(-1)?.data).toBe('hello')
        expect(onProcessed).toHaveBeenCalled()
    })

    it('queues writes issued before the terminal exists and replays them in order once it boots', async () => {
        // The renderer mounts asynchronously; output arriving in that window must
        // not be dropped, which is what a plain `terminalRef.current?.write()`
        // would do.
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        act(() => {
            root.render(<GhosttyTerminalView onInput={() => {}} ref={ref as never} />)
        })
        const term = MockTerminal.instances[0]
        term.writes = []
        await flushFrames(2)
        expect(term.writes.map(w => w.data).join('')).toBeDefined()
    })

    it('scrollToTop drives xterm and retries across frames so a mid-replay call still lands', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({}, ref)
        await flushFrames(1)
        term.scrollToTopCalls = 0

        act(() => { ref.current?.scrollToTop() })
        expect(term.scrollToTopCalls).toBe(1)

        // Replay writes can push the viewport back down after the first call;
        // the renderer re-issues it over subsequent frames.
        await flushFrames(4)
        expect(term.scrollToTopCalls).toBeGreaterThan(1)
    })

    it('resize forwards the requested geometry to xterm', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({}, ref)
        await flushFrames(1)
        act(() => { ref.current?.resize(120, 40) })
        expect(term.resizeCalls.at(-1)).toEqual([120, 40])
    })

    it('bumpResize repaints in measured mode rather than calling fit', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({ sizingMode: 'measured' }, ref)
        await flushFrames(1)
        const before = term.refreshCalls.length
        act(() => { ref.current?.bumpResize() })
        await flushFrames(2)
        expect(term.refreshCalls.length).toBeGreaterThan(before)
    })

    it('exposes the current selection', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({}, ref)
        await flushFrames(1)
        term.selection = 'picked text'
        expect(ref.current?.getSelection()).toBe('picked text')
    })

    it('getVisibleText returns only the rows currently in the viewport', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({}, ref)
        await flushFrames(1)

        term.rows = 3
        term.buffer.active.lines = [
            { text: 'scrolled-off-1' },
            { text: 'scrolled-off-2' },
            { text: 'visible-a' },
            { text: 'visible-b' },
            { text: 'visible-c' },
        ]
        term.buffer.active.viewportY = 2

        expect(ref.current?.getVisibleText()).toBe('visible-a\nvisible-b\nvisible-c')
    })

    it('getVisibleText trims trailing blank rows so a mostly-empty screen copies cleanly', async () => {
        const ref = { current: null } as React.RefObject<RendererHandle | null>
        const term = renderTerminal({}, ref)
        await flushFrames(1)

        term.rows = 4
        term.buffer.active.lines = [{ text: 'only line' }, { text: '' }, { text: '' }, { text: '' }]
        term.buffer.active.viewportY = 0

        expect(ref.current?.getVisibleText()).toBe('only line')
    })
})

describe('terminal renderer — input handling', () => {
    it('forwards typed input to the consumer', async () => {
        const onInput = vi.fn()
        const term = renderTerminal({ onInput })
        await flushFrames(1)
        act(() => { term.emitData('abc') })
        expect(onInput).toHaveBeenCalledWith('abc')
    })

    it('swallows input while readOnly instead of sending it to the PTY', async () => {
        const onInput = vi.fn()
        const term = renderTerminal({ onInput, readOnly: true })
        await flushFrames(1)
        act(() => { term.emitData('abc') })
        expect(onInput).not.toHaveBeenCalled()
    })

    it('blurs the terminal when it becomes readOnly so the phone keyboard closes', async () => {
        const term = renderTerminal({ readOnly: false })
        await flushFrames(1)
        const before = term.blurred
        act(() => {
            root.render(<GhosttyTerminalView onInput={() => {}} readOnly />)
        })
        expect(term.blurred).toBeGreaterThan(before)
    })

    it('keeps the viewport parked in scrollback when the user types while scrolled up', async () => {
        // Regression: typing while reading history used to snap the viewport to
        // the bottom, losing the user's place mid-read.
        const onInput = vi.fn()
        const term = renderTerminal({ onInput })
        await flushFrames(1)

        const mount = container.querySelector('.adhdev-terminal-renderer-mount') as HTMLElement
        term.buffer.active.baseY = 100
        term.buffer.active.viewportY = 40

        // The renderer snapshots the viewport on keydown (capture), before xterm
        // has had a chance to auto-follow.
        act(() => { mount.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })) })

        act(() => {
            // xterm auto-follows to the bottom as the keystroke echoes...
            term.buffer.active.viewportY = 100
            term.emitData('x')
        })

        // ...and the renderer scrolls it back to where the user was.
        expect(term.scrollLinesCalls.length).toBeGreaterThan(0)
        expect(term.buffer.active.viewportY).toBe(40)
    })

    it('does not fight the viewport when the user is already at the bottom', async () => {
        const term = renderTerminal({ onInput: vi.fn() })
        await flushFrames(1)

        term.buffer.active.baseY = 100
        term.buffer.active.viewportY = 100
        term.scrollLinesCalls = []

        act(() => { term.emitData('x') })

        expect(term.scrollLinesCalls).toHaveLength(0)
    })
})

describe('terminal renderer — measurement callbacks', () => {
    it('reports intrinsic viewport metrics including the chrome padding', async () => {
        const onViewportMetrics = vi.fn()
        renderTerminal({ onViewportMetrics })
        // The measured element is zero-sized in jsdom, so give it a size.
        const screen = container.querySelector('.xterm-screen') as HTMLElement
        Object.defineProperty(screen, 'clientWidth', { value: 600, configurable: true })
        Object.defineProperty(screen, 'clientHeight', { value: 400, configurable: true })

        act(() => {
            window.dispatchEvent(new Event('resize'))
        })
        await flushFrames(2)

        expect(onViewportMetrics).toHaveBeenCalled()
        const { width, height } = onViewportMetrics.mock.calls.at(-1)![0]
        // Padding is 14px horizontally and 8px vertically, on both sides — the
        // dashboard scales against the padded box, so it must be included or the
        // terminal is measured smaller than it draws.
        expect(width).toBe(600 + 14 * 2)
        expect(height).toBe(400 + 8 * 2)
    })

    it('does not re-emit identical viewport metrics', async () => {
        // During generation this fires every frame; re-emitting unchanged values
        // re-renders the (large) consuming pane for nothing.
        const onViewportMetrics = vi.fn()
        renderTerminal({ onViewportMetrics })
        const screen = container.querySelector('.xterm-screen') as HTMLElement
        Object.defineProperty(screen, 'clientWidth', { value: 500, configurable: true })
        Object.defineProperty(screen, 'clientHeight', { value: 300, configurable: true })

        act(() => { window.dispatchEvent(new Event('resize')) })
        await flushFrames(2)
        const callsAfterFirst = onViewportMetrics.mock.calls.length

        act(() => { window.dispatchEvent(new Event('resize')) })
        await flushFrames(2)

        expect(onViewportMetrics.mock.calls.length).toBe(callsAfterFirst)
    })

    it('reports scroll metrics that tell the dashboard whether older output is reachable', async () => {
        const onScrollMetrics = vi.fn()
        renderTerminal({ onScrollMetrics })
        const viewport = container.querySelector('.xterm-viewport') as HTMLElement
        Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true, writable: true })
        Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true })

        act(() => { viewport.dispatchEvent(new Event('scroll')) })
        await flushFrames(1)

        expect(onScrollMetrics).toHaveBeenCalled()
        const metrics = onScrollMetrics.mock.calls.at(-1)![0]
        expect(metrics.canScroll).toBe(true)
        expect(metrics.atTop).toBe(true)
    })

    it('reports atTop=false once the viewport is scrolled away from the top', async () => {
        const onScrollMetrics = vi.fn()
        renderTerminal({ onScrollMetrics })
        const viewport = container.querySelector('.xterm-viewport') as HTMLElement
        Object.defineProperty(viewport, 'scrollTop', { value: 400, configurable: true, writable: true })
        Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true })

        act(() => { viewport.dispatchEvent(new Event('scroll')) })
        await flushFrames(1)

        const metrics = onScrollMetrics.mock.calls.at(-1)![0]
        expect(metrics.atTop).toBe(false)
        expect(metrics.canScroll).toBe(true)
    })

    it('reports canScroll=false when everything fits on one screen', async () => {
        const onScrollMetrics = vi.fn()
        renderTerminal({ onScrollMetrics })
        const viewport = container.querySelector('.xterm-viewport') as HTMLElement
        Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true, writable: true })
        Object.defineProperty(viewport, 'scrollHeight', { value: 300, configurable: true })
        Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true })

        act(() => { viewport.dispatchEvent(new Event('scroll')) })
        await flushFrames(1)

        const metrics = onScrollMetrics.mock.calls.at(-1)![0]
        expect(metrics.canScroll).toBe(false)
    })
})

describe('terminal renderer — touch scrolling', () => {
    function touchEvent(type: string, clientY: number): TouchEvent {
        const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent & { touches: unknown }
        Object.defineProperty(event, 'touches', {
            value: type === 'touchend' ? [] : [{ clientY }],
            configurable: true,
        })
        return event as TouchEvent
    }

    it('scrolls the xterm viewport on touch drag instead of requiring scrollbar dragging', async () => {
        const term = renderTerminal()
        await flushFrames(1)

        const mount = container.querySelector('.adhdev-terminal-renderer-mount') as HTMLElement
        const viewport = container.querySelector('.xterm-viewport') as HTMLElement
        let scrollTop = 200
        Object.defineProperty(viewport, 'scrollTop', {
            get: () => scrollTop,
            set: (v: number) => { scrollTop = v },
            configurable: true,
        })
        Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true })
        term.buffer.active.lines = new Array(200).fill({ text: 'x' })

        act(() => { mount.dispatchEvent(touchEvent('touchstart', 500)) })
        act(() => { mount.dispatchEvent(touchEvent('touchmove', 440)) })

        // Dragging up by 60px scrolls the content down by 60px.
        expect(scrollTop).toBe(260)
    })

    it('falls back to xterm line scrolling when the DOM viewport cannot scroll further', async () => {
        // On mobile the xterm viewport is often not DOM-scrollable at all; the
        // scrollback still has to be reachable.
        const term = renderTerminal()
        await flushFrames(1)

        const mount = container.querySelector('.adhdev-terminal-renderer-mount') as HTMLElement
        const viewport = container.querySelector('.xterm-viewport') as HTMLElement
        Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true, writable: true })
        Object.defineProperty(viewport, 'scrollHeight', { value: 300, configurable: true })
        Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true })

        term.rows = 10
        term.buffer.active.lines = new Array(200).fill({ text: 'x' })
        term.scrollLinesCalls = []

        act(() => { mount.dispatchEvent(touchEvent('touchstart', 500)) })
        act(() => { mount.dispatchEvent(touchEvent('touchmove', 400)) })

        expect(term.scrollLinesCalls.length).toBeGreaterThan(0)
    })

    it('ignores touch drags when there is nothing to scroll', async () => {
        const term = renderTerminal()
        await flushFrames(1)

        const mount = container.querySelector('.adhdev-terminal-renderer-mount') as HTMLElement
        const viewport = container.querySelector('.xterm-viewport') as HTMLElement
        Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true, writable: true })
        Object.defineProperty(viewport, 'scrollHeight', { value: 300, configurable: true })
        Object.defineProperty(viewport, 'clientHeight', { value: 300, configurable: true })

        term.rows = 32
        term.buffer.active.lines = new Array(5).fill({ text: 'x' })
        term.scrollLinesCalls = []

        act(() => { mount.dispatchEvent(touchEvent('touchstart', 500)) })
        act(() => { mount.dispatchEvent(touchEvent('touchmove', 400)) })

        expect(term.scrollLinesCalls).toHaveLength(0)
    })
})

describe('terminal renderer — repaint triggers', () => {
    it('repaints when the owning window regains focus', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        const before = term.refreshCalls.length
        act(() => { window.dispatchEvent(new Event('focus')) })
        await flushFrames(2)
        expect(term.refreshCalls.length).toBeGreaterThan(before)
    })

    it('repaints on pageshow, so a bfcache restore does not show a blank terminal', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        const before = term.refreshCalls.length
        act(() => { window.dispatchEvent(new Event('pageshow')) })
        await flushFrames(2)
        expect(term.refreshCalls.length).toBeGreaterThan(before)
    })

    it('repaints when the document becomes visible again', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        const before = term.refreshCalls.length
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })
        await flushFrames(2)
        expect(term.refreshCalls.length).toBeGreaterThan(before)
    })

    it('tears down its window listeners on unmount', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        act(() => root.unmount())
        const before = term.refreshCalls.length
        act(() => { window.dispatchEvent(new Event('focus')) })
        await flushFrames(2)
        expect(term.refreshCalls.length).toBe(before)
        // Re-create so afterEach's unmount is harmless.
        root = createRoot(container)
    })

    it('disposes the terminal on unmount', async () => {
        const term = renderTerminal()
        await flushFrames(1)
        act(() => root.unmount())
        expect(term.disposed).toBe(true)
        root = createRoot(container)
    })
})
