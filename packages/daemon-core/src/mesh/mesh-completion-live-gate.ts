import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { MeshRuntimeStore, type MeshTurnAttemptRow } from './mesh-runtime-store.js';
import { isTerminalTurnStage } from './mesh-turn-ledger.js';
import { isWeakCompletionEvidence, readNonEmptyString } from './mesh-events-utils.js';

export const AUTHORITATIVE_COMPLETION_MAX_AGE_MS = 60_000;

export type LiveTurnPendingEvidence = {
    pending: boolean;
    kind?: 'adapter' | 'modal' | 'transcript_tool';
    observedAt?: number;
};

/**
 * The provider-instance surface the mesh layer duck-types for live evidence.
 * Single declaration — mesh-event-forwarding and mesh-events-stale import this
 * instead of re-declaring the shape inline, so a provider-side signature change
 * has exactly one mesh-side declaration to update (previously three drifting
 * copies, each silently fail-open).
 */
export type LiveTurnEvidenceSource = {
    getLiveTurnPendingEvidence?: () => LiveTurnPendingEvidence;
    hasLiveTurnPendingEvidence?: () => boolean;
};

/**
 * Single definition of "read the live-turn pending evidence off a provider
 * instance" — shared by the two enforcement points of the completion contract:
 *
 *   1. The instance-level completion engine
 *      (providers/completion/completion-engine.ts) gates the instance's OWN
 *      emit: getLiveTurnPendingEvidence feeds the NATIVE-TRAILING-TOOL-GATE
 *      and the finalization block's adapter-pending checks.
 *   2. The forwarding-level MID-TURN-LIVE-STATE-GATE (mesh-event-forwarding)
 *      re-checks at delivery time. It is NOT redundant with (1): it also
 *      covers completion events that never pass through the engine flush —
 *      provider-native event completions and the out-of-band stall rescues —
 *      plus the emit→forward TOCTOU window.
 *
 * Fail-open by design: a probe error must never wedge a completion.
 */
export function readLiveTurnPendingEvidence(instance: unknown): LiveTurnPendingEvidence {
    const candidate = instance as LiveTurnEvidenceSource | null | undefined;
    try {
        if (typeof candidate?.getLiveTurnPendingEvidence === 'function') {
            const evidence = candidate.getLiveTurnPendingEvidence();
            if (evidence && typeof evidence === 'object') {
                return {
                    pending: evidence.pending === true,
                    ...(evidence.kind === 'adapter' || evidence.kind === 'modal' || evidence.kind === 'transcript_tool'
                        ? { kind: evidence.kind } : {}),
                    ...(typeof evidence.observedAt === 'number' && Number.isFinite(evidence.observedAt)
                        ? { observedAt: evidence.observedAt } : {}),
                };
            }
        }
        if (typeof candidate?.hasLiveTurnPendingEvidence === 'function') {
            return { pending: candidate.hasLiveTurnPendingEvidence() === true };
        }
    } catch { /* fail open — diagnostics must not wedge completion */ }
    return { pending: false };
}

