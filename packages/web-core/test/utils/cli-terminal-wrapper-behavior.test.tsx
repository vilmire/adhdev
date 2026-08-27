// @vitest-environment jsdom
//
// Behavioral suite for `CliTerminal` — the lazy wrapper that code-splits the
// xterm renderer out of the main bundle.
//
// This replaces the wrapper assertions in the old
// `test/utils/cli-terminal-measured-layout.test.ts`, which read
// `src/components/CliTerminal.tsx` as text and asserted things like
// `expect(source.includes('flushPending();')).toBe(true)` and
// `expect(source.includes('const frame = requestAnimationFrame(() =>')).toBe(false)`.
// The second form is the clearest illustration of why that shape was worthless:
// it passes for every possible rename of that variable, so it could never fail
// for the reason it was written.
//
// The wrapper's whole job is a queue: the renderer module arrives asynchronously,
// and every imperative call made before it lands must be replayed afterwards, in
// order, instead of being dropped on a null ref. That is directly observable, so
// it is tested directly — by resolving the lazy import against a stub renderer
// and watching what reaches it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forwardRef, useImperativeHandle } from 'react'

// ── stub renderer ─────────────────────────────────────────────────────────────
// Stands in for @adhdev/terminal-render-web. `resolveRenderer` controls exactly
// when the lazy import settles, which is the window the queue exists to cover.

interface RendererCall { method: string; args: unknown[] }

const calls: RendererCall[] = []
let lastProps: Record<string, unknown> = {}

const StubRenderer = forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    lastProps = props
    useImperativeHandle(ref, () => ({
        write: (data: string, onProcessed?: () => void) => {
            calls.push({ method: 'write', args: [data] })
            onProcessed?.()
        },
        clear: () => calls.push({ method: 'clear', args: [] }),
        reset: () => calls.push({ method: 'reset', args: [] }),
        resize: (cols: number, rows: number) => calls.push({ method: 'resize', args: [cols, rows] }),
        fit: () => calls.push({ method: 'fit', args: [] }),
        bumpResize: () => calls.push({ method: 'bumpResize', args: [] }),
        scrollToTop: () => calls.push({ method: 'scrollToTop', args: [] }),
        getSelection: () => 'stub-selection',
        getVisibleText: () => 'stub-visible',
    }), [])
    return <div data-stub-renderer="1" />
})
StubRenderer.displayName = 'StubRenderer'

// `vi.mock` factories are hoisted above module-scope initialization, so the gate
// they read has to be created in a `vi.hoisted` block. The factory returns a
// promise that only settles when the test calls `resolveRenderer()` — that
// pending window is exactly the interval the wrapper's queue exists to cover.
//
// The mocked module is cached after its first resolution, so each test calls
// `vi.resetModules()` and re-imports `CliTerminal`, which re-runs the factory and
// yields a fresh unresolved load window.
const gate = vi.hoisted(() => {
    const state: {
        resolve: (mod: { GhosttyTerminalView: unknown }) => void
        promise: Promise<{ GhosttyTerminalView: unknown }>
        arm: () => void
    } = {
        resolve: () => {},
        promise: null as never,
        arm: () => {
            state.promise = new Promise(resolve => { state.resolve = resolve })
        },
    }
    state.arm()
    return state
})

vi.mock('@adhdev/terminal-render-web', () => gate.promise)

type CliTerminalHandle = import('../../src/components/CliTerminal').CliTerminalHandle
type CliTerminalComponent = typeof import('../../src/components/CliTerminal').CliTerminal

let CliTerminal: CliTerminalComponent
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
    calls.length = 0
    lastProps = {}
    // Fresh module registry → the mock factory re-runs → a fresh pending import.
    gate.arm()
    vi.resetModules()
    ;({ CliTerminal } = await import('../../src/components/CliTerminal'))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

function renderWrapper(props: Record<string, unknown> = {}) {
    const ref = { current: null } as React.RefObject<CliTerminalHandle | null>
    act(() => {
        root.render(<CliTerminal ref={ref} onInput={() => {}} {...props} />)
    })
    return ref
}

