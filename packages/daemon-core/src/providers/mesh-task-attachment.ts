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
 *
 * ── Constructor-bypassed instances ──────────────────────────────────────
 * Every function here takes the history as a REQUIRED array — callers must
 * hand in a real one. CliProviderInstance does that by reading its field
 * through meshTaskAttachments() below rather than passing it raw, because the
 * field cannot be trusted to exist: this suite's established idiom for
 * exercising private completion/mesh state is
 * `Object.create(CliProviderInstance.prototype)` (55 test files), which skips
 * the constructor, so class-field initializers never run and the field reads
 * back as `undefined`.
 *
 * With ADHDEV_WORKER_MCP off those stubs never reach this module, so the gap
 * is invisible. With the flag ON — the documented daemon/CI canary
 * environment (test/mesh/mesh-refine-gate-env-sanitize.test.ts) — it was a
 * hard TypeError in all of them at once: 125 tests across 29 files.
 *
 * Routing every read through one helper is the fix rather than a `?? []`
 * inlined at each call site (which would scatter the invariant across four
 * places) or a seeded field in each test file (which a newly added stub would
 * silently omit). "No attachment recorded yet"
 * and "empty history" are the same state, so materializing an empty array
 * there is the field's genuine initial value, not a guard papering over a
 * missing one. Regression coverage:
 * test/providers/cli-provider-mesh-turn-aware-attach.test.ts
 * ("constructor-bypassed stub (Object.create) — history is self-healing").
 */

export interface MeshTaskAttachment {
    taskId: string;
    attemptId?: string;
    dispatchNonce?: number;
    injectedAt: number;
}

/**
 * The single point that guarantees the history exists before any helper below
 * dereferences it. Every call site reads its field through this rather than
 * passing it raw, so a constructor-bypassed instance gets the field's real
 * initial value ([]) instead of throwing.
 *
 * Takes and returns the array (rather than the owning object) so the field can
 * stay `private` on CliProviderInstance — the caller keeps ownership and reads
 * through it: `meshTaskAttachments(this.meshTaskAttachmentHistory)`. When a
 * history already exists the SAME reference comes back, so the mutating
 * helpers below (push/pop) still operate on the caller's own array.
 *
 * Only the never-initialized case allocates. The one call site that must
 * persist that allocation is the push in attachMeshAssignment, which assigns
 * the result back to its field first; the read-only resolvers and the pop do
 * not, because on a never-initialized history there is by definition nothing
 * to read and nothing to shift — an absent history and an empty one are the
 * same state.
 */
export function meshTaskAttachments(history: MeshTaskAttachment[] | undefined): MeshTaskAttachment[] {
    return history ?? [];
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