export type CompletionAuthorityDecision =
    | {
        authoritative: true;
        evidenceObservedAt: number;
        attemptStage: string;
        attemptUpdatedAt: number | null;
    }
    | {
        authoritative: false;
        reason: string;
        /**
         * The concrete values behind a profile-contract rejection. The reason string
         * alone ("evidence_source_profile_mismatch") says a contract was violated but
         * not WHICH side is wrong, and the event payload is not in the drop trace — so
         * a live recurrence could not be diagnosed without re-instrumenting and waiting
         * for it to happen again. These fields are content-free (enum-ish provider
         * classification labels, never prompt/transcript text), so they are safe on the
         * trace path under the server content boundary.
         */
        detail?: { authorityClass?: string; evidenceSource?: string; timing?: string };
    };

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function identitiesMatch(
    metadataEvent: Record<string, unknown>,
    evidence: Record<string, unknown>,
    attempt: MeshTurnAttemptRow,
    eventSessionId: string,
): boolean {
    const taskId = readNonEmptyString(metadataEvent.taskId);
    const attemptId = readNonEmptyString(metadataEvent.attemptId);
    const evidenceTaskId = readNonEmptyString(evidence.taskId);
    const evidenceAttemptId = readNonEmptyString(evidence.attemptId);
    const evidenceSessionId = readNonEmptyString(evidence.sessionId);
    const eventNonce = readFiniteNumber(metadataEvent.dispatchNonce);
    const evidenceNonce = readFiniteNumber(evidence.dispatchNonce);
    if (!taskId || !attemptId || !eventSessionId) return false;
    if (taskId !== attempt.taskId || attemptId !== attempt.attemptId) return false;
    if (evidenceTaskId !== taskId || evidenceAttemptId !== attemptId) return false;
    if (!evidenceSessionId || !sessionIdsEquivalent(evidenceSessionId, eventSessionId)) return false;
    if (!attempt.sessionId || !sessionIdsEquivalent(attempt.sessionId, eventSessionId)) return false;
    if (typeof attempt.dispatchNonce !== 'number'
        || eventNonce !== attempt.dispatchNonce
        || evidenceNonce !== attempt.dispatchNonce) return false;
    return true;
}

/**
 * A completion may outrank a contradictory live-screen snapshot only when the
 * provider carried forward the exact clean-path transcript proof that justified
 * its emit and that proof belongs to the current dispatch identity.
 */
