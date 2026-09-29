// The MCP `mesh_status` tool's ONE daemon call (data-path audit 2026-09-29 P1-6).
//
// Owner principle ④: tools talk only to the coordinator daemon, which holds every
// node's latest state because members push it. So `mesh_status` asks the
// coordinator ONE question — `mesh_status_view` (daemon-core
// commands/high-family/mesh-status-view.ts) — and the daemon composes every
// input the tool reads, in-process: its held `mesh_status` (the same view the
// dashboard gets), membership, its own status, recovery contexts, active work,
// missions, the caller's pending-event drain and the polling-rate record. This
// module only READS that answer: it never reads a member, and there is no
// live-probe fallback — a remote node with nothing held is reported as such.
//
// Each part of the view is the daemon's answer to one command and is decoded by
// that command's own decoder (`decodeTurnIpcAnswer`) and mapped by the same
// helper its live read uses (toActiveWorkRead, toStatusMissionsCompact, …). The
// renderer's context carries a SEALED transport (sealMeshStatusViewTransport):
// any read it would still attempt — a remote meshCommand, or a daemon command
// the view does not carry — throws, so the tool cannot regrow a second round trip.

import { applyPendingMeshEvents, toActiveWorkRead, type ActiveWorkRead, type MeshContext } from './mesh-tools-internal.js';
import { holdMeshNodeRoutes } from './mesh-node-routes.js';
import { missionStatsIds, toStatusMissionsCompact, withMissionStats, type StatusMissionsCompact } from './mesh-daemon-reads.js';
import { decodeTurnIpcAnswer } from '../ipc/turn-commands.js';
import { decodeActiveWorkQueryResponse, decodeMissionListQueryResponse, decodeRecoveryContextQueryResponse, decodeTaskStatsQueryResponse, decodeToolCallRecordResponse, readOptionalRecord } from '@adhdev/mesh-shared';
import type { MeshToolCallRateResult } from '@adhdev/daemon-core';

interface MeshStatusViewRequest {
    refresh?: boolean;
    compact: boolean;
    includeTerminalDirect?: boolean;
    pendingEvents?: Record<string, unknown> | null;
    toolCall?: { tool: string; sessionId?: string; callerRole?: string } | null;
}

export type MeshStatusView = Record<string, any>;

/** The ONE daemon call. Throws when the coordinator cannot answer at all. */
export async function readMeshStatusView(ctx: MeshContext, request: MeshStatusViewRequest): Promise<MeshStatusView> {
    const raw = await ctx.transport.command('mesh_status_view', {
        meshId: ctx.mesh.id,
        ...(request.refresh ? { refresh: true } : {}),
        compact: request.compact,
        ...(request.includeTerminalDirect ? { includeTerminalDirect: true } : {}),
        ...(request.pendingEvents ? { pendingEvents: request.pendingEvents } : {}),
        ...(request.toolCall ? { toolCall: request.toolCall } : {}),
        // The daemon refuses when it is not the one this process believes it talks to.
        ...(ctx.localDaemonId ? { callerDaemonId: ctx.localDaemonId } : {}),
    });
    const view = readOptionalRecord(readOptionalRecord(raw)?.result) ?? readOptionalRecord(raw);
    if (!view || view.success === false) {
        throw new Error(typeof view?.error === 'string' ? view.error : 'coordinator mesh_status_view returned no view');
    }
    return view;
}

class MeshStatusViewMiss extends Error {
    constructor(what: string) {
        super(`mesh_status renders only the coordinator's view — ${what} is not part of it`);
    }
}

/**
 * The renderer's transport: it keeps the base transport's prototype (the
 * locality checks read it) but reaches nothing — every command and every remote
 * meshCommand throws. The view is the tool's only input.
 */
export function sealMeshStatusViewTransport<T extends object>(base: T): T {
    const sealed = Object.create(base) as T;
    // Own properties (never an assignment: the base may carry accessors / read-only slots).
    Object.defineProperty(sealed, 'command', {
        value: async (command: string) => { throw new MeshStatusViewMiss(command); },
    });
    Object.defineProperty(sealed, 'meshCommand', {
        value: async (daemonId: string, command: string) => { throw new MeshStatusViewMiss(`a remote ${command} to ${daemonId}`); },
    });
    return sealed;
}

/** Hold the coordinator's per-node routes (carried in the view) on the context. */
export function applyMeshStatusViewRoutes(ctx: MeshContext, view: MeshStatusView): void {
    holdMeshNodeRoutes(ctx, view.routes);
}

/**
 * The polling-rate record (`tool_call_record`). Advisory, like its live read: an
 * absent or undecodable answer reads as "not rate limited", never a failure.
 */
export function readViewToolCall(view: MeshStatusView): MeshToolCallRateResult {
    try {
        if (view.toolCall) return decodeTurnIpcAnswer('tool_call_record', view.toolCall, decodeToolCallRecordResponse);
    } catch { /* advisory */ }
    return { rateLimitExceeded: false, callsInWindow: 0, advisory: null };
}

/** Recovery context per node id (`recovery_context_query`); unreadable → none. */
export function readViewRecovery(view: MeshStatusView, nodeIds: readonly string[]): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    if (!nodeIds.some(Boolean)) return out;
    try {
        const res = decodeTurnIpcAnswer('recovery_context_query', view.recovery ?? { success: true, contexts: {} }, decodeRecoveryContextQueryResponse);
        for (const [nodeId, context] of Object.entries(res.contexts ?? {})) out.set(nodeId, context);
    } catch {
        return new Map();
    }
    return out;
}

/** Active work computed in the daemon (`active_work_query`). Throws when the view lacks it. */
export function readViewActiveWork(view: MeshStatusView): ActiveWorkRead {
    return toActiveWorkRead(decodeTurnIpcAnswer('active_work_query', view.activeWork, decodeActiveWorkQueryResponse));
}

/** Compact missions (`mission_list_query` meshStatusView=compact). Throws when absent. */
export function readViewMissionsCompact(view: MeshStatusView): StatusMissionsCompact {
    return toStatusMissionsCompact(decodeTurnIpcAnswer('mission_list_query', readOptionalRecord(view.missions)?.list, decodeMissionListQueryResponse));
}

/** Verbose missions with their stats rollups (`mission_list_query` + `task_stats_query`). */
export function readViewMissionsVerbose(view: MeshStatusView): Record<string, unknown>[] {
    const missionsView = readOptionalRecord(view.missions) ?? {};
    const res = decodeTurnIpcAnswer('mission_list_query', missionsView.list, decodeMissionListQueryResponse);
    const missions = res.missions as unknown as Record<string, unknown>[];
    if (missionStatsIds(missions).length === 0) return missions;
    return withMissionStats(missions, decodeTurnIpcAnswer('task_stats_query', missionsView.stats ?? { success: true, missions: {} }, decodeTaskStatsQueryResponse));
}

/** A local related repo's git_status, as the view carries it (absent → a per-repo error). */
export function readViewRelatedRepoGit(view: MeshStatusView, workspace: string): unknown {
    const hit = readOptionalRecord(view.relatedRepoGit)?.[workspace];
    if (hit) return hit;
    throw new MeshStatusViewMiss(`git_status(${workspace})`);
}

/** This caller's pending-event drain, as the view carries it (one inbox read). */
export function drainViewPendingEvents(ctx: MeshContext, view: MeshStatusView): any[] {
    ctx.noticeDrainCount = (ctx.noticeDrainCount ?? 0) + 1;
    return applyPendingMeshEvents(ctx, view.pendingEvents ?? { events: [] });
}
