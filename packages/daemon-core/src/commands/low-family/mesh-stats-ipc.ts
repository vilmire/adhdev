/**
 * mesh-stats-ipc — daemon-side responders for the task/mission-stats,
 * prune-audit and orphaned-pin IPC commands through which the mcp-server
 * reaches this daemon's `mesh-runtime.db` instead of opening it in-process.
 *
 * Sibling of `mesh-store-ipc.ts`; same envelope and registration convention —
 * merged into `turnLedgerIpcHandlers` (turn-ledger-ipc.ts).
 *
 * Wire contract: `@adhdev/mesh-shared` `turn-ipc-stats.ts`.
 */

import {
    decodeOrphanedPinNotifyRequest,
    decodePruneStaleDirectRequest,
    decodeTaskStatsQueryRequest,
    type OrphanedPinNotifyResponse,
    type PruneStaleDirectResponse,
    type TaskStatsQueryResponse,
} from '@adhdev/mesh-shared';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { computeMeshMissionStatsBatch, computeMeshTaskStats, rollupMissionStats } from '../../mesh/mesh-task-stats.js';
import { pruneStaleDirectDispatches } from '../../mesh/mesh-active-work.js';
import { getActiveDirectDispatches, getQueue } from '../../mesh/mesh-work-queue.js';
import { readLocalRecords } from '../../mesh/mesh-local-records.js';
import { notifyCoordinatorOfOrphanedPins } from '../../mesh/mesh-orphaned-pin-notify.js';

function badRequest(command: string): { success: false; error: string } {
    return { success: false, error: `${command}: request failed decode (bad shape)` };
}

function failure(e: unknown): { success: false; error: string } {
    return { success: false, error: (e as any)?.message ?? String(e) };
}

// ─── task_stats_query ───────────────────────────────────────────────────────

const taskStatsQuery: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeTaskStatsQueryRequest(args);
    if (!req) return badRequest('task_stats_query');
    try {
        // Batch rollups (mesh_status verbose): ONE queue read + ONE record read for
        // every mission, instead of one full round (twice over) per mission.
        if (req.missionIds) {
            const rollups = computeMeshMissionStatsBatch(req.meshId, req.missionIds, req.tail !== undefined ? { tail: req.tail } : undefined);
            const missions: Record<string, Record<string, unknown>> = {};
            for (const [missionId, rollup] of rollups) missions[missionId] = rollup as unknown as Record<string, unknown>;
            const response: TaskStatsQueryResponse = { tasks: [], missions };
            return { success: true, ...response };
        }
        const tasks = computeMeshTaskStats(req.meshId, {
            ...(req.taskIds ? { taskIds: [...req.taskIds] } : {}),
            ...(req.missionId ? { missionId: req.missionId } : {}),
            ...(req.tail !== undefined ? { tail: req.tail } : {}),
        });
        const response: TaskStatsQueryResponse = { tasks: tasks as unknown as Record<string, unknown>[] };
        if (req.rollup && req.missionId) {
            try {
                // Default window: the rollup of exactly the per-task list above (same
                // queue + record window) — was a second, identical computeMeshTaskStats
                // pass. A caller-sized `tail` keeps the rollup on its default window.
                const rollup = req.tail === undefined
                    ? rollupMissionStats(req.missionId, tasks)
                    : computeMeshMissionStatsBatch(req.meshId, [req.missionId]).get(req.missionId);
                if (rollup) response.mission = rollup as unknown as Record<string, unknown>;
            } catch { /* rollup is an enhancement — the per-task stats still return */ }
        }
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── prune_stale_direct ─────────────────────────────────────────────────────

const pruneStaleDirect: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodePruneStaleDirectRequest(args);
    if (!req) return badRequest('prune_stale_direct');
    try {
        const queue = getQueue(req.meshId);
        const directDispatches = getActiveDirectDispatches(req.meshId);
        const ledgerEntries = readLocalRecords(req.meshId, { tail: 500 });
        const result = await pruneStaleDirectDispatches({
            meshId: req.meshId,
            queue,
            ledgerEntries,
            directDispatches,
            nodes: [],
            execute: req.execute === true,
            includeTerminal: req.includeTerminal === true,
            source: req.source || 'mesh_prune_stale_direct',
            // No closeDispatches override: this handler runs IN the daemon that owns
            // the turn ledger, so the default `cancelDirectDispatchAttempts` (this
            // process's ledger — the same core the daemon reconcile-loop auto-prune
            // already uses) is exactly right; the mcp-server's own closure existed
            // only to reach that ledger over `turn_cancel` IPC, which is now moot.
        });
        const response: PruneStaleDirectResponse = {
            mode: result.mode,
            includeTerminal: result.includeTerminal,
            candidateCount: result.candidateCount,
            prunable: result.prunable as unknown as Record<string, unknown>[],
            prunedCount: result.prunedCount,
            preservedUnacknowledged: result.preservedUnacknowledged as unknown as Record<string, unknown>[],
            preservedLedgerOnly: result.preservedLedgerOnly as unknown as Record<string, unknown>[],
            preservedNotOrphan: result.preservedNotOrphan as unknown as Record<string, unknown>[],
        };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── orphaned_pin_notify ────────────────────────────────────────────────────

const orphanedPinNotify: LowFamilyHandler = async (_ctx: LowFamilyContext, args: any) => {
    const req = decodeOrphanedPinNotifyRequest(args);
    if (!req) return badRequest('orphaned_pin_notify');
    try {
        const orphans = notifyCoordinatorOfOrphanedPins(req.meshId, req.stoppedSessionId, {
            ...(req.excludeTaskId ? { excludeTaskId: req.excludeTaskId } : {}),
            ...(req.cause ? { cause: req.cause } : {}),
            ...(req.nodeId ? { nodeId: req.nodeId } : {}),
            ...(req.coordinatorSessionId ? { coordinatorSessionId: req.coordinatorSessionId } : {}),
        });
        const response: OrphanedPinNotifyResponse = { orphans: orphans as unknown as OrphanedPinNotifyResponse['orphans'] };
        return { success: true, ...response };
    } catch (e) {
        return failure(e);
    }
};

// ─── registration (merged into turnLedgerIpcHandlers by turn-ledger-ipc.ts) ─

export const meshStatsIpcHandlers: Record<string, LowFamilyHandler> = {
    task_stats_query: taskStatsQuery,
    prune_stale_direct: pruneStaleDirect,
    orphaned_pin_notify: orphanedPinNotify,
};
