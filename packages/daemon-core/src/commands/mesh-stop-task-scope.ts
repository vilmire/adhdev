/**
 * CANCEL-STOP-TASK-SCOPE: decide whether a task-scoped `agent_command action:'stop'`
 * may terminate the target session.
 *
 * Background. `mesh_queue_cancel` propagates a stop to the worker that claimed the
 * cancelled task, because cancelling the queue row alone does NOT halt a worker that
 * already claimed the task and is generating — it would run to completion and commit.
 * That intent is correct and MUST be preserved.
 *
 * The defect this closes is the TARGETING, not the intent. The cancel path resolved its
 * victim purely from the queue row's `assignedSessionId`, with no check that the session
 * is still running THAT task. `action:'stop'` is a HARD stop (CliManager.stopSession
 * removes the instance), and sessions are reused: a session that finished task1 (whose
 * queue row lingered in `assigned`) and then picked up task2 would be killed mid-task2,
 * destroying unrelated work. Observed live 2026-09-02.
 *
 * The fix is to make the stop TASK-SCOPED at the daemon — the only place that knows what
 * the session is actually running right now. Task identity resolution mirrors
 * CliProviderInstance.completingTurnTaskId():
 *   1. `adapter.currentTurnTaskId` — the per-turn binding, set when the turn was
 *      submitted and surviving until the next turn starts. Authoritative.
 *   2. `settings.meshActiveTaskId` — the last-write-wins session scalar, retained as a
 *      backward-compat alias for "current/last assignment". Weaker (a second task
 *      attaching overwrites it) but it is what a session carries when the adapter does
 *      not track per-turn ids.
 *
 * Fail-open cases are deliberate and narrow — each would otherwise REGRESS the in-flight
 * cancellation this exists to perform:
 *   - the stop carries no taskId (a plain dashboard/operator stop): not task-scoped at
 *     all, so there is nothing to scope it to. Unchanged behaviour.
 *   - the session exposes no task identity at all: a worker mid-boot, or an adapter that
 *     tracks neither id. Refusing here would silently un-do the cancel-stop for exactly
 *     the workers most likely to be running the task.
 * Only a POSITIVE mismatch — the session says it is running some OTHER task — blocks the
 * stop. That is precisely the case that destroyed unrelated work.
 */

export interface MeshStopTaskScopeInputs {
    /** taskId the stop is scoped to (meshContext.taskId); absent for an unscoped stop. */
    requestedTaskId?: string | undefined;
    /** Per-turn binding on the adapter — the authoritative "what is running now". */
    currentTurnTaskId?: unknown;
    /** Last-write-wins session scalar (settings.meshActiveTaskId) — weaker fallback. */
    meshActiveTaskId?: unknown;
}

export type MeshStopTaskScopeDecision =
    | { allowed: true; reason: 'not_task_scoped' | 'task_match' | 'session_task_unknown'; sessionTaskId?: string }
    | { allowed: false; reason: 'task_mismatch'; sessionTaskId: string };

function readTaskId(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the taskId the session is currently working, using the same precedence as
 * CliProviderInstance.completingTurnTaskId(): per-turn binding first, session scalar
 * second. Returns undefined when the session carries no task identity.
 */
export function resolveSessionCurrentTaskId(inputs: MeshStopTaskScopeInputs): string | undefined {
    return readTaskId(inputs.currentTurnTaskId) ?? readTaskId(inputs.meshActiveTaskId);
}

export function evaluateMeshStopTaskScope(inputs: MeshStopTaskScopeInputs): MeshStopTaskScopeDecision {
    const requested = readTaskId(inputs.requestedTaskId);
    if (!requested) return { allowed: true, reason: 'not_task_scoped' };

    const sessionTaskId = resolveSessionCurrentTaskId(inputs);
    if (!sessionTaskId) return { allowed: true, reason: 'session_task_unknown' };

    if (sessionTaskId === requested) return { allowed: true, reason: 'task_match', sessionTaskId };
    return { allowed: false, reason: 'task_mismatch', sessionTaskId };
}
