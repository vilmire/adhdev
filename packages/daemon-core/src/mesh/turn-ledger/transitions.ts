// ---------------------------------------------------------------------------
// turn-ledger/transitions — the turn state machine as DATA
// ---------------------------------------------------------------------------
// Wiring-unification Phase C1 (plan §2.3, R0–R35 + H1–H7). The reducer
// iterates this table; a table test proves every rule fires from a minimal
// fixture, that at most one rule matches any (lane, state, kind, guard
// variant), and that the (state, kind) pairs no rule covers are exactly the
// enumerated illegal ones.
//
// Matching: a rule matches when its lane equals the evidence lane, `from`
// contains the attempt state, `on` contains the evidence kind and its guard
// passes. `guard: 'otherwise'` passes only when no other non-otherwise rule
// of the same lane/state/kind passes (explicit fall-through, never ordering).
//
// Lanes (decided before any rule, reducer.ts classifyLane):
//   none    — no attempt resolved
//   stale   — evidence belongs to another generation (R27a adopts, R27/R28 record)
//   current — everything else, including terminal attempts
//
// Ids suffixed with a letter (R0a, R3a, R6s, R17p, H2r, …) are rules the plan
// described inside another row's prose; they are split out so every rule has
// one target and one verdict. Owner rows: R17/R18 (worker report is primary,
// later scrape recorded); R27/R27a (revised 2026-09-23, design §5 "What
// changed"): a reclaim cuts g−1 first (cancel_dispatch + worker-bind revoke,
// reducer.ts reclaim); a genuine g−1 completion that still arrives is ADOPTED
// while g has not started (R27a: commit g−1's outcome, cancel g, one notice)
// and RECORDED + `late_completion`-notified once g is running or done (R27 —
// never auto-adopted: g−1 was reclaimed for a reason and g may have diverged).
// ---------------------------------------------------------------------------

import {
    TERMINAL_CLASS_EVIDENCE_KINDS,
    TURN_EVIDENCE_KINDS,
    type CommitStrength,
    type HoldReason,
    type NotifyKind,
    type TurnEvidenceKind,
    type TurnOutcome,
    type TurnReason,
} from '@adhdev/mesh-shared';
import type { HoldOnExpire, TurnBusEvent, TurnState } from './types.js';

export type RuleLane = 'none' | 'current' | 'stale';

/** `none` is the lane-none pseudo state; `any` includes terminal states. */
export type RuleFrom = readonly TurnState[] | 'none' | 'nonterminal' | 'terminal' | 'any';

export type GuardId =
    | 'otherwise'
    | 'unbound' | 'bound'
    | 'prev_generation_completion' | 'stale_session_distinct'
    | 'reclaiming_refusal'
    | 'suspension_changed'
    | 'end_genuine' | 'end_weak' | 'end_weak_after_timeout' | 'hollow_retry' | 'hollow_exhausted'
    | 'end_report_awaited' | 'end_report_awaited_held' | 'final_strong_report_awaited' | 'false_idle_resumed'
    | 'final_strong' | 'final_weak'
    | 'genuine_end_or_strong_final' | 'weak_end_or_final'
    | 'admission_hold' | 'admission_decline'
    | 'after_weak_since' | 'activity_keeps_state'
    | 'liveness_unknown' | 'liveness_fatal' | 'liveness_failed_nonfatal'
    | 'reported_terminal'
    | 'provider_failure' | 'no_provider_failure'
    | 'holder_is_this_attempt'
    | 'final_present'
    | 'hold_await_delivery' | 'hold_await_consume_redrive' | 'hold_await_consume_exhausted' | 'hold_await_turn'
    | 'hold_liveness' | 'hold_hard_ceiling' | 'hold_suspension_before_consumed' | 'hold_weak_candidate' | 'hold_admission'
    | 'hold_await_report';

