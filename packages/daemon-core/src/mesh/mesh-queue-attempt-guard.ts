// ---------------------------------------------------------------------------
// mesh-queue-attempt-guard — the queue row's view of its open turn attempt
// ---------------------------------------------------------------------------
// The queue row and the turn ledger's attempt for the same task must agree on
// whether the task is running. Three queue writers used to decide that from
// the row alone and drifted from the ledger (live rc.25, c362e481):
//
//   * requeue (force) put the row back to `pending` beside an attempt that was
//     still `generating` — the next claim was refused by the ledger, and the
//     worker's final report found no provable attempt;
//   * the claim bumped `dispatchNonce` and flipped the row `assigned` before
//     asking the ledger, so every 4 s drain tick re-claimed such a row,
//     bumped the nonce, was refused and wrote it back to `pending` (133 times).
//
// This module answers the ledger question for those writers. Ledger STATE is
// only ever changed through `ledger.observe` (single-emitter rule): retiring an
// open attempt is a `cancel` (superseded), which the reducer commits as an
// attempt-only retirement — the row the caller is about to requeue is not
// terminalized and the coordinator is not told the task was cancelled.
// ---------------------------------------------------------------------------

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { INJECTION_CLOSED_STATES } from './mesh-queue-dispatch-evidence.js';
import { afterBridgeCommit } from './worker-bridge-transaction.js';
import { expireWorkerTaskTokensForAttempt } from './worker-mcp-isolation.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { getActiveTurnLedger } from './turn-ledger/active-ledger.js';
import type { TurnStore } from './turn-ledger/store.js';
import type { TurnAttempt } from './turn-ledger/types.js';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

/** The task's open `mesh_queue` attempt, if any. */
export function findOpenQueueAttempt(turns: Pick<TurnStore, 'findLatestAttemptForTask'>, meshId: string, taskId: string): TurnAttempt | null {
    const latest = turns.findLatestAttemptForTask(meshId, taskId);
    return latest && !latest.terminal && latest.scope === 'mesh_queue' ? latest : null;
}

/** The task's open attempt when it already consumed a prompt (a second injection would double-execute). */
export function findInjectionClosedQueueAttempt(turns: Pick<TurnStore, 'findLatestAttemptForTask'>, meshId: string, taskId: string): TurnAttempt | null {
    const open = findOpenQueueAttempt(turns, meshId, taskId);
    return open && INJECTION_CLOSED_STATES.has(open.state) ? open : null;
}

export type QueueAttemptRetirementRefusal = 'attempt_open' | 'no_ledger' | 'not_owner' | 'cancel_not_applied';

export type QueueAttemptRetirement =
    /** No open attempt — the requeue proceeds as before. */
    | { kind: 'none' }
    /** The open attempt was closed on the ledger (cancel / superseded). */
    | { kind: 'closed'; attempt: TurnAttempt }
    /** The requeue must not proceed: the attempt stays open. */
    | { kind: 'refused'; attempt: TurnAttempt; reason: QueueAttemptRetirementRefusal; detail?: string };

/**
 * Before a requeue puts the row back to `pending`: close the task's open
 * attempt, or refuse. Without `force` an attempt that already consumed its
 * prompt is a running task and refuses the requeue. Otherwise the attempt is
 * retired on the ledger — cancel/superseded, which the reducer commits as an
 * attempt-only retirement (its dispatch is cut, but no queue terminal and no
 * coordinator notice) — so the next claim opens attemptNo + 1 under a new nonce.
 *
 * Only the attempt's OWNER may retire it: evidence for a foreign attempt is
 * forwarded and the owner would commit the cancel without this requeue, so a
 * foreign attempt refuses before anything is observed.
 */
