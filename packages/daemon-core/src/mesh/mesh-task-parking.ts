import { LOG } from '../logging/logger.js';
import { readNonEmptyString } from './mesh-events-utils.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events-pending.js';
import { noteTargetPinCleared } from './mesh-turn-ledger.js';
import { traceMeshEventDrop } from './mesh-event-trace.js';
import { loadConfig } from '../config/config.js';
import type { MeshWorkQueueEntry, MeshTaskParking } from './mesh-work-queue.js';

// ---------------------------------------------------------------------------
// PIN-PARKING: an expired target pin PARKS the task and returns it to the
// coordinator. It never silently re-homes the delta onto an arbitrary session.
//
// The defect this closes. Two coordinator-side paths handled a pin that can no
// longer deliver, and they disagreed:
//
//   - SESSION STOP (mesh-orphaned-pin-notify.ts) notifies and deliberately does
//     NOT clear the pin. Its stated reason: "a pin often encodes required
//     context continuity, so re-targeting is your decision, not the daemon's."
//   - TTL EXPIRY (the RC.20 rule) cleared the pin and made the row claimable by
//     ANY compatible session.
//
// The owner's decision (2026-08-19) is that the first path is right and the
// second is worse than dropping the task outright. A task pinned with
// targetSessionId is, by construction, a DELTA — a correction addressed to work
// already in flight in one specific session's context ("also handle the null
// case in the function you just wrote"). Handing that to a different session
// does not degrade to "delivered late"; it degrades to a context-free
// instruction landing on unrelated work. A silent succession is an incorrect
// delivery wearing the costume of a successful one.
//
// So the expiry now moves the row to PARKED: still durable, still addressed,
// but claimable by nobody until the coordinator decides. Parking preserves the
// original address (targetSessionId / targetNodeId are KEPT on the row, and
// mirrored into `parked` so they survive a later re-target), the reason, and
// the moment it happened.
//
// ★ Why parking keeps the pin instead of clearing it. Keeping `targetSessionId`
// is what makes the unclaimable property FREE rather than a new invariant to
// enforce. The claim gate's tier-1 SQL only offers a session-pinned row to that
// exact session (mesh-runtime-store claimNextQueueTask), so a parked row is
// already invisible to every other session — there is no path where clearing a
// gate somewhere else silently re-opens succession. The single remaining hole,
// the pinned session itself coming back and claiming, is closed by the explicit
// `taskIsParked` guard in the same candidate filter. Fail-closed by
// construction: any future query change still has to pass that guard.
//
// ★ Parking is not a graveyard. A parked row that nobody ever looks at is the
// same loss it was written to prevent, so parking is deliberately paired with:
//   (a) an actionable coordinator notification at park time (mesh-skip-notify),
//   (b) visibility in the existing mesh_view_queue surface (`parkedTasks`),
//   (c) the existing requeue/cancel mutators, which accept parked rows and
//       unpark them (mesh_queue_requeue clears `parked` on every requeue), and
//   (d) a bounded retention sweep that FAILS a long-abandoned parked row with a
//       notification, rather than deleting it quietly.
// ---------------------------------------------------------------------------

/**
 * How long a parked task waits for the coordinator before the retention sweep
 * gives up on it.
 *
 * Sized in hours, not minutes, on purpose: parking exists precisely for the case
 * where the coordinator is busy elsewhere (that is why the pin went stale in the
 * first place), and the whole point is to survive that window. 24h comfortably
 * outlasts a long worker session, an overnight gap, and a coordinator restart,
 * while still bounding unbounded growth of a queue nobody is reading.
 *
 * Reaching it is NOT a silent discard — {@link resolveParkingRetentionVerdict}
 * routes it to a terminal `failed` with a stated reason plus a coordinator
 * notification, so the task's disappearance is itself reported. That is the
 * property the owner's constraint demands: cleanup must not become the silent
 * drop that parking was introduced to eliminate.
 */
export const PARKED_TASK_RETENTION_MS = 24 * 60 * 60_000;

/** Reason recorded on the row when a pin TTL expiry parks a task. */
export const PARK_REASON_PIN_EXPIRED = 'target_session_pin_expired_parked';

