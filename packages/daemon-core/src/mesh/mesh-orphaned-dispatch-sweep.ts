// Host housekeeping backstop for old assignments whose session is confirmed gone.
// Open attempts stay ledger-owned and receive a forced probe (including suspended
// workers). Missing or terminal attempt references have no reclaim owner: fail the
// row once, retain its instruction/dependencies/history, and notify the coordinator
// to recover the same id with an explicit force-requeue. Unknown presence never
// convicts, and live sessions keep their assignment and node write slot.

import type { DaemonComponents } from '../boot/daemon-components.js';
import { LOG } from '../logging/logger.js';
import { getMachineId } from '../config/config.js';
import { meshNodeIdMatches, readText, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { failOrphanedUncorrelatedDispatch } from './mesh-work-queue.js';
import { meshRecord } from './mesh-record.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { resolveDeadTargetVerdict } from './mesh-skip-notify.js';
import { isLocalAutoLaunchNode } from './mesh-candidacy-predicates.js';
import { readMeshNodeDaemonId } from './mesh-node-identity.js';
import { readLiveHeldRuntime } from './mesh-node-git-refresher.js';
import { HELD_ABSENCE_MARGIN_MS } from './turn-ledger/probe.js';
import { getMeshWithCache } from './mesh-queue-mesh-view.js';

/** The terminal reason (leading machine code — it is also the notice's reason code). */
export const ORPHANED_UNCORRELATED_DISPATCH_REASON = 'orphaned_uncorrelated_dispatch';

/**
 * Minimum age of an attempt-less `assigned` row before it may be failed. Shared
 * with mcp-server's mesh_view_queue stale-assigned mark (mesh-queue-helpers.ts),
 * so the row the view flags is the row this sweep reclaims.
 */
export const STALE_ASSIGNED_QUEUE_MS = 30 * 60_000;

/** Whether an assigned row's session is live on its node. Only `not_live` convicts. */
export type AssignedSessionLiveness = 'live' | 'not_live' | 'unknown';

/** True when the row carries no turn-ledger attempt (the turn ledger does not own it). */
export function isUncorrelatedAssignedRow(row: Pick<MeshWorkQueueEntry, 'status' | 'attemptId'>): boolean {
    return row.status === 'assigned' && !readText(row.attemptId);
}

function rowNodeId(row: MeshWorkQueueEntry): string {
    return readText(row.assignedNodeId) || readText(row.targetNodeId);
}

function rowSessionId(row: MeshWorkQueueEntry): string {
    return readText(row.assignedSessionId) || readText(row.targetSessionId);
}

/**
 * Liveness of an assigned row's session, from what this host daemon can PROVE:
 *   - node absent from the live mesh → the dead-target membership predicate;
 *   - LOCAL session → registry/instance presence protects it; only a successful
 *     complete instance list can prove absence;
 *   - session on a REMOTE node → the coordinator-held runtime the member pushes
 *     (the turn probe's only remote presence source): listed → `live`; absent from
 *     a complete list observed after the row's last update → `not_live`;
 *     anything else → `unknown`.
 */
export function resolveAssignedSessionLiveness(
    components: DaemonComponents,
    meshId: string,
    mesh: any,
    row: MeshWorkQueueEntry,
): AssignedSessionLiveness {
    const nodeId = rowNodeId(row);
    const sessionId = rowSessionId(row);
    // An assigned row with no session has nothing that could be live.
    if (!sessionId) return 'not_live';
    if (!mesh) return 'unknown';
    const dead = resolveDeadTargetVerdict(components, meshId, mesh, { ...row, targetNodeId: nodeId || undefined, targetSessionId: sessionId });
    if (dead.nodeDead) return 'not_live';
    const node = nodeId && Array.isArray(mesh?.nodes) ? mesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId)) : undefined;
    if (!node) return 'unknown';
    if (isLocalAutoLaunchNode(node)) {
        // The dead-target predicate folds failed observations into UNKNOWN.
        // Recovery needs a complete successful list, not that ambiguity. Registry
        // presence also protects workers outside the CLI category.
        try {
            if (components.sessionRegistry?.has(sessionId)
                || components.instanceManager?.getInstance?.(sessionId)) return 'live';
            if (typeof components.instanceManager?.getByCategory !== 'function') return 'unknown';
            const instances = components.instanceManager.getByCategory('cli');
            if (!Array.isArray(instances)) return 'unknown';
            return instances.some((instance) => sessionIdsEquivalent(readText(instance.getState()?.instanceId), sessionId))
                ? 'live' : 'not_live';
        } catch { return 'unknown'; }
    }
    const daemonId = readMeshNodeDaemonId(node);
    if (!daemonId) return 'unknown';
    const held = readLiveHeldRuntime(components.router?.meshNodeGitState, { meshId, nodeId, daemonId });
    if (!held) return 'unknown';
    const listed = held.runtime.sessions.some((s: { id?: string; sessionId?: string; instanceId?: string }) =>
        [s.id, s.sessionId, s.instanceId].some((id) => !!readText(id) && sessionIdsEquivalent(readText(id), sessionId)));
    if (listed) return 'live';
    const rowUpdatedMs = Date.parse(row.updatedAt || row.createdAt || '');
    const complete = !held.runtime.sessionsTruncated;
    const observedAfterRow = Number.isFinite(rowUpdatedMs) && held.observedAt > rowUpdatedMs + HELD_ABSENCE_MARGIN_MS;
    return complete && observedAfterRow ? 'not_live' : 'unknown';
}

