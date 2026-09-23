// ---------------------------------------------------------------------------
// turn-ledger/admission — "may this observation be admitted as a turn end?"
// ---------------------------------------------------------------------------
// Wiring-unification Phase C1. Carved out of mesh-terminal-admission.ts and the
// mesh-completion-live-gate's pending predicates, reimplemented here (the old
// modules are deleted in C). PURE: no IO, no provider names, no ledger. The
// reducer's guards call these; nothing else decides transcript finality.
//
// THE INCIDENT THE RULE ORDER ENCODES (2026-08, unchanged): a mid-turn kimi
// worker's tail read without its trailing tool call looked like "idle + final
// assistant", was flipped to completed, and 6 s later the worker did the real
// work. Hence:
//   * a timeout is never completion evidence (no rule takes a deadline);
//   * the transcript-growing veto is never bypassable;
//   * a decline only DELAYS (a hold with a bounded expiry, or a record) — it is
//     never a completion verdict and never a reclaim verdict.
//
// Verdicts:
//   strong  → provider-native proof THIS turn ended (native marker, or a
//             self-attributing in-turn native summary) — commit.
//   weak    → message-shape evidence only — finalizing + weak_candidate hold;
//             the reducer re-confirms before it commits.
//   decline → hold (live state pending / transcript still moving) or record
//             (the read proves the turn has NOT ended, or there is no result).
// ---------------------------------------------------------------------------

import type { LiveTurnPending, TurnEvidenceOf } from '@adhdev/mesh-shared';
import type { HoldReason } from './types.js';
import { holdTtlMs, type TurnPolicy } from './policy.js';

export type AdmissionDeclineReason =
    | 'active_modal'
    | 'session_not_idle'
    | 'native_marker_absent'
    | 'trailing_tool_activity'
    | 'no_final_assistant_summary'
    | 'transcript_growing';

export interface TerminalAdmissionInput {
    /** An approval/question modal with real buttons is parked — the turn is blocked, not ended. */
    activeModalPresent: boolean;
    /** The worker's own status verdict; undefined = not observed. Anything but `idle` is mid-turn. */
    providerObservedStatus?: string;
    /** A native history read happened for a provider that has a native turn-terminal signal. */
    nativeReadHappened: boolean;
    /** A native turn-terminal marker scoped to THIS turn was found. */
    nativeMarkerScoped: boolean;
    /** The final summary is attributable to this turn by the provider itself (in-turn native summary). */
    selfAttributing: boolean;
    /** Tool/terminal bubbles AFTER the selected final assistant — mid-turn proof. */
    trailingActivityCount: number;
    /** A post-dispatch final assistant bubble was selected. */
    finalAssistantPresent: boolean;
    /** Newest bubble of ANY kind (epoch ms) — freshness probe. */
    newestActivityAtMs?: number;
    /** Time of the observation (same clock as newestActivityAtMs). */
    observedAtMs: number;
    quietWindowMs: number;
}

export type TerminalAdmissionVerdict =
    | { admit: true; evidenceLevel: 'strong' | 'weak'; reason: 'native_turn_terminal_marker' | 'self_attributing_summary' | 'message_shape_fallback' }
    | { admit: false; reason: AdmissionDeclineReason };

/** The ordered admission rules. Order is load-bearing: cheaper, harder vetoes first. */
export function evaluateTerminalAdmission(input: TerminalAdmissionInput): TerminalAdmissionVerdict {
    // 1. A parked modal: the turn is blocked, not ended.
    if (input.activeModalPresent) return { admit: false, reason: 'active_modal' };
    // 2. The worker's own non-idle verdict outranks every transcript inference.
    if (input.providerObservedStatus !== undefined && input.providerObservedStatus.trim().toLowerCase() !== 'idle') {
        return { admit: false, reason: 'session_not_idle' };
    }
    // 3. Native proof. A scoped marker admits strong even with no assistant text
    //    (empty-reply turns); so does a self-attributing native summary.
    if (input.nativeMarkerScoped) return { admit: true, evidenceLevel: 'strong', reason: 'native_turn_terminal_marker' };
    if (input.selfAttributing) return { admit: true, evidenceLevel: 'strong', reason: 'self_attributing_summary' };
    //    A native read that found NO scoped marker is the incident veto: the
    //    turn has not ended, whatever the message shape says.
    if (input.nativeReadHappened) return { admit: false, reason: 'native_marker_absent' };
    // 4. Trailing tool activity: the "final" bubble was a preamble.
    if (input.trailingActivityCount > 0) return { admit: false, reason: 'trailing_tool_activity' };
    // 5. Shape evidence requires a final assistant result.
    if (!input.finalAssistantPresent) return { admit: false, reason: 'no_final_assistant_summary' };
    // 6. Transcript-growing veto — never bypassable by any timeout.
    if (isTranscriptGrowing(input.newestActivityAtMs, input.observedAtMs, input.quietWindowMs)) {
        return { admit: false, reason: 'transcript_growing' };
    }
    // 7. Message-shape fallback: weak.
    return { admit: true, evidenceLevel: 'weak', reason: 'message_shape_fallback' };
}

