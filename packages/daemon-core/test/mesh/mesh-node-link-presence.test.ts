/**
 * A remote node's presence follows its mesh link when the link is authoritative
 * (standalone direct WS, `linkIsPresence`): a killed member must not stay
 * `machineStatus: 'online'` from its last held push while the link reads
 * closed / connecting. Demand-dialed links (cloud WebRTC, no mark) keep the
 * held derivation.
 */
import { describe, expect, it } from 'vitest'
import { applyMeshNodeLinkPresence, readMeshNodeLinkPresence } from '../../src/mesh/mesh-node-link-presence'
import { finalizeMeshNodeStatus } from '../../src/mesh/mesh-node-freshness'
import { overlayMeshNodeGitObservations } from '../../src/commands/high-family/mesh-status-node-state'
import { invalidateAggregateMeshStatusForPeer } from '../../src/commands/router-aggregate-status'

const MEMBER = 'standalone_mach_member01'

function wsLink(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        perspective: 'selected_coordinator',
        source: 'mesh_peer_status',
        reported: true,
        state,
        transport: 'direct',
        directPeerTruthSatisfied: state === 'connected',
        authority: state === 'connected' || state === 'connecting' ? 'live_peer' : 'cached_terminal_diagnostic',
        cached: state !== 'connected',
        ageMs: 0,
        lastStateChangeAt: new Date(0).toISOString(),
        linkIsPresence: true,
        ...extra,
    }
}

/** A cloud WebRTC snapshot: same shape, no presence mark. */
function p2pLink(state: string): Record<string, unknown> {
    const { linkIsPresence: _omit, ...rest } = wsLink(state)
    return rest
}

describe('readMeshNodeLinkPresence', () => {
    it('maps a presence link: connected → online, every other state → offline', () => {
        expect(readMeshNodeLinkPresence(wsLink('connected'))).toBe('online')
        for (const state of ['closed', 'failed', 'disconnected', 'connecting']) {
            expect(readMeshNodeLinkPresence(wsLink(state)), state).toBe('offline')
        }
    })

    it('is null for a link that is not presence (cloud P2P), self, not_reported or missing', () => {
        expect(readMeshNodeLinkPresence(p2pLink('failed'))).toBeNull()
        expect(readMeshNodeLinkPresence(p2pLink('connected'))).toBeNull()
        expect(readMeshNodeLinkPresence({ source: 'mesh_peer_status', state: 'self' })).toBeNull()
        expect(readMeshNodeLinkPresence({ ...wsLink('closed'), source: 'not_reported' })).toBeNull()
        expect(readMeshNodeLinkPresence(undefined)).toBeNull()
        expect(readMeshNodeLinkPresence(null)).toBeNull()
    })
})

describe('applyMeshNodeLinkPresence', () => {
    it('a closed presence link overrides a held online status', () => {
        const status: Record<string, unknown> = { machineStatus: 'online', health: 'online', launchReady: true, connection: wsLink('closed') }
        expect(applyMeshNodeLinkPresence(status)).toBe('offline')
        expect(status).toMatchObject({ machineStatus: 'offline', health: 'offline', launchReady: false })
    })

    it('a connected presence link reports online and leaves git health alone', () => {
        const status: Record<string, unknown> = { health: 'dirty', connection: wsLink('connected') }
        expect(applyMeshNodeLinkPresence(status)).toBe('online')
        expect(status).toMatchObject({ machineStatus: 'online', health: 'dirty' })
    })

    it('leaves a non-presence link untouched (cloud is not regressed)', () => {
        const status: Record<string, unknown> = { machineStatus: 'online', health: 'online', connection: p2pLink('failed') }
        expect(applyMeshNodeLinkPresence(status)).toBeNull()
        expect(status).toEqual({ machineStatus: 'online', health: 'online', connection: p2pLink('failed') })
    })
})

