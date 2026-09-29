/**
 * Chat Commands — read side, history-only path of read_chat (no live adapter
 * for the target session): read provider-native history, decide ownership, and
 * either serve it, preserve native-only content, or return the soft
 * `native_history_not_safely_available` pending response.
 *
 * Split out of chat-commands-read.ts (file-size gate).
 */

import type { CommandHelpers, CommandResult } from './handler.js';
import type { ChatMessage } from '../types.js';
import { isNativeSourceCanonicalHistory, readProviderChatHistory } from '../config/provider-native-history.js';
import { LOG } from '../logging/logger.js';
import { getCurrentProviderType } from './chat-commands-shared.js';
import { normalizeReadChatTailLimit } from './read-chat-message-filters.js';
import { decideCliReadChatSource, supportsCliNativeTranscript } from './read-chat-source-decision.js';
import { selectHistoryTurnTerminalMarkers } from './chat-commands-read-turn-markers.js';
import { buildReadChatCommandResult } from './read-chat-presentation.js';
import { recordBoundProviderSessionId, resolveNativeHistoryReadSession } from './chat-commands-read-session-id.js';
import { normalizeAndFilterNativeHistory, readHistorySessionIdFromMessages } from './chat-commands-read-native-normalize.js';
import {
    effectiveReadSessionId,
    hasSafeNativeHistoryMapping,
    readCliProviderNativeHistory,
    sessionSpawnEnvFromAdapter,
    sessionStartedAtMsFromRegistry,
} from './chat-commands-read-native.js';
import type { CliReadChatRequest } from './chat-commands-read-cli.js';

/** Stage output: the native read, its ownership verdict and the source decision. */
interface HistoryOnlyRead {
    agentStr: string;
    supportsNative: boolean;
    history: any;
    historyMessages: ChatMessage[];
    historyProviderSessionId?: string;
    decision: ReturnType<typeof decideCliReadChatSource>;
    historyTurnTerminalMarkers: ReturnType<typeof selectHistoryTurnTerminalMarkers>;
    safeMapping: boolean;
}

// History-only path (no adapter). Same source-decision contract as
// the adapter path above, but with no PTY messages — the machine
// simply decides whether native is usable; if not we return the
// history we have plus a `native_history_not_safely_available`
// error response when the provider requires native source.
export function readChatFromHistoryOnly(h: CommandHelpers, args: any, req: CliReadChatRequest): CommandResult {
    try {
        return buildHistoryOnlyResult(h, args, req, readHistoryOnlyNative(h, args, req));
    } catch (error: any) {
        return { success: false, error: error?.message || `${req.transport} adapter not found` };
    }
}