/** Named attempt mutations (reducer.ts ACTIONS). */
export type ActionId =
    | 'open_dispatch' | 'open_plain'
    | 'mark_delivered' | 'consume' | 'apply_held_suspension'
    | 'suspend' | 'resume' | 'resume_by_activity'
    | 'weak_candidate' | 'clear_weak' | 'await_report' | 'false_idle'
    | 'activity' | 'liveness_unknown' | 'liveness_failure' | 'worker_absent'
    | 'rebind_to_holder' | 'rebind'
    | 'hollow' | 'mark_notified' | 'store_git' | 'redrive' | 'stamp_no_progress_notice';

/** Hold deadline expressions, resolved against policy + ledger clock. */
export type UntilExpr =
    | 'await_delivery' | 'await_consume' | 'await_turn' | 'liveness' | 'hard_ceiling'
    | 'weak_confirm' | 'unknown_grace' | 'liveness_reprobe' | 'admission' | 'await_report' | 'none';

export type EffectTemplate =
    | { e: 'act'; act: ActionId }
    | { e: 'hold'; reason: HoldReason | 'from_admission'; until: UntilExpr; onExpire: HoldOnExpire; meshOnly?: true; generationAgnostic?: true }
    | { e: 'release'; reasons: readonly HoldReason[] | '*' | 'expired_hold' }
    | { e: 'commit'; outcome: TurnOutcome | 'from_report' | 'from_operator'; strength: CommitStrength; reason: TurnReason | 'from_cancel' | 'from_operator' | 'from_provider_failure' }
    | { e: 'reclaim'; reason: TurnReason | 'from_refusal' | 'from_exit_state' }
    | { e: 'notify'; notify: NotifyKind | 'from_modal'; when?: 'candidate_once' | 'no_progress_due'
        /** `evidence` = the notice names the evidence's (stale) generation, not the attempt's. */
        generation?: 'evidence' }
    /** R27a: commit g−1's outcome onto the attempt, cutting g first. */
    | { e: 'adopt_prev_generation' }
    | { e: 'bus'; phase: Exclude<TurnBusEvent['phase'], 'committed'> }
    | { e: 'record'; note: string | 'from_terminal_compare' | 'from_admission' }
    | { e: 'cancel_dispatch'; target: 'current' | 'evidence_session'; when?: 'not_intentional_cleanup' }
    | { e: 'redeliver' }
    | { e: 'probe' }
    | { e: 'reevaluate' };

export interface TransitionRule {
    id: string;
    lane: RuleLane;
    from: RuleFrom;
    on: readonly TurnEvidenceKind[];
    guard?: GuardId;
    /**
     * Nominal target. `outcome` = the commit's outcome. Reclaim rules name
     * `accepted`; the reducer turns a reclaim into `failed` when the budget is
     * spent or the attempt is plain or `mesh_direct` (nothing redelivers a
     * direct dispatch — reducer.ts `reclaim`). R4 names `generating`; a held suspension
     * turns it into `suspended`.
     */
    to: TurnState | 'same' | 'outcome';
    verdict: 'applied' | 'recorded';
    effects: readonly EffectTemplate[];
}

const A = 'accepted', D = 'delivered', C = 'consumed', G = 'generating', S = 'suspended', F = 'finalizing';
const ALL_KINDS = TURN_EVIDENCE_KINDS;
const AWAITS: readonly HoldReason[] = ['await_delivery', 'await_consume', 'await_turn'];

const livenessExtend: EffectTemplate = { e: 'hold', reason: 'liveness', until: 'liveness', onExpire: 'escalate' };
const weakCandidate: readonly EffectTemplate[] = [
    { e: 'act', act: 'weak_candidate' },
    { e: 'hold', reason: 'weak_candidate', until: 'weak_confirm', onExpire: 'commit' },
    { e: 'notify', notify: 'candidate', when: 'candidate_once' },
];