export function evaluateAuthoritativeTranscriptCompletion(args: {
    metadataEvent: Record<string, unknown>;
    eventSessionId: string;
    attempt: MeshTurnAttemptRow | null;
    nowMs?: number;
}): CompletionAuthorityDecision {
    const { metadataEvent, eventSessionId, attempt } = args;
    const nowMs = args.nowMs ?? Date.now();
    if (!attempt || attempt.terminalOutcome || isTerminalTurnStage(attempt.stage)) {
        return { authoritative: false, reason: 'attempt_missing_or_terminal' };
    }
    if (isWeakCompletionEvidence(metadataEvent)) {
        return { authoritative: false, reason: 'weak_evidence' };
    }
    const diagnostic = readRecord(metadataEvent.completionDiagnostic);
    const evidence = readRecord(diagnostic?.transcriptEvidence);
    if (diagnostic?.finalAssistantPresent !== true
        || diagnostic?.cleanPath !== true
        || diagnostic?.evidenceWeak !== false
        || !evidence) {
        return { authoritative: false, reason: 'not_clean_strong_evidence' };
    }
    if (evidence.version !== 1
        || evidence.kind !== 'final_assistant'
        || evidence.cleanPath !== true
        || evidence.weak !== false) {
        return { authoritative: false, reason: 'invalid_evidence_contract' };
    }
    const authorityClass = readNonEmptyString(evidence.authorityClass);
    const timing = readNonEmptyString(evidence.timing);
    const evidenceSource = readNonEmptyString(diagnostic.finalAssistantEvidenceSource);
    const profileDetail = { authorityClass, evidenceSource, timing };
    if ((authorityClass !== 'native-source' && authorityClass !== 'pure-pty')
        || (timing !== 'floor' && timing !== 'hold' && timing !== 'immediate')) {
        return { authoritative: false, reason: 'non_transcript_authority_profile', detail: profileDetail };
    }
    // EVIDENCE-SOURCE-PROFILE (widened, 2026-08-18): `authorityClass` says WHERE the
    // provider's authoritative transcript lives (a static provider property);
    // `evidenceSource` says WHICH probe produced THIS turn's evidence (a per-turn
    // runtime outcome). They are independent axes, so the old strict bijection
    // (native-source⇒external-native, pure-pty⇒parsed) rejected combinations the
    // producing code deliberately emits — observed live as a dropped completion whose
    // attempt then never settled:
    //   - a native-source provider that is NOT lease-gated takes the parsed
    //     short-circuit (completion/evidence.ts `!preferNativeOverParsed` → 'parsed');
    //   - a lease-gated native-source provider whose native transcript is not yet
    //     resolved falls back to 'parsed' by design (TX-FSM Stage 2.1, fail-open);
    //   - a provider whose own turn-terminal marker answers directly reports
    //     'native-signal' (NATIVE-TURN-SIGNAL — the turn ended on a tool call or an
    //     empty reply, so no assistant bubble exists to parse);
    //   - a point-sample miss rescued by the cached in-turn summary reports
    //     'cached-summary' (NOTIF Defect-B), which is strictly an UPGRADE of evidence.
    // What the gate actually needs to exclude is evidence that never established a
    // final assistant at all — keep rejecting those, and admit the legitimate probes.
    // The strong-evidence guarantees this gate relies on are enforced above and below
    // regardless (cleanPath/weak contract, non-empty final content, causal identity,
    // freshness), so widening here does not weaken the completion authority.
    const ADMISSIBLE_EVIDENCE_SOURCES = new Set([
        'external-native', 'parsed', 'native-signal', 'cached-summary',
    ]);
    if (!evidenceSource || !ADMISSIBLE_EVIDENCE_SOURCES.has(evidenceSource)) {
        return { authoritative: false, reason: 'evidence_source_profile_mismatch', detail: profileDetail };
    }
    const finalSummary = readNonEmptyString(metadataEvent.finalSummary);
    const finalContentLength = readFiniteNumber(evidence.finalContentLength) ?? 0;
    if (!finalSummary || finalContentLength <= 0) {
        return { authoritative: false, reason: 'empty_final_content' };
    }
    if (!identitiesMatch(metadataEvent, evidence, attempt, eventSessionId)) {
        return { authoritative: false, reason: 'causal_identity_mismatch' };
    }
    const observedAt = readFiniteNumber(evidence.observedAt);
    const eventTimestamp = readFiniteNumber(metadataEvent.timestamp);
    const turnStartedAt = readFiniteNumber(evidence.turnStartedAt);
    const acceptedAt = Date.parse(attempt.acceptedAt || attempt.createdAt);
    if (!observedAt || !eventTimestamp || !turnStartedAt) {
        return { authoritative: false, reason: 'missing_evidence_timestamp' };
    }
    if (observedAt < turnStartedAt || eventTimestamp < turnStartedAt) {
        return { authoritative: false, reason: 'pre_turn_evidence' };
    }
    if (Number.isFinite(acceptedAt) && (observedAt < acceptedAt - 2_000 || eventTimestamp < acceptedAt - 2_000)) {
        return { authoritative: false, reason: 'pre_dispatch_evidence' };
    }
    if (observedAt > nowMs + 2_000
        || eventTimestamp > nowMs + 2_000
        || nowMs - observedAt > AUTHORITATIVE_COMPLETION_MAX_AGE_MS
        || nowMs - eventTimestamp > AUTHORITATIVE_COMPLETION_MAX_AGE_MS) {
        return { authoritative: false, reason: 'stale_evidence_timestamp' };
    }
    const attemptUpdatedAt = Date.parse(attempt.updatedAt);
    return {
        authoritative: true,
        evidenceObservedAt: observedAt,
        attemptStage: attempt.stage,
        attemptUpdatedAt: Number.isFinite(attemptUpdatedAt) ? attemptUpdatedAt : null,
    };
}

/**
 * Strong transcript evidence only overrides live evidence that is provably an
 * older screen/modal observation. Fresh modal, adapter, or trailing-tool
 * evidence remains a veto.
 */
export function authoritativeEvidenceOutranksLivePending(
    authority: CompletionAuthorityDecision,
    live: LiveTurnPendingEvidence,
): boolean {
    if (!authority.authoritative || live.pending !== true) return false;
    if (live.kind !== 'modal' && live.kind !== 'adapter') return false;
    // Restart/rebind can repaint an old modal NOW, making the PTY snapshot clock
    // look newer than the transcript. The reducer's suspension edge retains the
    // causal clock: when waiting_* itself predates the clean final, the repaint is
    // stale even if lastOutputAt was refreshed during rebind.
    if (live.kind === 'modal'
        && (authority.attemptStage === 'waiting_approval' || authority.attemptStage === 'waiting_choice')
        && authority.attemptUpdatedAt !== null
        && authority.attemptUpdatedAt <= authority.evidenceObservedAt) {
        return true;
    }
    return typeof live.observedAt === 'number'
        && Number.isFinite(live.observedAt)
        && live.observedAt <= authority.evidenceObservedAt;
}