function readHistoryOnlyNative(h: CommandHelpers, args: any, req: CliReadChatRequest): HistoryOnlyRead {
    const { provider, historySessionId } = req;
    const historyLimit = normalizeReadChatTailLimit(args);
    const agentStr = provider?.type || args?.agentType || getCurrentProviderType(h);
    const targetSid = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const registrySessionWorkspace = targetSid
        ? (h.ctx?.sessionRegistry?.get?.(targetSid) as any)?.workspace
        : undefined;
    const currentSessionWorkspace = typeof (h.currentSession as any)?.workspace === 'string'
        ? (h.currentSession as any).workspace
        : undefined;
    const argsWorkspace = typeof args?.workspace === 'string' ? args.workspace : undefined;
    // When reading a different session (targetSid), prefer that session's registered
    // workspace (or the caller-supplied args.workspace) over the current (coordinator)
    // session's workspace — otherwise the coordinator's cwd shadows the worker's cwd
    // and history lookups find the wrong files.
    const workspace = targetSid
        ? (typeof registrySessionWorkspace === 'string' ? registrySessionWorkspace : argsWorkspace ?? currentSessionWorkspace)
        : (typeof currentSessionWorkspace === 'string' ? currentSessionWorkspace : undefined);
    const intendedWorkspace = argsWorkspace;
    const supportsNative = supportsCliNativeTranscript(agentStr, provider)
        && isNativeSourceCanonicalHistory(provider?.nativeHistory);
    // Post-turn read (no live adapter): getHistorySessionId falls back to
    // the daemon runtime session id when no provider-native id was ever
    // registered. That runtime id is NOT a real provider session, so a
    // native read keyed on it resolves nothing (providerSessionId=null,
    // zero rows) even though the transcript is present in state.db. When
    // this is that runtime fallback (historySessionId === targetSid and no
    // explicit id was passed) and we hold a pin from an earlier bound
    // read, prefer the pin so the query hits the real session. Detects the
    // fallback whether historySessionId reached targetSid via
    // getHistorySessionId's internal fallback (empty args) or the browser
    // explicitly echoed targetSid back (poisoned agy-coordinator
    // subscription / D8 refreshAuthoritativeTail read); a real DISTINCT
    // provider uuid still exact-binds unchanged. See
    // resolveNativeHistoryReadSession.
    const {
        isRuntimeFallback: historySessionIdIsRuntimeFallback,
        pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
        effectiveHistorySessionId: effectiveHistorySessionIdForRead,
    } = resolveNativeHistoryReadSession(args, historySessionId);
    const history = supportsNative
        ? readCliProviderNativeHistory(agentStr, {
            canonicalHistory: provider?.nativeHistory,
            historySessionId: effectiveHistorySessionIdForRead,
            workspace,
            offset: 0,
            limit: historyLimit,
            excludeRecentCount: 0,
            historyBehavior: provider?.historyBehavior,
            scripts: provider?.scripts as any,
            sessionStartedAtMs: sessionStartedAtMsFromRegistry(h, args?.targetSessionId),
            envOverrides: sessionSpawnEnvFromAdapter(h, args?.targetSessionId),
            instanceId: effectiveReadSessionId(h, args?.targetSessionId) || undefined,
            pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
            // Last-resort only when no pin was ever recorded AND the
            // runtime fallback did not resolve a real provider session.
            allowWorkspaceLatestFallback: !pinnedProviderSessionIdForHistory && historySessionIdIsRuntimeFallback,
        })
        : readProviderChatHistory(agentStr, {
            canonicalHistory: provider?.nativeHistory,
            historySessionId,
            workspace,
            offset: 0,
            limit: historyLimit,
            excludeRecentCount: 0,
            historyBehavior: provider?.historyBehavior,
            scripts: provider?.scripts as any,
        });
    const lookup = (history as any)?.lookup === 'workspace' ? 'workspace' : 'session';
    const historyMessages = Array.isArray((history as any)?.messages)
        ? normalizeAndFilterNativeHistory(h, agentStr, args, (history as any).messages as ChatMessage[], (history as any)?.providerSessionId)
        : [];
    const historyProviderSessionId = typeof (history as any)?.providerSessionId === 'string'
        ? (history as any).providerSessionId
        : readHistorySessionIdFromMessages(historyMessages) || effectiveHistorySessionIdForRead;
    // Antigravity coordinator root fix (history-only path — the post-turn
    // read a coordinator actually hits: no live adapter, no pin, agy takes no
    // --session-id so spawnedAtMs is 0 after attach-restore → the read resolves
    // via the workspace-latest fallback, lookup === 'workspace'). The dispatcher
    // STILL surfaces the on-disk conversation uuid there, and flags whether it
    // was OWNER-token-confirmed as this session's own (an exact/birth pick) vs a
    // bare recency pick that could be a co-located replica's conversation.
    //   • Pin the uuid on a workspace-latest read ONLY when owner-confirmed —
    //     recording a replica's uuid would hard-wire the coordinator↔replica
    //     crosswire permanently. Exact/session-scoped reads pin as before.
    //   • Feed the owner-confirmed uuid as the explicit identity to the
    //     safe-mapping check even on a workspace-latest read so the identity
    //     test runs uuid-to-uuid and trusts the assistant on this FIRST read
    //     (else it saw undefined identity → workspace-overlap branch → the PTY
    //     snapshot has only the user echo → fail-closed → regress to pty-parser).
    const historyLookupIsWorkspace = lookup === 'workspace';
    const historyOwnerConfirmed = agentStr === 'antigravity-cli' && (history as any)?.ownerConfirmed === true;
    const historyOwnerConfirmedUuid = historyOwnerConfirmed
        && typeof historyProviderSessionId === 'string' && historyProviderSessionId.trim()
        ? historyProviderSessionId.trim()
        : '';
    // Refresh the pin whenever this path resolves a real provider id — but for
    // a workspace-latest antigravity read, only when the uuid is owner-confirmed.
    if (typeof (history as any)?.providerSessionId === 'string'
        && (history as any).providerSessionId.trim()
        && (!historyLookupIsWorkspace || !agentStr || agentStr !== 'antigravity-cli' || historyOwnerConfirmed)) {
        recordBoundProviderSessionId(h, effectiveReadSessionId(h, targetSid), (history as any).providerSessionId.trim());
    }
    // Use the id we actually read with (pin / real provider id), NOT the
    // raw runtime-fallback historySessionId — otherwise the mapping guard
    // compares the stamped messages' real id against the runtime id and
    // fails closed, undoing the pin reuse.
    const mappingSessionId = historyOwnerConfirmedUuid || effectiveHistorySessionIdForRead;
    // Fail closed for an antigravity workspace-latest read whose uuid was NOT
    // owner-confirmed: it is a bare recency/newest-by-mtime pick that could be
    // a co-located concurrent session's (replica's) conversation. Without an
    // owner-token confirmation we cannot prove ownership, so refuse it rather
    // than surface a sibling's transcript (the coordinator↔replica crosswire
    // guard). This is the same fail-closed default the design study protects —
    // only an owner-confirmed uuid escapes it above.
    const antigravityWorkspaceLatestUnconfirmed = agentStr === 'antigravity-cli'
        && historyLookupIsWorkspace
        && !historyOwnerConfirmedUuid;
    const safeMapping = supportsNative && !antigravityWorkspaceLatestUnconfirmed
        ? hasSafeNativeHistoryMapping({
            historySessionId: historyOwnerConfirmedUuid || (lookup === 'workspace' ? undefined : mappingSessionId),
            providerSessionId: historyOwnerConfirmedUuid || (lookup === 'workspace' ? undefined : historyProviderSessionId),
            workspace,
            nativeMessages: historyMessages,
        })
        : false;
    const trustedExactNativeIdentity = (lookup !== 'workspace' || Boolean(historyOwnerConfirmedUuid))
        && Boolean(mappingSessionId)
        && Boolean(historyProviderSessionId)
        && mappingSessionId === historyProviderSessionId;

    const machineSessionKey = String(
        args?.targetSessionId
        || historyProviderSessionId
        || historySessionId
        || (h.currentSession as any)?.sessionId
        || ''
    );
    const decision = decideCliReadChatSource({
        providerType: agentStr,
        provider,
        sessionId: machineSessionKey,
        nativeHistoryResult: history,
        safeMapping,
        trustedExactNativeIdentity,
        sessionWorkspace: workspace,
        intendedWorkspace,
        ptyMessages: [],
        ptyStatusApprovalOnly: false,
    });

    // (NATIVE-TURN-SIGNAL) marker selection — same rule as the adapter
    // path; see chat-commands-read-turn-markers.ts.
    const historyTurnTerminalMarkers = selectHistoryTurnTerminalMarkers({
        nativeSelected: decision.nativeSelected,
        safeMapping,
        history,
    });
    return {
        agentStr, supportsNative, history, historyMessages, historyProviderSessionId,
        decision, historyTurnTerminalMarkers, safeMapping,
    };
}

