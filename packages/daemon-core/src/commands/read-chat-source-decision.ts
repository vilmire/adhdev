/**
 * Chat Commands — read side: CLI chat-source decision.
 *
 * Drives ChatSourceRegistry for a single read: turns a native-history fetch
 * result into a ChatSourceObservation, applies the sticky-native hold and
 * exact-identity re-bootstrap rules, and emits the legacy v1 `messageSource`
 * provenance payload the dashboard and debug bundles still parse.
 *
 * Split out of chat-commands-read.ts verbatim — no behaviour change.
 */

import type { ProviderModule } from '../providers/contracts.js';
import {
    CHAT_SOURCE_REGISTRY,
    buildV1NativePresentObservation,
    chatSourceSessionKey,
    type ChatSourceDecision,
    type ChatSourceObservation,
    type ChatSourceTransitionCause,
} from '../chat/source-resolver.js';
import type { ChatMessage } from '../types.js';
import { isNativeSourceCanonicalHistory } from '../config/chat-history.js';
// normalizeNativeHistoryMessages stays in chat-commands-read.ts: it is a
// public export with call sites in handleReadChat / handleChatHistory that
// are out of scope for this split.
import { normalizeNativeHistoryMessages } from './chat-commands-read.js';

// (A2.2) CLI_NATIVE_HISTORY_FRESH_MS removed with isNativeHistoryFreshEnough.
// Hardcoded native-transcript provider allow-list. Deprecated. Kept only as a
// last-resort fallback when ProviderModule is not yet loaded; on every hit we
// warn so the dependency on this set is visible. A2 deletes the set entirely
// and routes solely through canonicalHistory.contractVersion +
// isNativeSourceCanonicalHistory().
const CLI_NATIVE_TRANSCRIPT_PROVIDERS = new Set(['codex-cli', 'claude-cli', 'hermes-cli', 'antigravity-cli']);

const warnedLegacyNativeAllowlistHits = new Set<string>();
function warnLegacyNativeAllowlistHit(providerType: string): void {
    if (warnedLegacyNativeAllowlistHits.has(providerType)) return;
    warnedLegacyNativeAllowlistHits.add(providerType);
    // eslint-disable-next-line no-console
    console.warn(
        `[chat-commands] supportsCliNativeTranscript fell back to the hardcoded `
        + `CLI_NATIVE_TRANSCRIPT_PROVIDERS set for "${providerType}". `
        + `The provider module was unavailable or did not declare canonicalHistory. `
        + `Set canonicalHistory.contractVersion in the provider.json to remove this dependency.`,
    );
}

export function supportsCliNativeTranscript(providerType: string, provider?: ProviderModule): boolean {
    // Preferred path: the provider module declares canonicalHistory in its
    // provider.json. We trust that declaration regardless of the legacy
    // allow-list. A2 will additionally require canonicalHistory.contractVersion
    // to be a supported value (transcript-v2.ts).
    if (provider?.category === 'cli' && isNativeSourceCanonicalHistory(provider?.nativeHistory)) {
        return true;
    }
    // Last-resort fallback for early call sites where the provider module is
    // not yet loaded. Warn once per provider type so this dependency is visible
    // and can be removed in A2.
    if (CLI_NATIVE_TRANSCRIPT_PROVIDERS.has(providerType)) {
        warnLegacyNativeAllowlistHit(providerType);
        return true;
    }
    return false;
}

function getMessageNewestReceivedAt(messages: Array<{ receivedAt?: unknown; timestamp?: unknown }>): number {
    let newest = 0;
    for (const message of messages) {
        const receivedAt = Number(message?.receivedAt ?? message?.timestamp ?? 0);
        if (Number.isFinite(receivedAt) && receivedAt > newest) newest = receivedAt;
    }
    return newest;
}