/**
 * A retry hold is causal metadata only. It is never armed for weak, empty,
 * stale, synthetic, pre-dispatch, or mismatched completions.
 */
export function completionEligibleForLiveStateRetry(args: {
    metadataEvent: Record<string, unknown>;
    eventSessionId: string;
    attempt: MeshTurnAttemptRow | null;
    nowMs?: number;
}): boolean {
    const { metadataEvent, eventSessionId, attempt } = args;
    const nowMs = args.nowMs ?? Date.now();
    if (!evaluateAuthoritativeTranscriptCompletion({
        metadataEvent,
        eventSessionId,
        attempt,
        nowMs,
    }).authoritative) return false;
    if (!attempt || attempt.terminalOutcome || isTerminalTurnStage(attempt.stage)) return false;
    const taskId = readNonEmptyString(metadataEvent.taskId);
    const attemptId = readNonEmptyString(metadataEvent.attemptId);
    const nonce = readFiniteNumber(metadataEvent.dispatchNonce);
    if (!taskId || taskId !== attempt.taskId || attemptId !== attempt.attemptId) return false;
    if (!attempt.sessionId || !sessionIdsEquivalent(attempt.sessionId, eventSessionId)) return false;
    if (typeof attempt.dispatchNonce !== 'number' || nonce !== attempt.dispatchNonce) return false;
    const eventTimestamp = readFiniteNumber(metadataEvent.timestamp);
    const acceptedAt = Date.parse(attempt.acceptedAt || attempt.createdAt);
    if (!eventTimestamp
        || eventTimestamp > nowMs + 2_000
        || nowMs - eventTimestamp > AUTHORITATIVE_COMPLETION_MAX_AGE_MS) return false;
    if (Number.isFinite(acceptedAt) && eventTimestamp < acceptedAt - 2_000) return false;
    return true;
}

// ---------------------------------------------------------------------------
// MID-TURN-LIVE-STATE-GATE bounded retry hold (moved here from
// mesh-event-forwarding.ts 2026-08-17 — this module already owns every
// predicate the hold re-evaluates; the forwarder passes its delivery function
// in as `inject` so the hold machinery stays free of forwarding internals).
//
// The hold deliberately contains no task message, final summary, transcript,
// or modal content: only the dispatch identity needed to re-evaluate the
// live-state disagreement. The provider's transcript remains the content
// authority.
//
// ★ THE PERMANENT-LOSS DEFECT THIS SHAPE EXISTS TO PREVENT (2026-09-20)
// ---------------------------------------------------------------------
// Measured live: 6 `terminal admission declined (transcript_growing)`
// suppressions in one day, every one logging "bounded content-free retry
// armed", and ZERO retries ever delivering. Two independent bugs, both of which
// the arm/fire split below now fixes:
//
//   1. TTL EXPIRY WAS A SILENT DROP. The drain's expiry branch deleted the hold
//      and `continue`d — no delivery, no log, no ledger mark. The coordinator
//      was never told the worker finished, so it waited forever on a task whose
//      queue row already said `completed`. The module headers claimed "when the
//      hold's TTL expires the completion is released to the normal pipeline";
//      that release did not exist. RELEASE_ON_EXPIRY below makes the claim true.
//
//   2. THE TTL COULD NOT OUTLAST THE THING IT WAITED FOR. A transcript_growing
//      decline waits for an 8s quiet window, against a 5s TTL — so expiry was
//      not an edge case, it was the GUARANTEED outcome for exactly the shape
//      that armed it. Both observed sessions declined at a bubble age of ~5.8s.
//      Holds now derive their TTL from the window they are actually waiting on.
//
//   3. THE RE-CHECK WAS BLIND TO THE DECLINE REASON. The drain only re-read
//      `live.pending`, which is FALSE for a transcript_growing decline by
//      construction (that rule fires precisely when there is no modal, no
//      adapter-pending and no trailing tool — a tail that is merely moving). So
//      the hold fired at the first 250ms tick straight back into the same veto.
//      Holds now carry the `waitingOn` reason and re-check THAT.
// ---------------------------------------------------------------------------
const MID_TURN_COMPLETION_HOLD_RETRY_MS = 250;
const MID_TURN_COMPLETION_HOLD_TTL_MS = 5_000;

