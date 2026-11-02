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
    | 'attempt_terminal'
    /** Review-in-task: a stage-internal row's notice (review child / held stage parent) never wakes the coordinator. */
    | 'stage_internal'
    /** The coordinator was already woken for this exact fact (same attempt, generation and kind). */
    | 'duplicate_wake';

interface NotifySuppressionInput {
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
        case 'blocked':
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

// ─── wake keys & hold classes (2026-11-02, coordinator-turn budget) ────────

/**
 * Kinds that state a one-off FACT about an attempt generation. The reducer already writes at most
 * one such notice row per (attempt, generation, kind) for terminals, but `late_completion` rows
 * are keyed by their cause evidence (turn_end + worker_report + transcript_final of the same
 * superseded run each wrote one), and a relayed, re-issued or backlog-redelivered notice is a
 * different row for the same fact. `no_progress` and `candidate` are deliberately NOT keyed: the
 * reducer already limits them (once per attempt / once per generation), and a writer-checkpoint
 * `no_progress` notice is a different, action-bearing message that a stall wake must never mask. The wake key makes the
 * deliver step itself idempotent on the FACT: the first delivered/queued/surfaced notice claims
 * the key; later rows for the same fact are suppressed as `duplicate_wake`. The key is stored on
 * the delivery claim row, so it survives a daemon restart; a released claim (composer-residue
 * recovery) frees it again, so a notice that never reached the composer is still retried.
 */
const WAKE_ONCE_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>([
    'completed', 'failed', 'cancelled', 'stopped', 'blocked', 'late_completion',
]);

export function noticeWakeKey(input: { meshId: string; notify: NotifyKind; attemptId?: string | null; generation?: number | null }): string | null {
    if (!WAKE_ONCE_KINDS.has(input.notify) || !input.attemptId) return null;
    return `${input.meshId}|${input.attemptId}|g${input.generation ?? '-'}|${input.notify}`;
}

/**
 * Informational notices may wait up to `coalesceWindowMs` for company so that several arriving
 * together cost the coordinator ONE turn. Everything that states an outcome, a block, a failure,
 * a question or an approval — and the mesh events a blocked coordinator waits on — is never held.
 */
const HOLDABLE_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>(['progress', 'no_progress', 'candidate']);

export function isHoldableNotice(notify: NotifyKind, forceInjectEvent: boolean): boolean {
    if (notify === 'mesh_event') return !forceInjectEvent;
    return HOLDABLE_KINDS.has(notify);
}
