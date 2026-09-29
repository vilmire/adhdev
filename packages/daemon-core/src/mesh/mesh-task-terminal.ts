/**
 * The single transactional terminal choke point for a queue task.
 *
 * Every genuine terminal acceptance — a turn-ledger commit (through
 * `applyTaskTerminalInTxn`), a worker `report_completion`, an operator cancel,
 * and the queue-side policy terminals (retry cap / dispatch-failure cap /
 * park-retention expiry / dependency cascade) — lands here. Inside one
 * better-sqlite3 immediate transaction it:
 *
 *   1. Replay fence: a row ALREADY in this exact terminal is a duplicate — no
 *      new output version, nothing else happens.
 *   2. Persists the normalized completion envelope as the task's next immutable
 *      output version (append-only mesh_task_outputs).
 *   3. Flips the queue row to its terminal status and ends the dispatch window.
 *
 * After the commit: the task's worker tokens expire and any undelivered
 * worker mailbox memo is discarded (neither may outlive the task).
 *
 * Downstream consequences are NOT decided here: `depends_on` dependents are
 * gated by `taskDependenciesSatisfied` at claim time, and the failure policy
 * (block notice / cancel cascade) is applied by the queue module that owns it
 * (mesh-work-queue.ts propagateDependencyFailure).
 */

import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { endTaskDispatchInFlight } from './mesh-task-inflight.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { expireWorkerTaskTokensForTask } from './worker-mcp-isolation.js';
import { discardWorkerMailboxForTask } from './worker-mailbox.js';
import { canonicalJson } from './mesh-untrusted-evidence.js';
import { sha256Hex } from '../system/hash.js';

/** Terminal statuses the choke point accepts. */
export type MeshTerminalCommitStatus = 'completed' | 'failed' | 'cancelled';

/** Normalized completion envelope input. Optional for non-completion terminals. */
export interface MeshTerminalCompletionEnvelope {
    workerResult?: unknown;
    finalSummary?: string;
    artifacts?: unknown;
    evidence?: unknown;
    nodeId?: string;
    providerType?: string;
    completedAt?: string;
}

/** The terminal-writer classes that reach the choke point (provenance / logging only). */
export type MeshTerminalCommitSource =
    | 'provider_event'
    | 'stall_reconcile'
    | 'cancellation'
    /** WORKER-MCP report_completion — fenced on the turn ledger by worker-report.ts before it lands here. */
    | 'worker_tool_report'
    /** A queue-side policy terminal (retry cap / dispatch-failure cap / park-retention expiry). */
    | 'queue_policy';

interface MeshTerminalCommitInput {
    meshId: string;
    taskId: string;
    status: MeshTerminalCommitStatus;
    sessionId?: string;
    attemptId?: string;
    occurredAtMs?: number;
    source: MeshTerminalCommitSource;
    reason?: string;
    envelope?: MeshTerminalCompletionEnvelope;
}

interface MeshTerminalCommitResult {
    /** The queue row after the transition (null when the task id is unknown). */
    entry: MeshWorkQueueEntry | null;
    /** False when the task is unknown. */
    committed: boolean;
    /** True when the row was ALREADY terminal with the same status — a replayed event. */
    duplicate: boolean;
}

/**
 * THE terminal-acceptance entry point for queue-side writers. Synchronous: the
 * whole state change is one immediate transaction (a nested call under a
 * caller's queue lock degrades to a savepoint).
 */
export function commitTaskTerminal(terminal: MeshTerminalCommitInput): MeshTerminalCommitResult {
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date(terminal.occurredAtMs ?? Date.now()).toISOString();
    const result = store.transaction((): MeshTerminalCommitResult => {
        const entry = store.findQueueEntryById(terminal.meshId, terminal.taskId);
        if (!entry) return { entry: null, committed: false, duplicate: false };
        if (entry.status === terminal.status) return { entry, committed: true, duplicate: true };
        applyTaskTerminalSteps(store, entry, terminal, nowIso);
        return { entry, committed: true, duplicate: false };
    });
    // Idempotent post-commit cleanup: the replay fence re-enters with
    // duplicate:true for an already-terminal row, so this may run more than once.
    if (result.committed) afterTaskTerminalCommitted(terminal.meshId, terminal.taskId);
    return result;
}

