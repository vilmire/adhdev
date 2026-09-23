// ---------------------------------------------------------------------------
// mesh-queue-dispatch-evidence — the queue claim's attempt, as ledger evidence
// ---------------------------------------------------------------------------
// Wiring-unification C2/C4 (C-W4). The queue claim path (mesh-queue-assignment)
// no longer opens / acks / closes / rebinds attempt rows itself — the legacy
// openTurnAttempt / recordTurnAck / closeAttemptForReassignment /
// rebindAttemptToLiveHolder writers are retired. It reports `dispatch_accepted`
// here (R1 opens the attempt with its await_delivery + hard_ceiling holds) and
// `delivered` / `dispatch_failed` / `duplicate_dispatch_refusal` from the
// transport callbacks; queue-row changes (reclaim → pending, commit → terminal)
// are ledger effects. Kept a leaf (type-only ledger imports) so it is testable
// without loading the claim path's import graph.
// ---------------------------------------------------------------------------

import type { ConsumeProfile, TurnAttemptRef } from '@adhdev/mesh-shared';
import type { TurnLedger } from './turn-ledger/ledger.js';
import type { TurnAttempt } from './turn-ledger/types.js';

/** The slice of a queue row this module reads. */
export interface QueueDispatchTask {
    id: string;
    dispatchNonce?: number;
    sourceCoordinatorSessionId?: string;
}

/** The task's dispatch message identity (D1): stable across a same-nonce redeliver. */
export function dispatchMessageId(task: QueueDispatchTask): string {
    return `task:${task.id}:n${task.dispatchNonce ?? 0}`;
}

/** Attempt id of a queue task's Nth attempt (UNIQUE (mesh_id, task_id, attempt_no)). */
export function queueAttemptId(meshId: string, taskId: string, attemptNo: number): string {
    return `mesh_queue:${meshId}:${taskId}:${attemptNo}`;
}

/** States in which the attempt already consumed a prompt — a second injection would double-execute. */
export const INJECTION_CLOSED_STATES: ReadonlySet<TurnAttempt['state']> = new Set(['consumed', 'generating', 'suspended', 'finalizing']);

/**
 * Open (dispatch_accepted → R1) or resume (after a reclaim the attempt is back
 * at `accepted` under generation + 1) the attempt this claim dispatches.
 * `refused` = the open attempt already consumed a prompt (the old
 * assertPromptInjectionAllowed guard). A terminal latest attempt is a retry:
 * attemptNo + 1 opens a fresh row.
 */
export function openOrResumeQueueAttempt(ledger: Pick<TurnLedger, 'store' | 'observe'>, args: {
    meshId: string;
    task: QueueDispatchTask;
    nodeId: string;
    sessionId: string;
    providerType: string;
    consumeProfile: ConsumeProfile;
    maxTaskRetries: number;
    coordinatorDaemonId?: string;
    now?: number;
}): { ref: TurnAttemptRef } | { refused: TurnAttempt } {
    const latest = ledger.store.findLatestAttemptForTask(args.meshId, args.task.id);
    if (latest && !latest.terminal) {
        if (INJECTION_CLOSED_STATES.has(latest.state)) return { refused: latest };
        return { ref: { attemptId: latest.attemptId, generation: latest.generation } };
    }
    const attemptNo = latest ? latest.attemptNo + 1 : 0;
    const attemptId = queueAttemptId(args.meshId, args.task.id, attemptNo);
    const coordinatorDaemonId = args.coordinatorDaemonId;
    const coordinatorSessionId = typeof args.task.sourceCoordinatorSessionId === 'string' ? args.task.sourceCoordinatorSessionId.trim() : '';
    const ref = { attemptId, generation: 0 };
    const result = ledger.observe({
        eventId: `dispatch:${attemptId}`,
        at: args.now ?? Date.now(),
        source: 'dispatch',
        sessionId: args.sessionId,
        attemptRef: ref,
        // The attempt's task binding: R1's open_dispatch reads the envelope taskId
        // (the queue_status / graph_advance effects key on it).
        taskId: args.task.id,
        observedBy: coordinatorDaemonId || 'local',
        kind: 'dispatch_accepted',
        scope: 'mesh_queue',
        messageId: dispatchMessageId(args.task),
        meshId: args.meshId,
        nodeId: args.nodeId,
        providerType: args.providerType,
        attemptNo,
        ...(typeof args.task.dispatchNonce === 'number' ? { dispatchNonce: args.task.dispatchNonce } : {}),
        consumeProfile: args.consumeProfile,
        maxTaskRetries: args.maxTaskRetries,
        ...(coordinatorDaemonId ? {
            coordinator: {
                daemonId: coordinatorDaemonId,
                // The coordinator run id is not known on the claim path (contracts.ts
                // notes the same gap for every emit site); the daemon id stands in.
                coordinatorRunId: coordinatorDaemonId,
                ...(coordinatorSessionId ? { sessionId: coordinatorSessionId } : {}),
            },
        } : {}),
    });
    if (result.verdict === 'rejected') throw new Error(`dispatch_accepted rejected (${result.rejection ?? 'unknown'})`);
    return { ref };
}
