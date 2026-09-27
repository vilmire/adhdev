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
// OLDER DAEMONS: every new request field is rejected by an older daemon's strict
// wire decoder (`request failed decode`), so each helper falls back to the
// request shape that daemon understands. No helper ever reads the daemon store
// in-process.

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

/**
 * `active_work_query` with the scheduling runtime computed from the daemon's own
 * mesh record. An older daemon requires the caller's mesh for that (it rejects
 * `includeSchedulingRuntime` without `mesh`), and a daemon that cannot resolve
 * the mesh answers without the runtime: resend with the snapshot in both cases.
 */
export async function activeWorkQueryWithRuntime(
    ctx: MeshContext,
    args: Omit<Parameters<typeof activeWorkQuery>[1], 'v' | 'meshId' | 'mesh'>,
): Promise<ActiveWorkQueryResponse> {
    const base = { meshId: ctx.mesh.id, ...args };
    if (!args.includeSchedulingRuntime) return activeWorkQuery(ctx.transport, base);
    try {
        const res = await activeWorkQuery(ctx.transport, base);
        // A daemon that could not resolve its own mesh record answers without it.
        if (res.schedulingRuntime) return res;
    } catch { /* older daemon: rejects includeSchedulingRuntime without mesh */ }
    return activeWorkQuery(ctx.transport, { ...base, mesh: ctx.mesh as unknown as Record<string, unknown> });
}

/** Recovery context per node id — ONE batched call; per-node calls on an older daemon. */
export async function readRecoveryContexts(ctx: MeshContext, nodeIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const ids = [...new Set(nodeIds.filter(Boolean))];
    if (ids.length === 0) return out;
    try {
        const res = await recoveryContextQuery(ctx.transport, { meshId: ctx.mesh.id, nodeIds: ids });
        if (res.contexts) {
            for (const [nodeId, context] of Object.entries(res.contexts)) out.set(nodeId, context);
            return out;
        }
    } catch { /* older daemon: per-node below */ }
    await Promise.all(ids.map(async (nodeId) => {
        try {
            const res = await recoveryContextQuery(ctx.transport, { meshId: ctx.mesh.id, nodeId });
            if (res.context) out.set(nodeId, res.context);
        } catch { /* best-effort — a node without context reads as zero failures */ }
    }));
    return out;
}

/** Goal preview length the compact mesh_status mission rows use (daemon-core COMPACT_STATUS_GOAL_PREVIEW_MAX). */
const COMPACT_STATUS_GOAL_PREVIEW_MAX = 80;
const LIVE_STATUSES = ['active', 'paused'] as const;

/**
 * mesh_status COMPACT missions: live rows (goal-elided) + folded history,
 * computed in the daemon. An older daemon gets the closest equivalent from the
 * plain mesh_mission_list projection (live detail + folded history; the goal
 * preview is re-trimmed to the compact length).
 */
export async function readStatusMissionsCompact(ctx: MeshContext): Promise<{ live: Record<string, unknown>[]; historyFold: Record<string, unknown> | null }> {
    try {
        const res = await missionListQuery(ctx.transport, { meshId: ctx.mesh.id, meshStatusView: 'compact' });
        return { live: res.missions as unknown as Record<string, unknown>[], historyFold: res.historyFold as unknown as Record<string, unknown> | null };
    } catch { /* older daemon */ }
    const res = await missionListQuery(ctx.transport, { meshId: ctx.mesh.id, includeMagi: true, limit: 1000 });
    const live = (res.missions as unknown as Record<string, unknown>[]).map((m) => {
        const preview = typeof m.goalPreview === 'string' ? m.goalPreview : '';
        if (preview.length <= COMPACT_STATUS_GOAL_PREVIEW_MAX) return m;
        return { ...m, goalPreview: preview.slice(0, COMPACT_STATUS_GOAL_PREVIEW_MAX), goalTruncated: true };
    }).filter((m) => (LIVE_STATUSES as readonly string[]).includes(String(m.status)));
    return { live, historyFold: res.historyFold as unknown as Record<string, unknown> | null };
}

/**
 * mesh_status VERBOSE missions: live + capped history with full goals, each with
 * its stats rollup — the rows from the daemon's projection and every rollup from
 * ONE batched task_stats_query. Older daemon: the plain list (live + 10 newest
 * history, verbose, with the daemon's own per-mission stats).
 */
export async function readStatusMissionsVerbose(ctx: MeshContext): Promise<Record<string, unknown>[]> {
    let missions: Record<string, unknown>[];
    try {
        const res = await missionListQuery(ctx.transport, { meshId: ctx.mesh.id, meshStatusView: 'verbose' });
        missions = res.missions as unknown as Record<string, unknown>[];
    } catch {
        const [live, history] = await Promise.all([
            missionListQuery(ctx.transport, { meshId: ctx.mesh.id, statuses: [...LIVE_STATUSES], verbose: true, includeMagi: true, withStats: true, limit: 1000 }),
            missionListQuery(ctx.transport, { meshId: ctx.mesh.id, statuses: ['completed', 'abandoned'], verbose: true, includeMagi: true, withStats: true, limit: 10 }),
        ]);
        return [...live.missions, ...history.missions] as unknown as Record<string, unknown>[];
    }
    if (missions.length === 0) return missions;
    const ids = missions.map((m) => String(m.id));
    const rollups = await readMissionStatsBatch(ctx, ids);
    return missions.map((m) => {
        const stats = rollups.get(String(m.id));
        return stats ? { ...m, stats } : m;
    });
}

/** Mission rollups — ONE batched task_stats_query; one call per mission on an older daemon. */
export async function readMissionStatsBatch(ctx: MeshContext, missionIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const ids = [...new Set(missionIds.filter(Boolean))];
    if (ids.length === 0) return out;
    try {
        const res = await taskStatsQuery(ctx.transport, { meshId: ctx.mesh.id, missionIds: ids });
        if (res.missions) {
            for (const [id, rollup] of Object.entries(res.missions)) out.set(id, rollup);
            return out;
        }
    } catch { /* older daemon: per-mission below */ }
    await Promise.all(ids.map(async (missionId) => {
        try {
            const { mission } = await taskStatsQuery(ctx.transport, { meshId: ctx.mesh.id, missionId, rollup: true });
            if (mission) out.set(missionId, mission);
        } catch { /* stats optional */ }
    }));
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
 * the queue's bytes) never leave the daemon. Null on an older daemon (caller
 * falls back to the full-queue read).
 */
export async function readQueueActiveView(ctx: MeshContext): Promise<QueueActiveView | null> {
    try {
        const res = await queueQuery(ctx.transport, {
            meshId: ctx.mesh.id,
            statuses: ['pending', 'assigned'],
            view: true,
            withCounts: true,
            historicalOlderThanMs: OLD_HISTORICAL_QUEUE_RECORD_MS,
            withDependencyHeads: true,
        });
        if (!res.counts) return null;
        return {
            activeRows: res.entries as unknown as Record<string, unknown>[],
            counts: res.counts,
            oldHistoricalCount: res.oldHistoricalCount ?? 0,
            dependencyHeads: [...(res.dependencyHeads ?? [])],
        };
    } catch {
        return null;
    }
}
