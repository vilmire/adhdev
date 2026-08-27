// @vitest-environment jsdom
//
// Behavioral suite for `CliTerminalPane` — the dashboard's CLI terminal view.
//
// This replaces the pane assertions in the old
// `test/utils/cli-terminal-measured-layout.test.ts`, which read
// `CliTerminalPane.tsx` as text and matched ~120 source substrings, including
// whole formatted statements like
// `expect(source.includes('seedTerminal(pendingSnapshot.text, pendingSnapshot.seq, pendingSnapshot.cols, pendingSnapshot.rows, { force: !!pendingSnapshot.force });')).toBe(true)`.
// Reformatting that call across two lines — a no-op for users — turned the suite
// red, while deleting the visibility-restore path entirely and leaving the string
// in a comment would have kept it green.
//
// Everything those assertions were reaching for is observable: the pane consumes
// runtime events from an injected `connectionManager`, writes into an injected
// terminal handle, and renders buttons that send bytes through an injected
// transport. All three are seams the production code already has, so the suite
// drives them instead of reading the file.
import { act, forwardRef, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TransportProvider } from '../../src/context/TransportContext'
import { setupCompat, type WebConnectionRuntimeEvent } from '../../src/compat'
import type { ActiveConversation } from '../../src/components/dashboard/types'

// ── terminal spy ──────────────────────────────────────────────────────────────
// The pane forwards the ref it is handed straight down to `CliTerminal`, which
// overwrites `.current` with its own imperative handle — so a spy passed in as
// the ref would be clobbered on mount. Instead the renderer module underneath
// `CliTerminal` is mocked, and the spy records what reaches it. That keeps the
// real pane → CliTerminal → renderer wiring under test rather than stubbing the
// component the pane actually talks to.

interface TerminalSpy {
    writes: string[]
    resets: number
    scrollToTops: number
    bumpResizes: number
    resizes: Array<[number, number]>
    selection: string
    visibleText: string
    /** Set to withhold onProcessed so a chunked replay can be stepped manually. */
    deferProcessed: boolean
    pendingProcessed: Array<() => void>
}

const spy = vi.hoisted((): TerminalSpy => ({
    writes: [],
    resets: 0,
    scrollToTops: 0,
    bumpResizes: 0,
    resizes: [],
    selection: '',
    visibleText: '',
    deferProcessed: false,
    pendingProcessed: [],
}))

function resetSpy() {
    spy.writes = []
    spy.resets = 0
    spy.scrollToTops = 0
    spy.bumpResizes = 0
    spy.resizes = []
    spy.selection = ''
    spy.visibleText = ''
    spy.deferProcessed = false
    spy.pendingProcessed = []
}

vi.mock('@adhdev/terminal-render-web', () => {
    const StubRenderer = forwardRef<unknown, Record<string, unknown>>((_props, ref) => {
        useImperativeHandle(ref, () => ({
            write: (data: string, onProcessed?: () => void) => {
                spy.writes.push(data)
                if (!onProcessed) return
                if (spy.deferProcessed) spy.pendingProcessed.push(onProcessed)
                else onProcessed()
            },
            clear: () => {},
            reset: () => { spy.resets += 1 },
            resize: (cols: number, rows: number) => { spy.resizes.push([cols, rows]) },
            fit: () => {},
            bumpResize: () => { spy.bumpResizes += 1 },
            scrollToTop: () => { spy.scrollToTops += 1 },
            getSelection: () => spy.selection,
            getVisibleText: () => spy.visibleText,
        }), [])
        return <div data-stub-terminal="1" />
    })
    StubRenderer.displayName = 'StubRenderer'
    return { GhosttyTerminalView: StubRenderer }
})

const { default: CliTerminalPane } = await import('../../src/components/dashboard/CliTerminalPane')
type CliTerminalHandle = import('../../src/components/CliTerminal').CliTerminalHandle

// ── connection manager stand-in ───────────────────────────────────────────────

interface ConnectionHarness {
    emit: (event: WebConnectionRuntimeEvent) => void
    snapshotCalls: Array<{ daemonId: string; sessionId: string; options?: { sinceSeq?: number; force?: boolean } }>
    snapshotResult: { success: true } | { success: false; error: string }
    state: string
}

