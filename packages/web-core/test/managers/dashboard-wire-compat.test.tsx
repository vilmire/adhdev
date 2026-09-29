// @vitest-environment jsdom
//
// One dashboard wire format per release (mesh-shared protocol/dashboard-wire-version.ts).
// A daemon that speaks another version is NEVER rendered:
//   - it answers `protocol_mismatch` (it is newer than this page) → a
//     non-dismissable "reload required" overlay, and no state reaches handlers;
//   - its snapshot carries an older (or no) version → "daemon update required",
//     and none of its frames reach handlers;
//   - a matching daemon renders normally.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DASHBOARD_WIRE_VERSION } from '@adhdev/mesh-shared'
import type { SubscribeRequest } from '@adhdev/daemon-core'
import { SubscriptionManager } from '../../src/managers/SubscriptionManager'
import { __resetDashboardWireCompatForTest, getDashboardWireCompat } from '../../src/managers/dashboard-wire-compat'
import DashboardWireCompatOverlay from '../../src/components/DashboardWireCompatOverlay'

const request = (daemonId: string): SubscribeRequest => ({ type: 'subscribe', topic: 'daemon.metadata', key: `daemon:metadata:${daemonId}`, params: { includeSessions: true } })
const snapshot = (daemonId: string, wireVersion?: number) => ({
    topic: 'daemon.metadata', key: `daemon:metadata:${daemonId}`, mode: 'snapshot',
    ...(wireVersion === undefined ? {} : { wireVersion }),
    daemonId, seq: 1, timestamp: 1, status: { instanceId: daemonId, timestamp: 1, sessions: [] },
}) as any

describe('dashboard wire-version gate', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => {
        __resetDashboardWireCompatForTest()
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
        __resetDashboardWireCompatForTest()
    })

    it('every subscribe states the page wire version', () => {
        const manager = new SubscriptionManager()
        const sendData = vi.fn().mockReturnValue(true)
        manager.subscribe({ sendData }, 'd1', request('d1'), vi.fn())
        expect(sendData.mock.calls[0]?.[1]).toMatchObject({ wireVersion: DASHBOARD_WIRE_VERSION })
    })

    it('protocol_mismatch from a newer daemon → reload overlay, no state rendered', () => {
        const manager = new SubscriptionManager()
        const handler = vi.fn()
        manager.subscribe({ sendData: () => true }, 'd1', request('d1'), handler)
        act(() => root.render(<DashboardWireCompatOverlay />))
        expect(container.querySelector('[data-testid="dashboard-wire-reload-overlay"]')).toBeNull()

        act(() => {
            manager.publish({ topic: 'daemon.metadata', key: 'daemon:metadata:d1', mode: 'protocol_mismatch', daemonWireVersion: DASHBOARD_WIRE_VERSION + 1, pageWireVersion: DASHBOARD_WIRE_VERSION, seq: 0, timestamp: 1 } as any)
        })
        expect(handler).not.toHaveBeenCalled()
        expect(getDashboardWireCompat().reloadRequired).toBe(true)
        const overlay = container.querySelector('[data-testid="dashboard-wire-reload-overlay"]')
        expect(overlay).not.toBeNull()
        expect(overlay?.getAttribute('role')).toBe('alertdialog')
        // Non-dismissable: the only control is Reload.
        expect(overlay?.querySelectorAll('button')).toHaveLength(1)
        expect(overlay?.textContent).toContain('Reload required')
    })

    it('a snapshot from an older (unversioned) daemon → daemon-update notice; none of its frames render', () => {
        const manager = new SubscriptionManager()
        const old = vi.fn()
        const current = vi.fn()
        manager.subscribe({ sendData: () => true }, 'd-old', request('d-old'), old)
        manager.subscribe({ sendData: () => true }, 'd-new', request('d-new'), current)
        act(() => root.render(<DashboardWireCompatOverlay />))

        act(() => {
            manager.publish(snapshot('d-old'))
            manager.publish(snapshot('d-new', DASHBOARD_WIRE_VERSION))
        })
        expect(old).not.toHaveBeenCalled()
        expect(current).toHaveBeenCalledTimes(1)
        expect(getDashboardWireCompat()).toEqual({ reloadRequired: false, daemonUpdateRequired: ['d-old'] })
        expect(container.querySelector('[data-testid="dashboard-wire-reload-overlay"]')).toBeNull()
        expect(container.querySelector('[data-testid="dashboard-wire-daemon-update"]')?.textContent).toContain('Daemon update required')

        // Later deltas from the old daemon are dropped too (no resubscribe loop).
        const sendData = vi.fn().mockReturnValue(true)
        manager.subscribe({ sendData }, 'd-old', request('d-old'), old)
        act(() => { manager.publish({ topic: 'daemon.metadata', key: 'daemon:metadata:d-old', mode: 'delta', daemonId: 'd-old', seq: 2, timestamp: 2, delta: {} } as any) })
        expect(old).not.toHaveBeenCalled()

        // The daemon is updated: its next snapshot speaks this version and renders.
        act(() => { manager.publish({ ...snapshot('d-old', DASHBOARD_WIRE_VERSION), seq: 3 }) })
        expect(old).toHaveBeenCalled()
        expect(getDashboardWireCompat().daemonUpdateRequired).toEqual([])
    })
})
