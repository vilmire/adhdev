// ---------------------------------------------------------------------------
// turn-ledger/suppression — deliver-time predicates for a `turn.notify` (C2)
// ---------------------------------------------------------------------------
// Wiring-unification C-W3. PURE predicates over the notice and the ledger's
// CURRENT view of its attempt, evaluated by the deliver consumer right before
// submit. They replace `mesh-event-suppression.ts` (1,229 lines) — most of
// which existed because the old path had no single authority and had to
// re-derive "is this still true?" from fingerprints, supersede windows and
// ledger scans (brief §2.3 layer 12, bucket c). With the reducer the only
// writer of turn state, the remaining questions are all "has the attempt moved
// past what this notice announces since it was written?":
//
//   approval / choice   → only while the attempt is still `suspended`
//                         (STALE-APPROVAL-AFTER-TERMINAL: a modal that resolved
//                         or a turn that ended leaves no actionable prompt);
//   candidate           → only while the attempt is still `finalizing`
//                         (the commit brings its own terminal notice);
//   no_progress         → only while the attempt is open;
//   progress            → only while the attempt is open;
//   terminal kinds, late_completion, approval_resolved, mesh_event → always.
//
// A notice whose attempt is unknown here (a re-issued foreign notice, or an
// attempt pruned since) is never suppressed — delivering a harmless stale
// notice beats silently dropping a real one.
// ---------------------------------------------------------------------------

import type { NotifyKind } from '@adhdev/mesh-shared';
import { isTerminalTurnState, type TurnState } from './types.js';

export type NotifySuppression =
    | 'stale_suspension'
    | 'candidate_superseded'
    | 'attempt_terminal';

export interface NotifySuppressionInput {
    notify: NotifyKind;
    /** The attempt as the ledger holds it NOW; null when unknown on this daemon. */
    attempt: { state: TurnState; generation: number; suspension: 'approval' | 'choice' | null } | null;
    /** Generation the notice was written for (from its row), when known. */
    generation?: number | null;
}

/** Null = deliver; otherwise the reason the notice is claimed without a submit. */
export function evaluateNotifySuppression(input: NotifySuppressionInput): NotifySuppression | null {
    const { notify, attempt } = input;
    if (!attempt) return null;
    // A notice for an OLDER generation of a live attempt is only ever
    // `late_completion` (R27) — which is always delivered below.
    switch (notify) {
        case 'approval':
        case 'choice': {
            if (attempt.state !== 'suspended') return 'stale_suspension';
            if (input.generation !== undefined && input.generation !== null && input.generation !== attempt.generation) return 'stale_suspension';
            return null;
        }
        case 'candidate':
            return attempt.state === 'finalizing' ? null : 'candidate_superseded';
        case 'no_progress':
        case 'progress':
            return isTerminalTurnState(attempt.state) ? 'attempt_terminal' : null;
        case 'completed':
        case 'failed':
        case 'cancelled':
        case 'stopped':
        case 'late_completion':
        case 'approval_resolved':
        case 'mesh_event':
            return null;
        default: {
            const never: never = notify;
            void never;
            return null;
        }
    }
}