export function isTranscriptGrowing(newestActivityAtMs: number | undefined, observedAtMs: number, quietWindowMs: number): boolean {
    return typeof newestActivityAtMs === 'number' && Number.isFinite(newestActivityAtMs)
        && observedAtMs - newestActivityAtMs < quietWindowMs;
}

/** Live state says the turn is still running (modal parked, adapter busy, tool trailing). */
export function isLivePending(live: LiveTurnPending | undefined): boolean {
    return !!live && (live.modal || live.adapterPending || live.trailingTool);
}

/** Which hold (if any) a decline maps to. Null = record only (re-evaluating the same read cannot change it). */
export function holdReasonForDecline(reason: AdmissionDeclineReason): Extract<HoldReason, 'live_pending' | 'transcript_quiet'> | null {
    switch (reason) {
        case 'active_modal':
        case 'session_not_idle':
        case 'trailing_tool_activity':
            return 'live_pending';
        case 'transcript_growing':
            return 'transcript_quiet';
        case 'native_marker_absent':
        case 'no_final_assistant_summary':
            return null;
    }
}

// ─── evidence-level admission (what the reducer's guards call) ───────────

export type EvidenceAdmission =
    | { kind: 'strong' }
    | { kind: 'weak' }
    | { kind: 'hold'; reason: AdmissionDeclineReason; holdReason: 'live_pending' | 'transcript_quiet' }
    | { kind: 'decline'; reason: AdmissionDeclineReason };

function fromVerdict(verdict: TerminalAdmissionVerdict): EvidenceAdmission {
    if (verdict.admit) return { kind: verdict.evidenceLevel };
    const holdReason = holdReasonForDecline(verdict.reason);
    return holdReason ? { kind: 'hold', reason: verdict.reason, holdReason } : { kind: 'decline', reason: verdict.reason };
}

export function admitTranscriptFinal(ev: TurnEvidenceOf<'transcript_final'>, policy: TurnPolicy): EvidenceAdmission {
    return fromVerdict(evaluateTerminalAdmission({
        activeModalPresent: ev.live.modal,
        providerObservedStatus: ev.live.adapterPending ? 'generating' : 'idle',
        nativeReadHappened: ev.nativeRead,
        nativeMarkerScoped: ev.nativeMarker !== undefined,
        selfAttributing: ev.selfAttributing,
        trailingActivityCount: ev.live.trailingTool ? 1 : 0,
        finalAssistantPresent: ev.summary !== undefined || ev.messageAt !== undefined,
        newestActivityAtMs: ev.live.newestActivityAt,
        observedAtMs: ev.at,
        quietWindowMs: policy.quietWindowMs,
    }));
}

/**
 * A provider-side turn end was already debounced by the completion engine; the
 * only thing that can hold it is live state attached to the evidence.
 */
export function admitTurnEnd(ev: TurnEvidenceOf<'turn_end'>, policy: TurnPolicy): EvidenceAdmission {
    const live = ev.live;
    if (live) {
        if (live.modal) return { kind: 'hold', reason: 'active_modal', holdReason: 'live_pending' };
        if (live.adapterPending) return { kind: 'hold', reason: 'session_not_idle', holdReason: 'live_pending' };
        if (live.trailingTool) return { kind: 'hold', reason: 'trailing_tool_activity', holdReason: 'live_pending' };
        if (isTranscriptGrowing(live.newestActivityAt, ev.at, policy.quietWindowMs)) {
            return { kind: 'hold', reason: 'transcript_growing', holdReason: 'transcript_quiet' };
        }
    }
    return { kind: ev.strength === 'genuine' ? 'strong' : 'weak' };
}

/** Strong or weak admit (i.e. the observation may move the turn toward terminal). */
export function isTerminalAdmissible(admission: EvidenceAdmission): boolean {
    return admission.kind === 'strong' || admission.kind === 'weak';
}

export function isWeakEnd(admission: EvidenceAdmission): boolean {
    return admission.kind === 'weak';
}

/**
 * Hold deadline for a declined observation, relative to the ledger clock:
 * a quiet-window hold ends when the transcript has been quiet for the window
 * (never later than the hold TTL); a live-pending hold lasts the TTL.
 */
export function admissionHoldUntil(
    admission: Extract<EvidenceAdmission, { kind: 'hold' }>,
    live: LiveTurnPending | undefined,
    observedAtMs: number,
    policy: TurnPolicy,
    nowMs: number,
): number {
    const ttl = holdTtlMs(policy);
    if (admission.holdReason === 'transcript_quiet' && live && typeof live.newestActivityAt === 'number') {
        const remaining = live.newestActivityAt + policy.quietWindowMs - observedAtMs;
        return nowMs + Math.min(Math.max(0, remaining), ttl);
    }
    return nowMs + ttl;
}
