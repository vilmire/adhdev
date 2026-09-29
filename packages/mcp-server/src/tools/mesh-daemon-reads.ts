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
import { activeWorkQuery, queueQuery } from '../ipc/turn-commands.js';
import type { ActiveWorkQueryResponse, MissionListQueryResponse, QueueDependencyHeadWire, TaskStatsQueryResponse } from '@adhdev/mesh-shared';

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

export type StatusMissionsCompact = { live: Record<string, unknown>[]; historyFold: Record<string, unknown> | null };

/** The compact mesh_status missions of a `mission_list_query` answer. */
export function toStatusMissionsCompact(res: MissionListQueryResponse): StatusMissionsCompact {
    return { live: res.missions as unknown as Record<string, unknown>[], historyFold: res.historyFold as unknown as Record<string, unknown> | null };
}

/** Attach each mission's stats rollup (a `task_stats_query` answer) to its row. */
export function withMissionStats(missions: Record<string, unknown>[], stats: TaskStatsQueryResponse): Record<string, unknown>[] {
    const rollups = new Map(Object.entries(stats.missions ?? {}));
    return missions.map((m) => {
        const rollup = rollups.get(String(m.id));
        return rollup ? { ...m, stats: rollup } : m;
    });
}

/** The mission ids a stats rollup is asked for (none → no task_stats_query). */
export function missionStatsIds(missions: Record<string, unknown>[]): string[] {
    return [...new Set(missions.map((m) => String(m.id)).filter(Boolean))];
}

/** Terminal queue rows older than this count as old historical records (mesh-queue-helpers). */
export const OLD_HISTORICAL_QUEUE_RECORD_MS = 7 * 24 * 60 * 60_000;

interface QueueActiveView {
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
