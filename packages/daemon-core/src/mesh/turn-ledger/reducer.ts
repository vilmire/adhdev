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
    RECLAIM_BUDGET,
    awaitDeliveryMs,
    consumeGraceFor,
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

/** Kinds produced BY the worker session itself; their sessionId must match the attempt's. */
const SESSION_PRODUCED_KINDS: ReadonlySet<TurnEvidenceKind> = new Set<TurnEvidenceKind>([
    'turn_started', 'suspension', 'suspension_resolved', 'turn_end', 'transcript_final',
    'transcript_activity', 'no_progress', 'process_exit', 'session_error', 'worker_report', 'worker_progress',
]);

// ─── lane classification ─────────────────────────────────────────────────

export type LaneResult =
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

function notHeld(ctx: GuardCtx): boolean {
    return admissionOf(ctx)?.kind !== 'hold';
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
        if (ev.kind === 'turn_end') return ev.strength === 'genuine' && !ev.hollow;
        if (ev.kind === 'transcript_final') return admitTranscriptFinal(ev, ctx.policy).kind === 'strong';
        return false;
    },
    stale_session_distinct: (ctx) => !!ctx.attempt && !sessionIdsEquivalent(ctx.evidence.sessionId, ctx.attempt.sessionId),
    reclaiming_refusal: (ctx) => ctx.evidence.kind === 'delivery_refused'
        && (RECLAIMING_SEND_REFUSALS as readonly string[]).includes(ctx.evidence.reason),
    suspension_changed: (ctx) => ctx.evidence.kind === 'suspension' && ctx.attempt?.suspension !== ctx.evidence.modal,
    end_genuine: (ctx) => { const e = turnEnd(ctx); return !!e && e.strength === 'genuine' && !e.hollow && notHeld(ctx); },
    end_weak: (ctx) => { const e = turnEnd(ctx); return !!e && e.strength === 'weak' && !e.afterFinalizationTimeout && !e.hollow && notHeld(ctx); },
    end_weak_after_timeout: (ctx) => { const e = turnEnd(ctx); return !!e && e.strength === 'weak' && !!e.afterFinalizationTimeout && !e.hollow && notHeld(ctx); },
    hollow_retry: (ctx) => { const e = turnEnd(ctx); return !!e && !!e.hollow && notHeld(ctx) && ctx.attempt!.hollowCount < ctx.attempt!.maxTaskRetries; },
    hollow_exhausted: (ctx) => { const e = turnEnd(ctx); return !!e && !!e.hollow && notHeld(ctx) && ctx.attempt!.hollowCount >= ctx.attempt!.maxTaskRetries; },
    final_strong: (ctx) => ctx.evidence.kind === 'transcript_final' && admissionOf(ctx)?.kind === 'strong',
    final_weak: (ctx) => ctx.evidence.kind === 'transcript_final' && admissionOf(ctx)?.kind === 'weak',
    genuine_end_or_strong_final: (ctx) => GUARDS.end_genuine(ctx) || GUARDS.final_strong(ctx),
    weak_end_or_final: (ctx) => GUARDS.end_weak(ctx) || GUARDS.final_weak(ctx),
    admission_hold: (ctx) => admissionOf(ctx)?.kind === 'hold',
    admission_decline: (ctx) => admissionOf(ctx)?.kind === 'decline',
    after_weak_since: afterWeakSince,
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
    final_present: (ctx) => ctx.evidence.kind === 'no_progress' && ctx.evidence.finalAssistantPresent,
    hold_await_delivery: (ctx) => holdIs(ctx, 'await_delivery'),
    hold_await_consume_redrive: (ctx) => holdIs(ctx, 'await_consume') && ctx.attempt!.redriveCount < MAX_REDRIVES_PER_GENERATION,
    hold_await_consume_exhausted: (ctx) => holdIs(ctx, 'await_consume') && ctx.attempt!.redriveCount >= MAX_REDRIVES_PER_GENERATION,
    hold_await_turn: (ctx) => holdIs(ctx, 'await_turn'),
    hold_liveness: (ctx) => holdIs(ctx, 'liveness'),
    hold_hard_ceiling: (ctx) => holdIs(ctx, 'hard_ceiling'),
    hold_suspension_before_consumed: (ctx) => holdIs(ctx, 'suspension_before_consumed'),
    hold_weak_candidate: (ctx) => holdIs(ctx, 'weak_candidate'),
    hold_admission: (ctx) => holdIs(ctx, 'live_pending', 'transcript_quiet'),
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
        data: { ...attempt.data, ...(attempt.data.gitSideEffect ? { gitSideEffect: { ...attempt.data.gitSideEffect } } : {}) },
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
        case 'unknown_grace': return nowMs + unknownLivenessGraceMs(policy);
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

