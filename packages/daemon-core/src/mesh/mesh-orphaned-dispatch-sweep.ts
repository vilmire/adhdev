// ---------------------------------------------------------------------------
// mesh-orphaned-dispatch-sweep — reclaim `assigned` rows no turn-ledger attempt owns
// ---------------------------------------------------------------------------
// Live case (preview mesh, task 14147d9b, 2026-10-06): a direct dispatch
// (`mesh_send_task`) whose `dispatch_accepted` the turn ledger REFUSED still sent
// and materialised its queue row as `assigned` with no `attemptId`. Reclaim is
// turn-ledger-only (attempts + holds, turn-ledger/scheduler.ts), so nothing ever
// moved that row: it stayed `assigned` for days and — because
// `nodeHasActiveWriteAssignment` / the claim-side `hasActiveNodeWriteAssignment`
// count every assigned WRITE row — blocked write autolaunch on its node with
// `node_has_active_assignment`. mcp-server's `staleAssigned` mark on
// mesh_view_queue saw it but is display-only.
//
// This housekeeping step (host daemon only — it runs per HOSTED mesh, and the
// queue write itself asserts host ownership) fails such a row when ALL hold:
//   - no `attemptId` (a row WITH one belongs to the turn ledger — never touched);
//   - older than ORPHANED_UNCORRELATED_DISPATCH_MIN_AGE_MS (the same 30 min
//     mesh_view_queue uses for its stale-assigned mark);
//   - its assigned session is provably NOT live on its node. "Unknown" (remote
//     member not pushing, list truncated, peer down) never convicts.
// Each failed row gets one `task_failed` mesh record and one coordinator notice
// (stable eventId → a re-run cannot double-page). Idempotent: the queue write
// re-checks `assigned` + no attempt under the queue lock.
// ---------------------------------------------------------------------------

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
 *   - node absent from the live mesh / session absent on a LOCAL node →
 *     `resolveDeadTargetVerdict` (the dead-target self-heal's predicate, applied
 *     to the row's assigned address) says dead → `not_live`;
 *   - session on a REMOTE node → the coordinator-held runtime the member pushes
 *     (the turn probe's only remote presence source): listed → `live`; absent from
 *     a complete, non-empty list observed after the row's last update → `not_live`;
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
    if (dead.dead) return 'not_live';
    const node = nodeId && Array.isArray(mesh?.nodes) ? mesh.nodes.find((n: any) => meshNodeIdMatches(n, nodeId)) : undefined;
    if (!node || isLocalAutoLaunchNode(node)) {
        // Local (or node-less): resolveDeadTargetVerdict already checked local
        // absence; reaching here means the session is present (or the node is
        // transiently unresolved) — never convict.
        return node ? 'live' : 'unknown';
    }
    const daemonId = readMeshNodeDaemonId(node);
    if (!daemonId) return 'unknown';
    const held = readLiveHeldRuntime(components.router?.meshNodeGitState, { meshId, nodeId, daemonId });
    if (!held) return 'unknown';
    const listed = held.runtime.sessions.some((s: { id?: string; sessionId?: string; instanceId?: string }) =>
        [s.id, s.sessionId, s.instanceId].some((id) => !!readText(id) && sessionIdsEquivalent(readText(id), sessionId)));
    if (listed) return 'live';
    const rowUpdatedMs = Date.parse(row.updatedAt || row.createdAt || '');
    const complete = !held.runtime.sessionsTruncated && held.runtime.sessions.length > 0;
    const observedAfterRow = Number.isFinite(rowUpdatedMs) && held.observedAt > rowUpdatedMs + HELD_ABSENCE_MARGIN_MS;
    return complete && observedAfterRow ? 'not_live' : 'unknown';
}

export interface OrphanedDispatchSweepDeps {
    liveness(row: MeshWorkQueueEntry): AssignedSessionLiveness;
    now?: number;
    minAgeMs?: number;
}

function notifyOrphanedDispatchFailed(meshId: string, row: MeshWorkQueueEntry): void {
    const taskId = row.id;
    const nodeId = rowNodeId(row);
    const sessionId = rowSessionId(row);
    const coordinatorMessage = `[System] A mesh task was stuck 'assigned' with no delivery attempt behind it and has been marked FAILED (${ORPHANED_UNCORRELATED_DISPATCH_REASON}).\n`
        + `Task ${taskId}${nodeId ? ` on node ${nodeId}` : ''}${sessionId ? ` (session ${sessionId})` : ''} was recorded as dispatched, but no turn-ledger attempt was ever opened for it, `
        + 'and its session is no longer live — so no completion can arrive and nothing would ever release it. '
        + `While it sat 'assigned' it counted as an active assignment on its node and could block auto-launch there.\n`
        + 'Check whether the work actually happened (mesh_task_history / git); if it still matters, re-send it with mesh_send_task or mesh_enqueue_task. The failed row stays in the queue as the audit record.';
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
 * One sweep over a mesh's attempt-less `assigned` rows. Returns the rows it failed.
 * Rows with an `attemptId` are skipped before liveness is even asked.
 */
export function sweepOrphanedUncorrelatedDispatches(meshId: string, deps: OrphanedDispatchSweepDeps): MeshWorkQueueEntry[] {
    const now = deps.now ?? Date.now();
    const minAgeMs = deps.minAgeMs ?? STALE_ASSIGNED_QUEUE_MS;
    const failed: MeshWorkQueueEntry[] = [];
    const rows = MeshRuntimeStore.getInstance().getQueueEntries(meshId, ['assigned']);
    for (const row of rows) {
        if (!isUncorrelatedAssignedRow(row)) continue;
        // Age from the row's last update. A future-dated or unparseable stamp
        // (foreign clock) is not old — never convict on it.
        const updatedMs = Date.parse(row.updatedAt || row.createdAt || '');
        if (!Number.isFinite(updatedMs) || now - updatedMs < minAgeMs) continue;
        let liveness: AssignedSessionLiveness;
        try { liveness = deps.liveness(row); } catch { liveness = 'unknown'; }
        if (liveness !== 'not_live') continue;
        const entry = failOrphanedUncorrelatedDispatch(meshId, row.id, ORPHANED_UNCORRELATED_DISPATCH_REASON);
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
        LOG.warn('MeshQueue', `ORPHANED-DISPATCH: task ${row.id} (mesh ${meshId}) was 'assigned' with no turn-ledger attempt and its session ${sessionId || '(none)'} is not live on node ${nodeId || '(none)'}; failed it (${ORPHANED_UNCORRELATED_DISPATCH_REASON}).`);
        notifyOrphanedDispatchFailed(meshId, row);
    }
    return failed;
}

/** The housekeeping entry point: the sweep with the components-backed liveness. */
export function runOrphanedDispatchSweep(components: DaemonComponents, meshId: string, now: number = Date.now()): MeshWorkQueueEntry[] {
    let mesh: any;
    return sweepOrphanedUncorrelatedDispatches(meshId, {
        now,
        liveness: (row) => {
            if (mesh === undefined) mesh = getMeshWithCache(components, meshId) ?? null;
            return resolveAssignedSessionLiveness(components, meshId, mesh, row);
        },
    });
}