function installConnectionManager(): ConnectionHarness {
    let listener: ((event: WebConnectionRuntimeEvent) => void) | null = null
    const harness: ConnectionHarness = {
        emit: (event) => listener?.(event),
        snapshotCalls: [],
        snapshotResult: { success: true },
        state: 'connected',
    }
    setupCompat({
        connectionManager: {
            get: () => undefined,
            getState: () => harness.state,
            retryConnection: () => {},
            sendPtyInput: () => true,
            onScreenshot: () => () => {},
            onStateChange: () => () => {},
            onRuntimeEvent: (_sessionId, callback) => {
                listener = callback as (event: WebConnectionRuntimeEvent) => void
                return () => { listener = null }
            },
            requestRuntimeSnapshot: async (daemonId, sessionId, options) => {
                harness.snapshotCalls.push({ daemonId, sessionId, options })
                return harness.snapshotResult
            },
        },
    })
    return harness
}

const conversation: ActiveConversation = {
    tabKey: 'tab-1',
    sessionId: 'session-1',
    daemonId: 'daemon-1',
    routeId: 'daemon-1:session-1',
    transport: 'pty',
} as ActiveConversation

let container: HTMLDivElement
let root: Root
let harness: ConnectionHarness
let terminal: TerminalSpy
let terminalRef: React.RefObject<CliTerminalHandle | null>
let sendPtyInput: ReturnType<typeof vi.fn>

beforeEach(() => {
    harness = installConnectionManager()
    resetSpy()
    terminal = spy
    // A real ref — `CliTerminal` populates `.current` with its own handle, and
    // the calls it receives land on the mocked renderer (i.e. on `spy`).
    terminalRef = { current: null }
    sendPtyInput = vi.fn(() => true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
})

function renderPane(props: Partial<React.ComponentProps<typeof CliTerminalPane>> = {}) {
    act(() => {
        root.render(
            <TransportProvider value={{ sendCommand: async () => ({}), sendPtyInput: sendPtyInput as never }}>
                <CliTerminalPane
                    activeConv={conversation}
                    terminalRef={terminalRef}
                    handleSendChat={props.handleSendChat || (async () => true)}
                    {...props}
                />
            </TransportProvider>
        )
    })
}

/** Lets queued rAF/microtask work run (fake-timer aware). */
async function flush(times = 3) {
    for (let i = 0; i < times; i += 1) {
        if (vi.isFakeTimers()) {
            await act(async () => { await vi.advanceTimersByTimeAsync(20) })
        } else {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
        }
    }
}

function buttonByText(text: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button'))
        .find(btn => btn.textContent?.trim() === text)
    if (!found) throw new Error(`button not found: ${text} (have: ${Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim()).join(', ')})`)
    return found as HTMLButtonElement
}

async function openKeysPopover() {
    act(() => { buttonByText('Keys').click() })
    await flush(1)
}

describe('CliTerminalPane — runtime snapshot seeding', () => {
    it('writes a runtime snapshot into the terminal', async () => {
        renderPane()
        await flush(1)
        act(() => {
            harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 5, text: 'hello world' } as WebConnectionRuntimeEvent)
        })
        await flush(2)
        expect(terminal.writes.join('')).toContain('hello world')
    })

    it('resizes the terminal to the snapshot geometry before replaying it', async () => {
        renderPane()
        await flush(1)
        act(() => {
            harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 1, text: 'x', cols: 120, rows: 40 } as WebConnectionRuntimeEvent)
        })
        await flush(2)
        expect(terminal.resizes).toContainEqual([120, 40])
    })

    it('ignores a snapshot older than what has already been seeded', async () => {
        // Snapshots race with live output; replaying a stale one would rewind the
        // terminal to an older screen.
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 10, text: 'newer' } as WebConnectionRuntimeEvent) })
        await flush(2)
        terminal.writes = []

        act(() => { harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 4, text: 'older' } as WebConnectionRuntimeEvent) })
        await flush(2)

        expect(terminal.writes.join('')).not.toContain('older')
    })

    it('replays a forced snapshot even when it is older than the seeded sequence', async () => {
        // "Load older output" deliberately re-requests from seq 0; the force flag
        // is what stops the staleness guard from discarding it.
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 10, text: 'newer' } as WebConnectionRuntimeEvent) })
        await flush(2)
        terminal.writes = []

        act(() => { harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 0, text: 'full scrollback', force: true } as WebConnectionRuntimeEvent) })
        await flush(2)

        expect(terminal.writes.join('')).toContain('full scrollback')
    })

    it('ignores events addressed to a different session', async () => {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'runtime_snapshot', sessionId: 'other-session', seq: 1, text: 'leak' } as WebConnectionRuntimeEvent) })
        await flush(2)
        expect(terminal.writes.join('')).not.toContain('leak')
    })

    it('clears the not-ready banner once a snapshot arrives', async () => {
        renderPane()
        await flush(1)
        // Before any snapshot lands the pane is not ready and says so — either
        // "unavailable" (nothing requested yet) or "Loading..." (request in flight).
        expect(container.textContent).toMatch(/Runtime terminal unavailable|Loading runtime terminal/)

        act(() => { harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 1, text: 'ready' } as WebConnectionRuntimeEvent) })
        await flush(2)

        expect(container.textContent).not.toMatch(/Runtime terminal unavailable|Loading runtime terminal/)
    })

    it('surfaces the snapshot error text when the runtime cannot be reached', async () => {
        harness.snapshotResult = { success: false, error: 'session gone' }
        renderPane()
        await flush(3)
        expect(container.textContent).toContain('session gone')
    })

    it('does not mark the terminal ready merely because the daemon is connected', async () => {
        // Regression: readiness used to be set from the connection state, so a
        // connected-but-silent session showed an interactive terminal that
        // swallowed every keystroke.
        harness.snapshotResult = { success: false, error: 'no runtime' }
        renderPane()
        await flush(3)
        expect(container.textContent).toContain('Runtime terminal unavailable')
    })
})