export interface OrphanedDispatchSweepDeps {
    liveness(row: MeshWorkQueueEntry): AssignedSessionLiveness;
    now?: number;
    minAgeMs?: number;
    /** Force the ledger to probe an owned row, including a suspended worker. */
    requestProbe?(attemptId: string): void;
}

function notifyOrphanedDispatchFailed(meshId: string, row: MeshWorkQueueEntry): void {
    const taskId = row.id;
    const nodeId = rowNodeId(row);
    const sessionId = rowSessionId(row);
    const coordinatorMessage = `[System] A mesh task was stuck 'assigned' with no open delivery attempt behind it and has been marked FAILED (${ORPHANED_UNCORRELATED_DISPATCH_REASON}).\n`
        + `Task ${taskId}${nodeId ? ` on node ${nodeId}` : ''}${sessionId ? ` (session ${sessionId})` : ''} was recorded as dispatched, but no open turn-ledger attempt owns it, `
        + 'and its session is no longer live — so no completion can arrive and nothing would ever release it. '
        + `While it sat 'assigned' it counted as an active assignment on its node and could block auto-launch there.\n`
        + 'Check mesh_task_history / git, then use mesh_requeue_task with this task_id and force:true if recovery is needed. This preserves the original instruction, dependencies and retry history. The failed row remains the audit record.';
    try {
        const targetCoordinatorDaemonId = readText(getMachineId());
        const targetCoordinatorSessionId = readText(row.sourceCoordinatorSessionId);
        notifyMeshCoordinator({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel: nodeId || meshId,
            ...(nodeId ? { nodeId } : {}),
            // Stable: one notice per row, ever — a re-run of the sweep cannot double-page.
            eventId: `${ORPHANED_UNCORRELATED_DISPATCH_REASON}:${meshId}:${taskId}`,
            metadataEvent: {
                source: 'mesh_orphaned_dispatch_sweep',
                taskId,
                reason: ORPHANED_UNCORRELATED_DISPATCH_REASON,
                ...(sessionId ? { sessionId } : {}),
                coordinatorMessage,
            },
            coordinatorMessage,
            queuedAt: Date.now(),
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to surface orphaned-dispatch failure for task ${taskId} (mesh ${meshId}): ${e?.message || e}`);
    }
}

/**
 * One sweep over a mesh's old `assigned` rows. Returns the rows it failed.
 * Open attempts are probed by their ledger; dangling/terminal references have
 * no reclaim owner and follow the same audited failure path as attempt-less rows.
 */
export function sweepOrphanedUncorrelatedDispatches(meshId: string, deps: OrphanedDispatchSweepDeps): MeshWorkQueueEntry[] {
    const now = deps.now ?? Date.now();
    const minAgeMs = deps.minAgeMs ?? STALE_ASSIGNED_QUEUE_MS;
    const failed: MeshWorkQueueEntry[] = [];
    const rows = MeshRuntimeStore.getInstance().getQueueEntries(meshId, ['assigned']);
    for (const row of rows) {
        const attemptId = readText(row.attemptId);
        const attempt = attemptId ? MeshRuntimeStore.getInstance().turnStore().getAttempt(attemptId) : null;
        // Age from the row's last update. A future-dated or unparseable stamp
        // (foreign clock) is not old — never convict on it.
        const updatedMs = Date.parse(row.updatedAt || row.createdAt || '');
        if (!Number.isFinite(updatedMs) || now - updatedMs < minAgeMs) continue;
        let liveness: AssignedSessionLiveness;
        try { liveness = deps.liveness(row); } catch { liveness = 'unknown'; }
        if (liveness !== 'not_live') continue;
        if (attempt && !attempt.terminal) {
            // The ledger owns cancellation, generation fencing and its bounded
            // reclaim budget. A suspended attempt otherwise has no due probe.
            deps.requestProbe?.(attemptId);
            continue;
        }
        const entry = failOrphanedUncorrelatedDispatch(meshId, row.id, ORPHANED_UNCORRELATED_DISPATCH_REASON,
            attemptId ? { orphanedAttemptId: attemptId } : undefined);
        if (!entry) continue;
        failed.push(entry);
        const nodeId = rowNodeId(row);
        const sessionId = rowSessionId(row);
        meshRecord(meshId, 'task_failed', {
            taskId: row.id,
            ...(nodeId ? { nodeId } : {}),
            ...(sessionId ? { sessionId } : {}),
            payload: {
                taskId: row.id,
                reason: ORPHANED_UNCORRELATED_DISPATCH_REASON,
                source: 'mesh_orphaned_dispatch_sweep',
                ageMs: now - updatedMs,
            },
        }, { local: true });
        LOG.warn('MeshQueue', `ORPHANED-DISPATCH: task ${row.id} (mesh ${meshId}) was 'assigned' with no open turn-ledger attempt and its session ${sessionId || '(none)'} is not live on node ${nodeId || '(none)'}; failed it (${ORPHANED_UNCORRELATED_DISPATCH_REASON}).`);
        notifyOrphanedDispatchFailed(meshId, row);
    }
    return failed;
}

/** The housekeeping entry point: the sweep with the components-backed liveness. */
export function runOrphanedDispatchSweep(components: DaemonComponents, meshId: string, now: number = Date.now()): MeshWorkQueueEntry[] {
    let mesh: any;
    return sweepOrphanedUncorrelatedDispatches(meshId, {
        now,
        requestProbe: (attemptId) => components.turnScheduler?.requestProbe(attemptId),
        liveness: (row) => {
            if (mesh === undefined) mesh = getMeshWithCache(components, meshId) ?? null;
            return resolveAssignedSessionLiveness(components, meshId, mesh, row);
        },
    });
}
