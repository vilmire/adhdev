/**
 * turn-evidence-port — the provider-side half of the turn evidence pipeline.
 *
 * Wiring-unification Phase C5 "Provider side"
 * (docs/design/2026-09-23-wiring-unification.md §5 C1/C5/C6/C9).
 *
 * Provider instances never see the turn ledger. They hold a nullable
 * `TurnEvidencePort` and call one `emit*` helper per producer site (CLI FSM,
 * completion-flush, stall-rescue, mesh-stall-watchdog, ACP/IDE/extension
 * instances, …). The port stays null until the boot builder (B4) wires a
 * concrete implementation whose `observe` calls the ledger — this file never
 * imports anything from `mesh/` (only types from `@adhdev/mesh-shared`,
 * which is a dependency-free leaf, not `mesh/`), matching
 * `check:boundaries`'s providers ↮ mesh value-import ban and mirroring
 * `provider-event-port.ts` (B2)'s "guarded, null until boot wires it" shape
 * exactly: same file owns only pure diff/construction helpers and the
 * guarded call wrappers, never the ledger itself.
 *
 * NO VERDICTS HERE. Every helper below reports what was *observed*
 * (a turn started, a transcript looked final, a process exited, …) — never
 * "done". The pure reducer in `mesh/turn-ledger/{admission,reducer}.ts`
 * (C-W1/W2, not this file) is the only authority that turns evidence into a
 * commit. A site that used to decide "genuine ⇒ done" locally now only fills
 * in the fields it actually observed (e.g. `strength`) and submits.
 */

import { isTurnEvidence, type SummaryRef, type TurnAttemptRef, type TurnEvidence, type TurnEvidenceKind } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';

/**
 * The provider-facing emit surface. `observe` is the only method a concrete
 * implementation (B4 boot stage) must supply — sync or async, since the
 * underlying ledger write may hit local storage or a seqscribe append. This
 * interface itself is pure wiring: it does not decide anything.
 */
export interface TurnEvidencePort {
    observe(evidence: TurnEvidence): void;
}

/** One dropped-evidence count per kind, exposed for tests/diagnostics. */
export type DroppedEvidenceCounts = Readonly<Partial<Record<TurnEvidenceKind | 'unknown', number>>>;

export interface TurnEvidencePortDeps {
    /** Underlying sink. Never throws out of `observe()` — if it does, the
     *  port's guard swallows it (a ledger failure must never break the
     *  producer's own detection tick, same rule as `provider-event-port.ts`). */
    observe: (evidence: TurnEvidence) => void | Promise<void>;
    /**
     * Resolve the live per-turn attempt for a session, if the caller doesn't
     * already have one on hand. Returns `null` when there is no live attempt
     * tracked (e.g. a cold PTY-exit path, or a plain non-mesh session) — the
     * evidence is then submitted without `attemptRef`/`taskId`, and the
     * ledger's own `resolveAttempt` (mesh/turn-ledger, not here) does
     * identity resolution centrally from `(meshId, taskId)` or `sessionId`.
     */
    attemptRefFor?: (sessionId: string) => TurnAttemptRef | null;
    /** Clock used to backfill `at` for evidence passed to `observe()` directly
     *  without one (defensive only — every `emit*` helper below already
     *  stamps `at`, so this path is for a future direct-`observe()` caller). */
    now?: () => number;
    log?: { warn: (scope: string, msg: string) => void; debug: (scope: string, msg: string) => void };
}

let eventSeq = 0;

/** Stable id for dedupe across republish/replication: sessionId+kind+at+seq
 *  (seq breaks ties when two evidence records share a millisecond). */
function makeEventId(sessionId: string, kind: TurnEvidenceKind, at: number): string {
    eventSeq = (eventSeq + 1) % Number.MAX_SAFE_INTEGER;
    return `tev_${sessionId}_${kind}_${at}_${eventSeq}`;
}

const defaultLog = { warn: (scope: string, msg: string) => LOG.warn(scope, msg), debug: (scope: string, msg: string) => LOG.debug(scope, msg) };

/**
 * Build the guarded `TurnEvidencePort` over a concrete sink. Called once at
 * boot (B4) with the real ledger-backed `observe`; every provider instance
 * holds the resulting port (or `null` before boot wires it).
 *
 * The returned `observe()` is the single guard every `emit*` helper below
 * eventually funnels through: validates with `isTurnEvidence`, fills in
 * `attemptRef` via `attemptRefFor` when the evidence doesn't already carry
 * one, and never lets a sink failure escape (a ledger write failing must
 * never break the producer's own detection tick — same rule as
 * `provider-event-port.ts`'s `guard()`).
 */