/**
 * Ceiling for a hold whose release condition is the transcript quiet window.
 *
 * MUST stay strictly greater than TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS (8s, in
 * mesh-terminal-admission.ts): a hold that expires before the window it waits
 * on can never observe the condition it was armed for, which is defect (2)
 * above. The margin covers the drain's 250ms granularity plus the observation
 * lag between the provider's newest-bubble timestamp and our read of it.
 *
 * Duplicated as a local constant rather than imported so this module stays free
 * of an import cycle with the admission module; `assertHoldTtlOutlastsQuietWindow`
 * in the test suite pins the two together.
 */
const TRANSCRIPT_QUIET_HOLD_TTL_MS = 12_000;

/**
 * The quiet window a 'transcript_quiet' hold waits for before releasing early.
 *
 * Mirrors TERMINAL_FALLBACK_TRANSCRIPT_QUIET_MS (8s). Kept as a local constant to
 * avoid an import cycle; `mesh-completion-hold-release.test.ts` asserts the two
 * stay equal and that TRANSCRIPT_QUIET_HOLD_TTL_MS remains strictly greater, so a
 * future change to the admission window cannot silently re-create defect (2).
 */
const TRANSCRIPT_QUIET_RELEASE_MS = 8_000;

/** Test/assertion accessor for the hold timing contract. Content-free constants only. */
export function __completionHoldTimingContract(): {
    retryMs: number;
    liveStateTtlMs: number;
    transcriptQuietTtlMs: number;
    transcriptQuietReleaseMs: number;
} {
    return {
        retryMs: MID_TURN_COMPLETION_HOLD_RETRY_MS,
        liveStateTtlMs: MID_TURN_COMPLETION_HOLD_TTL_MS,
        transcriptQuietTtlMs: TRANSCRIPT_QUIET_HOLD_TTL_MS,
        transcriptQuietReleaseMs: TRANSCRIPT_QUIET_RELEASE_MS,
    };
}

/** Minimal structural slice of DaemonComponents the hold needs to re-read live state. */
export type LiveStateHoldComponents = {
    instanceManager?: { getInstance?: (sessionId: string) => unknown };
};

/** Payload shape the drain hands back to the forwarder's inject function. */
export type HeldCompletionInjectArgs = {
    meshId: string;
    sourceInstanceId?: string;
    nodeId?: string;
    nodeLabel: string;
    event: 'agent:generating_completed';
    metadataEvent: Record<string, unknown>;
};

/**
 * What the hold is actually waiting for. The drain re-checks THIS, not a fixed
 * predicate — see defect (3) in the header: re-checking live-pending for a hold
 * armed by the transcript_growing veto fires straight back into that veto.
 *
 *   'live_pending'       — MID-TURN-LIVE-STATE-GATE: a modal/adapter/trailing-tool
 *                          observation vetoed the completion. Clears when the
 *                          provider instance stops reporting pending evidence.
 *   'transcript_quiet'   — terminal-admission rule 6: the tail was still moving.
 *                          Clears when the newest bubble ages past the quiet window.
 */
export type CompletionHoldWaitReason = 'live_pending' | 'transcript_quiet';

/** Why a held completion left the map — the drain reports every exit. */
export type CompletionHoldOutcome =
    /** The wait condition cleared; the completion was re-injected normally. */
    | 'released_condition_cleared'
    /** The bound was reached; released anyway, marked so the gate admits it once. */
    | 'released_hold_expired'
    /** Identity moved on (terminal, reassignment, new attempt/nonce) — nothing to deliver. */
    | 'abandoned_identity_changed'
    /** The session is gone — no local instance to observe or deliver against. */
    | 'abandoned_session_gone';

