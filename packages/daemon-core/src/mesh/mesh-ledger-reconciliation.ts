import type { AppendRemoteLedgerResult, MeshLedgerSlice, MeshLedgerSummary } from './mesh-ledger.js';

/** Minimal ledger slice shape accepted by buildMeshLedgerReplicaEvidence. Covers both JSONL and SQLite slices. */
export interface AnyLedgerSlice {
    entries: Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId?: string | null; sessionId?: string | null; providerType?: string | null; payload: unknown }>;
    cursor: { afterId: string | null; nextAfterId: string | null; limit: number; hasMore: boolean };
    summary?: MeshLedgerSummary;
}

export type MeshLedgerReplicaStatus = 'local' | 'queried' | 'imported' | 'failed';

export interface MeshLedgerReplicaEvidence {
    nodeId: string;
    daemonId?: string;
    status: MeshLedgerReplicaStatus;
    transport: 'local' | 'p2p_datachannel';
    protocol: 'adhdev.mesh.ledger.slice.v1';
    entriesReceived: number;
    entriesImported: number;
    skippedDuplicate: number;
    rejectedInvalid: number;
    hasMore: boolean;
    nextAfterId: string | null;
    lastTimestamp: string | null;
    summary?: MeshLedgerSummary;
    error?: string;
    noFallbackReason?: string;
}

export interface MeshLedgerReconciliationEvidence {
    protocol: 'adhdev.mesh.ledger.reconciliation.v1';
    meshId: string;
    generatedAt: string;
    sourceOfTruth: {
        kind: 'coordinator_local_sqlite';
        p2pOnly: true;
        notes: string;
    };
    replicas: MeshLedgerReplicaEvidence[];
    totals: {
        replicas: number;
        queried: number;
        failed: number;
        entriesReceived: number;
        entriesImported: number;
        skippedDuplicate: number;
        rejectedInvalid: number;
    };
    convergence: {
        complete: boolean;
        pendingNodes: string[];
        failedNodes: string[];
    };
}

function lastTimestamp(slice?: AnyLedgerSlice): string | null {
    const entries = Array.isArray(slice?.entries) ? slice!.entries : [];
    return entries.length ? entries[entries.length - 1].timestamp : null;
}

export function buildMeshLedgerReplicaEvidence(args: {
    nodeId: string;
    daemonId?: string;
    transport: 'local' | 'p2p_datachannel';
    slice?: AnyLedgerSlice;
    importResult?: AppendRemoteLedgerResult;
    status?: MeshLedgerReplicaStatus;
    error?: string;
}): MeshLedgerReplicaEvidence {
    const entriesReceived = Array.isArray(args.slice?.entries) ? args.slice!.entries.length : 0;
    return {
        nodeId: args.nodeId,
        ...(args.daemonId ? { daemonId: args.daemonId } : {}),
        status: args.status ?? (args.importResult && args.importResult.accepted > 0 ? 'imported' : 'queried'),
        transport: args.transport,
        protocol: 'adhdev.mesh.ledger.slice.v1',
        entriesReceived,
        entriesImported: args.importResult?.accepted ?? 0,
        skippedDuplicate: args.importResult?.skippedDuplicate ?? 0,
        rejectedInvalid: args.importResult?.rejectedInvalid ?? 0,
        hasMore: args.slice?.cursor?.hasMore === true,
        nextAfterId: args.slice?.cursor?.nextAfterId ?? null,
        lastTimestamp: lastTimestamp(args.slice),
        ...(args.slice?.summary ? { summary: args.slice.summary } : {}),
        ...(args.error ? {
            error: args.error,
            noFallbackReason: 'Ledger reconciliation is P2P/local-first only; Cloud/D1 ledger sync is intentionally disabled.',
        } : {}),
    };
}

export function buildMeshLedgerReconciliationEvidence(meshId: string, replicas: MeshLedgerReplicaEvidence[]): MeshLedgerReconciliationEvidence {
    const failedNodes = replicas.filter(replica => replica.status === 'failed').map(replica => replica.nodeId);
    const pendingNodes = replicas.filter(replica => replica.hasMore && replica.status !== 'failed').map(replica => replica.nodeId);
    return {
        protocol: 'adhdev.mesh.ledger.reconciliation.v1',
        meshId,
        generatedAt: new Date().toISOString(),
        sourceOfTruth: {
            kind: 'coordinator_local_sqlite',
            p2pOnly: true,
            notes: 'Coordinator reconciles bounded slices from daemon-local SQLite event ledgers (mesh_event_ledger table) over P2P DataChannel; Cloud/D1 is not a ledger source of truth.',
        },
        replicas,
        totals: {
            replicas: replicas.length,
            queried: replicas.filter(replica => replica.status !== 'failed').length,
            failed: failedNodes.length,
            entriesReceived: replicas.reduce((sum, replica) => sum + replica.entriesReceived, 0),
            entriesImported: replicas.reduce((sum, replica) => sum + replica.entriesImported, 0),
            skippedDuplicate: replicas.reduce((sum, replica) => sum + replica.skippedDuplicate, 0),
            rejectedInvalid: replicas.reduce((sum, replica) => sum + replica.rejectedInvalid, 0),
        },
        convergence: {
            complete: failedNodes.length === 0 && pendingNodes.length === 0,
            pendingNodes,
            failedNodes,
        },
    };
}
