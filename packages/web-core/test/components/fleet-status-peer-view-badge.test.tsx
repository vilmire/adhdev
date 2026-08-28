// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import FleetStatusPeerViewBadge from '../../src/components/FleetStatusPeerViewBadge'
import type { FleetStatusPeerEntry } from '../../src/types'

const NOW = Date.parse('2026-08-28T06:00:00.000Z')
let container: HTMLDivElement
let root: Root

const peer: FleetStatusPeerEntry = {
    daemonId: 'daemon_mach_peer',
    at: '2026-08-28T05:59:55.000Z',
    onlineState: 'online',
    p2pActive: true,
    sessionCounts: {
        ideCount: 1,
        cliCount: 2,
        acpCount: 0,
        idleCount: 2,
        generatingCount: 1,
        waitingApprovalCount: 0,
        erroredCount: 0,
    },
}

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
})

function render(props: { peer?: FleetStatusPeerEntry; wsOnline: boolean; wsSessionCount: number }) {
    act(() => root.render(<FleetStatusPeerViewBadge {...props} now={NOW} />))
}

describe('FleetStatusPeerViewBadge', () => {
    it('shows a quiet auxiliary badge when the fresh SUB view agrees with WS', () => {
        render({ peer, wsOnline: true, wsSessionCount: 3 })
        const badge = container.querySelector('[data-testid="fleet-status-peer-view-badge"]')
        expect(badge).not.toBeNull()
        expect(badge?.getAttribute('data-diverged')).toBe('false')
    })

    it('highlights the cross-check when WS is offline but the P2P peer view is fresh', () => {
        render({ peer, wsOnline: false, wsSessionCount: 0 })
        const badge = container.querySelector('[data-testid="fleet-status-peer-view-badge"]')
        expect(badge?.getAttribute('data-diverged')).toBe('true')
        const tooltip = badge?.getAttribute('title') || ''
        expect(tooltip).toContain('WS')
        expect(tooltip).toContain('seqscribe')
        expect(tooltip).toContain('online')
    })

    it('renders nothing for an old peer observation', () => {
        render({
            peer: { ...peer, at: '2026-08-28T05:00:00.000Z' },
            wsOnline: false,
            wsSessionCount: 0,
        })
        expect(container.textContent).toBe('')
    })
})
