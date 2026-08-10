/**
 * Native turn-terminal signal — the provider's OWN "this turn is over" record.
 *
 * WHY THIS EXISTS
 * ---------------
 * Completion detection historically inferred turn end from MESSAGE SHAPE: "is
 * the last user-facing bubble an assistant reply with non-empty text?" That
 * question is unanswerable for a turn that legitimately ends without an
 * assistant message — a turn terminated by a tool call, or one whose reply is
 * empty. Measured on 40 local codex rollouts: of 990 completed turns, 193
 * (19.5%) carried NO assistant text. Every one of those was unjudgeable by
 * shape, so the only thing that ever released them was a timeout. That is the
 * root of the infinite-generating class and the reason five separate
 * time-based escape hatches accumulated in this engine.
 *
 * Several CLIs already answer the question directly. codex writes an explicit
 * `task_complete` event (with `turn_id` and `last_agent_message`) as the final
 * record of every turn, plus `turn_aborted` for the cancelled case; across
 * those same 40 sessions 992 of 997 turns were explicitly terminated, the 5
 * exceptions being process crashes. The signal was always there — nothing read
 * it, and the codex reader actively DROPPED the assistant-less 193 because its
 * message builder discards empty content.
 *
 * DECLARATION, NOT HARDCODING
 * ---------------------------
 * The signal is described by the provider's manifest (`nativeHistory.
 * completionSignal`), never by provider-name branching here, so a new provider
 * gains native completion by declaring where its marker lives. `nativeHistory`
 * is an open object in the v1 CLI schema (`additionalProperties: true`), so
 * this needs no schema change. Providers that ship no such record (claude-cli
 * has no turn-terminal record type at all; hermes-cli has no native transcript)
 * simply declare nothing and keep the existing shape-inference path unchanged.
 *
 * This module is pure: it resolves a declaration and reads already-parsed
 * records. It performs no IO and knows no provider names.
 */

/** Manifest-declared shape of a provider's turn-terminal record. */
export interface NativeCompletionSignalSpec {
    /** Record type marking a normally-finished turn (codex: 'task_complete'). */
    recordType: string;
    /** Optional record type marking an aborted/cancelled turn (codex: 'turn_aborted'). */
    abortRecordType?: string;
    /** Payload field carrying the turn's final text, when the provider supplies one. */
    summaryField?: string;
    /** Payload field carrying the provider's own turn identity (codex: 'turn_id'). */
    turnIdField?: string;
}

/**
 * A terminal marker as surfaced by a native-history reader. Readers emit this
 * for EVERY terminal record — including one with no summary text, which is
 * precisely the case shape inference cannot see.
 */
export interface NativeTurnTerminalMarker {
    /** When the provider recorded the turn end. */
    receivedAt: number;
    /** 'completed' (normal end) or 'aborted' (cancelled/interrupted). */
    outcome: 'completed' | 'aborted';
    /** The turn's final text; EMPTY STRING is valid and means a tool-terminated / empty-reply turn. */
    summary: string;
    /** Provider-native turn identity, when declared and present. */
    turnId?: string;
}

/**
 * Reads a completionSignal declaration off a provider's nativeHistory block.
 * Returns null when the provider declares none — the signal-less path.
 */
export function resolveNativeCompletionSignalSpec(
    nativeHistory: unknown,
): NativeCompletionSignalSpec | null {
    if (!nativeHistory || typeof nativeHistory !== 'object') return null;
    const declared = (nativeHistory as Record<string, unknown>).completionSignal;
    if (!declared || typeof declared !== 'object') return null;
    const spec = declared as Record<string, unknown>;
    const recordType = typeof spec.recordType === 'string' ? spec.recordType.trim() : '';
    if (!recordType) return null;
    const abortRecordType = typeof spec.abortRecordType === 'string' ? spec.abortRecordType.trim() : '';
    const summaryField = typeof spec.summaryField === 'string' ? spec.summaryField.trim() : '';
    const turnIdField = typeof spec.turnIdField === 'string' ? spec.turnIdField.trim() : '';
    return {
        recordType,
        ...(abortRecordType ? { abortRecordType } : {}),
        ...(summaryField ? { summaryField } : {}),
        ...(turnIdField ? { turnIdField } : {}),
    };
}

/**
 * Provider types whose BUILT-IN daemon-side reader surfaces turn-terminal markers even
 * when the manifest carries no `completionSignal` block.
 *
 * This exists only because codex-cli@1.1.17 is already published to the registry, so
 * adding the declaration to its provider.v1.json would drift the channel bundleDigest and
 * require a version bump + republish (a release action). Once the declaration ships in the
 * manifest this set can be emptied without touching any consumer — every call site reads
 * through providerHasNativeTurnSignal / resolveNativeCompletionSignalSpec, never a
 * provider name.
 */
const BUILTIN_TURN_SIGNAL_PROVIDER_TYPES: ReadonlySet<string> = new Set(['codex-cli']);

/**
 * Whether this provider can answer "did the turn end?" authoritatively — either by
 * manifest declaration (the generic path a new provider uses) or via a built-in reader.
 *
 * False for claude-cli (its transcript has no turn-terminal record type at all) and
 * hermes-cli (no native transcript), which stay on message-shape inference.
 */
export function providerHasNativeTurnSignal(
    provider: { type?: string; nativeHistory?: unknown } | null | undefined,
): boolean {
    if (!provider) return false;
    if (resolveNativeCompletionSignalSpec(provider.nativeHistory)) return true;
    const type = typeof provider.type === 'string' ? provider.type.trim() : '';
    return !!type && BUILTIN_TURN_SIGNAL_PROVIDER_TYPES.has(type);
}

/**
 * Selects the terminal marker that proves THIS turn ended.
 *
 * Turn scoping prefers the provider's own turn id when the caller knows it
 * (stronger than a timestamp comparison, which is what the shape-inference path
 * has to fall back on). Otherwise it requires the marker to post-date the turn
 * start, mirroring the existing FALSE-IDLE turn-boundary rule so a PRIOR turn's
 * terminal record can never satisfy the gate for a new one — the
 * ANTIGRAVITY-PREMATURE-COMPLETION failure mode.
 *
 * A marker with no known boundary at all (no turnId, no turnStartedAt) is
 * REJECTED rather than accepted: an unscoped terminal record is exactly the
 * stale-tail evidence the turn-boundary guards exist to refuse.
 */
export function selectTurnTerminalMarker(
    markers: readonly NativeTurnTerminalMarker[] | null | undefined,
    scope: { turnStartedAt?: number; turnId?: string },
): NativeTurnTerminalMarker | null {
    if (!Array.isArray(markers) || markers.length === 0) return null;

    const wantedTurnId = typeof scope.turnId === 'string' && scope.turnId.trim() ? scope.turnId.trim() : '';
    if (wantedTurnId) {
        // Provider-native identity: exact match, no timestamp heuristic needed.
        for (let i = markers.length - 1; i >= 0; i--) {
            const m = markers[i];
            if (m && m.turnId === wantedTurnId) return m;
        }
        // A turn id was expected but no marker carries it — the turn has not ended.
        return null;
    }

    const startedAt = typeof scope.turnStartedAt === 'number' && Number.isFinite(scope.turnStartedAt) && scope.turnStartedAt > 0
        ? scope.turnStartedAt
        : 0;
    if (!startedAt) return null;

    for (let i = markers.length - 1; i >= 0; i--) {
        const m = markers[i];
        if (!m) continue;
        if (typeof m.receivedAt === 'number' && m.receivedAt >= startedAt) return m;
    }
    return null;
}