describe('CliTerminalPane — live output', () => {
    it('writes live session output into the terminal', async () => {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'tick' } as WebConnectionRuntimeEvent) })
        await flush(2)
        expect(terminal.writes.join('')).toContain('tick')
    })

    it('becomes ready on live output even if no snapshot ever arrives', async () => {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'live' } as WebConnectionRuntimeEvent) })
        await flush(2)
        expect(container.textContent).not.toContain('Runtime terminal unavailable')
    })

    it('splits a large replay into frame-sized chunks instead of one giant write', async () => {
        // A single multi-megabyte write blocks the main thread long enough to
        // freeze the tab; the pane caps each write at 32KB and continues on the
        // next frame.
        renderPane()
        await flush(1)
        const huge = 'a'.repeat(32 * 1024 * 3 + 500)

        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: huge } as WebConnectionRuntimeEvent) })
        await flush(6)

        expect(terminal.writes.length).toBeGreaterThan(1)
        for (const chunk of terminal.writes) {
            expect(chunk.length).toBeLessThanOrEqual(32 * 1024)
        }
        expect(terminal.writes.join('')).toBe(huge)
    })

    it('continues the chunked replay only as each chunk reports processed', async () => {
        // The continuation is chained on the write callback (back-pressure); if it
        // were chained on a bare timer the queue would outrun the renderer.
        renderPane()
        await flush(1)
        terminal.deferProcessed = true
        const huge = 'b'.repeat(32 * 1024 * 2 + 10)

        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: huge } as WebConnectionRuntimeEvent) })
        await flush(3)

        expect(terminal.writes).toHaveLength(1)

        act(() => { terminal.pendingProcessed.shift()?.() })
        await flush(3)

        expect(terminal.writes).toHaveLength(2)
    })

    it('resets the terminal and clears queued output on session_cleared', async () => {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'old' } as WebConnectionRuntimeEvent) })
        await flush(2)
        const resetsBefore = terminal.resets

        act(() => { harness.emit({ type: 'session_cleared', sessionId: 'session-1' } as WebConnectionRuntimeEvent) })
        await flush(2)

        expect(terminal.resets).toBeGreaterThan(resetsBefore)
    })

    it('reports an IO error in the banner and drops out of ready', async () => {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'x' } as WebConnectionRuntimeEvent) })
        await flush(2)

        act(() => {
            harness.emit({ type: 'session_io_error', sessionId: 'session-1', reason: 'pipe closed' } as WebConnectionRuntimeEvent)
        })
        await flush(2)

        expect(container.textContent).toContain('pipe closed')
    })
})

