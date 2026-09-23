/**
 * Mesh Direct Dispatch Tracking — persists direct (non-queue) task dispatches,
 * plus the mesh tool-call rate window.
 *
 * Split out of mesh-work-queue.ts (FILE-SIZE-HEADROOM). Pure move. This module
 * writes only direct-dispatch rows in MeshRuntimeStore — never a queue row's
 * terminal status, which stays behind the graph choke point in
 * mesh-work-queue.ts. mesh-work-queue.ts re-exports the surface.
 */

import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { LOG } from '../logging/logger.js';
import { appendLedgerEntry } from './mesh-ledger.js';
import { cancelTask, recordDirectDispatchTask, requeueTask } from './mesh-work-queue.js';

// ── Direct Dispatch Tracking ─────────────────────────────────────────────────
// Persists direct (non-queue) task dispatches so buildMeshActiveWork can read
// active work from MeshRuntimeStore instead of scanning ledger JSONL entries.

export type DirectDispatchRecord = ReturnType<MeshRuntimeStore['getActiveDirectDispatches']>[number];

export function insertDirectDispatch(
    meshId: string,
    data: {
        taskId: string;
        nodeId?: string;
        sessionId?: string;
        providerType?: string;
        message: string;
        taskMode?: string;
        via: string;
        dispatchedToIdleSession?: boolean;
        dispatchedAt: string;
    },
): void {
    try {
        MeshRuntimeStore.getInstance().insertDirectDispatch({ ...data, meshId });
    } catch (e: any) {
        process.stderr.write(`[adhdev-mesh] insertDirectDispatch failed for task ${data.taskId}: ${e?.message || e}\n`);
    }
}

export function getActiveDirectDispatches(meshId: string): DirectDispatchRecord[] {
    try {
        return MeshRuntimeStore.getInstance().getActiveDirectDispatches(meshId);
    } catch {
        return [];
    }
}

