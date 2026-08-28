// Phase 2 Stage 1 — the LOCAL read surface for seqscribe replication health.
//
// `summarizeSeqscribeStats` existed but was reachable through exactly one path:
// the periodic status report to the cloud server. An operator on the machine
// (or a coordinator over mesh_status) could not ask "is replication healthy?"
// at all. `get_status_metadata` is the existing on-demand metadata read — the
// same command that already carries `bootId`, `daemonBuild` and
// `providerChannelStaleness` — so the counters ride there.
//
// ── What must stay true ─────────────────────────────────────────────────────
//   - the key is ALWAYS present, so `seqscribe: null` (no node) is
//     distinguishable from an older daemon that never reported the field;
//   - the payload is the aggregate summary and nothing more. This command is
//     NOT the server status path, but the same §6.1 discipline applies: a
//     topic name embeds a sessionId/meshId, and peer ids are not routing
//     metadata. The shape assertion below is the guard against that widening.

import { describe, expect, it, vi } from 'vitest'
import { statusMetaHandlers } from '../../src/commands/low-family/status-meta.js'
import type { SeqscribeStatusSummary } from '../../src/shared-types.js'

/** Minimal deps for buildStatusSnapshot — the snapshot itself is not under test. */
function baseDeps(extra: Record<string, unknown> = {}) {
    return {
        instanceManager: { collectAllStates: () => [] },
        cdpManagers: new Map(),
        providerLoader: {
            getAll: () => [],
            getAvailableProviderInfos: () => [],
            getChannelStalenessSnapshot: () => null,
        },
        detectedIdes: { value: [] },
        statusInstanceId: 'daemon_test',
        statusVersion: '1.2.3',
        ...extra,
    } as any
}

const HEALTHY: SeqscribeStatusSummary = {
    topics: 3,
    peers: 2,
    peersReady: 2,
    pendingBucket: 0,
    consumerLagBucket: 0,
    queueBucket: 0,
    fgenAgeBucket: 1,
    quarantined: false,
    authority: true,
}

describe('get_status_metadata — seqscribe replication health', () => {
    it('includes the local fleet.status SUB peer snapshot and receive counters', async () => {
        const fleetStatusPeerView = {
            peers: [{
                daemonId: 'daemon_mach_peer',
                at: '2026-08-28T00:00:00.000Z',
                onlineState: 'online',
                p2pActive: true,
                sessionCounts: {
                    ideCount: 1,
                    cliCount: 0,
                    acpCount: 0,
                    idleCount: 1,
                    generatingCount: 0,
                    waitingApprovalCount: 0,
                    erroredCount: 0,
                },
            }],
            diagnostics: {
                subscribedPeers: 1,
                receivedEntries: 2,
                comparedEntries: 2,
                matchedEntries: 2,
                mismatchedEntries: 0,
                invalidEntries: 0,
                viewReplacements: 1,
            },
        }
        const result: any = await statusMetaHandlers.get_status_metadata(
            { deps: baseDeps({ getFleetStatusPeerView: () => fleetStatusPeerView }) },
            {},
        )

        expect(result.fleetStatusPeerView).toEqual(fleetStatusPeerView)
        for (const value of Object.values(result.fleetStatusPeerView.diagnostics)) {
            expect(typeof value).toBe('number')
        }
    })

    it('carries the aggregate summary when a node is open', async () => {
        const getSeqscribeStats = vi.fn(() => HEALTHY)
        const result: any = await statusMetaHandlers.get_status_metadata(
            { deps: baseDeps({ getSeqscribeStats }) },
            {},
        )

        expect(result.success).toBe(true)
        expect(getSeqscribeStats).toHaveBeenCalledTimes(1)
        expect(result.seqscribe).toEqual(HEALTHY)
    })

    it('reports null — not a missing key — when replication is unavailable', async () => {
        // A daemon whose seqscribe node failed to open (fail-soft by contract,
        // node.ts) still answers the command; the caller must be able to tell
        // "no node here" from "this daemon predates the field".
        const result: any = await statusMetaHandlers.get_status_metadata(
            { deps: baseDeps({ getSeqscribeStats: () => null }) },
            {},
        )
        expect(result.seqscribe).toBe(null)
        expect('seqscribe' in result).toBe(true)
    })

    it('reports null when the daemon runtime wires no getter at all', async () => {
        const result: any = await statusMetaHandlers.get_status_metadata({ deps: baseDeps() }, {})
        expect(result.seqscribe).toBe(null)
        expect('seqscribe' in result).toBe(true)
    })

    it('exposes only aggregate counters — no topic names, peer ids or payload-derived text', async () => {
        const result: any = await statusMetaHandlers.get_status_metadata(
            { deps: baseDeps({ getSeqscribeStats: () => HEALTHY }) },
            {},
        )

        // Exact key set. A field added to SeqscribeStatusSummary lands here and
        // must be argued to be non-content before this test is updated — the
        // same allow-list discipline the status path uses, never a deny-list.
        expect(Object.keys(result.seqscribe).sort()).toEqual([
            'authority',
            'consumerLagBucket',
            'fgenAgeBucket',
            'peers',
            'peersReady',
            'pendingBucket',
            'quarantined',
            'queueBucket',
            'topics',
        ])
        // Every value is a number or a boolean: no strings means no id and no
        // free text can be riding along.
        for (const value of Object.values(result.seqscribe)) {
            expect(['number', 'boolean']).toContain(typeof value)
        }
    })
})
