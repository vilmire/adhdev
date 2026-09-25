/**
 * Graph-orchestration usage counters + the open-gate listing that mesh_status
 * surfaces (the 2026-09-25 graph orchestration simplification D3(b), D6).
 *
 * Both ride the daemon's `active_work_query` response as extra keys of
 * `activeWork.summary`, which the mcp-server's mesh_status passes through
 * verbatim as `activeWorkSummary` — so they surface without a wire-contract
 * change. Content boundary: identifiers, enums, timestamps and counters only
 * (gate `instructions` are coordinator-authored free text and are deliberately
 * NOT listed here — mesh_graph_view carries them).
 *
 * D6 decision rule (design §1): if ≥ 60 % of graphs stay ≤ 2 nodes for two weeks
 * after the change, the batch surface is cut further — `nodesPerGraphP50` and
 * `graphsLast7d` are the inputs to that call.
 */

import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { MESH_GATE_AUTO_ABANDON_REASON } from './mesh-graph-gate-closure.js';

/** Window every usage counter is computed over. */
export const GRAPH_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Usage counters are cached per mesh for at least this long. */
export const GRAPH_USAGE_CACHE_TTL_MS = 60_000;
/** mesh_status lists at most this many open gates (expired first, then oldest). */
export const BLOCKED_GATES_LIST_LIMIT = 10;

export interface MeshGraphUsage {
    /** Graphs created in the last 7 days. */
    graphsLast7d: number;
    /** Median node count (tasks + gates) over those graphs; 0 when none. */
    nodesPerGraphP50: number;
    /** Gates that went `expired` (deadline) within the window and are still expired. */
    gatesExpired: number;
    /** Gates auto-closed with reason `downstream_all_terminal` within the window. */
    gatesAutoAbandoned: number;
    /** Queue tasks created in the window with a non-empty `dependsOn` that are NOT batch-graph nodes (mesh_enqueue_task chains). */
    depsChainedViaEnqueueTask: number;
    windowDays: 7;
    computedAt: string;
}

export interface MeshBlockedGateRow {
    gateId: string;
    graphId: string;
    ref?: string;
    action: string;
    /** `awaiting_coordinator` | `claimed` | `expired` (hold only — other policies already settled downstream). */
    state: string;
    /** ms since the gate opened (its node became workable). */
    ageMs?: number;
    deadlineAt?: string;
    leaseOwnerSessionId?: string;
}

export interface MeshBlockedGatesSummary {
    blockedGates: MeshBlockedGateRow[];
    blockedGatesTotal: number;
    expiredGatesTotal: number;
}

const usageCache = new Map<string, { atMs: number; usage: MeshGraphUsage }>();

export function __resetMeshGraphUsageCacheForTests(): void {
    usageCache.clear();
}

function count(sql: string, ...params: unknown[]): number {
    const row = MeshRuntimeStore.getInstance().db.prepare(sql).get(...params) as { n?: number } | undefined;
    return typeof row?.n === 'number' ? row.n : 0;
}

/** D6 counters for one mesh. Cheap indexed queries, cached ≥ 60 s per mesh. */
export function computeMeshGraphUsage(meshId: string, nowMs: number = Date.now()): MeshGraphUsage {
    const cached = usageCache.get(meshId);
    if (cached && nowMs - cached.atMs < GRAPH_USAGE_CACHE_TTL_MS && nowMs >= cached.atMs) return cached.usage;

    const db = MeshRuntimeStore.getInstance().db;
    const sinceIso = new Date(nowMs - GRAPH_USAGE_WINDOW_MS).toISOString();
    const sizes = (db.prepare(
        `SELECT task_count + gate_count AS n FROM mesh_task_graphs WHERE mesh_id = ? AND created_at >= ? ORDER BY n`,
    ).all(meshId, sinceIso) as Array<{ n: number }>).map(r => r.n);
    const nodesPerGraphP50 = sizes.length === 0
        ? 0
        : sizes.length % 2 === 1
            ? sizes[(sizes.length - 1) / 2]
            : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2;

    const usage: MeshGraphUsage = {
        graphsLast7d: sizes.length,
        nodesPerGraphP50,
        gatesExpired: count(
            `SELECT COUNT(*) AS n FROM mesh_graph_gates WHERE mesh_id = ? AND state = 'expired' AND updated_at >= ?`,
            meshId, sinceIso,
        ),
        gatesAutoAbandoned: count(
            `SELECT COUNT(*) AS n FROM mesh_task_graph_nodes
             WHERE mesh_id = ? AND kind = 'coordinator_gate' AND state = 'cancelled'
               AND failure_reason LIKE ? AND updated_at >= ?`,
            meshId, `%:${MESH_GATE_AUTO_ABANDON_REASON}`, sinceIso,
        ),
        // `"dependsOn":["` is how JSON.stringify writes a NON-empty string array
        // (an empty one is `"dependsOn":[]`), so LIKE is exact without JSON1.
        depsChainedViaEnqueueTask: count(
            `SELECT COUNT(*) AS n FROM mesh_queue q
             WHERE q.mesh_id = ? AND q.created_at >= ? AND q.payload LIKE '%"dependsOn":["%'
               AND NOT EXISTS (SELECT 1 FROM mesh_task_graph_nodes g WHERE g.queue_task_id = q.id)`,
            meshId, sinceIso,
        ),
        windowDays: 7,
        computedAt: new Date(nowMs).toISOString(),
    };
    usageCache.set(meshId, { atMs: nowMs, usage });
    return usage;
}

/**
 * Open gates for mesh_status's blocked listing: every gate still holding work
 * back — `awaiting_coordinator`, `claimed`, and `expired` under `hold` (D3(b):
 * an expired gate must stay VISIBLE, not vanish when its deadline passes).
 * Expired first, then oldest.
 */
export function listMeshBlockedGates(meshId: string, nowMs: number = Date.now()): MeshBlockedGatesSummary {
    const graphStore = MeshRuntimeStore.getInstance().graphStore();
    const gates = graphStore.listGatesByMesh(meshId, ['awaiting_coordinator', 'claimed', 'expired'])
        .filter(g => g.state !== 'expired' || g.onTimeout === 'hold');
    const rows: MeshBlockedGateRow[] = gates.map(g => {
        const node = graphStore.getNode(g.graphId, g.nodeId);
        const openedMs = Date.parse(node?.stateChangedAt && g.state !== 'expired' ? node.stateChangedAt : g.createdAt);
        // For an expired gate the node's stateChangedAt is the EXPIRY instant, so
        // age is measured from the gate row's creation instead.
        return {
            gateId: g.gateId,
            graphId: g.graphId,
            ...(g.ref ? { ref: g.ref } : {}),
            action: g.action,
            state: g.state,
            ...(Number.isFinite(openedMs) ? { ageMs: Math.max(0, nowMs - openedMs) } : {}),
            ...(g.deadlineAt ? { deadlineAt: g.deadlineAt } : {}),
            ...(g.state === 'claimed' && g.leaseOwnerSessionId ? { leaseOwnerSessionId: g.leaseOwnerSessionId } : {}),
        };
    });
    rows.sort((a, b) => {
        const ae = a.state === 'expired' ? 0 : 1;
        const be = b.state === 'expired' ? 0 : 1;
        return ae - be || (b.ageMs ?? 0) - (a.ageMs ?? 0);
    });
    return {
        blockedGates: rows.slice(0, BLOCKED_GATES_LIST_LIMIT),
        blockedGatesTotal: rows.length,
        expiredGatesTotal: rows.filter(r => r.state === 'expired').length,
    };
}