function notify(draft: Draft, kind: NotifyKind, opts: { generation?: number; summary?: SummaryRef } = {}): void {
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
    });
}

function summaryOf(ev: TurnEvidence): SummaryRef | undefined {
    if (ev.kind === 'turn_end' || ev.kind === 'transcript_final' || ev.kind === 'worker_report') return ev.summary;
    return undefined;
}

function commit(
    draft: Draft,
    outcome: TurnOutcome,
    strength: NonNullable<TurnAttempt['terminal']>['strength'],
    reason: TurnReason,
): void {
    const attempt = draft.attempt!;
    const ev = draft.ctx.evidence;
    const summary = summaryOf(ev);
    attempt.state = outcome;
    attempt.suspension = null;
    attempt.terminal = { outcome, reason, source: ev.source, strength, at: ev.at, ...(summary ? { summary } : {}) };
    draft.effects.push({
        kind: 'commit', attemptId: attempt.attemptId, generation: attempt.generation,
        outcome, strength, reason, source: ev.source, ...(summary ? { summary } : {}),
    });
    releaseHolds(draft, '*');
    // Both mesh scopes carry a queue row: `mesh_queue` owns one, and a
    // `mesh_direct` dispatch materialises one pre-assigned
    // (`recordDirectDispatchTask`) for mission attribution + status. Gating this
    // on `mesh_queue` alone left a committed direct dispatch's row `assigned`
    // forever (live, rc.37: task 2cb0ab79). A direct attempt with no row is a
    // no-op at the host (`applyTaskTerminalInTxn` finds no entry).
    if (isMeshScope(attempt) && attempt.meshId && attempt.taskId) {
        draft.effects.push({ kind: 'queue_status', meshId: attempt.meshId, taskId: attempt.taskId, status: outcome, reason });
        draft.effects.push({ kind: 'graph_advance', meshId: attempt.meshId, taskId: attempt.taskId, outcome });
    }
    draft.effects.push({ kind: 'bus', event: { kind: 'turn', phase: 'committed', sessionId: attempt.sessionId, attemptId: attempt.attemptId, generation: attempt.generation, outcome, strength } });
    notify(draft, outcome, summary ? { summary } : {});
    draft.effects.push({ kind: 'release_attempt_ref', attemptId: attempt.attemptId, sessionId: attempt.sessionId });
    draft.committed = true;
}

/**
 * generation + 1 and back to `accepted` — or `failed` when the reclaim budget
 * is spent. A plain attempt has no dispatcher to re-claim it, so its
 * "reclaim" is a failure too.
 *
 * Reclaim CUTS the old generation first (owner revision 2026-09-23): the
 * `cancel_dispatch` for g−1's session is emitted unconditionally — an
 * `accepted` attempt's prompt may still sit in the worker's input queue, and
 * withdrawing it by messageId is exactly what stops a late start — and it
 * carries `revokeBind`, so g−1's worker can no longer report through the MCP.
 * A late g−1 completion can then only arrive inside the window between this
 * txn and the cancel landing (R27/R27a).
 *
 * The one skip: an `accepted` generation ≥ 1 that was never delivered still
 * names the ALREADY-CUT previous session (a reclaim does not rebind; the next
 * `delivered` does) — cutting it again would stop a session that is no longer
 * this attempt's, so no cancel is emitted for it.
 */
