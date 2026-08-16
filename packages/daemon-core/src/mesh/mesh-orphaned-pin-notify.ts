import { LOG } from '../logging/logger.js';
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getQueue } from './mesh-work-queue.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { loadConfig } from '../config/config.js';

// ---------------------------------------------------------------------------
// CANCEL-ORPHANS-PINNED-TASK: stopping a worker session strands every OTHER queue
// task hard-pinned to that same session.
//
// The live incident (reproduced in this mesh, 2026-08-16):
//   1. Task A is dispatched to worker session S → S goes generating.
//   2. Task B is sent to the SAME session while it is busy. mesh_send_task's
//      busy-session branch (mesh-tools-session.ts) enqueues B pinned to S with
//      targetSessionId=S, promising in its own nextAction that it "auto-delivers
//      the moment the session goes idle — no manual resend needed".
//   3. The coordinator cancels A. mesh_queue_cancel propagates a worker stop, and
//      `stop` is a HARD stop: CliManager.stopSession deletes the adapter and calls
//      instanceManager.removeInstance — session S ceases to exist.
//   4. B is now pinned to a session that can never go idle because it can never
//      exist again. The claim gate refuses every non-matching session, so B sits
//      'pending' behind `autoLaunch: { status: 'skipped', reason:
//      'target_session_constraint' }` — undeliverable AND un-launchable.
//
// Observed live: 12 minutes with zero generating sessions before a human noticed.
//
// Why the EXISTING self-heal did not cover it. Two coordinator-side backstops
// already exist in mesh-queue-assignment.ts and both are deliberately slow:
//   - DEAD-TARGET-SELFHEAL requires DEAD_TARGET_GRACE_MS (60s) AND a *provable*
//     death. Proof comes from resolveSessionBusyVerdict, which reads the LOCAL
//     instance manager only; for a pin on a REMOTE node the verdict is UNKNOWN by
//     design (absence from the remote-idle mirror is not death), so the verdict
//     never turns 'dead' at all.
//   - TARGET_SESSION_PIN_TTL_MS is 15 minutes.
// Both are correct as backstops: they must never race a healthy reconnect, so
// they infer death from silence. The cancel path does not have to infer anything —
// it is the actor. It just stopped a *named* session, synchronously, and it owns
// the queue. This module turns that certainty into an immediate notification
// instead of waiting out a timer sized for a guess.
//
// Detection lives HERE (a shared helper) rather than inline in the cancel tool so
// any other coordinator-side path that knowingly kills a named session can reuse
// it. It deliberately does NOT live in CliManager.stopSession: the mesh work queue
// is stored in the COORDINATOR daemon's MeshRuntimeStore, while stopSession runs on
// the WORKER daemon. For a remote worker (the common mesh topology) the queue is
// simply not visible there, so a chokepoint at that level would silently cover only
// the co-located case while appearing to cover all of them. See
// `docs/guides/REPO_MESH_GUIDE.md` for the coordinator/worker split.
// ---------------------------------------------------------------------------

/** A pending queue task left undeliverable because its pinned session was stopped. */
export interface OrphanedPinnedTask {
    taskId: string;
    /** Short title derived from the task message, for the coordinator notification. */
    title: string;
    targetSessionId: string;
    targetNodeId?: string;
    missionId?: string;
}

/** Cap the number of orphans named in one notification so the message stays readable. */
const MAX_LISTED_ORPHANS = 5;

