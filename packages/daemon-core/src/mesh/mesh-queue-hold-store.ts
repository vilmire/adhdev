import { createHash } from 'crypto';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { isUnclaimableAsDeclared, queueHoldContext, queueTaskHoldView, setQueueTaskHold, QUEUE_HOLD_NOTICE_AFTER_MS } from './mesh-queue-hold.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { isDifficultyFloorWaitReason } from './mesh-difficulty-floor.js';
import { resolvePathOwnershipGate } from './mesh-path-ownership-gate.js';
import { getMachineId } from '../config/config.js';
import { isQuotaGateHoldReason, quotaHoldCoordinatorMessage, readQuotaGateEvidence } from './mesh-quota-override.js';

function persistHold(store: MeshRuntimeStore, task: MeshWorkQueueEntry): void {
    store.db.prepare("UPDATE mesh_queue SET payload = ? WHERE mesh_id = ? AND id = ? AND status = 'pending'").run(JSON.stringify(task), task.meshId, task.id);
    store.maybeCheckpointWal();
}

/** Called at the skip decision, including when the historical autoLaunch field is protected. */
export function recordQueueTaskHold(meshId: string, taskId: string, reason: string, nodeId?: string, preserveExisting = false): void {
    const store = MeshRuntimeStore.getInstance();
    store.transaction(() => {
        const task = store.findQueueEntryById(meshId, taskId);
        if (!task || task.status !== 'pending' || (preserveExisting && task.hold)) return;
        // Path-ownership holds exist only when the opt-in gate is on.
        if ((reason === 'owned_paths_conflict' || reason === 'ownership_unproven') && resolvePathOwnershipGate(meshId) === 'off') return;
        // Same active-writer set admission uses (assignedRowsMeshWide includes stopping
        // exclusive writers whose queue status may already be terminal) plus pending rows
        // for launch reservations / dependency titles — not a pending+assigned-only copy.
        const writers = store.assignedRowsMeshWide(meshId).map(row => JSON.parse(row.payload) as MeshWorkQueueEntry);
        const pending = store.getQueueEntries(meshId, ['pending']);
        const queue = [...writers, ...pending.filter(p => !writers.some(w => w.id === p.id))];
        const context = queueHoldContext(task, reason, queue, nodeId);
        if (reason === 'dependencies_unsatisfied') {
            const completed = new Set(store.getQueueHeads(meshId, ['completed']).map(head => head.id));
            context.blockingTaskIds = (task.dependsOn || []).filter(id => !completed.has(id));
        }
        const before = JSON.stringify(task.hold);
        setQueueTaskHold(task, reason, context);
        if (before === JSON.stringify(task.hold)) return;
        persistHold(store, task);
    });
}

/**
 * Short, order-independent digest of the blocking task ids. The event id becomes a
 * `turn.notify` topic identifier (<=256 chars); embedding the full id list overflowed
 * it once a task was blocked by ~7+ others and the mesh publisher refused the entry.
 */
/** Event ids are published and must stay identifier-shaped; a free-form reason (quota detail) goes in as a digest. */
export function holdReasonIdPart(reason: string): string {
    if (/^[\w.-]+$/.test(reason)) return reason;
    const family = /^[\w.-]+/.exec(reason)?.[0] ?? 'reason';
    return `${family}-${createHash('sha1').update(reason).digest('hex').slice(0, 12)}`;
}

export function blockerDigest(ids: readonly string[]): string {
    if (ids.length === 0) return 'none';
    return `${ids.length}-${createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 12)}`;
}

/** Uses the existing coordinator notice/ledger path (pendingCoordinatorEvents), no new RPC. */
export function notifyHeldQueueTasks(meshId: string, now = Date.now()): void {
    const store = MeshRuntimeStore.getInstance();
    const queue = store.getQueueEntries(meshId, ['pending', 'assigned']);
    for (const snapshot of queue) {
        const view = queueTaskHoldView(snapshot, queue, now);
        // A path-ownership hold persisted before the gate went opt-in (or while it was on) is stale when it is off.
        if ((view?.reason === 'owned_paths_conflict' || view?.reason === 'ownership_unproven') && resolvePathOwnershipGate(meshId) === 'off') continue;
        const unclaimable = isUnclaimableAsDeclared(view);
        if (!view || (!unclaimable && view.ageMs < QUEUE_HOLD_NOTICE_AFTER_MS) || snapshot.holdNoticeId) continue;
        // Floor-wait holds already have their own bounded-wait pager with a double
        // debounce (handleDifficultyFloorSkip, 10 min); paging them again here after
        // 3 min would duplicate that notice for the same stuck task. The hold itself
        // stays recorded for status/dashboard visibility — only the page is skipped.
        // 'difficulty_floor_unmet' is the claim path's literal for the same condition.
        // A quota hold shares the floor-wait family for the auto-launch clock, but its pager used the
        // difficulty-floor wording and never fired at 3 min — it is paged here, with quota wording.
        if ((isDifficultyFloorWaitReason(view.reason) && !isQuotaGateHoldReason(view.reason)) || view.reason === 'difficulty_floor_unmet') continue;
        store.transaction(() => {
            const task = store.findQueueEntryById(meshId, snapshot.id);
            if (!task || task.status !== 'pending' || task.holdNoticeId || JSON.stringify(task.hold) !== JSON.stringify(snapshot.hold)) return;
            const eventId = `queue-hold:${meshId}:${task.id}:${view.since}:${holdReasonIdPart(view.reason)}:${blockerDigest(view.blockingTaskIds)}`;
            const blockers = view.blockingTasks.map(b => `${b.taskId} (${b.title})`).join(', ');
            const coordinatorMessage = isQuotaGateHoldReason(view.reason)
                ? quotaHoldCoordinatorMessage(task, view.reason, view.ageMs, readQuotaGateEvidence(meshId, task.id))
                : unclaimable
                    ? `[System] Queue task ${task.id} cannot be claimed as declared: ${view.reason}. Waiting will not clear it; revise its owned_paths (mesh_queue_revise). ${JSON.stringify(view.detail)}`
                    : `[System] Queue task ${task.id} has been held for ${Math.floor(view.ageMs / 60_000)} min: ${view.reason}${blockers ? ` by ${blockers}` : ''}. ${JSON.stringify(view.detail)}`;
            if (notifyMeshCoordinator({
                event: 'mesh:queue_held', meshId, eventId, nodeLabel: meshId,
                coordinatorMessage, queuedAt: now,
                targetCoordinatorDaemonId: getMachineId(),
                ...(task.sourceCoordinatorSessionId ? { targetCoordinatorSessionId: task.sourceCoordinatorSessionId } : {}),
                metadataEvent: { source: 'mesh_queue_hold', taskId: task.id, hold: view, coordinatorMessage },
            })) {
                task.holdNoticeId = eventId;
                persistHold(store, task);
            }
        });
    }
}
