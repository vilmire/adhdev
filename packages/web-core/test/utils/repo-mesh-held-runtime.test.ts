/**
 * Coordinator-held node runtime (mesh_status `nodes[].heldRuntime`) survives
 * status normalization and becomes the node's sessions.
 *
 * The dashboard no longer subscribes to every member daemon to learn what runs
 * on a remote node: the coordinator holds each remote node's content-free
 * runtime (raw get_status_metadata-shaped sessions) and mesh_status carries it.
 * Two things must hold for that to reach the screen:
 *   1. normalization (extractRepoMeshStatus / canonicalizeRepoMeshStatus — incl.
 *      the snake_case alias rebuild cloud always triggers) must NOT drop
 *      `heldRuntime`;
 *   2. its sessions must be folded into `activeSessionDetails` of the node they
 *      are stamped to.
 *
 * Break-once: remove the `heldRuntime` pass-through in normalizeRepoMeshNodeStatus
 * (repo-mesh-status.ts) and the "preserved" + "mapped" cases go red.
 */
import { describe, expect, it } from 'vitest'
import { canonicalizeRepoMeshStatus, extractRepoMeshStatus, normalizeHeldRuntime } from '../../src/utils/repo-mesh-status'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'

function heldRuntime(sessions: unknown[], extra: Record<string, unknown> = {}) {
    return { source: 'member_push', observedAt: 1_700_000_000_000, refreshing: false, sessions, ...extra }
}

function statusWith(nodes: unknown[]) {
    return {
        success: true,
        result: {
            success: true,
            meshId: 'mesh_a',
            meshName: 'Mesh A',
            repoIdentity: 'github.com/acme/repo',
            refreshedAt: '2026-09-27T00:00:00.000Z',
            nodeRuntimeHeld: true,
            nodes,
            queue: { tasks: [], summary: {} },
        },
    }
}

const remoteNode = {
    nodeId: 'node_remote',
    machineLabel: 'remote-box',
    workspace: '/remote/repo',
    daemonId: 'daemon_remote',
    machineStatus: 'online',
    health: 'online',
    providers: ['codex-cli'],
    activeSessions: [],
    connection: { perspective: 'selected_coordinator', source: 'mesh_peer_status', state: 'connected', transport: 'direct', reported: true },
    gitObservation: { source: 'member_push', observedAt: 1_700_000_000_000, refreshing: false, unreachableSince: null },
    heldRuntime: heldRuntime([
        {
            id: 'sess_worker',
            providerType: 'codex-cli',
            status: 'generating',
            activeChat: { status: 'generating' },
            turn: { stage: 'running' },
            settings: { meshNodeFor: 'mesh_a', meshNodeId: 'node_remote' },
        },
        {
            // Stamped to ANOTHER node served by the same daemon — must not land here.
            id: 'sess_other_node',
            providerType: 'claude-cli',
            status: 'idle',
            settings: { meshNodeFor: 'mesh_a', meshNodeId: 'node_other' },
        },
        {
            // A plain user session on that machine (no mesh stamp) — not a mesh session.
            id: 'sess_unrelated',
            providerType: 'claude-cli',
            status: 'idle',
        },
    ], { daemonBuild: { commit: 'abc', track: 'preview' }, futureField: { opaque: true } }),
}

describe('heldRuntime survives normalization', () => {
    it('extractRepoMeshStatus preserves heldRuntime (and unknown extra keys) on the node', () => {
        const status = extractRepoMeshStatus(statusWith([remoteNode]))
        const node = status?.nodes.find(n => n.nodeId === 'node_remote')
        expect(node?.heldRuntime).toMatchObject({
            source: 'member_push',
            refreshing: false,
            daemonBuild: { commit: 'abc', track: 'preview' },
            futureField: { opaque: true },
        })
        expect(node?.heldRuntime?.sessions).toHaveLength(3)
    })

    it('canonicalizeRepoMeshStatus keeps heldRuntime through the snake_case alias rebuild (cloud path)', () => {
        const extracted = extractRepoMeshStatus(statusWith([remoteNode]))!
        // Cloud's node normalizer used to add snake_case aliases, which forces the
        // field-by-field rebuild in canonicalizeRepoMeshNodes.
        const aliased = {
            ...extracted,
            nodes: extracted.nodes.map(node => ({ ...node, daemon_id: node.daemonId, machine_label: node.machineLabel })),
        }
        const canonical = canonicalizeRepoMeshStatus(aliased as any)
        const node = canonical.nodes.find(n => n.nodeId === 'node_remote')
        expect(node?.heldRuntime?.source).toBe('member_push')
        expect(node?.gitObservation?.source).toBe('member_push')
        expect(node?.machineStatus).toBe('online')
    })
})

