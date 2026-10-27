// ---------------------------------------------------------------------------
// turn-ledger/reducer — PURE: (attempt, holds, evidence, policy, now) → next
// ---------------------------------------------------------------------------
// Wiring-unification Phase C1. No IO, no clock, no store, no randomness: the
// same input always yields the same output (ids derive from the evidence).
// The store (C-W2) persists `attempt` + `holds` and executes `effects` inside
// one transaction; this module only decides.
//
//   1. classifyLane   — none / stale / current (or a lane-level rejection)
//   2. matchRule      — the ONE TRANSITIONS row whose lane/from/on/guard match
//   3. apply          — run the rule's effect templates against a draft
//
// Timestamps: facts observed about the session (deliveredAt, consumedAt,
// terminal.at, …) use the evidence clock `evidence.at`; hold deadlines use the
// ledger clock `nowMs`, so a remote worker's clock skew cannot expire a hold
// early or late.
// ---------------------------------------------------------------------------

import {
    RECLAIMING_SEND_REFUSALS,
    sessionIdsEquivalent,
    type HoldReason,
    type NotifyKind,
    type SummaryRef,
    type CommitStrength as TurnCommitStrength,
    type TurnEvidence,
    type TurnEvidenceKind,
    type TurnEvidenceOf,
    type TurnOutcome,
    type TurnReason,
} from '@adhdev/mesh-shared';
import {
    admissionHoldUntil,
    admitTranscriptFinal,
    admitTurnEnd,
    type EvidenceAdmission,
} from './admission.js';
import {
    DEFAULT_MAX_TASK_RETRIES,
    LIVENESS_FAIL_STREAK_LIMIT,
    MAX_REDRIVES_PER_GENERATION,
    MAX_UNCONFIRMED_END_DEFERRALS,
    endProbeGraceMs,
    reportCorrectionMs,
    RECLAIM_BUDGET,
    awaitDeliveryMs,
    consumeGraceFor,
    livenessReArmMs,
    unknownLivenessGraceMs,
    weakConfirmMs,
    type TurnPolicy,
} from './policy.js';
import {
    TRANSITIONS,
    ruleAdmitsState,
    type ActionId,
    type EffectTemplate,
    type GuardId,
    type RuleLane,
    type TransitionRule,
    type UntilExpr,
} from './transitions.js';
import {
    isTerminalTurnState,
    type ReduceRejection,
    type ReduceVerdict,
    type TurnAttempt,
    type TurnEffect,
    type TurnHold,
} from './types.js';

export interface ReduceInput {
    /** Local executor capability, never derived from received evidence fields. */
    stopConfirmed?: boolean;
    /** Separate private executor admission; never set from remote evidence. */
    operatorRecoveryConfirmed?: boolean;
    attempt: TurnAttempt | null;
    /** Active holds of this attempt. */
    holds: readonly TurnHold[];
    evidence: TurnEvidence;
    policy: TurnPolicy;
    nowMs: number;
}

export interface ReduceResult {
    attempt: TurnAttempt | null;
    /** Active holds after the step (the store diffs, or follows hold/release_hold effects). */
    holds: TurnHold[];
    effects: TurnEffect[];
    verdict: ReduceVerdict;
    rule?: string;
    rejection?: ReduceRejection;
}

/** Evidence about a worker session must name the session currently bound to the attempt. */
const SESSION_PRODUCED_KINDS: ReadonlySet<TurnEvidenceKind> = new Set<TurnEvidenceKind>([
    'turn_started', 'suspension', 'suspension_resolved', 'turn_end', 'transcript_final',
    'transcript_activity', 'no_progress', 'process_exit', 'session_error', 'worker_report', 'worker_progress', 'liveness',
]);

// ─── lane classification ─────────────────────────────────────────────────

type LaneResult =
    | { lane: RuleLane; effectiveGeneration: number | null }
    | { rejection: Extract<ReduceRejection, 'attempt_mismatch' | 'session_mismatch'> };

export function classifyLane(attempt: TurnAttempt | null, evidence: TurnEvidence, holds: readonly TurnHold[] = []): LaneResult {
    if (!attempt) return { lane: 'none', effectiveGeneration: null };

    // Scheduler evidence names its hold; the hold carries the generation.
    if (evidence.kind === 'hold_expired') {
        const hold = holds.find((h) => h.holdId === evidence.holdId);
        const generation = evidence.attemptRef?.generation ?? hold?.generation ?? null;
        if (evidence.attemptRef && evidence.attemptRef.attemptId !== attempt.attemptId) return { rejection: 'attempt_mismatch' };
        if (generation !== null && generation !== attempt.generation) return { lane: 'stale', effectiveGeneration: generation };
        return { lane: 'current', effectiveGeneration: attempt.generation };
    }

    const cut = attempt.data.livenessSessionCut;
    if (evidence.kind === 'liveness' && cut?.generation === attempt.generation
        && (evidence.attemptRef?.generation ?? attempt.generation) === attempt.generation
        && (evidence.at < cut.at || (evidence.probeStartedAtMs ?? evidence.at) < cut.at)) {
        return { rejection: 'session_mismatch' };
    }
    const sessionProduced = SESSION_PRODUCED_KINDS.has(evidence.kind);
    const ref = evidence.attemptRef;
    if (ref) {
        if (ref.attemptId !== attempt.attemptId) return { rejection: 'attempt_mismatch' };
        if (ref.generation !== attempt.generation) return { lane: 'stale', effectiveGeneration: ref.generation };
        if (sessionProduced && !sessionIdsEquivalent(evidence.sessionId, attempt.sessionId)) return { rejection: 'session_mismatch' };
        return { lane: 'current', effectiveGeneration: ref.generation };
    }
    if (!sessionProduced) return { lane: 'current', effectiveGeneration: attempt.generation };
    if (sessionIdsEquivalent(evidence.sessionId, attempt.sessionId)) return { lane: 'current', effectiveGeneration: attempt.generation };
    if (attempt.prevGeneration && sessionIdsEquivalent(evidence.sessionId, attempt.prevGeneration.sessionId)) {
        return { lane: 'stale', effectiveGeneration: attempt.generation - 1 };
    }
    return { rejection: 'session_mismatch' };
}

// ─── guards ──────────────────────────────────────────────────────────────

interface GuardCtx {
    operatorRecoveryConfirmed?: boolean;
    attempt: TurnAttempt | null;
    holds: readonly TurnHold[];
    evidence: TurnEvidence;
    policy: TurnPolicy;
    nowMs: number;
    effectiveGeneration: number | null;
}

function admissionOf(ctx: GuardCtx): EvidenceAdmission | null {
    const ev = ctx.evidence;
    if (ev.kind === 'transcript_final') return admitTranscriptFinal(ev, ctx.policy);
    if (ev.kind === 'turn_end') return admitTurnEnd(ev, ctx.policy);
    return null;
}

function expiredHold(ctx: GuardCtx): TurnHold | undefined {
    const ev = ctx.evidence;
    if (ev.kind !== 'hold_expired') return undefined;
    const hold = ctx.holds.find((h) => h.holdId === ev.holdId);
    if (!hold || hold.reason !== ev.reason || (ctx.attempt && hold.attemptId !== ctx.attempt.attemptId)) return undefined;
    return hold;
}

function holdIs(ctx: GuardCtx, ...reasons: HoldReason[]): boolean {
    const hold = expiredHold(ctx);
    return !!hold && reasons.includes(hold.reason);
}

function activityAt(ev: TurnEvidence): number {
    return ev.kind === 'transcript_activity' ? ev.newestActivityAt : ev.at;
}

function afterWeakSince(ctx: GuardCtx): boolean {
    const since = ctx.attempt?.weakSince;
    return since !== null && since !== undefined && activityAt(ctx.evidence) > since;
}

function turnEnd(ctx: GuardCtx): TurnEvidenceOf<'turn_end'> | null {
    return ctx.evidence.kind === 'turn_end' ? ctx.evidence : null;
}

/**
 * A turn_end the worker's daemon stamped `providerFailure` (its whole reply was
 * an auth/billing failure banner — 2026-10-06 preview incident, claude-cli
 * "Login expired · Please run /login" committed task_completed). R9f fails it;
 * every completion-shaped turn_end guard below excludes it.
 */
function completionEnd(ctx: GuardCtx): TurnEvidenceOf<'turn_end'> | null {
    const e = turnEnd(ctx);
    return e && !e.providerFailure && e.nativeOutcome !== 'failed' ? e : null;
}

