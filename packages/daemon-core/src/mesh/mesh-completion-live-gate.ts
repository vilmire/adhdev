import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { MeshTurnAttemptRow } from './mesh-runtime-store.js';
import { isTerminalTurnStage } from './mesh-turn-ledger.js';
import { isWeakCompletionEvidence, readNonEmptyString } from './mesh-events-utils.js';

export const AUTHORITATIVE_COMPLETION_MAX_AGE_MS = 60_000;

export type LiveTurnPendingEvidence = {
    pending: boolean;
    kind?: 'adapter' | 'modal' | 'transcript_tool';
    observedAt?: number;
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
    const candidate = instance as {
        getLiveTurnPendingEvidence?: () => LiveTurnPendingEvidence;
        hasLiveTurnPendingEvidence?: () => boolean;
    } | null | undefined;
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
    | { authoritative: false; reason: string };

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
    if ((authorityClass !== 'native-source' && authorityClass !== 'pure-pty')
        || (timing !== 'floor' && timing !== 'hold' && timing !== 'immediate')) {
        return { authoritative: false, reason: 'non_transcript_authority_profile' };
    }
    const evidenceSource = readNonEmptyString(diagnostic.finalAssistantEvidenceSource);
    if ((authorityClass === 'native-source' && evidenceSource !== 'external-native')
        || (authorityClass === 'pure-pty' && evidenceSource !== 'parsed')) {
        return { authoritative: false, reason: 'evidence_source_profile_mismatch' };
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