function buildHistoryOnlyResult(h: CommandHelpers, args: any, req: CliReadChatRequest, read: HistoryOnlyRead): CommandResult {
    const { provider } = req;
    const {
        agentStr, supportsNative, history, historyMessages, historyProviderSessionId,
        decision, historyTurnTerminalMarkers, safeMapping,
    } = read;
    if (supportsNative && !decision.nativeSelected) {
        // Native-only content preservation (hermes native-only gap).
        // The history-only path has NO PTY transcript (native-only
        // providers suppress PTY bodies), so args.ptyMessages is empty
        // and the machine's pty-parser selection returns NOTHING. But a
        // post-turn / cold read routinely lands here with a REAL,
        // safely-mapped native slice that the source FSM declined only
        // because coverage came back 'partial' (missing sessionStartedAtMs
        // → Booting→Recovering→pty-parser) or a transient shrink looked
        // like a regression. Dropping those rows deletes the assistant
        // answer from read_chat (and the keyed chat lane it feeds). When the native
        // read actually resolved rows for THIS session identity
        // (safeMapping proves ownership: matching historySessionId /
        // providerSessionId + workspace), return them instead of an empty
        // array. This never loosens identity safety — it is gated on the
        // same hasSafeNativeHistoryMapping used everywhere else — and it
        // is scoped to the native-only history path (no PTY to prefer).
        // Truly-empty native reads (historyMessages.length === 0) and
        // unsafe/workspace-aliasing reads (safeMapping === false) still
        // fall through to the soft-pending dead-end below.
        if (safeMapping && historyMessages.length > 0) {
            LOG.debug('Command', `[read_chat] native-only content preserved despite pty-parser selection target=${String(args?.targetSessionId || '')} provider=${agentStr} rows=${historyMessages.length} cause=${decision.decision.transition.cause}`);
            return buildReadChatCommandResult({
                messages: historyMessages,
                status: 'idle',
                messageSource: {
                    ...decision.messageSource,
                    nativeOnlyContentPreserved: true,
                    returnedMessageCount: historyMessages.length,
                },
                transcriptProvenance: {
                    ...decision.messageSource,
                    nativeOnlyContentPreserved: true,
                },
                ...(historyTurnTerminalMarkers !== undefined ? { turnTerminalMarkers: historyTurnTerminalMarkers } : {}),
                ...(typeof (history as any)?.title === 'string' ? { title: (history as any).title } : {}),
                ...(historyProviderSessionId ? { providerSessionId: historyProviderSessionId } : {}),
                ...(((provider?.historyBehavior as any)?.transcriptAuthority === 'provider' || (provider?.historyBehavior as any)?.transcriptAuthority === 'daemon')
                    ? { transcriptAuthority: (provider?.historyBehavior as any).transcriptAuthority }
                    : {}),
                coverage: 'tail',
            }, args, h);
        }
        // Dead-end: we are in the history-only path (no live PTY
        // adapter was found for this target session) AND provider-native
        // history is not safely mappable to the requested session
        // (no historySessionId stamp / workspace mismatch). Previously
        // this returned `success:false`, which the command logger emits
        // at warn level on EVERY poll (handler.ts logCommandEnd) —
        // mesh coordinators poll read_chat continuously, so a worker whose
        // transcript can never be safely mapped produced a 100% warn-log
        // storm with no recovery. Switch to a SOFT response: success with
        // empty messages + pending:true so the coordinator treats it as
        // "no live messages readable yet" rather than a hard failure, and
        // carry the machine-readable reason for debuggability. The normal
        // live-adapter path (above) and the safe-native return (below) are
        // unaffected — this is strictly the both-absent dead end.
        LOG.debug('Command', `[read_chat] soft pending: no live adapter and native history not safely mappable target=${String(args?.targetSessionId || '')} provider=${agentStr} reason=native_history_not_safely_available`);
        return {
            success: true,
            pending: true,
            // Both signals are true here: we reached the history-only path
            // because no live adapter was found (`live_adapter_not_found`),
            // and native history is not safely mappable
            // (`native_history_not_safely_available`).
            reason: 'native_history_not_safely_available',
            reasons: ['live_adapter_not_found', 'native_history_not_safely_available'],
            code: 'native_history_not_safely_available',
            messages: [],
            status: 'idle',
            providerSessionId: historyProviderSessionId,
            messageSource: decision.messageSource,
            transcriptProvenance: decision.messageSource,
        };
    }
    return buildReadChatCommandResult({
        messages: historyMessages,
        status: 'idle',
        messageSource: decision.messageSource,
        transcriptProvenance: decision.messageSource,
        ...(historyTurnTerminalMarkers !== undefined ? { turnTerminalMarkers: historyTurnTerminalMarkers } : {}),
        ...(typeof (history as any)?.title === 'string' ? { title: (history as any).title } : {}),
        ...(historyProviderSessionId ? { providerSessionId: historyProviderSessionId } : {}),
        ...(((provider?.historyBehavior as any)?.transcriptAuthority === 'provider' || (provider?.historyBehavior as any)?.transcriptAuthority === 'daemon')
            ? { transcriptAuthority: (provider?.historyBehavior as any).transcriptAuthority }
            : {}),
        coverage: 'tail',
    }, args, h);
}
