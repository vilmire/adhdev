// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import RemoteView from '../../src/components/RemoteView'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    vi.useFakeTimers()
    // jsdom does not implement matchMedia; RemoteView uses it once, on mount,
    // to pick the initial input mode (desktop vs mobile).
    window.matchMedia = window.matchMedia || ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
})

function render(props: Partial<Parameters<typeof RemoteView>[0]> = {}) {
    act(() => root.render(
        <RemoteView
            onAction={vi.fn(async () => ({ success: true }))}
            addLog={vi.fn()}
            connState="connected"
            connScreenshot={null}
            {...props}
        />,
    ))
}

/**
 * ★ G7-1 THE PERMANENT-"RECONNECTING" REGRESSION.
 *
 * `failed`/`disconnected` used to render "Reconnecting to Host..." forever —
 * no error, no reason, no retry, no way for the user to tell the remote
 * session is actually dead. These tests pin the two ways that must now
 * surface as an explicit error instead.
 *
 * ── Red/green injection ────────────────────────────────────────────────────
 * Revert RemoteView's `isErrorState` branch (or drop the escalation timer)
 * and the corresponding case below goes red — the DOM falls back to
 * "Reconnecting to Host..." text with no `remote-error-state` node.
 */
describe('RemoteView — G7-1 failed/disconnected surfaces as an explicit error', () => {
    it('renders an error state immediately on connState="failed", not "Reconnecting..."', () => {
        render({ connState: 'failed' })
        const error = container.querySelector('[data-testid="remote-error-state"]')
        expect(error).not.toBeNull()
        expect(container.textContent).not.toContain('Reconnecting to Host')
    })

    it('does NOT show an error immediately on "disconnected" — waits for the 15s escalation', () => {
        render({ connState: 'disconnected' })
        expect(container.querySelector('[data-testid="remote-error-state"]')).toBeNull()
        expect(container.textContent).toContain('Reconnecting to Host')
    })

    it('escalates "disconnected" to an explicit error after 15s stuck reconnecting', () => {
        render({ connState: 'disconnected' })
        expect(container.querySelector('[data-testid="remote-error-state"]')).toBeNull()

        act(() => { vi.advanceTimersByTime(15000) })

        const error = container.querySelector('[data-testid="remote-error-state"]')
        expect(error).not.toBeNull()
        expect(container.textContent).not.toContain('Reconnecting to Host')
    })

    it('recovering to "connected" before 15s cancels the escalation (no stale error)', () => {
        const { rerender } = (() => {
            render({ connState: 'disconnected' })
            return {
                rerender: (props: Partial<Parameters<typeof RemoteView>[0]>) => render(props),
            }
        })()
        act(() => { vi.advanceTimersByTime(5000) })
        rerender({ connState: 'connected', connScreenshot: 'data:image/png;base64,x' })
        act(() => { vi.advanceTimersByTime(15000) })
        expect(container.querySelector('[data-testid="remote-error-state"]')).toBeNull()
    })

    it('renders a retry action when onRetry is provided, and calls it on click', () => {
        const onRetry = vi.fn()
        render({ connState: 'failed', onRetry })
        const button = container.querySelector('[data-testid="remote-error-state"] button')
        expect(button).not.toBeNull()
        act(() => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('renders no retry button when onRetry is omitted', () => {
        render({ connState: 'failed' })
        expect(container.querySelector('[data-testid="remote-error-state"] button')).toBeNull()
    })
})

describe('RemoteView — G7-1 addLog wiring and click-ripple-after-resolve', () => {
    it('calls addLog when a remote click fails', async () => {
        const addLog = vi.fn()
        const onAction = vi.fn(async () => ({ success: false, error: 'boom' }))
        render({
            connState: 'connected',
            connScreenshot: 'data:image/png;base64,x',
            onAction,
            addLog,
        })

        const img = container.querySelector('img[alt="Remote View"]') as HTMLImageElement
        expect(img).not.toBeNull()
        vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
            left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() { return {} },
        })

        await act(async () => {
            img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }))
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(addLog).toHaveBeenCalledWith(expect.stringContaining('Click failed'))
    })
})

/**
 * G7-3: mount auto-focus must not let Escape (or any key) reach the remote
 * host before the user explicitly takes control by interacting with the
 * remote surface. This does NOT introduce a persistent view-only mode —
 * it only gates the pre-interaction window right after mount.
 */
describe('RemoteView — G7-3 mount focus does not swallow Escape before take-control', () => {
    it('does not forward Escape to onAction when control has not been taken', () => {
        const onAction = vi.fn(async () => ({ success: true }))
        render({ connState: 'connected', connScreenshot: 'data:image/png;base64,x', onAction })

        const surface = container.querySelector('[tabindex="0"]') as HTMLDivElement
        expect(surface).not.toBeNull()
        act(() => {
            surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        expect(onAction).not.toHaveBeenCalled()
    })
})