function notHeld(ctx: GuardCtx): boolean {
    return admissionOf(ctx)?.kind !== 'hold';
}

/**
 * A genuine end stamped `reportExpected` by the worker's daemon (live
 * worker-MCP bind) on a mesh attempt: the structured report, not the idle
 * edge, commits it (R9r). Plain attempts never await a report.
 */
function reportAwaitedEnd(ctx: GuardCtx): boolean {
    const e = completionEnd(ctx);
    return !!e && e.strength === 'genuine' && !e.hollow && e.reportExpected === true
        && !!ctx.attempt && isMeshScope(ctx.attempt);
}

/**
 * R17g recorded a worker report for the attempt's CURRENT generation (the
 * report arrived before the idle edge). A reclaim bumps the generation, so a
 * report of a cut generation never satisfies this.
 */
function reportedThisGeneration(ctx: GuardCtx): boolean {
    const attempt = ctx.attempt;
    return !!attempt && attempt.data.report?.generation === attempt.generation;
}

/**
 * An idle signal after a recorded report (R9t): any admitted turn_end (strong
 * or weak, hollow or not — the report is the verdict), a transcript_final that
 * is either admitted OR declined on content grounds (native_marker_absent /
 * no_final_assistant_summary — the scrape's own completion proof is exactly
 * what the report already supplies, so its absence is not evidence the turn is
 * still running), or a no-progress watchdog that sees the final message. A
 * live-pending/quiet HOLD admission (modal parked, adapter still busy,
 * trailing tool activity, or the transcript still growing) is a genuine sign
 * of continued activity, not just a missing marker — that is not an idle
 * signal; it still goes to R16 and re-reduces (R9t) once the hold clears.
 */
function finishedAfterReport(ctx: GuardCtx): boolean {
    if (!reportedThisGeneration(ctx)) return false;
    const ev = ctx.evidence;
    if (ev.kind === 'turn_end' || ev.kind === 'transcript_final') {
        const admission = admissionOf(ctx);
        return admission?.kind === 'strong' || admission?.kind === 'weak' || admission?.kind === 'decline';
    }
    return ev.kind === 'no_progress' && ev.finalAssistantPresent;
}

/** A weakly admitted transcript_final (R15 / R15p / R10a). */
function finalWeak(ctx: GuardCtx): boolean {
    return ctx.evidence.kind === 'transcript_final' && admissionOf(ctx)?.kind === 'weak' && !reportedThisGeneration(ctx);
}

/** Evidence the owner read itself — never the worker daemon's turn verdict. */
const OWNER_SCRAPE_SOURCES: ReadonlySet<string> = new Set(['coordinator_probe', 'mcp_probe']);

/**
 * R15p: a transcript_final the owner scraped on a mesh attempt. The worker's
 * daemon emits its own turn_end (and withholds it while its completion gate
 * holds), so a scrape alone awaits the report instead of committing weak.
 */
function ownerScrapedMeshFinal(ctx: GuardCtx): boolean {
    return ctx.evidence.kind === 'transcript_final' && OWNER_SCRAPE_SOURCES.has(ctx.evidence.source)
        && !!ctx.attempt && isMeshScope(ctx.attempt);
}

/** A native marker ends the provider turn, but an owner probe cannot use it as
 * the task verdict for a report-owning queue worker. R15p waits for the report. */
function ownerProbedQueueNativeCompletion(ctx: GuardCtx): boolean {
    const ev = ctx.evidence;
    return ev.kind === 'transcript_final' && ev.nativeRead && ev.nativeMarker?.outcome === 'completed'
        && OWNER_SCRAPE_SOURCES.has(ev.source) && ctx.attempt?.scope === 'mesh_queue'
        && admissionOf(ctx)?.kind === 'strong';
}

/** The attempt is inside an R9r window (an active `await_report` hold). */
function awaitReportHeld(ctx: GuardCtx): boolean {
    const attempt = ctx.attempt;
    return !!attempt && ctx.holds.some((h) => h.reason === 'await_report' && h.attemptId === attempt.attemptId);
}

/** A timer may use only a recent observation from a probe begun after its hold/request. */
function freshEndProbe(ctx: GuardCtx): boolean {
    const a = ctx.attempt;
    const o = a?.data.livenessObservation;
    const request = a?.data.unconfirmedEndDeferral;
    const boundary = request?.generation === a?.generation && request?.requestedAt !== undefined
        ? request.requestedAt : expiredHold(ctx)?.createdAt;
    const cut = a?.data.livenessSessionCut;
    const since = Math.max(boundary ?? 0, cut && cut.generation === a?.generation ? cut.at : 0);
    return !!a && !!o && o.generation === a.generation && !!o.sessionId
        && sessionIdsEquivalent(o.sessionId, a.sessionId) && boundary !== undefined
        && o.probeStartedAt >= since && o.at >= since && o.at <= ctx.nowMs
        && ctx.nowMs - o.at <= endProbeGraceMs(ctx.policy);
}
function correctionPending(ctx: GuardCtx): boolean {
    const r = ctx.attempt?.data.reportCorrection;
    return r?.generation === ctx.attempt?.generation && !reportedThisGeneration(ctx);
}
function endTimer(ctx: GuardCtx): boolean {
    return holdIs(ctx, 'weak_candidate', 'await_report')
        && expiredHold(ctx)?.data.nativeProbeReportOnly !== true && !correctionPending(ctx);
}
function freshAlive(ctx: GuardCtx): boolean { return freshEndProbe(ctx) && ctx.attempt?.lastLiveness === 'alive'; }

/** How many times R13u already deferred a weak/await_report expiry in this generation. */
function unconfirmedEndDeferrals(ctx: GuardCtx): number {
    const d = ctx.attempt?.data.unconfirmedEndDeferral;
    return d && d.generation === ctx.attempt!.generation && d.requestedAt !== undefined ? d.count : 0;
}