export function updateDirectDispatchStatus(
    meshId: string,
    sessionId: string,
    status: 'acked' | 'completed' | 'failed' | 'stale',
    taskId?: string,
): void {
    try {
        // CANON-B: prefer the exact task_id row; fall back to the session_id match only when
        // the firing event carried no taskId (a legacy/relayed event). Warn on the fallback so
        // the residual PK-substitute path is observable when it strands a sibling dispatch.
        if (!taskId) {
            LOG.warn('MeshQueue', `updateDirectDispatchStatus(${status}) for mesh ${meshId} session ${sessionId} has no taskId — falling back to session_id match (may flip a sibling dispatch row)`);
        }
        MeshRuntimeStore.getInstance().updateDirectDispatchStatus(meshId, sessionId, status, taskId);
    } catch { /* best-effort */ }
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
 * SIBLING-DISPATCH-ORPHAN: terminalize the `mesh_direct_dispatches` row that shares this
 * task id, whenever the QUEUE row is abandoned out from under it.
 *
 * WHY THIS EXISTS. `recordDirectDispatchTask` materialises TWO rows per direct dispatch —
 * a queue entry and a `mesh_direct_dispatches` entry — but every abandonment path
 * (cancelTask, requeueTask incl. its dispatch-failure branch, reclaimStrandedAssignedTask)
 * only ever touched the queue row and `endTaskDispatchInFlight`. The dispatch row was left
 * behind, and nothing else would ever collect it:
 *
 *   - `markStaleDirectDispatches` sweeps ONLY `status='dispatched'`, so a row that reached
 *     `acked` (the worker confirmed it started) has NO timeout sweeper whatsoever;
 *   - the orphan-prune path is age-gated and node/session-liveness-gated, so a row whose
 *     session is still alive is never pruned.
 *
 * The consequence is not cosmetic. `buildMeshActiveWork` skips CANCELLED queue rows when
 * building its dedupe set, so the orphan is NOT deduped against its queue sibling, and the
 * `dbStatus === 'acked' ? 'generating' : 'assigned'` fallback then renders a cancelled task
 * as actively generating — feeding generatingCount, sessionHasActiveAssignment, routing
 * fitness, idle reminders and the completion-synthesis loop. Measured live: one such row
 * survived 12 days. (Both halves are load-bearing: cancelling BEFORE dispatch leaves no
 * dispatch row at all, which is why this only ever bit already-dispatched tasks.)
 *
 * 'stale' — never 'completed'/'failed' — for the same reason `terminalizeAckedHold` chose
 * it: the abandonment says nothing about whether the worker finished, and a cancel is not
 * completion evidence (mesh-terminal-admission.ts). 'stale' is exactly "this dispatch will
 * never resolve itself": it leaves the active set without asserting an outcome.
 *
 * Deliberately NOT `terminalizeAckedHold` (mesh-completion-synthesis.ts) even though the
 * two do a similar flip: that helper is bound to synth-hold state and its own ledger kind,
 * and this module is upstream of it — importing it here would invert the dependency
 * (mesh-completion-synthesis already imports mesh-work-queue). The acked-hold state itself
 * needs no explicit cleanup on this path: reconcileUnterminatedDirectDispatches prunes hold
 * rows whose task has left the active dispatch set, which this flip is what causes.
 *
 * Best-effort and self-contained: a store/ledger failure must never fail the cancel/requeue
 * that already committed.
 */
export function terminalizeSiblingDispatch(
    meshId: string,
    taskId: string,
    reason: SiblingDispatchTerminalizeReason,
): void {
    try {
        const store = MeshRuntimeStore.getInstance();
        // Only act on a row that is actually still live; a dispatch that already reached a
        // terminal status by its own path needs neither the flip nor an audit entry (this
        // keeps the ledger free of a no-op record on the common well-behaved case).
        const sibling = store.getActiveDirectDispatches(meshId).find(d => d.taskId === taskId);
        if (!sibling) return;
        // Keyed by the exact task id — never the session_id fallback, which would flip a
        // sibling task's row (CANON-B, see updateDirectDispatchStatus).
        store.updateDirectDispatchStatus(meshId, sibling.sessionId ?? '', 'stale', taskId);
        LOG.info('MeshQueue', `SIBLING-DISPATCH-ORPHAN: task ${taskId} (mesh ${meshId}) was abandoned (${reason}) while its direct-dispatch row was still '${sibling.status}'; marked that row stale so it stops rendering as active work.`);
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
                    ...(sibling.sessionId ? { sessionId: sibling.sessionId } : {}),
                    ...(sibling.nodeId ? { nodeId: sibling.nodeId } : {}),
                },
            });
        } catch { /* best-effort audit — the terminalization above still stands */ }
    } catch { /* best-effort — never fail the queue mutation that already committed */ }
}

export function cleanupTerminalDirectDispatches(olderThanMs = 7 * 24 * 60 * 60_000): void {
    try {
        MeshRuntimeStore.getInstance().cleanupTerminalDirectDispatches(olderThanMs);
    } catch { /* best-effort */ }
}

export function markStaleDirectDispatches(meshId: string, olderThanMs = 60 * 60_000): void {
    try {
        MeshRuntimeStore.getInstance().markStaleDirectDispatches(meshId, olderThanMs);
    } catch { /* best-effort */ }
}

/**
 * Delete specific direct dispatch rows by taskId. Returns the number of rows deleted.
 * Used by the staleDirect prune path to evict orphaned/terminal dispatch records from the
 * active staleDirect surface while leaving the append-only mesh ledger (audit history) intact.
 */
export function deleteDirectDispatchesByTaskId(meshId: string, taskIds: string[]): number {
    try {
        return MeshRuntimeStore.getInstance().deleteDirectDispatchesByTaskId(meshId, taskIds);
    } catch {
        return 0;
    }
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