/** Settles the lazy import and lets the resulting effects run. */
async function loadRenderer() {
    gate.resolve({ GhosttyTerminalView: StubRenderer })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('CliTerminal lazy loading', () => {
    it('renders a placeholder, not the renderer, before the module resolves', () => {
        renderWrapper()
        expect(container.querySelector('[data-stub-renderer]')).toBeNull()
        expect(container.firstElementChild).not.toBeNull()
    })

    it('mounts the renderer once the module resolves', async () => {
        renderWrapper()
        await loadRenderer()
        expect(container.querySelector('[data-stub-renderer]')).not.toBeNull()
    })
})

describe('CliTerminal pending-work queue', () => {
    it('replays writes issued before the renderer loaded, in order', async () => {
        // This is the actual regression the wrapper exists for: session output
        // starts streaming immediately, well before the lazily-imported renderer
        // module has arrived. Dropping it leaves a permanently blank terminal.
        const ref = renderWrapper()
        act(() => {
            ref.current?.write('first')
            ref.current?.write('second')
            ref.current?.write('third')
        })
        expect(calls).toHaveLength(0)

        await loadRenderer()

        expect(calls.filter(c => c.method === 'write').map(c => c.args[0]))
            .toEqual(['first', 'second', 'third'])
    })

    it('invokes each queued write\'s onProcessed callback when it is finally flushed', async () => {
        // The pane chains its chunked replay on onProcessed; if the queued form
        // dropped the callback the replay would stall forever at the first chunk.
        const ref = renderWrapper()
        const onProcessed = vi.fn()
        act(() => { ref.current?.write('chunk', onProcessed) })
        expect(onProcessed).not.toHaveBeenCalled()

        await loadRenderer()

        expect(onProcessed).toHaveBeenCalledTimes(1)
    })

    it('passes writes straight through once the renderer is loaded', async () => {
        const ref = renderWrapper()
        await loadRenderer()
        act(() => { ref.current?.write('live') })
        expect(calls.filter(c => c.method === 'write').map(c => c.args[0])).toEqual(['live'])
    })

    it('drops queued writes when clear() is called before the renderer loads', async () => {
        const ref = renderWrapper()
        act(() => {
            ref.current?.write('stale')
            ref.current?.clear()
        })
        await loadRenderer()
        expect(calls.filter(c => c.method === 'write')).toHaveLength(0)
        expect(calls.some(c => c.method === 'clear')).toBe(true)
    })

    it('keeps writes issued after a pending clear', async () => {
        const ref = renderWrapper()
        act(() => {
            ref.current?.write('stale')
            ref.current?.clear()
            ref.current?.write('fresh')
        })
        await loadRenderer()
        expect(calls.filter(c => c.method === 'write').map(c => c.args[0])).toEqual(['fresh'])
    })

    it('replays a pending scrollToTop once the renderer loads', async () => {
        // Older-scrollback replay anchors the viewport at the top; if the request
        // is made during the load window it must not be lost, or the user is left
        // at the bottom of a buffer they explicitly asked to see the start of.
        const ref = renderWrapper()
        act(() => { ref.current?.scrollToTop() })
        expect(calls).toHaveLength(0)

        await loadRenderer()

        expect(calls.some(c => c.method === 'scrollToTop')).toBe(true)
    })

    it('replays a pending bumpResize once the renderer loads', async () => {
        const ref = renderWrapper()
        act(() => { ref.current?.bumpResize() })
        await loadRenderer()
        expect(calls.some(c => c.method === 'bumpResize')).toBe(true)
    })

    it('replays a pending fit once the renderer loads', async () => {
        const ref = renderWrapper()
        act(() => { ref.current?.fit() })
        await loadRenderer()
        expect(calls.some(c => c.method === 'fit')).toBe(true)
    })

    it('flushes queued work exactly once, not on every later re-render', async () => {
        const ref = renderWrapper()
        act(() => { ref.current?.write('once') })
        await loadRenderer()

        act(() => { root.render(<CliTerminal ref={ref} onInput={() => {}} fontSize={20} />) })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

        expect(calls.filter(c => c.method === 'write')).toHaveLength(1)
    })
})

describe('CliTerminal handle delegation', () => {
    it('forwards resize to the renderer', async () => {
        const ref = renderWrapper()
        await loadRenderer()
        act(() => { ref.current?.resize(100, 30) })
        expect(calls.find(c => c.method === 'resize')?.args).toEqual([100, 30])
    })

    it('returns the renderer selection and visible text through the wrapper', async () => {
        const ref = renderWrapper()
        await loadRenderer()
        expect(ref.current?.getSelection()).toBe('stub-selection')
        expect(ref.current?.getVisibleText()).toBe('stub-visible')
    })

    it('returns empty strings for selection/visible text before the renderer loads', () => {
        // Copy is reachable in the UI before the renderer arrives; it must return
        // a string rather than throwing on a null ref.
        const ref = renderWrapper()
        expect(ref.current?.getSelection()).toBe('')
        expect(ref.current?.getVisibleText()).toBe('')
    })
})

describe('CliTerminal prop plumbing', () => {
    it('defaults to measured sizing so the dashboard never silently gets xterm fit()', async () => {
        renderWrapper()
        await loadRenderer()
        expect(lastProps.sizingMode).toBe('measured')
    })

    it('passes an explicit sizingMode through to the renderer', async () => {
        renderWrapper({ sizingMode: 'fit' })
        await loadRenderer()
        expect(lastProps.sizingMode).toBe('fit')
    })

    it('forwards the measurement callbacks the dashboard autoscale depends on', async () => {
        const onViewportMetrics = vi.fn()
        const onScrollMetrics = vi.fn()
        renderWrapper({ onViewportMetrics, onScrollMetrics })
        await loadRenderer()
        expect(lastProps.onViewportMetrics).toBe(onViewportMetrics)
        expect(lastProps.onScrollMetrics).toBe(onScrollMetrics)
    })

    it('forwards readOnly and fontSize', async () => {
        renderWrapper({ readOnly: true, fontSize: 17 })
        await loadRenderer()
        expect(lastProps.readOnly).toBe(true)
        expect(lastProps.fontSize).toBe(17)
    })
})