export function createTurnEvidencePort(deps: TurnEvidencePortDeps): TurnEvidencePort {
    const log = deps.log ?? defaultLog;
    const now = deps.now ?? (() => Date.now());
    const dropped: Record<string, number> = {};

    return {
        observe(evidence: TurnEvidence): void {
            const kind = (evidence as { kind?: string } | null)?.kind ?? 'unknown';
            // Resolve attemptRef centrally when the call site didn't already
            // supply one and has a sessionId to resolve against — this is the
            // one place `attemptRefFor` (replacing the `meshActiveTaskId`
            // scalar read) is consulted for evidence built via `port.observe`
            // directly rather than through an `emit*` helper.
            let withAttempt: TurnEvidence = evidence;
            if (!evidence.attemptRef && evidence.sessionId && deps.attemptRefFor) {
                const resolved = deps.attemptRefFor(evidence.sessionId);
                if (resolved) withAttempt = { ...withAttempt, attemptRef: resolved };
            }
            // Defensive backfill: every emit* helper already stamps `at`, but a
            // future direct-observe() caller might not.
            if (typeof (withAttempt as { at?: unknown }).at !== 'number') {
                withAttempt = { ...withAttempt, at: now() };
            }
            if (!isTurnEvidence(withAttempt)) {
                dropped[kind] = (dropped[kind] ?? 0) + 1;
                log.debug('TurnEvidencePort', `[TurnEvidencePort] dropped invalid ${kind} for ${(evidence as { sessionId?: string })?.sessionId ?? 'unknown'} (failed isTurnEvidence)`);
                return;
            }
            try {
                const result = deps.observe(withAttempt);
                // A sync sink returns undefined; an async sink returns a
                // Promise, whose rejection must also never escape — an
                // unhandled rejection is just as much a "broke the producer's
                // tick" failure as a synchronous throw.
                if (result && typeof (result as Promise<void>).catch === 'function') {
                    (result as Promise<void>).catch((error: unknown) => {
                        log.warn('TurnEvidencePort', `[TurnEvidencePort] observe(${kind}) for ${withAttempt.sessionId} failed (async): ${(error as Error)?.message ?? error}`);
                    });
                }
            } catch (error) {
                log.warn('TurnEvidencePort', `[TurnEvidencePort] observe(${kind}) for ${withAttempt.sessionId} failed: ${(error as Error)?.message ?? error}`);
            }
        },
    };
}

/** Snapshot of drop counts is intentionally NOT exposed off `createTurnEvidencePort`'s
 *  closure today (no caller needs it yet — `DroppedEvidenceCounts` is exported
 *  for a future diagnostics consumer to type against without re-deriving the shape). */

// ─── Guarded, never-throwing emit helpers (one per producer family) ───────
//
// Each helper takes the (possibly null) port plus exactly the fields a
// producer site observes, fills eventId/at/sessionId/attemptRef, validates,
// and calls `port.observe(...)`. None of these compute a verdict — see the
// per-kind notes in the producer matrix (brief §1).

function nowMs(): number {
    return Date.now();
}

function makeEnvelope(
    kind: TurnEvidenceKind,
    sessionId: string,
    observedBy: string,
    attemptRef: TurnAttemptRef | undefined,
    taskId: string | undefined,
    at: number,
): { eventId: string; at: number; sessionId: string; observedBy: string; attemptRef?: TurnAttemptRef; taskId?: string } {
    return {
        eventId: makeEventId(sessionId, kind, at),
        at,
        sessionId,
        observedBy,
        ...(attemptRef ? { attemptRef } : {}),
        ...(!attemptRef && taskId ? { taskId } : {}),
    };
}

function guardEmit(port: TurnEvidencePort | null | undefined, kind: TurnEvidenceKind, sessionId: string, build: () => TurnEvidence): void {
    if (!port) return;
    try {
        const evidence = build();
        if (!isTurnEvidence(evidence)) {
            LOG.debug('TurnEvidencePort', `[TurnEvidencePort] dropped invalid ${kind} for ${sessionId} (failed isTurnEvidence)`);
            return;
        }
        port.observe(evidence);
    } catch (error) {
        LOG.warn('TurnEvidencePort', `[TurnEvidencePort] emit ${kind} for ${sessionId} failed: ${(error as Error)?.message ?? error}`);
    }
}