export function retireOpenQueueAttemptForRequeue(meshId: string, taskId: string, opts: { force: boolean }): QueueAttemptRetirement {
    const store = MeshRuntimeStore.getInstance();
    const open = findOpenQueueAttempt(store.turnStore(), meshId, taskId);
    if (!open) return { kind: 'none' };
    if (!opts.force && INJECTION_CLOSED_STATES.has(open.state)) return { kind: 'refused', attempt: open, reason: 'attempt_open' };
    const ledger = getActiveTurnLedger();
    if (!ledger) return { kind: 'refused', attempt: open, reason: 'no_ledger' };
    if (open.ownerDaemonId && !daemonIdsEquivalent(open.ownerDaemonId, ledger.selfDaemonId)) {
        return { kind: 'refused', attempt: open, reason: 'not_owner', detail: `owned by ${open.ownerDaemonId}` };
    }
    const at = Date.now();
    const result = ledger.observe({
        eventId: `requeue_supersede:${open.attemptId}:g${open.generation}:${at}`,
        at,
        source: opts.force ? 'operator' : 'scheduler',
        sessionId: open.sessionId,
        observedBy: ledger.selfDaemonId,
        attemptRef: { attemptId: open.attemptId, generation: open.generation },
        kind: 'cancel',
        reason: 'superseded',
    });
    if (result.verdict !== 'applied') {
        return { kind: 'refused', attempt: open, reason: 'cancel_not_applied', detail: `${result.verdict}${result.rejection ? ` (${result.rejection})` : ''}` };
    }
    // The retired attempt's worker tokens die with it (the task's do not): a
    // same-session retry must not exchange the stale one.
    afterBridgeCommit(store.db, () => expireWorkerTaskTokensForAttempt(meshId, taskId, open.attemptId));
    LOG.info('MeshQueue', `Requeue of task ${taskId} (mesh ${meshId}) retired its open attempt ${open.attemptId} g${open.generation} (${open.state} on ${open.sessionId}) — the next claim opens a fresh attempt`);
    return { kind: 'closed', attempt: open };
}

/**
 * The command answer for a requeue the turn ledger refused (both the med-family
 * `requeue_mesh_queue_task` and the turn-IPC `queue_requeue` handlers): never a
 * success, with the attempt that blocked it.
 */
export function requeueRefusalResponse(
    taskId: string,
    refusal: { reason: QueueAttemptRetirementRefusal; attempt: TurnAttempt; detail?: string },
    task: unknown,
): { success: false; error: string; code: 'requeue_refused_attempt_open'; refusalReason: QueueAttemptRetirementRefusal; attemptId: string; attemptState: TurnAttempt['state']; task: unknown } {
    const { attempt, reason } = refusal;
    const why = reason === 'attempt_open'
        ? 'Pass force:true to retire that attempt and requeue, or cancel and re-enqueue.'
        : reason === 'not_owner'
            ? `The attempt is owned by daemon ${attempt.ownerDaemonId}; requeue it there.`
            : reason === 'no_ledger'
                ? 'No turn ledger is active on this daemon to retire it.'
                : `The turn ledger did not apply the retirement${refusal.detail ? ` (${refusal.detail})` : ''}.`;
    return {
        success: false,
        error: `Task '${taskId}' was not requeued: its turn attempt ${attempt.attemptId} is still ${attempt.state} on session ${attempt.sessionId} (${reason}). ${why}`,
        code: 'requeue_refused_attempt_open',
        refusalReason: reason,
        attemptId: attempt.attemptId,
        attemptState: attempt.state,
        task,
    };
}

/** Claim-refusal backoff: 2 s, 4 s, 8 s … capped at 60 s. */
export const CLAIM_REFUSAL_BACKOFF_BASE_MS = 2_000;
export const CLAIM_REFUSAL_BACKOFF_MAX_MS = 60_000;

/**
 * The claim flipped the row `assigned` to the claiming session (and bumped
 * its nonce), then the ledger refused the dispatch because the task's attempt
 * is already running elsewhere. The row goes back to describing THAT run —
 * assigned to the attempt's session, the claim's nonce bump undone — instead
 * of `pending`, which every drain tick would re-claim. The refusal is counted
 * and arms an escalating `notBefore`, so any path that later returns the row
 * to `pending` cannot spin either.
 */
export function rebindRefusedClaimToOpenAttempt(meshId: string, taskId: string, attempt: TurnAttempt, now = Date.now()): MeshWorkQueueEntry | null {
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() => {
        const entry = store.findQueueEntryById(meshId, taskId);
        if (!entry || entry.status !== 'assigned') return entry;
        entry.assignedSessionId = attempt.sessionId;
        if (attempt.nodeId) entry.assignedNodeId = attempt.nodeId;
        else delete entry.assignedNodeId;
        if (attempt.providerType) entry.assignedProviderType = attempt.providerType;
        // The claiming session's model/profile were stamped by the refused claim.
        delete entry.assignedModel;
        delete entry.assignedTranscriptProfile;
        entry.attemptId = attempt.attemptId;
        entry.dispatchNonce = Math.max(0, (entry.dispatchNonce || 0) - 1);
        entry.dispatchTimestamp = new Date(attempt.deliveredAt ?? attempt.acceptedAt).toISOString();
        const refusals = (entry.claimRefusedCount || 0) + 1;
        entry.claimRefusedCount = refusals;
        const backoffMs = Math.min(CLAIM_REFUSAL_BACKOFF_BASE_MS * Math.pow(2, refusals - 1), CLAIM_REFUSAL_BACKOFF_MAX_MS);
        entry.notBefore = new Date(now + backoffMs).toISOString();
        store.updateQueueEntry(entry);
        return entry;
    });
}