/** Steps 2-3 on a queue row known to be non-terminal-for-this-status. Inside the caller's txn. */
function applyTaskTerminalSteps(
    store: MeshRuntimeStore,
    entry: MeshWorkQueueEntry,
    terminal: MeshTerminalCommitInput,
    nowIso: string,
    attemptNo?: number,
): void {
    persistOutputVersion(store, terminal, nowIso, attemptNo);
    entry.status = terminal.status;
    store.updateQueueEntry(entry);
    endTaskDispatchInFlight(terminal.meshId, terminal.taskId);
}

/** A committed turn's queue consequence, as the ledger's `task_terminal` effect names it. */
interface MeshLedgerTerminalInput {
    meshId: string;
    taskId: string;
    status: MeshTerminalCommitStatus;
    sessionId?: string;
    attemptId?: string;
    /** turn_attempts.attempt_no (+1 = the output's `attempt`). */
    attemptNo?: number;
    occurredAtMs: number;
    reason?: string;
    envelope?: MeshTerminalCompletionEnvelope;
}

/**
 * Steps 2-3 for a turn the ledger ALREADY committed (the reducer is the only
 * acceptance decision). MUST run inside the ledger's transaction on the
 * MeshRuntimeStore handle (it nests as a savepoint). Post-commit work is
 * {@link afterTaskTerminalCommitted}. The replay fence is kept: a row already in
 * this terminal transitions nothing.
 */
export function applyTaskTerminalInTxn(input: MeshLedgerTerminalInput): { entry: MeshWorkQueueEntry | null; transitioned: boolean } {
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() => {
        const entry = store.findQueueEntryById(input.meshId, input.taskId);
        if (!entry) return { entry: null, transitioned: false };
        if (entry.status === input.status) return { entry, transitioned: false };
        const terminal: MeshTerminalCommitInput = {
            meshId: input.meshId,
            taskId: input.taskId,
            status: input.status,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.attemptId ? { attemptId: input.attemptId } : {}),
            occurredAtMs: input.occurredAtMs,
            source: 'provider_event',
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.envelope ? { envelope: input.envelope } : {}),
        };
        applyTaskTerminalSteps(store, entry, terminal, new Date(input.occurredAtMs).toISOString(), input.attemptNo);
        return { entry, transitioned: true };
    });
}

/**
 * Post-commit half of a task terminal: token expiry and mailbox discard. A token
 * cannot outlive the task it authorizes, and an undelivered memo for a terminal
 * task can never be delivered. Best-effort and idempotent.
 */
export function afterTaskTerminalCommitted(meshId: string, taskId: string): void {
    try { expireWorkerTaskTokensForTask(meshId, taskId); } catch { /* a stale token still fails the causal checks */ }
    try { discardWorkerMailboxForTask(meshId, taskId); } catch { /* best-effort */ }
}

/** Insert the next immutable output version for this task. */
function persistOutputVersion(
    store: MeshRuntimeStore,
    terminal: MeshTerminalCommitInput,
    nowIso: string,
    attemptNo?: number,
): void {
    const latest = store.getLatestTaskOutput(terminal.taskId);
    const version = (latest?.version ?? 0) + 1;
    let attemptSeq = attemptNo !== undefined ? attemptNo + 1 : 1;
    if (attemptNo === undefined) {
        try {
            const attempt = store.turnStore().findLatestAttemptForTask(terminal.meshId, terminal.taskId);
            if (attempt) attemptSeq = attempt.attemptNo + 1;
        } catch { /* task without a ledger attempt — version still persists */ }
    }
    const envelopeJson = canonicalJson({
        task_id: terminal.taskId,
        attempt: attemptSeq,
        status: terminal.status,
        worker_result: terminal.envelope?.workerResult,
        final_summary: terminal.envelope?.finalSummary,
        artifacts: terminal.envelope?.artifacts,
        evidence: terminal.envelope?.evidence,
        completed_at: terminal.envelope?.completedAt ?? nowIso,
        source: {
            node_id: terminal.envelope?.nodeId,
            session_id: terminal.sessionId,
            provider_type: terminal.envelope?.providerType,
        },
    });
    store.insertTaskOutput({
        taskId: terminal.taskId,
        version,
        meshId: terminal.meshId,
        attempt: attemptSeq,
        status: terminal.status,
        envelopeJson,
        digest: sha256Hex(envelopeJson),
        createdAt: nowIso,
    });
}
