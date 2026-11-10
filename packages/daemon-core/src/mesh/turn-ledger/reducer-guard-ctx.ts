// Guard-context helpers of the turn-ledger reducer (moved out of reducer.ts unchanged,
// only `export`ed, to keep it under the file-size gate). Pure functions of GuardCtx.

import {
    sessionIdsEquivalent,
    type HoldReason,
    type TurnEvidence,
    type TurnEvidenceOf,
} from '@adhdev/mesh-shared';
import { admitTranscriptFinal, admitTurnEnd, type EvidenceAdmission } from './admission.js';
import { endProbeGraceMs, type TurnPolicy } from './policy.js';
import type { TurnAttempt, TurnHold } from './types.js';

const isMeshScope = (attempt: TurnAttempt): boolean => attempt.scope !== 'plain';

export interface GuardCtx {
    attempt: TurnAttempt | null;
    holds: readonly TurnHold[];
    evidence: TurnEvidence;
    policy: TurnPolicy;
    nowMs: number;
    effectiveGeneration: number | null;
    backgroundWorkLive?: boolean;
    hardCeilingActive?: boolean;
}

export function admissionOf(ctx: GuardCtx): EvidenceAdmission | null {
    const ev = ctx.evidence;
    if (ev.kind === 'transcript_final') return admitTranscriptFinal(ev, ctx.policy);
    if (ev.kind === 'turn_end') return admitTurnEnd(ev, ctx.policy);
    return null;
}

export function expiredHold(ctx: GuardCtx): TurnHold | undefined {
    const ev = ctx.evidence;
    if (ev.kind !== 'hold_expired') return undefined;
    const hold = ctx.holds.find((h) => h.holdId === ev.holdId);
    if (!hold || hold.reason !== ev.reason || (ctx.attempt && hold.attemptId !== ctx.attempt.attemptId)) return undefined;
    return hold;
}

export function holdIs(ctx: GuardCtx, ...reasons: HoldReason[]): boolean {
    const hold = expiredHold(ctx);
    return !!hold && reasons.includes(hold.reason);
}

export function activityAt(ev: TurnEvidence): number {
    return ev.kind === 'transcript_activity' ? ev.newestActivityAt : ev.at;
}

export function afterWeakSince(ctx: GuardCtx): boolean {
    const since = ctx.attempt?.weakSince;
    return since !== null && since !== undefined && activityAt(ctx.evidence) > since;
}

export function turnEnd(ctx: GuardCtx): TurnEvidenceOf<'turn_end'> | null {
    return ctx.evidence.kind === 'turn_end' ? ctx.evidence : null;
}

/**
 * A turn_end the worker's daemon stamped `providerFailure` (its whole reply was
 * an auth/billing failure banner — 2026-10-06 preview incident, claude-cli
 * "Login expired · Please run /login" committed task_completed). R9f fails it;
 * every completion-shaped turn_end guard below excludes it.
 */
export function completionEnd(ctx: GuardCtx): TurnEvidenceOf<'turn_end'> | null {
    const e = turnEnd(ctx);
    return e && !e.providerFailure && e.nativeOutcome !== 'failed' ? e : null;
}

export function notHeld(ctx: GuardCtx): boolean {
    return admissionOf(ctx)?.kind !== 'hold';
}

/**
 * A genuine end stamped `reportExpected` by the worker's daemon (live
 * worker-MCP bind) on a mesh attempt: the structured report, not the idle
 * edge, commits it (R9r). Plain attempts never await a report.
 */
export function reportAwaitedEnd(ctx: GuardCtx): boolean {
    const e = completionEnd(ctx);
    return !!e && e.strength === 'genuine' && !e.hollow && e.reportExpected === true
        && !!ctx.attempt && isMeshScope(ctx.attempt);
}

/**
 * R17g recorded a worker report for the attempt's CURRENT generation (the
 * report arrived before the idle edge). A reclaim bumps the generation, so a
 * report of a cut generation never satisfies this.
 */
export function reportedThisGeneration(ctx: GuardCtx): boolean {
    const attempt = ctx.attempt;
    return !!attempt && attempt.data.report?.generation === attempt.generation;
}

/**
 * A clean process exit while a report recorded for this generation still waits
 * on its `await_end` hold (R20r): the exit ends the turn, so the report commits.
 */