/**
 * The skip reason surfaced to the coordinator when a task parks. Distinct from
 * the pre-parking `target_session_pin_expired` so the notification can say
 * "held for you" instead of the old (and now false) "already claimable by any
 * compatible session".
 */
export const PARKED_SKIP_REASON = 'target_session_pin_parked';

/** Terminal reason stamped when a parked task outlives the retention window. */
export const PARK_RETENTION_EXPIRED_REASON = 'parked_task_retention_expired';

/** True when the entry is currently parked (awaiting an explicit coordinator decision). */
export function taskIsParked(task: Pick<MeshWorkQueueEntry, 'parked'> | null | undefined): boolean {
    return !!readNonEmptyString(task?.parked?.reason);
}

/** Build the immutable parking record stamped onto a row at park time. */
export function buildParkingRecord(
    task: Pick<MeshWorkQueueEntry, 'targetSessionId' | 'targetNodeId'>,
    reason: string,
    nowIso: string = new Date().toISOString(),
): MeshTaskParking {
    return {
        reason,
        parkedAt: nowIso,
        // Mirror the ORIGINAL address. `targetSessionId` also stays on the row
        // (that is what keeps the row unclaimable), but a later re-target
        // overwrites it — this copy is what still answers "who was this delta
        // written for?" after the coordinator has moved it.
        ...(readNonEmptyString(task.targetSessionId) ? { targetSessionId: task.targetSessionId } : {}),
        ...(readNonEmptyString(task.targetNodeId) ? { targetNodeId: task.targetNodeId } : {}),
    };
}

/** Age of a parked row in ms, or null when it is not parked / has no parse-able stamp. */
export function parkedAgeMs(task: Pick<MeshWorkQueueEntry, 'parked'>, nowMs: number = Date.now()): number | null {
    const parkedAt = readNonEmptyString(task.parked?.parkedAt);
    if (!parkedAt) return null;
    const parsed = Date.parse(parkedAt);
    return Number.isFinite(parsed) ? nowMs - parsed : null;
}

/**
 * Retention verdict for one parked row: has it waited past
 * {@link PARKED_TASK_RETENTION_MS} without the coordinator touching it?
 *
 * Deliberately conservative in both directions. A row that is not parked, or
 * whose `parkedAt` will not parse, is never swept — an unreadable timestamp
 * must not be grounds for discarding work. And the sweep is bounded by the
 * PARK stamp rather than `updatedAt`, so an unrelated per-tick `updatedAt` bump
 * cannot keep a forgotten row alive forever.
 */
export function parkedTaskRetentionExpired(
    task: Pick<MeshWorkQueueEntry, 'parked'>,
    nowMs: number = Date.now(),
    retentionMs: number = PARKED_TASK_RETENTION_MS,
): boolean {
    if (!taskIsParked(task as MeshWorkQueueEntry)) return false;
    const age = parkedAgeMs(task, nowMs);
    return age !== null && age >= retentionMs;
}

/**
 * The coordinator-facing "why + how to act" text for a parked task.
 *
 * Spelled with the exact tool calls, for the same reason the orphaned-pin notice
 * is: this message exists for the moment the coordinator has NOT realised
 * anything needs its attention, and a hint it must decode is a hint it will not
 * act on. The four verbs are the four exits from parking — inspect, re-target,
 * edit, cancel — because a park with no exit is indistinguishable from a loss.
 */