type HeldLiveStateCompletion = {
    components: LiveStateHoldComponents;
    inject: (components: LiveStateHoldComponents, args: HeldCompletionInjectArgs) => unknown;
    meshId: string;
    sourceInstanceId?: string;
    nodeId?: string;
    nodeLabel: string;
    sessionId: string;
    taskId: string;
    attemptId: string;
    dispatchNonce: number;
    providerType?: string;
    eventTimestamp: number;
    waitingOn: CompletionHoldWaitReason;
    armedAt: number;
    expiresAt: number;
    nextCheckAt: number;
};

/**
 * Observer for hold lifecycle transitions. The forwarder installs one so every
 * arm/fire/give-up is logged and traced — defect (1) was invisible in production
 * precisely because the drop path emitted nothing at all, leaving a log that said
 * "retry armed" and then went silent forever.
 *
 * Content-free by construction: identity plus an enum outcome, never transcript,
 * summary, or modal text.
 */
export type CompletionHoldObserver = (report: {
    outcome: CompletionHoldOutcome;
    meshId: string;
    sessionId: string;
    taskId: string;
    attemptId: string;
    waitingOn: CompletionHoldWaitReason;
    heldForMs: number;
}) => void;

let completionHoldObserver: CompletionHoldObserver | null = null;

export function setCompletionHoldObserver(observer: CompletionHoldObserver | null): void {
    completionHoldObserver = observer;
}

function reportHoldOutcome(held: HeldLiveStateCompletion, outcome: CompletionHoldOutcome, nowMs: number): void {
    try {
        completionHoldObserver?.({
            outcome,
            meshId: held.meshId,
            sessionId: held.sessionId,
            taskId: held.taskId,
            attemptId: held.attemptId,
            waitingOn: held.waitingOn,
            heldForMs: nowMs - held.armedAt,
        });
    } catch { /* observation must never wedge a completion */ }
}

const heldLiveStateCompletions = new Map<string, HeldLiveStateCompletion>();
let heldLiveStateCompletionTimer: NodeJS.Timeout | null = null;

function heldCompletionKey(meshId: string, taskId: string, attemptId: string, sessionId: string, nonce: number): string {
    return `${meshId}\u001f${taskId}\u001f${attemptId}\u001f${sessionId}\u001f${nonce}`;
}

function scheduleHeldLiveStateCompletionDrain(): void {
    if (heldLiveStateCompletionTimer || heldLiveStateCompletions.size === 0) return;
    heldLiveStateCompletionTimer = setTimeout(() => {
        heldLiveStateCompletionTimer = null;
        drainHeldLiveStateCompletions();
    }, MID_TURN_COMPLETION_HOLD_RETRY_MS);
    heldLiveStateCompletionTimer.unref?.();
}

/**
 * Read the newest transcript-tail timestamp off a provider instance, using the
 * same duck-typed accessor the provider_event admission gate reads. Returns
 * undefined when the tail cannot be observed — the caller treats that as "cannot
 * prove still-growing", i.e. it releases rather than holding forever. Absence of
 * evidence must never manufacture a hold, exactly as it never manufactures a veto.
 */
function readNewestTailActivityAtMs(instance: unknown, nowMs: number): number | undefined {
    const source = instance as {
        getTerminalAdmissionObservations?: (nowMs?: number) => { newestActivityAtMs?: number } | undefined;
    } | null | undefined;
    if (typeof source?.getTerminalAdmissionObservations !== 'function') return undefined;
    try {
        // Pass OUR clock. The accessor takes nowMs and some implementations fold it
        // into the snapshot they return; letting it default to wall-clock would make
        // the freshness comparison below mix two different clocks.
        const newest = source.getTerminalAdmissionObservations(nowMs)?.newestActivityAtMs;
        return typeof newest === 'number' && Number.isFinite(newest) ? newest : undefined;
    } catch { return undefined; }
}