function reclaim(draft: Draft, reason: TurnReason): void {
    const attempt = draft.attempt!;
    if (attempt.scope === 'plain') {
        commit(draft, 'failed', 'genuine', reason);
        return;
    }
    if (attempt.reclaimCount >= RECLAIM_BUDGET) {
        commit(draft, 'failed', 'genuine', 'reclaim_budget_exhausted');
        return;
    }
    const prevSession = attempt.sessionId;
    const prevMessageId = attempt.messageId;
    const fromGeneration = attempt.generation;
    const alreadyCut = attempt.state === 'accepted' && attempt.prevGeneration !== null
        && sessionIdsEquivalent(attempt.sessionId, attempt.prevGeneration.sessionId);
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
    draft.effects.push({ kind: 'reclaim', attemptId: attempt.attemptId, fromGeneration, toGeneration: attempt.generation, reason });
    releaseHolds(draft, '*', ['hard_ceiling']);
    if (!alreadyCut) {
        draft.effects.push({ kind: 'cancel_dispatch', attemptId: attempt.attemptId, generation: fromGeneration, sessionId: prevSession, messageId: prevMessageId, revokeBind: true });
    }
    if (attempt.scope === 'mesh_queue' && attempt.meshId && attempt.taskId) {
        draft.effects.push({ kind: 'queue_status', meshId: attempt.meshId, taskId: attempt.taskId, status: 'pending', reason });
    }
    addHold(draft, {
        holdId: holdId(attempt.attemptId, 'await_delivery'), attemptId: attempt.attemptId, generation: attempt.generation,
        reason: 'await_delivery', until: draft.ctx.nowMs + awaitDeliveryMs(draft.ctx.policy), onExpire: 'reclaim', data: {}, createdAt: draft.ctx.nowMs,
    });
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

const TERMINAL_NOTIFY_KINDS: readonly NotifyKind[] = ['completed', 'failed', 'cancelled', 'stopped'];

/** The terminal a genuine g−1 completion commits when R27a adopts it. */
function adoptedTerminal(ev: TurnEvidence): { outcome: TurnOutcome; strength: TurnCommitStrength; reason: TurnReason } {
    if (ev.kind === 'worker_report') {
        return { outcome: ev.outcome === 'completed' ? 'completed' : 'failed', strength: 'tool_report', reason: 'worker_reported' };
    }
    if (ev.kind === 'transcript_final') return { outcome: 'completed', strength: 'genuine', reason: 'transcript_final' };
    return { outcome: 'completed', strength: 'genuine', reason: 'turn_end' };
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
        attempt.sessionId = ev.sessionId;
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
        releaseHolds(draft, ['suspension_before_consumed']);
        attempt.state = 'suspended';
        attempt.suspension = modal;
        draft.effects.push({ kind: 'bus', event: { kind: 'turn', phase: 'suspended', sessionId: attempt.sessionId, attemptId: attempt.attemptId, generation: attempt.generation } });
        notify(draft, modal);
    },
    suspend: (draft) => {
        const attempt = draft.attempt!;
        attempt.suspension = (draft.ctx.evidence as TurnEvidenceOf<'suspension'>).modal;
        attempt.weakSince = null;
    },
    resume: (draft) => {
        draft.attempt!.suspension = null;
    },
    resume_by_activity: (draft) => {
        const attempt = draft.attempt!;
        attempt.suspension = null;
        attempt.lastActivityAt = activityAt(draft.ctx.evidence);
        attempt.livenessFailStreak = 0;
    },
    weak_candidate: (draft) => {
        const attempt = draft.attempt!;
        attempt.weakSince = draft.ctx.evidence.at;
    },
    clear_weak: (draft) => {
        draft.attempt!.weakSince = null;
    },
    activity: (draft) => {
        const attempt = draft.attempt!;
        const ev = draft.ctx.evidence;
        attempt.lastActivityAt = Math.max(attempt.lastActivityAt ?? 0, activityAt(ev));
        attempt.livenessFailStreak = 0;
        if (ev.kind === 'liveness') attempt.lastLiveness = ev.result;
    },
    liveness_unknown: (draft) => {
        draft.attempt!.lastLiveness = 'unknown';
    },
    liveness_failure: (draft) => {
        const attempt = draft.attempt!;
        attempt.livenessFailStreak += 1;
        attempt.lastLiveness = (draft.ctx.evidence as TurnEvidenceOf<'liveness'>).result;
    },
    worker_absent: (draft) => {
        if ((draft.ctx.evidence as TurnEvidenceOf<'dispatch_failed'>).workerAbsent) draft.attempt!.livenessFailStreak += 1;
    },
    rebind_to_holder: (draft) => {
        draft.attempt!.sessionId = (draft.ctx.evidence as TurnEvidenceOf<'duplicate_dispatch_refusal'>).holderSessionId;
    },
    rebind: (draft) => {
        draft.attempt!.sessionId = (draft.ctx.evidence as TurnEvidenceOf<'session_rebound'>).toSessionId;
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
        case 'worker_report': return ev.outcome === 'completed' ? 'completed' : 'failed';
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
            if (reason === 'suspension_before_consumed' && ev.kind === 'suspension') data.modal = ev.modal;
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
                outcome = (ev as TurnEvidenceOf<'worker_report'>).outcome === 'completed' ? 'completed' : 'failed';
            } else if (template.outcome === 'from_operator') {
                outcome = (ev as TurnEvidenceOf<'operator_status'>).status;
            } else {
                outcome = template.outcome;
            }
            let reason: TurnReason;
            if (template.reason === 'from_cancel') reason = (ev as TurnEvidenceOf<'cancel'>).reason;
            else if (template.reason === 'from_operator') reason = (ev as TurnEvidenceOf<'operator_status'>).reason;
            else if (template.reason === 'from_provider_failure') {
                reason = (ev as TurnEvidenceOf<'process_exit'>).providerFailure === 'billing_failed' ? 'provider_billing_failed' : 'provider_auth_failed';
            } else reason = template.reason;
            commit(draft, outcome, template.strength, reason);
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
                draft.effects.push({
                    kind: 'cancel_dispatch', attemptId: attempt.attemptId, generation: attempt.generation,
                    sessionId: attempt.sessionId, messageId: attempt.messageId, revokeBind: true,
                });
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
