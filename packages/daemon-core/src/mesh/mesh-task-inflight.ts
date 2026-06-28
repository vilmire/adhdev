/**
 * CANON-IDENTITY single-flight dispatch guard.
 *
 * A queue task is double-dispatched into two worker sessions when a SECOND dispatch
 * path opens after the first has already claimed + dispatched the task. The two
 * observed paths:
 *   - the idle-claim drain / auto-launch both funnel through tryAssignQueueTask,
 *     which is serialized by the atomic claim transaction (claimNextQueueTask) — so
 *     two concurrent claims can never both win; and
 *   - the operator requeue tool (mesh_queue_requeue → requeueTask), which flips an
 *     already-`assigned` row back to `pending` REGARDLESS of whether the worker
 *     holding it is still generating. A requeue issued while the worker is mid-turn
 *     re-opens the task for a SECOND session to claim — the live `ade8586d` race.
 *
 * The atomic claim already discriminates pending-vs-assigned, but it cannot tell a
 * GENUINELY-in-flight assigned row (dispatched, worker generating) from a STALE
 * assigned row (dead session, dispatch never confirmed) — and the requeue contract
 * must still reopen the stale case. This module is that discriminator: a task id is
 * registered here ONLY by the dispatch path at the moment it hands the claimed task
 * to a transport, and cleared the moment the task leaves the `assigned` state
 * (terminal completion/failure, dispatch-failure requeue, cancel, reclaim, or a
 * forced requeue). requeueTask consults it and refuses (no-op) to reopen a task that
 * is still in-flight unless the caller passes `force`.
 *
 * Dependency-free leaf (no imports) so both mesh-queue-assignment (begin) and
 * mesh-work-queue (clear + the requeue guard) can import it without a cycle. The key
 * is `${meshId}::${taskId}`; a task id is a single-form UUID, so no daemon-id
 * normalization is needed on the key itself.
 */

const inFlight = new Set<string>();

function key(meshId: string, taskId: string): string {
    return `${meshId}::${taskId}`;
}

/**
 * Mark a task as actively dispatched/generating (in-flight). Called by the dispatch
 * path right after a successful claim, before/as the task is handed to a transport.
 * Returns true when this call transitioned the task into the in-flight set, false
 * when it was already in-flight (a redundant begin — the caller may treat that as a
 * signal that a dispatch is already live for this task).
 */
export function beginTaskDispatchInFlight(meshId: string, taskId: string): boolean {
    if (!meshId || !taskId) return false;
    const k = key(meshId, taskId);
    if (inFlight.has(k)) return false;
    inFlight.add(k);
    return true;
}

/** True while a task is actively dispatched/generating (registered by the dispatch
 *  path and not yet cleared by a terminal/requeue/cancel transition). */
export function isTaskDispatchInFlight(meshId: string, taskId: string): boolean {
    if (!meshId || !taskId) return false;
    return inFlight.has(key(meshId, taskId));
}

/** Clear a task's in-flight mark. Called whenever the task leaves the `assigned`
 *  state (terminal completion/failure, dispatch-failure requeue, cancel, reclaim, or
 *  a forced requeue). Idempotent / safe to call when the task was never in-flight. */
export function endTaskDispatchInFlight(meshId: string, taskId: string): void {
    if (!meshId || !taskId) return;
    inFlight.delete(key(meshId, taskId));
}

/** Test-only: drop all in-flight marks so a fresh test starts from a clean guard. */
export function __resetTaskDispatchInFlightForTests(): void {
    inFlight.clear();
}