/**
 * Has the condition this hold is waiting on cleared?
 *
 * Re-checks the reason the completion was ACTUALLY declined. Checking a fixed
 * predicate here was defect (3): a transcript_growing hold whose re-check asked
 * "is live evidence pending?" always got "no" and fired straight back into the
 * veto that armed it, burning the whole TTL in 250ms bounces.
 */
function heldCompletionConditionCleared(
    held: HeldLiveStateCompletion,
    liveInstance: unknown,
    nowMs: number,
): boolean {
    if (held.waitingOn === 'live_pending') {
        return !readLiveTurnPendingEvidence(liveInstance).pending;
    }
    // 'transcript_quiet' — the tail must age past the same quiet window the
    // admission rule enforces. An unobservable tail cannot prove growth, so it
    // clears (fail-open, consistent with the gate's own liveness contract).
    const newest = readNewestTailActivityAtMs(liveInstance, nowMs);
    if (newest === undefined) return true;
    return nowMs - newest >= TRANSCRIPT_QUIET_RELEASE_MS;
}

function deliverHeldCompletion(held: HeldLiveStateCompletion, expired: boolean): void {
    held.inject(held.components, {
        meshId: held.meshId,
        sourceInstanceId: held.sourceInstanceId,
        nodeId: held.nodeId,
        nodeLabel: held.nodeLabel,
        event: 'agent:generating_completed',
        metadataEvent: {
            event: 'agent:generating_completed',
            instanceId: held.sessionId,
            targetSessionId: held.sessionId,
            taskId: held.taskId,
            attemptId: held.attemptId,
            dispatchNonce: held.dispatchNonce,
            timestamp: held.eventTimestamp,
            ...(held.providerType ? { providerType: held.providerType } : {}),
            completionDiagnostic: {
                source: 'mid_turn_live_state_retry',
                contentFreeRetry: true,
                // ★BOUNDED-HOLD-EXHAUSTED. The hold reached its ceiling without the
                // wait condition clearing, and we are releasing anyway rather than
                // dropping — a completion the worker already committed to its ledger
                // must reach the coordinator even if our local tail read disagrees.
                // The suppression gate honors this as a ONE-TIME admission bypass
                // (see mesh-event-suppression): without it the release re-enters the
                // same veto and the loss is merely relocated, which is what the
                // original "released to the normal pipeline" comment wrongly assumed
                // would not happen. Delivering a completion slightly early is
                // recoverable; never delivering it is not.
                ...(expired ? { holdExpired: true, holdWaitedOn: held.waitingOn } : {}),
            },
        },
    });
}

function drainHeldLiveStateCompletions(nowMs: number = Date.now()): void {
    for (const [key, held] of heldLiveStateCompletions) {
        if (nowMs < held.nextCheckAt) continue;

        const expired = nowMs >= held.expiresAt;

        const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(held.meshId, held.taskId);
        const identityStillCurrent = !!attempt
            && !attempt.terminalOutcome
            && attempt.attemptId === held.attemptId
            && sessionIdsEquivalent(attempt.sessionId, held.sessionId)
            && attempt.dispatchNonce === held.dispatchNonce;
        if (!identityStillCurrent) {
            // Nothing to deliver: the turn already reached a terminal by another
            // route, or the identity moved on. This is the one exit where dropping
            // is correct, because the coordinator is not waiting on THIS event.
            heldLiveStateCompletions.delete(key);
            reportHoldOutcome(held, 'abandoned_identity_changed', nowMs);
            continue;
        }
        const liveInstance = held.components.instanceManager?.getInstance?.(held.sessionId);
        if (!liveInstance) {
            heldLiveStateCompletions.delete(key);
            reportHoldOutcome(held, 'abandoned_session_gone', nowMs);
            continue;
        }

        if (!expired && !heldCompletionConditionCleared(held, liveInstance, nowMs)) {
            held.nextCheckAt = nowMs + MID_TURN_COMPLETION_HOLD_RETRY_MS;
            continue;
        }

        // Delete BEFORE delivery. A duplicate provider event or re-entrant retry
        // sees no armed hold, and the turn reducer/outbox remain the final exactly-
        // once authority.
        heldLiveStateCompletions.delete(key);
        reportHoldOutcome(held, expired ? 'released_hold_expired' : 'released_condition_cleared', nowMs);
        deliverHeldCompletion(held, expired);
    }
    scheduleHeldLiveStateCompletionDrain();
}