describe('heldRuntime sessions become the node sessions', () => {
    it('maps sessions stamped to the node into activeSessionDetails (content-free fields only)', () => {
        const status = extractRepoMeshStatus(statusWith([remoteNode]))!
        const node = status.nodes.find(n => n.nodeId === 'node_remote')!
        expect(node.activeSessionDetails).toEqual([
            expect.objectContaining({
                sessionId: 'sess_worker',
                providerType: 'codex-cli',
                state: 'generating',
                chatStatus: 'generating',
                role: 'worker',
                workspace: '/remote/repo',
                isSelfCoordinator: false,
            }),
        ])
        expect(node.activeSessions).toEqual(['sess_worker'])
        // Rendered by the graph with no member daemon subscription at all.
        const graphNode = buildMeshGraph(status).nodes.find(n => n.id === 'node_remote')
        expect(graphNode?.sessionDetails.map(s => s.sessionId)).toEqual(['sess_worker'])
    })

    it("source 'none' (coordinator holds nothing yet) adds no sessions — unknown is not zero", () => {
        const node = { ...remoteNode, heldRuntime: { source: 'none', observedAt: null, refreshing: true, sessions: [] } }
        const status = extractRepoMeshStatus(statusWith([node]))!
        const out = status.nodes[0]
        expect(out.heldRuntime).toMatchObject({ source: 'none', refreshing: true })
        expect(out.activeSessionDetails).toBeUndefined()
        expect(out.activeSessions).toEqual([])
    })

    it('merges with sessions the coordinator already listed for the node (no duplicates)', () => {
        const node = {
            ...remoteNode,
            activeSessions: ['sess_worker'],
            activeSessionDetails: [{ sessionId: 'sess_worker', providerType: 'codex-cli', state: 'idle' }],
        }
        const status = extractRepoMeshStatus(statusWith([node]))!
        expect(status.nodes[0].activeSessionDetails?.map(s => s.sessionId)).toEqual(['sess_worker'])
        expect(status.nodes[0].activeSessionDetails?.[0]).toMatchObject({ state: 'generating' })
    })

    it('an unstamped coordinator session for this mesh lands on the daemon\'s only node', () => {
        const node = {
            ...remoteNode,
            heldRuntime: heldRuntime([
                { id: 'sess_coord', providerType: 'claude-cli', status: 'idle', settings: { meshCoordinatorFor: 'mesh_a' } },
            ]),
        }
        const status = extractRepoMeshStatus(statusWith([node]))!
        expect(status.nodes[0].activeSessionDetails?.[0]).toMatchObject({ sessionId: 'sess_coord', role: 'coordinator' })
    })

    it('a coordinator predating heldRuntime (field absent) normalizes exactly as before', () => {
        const { heldRuntime: _drop, ...legacy } = remoteNode
        const status = extractRepoMeshStatus(statusWith([legacy]))!
        expect(status.nodes[0].heldRuntime).toBeUndefined()
        expect(status.nodes[0].activeSessionDetails).toBeUndefined()
    })

    it('normalizeHeldRuntime rejects garbage defensively', () => {
        expect(normalizeHeldRuntime(null)).toBeNull()
        expect(normalizeHeldRuntime('x')).toBeNull()
        expect(normalizeHeldRuntime({ source: 'made_up', sessions: [] })).toBeNull()
        expect(normalizeHeldRuntime({ source: 'coordinator_probe', sessions: 'nope' })?.sessions).toEqual([])
    })
})