function buildCliMessageSourceProvenance(args: {
    selected: 'native-history' | 'pty-parser';
    provider: string;
    nativeHandle?: string;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    transcriptWorkspace?: string;
    fallbackReason?: string;
    nativeSource?: string;
    sourcePath?: string;
    sourceMtimeMs?: number;
    nativeHistoryCoverage?: string;
    partialReason?: string;
    unavailableReason?: string;
    nativeMessages?: ChatMessage[];
    ptyMessages?: ChatMessage[];
    returnedMessages?: ChatMessage[];
    safeMapping?: boolean;
    freshEnough?: boolean;
    ptyStatusApprovalOnly?: boolean;
}): Record<string, unknown> {
    const sourceMtimeMs = Number(args.sourceMtimeMs || 0);
    const sourceMtimeAgeMs = sourceMtimeMs > 0 ? Math.max(0, Date.now() - sourceMtimeMs) : undefined;
    const nativeMessages = args.nativeMessages || [];
    const ptyMessages = args.ptyMessages || [];
    const returnedMessages = args.returnedMessages || [];
    const identityStatus = args.selected === 'native-history'
        ? 'safe'
        : args.fallbackReason === 'native_history_not_safely_mapped'
            ? 'ambiguous_session_identity'
            : args.fallbackReason?.startsWith('native_history_unavailable')
                ? 'transcript_unmapped'
                : undefined;
    return {
        selected: args.selected,
        provider: args.provider,
        providerType: args.provider,
        ...(identityStatus ? { identityStatus } : {}),
        ...(args.nativeHandle ? { nativeHandle: args.nativeHandle } : {}),
        ...(args.nativeHandle ? { nativeSessionId: args.nativeHandle } : {}),
        ...(args.sessionWorkspace ? { sessionWorkspace: args.sessionWorkspace } : {}),
        ...(args.intendedWorkspace ? { intendedWorkspace: args.intendedWorkspace } : {}),
        ...(args.transcriptWorkspace ? { transcriptWorkspace: args.transcriptWorkspace } : {}),
        ...(args.fallbackReason ? { fallbackReason: args.fallbackReason } : {}),
        ...(args.nativeSource ? { nativeSource: args.nativeSource } : {}),
        ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
        ...(args.nativeHistoryCoverage ? { nativeHistoryCoverage: args.nativeHistoryCoverage } : {}),
        ...(args.partialReason ? { partialReason: args.partialReason } : {}),
        ...(args.unavailableReason ? { unavailableReason: args.unavailableReason } : {}),
        ptyStatusApprovalOnly: args.ptyStatusApprovalOnly === true,
        staleness: {
            sourceMtimeMs: sourceMtimeMs || undefined,
            sourceMtimeAgeMs,
            nativeNewestMessageAt: getMessageNewestReceivedAt(nativeMessages),
            ptyNewestMessageAt: getMessageNewestReceivedAt(ptyMessages),
            freshEnough: args.freshEnough === true,
        },
        coverage: {
            nativeMessageCount: nativeMessages.length,
            ptyMessageCount: ptyMessages.length,
            returnedMessageCount: returnedMessages.length,
            safeMapping: args.safeMapping === true,
            // true when PTY message bodies are suppressed and must not be treated as
            // chat content. PTY may still contribute status/approval/screen evidence.
            ptyMessagesSuppressed: args.selected === 'native-history' || args.ptyStatusApprovalOnly === true,
        },
    };
}

/**
 * Map a ChatSourceMachine transition cause back to the v1 messageSource
 * `fallbackReason` vocabulary so legacy consumers (web-cloud, tests, mesh
 * debug bundles) keep parsing strings they already know. A3 replaces the
 * caller surface with stateTransition/lockState, after which this map can be
 * deleted.
 *
 * Returns undefined when the cause does not correspond to a fallback (i.e.
 * the source is native-history and there is nothing to explain).
 */
export function causeToLegacyFallbackReason(
    cause: ChatSourceTransitionCause,
    selected: 'native-history' | 'pty-parser',
    extraDetail?: { unavailableReason?: string; nativeSource?: string },
): string | undefined {
    if (selected === 'native-history') return undefined;
    switch (cause) {
        case 'initial':
            return 'native_history_not_checked';
        case 'native_progressed':
            // Selected pty-parser despite a progressed observation — that
            // means we held PtyOnly stickily (peak unmet or non-superset).
            return 'native_history_not_selected';
        case 'native_regressed_shrunk':
            return 'native_history_empty';
        case 'native_regressed_unsafe_mapping':
            return 'native_history_not_safely_mapped';
        case 'native_regressed_coverage_partial':
            return 'native_history_partial';
        case 'native_regressed_coverage_unavailable':
            return 'native_history_unavailable';
        case 'native_unavailable_read_error':
            return extraDetail?.unavailableReason
                ? `native_history_unavailable:${extraDetail.unavailableReason}`
                : 'native_history_unavailable';
        case 'native_unavailable_provider_unsupported':
            return 'provider_native_transcript_not_supported';
        case 'native_unavailable_empty':
            return 'native_history_empty';
        case 'native_unavailable_not_native_source':
            return extraDetail?.nativeSource
                ? `native_history_source_${extraDetail.nativeSource}`
                : 'native_history_unavailable';
    }
}

