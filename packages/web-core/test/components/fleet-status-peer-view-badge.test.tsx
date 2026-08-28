// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import FleetStatusPeerViewBadge from '../../src/components/FleetStatusPeerViewBadge'
import type { FleetStatusPeerEntry, DaemonData } from '../../src/types'
import { countDaemonFleetSessions } from '../../src/utils/daemon-utils'

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

/**
 * ★ THE PERMANENT-"DIVERGED" REGRESSION (2026-08-28).
 *
 * The badge compares a locally computed session count against one a REMOTE
 * daemon computed with `countFleetSessions` (daemon-core `status/reporter.ts`).
 * The dashboard used to pass `totalAgents` — a number built by a DIFFERENT rule
 * — so the badge lit "diverged" permanently on healthy fleets.
 *
 * `countDaemonFleetSessions` exists to make that comparison well-posed. These
 * tests pin each of the four axes on which the two definitions disagreed. The
 * fixtures encode the daemon's expected answer directly, because web-core must
 * not value-import the daemon-core barrel; the daemon-side half of this pair
 * lives in daemon-core's `count-fleet-sessions-parity.test.ts`.
 *
 * ── Red/green injection ────────────────────────────────────────────────────
 * Point `wsSessionCount` back at a naive length sum, or drop any one of the
 * four guards in `countDaemonFleetSessions`, and the matching case below goes
 * red.
 */
describe('countDaemonFleetSessions — matches the daemon-side counting rule', () => {
    const DAEMON = 'daemon_mach_local'

    /** Shorthand for a session row as `status-transform` emits it. */
    const row = (over: Partial<DaemonData>): DaemonData => ({
        id: `${DAEMON}:x:${Math.random()}`,
        type: 'claude-code',
        status: 'online',
        daemonId: DAEMON,
        ...over,
    } as DaemonData)

    it('counts the three explicit kind+transport pairs', () => {
        expect(countDaemonFleetSessions([
            row({ sessionKind: 'workspace', transport: 'cdp-page' }),
            row({ sessionKind: 'agent', transport: 'pty' }),
            row({ sessionKind: 'agent', transport: 'acp' }),
        ], DAEMON)).toBe(3)
    })

    it('AXIS 1 — excludes child sessions, as the daemon does', () => {
        expect(countDaemonFleetSessions([
            row({ sessionKind: 'agent', transport: 'pty' }),
            row({ sessionKind: 'agent', transport: 'pty', parentSessionId: 'parent-1' }),
        ], DAEMON)).toBe(1)
    })

    it('AXIS 2 — does NOT dedupe: two rows for one logical session count twice', () => {
        // groupByMachine collapses these; the daemon does not. Matching the
        // daemon is the whole point of this helper.
        expect(countDaemonFleetSessions([
            row({ sessionId: 'same', sessionKind: 'agent', transport: 'pty' }),
            row({ sessionId: 'same', sessionKind: 'agent', transport: 'pty' }),
        ], DAEMON)).toBe(2)
    })

    it('AXIS 3 — no `else` IDE bucket: an unrecognised pair counts as nothing', () => {
        expect(countDaemonFleetSessions([
            // Would land in `ideSessions` via groupByMachine's else-branch.
            row({ sessionKind: 'workspace', transport: 'none' as never }),
            // kind/transport mismatch — neither side should count it.
            row({ sessionKind: 'workspace', transport: 'pty' }),
        ], DAEMON)).toBe(0)
    })

    it('AXIS 4 — attributes by reporting daemonId, not ownerDaemonId', () => {
        expect(countDaemonFleetSessions([
            row({ sessionKind: 'agent', transport: 'pty' }),
            // Reported by another daemon: not this machine's count.
            row({ sessionKind: 'agent', transport: 'pty', daemonId: 'daemon_mach_other' }),
        ], DAEMON)).toBe(1)
    })

    it('ignores the machine-level daemon row itself', () => {
        expect(countDaemonFleetSessions([
            row({ type: 'adhdev-daemon', sessionKind: 'workspace', transport: 'cdp-page' }),
        ], DAEMON)).toBe(0)
    })

    it('matches daemon ids across prefix forms', () => {
        // canon-identity: bare mach_ vs daemon_mach_ must not split a count.
        expect(countDaemonFleetSessions([
            row({ sessionKind: 'agent', transport: 'pty', daemonId: 'mach_local' }),
        ], 'daemon_mach_local')).toBe(1)
    })

    it('agrees with a peer report built from the same sessions (badge reads quiet)', () => {
        const sessions = [
            row({ sessionKind: 'workspace', transport: 'cdp-page' }),
            row({ sessionKind: 'agent', transport: 'pty' }),
            row({ sessionKind: 'agent', transport: 'pty', parentSessionId: 'p' }),
        ]
        const local = countDaemonFleetSessions(sessions, DAEMON)
        // What the daemon's countFleetSessions reports for the same set:
        // 1 ide + 1 cli top-level; the child contributes to neither category.
        render({
            peer: { ...peer, sessionCounts: { ...peer.sessionCounts, ideCount: 1, cliCount: 1, acpCount: 0 } },
            wsOnline: true,
            wsSessionCount: local,
        })
        expect(
            container.querySelector('[data-testid="fleet-status-peer-view-badge"]')
                ?.getAttribute('data-diverged'),
        ).toBe('false')
    })
})