const GUARDS: Record<Exclude<GuardId, 'otherwise'>, (ctx: GuardCtx) => boolean> = {
    unbound: (ctx) => !ctx.evidence.attemptRef && !ctx.evidence.taskId,
    bound: (ctx) => !!ctx.evidence.attemptRef || !!ctx.evidence.taskId,
    prev_generation_completion: (ctx) => {
        const attempt = ctx.attempt;
        if (!attempt || !attempt.prevGeneration || ctx.effectiveGeneration !== attempt.generation - 1) return false;
        if (!sessionIdsEquivalent(ctx.evidence.sessionId, attempt.prevGeneration.sessionId)) return false;
        const ev = ctx.evidence;
        if (ev.kind === 'worker_report') return true;
        if (ev.kind === 'turn_end') return ev.strength === 'genuine' && !ev.hollow && !ev.providerFailure && ev.nativeOutcome !== 'failed';
        if (ev.kind === 'transcript_final') return admitTranscriptFinal(ev, ctx.policy).kind === 'strong'
            && !ownerProbedQueueNativeCompletion(ctx);
        return false;
    },
    stale_session_distinct: (ctx) => !!ctx.attempt && !sessionIdsEquivalent(ctx.evidence.sessionId, ctx.attempt.sessionId),
    reclaiming_refusal: (ctx) => ctx.evidence.kind === 'delivery_refused'
        && (RECLAIMING_SEND_REFUSALS as readonly string[]).includes(ctx.evidence.reason),
    stale_modal_resolution: (ctx) => ctx.evidence.kind === 'suspension_resolved' && !!ctx.evidence.modalKey && !!ctx.attempt?.data.providerSuspension?.modalKey && ctx.evidence.modalKey !== ctx.attempt.data.providerSuspension.modalKey,
    held_provider_setup: (ctx) => !(ctx.evidence.kind === 'suspension_resolved' && ctx.evidence.modalKey && ctx.evidence.modalKey !== ctx.attempt?.data.providerSuspension?.modalKey) && ctx.attempt?.data.providerSuspension?.providerSetup === true && ctx.attempt.data.providerSuspension.generation === ctx.attempt.generation && ctx.attempt.data.providerSuspension.resolvedAt === null,
    confirmed_provider_setup: (ctx) => ctx.evidence.kind === 'suspension' && ctx.evidence.providerSetup === true && !!ctx.evidence.modalKey,
    suspension_changed: (ctx) => ctx.evidence.kind === 'suspension' && (ctx.attempt?.suspension !== ctx.evidence.modal || (!!ctx.evidence.modalKey && ctx.attempt?.data.providerSuspension?.modalKey !== ctx.evidence.modalKey)),
    // Every idle-signal guard below yields to R9t once a report is recorded for
    // this generation (`!reportedThisGeneration`): the report is the verdict.
    end_genuine: (ctx) => { const e = completionEnd(ctx); return !!e && e.strength === 'genuine' && !e.hollow && notHeld(ctx) && !reportAwaitedEnd(ctx) && !reportedThisGeneration(ctx); },
    end_report_awaited: (ctx) => reportAwaitedEnd(ctx) && notHeld(ctx) && !awaitReportHeld(ctx) && !reportedThisGeneration(ctx),
    end_report_awaited_held: (ctx) => reportAwaitedEnd(ctx) && notHeld(ctx) && awaitReportHeld(ctx) && !reportedThisGeneration(ctx),
    final_strong_report_awaited: (ctx) => ctx.evidence.kind === 'transcript_final' && admissionOf(ctx)?.kind === 'strong' && awaitReportHeld(ctx) && !reportedThisGeneration(ctx),
    finished_after_report: finishedAfterReport,
    end_provider_failure: (ctx) => { const e = turnEnd(ctx); return !!e && (!!e.providerFailure || e.nativeOutcome === 'failed') && notHeld(ctx) && !reportedThisGeneration(ctx); },
    false_idle_resumed: (ctx) => (ctx.evidence.kind === 'turn_started' || ctx.evidence.kind === 'transcript_activity')
        && afterWeakSince(ctx) && awaitReportHeld(ctx),
    end_weak: (ctx) => { const e = completionEnd(ctx); return !!e && e.strength === 'weak' && !e.afterFinalizationTimeout && !e.hollow && notHeld(ctx) && !reportedThisGeneration(ctx); },
    end_weak_after_timeout: (ctx) => { const e = completionEnd(ctx); return !!e && e.strength === 'weak' && !!e.afterFinalizationTimeout && !e.hollow && notHeld(ctx) && !reportedThisGeneration(ctx); },
    hollow_retry: (ctx) => { const e = completionEnd(ctx); return !!e && !!e.hollow && notHeld(ctx) && !reportedThisGeneration(ctx) && ctx.attempt!.hollowCount < ctx.attempt!.maxTaskRetries; },
    hollow_exhausted: (ctx) => { const e = completionEnd(ctx); return !!e && !!e.hollow && notHeld(ctx) && !reportedThisGeneration(ctx) && ctx.attempt!.hollowCount >= ctx.attempt!.maxTaskRetries; },
    final_strong: (ctx) => ctx.evidence.kind === 'transcript_final' && admissionOf(ctx)?.kind === 'strong'
        && !ownerProbedQueueNativeCompletion(ctx) && !reportedThisGeneration(ctx),
    final_weak: (ctx) => finalWeak(ctx) && !ownerScrapedMeshFinal(ctx),
    final_weak_probe: (ctx) => !reportedThisGeneration(ctx)
        && ((finalWeak(ctx) && ownerScrapedMeshFinal(ctx)) || ownerProbedQueueNativeCompletion(ctx)),
    genuine_end_or_strong_final: (ctx) => GUARDS.end_genuine(ctx) || (GUARDS.final_strong(ctx) && !awaitReportHeld(ctx)),
    weak_end_or_final: (ctx) => GUARDS.end_weak(ctx) || finalWeak(ctx)
        || (ownerProbedQueueNativeCompletion(ctx) && !awaitReportHeld(ctx)),
    admission_hold: (ctx) => admissionOf(ctx)?.kind === 'hold',
    // A content decline (no native marker / no final assistant summary) yields
    // to R9t once a report is recorded for this generation: the report already
    // supplies the completion proof the scrape is missing (2026-09-25 — R16a
    // was a dead end here, no reevaluate, so the attempt sat on the scrape's
    // decline until the unrelated await_end hold expired ~1 min later).
    admission_decline: (ctx) => admissionOf(ctx)?.kind === 'decline' && !reportedThisGeneration(ctx),
    after_weak_since: (ctx) => afterWeakSince(ctx) && !awaitReportHeld(ctx),
    activity_keeps_state: (ctx) => {
        const ev = ctx.evidence;
        const state = ctx.attempt?.state;
        if (ev.kind === 'liveness') return ev.result === 'alive';
        if (ev.kind === 'transcript_activity') return state === 'consumed' || state === 'generating' || (state === 'finalizing' && !afterWeakSince(ctx));
        if (ev.kind === 'turn_started') return state === 'generating' || (state === 'finalizing' && !afterWeakSince(ctx));
        return false;
    },
    liveness_unknown: (ctx) => ctx.evidence.kind === 'liveness' && ctx.evidence.result === 'unknown',
    liveness_fatal: (ctx) => ctx.evidence.kind === 'liveness' && (ctx.evidence.result === 'dead'
        || (ctx.evidence.result === 'read_failed' && ctx.attempt!.livenessFailStreak + 1 >= LIVENESS_FAIL_STREAK_LIMIT)),
    liveness_failed_nonfatal: (ctx) => ctx.evidence.kind === 'liveness' && ctx.evidence.result === 'read_failed'
        && ctx.attempt!.livenessFailStreak + 1 < LIVENESS_FAIL_STREAK_LIMIT,
    reported_terminal: (ctx) => ctx.attempt?.terminal?.strength === 'tool_report',
    provider_failure: (ctx) => ctx.evidence.kind === 'process_exit' && !!ctx.evidence.providerFailure,
    no_provider_failure: (ctx) => ctx.evidence.kind === 'process_exit' && !ctx.evidence.providerFailure,
    holder_is_this_attempt: (ctx) => ctx.evidence.kind === 'duplicate_dispatch_refusal' && ctx.evidence.holderAttemptId === ctx.attempt?.attemptId,
    final_present: (ctx) => ctx.evidence.kind === 'no_progress' && ctx.evidence.finalAssistantPresent && !reportedThisGeneration(ctx),
    hold_await_delivery: (ctx) => holdIs(ctx, 'await_delivery'),
    hold_await_consume_redrive: (ctx) => holdIs(ctx, 'await_consume') && ctx.attempt!.redriveCount < MAX_REDRIVES_PER_GENERATION,
    hold_await_consume_exhausted: (ctx) => holdIs(ctx, 'await_consume') && ctx.attempt!.redriveCount >= MAX_REDRIVES_PER_GENERATION,
    hold_await_turn: (ctx) => holdIs(ctx, 'await_turn'),
    hold_liveness: (ctx) => holdIs(ctx, 'liveness'),
    hold_hard_ceiling: (ctx) => holdIs(ctx, 'hard_ceiling'),
    hold_suspension_before_consumed: (ctx) => holdIs(ctx, 'suspension_before_consumed'),
    hold_weak_candidate: (ctx) => holdIs(ctx, 'weak_candidate') && !correctionPending(ctx) && freshAlive(ctx),
    hold_admission: (ctx) => holdIs(ctx, 'live_pending', 'transcript_quiet'),
    hold_await_report: (ctx) => holdIs(ctx, 'await_report')
        && expiredHold(ctx)?.data.nativeProbeReportOnly !== true && !correctionPending(ctx) && freshAlive(ctx),
    hold_native_probe_report_only: (ctx) => holdIs(ctx, 'await_report')
        && expiredHold(ctx)?.data.nativeProbeReportOnly === true && !correctionPending(ctx)
        && !reportedThisGeneration(ctx),
    hold_end_unconfirmed_defer: (ctx) => endTimer(ctx) && !freshAlive(ctx)
        && unconfirmedEndDeferrals(ctx) < MAX_UNCONFIRMED_END_DEFERRALS,
    hold_end_unconfirmed_exhausted: (ctx) => endTimer(ctx) && !freshAlive(ctx)
        && unconfirmedEndDeferrals(ctx) >= MAX_UNCONFIRMED_END_DEFERRALS && freshEndProbe(ctx),
    hold_end_probe_missing: (ctx) => endTimer(ctx) && !freshEndProbe(ctx) && unconfirmedEndDeferrals(ctx) >= MAX_UNCONFIRMED_END_DEFERRALS,
    hold_report_correction: (ctx) => holdIs(ctx, 'report_correction') && !reportedThisGeneration(ctx),
    hold_await_end: (ctx) => holdIs(ctx, 'await_end') && reportedThisGeneration(ctx),
};

function laneCandidates(lane: RuleLane, state: TurnAttempt['state'] | null, kind: TurnEvidenceKind): TransitionRule[] {
    return TRANSITIONS.filter((rule) => rule.lane === lane && ruleAdmitsState(rule.from, state) && rule.on.includes(kind));
}

