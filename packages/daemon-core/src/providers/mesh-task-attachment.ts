/**
 * WORKER-MCP T2 precursor (docs/design/2026-08-28-worker-mcp.md §8 R1 gap).
 *
 * meshActiveTaskId (CliProviderInstance's session-settings scalar) is
 * last-write-wins: a second task attaching to a session before the first
 * task's turn completes overwrites it, so completion attribution and the
 * ANTIGRAVITY-PREMATURE-COMPLETION gate both misfire (NOTIF-MISDELIVER /
 * TASK-MSG-MISROUTE). This module holds the turn-aware history that fixes
 * that — a FIFO of mesh task attachments, oldest-first — extracted out of
 * cli-provider-instance.ts to keep that file under the file-size gate
 * (scripts/check-file-sizes.mjs baseline-growth; pure move, no behavior
 * change).
 *
 * Nothing here makes the overlap reachable in production: mesh policy still
 * queues busy sessions (mesh-delivery-policy.ts BUSY_DELIVERY_STATUSES),
 * auto-pick still filters to idle sessions only (mcp-server
 * mesh-tools-internal.ts isIdleSessionRecord), and the FSM's canSendNow()
 * still hard-requires 'idle' before writing to the PTY
 * (providers/spec/fsm-driver.ts) — none of those three gates are touched by
 * this module. This history is the PRECONDITION a later T2 change would need
 * before any of them could be safely loosened.
 *
 * Every function here is pure with respect to gating: CliProviderInstance is
 * responsible for calling in here ONLY when isWorkerMcpEnabled() is true.
 * With the flag off, CliProviderInstance never calls in here, so the array
 * stays permanently empty and every consumer falls through to the exact
 * prior scalar-only behavior (byte-identical).
 */

export interface MeshTaskAttachment {
    taskId: string;
    attemptId?: string;
    dispatchNonce?: number;
    injectedAt: number;
}

/** Overlapping attachments should stay in the single digits in practice (one
 *  per still-completing turn). A runaway growth here would mean
 *  popCompletedMeshTaskAttachment stopped being called, which is a bug worth
 *  surfacing loudly rather than an unbounded array. */
export const MESH_TASK_ATTACHMENT_HISTORY_CAP = 8;

/**
 * Record a new mesh task attachment. Mutates `history` in place (push, and —
 * only past the cap — shift), mirroring the call site's existing
 * settings-mutation style. Returns the dropped entry's taskId when the cap
 * forced one out, so the caller can log it (this module stays logging-free).
 */
export function pushMeshTaskAttachment(
    history: MeshTaskAttachment[],
    attachment: MeshTaskAttachment,
): { droppedTaskId?: string } {
    history.push(attachment);
    if (history.length > MESH_TASK_ATTACHMENT_HISTORY_CAP) {
        const dropped = history.shift();
        return { droppedTaskId: dropped?.taskId };
    }
    return {};
}

/**
 * Pop the just-completed attachment (the oldest — FIFO, since only one turn
 * is ever physically in flight on the PTY) and return the NEXT pending
 * entry, if any, for the caller to restore onto its scalar settings fields.
 */
export function popCompletedMeshTaskAttachment(history: MeshTaskAttachment[]): MeshTaskAttachment | undefined {
    if (history.length === 0) return undefined;
    history.shift();
    return history[0];
}

/** The taskId of the turn that is CURRENTLY completing — the oldest (FIFO)
 *  entry — or undefined when no attachment is pending. */
export function resolveCompletingTaskId(history: MeshTaskAttachment[]): string | undefined {
    return history.length > 0 ? history[0].taskId : undefined;
}

/** The injectedAt anchor for the ANTIGRAVITY-PREMATURE-COMPLETION gate — the
 *  oldest (FIFO) entry's own inject time — or undefined when no attachment
 *  is pending. */
export function resolvePendingInjectedAt(history: MeshTaskAttachment[]): number | undefined {
    return history.length > 0 ? history[0].injectedAt : undefined;
}

/**
 * Merge a still-pending attachment's identity onto a settings object that has
 * just had its task-level mesh markers stripped (the `rest` produced by
 * detachMeshAssignment's destructure). Returns `rest` unchanged when there is
 * no pending attachment — the original full-clear behavior.
 */
export function mergePendingMeshTaskAttachment(
    rest: Record<string, unknown>,
    pending: MeshTaskAttachment | undefined,
): Record<string, unknown> {
    if (!pending) return rest;
    return {
        ...rest,
        meshActiveTaskId: pending.taskId,
        ...(pending.attemptId ? { meshActiveAttemptId: pending.attemptId } : {}),
        ...(typeof pending.dispatchNonce === 'number' ? { meshActiveDispatchNonce: pending.dispatchNonce } : {}),
    };
}