export interface EmitCommonOpts {
    sessionId: string;
    observedBy: string;
    attemptRef?: TurnAttemptRef;
    /** Only used when `attemptRef` is absent. */
    taskId?: string;
    /** Override the envelope clock — used for retro evidence. */
    at?: number;
}

/** `turn_started` — CLI FSM debounced start, or a retroactive short-gen start
 *  (`at = now - shortDurationMs`, `retro: true`). Never a verdict. */
export function emitTurnStarted(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & { retro: boolean; source: TurnEvidence['source'] },
): void {
    guardEmit(port, 'turn_started', opts.sessionId, () => ({
        ...makeEnvelope('turn_started', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'turn_started',
        retro: opts.retro,
    }) as TurnEvidence);
}

/** `turn_end` — a candidate end. `strength` stays on the evidence; whether
 *  "genuine ⇒ done" is now the reducer's call (R9), not the producer's. */
export function emitTurnEnd(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & {
        source: TurnEvidence['source'];
        strength: Extract<TurnEvidence, { kind: 'turn_end' }>['strength'];
        summary?: SummaryRef;
        afterFinalizationTimeout?: boolean;
        hollow?: boolean;
        blockReason?: Extract<TurnEvidence, { kind: 'turn_end' }>['blockReason'];
        releasedByHardCap?: boolean;
        nativeOutcome?: Extract<TurnEvidence, { kind: 'turn_end' }>['nativeOutcome'];
        live?: Extract<TurnEvidence, { kind: 'turn_end' }>['live'];
    },
): void {
    guardEmit(port, 'turn_end', opts.sessionId, () => ({
        ...makeEnvelope('turn_end', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'turn_end',
        strength: opts.strength,
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(opts.afterFinalizationTimeout !== undefined ? { afterFinalizationTimeout: opts.afterFinalizationTimeout } : {}),
        ...(opts.hollow !== undefined ? { hollow: opts.hollow } : {}),
        ...(opts.blockReason ? { blockReason: opts.blockReason } : {}),
        ...(opts.releasedByHardCap !== undefined ? { releasedByHardCap: opts.releasedByHardCap } : {}),
        ...(opts.nativeOutcome ? { nativeOutcome: opts.nativeOutcome } : {}),
        ...(opts.live ? { live: opts.live } : {}),
    }) as TurnEvidence);
}

/** `transcript_final` — a PTY-scrape or native-history read that LOOKS like a
 *  final assistant turn. Admission (strong/weak/decline) is decided by
 *  `mesh/turn-ledger/admission.ts` (W1/W2), never here. */
export function emitTranscriptFinal(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & {
        source: TurnEvidence['source'];
        selfAttributing: boolean;
        nativeRead: boolean;
        live: Extract<TurnEvidence, { kind: 'transcript_final' }>['live'];
        nativeMarker?: Extract<TurnEvidence, { kind: 'transcript_final' }>['nativeMarker'];
        summary?: SummaryRef;
        messageAt?: number;
    },
): void {
    guardEmit(port, 'transcript_final', opts.sessionId, () => ({
        ...makeEnvelope('transcript_final', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'transcript_final',
        selfAttributing: opts.selfAttributing,
        nativeRead: opts.nativeRead,
        live: opts.live,
        ...(opts.nativeMarker ? { nativeMarker: opts.nativeMarker } : {}),
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(opts.messageAt !== undefined ? { messageAt: opts.messageAt } : {}),
    }) as TurnEvidence);
}

/** `transcript_activity` — the transcript is still moving (not final). Used
 *  to keep a `transcript_quiet` hold honest. */
export function emitTranscriptActivity(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & { source: TurnEvidence['source']; newestActivityAt: number },
): void {
    guardEmit(port, 'transcript_activity', opts.sessionId, () => ({
        ...makeEnvelope('transcript_activity', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'transcript_activity',
        newestActivityAt: opts.newestActivityAt,
    }) as TurnEvidence);
}

/** `no_progress` — a stall monitor's observation (CLI FSM's StatusMonitor or
 *  the mesh stall watchdog). `observedStatus` must already be normalized to
 *  the closed `SessionStatus | 'unknown'` vocabulary by the caller. */
export function emitNoProgress(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & {
        source: TurnEvidence['source'];
        stalledMs: number;
        observedStatus: Extract<TurnEvidence, { kind: 'no_progress' }>['observedStatus'];
        finalAssistantPresent: boolean;
    },
): void {
    guardEmit(port, 'no_progress', opts.sessionId, () => ({
        ...makeEnvelope('no_progress', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'no_progress',
        stalledMs: opts.stalledMs,
        observedStatus: opts.observedStatus,
        finalAssistantPresent: opts.finalAssistantPresent,
    }) as TurnEvidence);
}

/** `liveness` — a probe's read of whether the process/session is still there. */
export function emitLiveness(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & { source: TurnEvidence['source']; result: Extract<TurnEvidence, { kind: 'liveness' }>['result'] },
): void {
    guardEmit(port, 'liveness', opts.sessionId, () => ({
        ...makeEnvelope('liveness', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'liveness',
        result: opts.result,
    }) as TurnEvidence);
}

/** `process_exit` — the PTY/process died. `exitCode` is passed through
 *  verbatim including `null` (an unexplained/signal death is never collapsed
 *  to 0 — same rule `adapter.ts`'s `on_exit` already follows). */
export function emitProcessExit(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & {
        source: TurnEvidence['source'];
        exitCode: number | null;
        providerFailure?: Extract<TurnEvidence, { kind: 'process_exit' }>['providerFailure'];
    },
): void {
    guardEmit(port, 'process_exit', opts.sessionId, () => ({
        ...makeEnvelope('process_exit', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'process_exit',
        exitCode: opts.exitCode,
        ...(opts.providerFailure ? { providerFailure: opts.providerFailure } : {}),
    }) as TurnEvidence);
}

/** `session_error` — a classified provider/adapter/spawn/auth/billing error.
 *  `reason` must already be mapped into the closed `SESSION_ERROR_REASONS`
 *  enum by the caller (free-text reasons are not carried). */
export function emitSessionError(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & { source: TurnEvidence['source']; reason: Extract<TurnEvidence, { kind: 'session_error' }>['reason'] },
): void {
    guardEmit(port, 'session_error', opts.sessionId, () => ({
        ...makeEnvelope('session_error', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'session_error',
        reason: opts.reason,
    }) as TurnEvidence);
}

/** `suspension` — a modal (approval/choice) is up. `modalKey` should reuse
 *  B2's `modalFingerprint()`/an approval fingerprint, never recompute one. */
export function emitSuspension(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & { source: TurnEvidence['source']; modal: Extract<TurnEvidence, { kind: 'suspension' }>['modal']; modalKey?: string },
): void {
    guardEmit(port, 'suspension', opts.sessionId, () => ({
        ...makeEnvelope('suspension', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'suspension',
        modal: opts.modal,
        ...(opts.modalKey ? { modalKey: opts.modalKey } : {}),
    }) as TurnEvidence);
}

/** `suspension_resolved` — the modal was answered (button/auto-approve/prompt). */
export function emitSuspensionResolved(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & {
        source: TurnEvidence['source'];
        resolution: Extract<TurnEvidence, { kind: 'suspension_resolved' }>['resolution'];
        via: Extract<TurnEvidence, { kind: 'suspension_resolved' }>['via'];
    },
): void {
    guardEmit(port, 'suspension_resolved', opts.sessionId, () => ({
        ...makeEnvelope('suspension_resolved', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'suspension_resolved',
        resolution: opts.resolution,
        via: opts.via,
    }) as TurnEvidence);
}

/** `session_rebound` — the session came back (restart, or another daemon's
 *  live holder took over). */
export function emitSessionRebound(
    port: TurnEvidencePort | null | undefined,
    opts: EmitCommonOpts & {
        source: TurnEvidence['source'];
        toSessionId: string;
        reason: Extract<TurnEvidence, { kind: 'session_rebound' }>['reason'];
    },
): void {
    guardEmit(port, 'session_rebound', opts.sessionId, () => ({
        ...makeEnvelope('session_rebound', opts.sessionId, opts.observedBy, opts.attemptRef, opts.taskId, opts.at ?? nowMs()),
        source: opts.source,
        kind: 'session_rebound',
        toSessionId: opts.toSessionId,
        reason: opts.reason,
    }) as TurnEvidence);
}