/**
 * Every rule that matches (for the coverage test). The reducer requires this
 * to have length ≤ 1; the table test proves it.
 */
export function matchingRules(input: ReduceInput): TransitionRule[] {
    const lane = classifyLane(input.attempt, input.evidence, input.holds);
    if ('rejection' in lane) return [];
    const ctx: GuardCtx = { ...input, effectiveGeneration: lane.effectiveGeneration };
    const candidates = laneCandidates(lane.lane, input.attempt?.state ?? null, input.evidence.kind);
    const specific = candidates.filter((rule) => rule.guard !== 'otherwise' && (!rule.guard || GUARDS[rule.guard](ctx)));
    if (specific.length > 0) return specific;
    return candidates.filter((rule) => rule.guard === 'otherwise');
}

// ─── application ─────────────────────────────────────────────────────────

interface Draft {
    attempt: TurnAttempt | null;
    holds: Map<string, TurnHold>;
    effects: TurnEffect[];
    ctx: GuardCtx;
    rule: TransitionRule;
    /** Set once a commit ran; later templates in the same rule are skipped. */
    committed: boolean;
}

function cloneAttempt(attempt: TurnAttempt): TurnAttempt {
    return {
        ...attempt,
        prevGeneration: attempt.prevGeneration ? { ...attempt.prevGeneration } : null,
        coordinator: { ...attempt.coordinator },
        terminal: attempt.terminal ? { ...attempt.terminal } : null,
        data: { ...attempt.data, ...(attempt.data.providerSuspension ? { providerSuspension: { ...attempt.data.providerSuspension } } : {}), ...(attempt.data.gitSideEffect ? { gitSideEffect: { ...attempt.data.gitSideEffect } } : {}) },
    };
}

function holdId(attemptId: string, reason: HoldReason): string {
    return `${attemptId}:${reason}`;
}

function isMeshScope(attempt: TurnAttempt): boolean {
    return attempt.scope !== 'plain';
}

function resolveUntil(expr: UntilExpr, draft: Draft): number | null {
    const { policy, nowMs, evidence } = draft.ctx;
    const attempt = draft.attempt!;
    switch (expr) {
        case 'none': return null;
        case 'await_delivery': return nowMs + awaitDeliveryMs(policy);
        case 'await_consume': return nowMs + consumeGraceFor(policy, attempt.consumeProfile);
        case 'await_turn': return nowMs + policy.noTurnDeadlineMs;
        case 'liveness': return nowMs + policy.livenessDeadlineMs;
        case 'hard_ceiling': return nowMs + policy.hardCeilingMs;
        case 'weak_confirm': return nowMs + weakConfirmMs(policy);
        case 'await_report': return nowMs + policy.awaitReportMs;
        case 'await_end': return nowMs + policy.awaitEndMs;
        case 'unknown_grace': return nowMs + unknownLivenessGraceMs(policy);
        // H4 / R32u re-arm: the normal 3×tick cadence, except while `await_report`
        // is open, where the probe backs off (see policy.ts livenessReArmMs).
        case 'liveness_reprobe': return nowMs + livenessReArmMs(policy, awaitReportHeld(draft.ctx));
        case 'admission': {
            const admission = admissionOf(draft.ctx);
            if (admission?.kind !== 'hold') return nowMs;
            const live = evidence.kind === 'transcript_final' || evidence.kind === 'turn_end' ? evidence.live : undefined;
            return admissionHoldUntil(admission, live, evidence.at, policy, nowMs);
        }
    }
}

function addHold(draft: Draft, hold: TurnHold): void {
    draft.holds.set(hold.holdId, hold);
    draft.effects.push({ kind: 'hold', hold });
}

function releaseHolds(draft: Draft, reasons: readonly HoldReason[] | '*', keep: readonly HoldReason[] = []): void {
    const attempt = draft.attempt!;
    const released: HoldReason[] = [];
    for (const [key, hold] of draft.holds) {
        if (keep.includes(hold.reason)) continue;
        if (reasons === '*' || reasons.includes(hold.reason)) {
            draft.holds.delete(key);
            released.push(hold.reason);
        }
    }
    if (released.length > 0) {
        draft.effects.push({ kind: 'release_hold', attemptId: attempt.attemptId, reasons: reasons === '*' && keep.length === 0 ? '*' : released });
    }
}

function notify(draft: Draft, kind: NotifyKind, opts: { generation?: number; summary?: SummaryRef; textEventId?: string } = {}): void {
    const attempt = draft.attempt!;
    if (!isMeshScope(attempt)) return;
    draft.effects.push({
        kind: 'notify_coordinator',
        attemptId: attempt.attemptId,
        generation: opts.generation ?? attempt.generation,
        notify: kind,
        taskId: attempt.taskId,
        coordinatorDaemonId: attempt.coordinator.daemonId,
        coordinatorSessionId: attempt.coordinator.sessionId,
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(opts.textEventId ? { textEventId: opts.textEventId } : {}),
    });
}

/** Holds that commit on expiry keep the text pointer of the evidence that opened them. */
const TEXT_CARRYING_HOLDS: readonly HoldReason[] = ['weak_candidate', 'await_report', 'await_end'];

/**
 * The text of a commit on hold expiry (R13a/R13r) is the text of the end that
 * opened the hold, not of the scheduler's `hold_expired` (which has none): the
 * hold stores the opener's summary pointer (remote owner) and event id (local
 * envelope, re-read by deliver.ts at render time).
 */
function heldText(draft: Draft): { summary?: SummaryRef; textEventId?: string } {
    const hold = expiredHold(draft.ctx);
    if (!hold || !TEXT_CARRYING_HOLDS.includes(hold.reason)) return {};
    const d = hold.data;
    const summary = typeof d.summaryTopic === 'string' && typeof d.summaryWriter === 'string' && typeof d.summarySeq === 'number'
        ? { topic: d.summaryTopic, writer: d.summaryWriter, seq: d.summarySeq }
        : undefined;
    const textEventId = typeof d.textEventId === 'string' && d.textEventId ? d.textEventId : undefined;
    return { ...(summary ? { summary } : {}), ...(textEventId ? { textEventId } : {}) };
}

function summaryOf(ev: TurnEvidence): SummaryRef | undefined {
    if (ev.kind === 'turn_end' || ev.kind === 'transcript_final' || ev.kind === 'worker_report') return ev.summary;
    return undefined;
}

/**
 * The text of a commit on a report R17g recorded (R9t/R13t): the report's own
 * pointer + local evidence row, never the idle edge's scrape.
 */
function recordedReportText(draft: Draft): { summary?: SummaryRef; textEventId?: string } {
    const report = draft.attempt!.data.report;
    if (!report) return {};
    return { ...(report.summary ? { summary: report.summary } : {}), textEventId: report.eventId };
}

