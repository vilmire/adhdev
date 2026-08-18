// ---------------------------------------------------------------------------
// mesh-terminal-admission — P0-1 single terminal-admission choke point
// ---------------------------------------------------------------------------
// THE INCIDENT THIS EXISTS FOR
// ----------------------------
// 2026-08: at the 15-min delivered-no-turn redrive deadline,
// pollAssignedTaskTerminalEvidence read a mid-turn kimi worker's chat tail
// WITHOUT includeActivity (so the trailing Edit tool call was filtered out of
// the payload), saw "idle + final assistant preamble", and flipped the queue
// row / attempt to completed — 6 seconds before the worker went busy again and
// did the real work. Every producer that turned transcript evidence into a
// terminal decision had re-implemented its own slightly-different finality
// check, so the fix for one path never covered the others.
//
// This module is the ONE place the "may transcript evidence be admitted as a
// turn end?" question is answered. It is PURE — no IO, no provider names, no
// ledger, no queue. Callers gather the observations (they own the read), hand
// them here, and honor the verdict:
//
//   ADMIT strong → a provider-NATIVE turn-terminal marker proves THIS turn
//                  ended. Immediate terminal flow is justified.
//   ADMIT weak   → only message-SHAPE evidence exists (idle + post-dispatch
//                  final assistant + no trailing activity + a quiet
//                  transcript) for a provider without a native marker (or an
//                  old daemon that cannot report one). Shape evidence is what
//                  the incident burned, so a weak admit must NEVER directly
//                  release queue/dependency state — the caller re-confirms
//                  (P1-4 candidate streak) before promoting.
//   DECLINE      → HOLD. A decline is never a completion verdict and never a
//                  reclaim verdict; the caller decides hold / bounded reclaim /
//                  fail from its own deadline machinery.
//
// WHY A TIMEOUT IS NEVER COMPLETION EVIDENCE
// ------------------------------------------
// A deadline expiring proves only that we ran out of patience, not that the
// worker finished. The incident flip happened AT a deadline: the 15-min
// redrive budget made the message-shape read feel "safe enough". It was not —
// the worker was mid-turn in a quiet valley between tool calls. No rule below
// takes a deadline as an input, and rule 6 (transcript_growing) must NOT be
// bypassable by any timeout/backstop: a quiet-valley preamble is FRESH
// transcript activity, and freshness — not the age of the row — is what
// separates "settled tail" from "mid-turn pause".
//
// WHY A DECLINE CAN ONLY DELAY, NEVER LOSE
// ----------------------------------------
// Every decline leaves the queue row 'assigned' and the attempt open. The
// caller's OWN bounded fail-safes still run above this predicate (the
// delivered-no-turn reclaim, the UNKNOWN-streak grace, the
// QUEUE_HOLD_HARD_DEADLINE_MS ceiling): a genuinely dead worker is still
// recovered by the reclaim path after its bounded grace, so a decline here
// defers a completion by at most one reconcile cadence — it can never wedge
// the row, and it can never manufacture one.
// ---------------------------------------------------------------------------

import { selectTurnTerminalMarker } from '../chat/native-turn-signal.js';
import type { NativeTurnTerminalMarker } from '../chat/native-turn-signal.js';

// How fresh the newest transcript bubble of ANY kind may be before the tail is
// judged "still growing" and message-shape evidence is refused (rule 6).
// Deliberately aligned with the early-idle settle window
// (ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS = 8s in mesh-reconcile-stranded-dispatch):
// both numbers answer the same question — "has this transcript been quiet long
// enough that a preamble-with-no-trailing-activity is a turn end, not a
// mid-turn valley?" — so the two paths cannot disagree at the boundary.
export const TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS = 8_000;

export interface TerminalAdmissionInput {
    /** Who is asking ('redrive_deadline_transcript_evidence' | 'early_idle_transcript_evidence' | …) — diagnostics only. */
    producer: string;
    providerType?: string;
    /** Does this provider have a native turn-terminal signal at all (providerHasNativeTurnSignal)? */
    providerHasNativeMarker: boolean;
    /**
     * Did the read_chat payload carry `turnTerminalMarkers` AT ALL (version
     * skew discriminator)? ABSENT means an old daemon / PTY fallback read —
     * the caller must fall through to the legacy message-shape rules and must
     * NEVER fabricate marker evidence. PRESENT (even as []) means a native
     * history read genuinely happened, so an empty/absent marker list is the
     * authoritative "this turn has NOT ended".
     */
    nativeMarkersFieldPresent: boolean;
    nativeMarkers?: readonly NativeTurnTerminalMarker[];
    /** Dispatch boundary (epoch ms) — scopes the native marker to THIS turn. */
    turnStartedAtMs?: number;
    /** The worker's own status verdict (providerObservedStatus, with the reader's projected-status fallback already applied). */
    providerObservedStatus?: string;
    /** An approval/question modal with real buttons is parked — the turn is blocked, not ended. */
    activeModalPresent: boolean;
    /** A post-dispatch final assistant bubble was selected. */
    finalAssistantPresent: boolean;
    /** Tool/terminal bubbles sitting AFTER the selected final assistant — mid-turn proof. */
    trailingActivityCount: number;
    /** Newest bubble of ANY kind in the tail (epoch ms) — the freshness probe for rule 6. */
    newestActivityAtMs?: number;
    nowMs: number;
    /**
     * The caller's own settle window (the early-idle path passes one). Kept
     * CALLER-SIDE by design (rule 7): the caller already evaluates it against
     * the final assistant's own timestamp before asking here, so this module
     * does not duplicate the check.
     */
    minFinalAssistantAgeMs?: number;
}

