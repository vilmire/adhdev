// ---------------------------------------------------------------------------
// chat-commands-read-turn-markers — (NATIVE-TURN-SIGNAL) read_chat turn-terminal
// marker selection, plus the native-history read helpers whose results feed it.
// Extracted from chat-commands-read.ts as a barrel-preserving pure move
// (file-size gate): the logic is byte-identical to what lived inline at the
// read sites; chat-commands-read.ts keeps its exact public export surface and
// imports these helpers.
//
// THE CONTRACT THESE HELPERS ENFORCE
// ----------------------------------
// The mesh completion poll (pollAssignedTaskTerminalEvidence) prefers the
// provider's OWN turn-terminal record (kimi `turn.ended`, codex `task_complete`)
// over message-shape inference. Those markers are extracted worker-side during
// the native-history read and must ride the read_chat result payload — but ONLY
// when the payload's messages genuinely came from THIS session's safely-
// attributed native transcript:
//
//   - PRESENT (even as an EMPTY array) = "a native read happened and no marker
//     terminates this turn" — the authoritative turn-NOT-ended signal.
//   - ABSENT = "no trustworthy native read on this path" (old daemon / PTY
//     mirror / fail-closed / unsafe aliased mapping) — the poll falls back to
//     its legacy message-shape rules. Never fabricate the array for a read
//     that did not happen; an aliased co-located transcript's terminal record
//     must never end this turn.
// ---------------------------------------------------------------------------

import type { ProviderModule, ProviderScripts } from '../providers/contracts.js';
import { readProviderChatHistory } from '../config/chat-history.js';

// The codex live-workspace native probe. Its result feeds the marker selection
// below (liveSelected) when the machine selects THAT read as the source.
export function readLiveCodexWorkspaceNativeHistory(agentStr: string, args: {
    canonicalHistory?: ProviderModule['canonicalHistory'];
    workspace?: string;
    offset: number;
    limit: number;
    excludeRecentCount: number;
    historyBehavior?: ProviderModule['historyBehavior'];
    scripts?: ProviderScripts;
}): (ReturnType<typeof readProviderChatHistory> & { lookup: 'workspace' }) | null {
    if (agentStr !== 'codex-cli') return null;
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : '';
    if (!workspace) return null;
    const history = readProviderChatHistory(agentStr, {
        canonicalHistory: args.canonicalHistory,
        workspace,
        offset: args.offset,
        limit: args.limit,
        excludeRecentCount: args.excludeRecentCount,
        historyBehavior: args.historyBehavior,
        scripts: args.scripts as any,
    });
    return { ...(history as any), lookup: 'workspace' };
}

// Extract the provider-native turn-terminal markers from a native-history read
// result so they can ride the read_chat result payload to the mesh completion
// poll. Returns an array (possibly EMPTY — "native read happened, no terminal
// marker yet" = turn not ended) ONLY when a native transcript was genuinely
// read on this path (source === 'provider-native'); returns undefined otherwise
// so the field stays ABSENT on PTY/mirror/fail-closed reads — the version-skew
// signal the poll uses to pick its legacy inference fallback. Never fabricate
// the array for a read that did not happen.
export function readChatNativeTurnTerminalMarkers(nativeHistoryResult: any): unknown[] | undefined {
    if (!nativeHistoryResult || nativeHistoryResult.source !== 'provider-native') return undefined;
    return Array.isArray(nativeHistoryResult.turnTerminalMarkers) ? nativeHistoryResult.turnTerminalMarkers : [];
}

// Adapter path: surface the provider-native turn-terminal markers to the mesh
// completion poll. Present ONLY when this session's native transcript was
// genuinely read AND safely attributed (selected as the message source, or
// safe-mapped) — an aliased co-located transcript's terminal record must never
// end this turn. Empty array = "native read happened, turn not ended"; absent =
// "no trustworthy native read" → poll uses legacy fallback.
export function selectAdapterTurnTerminalMarkers(args: {
    nativeSelected: boolean;
    safeMapping: boolean;
    nativeHistory: any;
    liveSelected: unknown[] | undefined;
}): unknown[] | undefined {
    return (args.nativeSelected || args.safeMapping)
        ? (readChatNativeTurnTerminalMarkers(args.nativeHistory) ?? args.liveSelected)
        : args.liveSelected;
}

// History-only path: same rule as the adapter path — surface the markers only
// when this session's native transcript was genuinely read AND safely
// attributed (selected by the machine, or safe-mapped). Empty array = "native
// read happened, turn not ended"; absent = legacy fallback for the poll. The
// soft-pending dead-end on that path is deliberately left without the field
// (native not safely mappable there).
export function selectHistoryTurnTerminalMarkers(args: {
    nativeSelected: boolean;
    safeMapping: boolean;
    history: any;
}): unknown[] | undefined {
    return (args.nativeSelected || args.safeMapping)
        ? readChatNativeTurnTerminalMarkers(args.history)
        : undefined;
}