function commit(
    draft: Draft,
    outcome: TurnOutcome,
    strength: NonNullable<TurnAttempt['terminal']>['strength'],
    reason: TurnReason,
    text?: { summary?: SummaryRef; textEventId?: string },
): void {
    const attempt = draft.attempt!;
    if (isMeshScope(attempt) && !attempt.data.writerStop?.confirmed && !draft.ctx.operatorRecoveryConfirmed && (reason === 'hard_ceiling'
        || draft.ctx.evidence.kind === 'cancel' || draft.ctx.evidence.kind === 'operator_status'
        || draft.ctx.evidence.kind === 'session_error' || draft.ctx.evidence.kind === 'process_exit')) {
        beginWriterStop(draft, reason);
        attempt.data.writerStop!.terminal = { outcome, strength, source: draft.ctx.evidence.source,
            ...(summaryOf(draft.ctx.evidence) ? { summary: summaryOf(draft.ctx.evidence) } : {}), textEventId: draft.ctx.evidence.eventId };
        return;
    }
    const ev = draft.ctx.evidence;
    const held = text ?? heldText(draft);
    const summary = text ? text.summary : summaryOf(ev) ?? held.summary;
    attempt.state = outcome;
    attempt.suspension = null;
    const source = draft.ctx.operatorRecoveryConfirmed ? ev.source : attempt.data.writerStop?.terminal?.source ?? ev.source;
    attempt.terminal = { outcome, reason, source, strength, at: ev.at, ...(summary ? { summary } : {}) };
    draft.effects.push({
        kind: 'commit', attemptId: attempt.attemptId, generation: attempt.generation,
        outcome, strength, reason, source, ...(summary ? { summary } : {}),
    });
    releaseHolds(draft, '*');
    // A queue requeue retiring the attempt (cancel/superseded, mesh-queue-attempt-
    // guard.ts): only the ATTEMPT ends — the row is going back to pending, so no
    // queue terminal and no coordinator "task cancelled" notice.
    const attemptOnly = reason === 'superseded' && attempt.scope === 'mesh_queue';
    if (attemptOnly && attempt.data.writerStop?.confirmed && attempt.meshId && attempt.taskId) {
        draft.effects.push({ kind: 'queue_status', meshId: attempt.meshId, taskId: attempt.taskId, status: 'pending', reason });
    }
    // Both mesh scopes carry a queue row: `mesh_queue` owns one, and a
    // `mesh_direct` dispatch materialises one pre-assigned
    // (`recordDirectDispatchTask`) for mission attribution + status. Gating this
    // on `mesh_queue` alone left a committed direct dispatch's row `assigned`
    // forever (live, rc.37: task 2cb0ab79). A direct attempt with no row is a
    // no-op at the host (`applyTaskTerminalInTxn` finds no entry).
    if (isMeshScope(attempt) && attempt.meshId && attempt.taskId && !attemptOnly) {
        draft.effects.push({ kind: 'queue_status', meshId: attempt.meshId, taskId: attempt.taskId, status: outcome, reason });
        draft.effects.push({ kind: 'task_terminal', meshId: attempt.meshId, taskId: attempt.taskId, outcome });
    }
    draft.effects.push({ kind: 'bus', event: { kind: 'turn', phase: 'committed', sessionId: attempt.sessionId, attemptId: attempt.attemptId, generation: attempt.generation, outcome, strength } });
    if (!attemptOnly) notify(draft, outcome, { ...(summary ? { summary } : {}), ...(held.textEventId ? { textEventId: held.textEventId } : {}) });
    draft.effects.push({ kind: 'release_attempt_ref', attemptId: attempt.attemptId, sessionId: attempt.sessionId });
    draft.committed = true;
}

/**
 * Every reason a reclaim is emitted with (the "reclaims" block of
 * TURN_REASONS). A `mesh_direct` attempt commits `failed` with one of these as
 * its terminal reason — that is how a consumer (the coordinator notice) tells
 * "the direct dispatch never got a turn and nothing will redeliver it" apart
 * from a turn that ran and failed.
 */
export const RECLAIM_TURN_REASONS = [
    'dispatch_refused_session_exited', 'dispatch_refused_no_target', 'dispatch_refused_unsupported_input', 'dispatch_failed',
    'session_exit', 'session_exit_before_turn', 'session_dead', 'hollow_completion',
    'assigned_stranded_dispatch_unconfirmed', 'delivered_not_consumed_redrive', 'delivered_no_turn_deadline',
] as const satisfies readonly TurnReason[];

export function isReclaimTurnReason(reason: TurnReason | null | undefined): boolean {
    return !!reason && (RECLAIM_TURN_REASONS as readonly string[]).includes(reason);
}

/**
 * A committed `mesh_direct` attempt whose terminal reason is a reclaim cause:
 * the direct dispatch was not redelivered (see `reclaim`).
 */
export function isUnredeliveredDirectFailure(attempt: Pick<TurnAttempt, 'scope' | 'terminal'> | null | undefined): boolean {
    return !!attempt && attempt.scope === 'mesh_direct' && attempt.terminal?.outcome === 'failed'
        && isReclaimTurnReason(attempt.terminal.reason);
}

/** A mesh reclaim first retains its exact writer in stopping. Only a
 * confirmed native settlement advances the generation and requeues it. Direct
 * attempts fail after settlement because no scheduler redelivers them. */
function reclaim(draft: Draft, reason: TurnReason): void {
    const attempt = draft.attempt!;
    if (attempt.scope === 'plain') {
        commit(draft, 'failed', 'genuine', reason);
        return;
    }
    const refusal = draft.ctx.evidence;
    if (attempt.scope === 'mesh_direct' && attempt.state === 'accepted'
        && attempt.deliveredAt === null && attempt.consumedAt === null
        && refusal.kind === 'dispatch_failed' && refusal.source === 'dispatch'
        && refusal.reason === 'rejected_by_worker' && refusal.refusalCode === 'dispatch_not_started') {
        // The addressed host refused before resolving an adapter or submitting
        // input. There is no writer for this attempt to stop. Transport errors
        // and delivered/consumed attempts still require exact quiescence.
        commit(draft, 'failed', 'genuine', 'dispatch_failed');
        return;
    }
    if (!attempt.data.writerStop?.confirmed) {
        beginWriterStop(draft, reason);
        return;
    }
    const prevSession = attempt.sessionId;
    const fromGeneration = attempt.generation;
    if (attempt.scope === 'mesh_direct') {
        commit(draft, 'failed', 'genuine', reason);
        return;
    }
    if (attempt.reclaimCount >= RECLAIM_BUDGET) {
        commit(draft, 'failed', 'genuine', 'reclaim_budget_exhausted');
        return;
    }
    attempt.prevGeneration = { sessionId: prevSession, consumed: attempt.consumedAt !== null };
    attempt.generation = fromGeneration + 1;
    attempt.reclaimCount += 1;
    attempt.state = 'accepted';
    attempt.suspension = null;
    attempt.deliveredAt = null;
    attempt.consumedAt = null;
    attempt.weakSince = null;
    attempt.redriveCount = 0;
    attempt.livenessFailStreak = 0;
    attempt.lastLiveness = null;
    delete attempt.data.writerStop;
    draft.effects.push({ kind: 'reclaim', attemptId: attempt.attemptId, fromGeneration, toGeneration: attempt.generation, reason });
    releaseHolds(draft, '*', ['hard_ceiling']);
    if (attempt.scope === 'mesh_queue' && attempt.meshId && attempt.taskId) {
        draft.effects.push({ kind: 'queue_status', meshId: attempt.meshId, taskId: attempt.taskId, status: 'pending', reason });
    }
    addHold(draft, {
        holdId: holdId(attempt.attemptId, 'await_delivery'), attemptId: attempt.attemptId, generation: attempt.generation,
        reason: 'await_delivery', until: draft.ctx.nowMs + awaitDeliveryMs(draft.ctx.policy), onExpire: 'reclaim', data: {}, createdAt: draft.ctx.nowMs,
    });
}

const WRITER_STOP_RETRY_MS = 30_000;
const WRITER_STOP_MAX_TRIES = 3;

function requestWriterStop(draft: Draft): void {
    const a = draft.attempt!, stop = a.data.writerStop!;
    draft.effects.push({ kind: 'cancel_dispatch', attemptId: a.attemptId, generation: a.generation,
        sessionId: a.sessionId, messageId: a.messageId, stopRequestId: stop.requestId });
    addHold(draft, { holdId: holdId(a.attemptId, 'liveness'), attemptId: a.attemptId, generation: a.generation,
        reason: 'liveness', until: draft.ctx.nowMs + WRITER_STOP_RETRY_MS, onExpire: 'escalate', data: {}, createdAt: draft.ctx.nowMs });
}

function beginWriterStop(draft: Draft, reason: TurnReason): void {
    const a = draft.attempt!;
    if (a.data.writerStop) return;
    a.state = 'stopping';
    a.data.writerStop = { requestId: `${draft.ctx.evidence.eventId}:writer-stop`, reason,
        requestedAt: draft.ctx.nowMs, tries: 1, escalated: false };
    releaseHolds(draft, '*', reason === 'hard_ceiling' ? [] : ['hard_ceiling']);
    requestWriterStop(draft);
}

/** Stopping is exclusive and nonterminal. All ordinary lifecycle proposals
 * remain evidence; neither a late idle nor an operator requeue releases it. */