/**
 * Translate a native-history fetch result + provider/adapter context into a
 * ChatSourceObservation and drive ChatSourceRegistry. Returns the decision
 * together with the legacy messageSource payload so call sites can produce
 * a v1-compatible response without duplicating the registry plumbing.
 *
 * This is the replacement for the 300-line if-ladder that previously lived
 * inline in handleReadChat. It is intentionally split out for two reasons:
 * (1) we will call it from two places (CLI adapter branch + history-only
 * branch) instead of duplicating the ladder, (2) tests can drive it with
 * synthetic native-history results to verify the cause→fallbackReason
 * mapping without booting the whole readChat pipeline.
 */
export function decideCliReadChatSource(args: {
    providerType: string;
    provider?: ProviderModule;
    sessionId: string;
    nativeHistoryResult: any | null;
    nativeHistoryError?: unknown;
    safeMapping: boolean;
    trustedExactNativeIdentity?: boolean;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    ptyMessages: ChatMessage[];
    ptyStatusApprovalOnly: boolean;
}): {
    decision: ChatSourceDecision;
    messageSource: Record<string, unknown>;
    nativeMessages: ChatMessage[];
    nativeSelected: boolean;
} {
    const supportsNative = supportsCliNativeTranscript(args.providerType, args.provider);
    const observation = buildObservationForCli(args, supportsNative);
    const sessionKey = chatSourceSessionKey(args.providerType, args.sessionId);

    // STICKY-NATIVE: once a session's transcript is bound to native-history via
    // a TRUSTED EXACT provider-session identity (the on-disk uuid == this
    // session's own transcript file, not a recency/mtime guess), a single read
    // that momentarily fails to reproduce the full native slice is a TRANSIENT
    // gap, NOT evidence native regressed or vanished. Concretely, cursor-agent
    // rewrites its JSONL tail mid-turn — the file is briefly empty, or exposes a
    // SHRUNK slice (old assistant row dropped while the new turn is streamed) —
    // so a per-read observation sees either `native_unavailable/empty` or a
    // `native_regressed_shrunk`. Either one flips a NativeLocked machine to
    // `pty-parser` for that read (and, after enough misses, permanently to
    // PtyOnly). That is exactly the reported symptom: cursor chat provenance
    // "flips back and forth between PTY and native-history".
    //
    // Fix: for a session that (a) resolved via a trusted EXACT identity and
    // (b) is already committed to native (NativeLocked/Recovering), speculatively
    // observe, and if the machine WOULD flip to pty-parser, roll the machine
    // state back and HOLD native-history as authoritative for this read. Exact
    // identity means the read is provably against THIS session's own transcript
    // file, so a transient gap on it can only be a mid-write artifact — never a
    // genuine session switch or data loss (cursor's file is cumulative). A
    // workspace-heuristic (non-exact) read is never eligible, so a real session
    // switch still flips normally.
    //
    // HOLD ELIGIBILITY (zero-bubble fix): the hold may only pin a NON-EMPTY,
    // safely-mapped native slice (the shrunk mid-write rewrite case above).
    // Holding an EMPTY/unavailable observation restored a NativeLocked selection
    // with zero rows and forced ptyStatusApprovalOnly — an "authoritative" empty
    // native tail that suppressed the very PTY rows that could have rendered
    // (the coordinator zero-bubble bug: messages=[] with selected=native-history,
    // ptyMessageCount=6, ptyMessagesSuppressed=true). An empty/unavailable or
    // unsafe observation therefore does NOT hold: the machine's own decision
    // stands (NativeLocked → Recovering on a transient miss — the watermark
    // survives and the next progressed read re-locks; → PtyOnly on unsafe
    // mapping), PTY stays visible, and the normal PTY/live-workspace recovery
    // below remains reachable.
    const priorSnapshot = CHAT_SOURCE_REGISTRY.snapshotRecord(sessionKey);
    const priorState = priorSnapshot?.state ?? CHAT_SOURCE_REGISTRY.getState(sessionKey);
    const eligibleForStickyHold = args.trustedExactNativeIdentity === true
        && (priorState.name === 'NativeLocked' || priorState.name === 'Recovering');

    let decision = CHAT_SOURCE_REGISTRY.observe(sessionKey, observation);

    const heldNativeMessages: ChatMessage[] = observation.kind === 'native_present'
        ? extractNativeMessagesFromResult(args.providerType, args.nativeHistoryResult)
        : [];
    const mayHoldNativeSlice = heldNativeMessages.length > 0 && args.safeMapping === true;

    if (eligibleForStickyHold && decision.selected === 'pty-parser' && mayHoldNativeSlice) {
        // The machine flipped a native-committed, exact-identity session to PTY
        // on this read even though a non-empty, safely-mapped native slice was
        // observed (a shrunk mid-write rewrite). Treat it as a transient native
        // gap: undo the observe and report native-history held with the shrunk
        // slice. The streaming/tail delivery layer already suppresses a thin
        // tail from clobbering the last real tail, so holding native with the
        // mapped rows is strictly safer than emitting PTY under a
        // native-authority session.
        CHAT_SOURCE_REGISTRY.restoreRecord(sessionKey, priorSnapshot);
        const messageSource = buildCliMessageSourceProvenance({
            selected: 'native-history',
            provider: args.providerType,
            nativeHandle: typeof args.nativeHistoryResult?.providerSessionId === 'string'
                ? args.nativeHistoryResult.providerSessionId
                : undefined,
            sessionWorkspace: args.sessionWorkspace,
            intendedWorkspace: args.intendedWorkspace,
            transcriptWorkspace: undefined,
            fallbackReason: 'native_history_transient_gap_held',
            nativeSource: 'provider-native',
            sourcePath: typeof args.nativeHistoryResult?.sourcePath === 'string' ? args.nativeHistoryResult.sourcePath : undefined,
            sourceMtimeMs: typeof args.nativeHistoryResult?.sourceMtimeMs === 'number' ? args.nativeHistoryResult.sourceMtimeMs : undefined,
            nativeHistoryCoverage: undefined,
            partialReason: undefined,
            unavailableReason: observation.kind === 'native_unavailable' ? observation.reason : undefined,
            nativeMessages: heldNativeMessages,
            ptyMessages: args.ptyMessages,
            returnedMessages: heldNativeMessages,
            safeMapping: args.safeMapping,
            freshEnough: true,
            ptyStatusApprovalOnly: true,
        });
        return {
            decision: {
                selected: 'native-history',
                nextState: priorState,
                transition: {
                    fromState: priorState.name,
                    toState: priorState.name,
                    event: 'NoOp',
                    cause: decision.transition.cause,
                    at: Date.now(),
                },
                lockState: { locked: priorState.name === 'NativeLocked' },
            },
            messageSource,
            nativeMessages: heldNativeMessages,
            nativeSelected: true,
        };
    }

    // A restored runtime can briefly expose different native slices while the
    // provider transcript settles (for example, startup/system rows may be
    // filtered after the first read). The source machine correctly treats a
    // shrinking slice as regression, but an exact provider-session lookup with
    // no PTY transcript has no safer fallback. Re-bootstrap only this proven
    // identity so the chat does not disappear after daemon restart.
    if (
        decision.selected === 'pty-parser'
        && args.trustedExactNativeIdentity === true
        && args.safeMapping
        && args.ptyMessages.length === 0
        && observation.kind === 'native_present'
        && observation.coverage !== 'partial'
        && observation.messages.length > 0
    ) {
        CHAT_SOURCE_REGISTRY.clear(sessionKey);
        decision = CHAT_SOURCE_REGISTRY.observe(sessionKey, observation);
    }

    const nativeMessages: ChatMessage[] = observation.kind === 'native_present'
        ? extractNativeMessagesFromResult(args.providerType, args.nativeHistoryResult)
        : [];

    const nativeSource = typeof args.nativeHistoryResult?.source === 'string'
        ? args.nativeHistoryResult.source
        : undefined;
    const sourcePath = typeof args.nativeHistoryResult?.sourcePath === 'string'
        ? args.nativeHistoryResult.sourcePath
        : undefined;
    const sourceMtimeMs = typeof args.nativeHistoryResult?.sourceMtimeMs === 'number'
        ? args.nativeHistoryResult.sourceMtimeMs
        : undefined;
    const coverageHint = typeof args.nativeHistoryResult?.nativeHistoryCoverage === 'string'
        ? args.nativeHistoryResult.nativeHistoryCoverage
        : undefined;
    const partialReason = typeof args.nativeHistoryResult?.partialReason === 'string'
        ? args.nativeHistoryResult.partialReason
        : undefined;
    const unavailableReason = typeof args.nativeHistoryResult?.unavailableReason === 'string'
        ? args.nativeHistoryResult.unavailableReason
        : args.nativeHistoryError
            ? `error:${(args.nativeHistoryError as any)?.message || String(args.nativeHistoryError)}`
            : undefined;
    const nativeHandle = typeof args.nativeHistoryResult?.providerSessionId === 'string'
        ? args.nativeHistoryResult.providerSessionId
        : undefined;
    const transcriptWorkspace = typeof args.nativeHistoryResult?.workspace === 'string'
        ? args.nativeHistoryResult.workspace
        : nativeMessages.map((m: any) => typeof m?.workspace === 'string' ? m.workspace.trim() : '').find(Boolean);

    const fallbackReason = causeToLegacyFallbackReason(decision.transition.cause, decision.selected, {
        unavailableReason,
        nativeSource: nativeSource && nativeSource !== 'provider-native' ? nativeSource : undefined,
    });

    // ptyStatusApprovalOnly: when the machine selected native-history we
    // suppress PTY content so the dashboard does not double-show messages
    // already in the native transcript. When the machine selected
    // pty-parser, PTY is the authoritative source — do NOT suppress it.
    // Callers used to hard-code this to `nativeSelected first = true` which
    // suppressed PTY content even when native was empty/unavailable, leaving
    // the dashboard with zero visible messages (the codex generating/waiting
    // approval stuck state). Trust the machine here, not the caller hint.
    const ptyStatusApprovalOnly = decision.selected === 'native-history'
        ? true
        : args.ptyStatusApprovalOnly;

    const messageSource = buildCliMessageSourceProvenance({
        selected: decision.selected,
        provider: args.providerType,
        nativeHandle,
        sessionWorkspace: args.sessionWorkspace,
        intendedWorkspace: args.intendedWorkspace,
        transcriptWorkspace,
        fallbackReason,
        nativeSource,
        sourcePath,
        sourceMtimeMs,
        nativeHistoryCoverage: coverageHint,
        partialReason,
        unavailableReason,
        nativeMessages,
        ptyMessages: args.ptyMessages,
        returnedMessages: decision.selected === 'native-history' ? nativeMessages : args.ptyMessages,
        safeMapping: args.safeMapping,
        // freshEnough is a v1 concept the machine does not model directly.
        // We surface lockState.locked here so v1 consumers reading
        // staleness.freshEnough still get a meaningful boolean.
        freshEnough: decision.lockState.locked,
        ptyStatusApprovalOnly,
    });

    return {
        decision,
        messageSource,
        nativeMessages,
        nativeSelected: decision.selected === 'native-history',
    };
}