describe('CliTerminalPane — hidden tab buffering', () => {
    it('does not write live output while the pane is hidden', async () => {
        // Writing into a hidden xterm measures against a zero-size box and
        // corrupts the layout when the tab comes back.
        renderPane({ isVisible: false })
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'hidden' } as WebConnectionRuntimeEvent) })
        await flush(3)
        expect(terminal.writes.join('')).not.toContain('hidden')
    })

    it('flushes output buffered while hidden once the pane becomes visible', async () => {
        renderPane({ isVisible: false })
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'buffered' } as WebConnectionRuntimeEvent) })
        await flush(2)

        renderPane({ isVisible: true })
        await flush(3)

        expect(terminal.writes.join('')).toContain('buffered')
    })

    it('replays a snapshot that arrived while hidden when the pane is shown', async () => {
        renderPane({ isVisible: false })
        await flush(1)
        act(() => {
            harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 3, text: 'hidden snapshot' } as WebConnectionRuntimeEvent)
        })
        await flush(2)
        expect(terminal.writes.join('')).not.toContain('hidden snapshot')

        renderPane({ isVisible: true })
        await flush(3)

        expect(terminal.writes.join('')).toContain('hidden snapshot')
    })

    it('still requests a fresh snapshot after replaying the buffered one', async () => {
        // The buffered snapshot is by definition stale; without a follow-up
        // request the terminal sits frozen at the moment the tab was hidden.
        renderPane({ isVisible: false })
        await flush(1)
        act(() => {
            harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 3, text: 'stale' } as WebConnectionRuntimeEvent)
        })
        await flush(2)
        harness.snapshotCalls.length = 0

        renderPane({ isVisible: true })
        await flush(3)

        expect(harness.snapshotCalls.length).toBeGreaterThan(0)
    })

    it('applies a clear that arrived while hidden', async () => {
        renderPane({ isVisible: false })
        await flush(1)
        const resetsBefore = terminal.resets
        act(() => { harness.emit({ type: 'session_cleared', sessionId: 'session-1' } as WebConnectionRuntimeEvent) })
        await flush(2)

        renderPane({ isVisible: true })
        await flush(3)

        expect(terminal.resets).toBeGreaterThan(resetsBefore)
    })
})

describe('CliTerminalPane — older scrollback loader', () => {
    async function makeLoaderVisible() {
        renderPane()
        await flush(1)
        // seq > 0 tells the pane older output may exist upstream.
        act(() => {
            harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 7, text: 'tail' } as WebConnectionRuntimeEvent)
        })
        await flush(2)
    }

    it('offers the loader once a sequenced snapshot shows older output may exist', async () => {
        await makeLoaderVisible()
        expect(container.textContent).toContain('Load older terminal output')
    })

    it('does not offer the loader before any sequenced snapshot arrives', async () => {
        renderPane()
        await flush(1)
        expect(container.textContent).not.toContain('Load older terminal output')
    })

    it('requests the full scrollback from the start, forcing past the staleness guard', async () => {
        await makeLoaderVisible()
        harness.snapshotCalls.length = 0

        act(() => { buttonByText('Load older terminal output').click() })
        await flush(3)

        const call = harness.snapshotCalls.at(-1)
        expect(call?.options?.sinceSeq).toBe(0)
        expect(call?.options?.force).toBe(true)
    })

    it('anchors the viewport at the top after the forced replay finishes', async () => {
        await makeLoaderVisible()
        terminal.scrollToTops = 0

        act(() => { buttonByText('Load older terminal output').click() })
        await flush(2)
        act(() => {
            harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 0, text: 'the whole history', force: true } as WebConnectionRuntimeEvent)
        })
        await flush(4)

        expect(terminal.scrollToTops).toBeGreaterThan(0)
    })

    it('reports the failure instead of silently doing nothing', async () => {
        await makeLoaderVisible()
        harness.snapshotResult = { success: false, error: 'scrollback expired' }

        act(() => { buttonByText('Load older terminal output').click() })
        await flush(3)

        expect(container.textContent).toContain('scrollback expired')
    })

    it('confirms the load and stops offering it again once older output is in', async () => {
        // The button stays mounted briefly while the transient "loaded" status is
        // showing; what must not happen is it remaining *clickable* afterwards,
        // re-replaying the whole scrollback on every press.
        vi.useFakeTimers()
        await makeLoaderVisible()
        act(() => { buttonByText('Load older terminal output').click() })
        await flush(4)
        expect(container.textContent).toContain('Older terminal output loaded')

        // Let the transient status expire (2.2s).
        await act(async () => { vi.advanceTimersByTime(3000) })
        expect(container.textContent).not.toContain('Load older terminal output')
    })

    it('re-offers the loader after the pane is hidden and shown again', async () => {
        // New output accumulates while the tab is away, so the "already loaded"
        // latch has to reset or the button never returns for the rest of the session.
        vi.useFakeTimers()
        await makeLoaderVisible()
        act(() => { buttonByText('Load older terminal output').click() })
        await flush(4)
        await act(async () => { vi.advanceTimersByTime(3000) })
        expect(container.textContent).not.toContain('Load older terminal output')

        renderPane({ isVisible: false })
        await flush(2)
        renderPane({ isVisible: true })
        await flush(2)
        act(() => {
            harness.emit({ type: 'runtime_snapshot', sessionId: 'session-1', seq: 12, text: 'more', force: true } as WebConnectionRuntimeEvent)
        })
        await flush(3)

        expect(container.textContent).toContain('Load older terminal output')
    })
})