export const TRANSITIONS: readonly TransitionRule[] = [
    // ── lane none: no attempt resolved ──────────────────────────────────
    { id: 'R1', lane: 'none', from: 'none', on: ['dispatch_accepted'], to: A, verdict: 'applied', effects: [
        { e: 'act', act: 'open_dispatch' },
        { e: 'hold', reason: 'await_delivery', until: 'await_delivery', onExpire: 'reclaim', meshOnly: true },
        { e: 'hold', reason: 'hard_ceiling', until: 'hard_ceiling', onExpire: 'escalate', meshOnly: true, generationAgnostic: true },
    ] },
    { id: 'R0a', lane: 'none', from: 'none', on: ['turn_started'], guard: 'unbound', to: G, verdict: 'applied', effects: [
        { e: 'act', act: 'open_plain' },
        { e: 'act', act: 'consume' },
        { e: 'bus', phase: 'started' },
    ] },
    { id: 'R0b', lane: 'none', from: 'none', on: ['turn_started'], guard: 'bound', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'no_attempt' },
    ] },
    { id: 'R0', lane: 'none', from: 'none', on: ALL_KINDS.filter((k) => k !== 'dispatch_accepted' && k !== 'turn_started'), to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'no_attempt' },
    ] },

    // ── lane stale: another generation (owner revision 2026-09-23) ──────
    // g has no turn_started yet (accepted/delivered): adopt g−1's genuine
    // completion — commit it, cancel g's dispatch, one notice.
    { id: 'R27a', lane: 'stale', from: [A, D], on: ['turn_end', 'worker_report', 'transcript_final'], guard: 'prev_generation_completion', to: 'outcome', verdict: 'applied', effects: [
        { e: 'adopt_prev_generation' },
    ] },
    // g is running (or already terminal): never mutate g; record g−1's verdict
    // and tell the coordinator, who decides whether to salvage g−1's work.
    { id: 'R27', lane: 'stale', from: [C, G, S, F, 'completed', 'failed', 'cancelled'], on: ['turn_end', 'worker_report', 'transcript_final'], guard: 'prev_generation_completion', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'late_completion_prev_generation' },
        { e: 'notify', notify: 'late_completion', generation: 'evidence' },
    ] },
    { id: 'R28a', lane: 'stale', from: 'any', on: ['turn_started'], guard: 'stale_session_distinct', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'stale_generation' },
        { e: 'cancel_dispatch', target: 'evidence_session' },
    ] },
    { id: 'R28', lane: 'stale', from: 'any', on: ALL_KINDS, guard: 'otherwise', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'stale_generation' },
    ] },

    // ── dispatch / delivery ─────────────────────────────────────────────
    { id: 'R2', lane: 'current', from: [A, D], on: ['delivered'], to: D, verdict: 'applied', effects: [
        { e: 'act', act: 'mark_delivered' },
        { e: 'release', reasons: ['await_delivery'] },
        { e: 'hold', reason: 'await_consume', until: 'await_consume', onExpire: 'redeliver', meshOnly: true },
        { e: 'hold', reason: 'await_turn', until: 'await_turn', onExpire: 'reclaim', meshOnly: true },
    ] },
    { id: 'R2a', lane: 'current', from: [C, G, S, F], on: ['delivered'], to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'late_delivery_ack' },
    ] },
    { id: 'R3', lane: 'current', from: [A, D], on: ['delivery_refused'], guard: 'reclaiming_refusal', to: A, verdict: 'applied', effects: [
        { e: 'reclaim', reason: 'from_refusal' },
    ] },
    { id: 'R3a', lane: 'current', from: [A, D], on: ['delivery_refused'], guard: 'otherwise', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'delivery_refused_retryable' },
    ] },
    { id: 'R24', lane: 'current', from: [A, D], on: ['dispatch_failed'], to: A, verdict: 'applied', effects: [
        { e: 'act', act: 'worker_absent' },
        { e: 'reclaim', reason: 'dispatch_failed' },
    ] },
    { id: 'R25', lane: 'current', from: [A, D], on: ['duplicate_dispatch_refusal'], guard: 'holder_is_this_attempt', to: C, verdict: 'applied', effects: [
        { e: 'act', act: 'rebind_to_holder' },
        { e: 'act', act: 'consume' },
        { e: 'release', reasons: AWAITS },
        livenessExtend,
    ] },
    { id: 'R25a', lane: 'current', from: [A, D], on: ['duplicate_dispatch_refusal'], guard: 'otherwise', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'foreign_holder' },
    ] },
    { id: 'R26', lane: 'current', from: 'nonterminal', on: ['session_rebound'], to: 'same', verdict: 'applied', effects: [
        { e: 'act', act: 'rebind' },
    ] },

    // ── turn start / suspension ─────────────────────────────────────────
    { id: 'R4', lane: 'current', from: [A, D, C], on: ['turn_started'], to: G, verdict: 'applied', effects: [
        { e: 'act', act: 'consume' },
        { e: 'release', reasons: AWAITS },
        livenessExtend,
        { e: 'bus', phase: 'started' },
        { e: 'act', act: 'apply_held_suspension' },
    ] },
    { id: 'R5', lane: 'current', from: [A, D], on: ['suspension'], to: 'same', verdict: 'applied', effects: [
        { e: 'hold', reason: 'suspension_before_consumed', until: 'none', onExpire: 'release' },
    ] },
    { id: 'R5b', lane: 'current', from: [A, D], on: ['suspension_resolved'], to: 'same', verdict: 'applied', effects: [
        { e: 'release', reasons: ['suspension_before_consumed'] },
    ] },
    { id: 'R6', lane: 'current', from: [C, G, F], on: ['suspension'], to: S, verdict: 'applied', effects: [
        { e: 'act', act: 'suspend' },
        { e: 'release', reasons: ['weak_candidate', 'live_pending', 'transcript_quiet', 'await_report'] },
        { e: 'bus', phase: 'suspended' },
        { e: 'notify', notify: 'from_modal' },
    ] },
    { id: 'R6s', lane: 'current', from: [S], on: ['suspension'], guard: 'suspension_changed', to: S, verdict: 'applied', effects: [
        { e: 'act', act: 'suspend' },
        { e: 'bus', phase: 'suspended' },
        { e: 'notify', notify: 'from_modal' },
    ] },
    { id: 'R6d', lane: 'current', from: [S], on: ['suspension'], guard: 'otherwise', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'duplicate_suspension' },
    ] },
    { id: 'R7', lane: 'current', from: [S], on: ['suspension_resolved'], to: G, verdict: 'applied', effects: [
        { e: 'act', act: 'resume' },
        { e: 'bus', phase: 'resumed' },
        { e: 'notify', notify: 'approval_resolved' },
    ] },
    { id: 'R8', lane: 'current', from: [S], on: ['turn_started', 'transcript_activity'], to: G, verdict: 'applied', effects: [
        { e: 'act', act: 'resume_by_activity' },
        { e: 'release', reasons: ['live_pending', 'transcript_quiet', 'weak_candidate'] },
        livenessExtend,
        { e: 'bus', phase: 'resumed' },
    ] },

    // ── turn end ────────────────────────────────────────────────────────
    { id: 'R9', lane: 'current', from: [C, G, S], on: ['turn_end'], guard: 'end_genuine', to: 'completed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'completed', strength: 'genuine', reason: 'turn_end' },
    ] },
    { id: 'R10', lane: 'current', from: [C, G, S], on: ['turn_end'], guard: 'end_weak', to: F, verdict: 'applied', effects: weakCandidate },
    { id: 'R10a', lane: 'current', from: [F], on: ['turn_end', 'transcript_final'], guard: 'weak_end_or_final', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'duplicate_weak_end' },
    ] },
    { id: 'R11', lane: 'current', from: [F], on: ['turn_end', 'transcript_final'], guard: 'genuine_end_or_strong_final', to: 'completed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'completed', strength: 'genuine', reason: 'transcript_final' },
    ] },
    { id: 'R12', lane: 'current', from: [F], on: ['turn_started', 'transcript_activity'], guard: 'after_weak_since', to: G, verdict: 'applied', effects: [
        { e: 'act', act: 'clear_weak' },
        { e: 'act', act: 'activity' },
        { e: 'release', reasons: ['weak_candidate'] },
        livenessExtend,
    ] },
    { id: 'R13b', lane: 'current', from: [C, G, S, F], on: ['turn_end'], guard: 'end_weak_after_timeout', to: 'failed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'failed', strength: 'weak', reason: 'finalization_timeout_no_response' },
    ] },
    { id: 'R14', lane: 'current', from: [C, G, S], on: ['transcript_final'], guard: 'final_strong', to: 'completed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'completed', strength: 'genuine', reason: 'transcript_final' },
    ] },
    { id: 'R15', lane: 'current', from: [C, G, S], on: ['transcript_final'], guard: 'final_weak', to: F, verdict: 'applied', effects: weakCandidate },
    { id: 'R16', lane: 'current', from: [C, G, S, F], on: ['turn_end', 'transcript_final'], guard: 'admission_hold', to: 'same', verdict: 'applied', effects: [
        { e: 'hold', reason: 'from_admission', until: 'admission', onExpire: 'reevaluate' },
    ] },
    { id: 'R16a', lane: 'current', from: [C, G, S, F], on: ['transcript_final'], guard: 'admission_decline', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'from_admission' },
    ] },
    { id: 'R33', lane: 'current', from: [C, G, S, F], on: ['turn_end'], guard: 'hollow_retry', to: A, verdict: 'applied', effects: [
        { e: 'act', act: 'hollow' },
        { e: 'reclaim', reason: 'hollow_completion' },
    ] },
    // ── report-awaiting end (live rc.40, 2026-09-24) ───────────────────
    // The worker holds a live worker-MCP bind (the worker daemon stamps
    // `reportExpected` on its turn_end), so its structured report is the
    // primary completion evidence (design §F2) and a genuine FSM idle edge is
    // only corroboration: a Bash tool call (`sleep 240`) showed an idle screen
    // 37 s into a 4-minute turn and R9 committed it genuine. R9r opens an
    // `await_report` hold instead of committing; R17 commits on the report,
    // R12r cancels the candidate when the worker goes busy again (false idle),
    // R13r commits weak when the hold expires with no report. Sessions with no
    // bind never set `reportExpected` and keep R9 exactly.
    { id: 'R9r', lane: 'current', from: [C, G, S, F], on: ['turn_end'], guard: 'end_report_awaited', to: F, verdict: 'applied', effects: [
        { e: 'act', act: 'await_report' },
        { e: 'release', reasons: ['weak_candidate'] },
        { e: 'hold', reason: 'await_report', until: 'await_report', onExpire: 'commit', meshOnly: true },
    ] },
    { id: 'R9d', lane: 'current', from: [F], on: ['turn_end'], guard: 'end_report_awaited_held', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'await_report_duplicate_end' },
    ] },
    { id: 'R11d', lane: 'current', from: [F], on: ['transcript_final'], guard: 'final_strong_report_awaited', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'await_report_transcript_final' },
    ] },
    { id: 'R12r', lane: 'current', from: [F], on: ['turn_started', 'transcript_activity'], guard: 'false_idle_resumed', to: G, verdict: 'applied', effects: [
        { e: 'act', act: 'false_idle' },
        { e: 'release', reasons: ['await_report'] },
        livenessExtend,
        { e: 'bus', phase: 'resumed' },
        { e: 'record', note: 'false_idle_worker_resumed' },
    ] },
    { id: 'R33f', lane: 'current', from: [C, G, S, F], on: ['turn_end'], guard: 'hollow_exhausted', to: 'failed', verdict: 'applied', effects: [
        { e: 'act', act: 'hollow' },
        { e: 'commit', outcome: 'failed', strength: 'genuine', reason: 'hollow_max_retries' },
    ] },

    // ── worker MCP (F2): the report is the primary completion evidence ──
    { id: 'R17', lane: 'current', from: 'nonterminal', on: ['worker_report'], to: 'outcome', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'from_report', strength: 'tool_report', reason: 'worker_reported' },
    ] },
    { id: 'R17p', lane: 'current', from: 'nonterminal', on: ['worker_progress'], to: 'same', verdict: 'applied', effects: [
        { e: 'bus', phase: 'progress' },
        { e: 'notify', notify: 'progress' },
    ] },

    // ── terminal attempts ───────────────────────────────────────────────
    { id: 'R18', lane: 'current', from: 'terminal', on: ['turn_end', 'transcript_final', 'no_progress'], guard: 'reported_terminal', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'after_report' },
    ] },
    { id: 'R19', lane: 'current', from: 'terminal', on: TERMINAL_CLASS_EVIDENCE_KINDS, guard: 'otherwise', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'from_terminal_compare' },
    ] },
    { id: 'R34', lane: 'current', from: 'any', on: ['coordinator_ack'], to: 'same', verdict: 'applied', effects: [
        { e: 'act', act: 'mark_notified' },
    ] },

    // ── session end / errors / operator ─────────────────────────────────
    { id: 'R20', lane: 'current', from: 'nonterminal', on: ['process_exit'], guard: 'no_provider_failure', to: A, verdict: 'applied', effects: [
        { e: 'reclaim', reason: 'from_exit_state' },
    ] },
    { id: 'R20f', lane: 'current', from: 'nonterminal', on: ['process_exit'], guard: 'provider_failure', to: 'failed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'failed', strength: 'genuine', reason: 'from_provider_failure' },
    ] },
    { id: 'R21', lane: 'current', from: 'nonterminal', on: ['session_error'], to: 'failed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'failed', strength: 'genuine', reason: 'session_error' },
    ] },
    { id: 'R22', lane: 'current', from: 'nonterminal', on: ['cancel'], to: 'cancelled', verdict: 'applied', effects: [
        { e: 'cancel_dispatch', target: 'current', when: 'not_intentional_cleanup' },
        { e: 'commit', outcome: 'cancelled', strength: 'operator', reason: 'from_cancel' },
    ] },
    { id: 'R23', lane: 'current', from: 'nonterminal', on: ['operator_status'], to: 'outcome', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'from_operator', strength: 'operator', reason: 'from_operator' },
    ] },

    // ── progress / liveness ─────────────────────────────────────────────
    { id: 'R29', lane: 'current', from: [C, G], on: ['no_progress'], guard: 'final_present', to: F, verdict: 'applied', effects: weakCandidate },
    { id: 'R30', lane: 'current', from: [C, G, S, F], on: ['no_progress'], guard: 'otherwise', to: 'same', verdict: 'applied', effects: [
        { e: 'notify', notify: 'no_progress', when: 'no_progress_due' },
    ] },
    { id: 'R31', lane: 'current', from: [C, G, S, F], on: ['liveness'], guard: 'liveness_fatal', to: A, verdict: 'applied', effects: [
        { e: 'act', act: 'liveness_failure' },
        { e: 'reclaim', reason: 'session_dead' },
    ] },
    { id: 'R31a', lane: 'current', from: [C, G, S, F], on: ['liveness'], guard: 'liveness_failed_nonfatal', to: 'same', verdict: 'applied', effects: [
        { e: 'act', act: 'liveness_failure' },
    ] },
    { id: 'R32', lane: 'current', from: [C, G, S, F], on: ['liveness', 'transcript_activity', 'turn_started'], guard: 'activity_keeps_state', to: 'same', verdict: 'applied', effects: [
        { e: 'act', act: 'activity' },
        livenessExtend,
    ] },
    { id: 'R32u', lane: 'current', from: [C, G, S, F], on: ['liveness'], guard: 'liveness_unknown', to: 'same', verdict: 'applied', effects: [
        { e: 'act', act: 'liveness_unknown' },
        { e: 'hold', reason: 'liveness', until: 'liveness_reprobe', onExpire: 'escalate' },
    ] },
    { id: 'R35', lane: 'current', from: [C, G, S, F], on: ['git_side_effect'], to: 'same', verdict: 'applied', effects: [
        { e: 'act', act: 'store_git' },
    ] },

    // ── hold expiry ─────────────────────────────────────────────────────
    { id: 'H1', lane: 'current', from: [A], on: ['hold_expired'], guard: 'hold_await_delivery', to: A, verdict: 'applied', effects: [
        { e: 'reclaim', reason: 'assigned_stranded_dispatch_unconfirmed' },
    ] },
    { id: 'H2', lane: 'current', from: [D], on: ['hold_expired'], guard: 'hold_await_consume_redrive', to: D, verdict: 'applied', effects: [
        { e: 'act', act: 'redrive' },
        { e: 'redeliver' },
        { e: 'hold', reason: 'await_consume', until: 'await_consume', onExpire: 'redeliver', meshOnly: true },
    ] },
    { id: 'H2r', lane: 'current', from: [D], on: ['hold_expired'], guard: 'hold_await_consume_exhausted', to: A, verdict: 'applied', effects: [
        { e: 'reclaim', reason: 'delivered_not_consumed_redrive' },
    ] },
    { id: 'H3', lane: 'current', from: [D], on: ['hold_expired'], guard: 'hold_await_turn', to: A, verdict: 'applied', effects: [
        { e: 'reclaim', reason: 'delivered_no_turn_deadline' },
    ] },
    { id: 'H4', lane: 'current', from: [C, G, S, F], on: ['hold_expired'], guard: 'hold_liveness', to: 'same', verdict: 'applied', effects: [
        { e: 'probe' },
        { e: 'hold', reason: 'liveness', until: 'liveness_reprobe', onExpire: 'escalate' },
    ] },
    { id: 'H5', lane: 'current', from: 'nonterminal', on: ['hold_expired'], guard: 'hold_hard_ceiling', to: 'failed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'failed', strength: 'genuine', reason: 'hard_ceiling' },
    ] },
    { id: 'H6', lane: 'current', from: 'nonterminal', on: ['hold_expired'], guard: 'hold_suspension_before_consumed', to: 'same', verdict: 'applied', effects: [
        { e: 'release', reasons: 'expired_hold' },
    ] },
    { id: 'H7', lane: 'current', from: [C, G, S, F], on: ['hold_expired'], guard: 'hold_admission', to: 'same', verdict: 'applied', effects: [
        { e: 'release', reasons: 'expired_hold' },
        { e: 'reevaluate' },
    ] },
    { id: 'R13a', lane: 'current', from: [F], on: ['hold_expired'], guard: 'hold_weak_candidate', to: 'completed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' },
    ] },
    { id: 'R13r', lane: 'current', from: [F], on: ['hold_expired'], guard: 'hold_await_report', to: 'completed', verdict: 'applied', effects: [
        { e: 'commit', outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' },
    ] },
    { id: 'H0', lane: 'current', from: 'any', on: ['hold_expired'], guard: 'otherwise', to: 'same', verdict: 'recorded', effects: [
        { e: 'record', note: 'hold_stale' },
    ] },
];

const NONTERMINAL: readonly TurnState[] = [A, D, C, G, S, F];
const TERMINAL: readonly TurnState[] = ['completed', 'failed', 'cancelled'];

/** Does a rule's `from` admit this state (`null` = lane none, no attempt)? */
export function ruleAdmitsState(from: RuleFrom, state: TurnState | null): boolean {
    if (state === null) return from === 'none';
    if (from === 'none') return false;
    if (from === 'any') return true;
    if (from === 'nonterminal') return NONTERMINAL.includes(state);
    if (from === 'terminal') return TERMINAL.includes(state);
    return from.includes(state);
}

export function findRule(id: string): TransitionRule | undefined {
    return TRANSITIONS.find((rule) => rule.id === id);
}
