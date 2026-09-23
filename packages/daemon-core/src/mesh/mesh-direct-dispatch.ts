/**
 * Mesh Direct Dispatch Tracking — reads direct (non-queue) task dispatches,
 * plus the mesh tool-call rate window.
 *
 * C-W8: a direct dispatch IS its open `mesh_direct` turn-ledger attempt (opened
 * by the caller's `dispatch_accepted` before the send). The retired
 * the legacy direct-dispatch table and its writers (insert / status flips / stale
 * sweeps / deletes) are gone; readers keep `getActiveDirectDispatches`, and the
 * queue-side abandonment paths close the attempt with a ledger `cancel`.
 *
 * Split out of mesh-work-queue.ts (FILE-SIZE-HEADROOM). Pure move. This module
 * writes only direct-dispatch rows in MeshRuntimeStore — never a queue row's
 * terminal status, which stays behind the graph choke point in
 * mesh-work-queue.ts. mesh-work-queue.ts re-exports the surface.
 */

import type { CancelReason } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import type { DirectDispatchView } from './mesh-runtime-store-queue-reads.js';
import { getActiveTurnLedger } from './turn-ledger/active-ledger.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { cancelTask, recordDirectDispatchTask, requeueTask } from './mesh-work-queue.js';

// ── Direct Dispatch Tracking ─────────────────────────────────────────────────

export type DirectDispatchRecord = DirectDispatchView;

export function getActiveDirectDispatches(meshId: string): DirectDispatchRecord[] {
    try {
        return MeshRuntimeStore.getInstance().getActiveDirectDispatches(meshId);
    } catch {
        return [];
    }
}

/**
 * Close the open `mesh_direct` attempt(s) of `taskIds` with a ledger `cancel`
 * (R22 → cancelled). The default reason `intentional_cleanup` is bookkeeping
 * only: R22 then emits NO `cancel_dispatch`, so the worker session is neither
 * withdrawn nor stopped (the retired row flip never touched it either).
 * Daemon-side only: it needs this process's turn ledger —
 * the mcp-server reaches the daemon's ledger with `turn_cancel` over IPC
 * instead. Returns how many attempts the ledger closed (0 when no ledger is
 * armed here). Best-effort: never throws.
 */
export function cancelDirectDispatchAttempts(
    meshId: string,
    taskIds: readonly string[],
    reason: CancelReason = 'intentional_cleanup',
    source: 'operator' | 'scheduler' | 'intentional_cleanup' = 'intentional_cleanup',
): number {
    const ledger = getActiveTurnLedger();
    if (!ledger) return 0;
    let closed = 0;
    try {
        const open = new Map(MeshRuntimeStore.getInstance().getActiveDirectDispatches(meshId).map((d) => [d.taskId, d] as const));
        for (const taskId of taskIds) {
            const dispatch = open.get(taskId);
            if (!dispatch) continue;
            const attempt = ledger.getAttempt(dispatch.attemptId);
            if (!attempt || attempt.terminal) continue;
            const result = ledger.observe({
                eventId: `cancel:${attempt.attemptId}:g${attempt.generation}:${reason}`,
                at: Date.now(),
                source,
                sessionId: attempt.sessionId,
                observedBy: ledger.selfDaemonId,
                attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
                kind: 'cancel',
                reason,
            });
            if (result.verdict === 'applied') closed += 1;
        }
    } catch (e: any) {
        LOG.warn('MeshQueue', `cancelDirectDispatchAttempts(${meshId}) failed: ${e?.message || e}`);
    }
    return closed;
}

/**
 * SIBLING-DISPATCH-ORPHAN: the reason a task's queue row was abandoned while a sibling
 * direct-dispatch row was still live. Recorded verbatim in the audit ledger entry.
 */
// DISPATCH-FAILURE-DEATH-SIGNAL: the re-export of recordAckedHoldDispatchOutcome
// stayed on mesh-work-queue.ts when this block moved out — mesh-queue-assignment
// imports it "through the queue module it already imports", which is that file,
// not this one. See the note at the bottom of mesh-work-queue.ts.

