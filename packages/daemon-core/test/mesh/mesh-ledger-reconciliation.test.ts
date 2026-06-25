import { describe, expect, it } from 'vitest';
import {
    buildMeshLedgerReconciliationEvidence,
    buildMeshLedgerReplicaEvidence,
} from '../../src/mesh/mesh-ledger-reconciliation.js';
import type { AppendRemoteLedgerResult, MeshLedgerSlice } from '../../src/mesh/mesh-ledger.js';

function makeSlice(overrides: Partial<MeshLedgerSlice> = {}): MeshLedgerSlice {
    const slice: MeshLedgerSlice = {
        protocol: 'adhdev.mesh.ledger.slice.v1',
        meshId: 'mesh_test',
        entries: [
            {
                id: 'entry_1',
                meshId: 'mesh_test',
                timestamp: '2026-05-13T12:00:00.000Z',
                kind: 'task_completed',
                payload: { ok: true },
            },
        ],
        cursor: {
            afterId: null,
            nextAfterId: 'entry_1',
            limit: 100,
            hasMore: false,
        },
        summary: {
            meshId: 'mesh_test',
            totalEntries: 1,
            taskDispatched: 0,
            taskCompleted: 1,
            taskFailed: 0,
            taskStalled: 0,
            sessionLaunched: 0,
            checkpointCreated: 0,
            lastActivityAt: '2026-05-13T12:00:00.000Z',
            recentFailures: 0,
        },
        sourceOfTruth: {
            kind: 'local_jsonl',
            path: '/tmp/mesh-ledger/mesh_test.jsonl',
            bounded: true,
            maxLimit: 500,
        },
    };
    return { ...slice, ...overrides };
}

describe('mesh-ledger-reconciliation', () => {
    it('builds replica evidence from a P2P ledger slice import', () => {
        const importResult: AppendRemoteLedgerResult = {
            accepted: 1,
            skippedDuplicate: 2,
            rejectedInvalid: 0,
            entries: makeSlice().entries,
        };
        const evidence = buildMeshLedgerReplicaEvidence({
            nodeId: 'node_remote',
            daemonId: 'daemon_remote',
            transport: 'p2p_datachannel',
            slice: makeSlice(),
            importResult,
        });

        expect(evidence.protocol).toBe('adhdev.mesh.ledger.slice.v1');
        expect(evidence.status).toBe('imported');
        expect(evidence.entriesReceived).toBe(1);
        expect(evidence.entriesImported).toBe(1);
        expect(evidence.skippedDuplicate).toBe(2);
        expect(evidence.transport).toBe('p2p_datachannel');
        expect(evidence.nextAfterId).toBe('entry_1');
        expect(evidence.lastTimestamp).toBe('2026-05-13T12:00:00.000Z');
    });

    it('marks failures as P2P/local-first with no Cloud/D1 fallback', () => {
        const evidence = buildMeshLedgerReplicaEvidence({
            nodeId: 'node_failed',
            daemonId: 'daemon_failed',
            transport: 'p2p_datachannel',
            status: 'failed',
            error: 'P2P command timed out',
        });

        expect(evidence.status).toBe('failed');
        expect(evidence.error).toContain('timed out');
        expect(evidence.noFallbackReason).toContain('Cloud/D1 ledger sync is intentionally disabled');
    });

    it('summarizes convergence across replicas', () => {
        const local = buildMeshLedgerReplicaEvidence({
            nodeId: 'node_local',
            transport: 'local',
            slice: makeSlice(),
            status: 'local',
        });
        const pending = buildMeshLedgerReplicaEvidence({
            nodeId: 'node_pending',
            daemonId: 'daemon_pending',
            transport: 'p2p_datachannel',
            slice: makeSlice({ cursor: { afterId: null, nextAfterId: 'entry_1', limit: 100, hasMore: true } }),
            importResult: { accepted: 0, skippedDuplicate: 1, rejectedInvalid: 0, entries: [] },
        });
        const failed = buildMeshLedgerReplicaEvidence({
            nodeId: 'node_failed',
            transport: 'p2p_datachannel',
            status: 'failed',
            error: 'offline',
        });

        const evidence = buildMeshLedgerReconciliationEvidence('mesh_test', [local, pending, failed]);
        expect(evidence.protocol).toBe('adhdev.mesh.ledger.reconciliation.v1');
        expect(evidence.sourceOfTruth.p2pOnly).toBe(true);
        expect(evidence.totals.replicas).toBe(3);
        expect(evidence.totals.failed).toBe(1);
        expect(evidence.convergence.complete).toBe(false);
        expect(evidence.convergence.pendingNodes).toEqual(['node_pending']);
        expect(evidence.convergence.failedNodes).toEqual(['node_failed']);
    });
});
