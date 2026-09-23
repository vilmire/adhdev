// ---------------------------------------------------------------------------
// mesh-record-reconcile-evidence — the evidence shape `mesh_reconcile_ledger`
// returns (pure; moved here from daemon-core's retired ledger-reconciliation
// module, C-W9a)
// ---------------------------------------------------------------------------
// C-W9a retired the P2P record IMPORT half of reconciliation: every daemon's
// records stay on that daemon (`mesh_local_records`), the content-free fleet
// view is the replicated `mesh.<id>.events` topic (`mesh_topic_index`), and a
// peer's nested payload (a refine result, a MAGI synthesis) is read from the
// peer over P2P (`get_mesh_ledger_slice`) when it is needed — never copied into
// another daemon's store. So the tool now QUERIES each node's bounded slice
// and reports what it saw; `entriesImported` is always 0 and the status is
// `local` / `queried` / `failed`.
// ---------------------------------------------------------------------------

/** Minimal slice shape (`get_mesh_ledger_slice` → `adhdev.mesh.ledger.slice.v1`). */
export interface AnyRecordSlice {
    entries: Array<{ id: string; meshId: string; timestamp: string; kind: string; nodeId?: string | null; sessionId?: string | null; providerType?: string | null; payload: unknown }>;
    cursor: { afterId: string | null; nextAfterId: string | null; limit: number; hasMore: boolean };
    summary?: Record<string, unknown>;
}

export type MeshRecordReplicaStatus = 'local' | 'queried' | 'failed';

export interface MeshRecordReplicaEvidence {
    nodeId: string;
    daemonId?: string;
    status: MeshRecordReplicaStatus;
    transport: 'local' | 'p2p_datachannel';
    protocol: 'adhdev.mesh.ledger.slice.v1';
    entriesReceived: number;
    /** Always 0 since C-W9a (import retired) — kept so the evidence shape is stable. */
    entriesImported: number;
    skippedDuplicate: number;
    rejectedInvalid: number;
    hasMore: boolean;
    nextAfterId: string | null;
    lastTimestamp: string | null;
    summary?: Record<string, unknown>;
    error?: string;
    noFallbackReason?: string;
}

export interface MeshRecordReconciliationEvidence {
    protocol: 'adhdev.mesh.ledger.reconciliation.v1';
    meshId: string;
    generatedAt: string;
    sourceOfTruth: {
        kind: 'daemon_local_records';
        p2pOnly: true;
        notes: string;
    };
    replicas: MeshRecordReplicaEvidence[];
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

function lastTimestamp(slice?: AnyRecordSlice): string | null {
    const entries = Array.isArray(slice?.entries) ? slice!.entries : [];
    return entries.length ? entries[entries.length - 1].timestamp : null;
}

export function buildMeshRecordReplicaEvidence(args: {
    nodeId: string;
    daemonId?: string;
    transport: 'local' | 'p2p_datachannel';
    slice?: AnyRecordSlice;
    status?: MeshRecordReplicaStatus;
    error?: string;
}): MeshRecordReplicaEvidence {
    const entriesReceived = Array.isArray(args.slice?.entries) ? args.slice!.entries.length : 0;
    return {
        nodeId: args.nodeId,
        ...(args.daemonId ? { daemonId: args.daemonId } : {}),
        status: args.status ?? 'queried',
        transport: args.transport,
        protocol: 'adhdev.mesh.ledger.slice.v1',
        entriesReceived,
        entriesImported: 0,
        skippedDuplicate: 0,
        rejectedInvalid: 0,
        hasMore: args.slice?.cursor?.hasMore === true,
        nextAfterId: args.slice?.cursor?.nextAfterId ?? null,
        lastTimestamp: lastTimestamp(args.slice),
        ...(args.slice?.summary ? { summary: args.slice.summary } : {}),
        ...(args.error ? {
            error: args.error,
            noFallbackReason: 'Record reconciliation is P2P/local-first only; Cloud/D1 is not a record source of truth.',
        } : {}),
    };
}

export function buildMeshRecordReconciliationEvidence(meshId: string, replicas: MeshRecordReplicaEvidence[]): MeshRecordReconciliationEvidence {
    const failedNodes = replicas.filter(replica => replica.status === 'failed').map(replica => replica.nodeId);
    const pendingNodes = replicas.filter(replica => replica.hasMore && replica.status !== 'failed').map(replica => replica.nodeId);
    return {
        protocol: 'adhdev.mesh.ledger.reconciliation.v1',
        meshId,
        generatedAt: new Date().toISOString(),
        sourceOfTruth: {
            kind: 'daemon_local_records',
            p2pOnly: true,
            notes: 'Each daemon keeps its own records (mesh_local_records); the coordinator queries bounded slices over P2P DataChannel and does not import them. The content-free fleet view is the replicated mesh.<id>.events topic. Cloud/D1 is not a record source of truth.',
        },
        replicas,
        totals: {
            replicas: replicas.length,
            queried: replicas.filter(replica => replica.status !== 'failed').length,
            failed: failedNodes.length,
            entriesReceived: replicas.reduce((sum, replica) => sum + replica.entriesReceived, 0),
            entriesImported: 0,
            skippedDuplicate: 0,
            rejectedInvalid: 0,
        },
        convergence: {
            complete: failedNodes.length === 0 && pendingNodes.length === 0,
            pendingNodes,
            failedNodes,
        },
    };
}