function reduceStopping(input: ReduceInput): ReduceResult {
    const a = cloneAttempt(input.attempt!), ev = input.evidence;
    a.data.writerStop = { ...a.data.writerStop! };
    const draft: Draft = { attempt: a, holds: new Map(input.holds.map(h => [h.holdId, h])), effects: [],
        ctx: { ...input, effectiveGeneration: a.generation }, rule: TRANSITIONS[0]!, committed: false };
    const stop = a.data.writerStop!;
    if (input.nowMs >= a.acceptedAt + input.policy.hardCeilingMs) {
        stop.reason = 'hard_ceiling';
        stop.terminal = { outcome: 'failed', strength: 'genuine', source: 'scheduler' };
        releaseHolds(draft, ['hard_ceiling']);
    }
    if (ev.kind === 'cancel') {
        stop.reason = ev.reason;
        stop.terminal = { outcome: 'cancelled', strength: 'genuine', source: ev.source };
    }
    if (input.operatorRecoveryConfirmed) {
        // A truthful operator association and physical absence permit failure
        // retirement, never success, reclaim, or a forged stop confirmation.
        commit(draft, 'failed', 'genuine', 'operator_update', {});
    } else if (input.stopConfirmed) {
        stop.confirmed = true;
        if (stop.terminal) {
            if (stop.terminal.adoptSessionId) {
                a.sessionId = stop.terminal.adoptSessionId;
                a.consumedAt ??= stop.requestedAt;
            }
            commit(draft, stop.terminal.outcome, stop.terminal.strength, stop.reason, stop.terminal);
        }
        else if (stop.reason === 'hard_ceiling') commit(draft, 'failed', 'genuine', stop.reason);
        else reclaim(draft, stop.reason);
    } else if (ev.kind === 'hold_expired' && holdIs(draft.ctx, 'liveness') && (expiredHold(draft.ctx)?.until ?? Infinity) <= input.nowMs) {
        releaseHolds(draft, ['liveness']);
        if (stop.tries < WRITER_STOP_MAX_TRIES) {
            stop.tries++;
            requestWriterStop(draft);
        } else if (!stop.escalated) {
            stop.escalated = true;
            notify(draft, 'no_progress');
            draft.effects.push({ kind: 'record', note: 'writer_stop_unconfirmed_checkpoint_pending' });
        }
    } else if (ev.kind === 'worker_report') ACTIONS.record_report(draft);
    else draft.effects.push({ kind: 'record', note: 'writer_stop_checkpoint_pending' });
    return { attempt: a, holds: [...draft.holds.values()], effects: draft.effects, verdict: 'applied', rule: input.operatorRecoveryConfirmed ? 'operator_recovery_settled' : input.stopConfirmed ? 'writer_settled' : 'WR' };
}