describe('CliTerminalPane — terminal control keys popover', () => {
    async function readyPane() {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'ready' } as WebConnectionRuntimeEvent) })
        await flush(2)
    }

    it('is disabled until the runtime is ready', async () => {
        renderPane()
        await flush(1)
        expect(buttonByText('Keys').disabled).toBe(true)
    })

    it('opens and exposes the hard-to-type keys phone keyboards cannot send', async () => {
        await readyPane()
        await openKeysPopover()
        const popover = container.querySelector('#terminal-control-keys-popover')
        expect(popover).not.toBeNull()
        const labels = Array.from(popover!.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || b.textContent?.trim())
        expect(labels).toEqual(expect.arrayContaining(['Esc', 'Tab', 'Enter', 'Arrow up', 'Arrow down', 'Arrow left', 'Arrow right', 'Ctrl-C', 'Space', 'Bksp']))
    })

    it.each([
        ['Esc', ''],
        ['Tab', '\t'],
        ['Enter', '\r'],
        ['Space', ' '],
        ['Bksp', ''],
    ])('sends the exact byte sequence for %s', async (label, expected) => {
        await readyPane()
        await openKeysPopover()
        act(() => { buttonByText(label).click() })
        expect(sendPtyInput).toHaveBeenCalledWith('daemon-1', 'session-1', expected)
    })

    it.each([
        ['Arrow up', '[A'],
        ['Arrow down', '[B'],
        ['Arrow left', '[D'],
        ['Arrow right', '[C'],
    ])('sends the CSI sequence for %s', async (ariaLabel, expected) => {
        await readyPane()
        await openKeysPopover()
        const btn = container.querySelector(`button[aria-label="${ariaLabel}"]`) as HTMLButtonElement
        act(() => { btn.click() })
        expect(sendPtyInput).toHaveBeenCalledWith('daemon-1', 'session-1', expected)
    })

    it('sends the raw SIGINT byte for Ctrl-C', async () => {
        // Ctrl-C stays hard-wired rather than going through the modifier encoder,
        // because it is the one combination users hit reflexively.
        await readyPane()
        await openKeysPopover()
        act(() => { buttonByText('Ctrl-C').click() })
        expect(sendPtyInput).toHaveBeenCalledWith('daemon-1', 'session-1', '')
    })

    it('applies a sticky Ctrl modifier to the next key', async () => {
        await readyPane()
        await openKeysPopover()
        act(() => { buttonByText('Ctrl').click() })
        act(() => { buttonByText('Space').click() })
        // Ctrl+Space is NUL.
        expect(sendPtyInput).toHaveBeenLastCalledWith('daemon-1', 'session-1', ' ')
    })

    it('applies a sticky Alt modifier as an ESC prefix', async () => {
        await readyPane()
        await openKeysPopover()
        act(() => { buttonByText('Alt').click() })
        act(() => { buttonByText('Space').click() })
        expect(sendPtyInput).toHaveBeenLastCalledWith('daemon-1', 'session-1', ' ')
    })

    it('encodes Shift+Tab as CBT rather than a plain tab', async () => {
        await readyPane()
        await openKeysPopover()
        act(() => { buttonByText('Shift').click() })
        act(() => { buttonByText('Tab').click() })
        expect(sendPtyInput).toHaveBeenLastCalledWith('daemon-1', 'session-1', '[Z')
    })

    it('encodes a modified arrow with the xterm modifier parameter', async () => {
        await readyPane()
        await openKeysPopover()
        act(() => { buttonByText('Ctrl').click() })
        const btn = container.querySelector('button[aria-label="Arrow right"]') as HTMLButtonElement
        act(() => { btn.click() })
        // 1 + ctrl(4) = 5
        expect(sendPtyInput).toHaveBeenLastCalledWith('daemon-1', 'session-1', '[1;5C')
    })

    it('clears sticky modifiers after one key, so they do not leak into the next', async () => {
        await readyPane()
        await openKeysPopover()
        act(() => { buttonByText('Ctrl').click() })
        act(() => { buttonByText('Space').click() })
        act(() => { buttonByText('Space').click() })
        expect(sendPtyInput).toHaveBeenLastCalledWith('daemon-1', 'session-1', ' ')
    })

    it('reflects sticky modifier state with aria-pressed', async () => {
        await readyPane()
        await openKeysPopover()
        expect(buttonByText('Ctrl').getAttribute('aria-pressed')).toBe('false')
        act(() => { buttonByText('Ctrl').click() })
        expect(buttonByText('Ctrl').getAttribute('aria-pressed')).toBe('true')
    })
})

