/**
 * mesh_direct_cancel — cancel one `mesh_direct` turn attempt through the turn
 * ledger (the MCP `mesh_direct_cancel` tool's daemon half).
 *
 * It reuses the ledger's `cancel` evidence (the same path as `turn_cancel` and
 * `mesh_queue_cancel`'s writer stop): rule R22 records a durable stop intent and
 * the proof-fenced writer-stop executor stops the exact session. It NEVER
 * releases a claim by itself — a still-running writer keeps the attempt in
 * `stopping` until the stop is settled with proof.
 *
 * Guards (each answers a distinct, machine-readable code):
 *   - unknown attempt                → success:false, `attempt_not_found`
 *   - not a `mesh_direct` attempt    → success:false, `not_direct_attempt`
 *                                       (queue attempts are cancelled with mesh_queue_cancel)
 *   - owned by another daemon        → success:false, `ledger_not_owner` (never forwarded:
 *                                       the caller must ask the owner's daemon)
 *   - already terminal               → success:true, `noop:true` (nothing is written)
 */
import { randomUUID } from 'crypto';
import { CANCEL_REASONS, daemonIdsEquivalent, type CancelReason, type TurnEvidence } from '@adhdev/mesh-shared';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { getActiveTurnLedger } from '../../mesh/turn-ledger/active-ledger.js';
import type { TurnLedger } from '../../mesh/turn-ledger/ledger.js';
import { isTerminalTurnState } from '../../mesh/turn-ledger/types.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

function failure(code: string, error: string): { success: false; error: string; code: string } {
    return { success: false, error: `mesh_direct_cancel: ${error}`, code };
}

function readId(value: unknown): string | undefined {
    return typeof value === 'string' && ID_RE.test(value.trim()) ? value.trim() : undefined;
}

export const meshDirectCancel: LowFamilyHandler = async (ctx: LowFamilyContext, args: any) => {
    const attemptId = readId(args?.attemptId);
    const taskId = readId(args?.taskId);
    const meshId = readId(args?.meshId);
    if ((args?.attemptId !== undefined && !attemptId) || (args?.taskId !== undefined && !taskId)) {
        return failure('bad_request', 'attemptId/taskId must be plain identifiers');
    }
    if (!!attemptId === !!taskId) return failure('bad_request', 'exactly one of attemptId or taskId is required');
    const rawReason = args?.reason;
    if (rawReason !== undefined && !(typeof rawReason === 'string' && (CANCEL_REASONS as readonly string[]).includes(rawReason))) {
        return failure('bad_request', `reason must be one of ${CANCEL_REASONS.join(', ')}`);
    }
    const reason: CancelReason = (rawReason as CancelReason | undefined) ?? 'operator_cancel';

    const ledger = getActiveTurnLedger();
    if (!ledger) return failure('turn_ledger_unavailable', 'no active turn ledger');

    try {
        const store = ledger.store as unknown as {
            findLatestAttemptForTask(meshId: string | null, taskId: string): ReturnType<TurnLedger['getAttempt']>;
        };
        const attempt = attemptId ? ledger.getAttempt(attemptId) : store.findLatestAttemptForTask(meshId ?? null, taskId!);
        if (!attempt || (meshId && attempt.meshId !== meshId)) {
            return failure('attempt_not_found', 'no attempt found for the given attemptId/taskId');
        }
        if (attempt.scope !== 'mesh_direct') {
            return failure('not_direct_attempt', `attempt ${attempt.attemptId} is a ${attempt.scope} attempt; use mesh_queue_cancel for queue tasks`);
        }
        if (!daemonIdsEquivalent(attempt.ownerDaemonId, ledger.selfDaemonId)) {
            return failure('ledger_not_owner', `attempt ${attempt.attemptId} is owned by another daemon; run the cancel on the owner`);
        }
        const attemptRef = { attemptId: attempt.attemptId, generation: attempt.generation };
        if (attempt.terminal || isTerminalTurnState(attempt.state)) {
            return {
                success: true, noop: true, attemptRef, state: attempt.state,
                ...(attempt.terminal ? { terminalOutcome: attempt.terminal.outcome } : {}),
            };
        }
        const evidence: TurnEvidence = {
            eventId: randomUUID(),
            at: Date.now(),
            source: 'mcp_probe',
            sessionId: attempt.sessionId,
            observedBy: ctx.deps.statusInstanceId ?? ledger.selfDaemonId,
            attemptRef,
            kind: 'cancel',
            reason,
        };
        const result = ledger.observe(evidence);
        if (result.verdict === 'rejected') {
            return failure('cancel_rejected', `ledger rejected the cancel (${result.rejection ?? 'unknown'})`);
        }
        const after = ledger.getAttempt(attempt.attemptId);
        return {
            success: true, noop: false, attemptRef, verdict: result.verdict,
            state: after?.state ?? attempt.state,
            // `stopping` = a durable stop intent is recorded and the writer is NOT yet proven stopped.
            stopPending: after?.state === 'stopping',
        };
    } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
    }
};