export type TerminalAdmissionVerdict =
    | { admit: true; evidenceLevel: 'strong' | 'weak'; nativeMarker?: NativeTurnTerminalMarker; reason: string }
    | { admit: false; reason: string; detail: string };

/**
 * The ordered terminal-admission rules. Order is load-bearing: cheaper and
 * harder vetoes run first, and every decline means HOLD (see the module
 * header — a decline can only delay).
 */
export function evaluateTerminalAdmission(input: TerminalAdmissionInput): TerminalAdmissionVerdict {
    const decline = (reason: string, detail: string): TerminalAdmissionVerdict => ({ admit: false, reason, detail });

    // 1. A parked approval/question modal is positive "turn blocked" evidence —
    //    the worker is awaiting input, not finished. Refuse before anything else.
    if (input.activeModalPresent) {
        return decline('active_modal', 'an approval/question modal with buttons is parked — the turn is blocked, not ended');
    }

    // 2. The worker's OWN verdict outranks every transcript inference. A
    //    non-idle observed status (including an empty/unknown one — the reader's
    //    fallback could not prove idle either) is never a turn end.
    if (input.providerObservedStatus !== undefined) {
        const observed = input.providerObservedStatus.trim().toLowerCase();
        if (observed !== 'idle') {
            return decline('session_not_idle', `status=${observed || 'unknown'} — mid-turn, not a turn-end`);
        }
    }

    // 3. NATIVE-MARKER PRIORITY (P0-2): when the provider has a native
    //    turn-terminal signal AND the payload proves a native read happened,
    //    the marker list is the authoritative answer to "did THIS turn end?".
    //    A marker scoped to this turn ADMITS STRONG — even with no assistant
    //    text in the tail (codex measured 19.5% empty-reply turns; a marker is
    //    the only evidence that can release those). NO scoped marker is the
    //    incident veto: the turn has not ended, whatever the message shape
    //    says. When the FIELD is absent (old daemon / PTY fallback) we fall
    //    through to the legacy rules below — never fabricate marker evidence.
    if (input.providerHasNativeMarker && input.nativeMarkersFieldPresent) {
        const marker = selectTurnTerminalMarker(input.nativeMarkers, { turnStartedAt: input.turnStartedAtMs });
        if (marker) {
            return {
                admit: true,
                evidenceLevel: 'strong',
                nativeMarker: marker,
                reason: 'native_turn_terminal_marker',
            };
        }
        return decline(
            'native_marker_absent',
            `native read happened (${input.nativeMarkers?.length ?? 0} marker(s)) but none terminates this turn — the turn has not ended`,
        );
    }

    // 4. Tool/terminal activity trailing the final assistant bubble: the
    //    "final" bubble was a preamble and the turn is still executing.
    if (input.trailingActivityCount > 0) {
        return decline(
            'trailing_tool_activity',
            `${input.trailingActivityCount} tool/terminal bubble(s) trail the final assistant — worker is mid-turn`,
        );
    }

    // 5. Message-shape evidence REQUIRES a final assistant summary. (A native
    //    marker would have admitted above without one; shape alone cannot.)
    if (!input.finalAssistantPresent) {
        return decline('no_final_assistant_summary', 'idle but no assistant result — not a turn-end');
    }

    // 6. TRANSCRIPT-GROWING veto (★ never bypassable by any timeout/backstop):
    //    the newest bubble of ANY kind is younger than the quiet window, so
    //    the tail is still moving — an idle read with a quiet-valley preamble
    //    is exactly the incident shape. A deadline expiring does not make a
    //    fresh transcript settled.
    const newest = input.newestActivityAtMs;
    if (typeof newest === 'number' && Number.isFinite(newest)
        && input.nowMs - newest < TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS) {
        return decline(
            'transcript_growing',
            `newest transcript bubble is ${input.nowMs - newest}ms old (< ${TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS}ms quiet window) — the tail is still moving`,
        );
    }

    // 7. The caller's settle window (minFinalAssistantAgeMs vs the final
    //    assistant's own timestamp) is evaluated CALLER-SIDE before this
    //    predicate runs — do not duplicate it here.

    // 8. MESSAGE-SHAPE FALLBACK: idle + post-dispatch final assistant + no
    //    trailing activity + a quiet transcript, for a provider with no native
    //    marker (or an old daemon that cannot report one). This is the WEAK
    //    admit — the caller must re-confirm before releasing anything.
    return {
        admit: true,
        evidenceLevel: 'weak',
        reason: 'message_shape_fallback',
    };
}