describe('CliTerminalPane — copy', () => {
    async function readyPane() {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'ready' } as WebConnectionRuntimeEvent) })
        await flush(2)
    }

    function stubClipboard() {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
        Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
        return writeText
    }

    it('copies the selection when there is one', async () => {
        const writeText = stubClipboard()
        await readyPane()
        terminal.selection = 'selected chunk'
        terminal.visibleText = 'whole screen'

        act(() => { buttonByText('Copy').click() })
        await flush(2)

        expect(writeText).toHaveBeenCalledWith('selected chunk')
        expect(container.textContent).toContain('Copied selection')
    })

    it('falls back to the visible viewport when nothing is selected', async () => {
        const writeText = stubClipboard()
        await readyPane()
        terminal.selection = ''
        terminal.visibleText = 'whole screen'

        act(() => { buttonByText('Copy').click() })
        await flush(2)

        expect(writeText).toHaveBeenCalledWith('whole screen')
        expect(container.textContent).toContain('Copied visible terminal')
    })

    it('reports when there is nothing to copy', async () => {
        stubClipboard()
        await readyPane()
        terminal.selection = ''
        terminal.visibleText = '   '

        act(() => { buttonByText('Copy').click() })
        await flush(2)

        expect(container.textContent).toContain('Nothing to copy')
    })

    it('is disabled until the runtime is ready', async () => {
        renderPane()
        await flush(1)
        expect(buttonByText('Copy').disabled).toBe(true)
    })
})