export function exitAfterReport(ctx: GuardCtx): boolean {
    const attempt = ctx.attempt;
    return ctx.evidence.kind === 'process_exit' && !ctx.evidence.providerFailure && reportedThisGeneration(ctx)
        && ctx.holds.some((h) => h.reason === 'await_end' && (!attempt || h.attemptId === attempt.attemptId));
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
export function finishedAfterReport(ctx: GuardCtx): boolean {
    if (!reportedThisGeneration(ctx)) return false;
    const ev = ctx.evidence;
    if (ev.kind === 'turn_end' || ev.kind === 'transcript_final') {
        const admission = admissionOf(ctx);
        return admission?.kind === 'strong' || admission?.kind === 'weak' || admission?.kind === 'decline';
    }
    return ev.kind === 'no_progress' && ev.finalAssistantPresent;
}

/** A weakly admitted transcript_final (R15 / R15p / R10a). */
export function finalWeak(ctx: GuardCtx): boolean {
    return ctx.evidence.kind === 'transcript_final' && admissionOf(ctx)?.kind === 'weak' && !reportedThisGeneration(ctx);
}

/** Evidence the owner read itself — never the worker daemon's turn verdict. */
export const OWNER_SCRAPE_SOURCES: ReadonlySet<string> = new Set(['coordinator_probe', 'mcp_probe']);

/**
 * R15p: a transcript_final the owner scraped on a mesh attempt. The worker's
 * daemon emits its own turn_end (and withholds it while its completion gate
 * holds), so a scrape alone awaits the report instead of committing weak.
 */
export function ownerScrapedMeshFinal(ctx: GuardCtx): boolean {
    return ctx.evidence.kind === 'transcript_final' && OWNER_SCRAPE_SOURCES.has(ctx.evidence.source)
        && !!ctx.attempt && isMeshScope(ctx.attempt);
}

/** A native marker ends the provider turn, but an owner probe cannot use it as
 * the task verdict for a report-owning queue worker. R15p waits for the report. */
export function ownerProbedQueueNativeCompletion(ctx: GuardCtx): boolean {
    const ev = ctx.evidence;
    return ev.kind === 'transcript_final' && ev.nativeRead && ev.nativeMarker?.outcome === 'completed'
        && OWNER_SCRAPE_SOURCES.has(ev.source) && ctx.attempt?.scope === 'mesh_queue'
        && admissionOf(ctx)?.kind === 'strong';
}

/** The attempt is inside an R9r window (an active `await_report` hold). */
export function awaitReportHeld(ctx: GuardCtx): boolean {
    const attempt = ctx.attempt;
    return !!attempt && ctx.holds.some((h) => h.reason === 'await_report' && h.attemptId === attempt.attemptId);
}

/** A timer may use only a recent observation from a probe begun after its hold/request. */
export function freshEndProbe(ctx: GuardCtx): boolean {
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
export function correctionPending(ctx: GuardCtx): boolean {
    const r = ctx.attempt?.data.reportCorrection;
    return r?.generation === ctx.attempt?.generation && !reportedThisGeneration(ctx);
}
/** Event-id prefix of the scheduler's idle-settle (mesh-pinned-followup-supersede.ts). */
export const PINNED_FOLLOWUP_SETTLE_EVENT_PREFIX = 'pinned_followup_supersede:';
/** R23s: the scheduler settles a queue attempt that is finalizing and still owes its report, writer kept alive. */
export function settleIdleReportOwed(ctx: GuardCtx): boolean {
    const e = ctx.evidence;
    return e.kind === 'operator_status' && e.source === 'scheduler' && e.eventId.startsWith(PINNED_FOLLOWUP_SETTLE_EVENT_PREFIX)
        && ctx.attempt?.scope === 'mesh_queue' && ctx.attempt.state === 'finalizing'
        && !ctx.attempt.data.writerStop && !reportedThisGeneration(ctx);
}
export function queueReportMissing(ctx: GuardCtx): boolean {
    return ctx.attempt?.scope === 'mesh_queue' && holdIs(ctx, 'await_report')
        && !reportedThisGeneration(ctx);
}
/** The report-missing nudge was already sent for this generation (R13m accepts on the next expiry). */
export function reportMissingNudged(a: TurnAttempt | null | undefined): boolean {
    const n = a?.data.reportMissingNudge;
    return !!a && !!n && n.generation === a.generation && n.count >= 1;
}
export function endTimer(ctx: GuardCtx): boolean {
    return holdIs(ctx, 'weak_candidate', 'await_report')
        && ctx.attempt?.scope !== 'mesh_direct'
        && expiredHold(ctx)?.data.nativeProbeReportOnly !== true && !correctionPending(ctx) && !queueReportMissing(ctx);
}
export function freshAlive(ctx: GuardCtx): boolean { return freshEndProbe(ctx) && ctx.attempt?.lastLiveness === 'alive'; }

/** How many times R13u already deferred a weak/await_report expiry in this generation. */
export function unconfirmedEndDeferrals(ctx: GuardCtx): number {
    const d = ctx.attempt?.data.unconfirmedEndDeferral;
    return d && d.generation === ctx.attempt!.generation && d.requestedAt !== undefined ? d.count : 0;
}
