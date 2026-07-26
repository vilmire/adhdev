/**
 * TX-FSM Stage 0 (shadow) — the `signal` capability envelope.
 *
 * Stage 0 of the transcript+PTY dual-source redesign: the daemon collects
 * native-transcript signals, normalizes them into this envelope, and injects
 * the snapshot into the FsmDriver as a pure OBSERVATION. The FSM evaluates
 * `signal` conditions against it and records what the verdict WOULD have been
 * (shadow log) — but a signal condition NEVER gates a transition in Stage 0
 * (pass-through, see fsm-evaluator.ts). Behavior change is exactly zero.
 *
 * Boundary contract:
 *  - This module is ENGINE-side: it defines the envelope + leaf evaluation and
 *    knows NOTHING about providers, file discovery, or parsing.
 *  - The daemon-side TranscriptSignalSource (providers/transcript-signal-source.ts)
 *    owns collection/normalization and is the only producer.
 *  - Approval is explicitly OUT of scope (deferred to Stage 4): no provider
 *    records its approval lifecycle in the native transcript, and an unfinished
 *    tool call cannot distinguish running/approval-pending/result-delayed/crash,
 *    so no approval signal exists in this envelope. PTY regex stays the sole
 *    approval authority.
 *
 * Fail-open contract: when no snapshot is available (non-native-source class,
 * unresolved transcript, read error), every signal is null and every `signal`
 * condition fails OPEN — a missing signal must never wedge a session.
 */
'use strict';

import type { TranscriptClass, CompletionTiming } from '../transcript-evidence.js';

export const SIGNAL_SNAPSHOT_KIND = 'adhdev:fsm/signal-snapshot@0' as const;

/** The normalized signal vocabulary. Stage 0 keeps this deliberately small —
 *  every name must be derivable from the FLATTENED native-transcript pipeline
 *  (which drops tool_use/tool_result correlation ids — that raw-JSONL read is
 *  Stage 4 territory and must NOT be added here). */
export type SignalName =
    | 'final_assistant_present'
    | 'in_turn_progress'
    | 'transcript_growing';

export const SIGNAL_NAMES: readonly SignalName[] = [
    'final_assistant_present',
    'in_turn_progress',
    'transcript_growing',
];

export type SignalUnavailableReason = 'no_native_source' | 'unresolved' | 'error';

/** The normalized, provider-agnostic observation the daemon hands the FSM. */
export interface SignalSnapshot {
    kind: typeof SIGNAL_SNAPSHOT_KIND;
    /** Wall-clock time the underlying transcript read happened (ms). */
    sampledAt: number;
    /** False ⇒ every signal is null and conditions fail open. */
    available: boolean;
    unavailableReason?: SignalUnavailableReason;
    /** The authority profile class/timing this snapshot was produced under
     *  (via resolveTranscriptAuthorityProfile — never raw predicates). */
    profile?: { class: TranscriptClass; timing: CompletionTiming };
    /** Normalized signals; null = unknown (fail-open). */
    signals: Record<SignalName, boolean | null>;
    /** Raw sampling context for the shadow log / Stage 1-3 analysis. */
    detail: {
        msgCount: number;
        sourceMtimeMs: number;
        /** now - sourceMtimeMs; null when the mtime is unknown (0). */
        ageMs: number | null;
    };
}

/** The fail-open snapshot: no usable observation, every signal null. */
export function unavailableSignalSnapshot(
    now: number,
    reason: SignalUnavailableReason,
    profile?: { class: TranscriptClass; timing: CompletionTiming },
): SignalSnapshot {
    return {
        kind: SIGNAL_SNAPSHOT_KIND,
        sampledAt: now,
        available: false,
        unavailableReason: reason,
        ...(profile ? { profile } : {}),
        signals: { final_assistant_present: null, in_turn_progress: null, transcript_growing: null },
        detail: { msgCount: 0, sourceMtimeMs: 0, ageMs: null },
    };
}

/** The spec's `signal` leaf: `{ signal: 'transcript_growing', equals?: boolean }`. */
export interface SignalLeaf {
    signal: string;
    equals?: boolean;
}

export interface SignalLeafEval {
    /** The normalized signal value read from the snapshot; null = unknown. */
    value: boolean | null;
    /** What the leaf WOULD evaluate to if signals gated transitions; null =
     *  unknown (no snapshot / signal missing → fail-open). */
    shadowResult: boolean | null;
    /** Human-readable shadow-log fragment. */
    detail: string;
}

/**
 * Evaluate one `signal` leaf against the injected snapshot. This computes the
 * SHADOW verdict only — the caller (fsm-evaluator) owns the Stage-0
 * pass-through rule that keeps the real result true regardless of what this
 * returns.
 */
export function evaluateSignalLeaf(cond: SignalLeaf, snapshot: SignalSnapshot | null | undefined): SignalLeafEval {
    const expected = cond.equals ?? true;
    if (!snapshot || !snapshot.available) {
        const why = !snapshot ? 'no snapshot' : `unavailable(${snapshot.unavailableReason ?? 'unknown'})`;
        return {
            value: null,
            shadowResult: null,
            detail: `signal ${cond.signal} ${why} → fail-open`,
        };
    }
    const raw = Object.prototype.hasOwnProperty.call(snapshot.signals, cond.signal)
        ? snapshot.signals[cond.signal as SignalName]
        : null;
    if (raw === null || raw === undefined) {
        return {
            value: null,
            shadowResult: null,
            detail: `signal ${cond.signal} unknown → fail-open`,
        };
    }
    const shadowResult = raw === expected;
    return {
        value: raw,
        shadowResult,
        detail: `signal ${cond.signal}=${raw} expected=${expected} → ${shadowResult}`,
    };
}