export function holdCompletionForLiveStateRetry<C extends LiveStateHoldComponents>(
    components: C,
    args: {
        meshId: string;
        sourceInstanceId?: string;
        nodeId?: string;
        nodeLabel: string;
        metadataEvent: Record<string, unknown>;
    },
    eventSessionId: string,
    nowMs: number,
    inject: (components: C, args: HeldCompletionInjectArgs) => unknown,
    /**
     * Which veto armed this hold, hence what the drain must re-check and how long
     * it may wait. Defaults to the live-state gate's own reason so existing callers
     * keep their prior behavior.
     */
    waitingOn: CompletionHoldWaitReason = 'live_pending',
): boolean {
    const taskId = readNonEmptyString(args.metadataEvent.taskId);
    const attemptId = readNonEmptyString(args.metadataEvent.attemptId);
    const dispatchNonce = typeof args.metadataEvent.dispatchNonce === 'number'
        ? args.metadataEvent.dispatchNonce : NaN;
    const eventTimestamp = typeof args.metadataEvent.timestamp === 'number'
        ? args.metadataEvent.timestamp : NaN;
    if (!taskId || !attemptId || !Number.isFinite(dispatchNonce) || !Number.isFinite(eventTimestamp)) return false;
    // ★A RELEASED-ON-EXPIRY completion must never re-arm a hold. Without this the
    // bound is per-hold rather than per-completion: each expiry release re-enters
    // the gate, gets declined again, and arms a FRESH hold with a fresh TTL — an
    // unbounded loop that still never notifies. The one-time bypass the gate grants
    // to `holdExpired` also closes this, but the invariant belongs here too, where
    // the bound is defined.
    const priorDiagnostic = args.metadataEvent.completionDiagnostic;
    if (priorDiagnostic && typeof priorDiagnostic === 'object'
        && (priorDiagnostic as Record<string, unknown>).holdExpired === true) {
        return false;
    }
    const ttlMs = waitingOn === 'transcript_quiet'
        ? TRANSCRIPT_QUIET_HOLD_TTL_MS
        : MID_TURN_COMPLETION_HOLD_TTL_MS;
    const key = heldCompletionKey(args.meshId, taskId, attemptId, eventSessionId, dispatchNonce);
    if (!heldLiveStateCompletions.has(key)) {
        heldLiveStateCompletions.set(key, {
            components,
            // Sound in practice: the drain always calls `inject` back with the
            // exact `components` object stored alongside it, so widening the
            // parameter type here can never surface a narrower object.
            inject: inject as HeldLiveStateCompletion['inject'],
            meshId: args.meshId,
            sourceInstanceId: args.sourceInstanceId,
            nodeId: args.nodeId,
            nodeLabel: args.nodeLabel,
            sessionId: eventSessionId,
            taskId,
            attemptId,
            dispatchNonce,
            providerType: readNonEmptyString(args.metadataEvent.providerType) || undefined,
            eventTimestamp,
            waitingOn,
            armedAt: nowMs,
            expiresAt: nowMs + ttlMs,
            nextCheckAt: nowMs + MID_TURN_COMPLETION_HOLD_RETRY_MS,
        });
    }
    scheduleHeldLiveStateCompletionDrain();
    return true;
}

export function __drainHeldLiveStateCompletionsForTests(nowMs: number = Date.now()): void {
    drainHeldLiveStateCompletions(nowMs);
}

export function __resetHeldLiveStateCompletionsForTests(): void {
    if (heldLiveStateCompletionTimer) clearTimeout(heldLiveStateCompletionTimer);
    heldLiveStateCompletionTimer = null;
    heldLiveStateCompletions.clear();
}
