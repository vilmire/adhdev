// Batched / trimmed daemon reads for the coordinator's read tools
// (mesh_status, mesh_view_queue, mesh_list_pending_approvals).
//
// MCP read-latency pass (2026-09-27). Measured on the preview coordinator
// (1,568 queue rows, 1,567 historical): mesh_status took 570–680 ms and pulled
// 5.2 MB over IPC, mesh_view_queue moved the whole queue twice (10.5 MB in +
// 5.3 MB out). Every helper here asks the daemon for exactly what the tool reads
// and computes over its own store:
//   - active work: slim node session lists, no queue argument (the daemon reads
//     its own queue), scheduling runtime without shipping the mesh;
//   - recovery contexts: one batched call for every node;
//   - mesh_status missions: the daemon's projection (the MCP no longer opens the
//     daemon's SQLite store in-process);
//   - mission stats: one batched task_stats_query;
//   - queue view: active rows + whole-queue counts + dependency heads.
//
// One request shape per read: the coordinator daemon ships with this MCP server
// (same release), so there is no older-daemon request fallback. No helper ever
// reads the daemon store in-process.

import type { MeshContext } from './mesh-tools-internal.js';
import {
    activeWorkQuery,
    missionListQuery,
    queueQuery,
    recoveryContextQuery,
    taskStatsQuery,
} from '../ipc/turn-commands.js';
import type { ActiveWorkQueryResponse, QueueDependencyHeadWire } from '@adhdev/mesh-shared';

/**
 * The node fields `buildMeshActiveWork` (daemon-core sessionStatusFromNodes)
 * reads: the node id and every session-list shape. A full node (policy,
 * nodeFacts, git, …) is ~9 KB and none of the rest is read.
 */
const ACTIVE_WORK_NODE_KEYS = [
    'id', 'nodeId', 'node_id',
    'sessions', 'activeSessions', 'active_sessions', 'activeSessionDetails', 'active_session_details',
    'sessionDetails', 'session_details', 'lastProbe', 'last_probe',
    'activeSession', 'active_session', 'currentSession', 'current_session', 'runtimeSession', 'runtime_session', 'session',
] as const;

export function slimNodesForActiveWork(nodes: readonly unknown[]): Record<string, unknown>[] {
    return nodes.map((node) => {
        const src = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of ACTIVE_WORK_NODE_KEYS) {
            if (src[key] !== undefined) out[key] = src[key];
        }
        return out;
    });
}

/** `active_work_query`; the scheduling runtime is computed from the daemon's own mesh record. */
export async function activeWorkQueryWithRuntime(
    ctx: MeshContext,
    args: Omit<Parameters<typeof activeWorkQuery>[1], 'v' | 'meshId' | 'mesh'>,
): Promise<ActiveWorkQueryResponse> {
    return activeWorkQuery(ctx.transport, { meshId: ctx.mesh.id, ...args });
}

/** Recovery context per node id — ONE batched call. */
export async function readRecoveryContexts(ctx: MeshContext, nodeIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const ids = [...new Set(nodeIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const res = await recoveryContextQuery(ctx.transport, { meshId: ctx.mesh.id, nodeIds: ids });
    for (const [nodeId, context] of Object.entries(res.contexts ?? {})) out.set(nodeId, context);
    return out;
}

/** mesh_status COMPACT missions: live rows (goal-elided) + folded history, computed in the daemon. */
export async function readStatusMissionsCompact(ctx: MeshContext): Promise<{ live: Record<string, unknown>[]; historyFold: Record<string, unknown> | null }> {
    const res = await missionListQuery(ctx.transport, { meshId: ctx.mesh.id, meshStatusView: 'compact' });
    return { live: res.missions as unknown as Record<string, unknown>[], historyFold: res.historyFold as unknown as Record<string, unknown> | null };
}

/**
 * mesh_status VERBOSE missions: live + capped history with full goals, each with
 * its stats rollup — the rows from the daemon's projection and every rollup from
 * ONE batched task_stats_query.
 */
export async function readStatusMissionsVerbose(ctx: MeshContext): Promise<Record<string, unknown>[]> {
    const res = await missionListQuery(ctx.transport, { meshId: ctx.mesh.id, meshStatusView: 'verbose' });
    const missions = res.missions as unknown as Record<string, unknown>[];
    if (missions.length === 0) return missions;
    const rollups = await readMissionStatsBatch(ctx, missions.map((m) => String(m.id)));
    return missions.map((m) => {
        const stats = rollups.get(String(m.id));
        return stats ? { ...m, stats } : m;
    });
}

/** Mission rollups — ONE batched task_stats_query. */
export async function readMissionStatsBatch(ctx: MeshContext, missionIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const ids = [...new Set(missionIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const res = await taskStatsQuery(ctx.transport, { meshId: ctx.mesh.id, missionIds: ids });
    for (const [id, rollup] of Object.entries(res.missions ?? {})) out.set(id, rollup);
    return out;
}

/** Terminal queue rows older than this count as old historical records (mesh-queue-helpers). */
export const OLD_HISTORICAL_QUEUE_RECORD_MS = 7 * 24 * 60 * 60_000;

export interface QueueActiveView {
    /** pending + assigned rows (view-projected: no input envelope). */
    activeRows: Record<string, unknown>[];
    /** Row count per status over the WHOLE mesh queue. */
    counts: Record<string, number>;
    /** Terminal rows last updated more than OLD_HISTORICAL_QUEUE_RECORD_MS ago. */
    oldHistoricalCount: number;
    /** Dependency rows the active rows point at that are not themselves active. */
    dependencyHeads: QueueDependencyHeadWire[];
}

/**
 * The compact mesh_view_queue read: active rows only, plus whole-queue counts and
 * the dependency heads the active rows reference — the historical rows (most of
 * the queue's bytes) never leave the daemon.
 */
export async function readQueueActiveView(ctx: MeshContext): Promise<QueueActiveView> {
    const res = await queueQuery(ctx.transport, {
        meshId: ctx.mesh.id,
        statuses: ['pending', 'assigned'],
        view: true,
        withCounts: true,
        historicalOlderThanMs: OLD_HISTORICAL_QUEUE_RECORD_MS,
        withDependencyHeads: true,
    });
    return {
        activeRows: res.entries as unknown as Record<string, unknown>[],
        counts: res.counts ?? {},
        oldHistoricalCount: res.oldHistoricalCount ?? 0,
        dependencyHeads: [...(res.dependencyHeads ?? [])],
    };
}
