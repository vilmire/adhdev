// @vitest-environment jsdom
//
// Regression tests for the inline chat-header machine reconnect (owner request).
//
// Context: P2PManager parks a daemon after exhausting its auto-reconnect budget
// (`blockAutoReconnect` → `connectionRetryStatuses[id].blocked === true`). Before this
// control, recovering from that parked state meant leaving the chat for the Machines
// list or the Machine detail page.
//
// These assert the three properties that actually constrain the design, not the mere
// existence of a button:
//   1. It is absent unless the machine is parked — the header must not gain a permanent
//      fourth control, and on standalone (no P2P → no retry statuses) it must stay inert.
//   2. Clicking calls the SHARED `retryConnection(machineId)` contract — the same one the
//      Machines page uses — with the machine id, not some new path.
//   3. Repeated taps dispatch exactly one retry. A parked machine invites impatient
//      tapping and each call tears down and rebuilds the peer connection.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMachineReconnectButton from '../../../src/components/dashboard/ChatMachineReconnectButton'

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

function render(props: { machineId?: string; blocked: boolean; retryConnection?: (id: string) => void }) {
    act(() => root.render(<ChatMachineReconnectButton {...props} />))
}

function button(): HTMLButtonElement | null {
    return container.querySelector('[data-testid="chat-machine-reconnect"]')
}

describe('ChatMachineReconnectButton', () => {
    it('renders nothing while auto-reconnect is still running (not parked)', () => {
        render({ machineId: 'daemon_mach_abc', blocked: false, retryConnection: vi.fn() })
        expect(button()).toBeNull()
        expect(container.textContent).toBe('')
    })

    it('renders nothing on a host with no reconnect contract (standalone)', () => {
        // Standalone never populates connectionRetryStatuses and its retryConnection is
        // a no-op; the control must not appear there even if `blocked` were somehow set.
        render({ machineId: 'standalone_mach_abc', blocked: true, retryConnection: undefined })
        expect(button()).toBeNull()
    })

    it('renders nothing when the conversation resolves to no machine', () => {
        render({ machineId: undefined, blocked: true, retryConnection: vi.fn() })
        expect(button()).toBeNull()
    })

    it('appears once the machine is parked and calls retryConnection with that machine id', () => {
        const retryConnection = vi.fn()
        render({ machineId: 'daemon_mach_abc', blocked: true, retryConnection })

        const btn = button()
        expect(btn).not.toBeNull()
        expect(btn!.disabled).toBe(false)

        act(() => btn!.click())

        expect(retryConnection).toHaveBeenCalledTimes(1)
        expect(retryConnection).toHaveBeenCalledWith('daemon_mach_abc')
    })

    it('dispatches only one retry when tapped repeatedly', () => {
        const retryConnection = vi.fn()
        render({ machineId: 'daemon_mach_abc', blocked: true, retryConnection })

        const btn = button()!
        act(() => btn.click())
        act(() => btn.click())
        act(() => btn.click())

        expect(retryConnection).toHaveBeenCalledTimes(1)
        expect(button()!.disabled).toBe(true)
    })

    it('releases the lock when the machine stops being parked, and re-arms if it parks again', () => {
        const retryConnection = vi.fn()
        render({ machineId: 'daemon_mach_abc', blocked: true, retryConnection })
        act(() => button()!.click())
        expect(button()!.disabled).toBe(true)

        // `blocked` going false is the authoritative "retry accepted" signal
        // (retryConnect clears the parked status synchronously).
        render({ machineId: 'daemon_mach_abc', blocked: false, retryConnection })
        expect(button()).toBeNull()

        // Parked again after another failed budget — the control must work a second time,
        // i.e. the lock must not have survived the unmount/remount of the parked state.
        render({ machineId: 'daemon_mach_abc', blocked: true, retryConnection })
        const rearmed = button()!
        expect(rearmed.disabled).toBe(false)
        act(() => rearmed.click())
        expect(retryConnection).toHaveBeenCalledTimes(2)
    })

    it('frees a lock that no status change ever cleared, so the control cannot wedge', () => {
        vi.useFakeTimers()
        const retryConnection = vi.fn()
        render({ machineId: 'daemon_mach_abc', blocked: true, retryConnection })

        act(() => button()!.click())
        expect(button()!.disabled).toBe(true)

        // Still parked, no status transition arrived — the timeout safety net must
        // re-enable the button rather than leaving the user with a dead control.
        act(() => { vi.advanceTimersByTime(10_000) })
        expect(button()!.disabled).toBe(false)

        act(() => button()!.click())
        expect(retryConnection).toHaveBeenCalledTimes(2)
    })
})