/** First line of the task message, trimmed to a readable label. */
function titleForTask(task: MeshWorkQueueEntry): string {
    const raw = readNonEmptyString((task as { message?: string }).message) || '';
    const firstLine = raw.split('\n').map(s => s.trim()).find(Boolean) || '(no message)';
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

/**
 * Find every PENDING queue task hard-pinned to `stoppedSessionId`, excluding the task
 * whose cancellation caused the stop.
 *
 * Only 'pending' rows can be orphaned this way: an 'assigned' row is already claimed
 * (its own stop/reclaim path handles it) and a terminal row needs no delivery.
 *
 * Session ids are compared through sessionIdsEquivalent rather than a raw `===`. Note
 * that for SESSION ids that predicate is exact-match-after-trim — unlike daemon/node ids,
 * a session id is single-form (one canonical UUID carried verbatim across daemons), so
 * there is no multi-form skew to normalize here. Routing through the shared predicate is
 * still the rule in this repo: it keeps that single-form policy in one place and gives any
 * future session-id aliasing a single seam.
 */
export function findTasksOrphanedBySessionStop(
    meshId: string,
    stoppedSessionId: string,
    opts?: { excludeTaskId?: string },
): OrphanedPinnedTask[] {
    const sessionId = readNonEmptyString(stoppedSessionId);
    if (!sessionId) return [];
    let queue: MeshWorkQueueEntry[];
    try {
        queue = getQueue(meshId, { status: ['pending'] });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Orphan-pin scan failed to read queue for mesh ${meshId}: ${e?.message || e}`);
        return [];
    }
    const excludeTaskId = readNonEmptyString(opts?.excludeTaskId);
    const orphans: OrphanedPinnedTask[] = [];
    for (const task of queue) {
        if (excludeTaskId && task.id === excludeTaskId) continue;
        const pin = readNonEmptyString(task.targetSessionId);
        if (!pin || !sessionIdsEquivalent(pin, sessionId)) continue;
        orphans.push({
            taskId: task.id,
            title: titleForTask(task),
            targetSessionId: pin,
            ...(readNonEmptyString(task.targetNodeId) ? { targetNodeId: task.targetNodeId } : {}),
            ...(readNonEmptyString(task.missionId) ? { missionId: task.missionId } : {}),
        });
    }
    return orphans;
}

/** Build the coordinator-facing "why + how to fix" message for a set of orphans. */
export function buildOrphanedPinNotice(
    orphans: readonly OrphanedPinnedTask[],
    stoppedSessionId: string,
    cause: string,
): string {
    const listed = orphans.slice(0, MAX_LISTED_ORPHANS);
    const overflow = orphans.length - listed.length;
    const lines = listed.map(o => `  - ${o.taskId}: "${o.title}"`).join('\n');
    const more = overflow > 0 ? `\n  ...and ${overflow} more.` : '';
    const plural = orphans.length === 1 ? 'task is' : 'tasks are';
    // The fix is spelled with the exact tool call the coordinator must make, because
    // this notification exists precisely for the moment when the coordinator has NOT
    // realised anything is wrong — a hint it has to decode is a hint it will not act on.
    const firstId = listed[0]?.taskId || '<task_id>';
    return `[System] ${orphans.length} queued mesh ${plural} now ORPHANED and will never be delivered.\n`
        + `Cause: ${cause} stopped worker session '${stoppedSessionId}', and these pending tasks are hard-pinned to that session (targetSessionId), so they can neither be delivered (the session is gone) nor start a new session (the pin blocks auto-launch, reported as autoLaunch.reason='target_session_constraint').\n`
        + `Orphaned:\n${lines}${more}\n`
        + `Fix — for each task, clear the dead pin so it can be re-dispatched:\n`
        + `  mesh_queue_requeue(task_id='${firstId}', keep_target_session=false, clear_target_node=false, reason='pinned session stopped')\n`
        + `That releases the session pin (keeping the node pin) and the task becomes claimable by a live session on the same node; add clear_target_node=true to free it to any node, or pass target_session_id=<new session> to re-pin it to a replacement session. If the task is no longer wanted, cancel it with mesh_queue_cancel instead.\n`
        + `The pin is NOT cleared automatically: a pin often encodes required context continuity, so re-targeting is your decision, not the daemon's.`;
}

/**
 * Surface tasks orphaned by a session stop to the originating coordinator as a
 * pending `mesh:dispatch_blocked` event — the SAME coordinator-addressed alert
 * channel the actionable dispatch-skip notifications already use
 * (mesh-skip-notify.ts). No new channel: `mesh:dispatch_blocked` is already
 * classed as a COORDINATOR_ALERT_EVENT in contracts.ts, so it routes unicast to
 * the originating coordinator instead of dead-lettering.
 *
 * Deliberately NOTIFY-ONLY — it does not clear the pins. A `targetSessionId` pin is
 * usually written to keep a delta with the session that holds the context it
 * corrects; silently re-homing it onto an arbitrary live session could land a
 * follow-up on work it was never about. The coordinator is given the exact requeue
 * call instead and decides. (The slow DEAD-TARGET-SELFHEAL / pin-TTL backstops in
 * mesh-queue-assignment.ts still eventually unpin a provably dead LOCAL target;
 * this notification is what makes the 60s–15min gap survivable.)
 *
 * Returns the orphans found (empty when there are none), so callers can include
 * them in their own tool response.
 */
export function notifyCoordinatorOfOrphanedPins(
    meshId: string,
    stoppedSessionId: string,
    opts?: { excludeTaskId?: string; cause?: string; nodeId?: string; coordinatorSessionId?: string },
): OrphanedPinnedTask[] {
    const orphans = findTasksOrphanedBySessionStop(meshId, stoppedSessionId, { excludeTaskId: opts?.excludeTaskId });
    if (orphans.length === 0) return orphans;

    const cause = readNonEmptyString(opts?.cause) || 'A cancellation';
    const coordinatorMessage = buildOrphanedPinNotice(orphans, stoppedSessionId, cause);
    const nodeLabel = readNonEmptyString(opts?.nodeId) || readNonEmptyString(orphans[0]?.targetNodeId) || meshId;
    // Address the event to THIS daemon (it owns the queue) and, when known, to the
    // coordinator session that issued the cancel — the same addressing the actionable
    // dispatch-skip notification uses.
    const targetCoordinatorDaemonId = readNonEmptyString(loadConfig().machineId);
    const targetCoordinatorSessionId = readNonEmptyString(opts?.coordinatorSessionId);

    LOG.warn('MeshQueue', `CANCEL-ORPHANS-PINNED-TASK: stopping session ${stoppedSessionId} (mesh ${meshId}) orphaned ${orphans.length} pinned pending task(s): ${orphans.map(o => o.taskId).join(', ')}`);
    try {
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel,
            ...(readNonEmptyString(opts?.nodeId) ? { nodeId: opts!.nodeId } : {}),
            metadataEvent: {
                source: 'mesh_session_stop_orphaned_pins',
                // taskId anchors the pending-event fingerprint (buildPendingEventFingerprint),
                // so one notification per orphaned task set rather than a global collapse.
                taskId: orphans[0].taskId,
                reason: 'pinned_session_stopped',
                orphanedTaskIds: orphans.map(o => o.taskId),
                stoppedSessionId,
                coordinatorMessage,
            },
            coordinatorMessage,
            queuedAt: Date.now(),
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to surface orphaned-pin notification for session ${stoppedSessionId} (mesh ${meshId}): ${e?.message || e}`);
    }
    return orphans;
}
