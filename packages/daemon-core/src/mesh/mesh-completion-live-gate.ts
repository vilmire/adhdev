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
// ---------------------------------------------------------------------------
const MID_TURN_COMPLETION_HOLD_RETRY_MS = 250;
const MID_TURN_COMPLETION_HOLD_TTL_MS = 5_000;

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
    expiresAt: number;
    nextCheckAt: number;
};

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

function drainHeldLiveStateCompletions(nowMs: number = Date.now()): void {
    for (const [key, held] of heldLiveStateCompletions) {
        if (nowMs < held.nextCheckAt) continue;
        if (nowMs >= held.expiresAt) {
            heldLiveStateCompletions.delete(key);
            continue;
        }
        const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(held.meshId, held.taskId);
        const identityStillCurrent = !!attempt
            && !attempt.terminalOutcome
            && attempt.attemptId === held.attemptId
            && sessionIdsEquivalent(attempt.sessionId, held.sessionId)
            && attempt.dispatchNonce === held.dispatchNonce;
        if (!identityStillCurrent) {
            heldLiveStateCompletions.delete(key);
            continue;
        }
        const liveInstance = held.components.instanceManager?.getInstance?.(held.sessionId);
        if (!liveInstance) {
            heldLiveStateCompletions.delete(key);
            continue;
        }
        const live = readLiveTurnPendingEvidence(liveInstance);
        if (live.pending) {
            held.nextCheckAt = nowMs + MID_TURN_COMPLETION_HOLD_RETRY_MS;
            continue;
        }
        // Delete BEFORE delivery. A duplicate provider event or re-entrant retry
        // sees no armed hold, and the turn reducer/outbox remain the final exactly-
        // once authority.
        heldLiveStateCompletions.delete(key);
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
                },
            },
        });
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
): boolean {
    const taskId = readNonEmptyString(args.metadataEvent.taskId);
    const attemptId = readNonEmptyString(args.metadataEvent.attemptId);
    const dispatchNonce = typeof args.metadataEvent.dispatchNonce === 'number'
        ? args.metadataEvent.dispatchNonce : NaN;
    const eventTimestamp = typeof args.metadataEvent.timestamp === 'number'
        ? args.metadataEvent.timestamp : NaN;
    if (!taskId || !attemptId || !Number.isFinite(dispatchNonce) || !Number.isFinite(eventTimestamp)) return false;
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
            expiresAt: nowMs + MID_TURN_COMPLETION_HOLD_TTL_MS,
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
