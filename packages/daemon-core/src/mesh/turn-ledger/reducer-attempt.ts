// Attempt construction helpers for the turn-ledger reducer (moved out of
// reducer.ts unchanged to keep it under the file-size gate).

import {
    type CommitStrength as TurnCommitStrength,
    type TurnEvidence,
    type TurnOutcome,
    type TurnReason,
} from '@adhdev/mesh-shared';
import { DEFAULT_MAX_TASK_RETRIES } from './policy.js';
import type { TurnAttempt } from './types.js';

export function newAttempt(ev: TurnEvidence, fields: Partial<TurnAttempt> & Pick<TurnAttempt, 'attemptId' | 'scope'>): TurnAttempt {
    return {
        meshId: null, taskId: ev.taskId ?? null, attemptNo: 0,
        sessionId: ev.sessionId, nodeId: null, providerType: null, ownerDaemonId: ev.observedBy,
        generation: ev.attemptRef?.generation ?? 0, prevGeneration: null, dispatchNonce: null, messageId: null,
        consumeProfile: 'default', maxTaskRetries: DEFAULT_MAX_TASK_RETRIES,
        state: 'accepted', suspension: null, redriveCount: 0, reclaimCount: 0, hollowCount: 0, livenessFailStreak: 0, lastLiveness: null,
        coordinator: { daemonId: null, sessionId: null },
        acceptedAt: ev.at, deliveredAt: null, consumedAt: null, lastActivityAt: null, weakSince: null,
        candidateNotifiedGeneration: null, lastNoProgressNoticeAt: null, notifiedAt: null, terminal: null, data: {},
        ...fields,
    };
}

/** The terminal a genuine g−1 completion commits when R27a adopts it. */
export function adoptedTerminal(ev: TurnEvidence): { outcome: TurnOutcome; strength: TurnCommitStrength; reason: TurnReason } {
    if (ev.kind === 'worker_report') {
        return { outcome: ev.outcome, strength: 'tool_report', reason: 'worker_reported' };
    }
    if (ev.kind === 'transcript_final') return { outcome: 'completed', strength: 'genuine', reason: 'transcript_final' };
    return { outcome: 'completed', strength: 'genuine', reason: 'turn_end' };
}
