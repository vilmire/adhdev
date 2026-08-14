// @vitest-environment jsdom
//
// Regression test for the reconnect button double-click / stuck-lock bug.
// Root cause: the "Reconnect now" button had no in-flight state — `disabled`
// only reflected `wsStatus === 'offline'`, so repeated clicks each cancelled
// the previous retryConnect() and restarted it, and there was no signal wired
// back into the button at all.
//
// Fix: a local `manualReconnectPending` lock set on click, cleared as soon as
// `wsStatus` leaves 'reconnecting' (dashboardWS.forceReconnect / standalone's
// equivalent flips wsStatus to 'reconnecting' synchronously), with a timeout
// safety net so a connect path that returns without emitting any status can
// never leave the button stuck disabled forever.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionBanner from '../../../src/components/dashboard/ConnectionBanner'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
})

function getReconnectButton(): HTMLButtonElement {
    const btn = container.querySelector('button')
    if (!btn) throw new Error('reconnect button not found')
    return btn as HTMLButtonElement
}

describe('ConnectionBanner manual reconnect lock', () => {
    it('disables the button immediately after click and shows the in-flight label', () => {
        const onReconnect = vi.fn()
        act(() => {
            root.render(
                <ConnectionBanner
                    wsStatus="disconnected"
                    showReconnected={false}
                    onReconnect={onReconnect}
                    reconnectDelayMs={0}
                    reconnectActionDelayMs={0}
                />
            )
        })

        const btn = getReconnectButton()
        expect(btn.disabled).toBe(false)
        expect(btn.textContent).toContain('Reconnect now')

        act(() => {
            btn.click()
        })

        expect(onReconnect).toHaveBeenCalledTimes(1)
        expect(getReconnectButton().disabled).toBe(true)
        expect(getReconnectButton().textContent).toContain('Reconnecting')

        // Re-click while pending must not fire onReconnect again (disabled).
        act(() => {
            getReconnectButton().click()
        })
        expect(onReconnect).toHaveBeenCalledTimes(1)
    })

    it('releases the lock once wsStatus resolves away from reconnecting (failure path)', () => {
        const onReconnect = vi.fn()
        act(() => {
            root.render(
                <ConnectionBanner
                    wsStatus="disconnected"
                    showReconnected={false}
                    onReconnect={onReconnect}
                    reconnectDelayMs={0}
                    reconnectActionDelayMs={0}
                />
            )
        })

        act(() => {
            getReconnectButton().click()
        })
        expect(getReconnectButton().disabled).toBe(true)

        // Simulate the click driving wsStatus to 'reconnecting' then failing.
        act(() => {
            root.render(
                <ConnectionBanner
                    wsStatus="reconnecting"
                    showReconnected={false}
                    onReconnect={onReconnect}
                    reconnectDelayMs={0}
                    reconnectActionDelayMs={0}
                />
            )
        })
        expect(getReconnectButton().disabled).toBe(true)

        act(() => {
            root.render(
                <ConnectionBanner
                    wsStatus="auth_failed"
                    showReconnected={false}
                    onReconnect={onReconnect}
                    reconnectDelayMs={0}
                    reconnectActionDelayMs={0}
                />
            )
        })

        // auth_failed hides the manual reconnect action entirely, so fall back
        // to disconnected to assert the button re-renders enabled, not stuck.
        act(() => {
            root.render(
                <ConnectionBanner
                    wsStatus="disconnected"
                    showReconnected={false}
                    onReconnect={onReconnect}
                    reconnectDelayMs={0}
                    reconnectActionDelayMs={0}
                />
            )
        })
        expect(getReconnectButton().disabled).toBe(false)
        expect(getReconnectButton().textContent).toContain('Reconnect now')
    })

    it('releases the lock via the safety timeout if wsStatus never resolves', () => {
        vi.useFakeTimers()
        const onReconnect = vi.fn()
        act(() => {
            root.render(
                <ConnectionBanner
                    wsStatus="disconnected"
                    showReconnected={false}
                    onReconnect={onReconnect}
                    reconnectDelayMs={0}
                    reconnectActionDelayMs={0}
                />
            )
        })

        act(() => {
            getReconnectButton().click()
        })
        expect(getReconnectButton().disabled).toBe(true)

        // wsStatus is held at 'reconnecting' (stuck) — only the safety timeout
        // should release the lock.
        act(() => {
            root.render(
                <ConnectionBanner
                    wsStatus="reconnecting"
                    showReconnected={false}
                    onReconnect={onReconnect}
                    reconnectDelayMs={0}
                    reconnectActionDelayMs={0}
                />
            )
        })
        expect(getReconnectButton().disabled).toBe(true)

        act(() => {
            vi.advanceTimersByTime(15000)
        })
        expect(getReconnectButton().disabled).toBe(false)
        expect(getReconnectButton().textContent).toContain('Reconnect now')
    })
})