export function buildObservationForCli(
    args: {
        providerType: string;
        sessionId: string;
        nativeHistoryResult: any | null;
        nativeHistoryError?: unknown;
        safeMapping: boolean;
    },
    supportsNative: boolean,
): ChatSourceObservation {
    if (!supportsNative) {
        return { kind: 'native_unavailable', reason: 'provider_not_supported' };
    }
    if (args.nativeHistoryError) {
        return { kind: 'native_unavailable', reason: 'read_error' };
    }
    const result = args.nativeHistoryResult;
    if (!result || typeof result !== 'object') {
        return { kind: 'native_unavailable', reason: 'read_error' };
    }
    const source = typeof result.source === 'string' ? result.source : '';
    if (source && source !== 'provider-native') {
        // 'native-unavailable' or other producer-side declined source.
        return { kind: 'native_unavailable', reason: source === 'native-unavailable' ? 'empty' : 'not_native_source' };
    }
    const messages = Array.isArray(result.messages) ? result.messages : [];
    if (messages.length === 0) {
        return { kind: 'native_unavailable', reason: 'empty' };
    }
    const coverage = typeof result.nativeHistoryCoverage === 'string'
        ? result.nativeHistoryCoverage
        : 'tail';
    if (coverage === 'unavailable') {
        return { kind: 'native_unavailable', reason: 'coverage_unavailable' };
    }
    return buildV1NativePresentObservation({
        providerType: args.providerType,
        sessionId: args.sessionId,
        messages,
        coverage: coverage === 'full' || coverage === 'tail' || coverage === 'current-turn' || coverage === 'partial'
            ? coverage
            : 'tail',
        safeMapping: args.safeMapping,
    });
}

function extractNativeMessagesFromResult(providerType: string, result: any): ChatMessage[] {
    if (!result || !Array.isArray(result.messages)) return [];
    return normalizeNativeHistoryMessages(
        providerType,
        result.messages as ChatMessage[],
        typeof result.providerSessionId === 'string' ? result.providerSessionId : undefined,
    );
}

/**
 * ptyStatusApprovalOnly is true when the daemon should treat PTY content as
 * status/approval signal only (not as chat messages). v1 set this to `true`
 * whenever native-history was selected as the source, and `false` otherwise.
 * The machine equivalent: when native is the source we want PTY suppressed.
 */
export function primaryPtyApprovalOnlyFor(_cliType: string, nativeSelected: boolean): boolean {
    return nativeSelected;
}