describe('CliTerminalPane — zoom', () => {
    async function readyPane() {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'ready' } as WebConnectionRuntimeEvent) })
        await flush(2)
    }

    // NOTE: the zoom factor itself is applied as the CSS `zoom` property, which
    // jsdom's CSSOM drops (it is non-standard), so it cannot be read back from
    // the inline style here. Zoom is therefore asserted through the observable
    // consequence the pane derives from it: whether the pan surface becomes
    // scrollable. That is also the property users actually feel — a zoomed-in
    // terminal you cannot pan is the bug worth catching.
    function panSurface(): HTMLElement {
        return container.querySelector('.overscroll-contain') as HTMLElement
    }

    it('keeps the pan surface unscrollable while the terminal is at fitted scale', async () => {
        await readyPane()
        expect(panSurface().className).toContain('overflow-hidden')
        expect(panSurface().className).not.toContain('overflow-auto')
    })

    it('makes the pan surface scrollable once zoomed beyond the fitted scale', async () => {
        await readyPane()
        act(() => { buttonByText('+').click() })
        await flush(1)
        expect(panSurface().className).toContain('overflow-auto')
    })

    it('returns to an unscrollable surface when zoomed back down to the fitted scale', async () => {
        await readyPane()
        act(() => { buttonByText('+').click() })
        await flush(1)
        expect(panSurface().className).toContain('overflow-auto')

        act(() => { buttonByText('-').click() })
        await flush(1)
        expect(panSurface().className).toContain('overflow-hidden')
    })

    it('does not zoom out below the fitted scale, so zooming out cannot leave dead space', async () => {
        // Clamping at the fitted scale (rather than a fixed MIN) is what stops
        // the terminal from shrinking into a corner of its own pane.
        await readyPane()
        for (let i = 0; i < 20; i += 1) {
            act(() => { buttonByText('-').click() })
        }
        await flush(1)
        expect(panSurface().className).toContain('overflow-hidden')
    })

    it('stops growing at the shared maximum scale instead of zooming without bound', async () => {
        await readyPane()
        for (let i = 0; i < 40; i += 1) {
            act(() => { buttonByText('+').click() })
        }
        await flush(1)
        // Still just a scrollable pan surface — no crash, no runaway growth.
        expect(panSurface().className).toContain('overflow-auto')
        // And zooming out the same number of steps lands back at fitted scale,
        // which only holds if the maximum actually clamped the accumulated value.
        for (let i = 0; i < 40; i += 1) {
            act(() => { buttonByText('-').click() })
        }
        await flush(1)
        expect(panSurface().className).toContain('overflow-hidden')
    })
})

describe('CliTerminalPane — input routing', () => {
    it('routes terminal-mode sends through the same handler as chat mode', async () => {
        // Terminal mode used to have its own send path, so features added to the
        // chat path (queueing, attachments, busy handling) silently skipped it.
        const handleSendChat = vi.fn(async () => true)
        renderPane({ handleSendChat })
        await flush(1)

        const textarea = container.querySelector('textarea') as HTMLTextAreaElement
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
            setter.call(textarea, 'hello agent')
            textarea.dispatchEvent(new Event('input', { bubbles: true }))
        })
        act(() => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        })
        await flush(2)

        expect(handleSendChat).toHaveBeenCalledWith('hello agent')
    })

    it('sends typed terminal input over the PTY transport', async () => {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'ready' } as WebConnectionRuntimeEvent) })
        await flush(2)

        // The pane wires onInput straight to sendPtyInput; the Keys popover uses
        // the same path, so exercising it proves the wiring.
        await openKeysPopover()
        act(() => { buttonByText('Tab').click() })

        expect(sendPtyInput).toHaveBeenCalledWith('daemon-1', 'session-1', '\t')
    })
})

describe('CliTerminalPane — session switching', () => {
    it('resets the terminal when the session changes', async () => {
        renderPane()
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'first session' } as WebConnectionRuntimeEvent) })
        await flush(2)
        const resetsBefore = terminal.resets

        act(() => {
            root.render(
                <TransportProvider value={{ sendCommand: async () => ({}), sendPtyInput: sendPtyInput as never }}>
                    <CliTerminalPane
                        activeConv={{ ...conversation, sessionId: 'session-2', routeId: 'daemon-1:session-2' } as ActiveConversation}
                        terminalRef={terminalRef}
                        handleSendChat={async () => true}
                    />
                </TransportProvider>
            )
        })
        await flush(2)

        expect(terminal.resets).toBeGreaterThan(resetsBefore)
        // And the new session starts from a not-ready state rather than
        // inheriting the previous session's ready terminal.
        expect(container.textContent).toMatch(/Runtime terminal unavailable|Loading runtime terminal/)
    })

    it('resets the view when the parent bumps clearToken', async () => {
        renderPane({ clearToken: 0 })
        await flush(1)
        act(() => { harness.emit({ type: 'session_output', sessionId: 'session-1', seq: 1, data: 'x' } as WebConnectionRuntimeEvent) })
        await flush(2)
        const resetsBefore = terminal.resets

        renderPane({ clearToken: 1 })
        await flush(2)

        expect(terminal.resets).toBeGreaterThan(resetsBefore)
    })
})