export function buildParkedTaskNotice(taskId: string, targetSessionId?: string, reason?: string): string {
    const addressee = readNonEmptyString(targetSessionId);
    return `The delta was addressed to session '${addressee || '(unknown)'}' and that pin went stale (${reason || PARK_REASON_PIN_EXPIRED}), so the task is now PARKED — held for you, deliberately NOT re-homed onto another session. `
        + `A message written for one session's context becomes a context-free instruction anywhere else, so the daemon will not choose a new addressee for you. `
        + `The task is claimable by nobody until you act on it, and it is dropped (as a terminal failure, with another notification) if left parked for ${Math.round(PARKED_TASK_RETENTION_MS / 3_600_000)}h. `
        + `Four ways out — inspect it with mesh_view_queue (parked rows are listed under parkedTasks with their original addressee), then either `
        + `re-target it with mesh_queue_requeue(task_id='${taskId}', target_session_id='<live session>') — or clear_target_session to let any compatible session take it; `
        + `REWRITE it first with mesh_queue_requeue(task_id='${taskId}', message='<updated instruction>') if the situation moved on while it waited (the common case: the worker already did the part your delta was about); `
        + `or cancel it with mesh_queue_cancel(task_id='${taskId}') if it is no longer wanted. Any requeue unparks the task.`;
}

/**
 * Tell the coordinator that a parked task was dropped by the retention sweep.
 *
 * This notification is the whole reason the sweep is allowed to exist. Parking was
 * introduced to eliminate a silent succession; a cleanup that silently deleted the
 * parked row would simply reinstate the same class of loss one step later, with a
 * longer fuse. So the sweep's terminal transition is always paired with this page,
 * on the SAME `mesh:dispatch_blocked` coordinator-alert channel the park itself
 * used (already unicast-routed to the originating coordinator via contracts.ts).
 *
 * Emitted best-effort: a failure here is logged, never thrown, because the row has
 * already been failed and losing the alert must not also break the reconcile tick.
 */
export function notifyCoordinatorOfParkedTaskDropped(
    meshId: string,
    task: Pick<MeshWorkQueueEntry, 'id' | 'parked' | 'targetNodeId' | 'sourceCoordinatorSessionId'>,
): void {
    const taskId = task.id;
    const addressee = readNonEmptyString(task.parked?.targetSessionId);
    const hours = Math.round(PARKED_TASK_RETENTION_MS / 3_600_000);
    const coordinatorMessage = `[System] A PARKED mesh task was dropped after ${hours}h with no coordinator decision.\n`
        + `Task ${taskId} was parked because its delta was addressed to session '${addressee || '(unknown)'}' and that pin went stale. `
        + `It was held — claimable by nobody — waiting for you to re-target, rewrite, or cancel it. That never happened, so it is now marked FAILED (${PARK_RETENTION_EXPIRED_REASON}) and any dependent tasks have been unblocked.\n`
        + `The instruction it carried was never delivered to anyone. If it still matters, re-enqueue it (mesh_enqueue_task) against a live session; the failed row remains in the queue as the audit record. `
        + `To avoid this next time, check parkedTasks in mesh_view_queue — parked rows are surfaced there from the moment they park.`;
    const nodeLabel = readNonEmptyString(task.targetNodeId) || readNonEmptyString(task.parked?.targetNodeId) || meshId;
    try {
        const targetCoordinatorDaemonId = readNonEmptyString(loadConfig().machineId);
        const targetCoordinatorSessionId = readNonEmptyString(task.sourceCoordinatorSessionId);
        queuePendingMeshCoordinatorEvent({
            event: 'mesh:dispatch_blocked',
            meshId,
            nodeLabel,
            metadataEvent: {
                source: 'mesh_parked_task_retention_expired',
                taskId,
                reason: PARK_RETENTION_EXPIRED_REASON,
                ...(addressee ? { parkedTargetSessionId: addressee } : {}),
                coordinatorMessage,
            },
            coordinatorMessage,
            queuedAt: Date.now(),
            ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
            ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
        });
    } catch (e: any) {
        LOG.warn('MeshQueue', `Failed to surface parked-task retention drop for task ${taskId} (mesh ${meshId}): ${e?.message || e}`);
    }
}