describe('finalizeMeshNodeStatus — presence link', () => {
    it('a member with a held push but a closed link is offline and not launch-ready', () => {
        const status: Record<string, unknown> = { nodeId: 'n1', daemonId: MEMBER, machineStatus: 'online', health: 'online', connection: wsLink('closed') }
        finalizeMeshNodeStatus({ status, node: { id: 'n1', daemonId: MEMBER }, daemonId: MEMBER, isSelfNode: false })
        expect(status).toMatchObject({ machineStatus: 'offline', health: 'offline', launchReady: false })
    })

    it("a refresh's queued request ('connecting' peer, no socket) is still offline", () => {
        const status: Record<string, unknown> = { nodeId: 'n1', daemonId: MEMBER, machineStatus: 'online', health: 'online', connection: wsLink('connecting') }
        finalizeMeshNodeStatus({ status, node: { id: 'n1', daemonId: MEMBER }, daemonId: MEMBER, isSelfNode: false })
        expect(status.machineStatus).toBe('offline')
        expect(status.launchReady).toBe(false)
    })

    it('a reconnected member is online and launch-ready even with nothing held', () => {
        const status: Record<string, unknown> = { nodeId: 'n1', daemonId: MEMBER, health: 'unknown', connection: wsLink('connected') }
        finalizeMeshNodeStatus({ status, node: { id: 'n1', daemonId: MEMBER }, daemonId: MEMBER, isSelfNode: false })
        expect(status).toMatchObject({ machineStatus: 'online', launchReady: true })
    })

    it('a cloud member keeps its held machineStatus over a failed P2P link', () => {
        const status: Record<string, unknown> = { nodeId: 'n1', daemonId: MEMBER, machineStatus: 'online', health: 'online', connection: p2pLink('failed') }
        finalizeMeshNodeStatus({ status, node: { id: 'n1', daemonId: MEMBER }, daemonId: MEMBER, isSelfNode: false })
        expect(status).toMatchObject({ machineStatus: 'online', health: 'online', launchReady: true })
    })
})

describe('overlayMeshNodeGitObservations — every serve re-applies the link', () => {
    const store = { get: () => undefined } as any
    const refresher = { isRefreshing: () => false, isRuntimeRefreshing: () => false } as any

    it('a cached snapshot whose node was re-hydrated online is corrected to the closed link', () => {
        const snapshot = {
            nodes: [
                { nodeId: 'self', daemonId: 'standalone_mach_host01', workspace: '/nope/self', machineStatus: 'online', health: 'online', connection: { source: 'mesh_peer_status', state: 'self' } },
                { nodeId: 'n1', daemonId: MEMBER, workspace: '/nope/member', machineStatus: 'online', health: 'online', launchReady: true, connection: wsLink('closed') },
            ],
        }
        overlayMeshNodeGitObservations(snapshot, { meshId: 'm1', store, refresher })
        expect(snapshot.nodes[0]).toMatchObject({ machineStatus: 'online', health: 'online' })
        expect(snapshot.nodes[1]).toMatchObject({ machineStatus: 'offline', health: 'offline', launchReady: false })
    })
})

describe('invalidateAggregateMeshStatusForPeer', () => {
    function fakeRouter(entries: Record<string, string[]>) {
        const invalidated: string[] = []
        const self = {
            aggregateMeshStatusCache: new Map(Object.entries(entries).map(([meshId, daemonIds]) => [meshId, {
                builtAt: 0,
                queueRevision: 'r',
                snapshot: { success: true, nodes: daemonIds.map((daemonId, i) => ({ nodeId: `${meshId}-${i}`, daemonId })) },
            }])),
            invalidateAggregateMeshStatus(meshId: string) { invalidated.push(meshId); self.aggregateMeshStatusCache.delete(meshId) },
        }
        return { self, invalidated }
    }

    it('drops only the cached meshes that render a node of that peer (any id form)', () => {
        const { self, invalidated } = fakeRouter({
            withMember: ['standalone_mach_host01', MEMBER],
            other: ['standalone_mach_host01', 'standalone_mach_other99'],
        })
        expect(invalidateAggregateMeshStatusForPeer(self as any, 'daemon_mach_member01')).toBe(1)
        expect(invalidated).toEqual(['withMember'])
        expect(self.aggregateMeshStatusCache.has('other')).toBe(true)
    })

    it('is a no-op for an empty id or an unknown peer', () => {
        const { self, invalidated } = fakeRouter({ m: [MEMBER] })
        expect(invalidateAggregateMeshStatusForPeer(self as any, '')).toBe(0)
        expect(invalidateAggregateMeshStatusForPeer(self as any, 'standalone_mach_nobody')).toBe(0)
        expect(invalidated).toEqual([])
    })
})