function newAttempt(ev: TurnEvidence, fields: Partial<TurnAttempt> & Pick<TurnAttempt, 'attemptId' | 'scope'>): TurnAttempt {
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

const TERMINAL_NOTIFY_KINDS: readonly NotifyKind[] = ['completed', 'blocked', 'failed', 'cancelled', 'stopped'];

/** The terminal a genuine g−1 completion commits when R27a adopts it. */
function adoptedTerminal(ev: TurnEvidence): { outcome: TurnOutcome; strength: TurnCommitStrength; reason: TurnReason } {
    if (ev.kind === 'worker_report') {
        return { outcome: ev.outcome, strength: 'tool_report', reason: 'worker_reported' };
    }
    if (ev.kind === 'transcript_final') return { outcome: 'completed', strength: 'genuine', reason: 'transcript_final' };
    return { outcome: 'completed', strength: 'genuine', reason: 'turn_end' };
}

/** Keep report evidence/deadlines intact; only the session's liveness is cut. */
function bindLivenessSession(draft: Draft, sessionId: string, rebound = false): void {
    const a = draft.attempt!;
    if (rebound || !sessionIdsEquivalent(a.sessionId, sessionId)) {
        a.lastLiveness = null;
        a.livenessFailStreak = 0;
        a.data.livenessObservation = undefined;
        a.data.livenessSessionCut = {
            generation: a.generation, at: draft.ctx.nowMs,
            revision: (a.data.livenessSessionCut?.revision ?? 0) + 1,
        };
    }
    a.sessionId = sessionId;
}

const ACTIONS: Record<ActionId, (draft: Draft) => void> = {
    open_dispatch: (draft) => {
        const ev = draft.ctx.evidence as TurnEvidenceOf<'dispatch_accepted'>;
        draft.attempt = newAttempt(ev, {
            attemptId: ev.attemptRef?.attemptId ?? `${ev.scope}:${ev.eventId}`,
            scope: ev.scope,
            meshId: ev.meshId ?? null,
            attemptNo: ev.attemptNo ?? 0,
            nodeId: ev.nodeId ?? null,
            providerType: ev.providerType ?? null,
            dispatchNonce: ev.dispatchNonce ?? null,
            messageId: ev.messageId,
            consumeProfile: ev.consumeProfile ?? 'default',
            maxTaskRetries: ev.maxTaskRetries ?? DEFAULT_MAX_TASK_RETRIES,
            coordinator: { daemonId: ev.coordinator?.daemonId ?? null, sessionId: ev.coordinator?.sessionId ?? null },
        });
    },
    open_plain: (draft) => {
        const ev = draft.ctx.evidence;
        draft.attempt = newAttempt(ev, { attemptId: `plain:${ev.sessionId}:${ev.eventId}`, scope: 'plain' });
    },
    mark_delivered: (draft) => {
        const attempt = draft.attempt!;
        const ev = draft.ctx.evidence as TurnEvidenceOf<'delivered'>;
        attempt.deliveredAt = attempt.deliveredAt ?? ev.at;
        bindLivenessSession(draft, ev.sessionId);
        attempt.messageId = ev.messageId;
    },
    consume: (draft) => {
        const attempt = draft.attempt!;
        const at = draft.ctx.evidence.at;
        attempt.deliveredAt = attempt.deliveredAt ?? at;
        attempt.consumedAt = attempt.consumedAt ?? at;
        attempt.lastActivityAt = at;
    },
    apply_held_suspension: (draft) => {
        const attempt = draft.attempt!;
        const held = draft.holds.get(holdId(attempt.attemptId, 'suspension_before_consumed'));
        if (!held) return;
        const modal = held.data.modal === 'choice' ? 'choice' : 'approval';
        attempt.data.providerSuspension = { generation: attempt.generation, modalKey: typeof held.data.modalKey === 'string' ? held.data.modalKey : null, providerSetup: held.data.providerSetup === true, at: held.data.suspendedAt === null ? null : Number(held.data.suspendedAt ?? held.createdAt), resolvedAt: null };
        releaseHolds(draft, ['suspension_before_consumed']);
        attempt.state = 'suspended';
        attempt.suspension = modal;
        draft.effects.push({ kind: 'bus', event: { kind: 'turn', phase: 'suspended', sessionId: attempt.sessionId, attemptId: attempt.attemptId, generation: attempt.generation } });
        notify(draft, modal);
    },
    suspend: (draft) => {
        const attempt = draft.attempt!;
        const ev = draft.ctx.evidence as TurnEvidenceOf<'suspension'>;
        attempt.suspension = ev.modal;
        attempt.data.providerSuspension = { generation: attempt.generation, modalKey: ev.modalKey ?? null, providerSetup: ev.providerSetup === true, at: ev.clockUnknown ? null : ev.at, resolvedAt: null };
        attempt.weakSince = null;
    },
    resume: (draft) => {
        const attempt = draft.attempt!;
        attempt.suspension = null;
        if (attempt.data.providerSuspension?.generation === attempt.generation) attempt.data.providerSuspension.resolvedAt = draft.ctx.evidence.at;
    },
    resume_by_activity: (draft) => {
        const attempt = draft.attempt!;
        attempt.suspension = null;
        if (attempt.data.providerSuspension?.generation === attempt.generation && attempt.data.providerSuspension.resolvedAt === null) attempt.data.providerSuspension.resolvedAt = draft.ctx.evidence.at;
        attempt.lastActivityAt = activityAt(draft.ctx.evidence);
        attempt.livenessFailStreak = 0;
    },
    weak_candidate: (draft) => {
        const attempt = draft.attempt!;
        attempt.data.unconfirmedEndDeferral = undefined;
        attempt.weakSince = draft.ctx.evidence.at;
    },
    clear_weak: (draft) => {
        draft.attempt!.weakSince = null;
    },
    await_report: (draft) => {
        draft.attempt!.data.unconfirmedEndDeferral = undefined;
        draft.attempt!.weakSince = draft.ctx.evidence.at;
    },
    false_idle: (draft) => {
        const attempt = draft.attempt!;
        attempt.weakSince = null;
        attempt.lastActivityAt = Math.max(attempt.lastActivityAt ?? 0, activityAt(draft.ctx.evidence));
        attempt.livenessFailStreak = 0;
        attempt.data = { ...attempt.data, unconfirmedEndDeferral: undefined, falseIdleCount: (attempt.data.falseIdleCount ?? 0) + 1 };
    },
    activity: (draft) => {
        const attempt = draft.attempt!;
        const ev = draft.ctx.evidence;
        attempt.lastActivityAt = Math.max(attempt.lastActivityAt ?? 0, activityAt(ev));
        attempt.livenessFailStreak = 0;
        if (ev.kind === 'liveness') {
            attempt.lastLiveness = ev.result;
            attempt.data.livenessObservation = { generation: attempt.generation, sessionId: ev.sessionId, at: ev.at, probeStartedAt: ev.probeStartedAtMs ?? ev.at };
        }
    },
    liveness_unknown: (draft) => {
        draft.attempt!.lastLiveness = 'unknown';
        const ev = draft.ctx.evidence as TurnEvidenceOf<'liveness'>;
        draft.attempt!.data.livenessObservation = { generation: draft.attempt!.generation, sessionId: ev.sessionId, at: ev.at, probeStartedAt: ev.probeStartedAtMs ?? ev.at };
    },
    liveness_failure: (draft) => {
        const attempt = draft.attempt!;
        attempt.livenessFailStreak += 1;
        const ev = draft.ctx.evidence as TurnEvidenceOf<'liveness'>;
        attempt.lastLiveness = ev.result;
        attempt.data.livenessObservation = { generation: attempt.generation, sessionId: ev.sessionId, at: ev.at, probeStartedAt: ev.probeStartedAtMs ?? ev.at };
    },
    defer_unconfirmed_end: (draft) => {
        // R13u: the timer ran out while the last probe could not confirm the worker.
        // Re-arm the SAME hold (same reason/id, opener's text pointer in `data`) for a
        // short liveness grace; the paired `probe` effect asks for a fresh verdict.
        const attempt = draft.attempt!;
        const hold = expiredHold(draft.ctx);
        if (!hold) return;
        const prior = attempt.data.unconfirmedEndDeferral;
        const count = prior && prior.generation === attempt.generation && prior.requestedAt !== undefined ? prior.count : 0;
        attempt.data = { ...attempt.data, unconfirmedEndDeferral: { generation: attempt.generation, count: count + 1, requestedAt: draft.ctx.nowMs } };
        addHold(draft, { ...hold, until: draft.ctx.nowMs + endProbeGraceMs(draft.ctx.policy), createdAt: draft.ctx.nowMs });
    },
    open_report_correction: (draft) => {
        const a = draft.attempt!;
        if (a.data.reportCorrection?.generation === a.generation || reportedThisGeneration(draft.ctx)) return;
        const until = draft.ctx.nowMs + reportCorrectionMs(draft.ctx.policy);
        a.data.reportCorrection = { generation: a.generation, until };
        addHold(draft, { holdId: holdId(a.attemptId, 'report_correction'), attemptId: a.attemptId, generation: a.generation, reason: 'report_correction', until, onExpire: 'commit', data: {}, createdAt: draft.ctx.nowMs });
    },
    worker_absent: (draft) => {
        if ((draft.ctx.evidence as TurnEvidenceOf<'dispatch_failed'>).workerAbsent) draft.attempt!.livenessFailStreak += 1;
    },
    rebind_to_holder: (draft) => {
        bindLivenessSession(draft, (draft.ctx.evidence as TurnEvidenceOf<'duplicate_dispatch_refusal'>).holderSessionId);
    },
    rebind: (draft) => {
        bindLivenessSession(draft, (draft.ctx.evidence as TurnEvidenceOf<'session_rebound'>).toSessionId, true);
    },
    hollow: (draft) => {
        draft.attempt!.hollowCount += 1;
    },
    mark_notified: (draft) => {
        const ev = draft.ctx.evidence as TurnEvidenceOf<'coordinator_ack'>;
        if (TERMINAL_NOTIFY_KINDS.includes(ev.notify) && isTerminalTurnState(draft.attempt!.state)) {
            draft.attempt!.notifiedAt = draft.attempt!.notifiedAt ?? ev.at;
        }
    },
    store_git: (draft) => {
        const ev = draft.ctx.evidence as TurnEvidenceOf<'git_side_effect'>;
        draft.attempt!.data = { ...draft.attempt!.data, gitSideEffect: { dirty: ev.dirty, commitsSinceDispatch: ev.commitsSinceDispatch, attributable: ev.attributable, at: ev.at } };
    },
    redrive: (draft) => {
        draft.attempt!.redriveCount += 1;
    },
    stamp_no_progress_notice: (draft) => {
        draft.attempt!.lastNoProgressNoticeAt = draft.ctx.nowMs;
    },
    record_report: (draft) => {
        const attempt = draft.attempt!;
        const ev = draft.ctx.evidence as TurnEvidenceOf<'worker_report'>;
        attempt.data = {
            ...attempt.data,
            report: { generation: attempt.generation, outcome: ev.outcome, eventId: ev.eventId, at: ev.at, ...(ev.summary ? { summary: ev.summary } : {}) },
        };
    },
};

function resolveNote(note: string, draft: Draft): string {
    if (note === 'from_admission') {
        const admission = admissionOf(draft.ctx);
        return admission && admission.kind === 'decline' ? `admission_declined:${admission.reason}` : 'admission_declined';
    }
    if (note === 'from_terminal_compare') {
        const terminal = draft.attempt?.terminal;
        const proposed = proposedOutcome(draft.ctx.evidence);
        return terminal && proposed === terminal.outcome ? 'duplicate' : 'already_terminal';
    }
    return note;
}

/** Outcome a terminal-class evidence would have committed (for R19's duplicate/already_terminal note). */
function proposedOutcome(ev: TurnEvidence): TurnOutcome | null {
    switch (ev.kind) {
        case 'turn_end': return ev.afterFinalizationTimeout || ev.hollow ? 'failed' : 'completed';
        case 'transcript_final':
        case 'no_progress': return 'completed';
        case 'worker_report': return ev.outcome;
        case 'session_error': return 'failed';
        case 'process_exit': return 'failed';
        case 'cancel': return 'cancelled';
        case 'operator_status': return ev.status;
        default: return null;
    }
}

function exitReclaimReason(state: TurnAttempt['state']): TurnReason {
    return state === 'accepted' || state === 'delivered' ? 'session_exit_before_turn' : 'session_exit';
}

function applyTemplate(template: EffectTemplate, draft: Draft): void {
    if (draft.committed) return;
    const { evidence: ev, nowMs } = draft.ctx;
    switch (template.e) {
        case 'act':
            ACTIONS[template.act](draft);
            return;
        case 'hold': {
            const attempt = draft.attempt!;
            if (template.meshOnly && !isMeshScope(attempt)) return;
            let reason: HoldReason;
            const data: Record<string, string | number | boolean | null> = {};
            if (template.reason === 'from_admission') {
                const admission = admissionOf(draft.ctx);
                if (admission?.kind !== 'hold') return;
                reason = admission.holdReason;
                data.evidenceId = ev.eventId;
                data.decline = admission.reason;
            } else {
                reason = template.reason;
            }
            if (reason === 'suspension_before_consumed' && ev.kind === 'suspension') { data.modal = ev.modal; data.modalKey = ev.modalKey ?? null; data.suspendedAt = ev.clockUnknown ? null : ev.at; data.providerSetup = ev.providerSetup === true; }
            if (reason === 'await_report' && ownerProbedQueueNativeCompletion(draft.ctx)) data.nativeProbeReportOnly = true;
            if (TEXT_CARRYING_HOLDS.includes(reason)) {
                data.textEventId = ev.eventId;
                const opener = summaryOf(ev);
                if (opener) { data.summaryTopic = opener.topic; data.summaryWriter = opener.writer; data.summarySeq = opener.seq; }
            }
            addHold(draft, {
                holdId: holdId(attempt.attemptId, reason),
                attemptId: attempt.attemptId,
                generation: template.generationAgnostic ? null : attempt.generation,
                reason,
                until: resolveUntil(template.until, draft),
                onExpire: template.onExpire,
                data,
                createdAt: nowMs,
            });
            return;
        }
        case 'release': {
            if (template.reasons === 'expired_hold') {
                if (ev.kind === 'hold_expired') releaseHolds(draft, [ev.reason]);
                return;
            }
            releaseHolds(draft, template.reasons);
            return;
        }
        case 'commit': {
            let outcome: TurnOutcome;
            if (template.outcome === 'from_report') {
                outcome = (ev as TurnEvidenceOf<'worker_report'>).outcome;
            } else if (template.outcome === 'from_recorded_report') {
                // The generation-scoped report guard proves this report exists.
                outcome = draft.attempt!.data.report!.outcome;
            } else if (template.outcome === 'from_operator') {
                outcome = (ev as TurnEvidenceOf<'operator_status'>).status;
            } else {
                outcome = template.outcome;
            }
            let reason: TurnReason;
            if (template.reason === 'from_cancel') reason = (ev as TurnEvidenceOf<'cancel'>).reason;
            else if (template.reason === 'from_operator') reason = (ev as TurnEvidenceOf<'operator_status'>).reason;
            else if (template.reason === 'from_provider_failure') {
                const failure = (ev as TurnEvidenceOf<'process_exit' | 'turn_end'>).providerFailure ?? 'provider_error';
                reason = failure === 'provider_error' ? failure : `provider_${failure}`;
            } else reason = template.reason;
            commit(draft, outcome, template.strength, reason, template.text === 'recorded_report' ? recordedReportText(draft) : undefined);
            return;
        }
        case 'reclaim': {
            let reason: TurnReason;
            if (template.reason === 'from_refusal') reason = `dispatch_refused_${(ev as TurnEvidenceOf<'delivery_refused'>).reason}` as TurnReason;
            else if (template.reason === 'from_exit_state') reason = exitReclaimReason(draft.attempt!.state);
            else reason = template.reason;
            reclaim(draft, reason);
            return;
        }
        case 'notify': {
            const attempt = draft.attempt!;
            if (template.when === 'candidate_once') {
                if (attempt.candidateNotifiedGeneration === attempt.generation) return;
                attempt.candidateNotifiedGeneration = attempt.generation;
            }
            if (template.when === 'no_progress_due') {
                const last = attempt.lastNoProgressNoticeAt;
                if (last !== null && nowMs - last < draft.ctx.policy.livenessDeadlineMs) return;
                ACTIONS.stamp_no_progress_notice(draft);
            }
            const kind: NotifyKind = template.notify === 'from_modal' ? (ev as TurnEvidenceOf<'suspension'>).modal : template.notify;
            const summary = summaryOf(ev);
            notify(draft, kind, {
                ...(template.generation === 'evidence' && draft.ctx.effectiveGeneration !== null ? { generation: draft.ctx.effectiveGeneration } : {}),
                ...(summary ? { summary } : {}),
            });
            return;
        }
        case 'adopt_prev_generation': {
            // R27a: g has not started — cut it, rebind the attempt to the g−1
            // session that did the work, and commit that work. The generation
            // number stays g (monotonic); the committed row names g.
            const attempt = draft.attempt!;
            const prev = attempt.prevGeneration!;
            // g was re-delivered to another session → cut it. Still `accepted` on
            // the g−1 session (not yet re-delivered) → there is no g session to cut,
            // and the g−1 session is the one whose work is being adopted.
            if (!sessionIdsEquivalent(attempt.sessionId, prev.sessionId)) {
                const adopted = adoptedTerminal(ev);
                beginWriterStop(draft, adopted.reason);
                attempt.data.writerStop!.terminal = { outcome: adopted.outcome, strength: adopted.strength, adoptSessionId: prev.sessionId,
                    source: ev.source, summary: summaryOf(ev), textEventId: ev.eventId };
                return;
            }
            attempt.sessionId = prev.sessionId;
            attempt.consumedAt = attempt.consumedAt ?? ev.at;
            const adopted = adoptedTerminal(ev);
            commit(draft, adopted.outcome, adopted.strength, adopted.reason);
            return;
        }
        case 'bus': {
            const attempt = draft.attempt!;
            draft.effects.push({ kind: 'bus', event: { kind: 'turn', phase: template.phase, sessionId: attempt.sessionId, attemptId: attempt.attemptId, generation: attempt.generation } });
            return;
        }
        case 'record':
            draft.effects.push({ kind: 'record', note: resolveNote(template.note, draft) });
            return;
        case 'cancel_dispatch': {
            const attempt = draft.attempt!;
            // The following commit records a durable stop intent and owns its
            // proof-fenced executor. Never send an unfenced stop ahead of it.
            if (ev.kind === 'cancel' && isMeshScope(attempt)) return;
            if (template.when === 'not_intentional_cleanup' && ev.kind === 'cancel' && ev.reason === 'intentional_cleanup') return;
            if (template.target === 'evidence_session') {
                draft.effects.push({ kind: 'cancel_dispatch', attemptId: attempt.attemptId, generation: draft.ctx.effectiveGeneration ?? attempt.generation, sessionId: ev.sessionId });
            } else {
                draft.effects.push({ kind: 'cancel_dispatch', attemptId: attempt.attemptId, generation: attempt.generation, sessionId: attempt.sessionId });
            }
            return;
        }
        case 'redeliver': {
            const attempt = draft.attempt!;
            draft.effects.push({ kind: 'redeliver', attemptId: attempt.attemptId, generation: attempt.generation, messageId: attempt.messageId, sessionId: attempt.sessionId });
            return;
        }
        case 'probe': {
            const attempt = draft.attempt!;
            draft.effects.push({ kind: 'probe', attemptId: attempt.attemptId, sessionId: attempt.sessionId });
            return;
        }
        case 'reevaluate': {
            const attempt = draft.attempt!;
            const hold = expiredHold(draft.ctx);
            const evidenceId = typeof hold?.data.evidenceId === 'string' ? hold.data.evidenceId : '';
            draft.effects.push({ kind: 'reevaluate', attemptId: attempt.attemptId, evidenceId, forceLiveFalse: true });
            return;
        }
    }
}

// ─── reduce ──────────────────────────────────────────────────────────────

export function reduce(input: ReduceInput): ReduceResult {
    const { attempt, holds, evidence } = input;
    const lane = classifyLane(attempt, evidence, holds);
    if ('rejection' in lane) {
        return { attempt, holds: [...holds], effects: [{ kind: 'record', note: lane.rejection }], verdict: 'rejected', rejection: lane.rejection };
    }
    if (attempt?.state === 'stopping' && lane.lane === 'current') return reduceStopping(input);
    const matches = matchingRules(input);
    const rule = matches[0];
    if (!rule) {
        const rejection: ReduceRejection = attempt && isTerminalTurnState(attempt.state) ? 'already_terminal' : 'illegal_transition';
        return { attempt, holds: [...holds], effects: [{ kind: 'record', note: rejection }], verdict: 'rejected', rejection };
    }

    const draft: Draft = {
        attempt: attempt ? cloneAttempt(attempt) : null,
        holds: new Map(holds.map((h) => [h.holdId, h])),
        effects: [],
        ctx: { ...input, effectiveGeneration: lane.effectiveGeneration },
        rule,
        committed: false,
    };
    // Rules that only record never mutate the attempt.
    for (const template of rule.effects) applyTemplate(template, draft);
    if (rule.verdict === 'applied' && draft.attempt && !draft.committed) {
        const target = rule.to;
        if (target !== 'same' && target !== 'outcome' && draft.attempt.state === (attempt?.state ?? draft.attempt.state)) {
            // Reclaim already moved the state; a held suspension already moved R4 to `suspended`.
            draft.attempt.state = target;
        }
    }
    return {
        attempt: draft.attempt,
        holds: [...draft.holds.values()],
        effects: draft.effects,
        verdict: rule.verdict,
        rule: rule.id,
    };
}

// ─── hold expiry → evidence ──────────────────────────────────────────────

export interface ExpireHoldsContext {
    /** Daemon running the sweep (evidence `observedBy`). */
    observedBy: string;
    /** Session the attempt is bound to (evidence envelope `sessionId`). */
    sessionIdFor(attemptId: string): string;
}

/**
 * Due holds → `hold_expired` evidence, in deadline order (ties by holdId), so
 * one sweep is deterministic. The eventId embeds the deadline: a re-armed hold
 * (same holdId, new `until`) expires as a new event, a re-swept one dedupes.
 */
export function expireHolds(holds: readonly TurnHold[], nowMs: number, ctx: ExpireHoldsContext): TurnEvidenceOf<'hold_expired'>[] {
    return holds
        .filter((hold): hold is TurnHold & { until: number } => hold.until !== null && hold.until <= nowMs)
        .sort((a, b) => a.until - b.until || (a.holdId < b.holdId ? -1 : a.holdId > b.holdId ? 1 : 0))
        .map((hold) => ({
            eventId: `hold_expired:${hold.holdId}:${hold.until}`,
            at: nowMs,
            source: 'scheduler' as const,
            sessionId: ctx.sessionIdFor(hold.attemptId),
            ...(hold.generation !== null ? { attemptRef: { attemptId: hold.attemptId, generation: hold.generation } } : {}),
            observedBy: ctx.observedBy,
            kind: 'hold_expired' as const,
            holdId: hold.holdId,
            reason: hold.reason,
        }));
}