/**
 * Park a task whose target pin has exhausted its TTL, if it has.
 *
 * Returns true when the caller should record the parked skip for this tick —
 * which is deliberately NOT the same as "a mutation happened". parkTaskTargetPin
 * is idempotent (an already-parked row returns null so its retention clock is
 * never restamped), so gating the coordinator page on the mutation would mean a
 * park whose first notification failed to persist is never surfaced again. The
 * page is de-duped downstream by (mesh, task, reason), so re-asserting it every
 * tick costs nothing and closes that hole.
 *
 * The TTL VERDICT is computed by the caller (resolveTargetPinTtlVerdict, in
 * mesh-skip-notify) and passed in — deliberately NOT imported. mesh-skip-notify
 * imports PARKED_SKIP_REASON from this module to build its actionable-reason list at
 * module init, so an import back forms a cycle whose TDZ leaves that constant
 * `undefined` inside the array — silently un-registering the very notification this
 * change exists to deliver. (Observed exactly that way while building this: the four
 * notification tests went red the moment the back-import was added.) This file stays
 * a leaf; only the trace/metric emission lives here.
 */
export function parkExpiredTargetPin(
    meshId: string,
    task: MeshWorkQueueEntry,
    verdict: { expired: boolean; ageMs: number | null },
    ttlMs: number,
    // Injected so this leaf does not import mesh-work-queue (which imports THIS
    // module for the park mutators — a static import back would close a value cycle).
    park: (meshId: string, taskId: string, reason: string) => MeshWorkQueueEntry | null,
): boolean {
    if (!verdict.expired) return false;
    const parked = park(meshId, task.id, PARK_REASON_PIN_EXPIRED);
    if (parked) {
        noteTargetPinCleared(PARK_REASON_PIN_EXPIRED);
        traceMeshEventDrop('target_session_pin_expired', {
            taskId: task.id,
            sessionId: readNonEmptyString(task.targetSessionId),
            nodeId: readNonEmptyString(task.targetNodeId),
            meshId,
            event: 'agent:ready',
        }, `unproductive ${Math.round((verdict.ageMs ?? 0) / 1000)}s ≥ ttl ${Math.round(ttlMs / 1000)}s → task PARKED (held for the coordinator, NOT re-homed)`);
    }
    return true;
}

/**
 * What the reconcile scan does with a row it finds already PARKED — the only two
 * automatic transitions a parked task has.
 *
 * Extracted here (rather than inlined in the auto-launch scan) so the whole
 * parking lifecycle — park, page, sweep — reads in one file, and so the scan's
 * branch stays a single call.
 *
 * Two outcomes:
 *  - past the retention window → FAIL it (terminal, with a stated reason and a
 *    coordinator page). Never a silent delete; see PARKED_TASK_RETENTION_MS.
 *  - otherwise → re-record the parked skip, which re-pages the coordinator. That
 *    is deliberately done on EVERY tick rather than only at park time:
 *    notifyCoordinatorOfActionableSkip de-dupes per (mesh, task, reason), so this
 *    is one alert per park, not a loop — but it means a park whose first
 *    notification failed to persist is retried instead of being lost, which is
 *    the exact failure mode this whole change exists to close.
 *
 * `markSkip` is injected rather than imported to keep the ledger/auto-launch
 * recording (which lives in the assignment module) out of this leaf.
 *
 * Both the skip recorder and the retention sweep are INJECTED rather than imported:
 * mesh-work-queue imports this module for the park mutators, so importing it back
 * would close a value cycle, and the ledger/auto-launch recording belongs to the
 * assignment module. Keeping both out leaves this file a leaf.
 */
export function settleParkedQueueTask(
    meshId: string,
    task: MeshWorkQueueEntry,
    markSkip: (reason: string) => void,
    sweep: (meshId: string, taskId: string) => MeshWorkQueueEntry | null,
): 'swept' | 'held' {
    const swept = sweep(meshId, task.id);
    if (swept) {
        notifyCoordinatorOfParkedTaskDropped(meshId, task);
        return 'swept';
    }
    markSkip(PARKED_SKIP_REASON);
    return 'held';
}

/** Log a park transition (content-free: ids and reasons only). */
export function logTaskParked(meshId: string, taskId: string, reason: string, targetSessionId?: string): void {
    LOG.warn('MeshQueue', `PIN-PARKING: task ${taskId} (mesh ${meshId}) PARKED (${reason})`
        + `${targetSessionId ? ` — original addressee session ${targetSessionId}` : ''}`
        + '; it is claimable by nobody until the coordinator re-targets, edits, or cancels it.');
}