export type SiblingDispatchTerminalizeReason =
    | 'queue_task_cancelled'
    | 'queue_task_requeued'
    | 'queue_task_dispatch_failed'
    | 'queue_task_stranded_reclaimed';

/**
 * SIBLING-DISPATCH-ORPHAN: close the open direct dispatch (its `mesh_direct`
 * attempt, C-W8) that shares this task id whenever the QUEUE row is abandoned
 * out from under it (cancelTask, requeueTask incl. its dispatch-failure branch,
 * the stranded reclaim). Those paths touch only the queue row; without this the
 * dispatch outlived its task and `buildMeshActiveWork` rendered a cancelled task
 * as live `generating` work — feeding generatingCount, sessionHasActiveAssignment,
 * routing fitness and idle reminders (measured live: one orphan survived 12 days).
 *
 * The ledger `cancel` (reason intentional_cleanup) asserts no completion outcome: the
 * abandonment says nothing about whether the worker finished. Best-effort and
 * self-contained: a ledger/audit failure never fails the queue mutation that
 * already committed.
 */
export function terminalizeSiblingDispatch(
    meshId: string,
    taskId: string,
    reason: SiblingDispatchTerminalizeReason,
): void {
    try {
        // Only act on a dispatch that is actually still open; one that already
        // reached a terminal outcome by its own path needs neither the cancel nor
        // an audit entry.
        const sibling = getActiveDirectDispatches(meshId).find(d => d.taskId === taskId);
        if (!sibling) return;
        // C-W8: the dispatch is its open mesh_direct attempt — close it on the
        // ledger (`cancel` / intentional_cleanup → cancelled, no session side
        // effect). "Cancelled" asserts no completion outcome, the same neutrality
        // the old 'stale' flip had; stopping the worker stays the cancel path's job.
        const closed = cancelDirectDispatchAttempts(meshId, [taskId]);
        LOG.info('MeshQueue', `SIBLING-DISPATCH-ORPHAN: task ${taskId} (mesh ${meshId}) was abandoned (${reason}) while its direct dispatch was still '${sibling.status}'; ${closed > 0 ? 'cancelled its attempt' : 'no ledger armed to cancel its attempt'} so it stops rendering as active work.`);
        try {
            appendLedgerEntry(meshId, {
                kind: 'sibling_dispatch_terminalized',
                taskId,
                ...(sibling.nodeId ? { nodeId: sibling.nodeId } : {}),
                ...(sibling.sessionId ? { sessionId: sibling.sessionId } : {}),
                ...(sibling.providerType ? { providerType: sibling.providerType } : {}),
                payload: {
                    taskId,
                    reason,
                    dispatchStatus: sibling.status,
                    attemptId: sibling.attemptId,
                    ...(sibling.sessionId ? { sessionId: sibling.sessionId } : {}),
                    ...(sibling.nodeId ? { nodeId: sibling.nodeId } : {}),
                },
            });
        } catch { /* best-effort audit — the cancel above still stands */ }
    } catch { /* best-effort — never fail the queue mutation that already committed */ }
}

export type MeshToolCallRateResult = { rateLimitExceeded: boolean; callsInWindow: number; advisory: string | null };

/**
 * Record a coordinator tool call and return a rate-limit advisory when the
 * call rate for that tool exceeds the allowed threshold.
 *
 * Defaults: 10-second sliding window, max 5 calls before advisory is raised.
 * Returns { rateLimitExceeded: false } on any store error so callers are not blocked.
 *
 * `callerRole` is diagnostic only (see MeshRuntimeStore.recordMeshToolCall) —
 * a process can set ADHDEV_COORDINATOR_SESSION_ID on itself, so this must
 * never become an authorization gate.
 */
export function recordMeshToolCall(opts: {
    meshId: string;
    tool: string;
    sessionId?: string | null;
    callerRole?: 'coordinator' | 'unknown' | null;
    windowMs?: number;
    maxCalls?: number;
}): MeshToolCallRateResult {
    try {
        return MeshRuntimeStore.getInstance().recordMeshToolCall(opts);
    } catch {
        return { rateLimitExceeded: false, callsInWindow: 0, advisory: null };
    }
}
