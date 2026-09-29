/**
 * Chat Commands — read side entry points: handleReadChat (a transport
 * dispatcher over chat-commands-read-cli / -history-only / -dom) and
 * handleChatHistory (native-history paging with the load-older PTY fallback).
 * Shared native-read plumbing lives in chat-commands-read-native.ts.
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import { type ProviderModule } from '../providers/contracts.js';
import { isNativeSourceCanonicalHistory, readProviderChatHistory } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import type { ChatMessage } from '../types.js';
import { isActivityChatMessage, normalizeChatMessages } from '../providers/chat-message-normalization.js';
import {
    getCurrentProviderType,
    getTargetedCliAdapter,
    getTargetTransport,
    isCliLikeTransport,
    isExtensionTransport,
    parseMaybeJson,
} from './chat-commands-shared.js';
import { evaluateReadChatNodeWorkspaceScope, resolveTargetSessionActualWorkspace } from './chat-commands-scope.js';
import { readChatFromCliAdapter } from './chat-commands-read-cli.js';
import { readChatFromHistoryOnly } from './chat-commands-read-history-only.js';
import { readChatFromExtension, readChatFromIde } from './chat-commands-read-dom.js';
import { supportsCliNativeTranscript } from './read-chat-source-decision.js';
import { stripMessageSourceAddresses } from '../chat/message-source-address.js';
// (NATIVE-TURN-SIGNAL) turn-terminal marker selection — pure-move extraction
// (file-size gate); logic unchanged, see the module header.
import {
    collapseAdjacentDuplicateChatMessages,
} from './read-chat-presentation.js';
// Read-path session-id resolution + the durable read-pin map — pure-move
// extraction (file-size gate); logic unchanged, see the module header.
import {
    getHistorySessionId,
    recordBoundProviderSessionId,
    resolveNativeHistoryReadSession,
} from './chat-commands-read-session-id.js';
// Native-history identity/normalization — pure-move extraction (file-size gate);
// logic unchanged, see the module header.
import {
    normalizeAndFilterNativeHistory,
    readHistorySessionIdFromMessages,
} from './chat-commands-read-native-normalize.js';
import {
    effectiveReadSessionId, hasSafeNativeHistoryMapping, normalizeComparableWorkspace, readCliProviderNativeHistory,
    sessionSpawnEnvFromAdapter, sessionStartedAtMsFromRegistry,
} from './chat-commands-read-native.js';

/**
 * LOAD-OLDER PTY FALLBACK (zero-bubble fix): when an exact (session-scoped)
 * native-history read comes back empty or unsafe but the session's own PTY
 * transcript has rows, serve those rows as the chat_history page instead of
 * returning []. This is the "Load older" twin of the read_chat STICKY-NATIVE
 * empty-hold fix: the same transient native gap that must not blank the live
 * tail must also not make history paging unrecoverable.
 *
 * Safety is fail-closed, mirroring isCurrentRuntimePtySafelyAttributed: the
 * adapter must be runtime-bound to the session being read (runtimeId match),
 * must not be an inactive/recovery surface, and its working directory must
 * match the session workspace (symlink-safe compare). Anything unproven
 * returns null and the caller keeps the previous empty/native-unavailable
 * response, so untrusted cross-session PTY content is never exposed.
 *
 * Paging contract matches the native path: exclude the rows the live tail
 * already shows (excludeRecentCount), then walk older pages by offset/limit.
 */
function readSafeSessionPtyHistoryPage(args: {
    h: CommandHelpers;
    readArgs: any;
    provider?: ProviderModule;
    sessionWorkspace?: string;
    excludeRecentCount: number;
    offset: number;
    limit: number;
    excludeActivity?: boolean; // chat_history's prose-only default — same contract as the native page
}): { messages: ChatMessage[]; hasMore: boolean } | null {
    const adapter = getTargetedCliAdapter(args.h, args.readArgs, args.provider?.type);
    if (!adapter || typeof adapter.getScriptParsedStatus !== 'function') return null;
    const targetSessionId = effectiveReadSessionId(args.h, args.readArgs?.targetSessionId);
    if (!targetSessionId) return null;
    const runtimeMeta = typeof (adapter as any).getRuntimeMetadata === 'function'
        ? (adapter as any).getRuntimeMetadata()
        : null;
    const runtimeId = typeof runtimeMeta?.runtimeId === 'string' ? runtimeMeta.runtimeId.trim() : '';
    if (!runtimeId || runtimeId !== targetSessionId) return null;
    const surfaceKind = typeof runtimeMeta?.surfaceKind === 'string' ? runtimeMeta.surfaceKind : '';
    if (surfaceKind === 'inactive_record' || surfaceKind === 'recovery_snapshot') return null;
    const sessionWorkspace = normalizeComparableWorkspace(args.sessionWorkspace);
    const adapterWorkspace = normalizeComparableWorkspace(adapter.workingDir);
    if (!sessionWorkspace || !adapterWorkspace || sessionWorkspace !== adapterWorkspace) return null;

    let parsed: any = null;
    try {
        parsed = parseMaybeJson(adapter.getScriptParsedStatus());
    } catch {
        return null;
    }
    const collapsedPtyMessages = collapseAdjacentDuplicateChatMessages(
        normalizeChatMessages(Array.isArray(parsed?.messages) ? parsed.messages as ChatMessage[] : []),
    );
    // Filter BEFORE slicing — paging operates in the delivered message space.
    const ptyMessages = args.excludeActivity === true
        ? collapsedPtyMessages.filter((message) => !isActivityChatMessage(message))
        : collapsedPtyMessages;
    if (ptyMessages.length === 0) return null;
    const end = Math.max(0, ptyMessages.length - args.excludeRecentCount - args.offset);
    const start = Math.max(0, end - args.limit);
    return { messages: ptyMessages.slice(start, end), hasMore: start > 0 };
}

// (A2.2) isNativeHistoryFreshEnough removed. The v1 freshness comparison
// (native_newest vs pty_newest with a 5-minute mtime grace window) was the
// direct cause of the plipping behaviour: PTY arrived every turn so native
// looked stale by default. ChatSourceMachine never compares native vs PTY
// freshness — the lock holds across arbitrary PTY arrival. See
// chat/source-machine.ts for the new semantics.

function toNonNegativeNumber(value: any): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function getCliVisibleTranscriptCount(adapter: any): number {
    if (typeof adapter?.getScriptParsedStatus !== 'function') return 0;
    try {
        const parsed = parseMaybeJson(adapter.getScriptParsedStatus());
        return Array.isArray(parsed?.messages) ? parsed.messages.length : 0;
    } catch {
        return 0;
    }
}

export async function handleChatHistory(h: CommandHelpers, args: any): Promise<CommandResult> {
    // chat_history pages native-history rows straight to the caller without
    // passing the read_chat choke point, so the daemon-internal `_src` reader
    // stamp is dropped here instead (design 2026-09-28 §3.3).
    const result = await readChatHistoryPage(h, args);
    return Array.isArray((result as any)?.messages)
        ? { ...result, messages: stripMessageSourceAddresses((result as any).messages) }
        : result;
}

async function readChatHistoryPage(h: CommandHelpers, args: any): Promise<CommandResult> {
    const { agentType, offset, limit } = args;
    const historySessionId = getHistorySessionId(h, args);
    // Same opt-in contract as read_chat (read-chat-presentation.ts): prose-only
    // default, `includeActivity` keeps activity rows — one toggle, both lanes.
    const includeActivity = args?.includeActivity === true || args?.includeActivity === 'true';
    try {
        const provider = h.getProvider(agentType);
        const agentStr = provider?.type || agentType || getCurrentProviderType(h);
        const transport = getTargetTransport(h, provider);
        const hasExplicitExcludeRecentCount = args?.excludeRecentCount !== undefined && args?.excludeRecentCount !== null;
        let excludeRecentCount = toNonNegativeNumber(args?.excludeRecentCount);
        if (!hasExplicitExcludeRecentCount && isCliLikeTransport(transport)) {
            const adapter = getTargetedCliAdapter(h, args, provider?.type);
            const visibleCount = getCliVisibleTranscriptCount(adapter);
            if (visibleCount > excludeRecentCount) excludeRecentCount = visibleCount;
        }
        // (SEAM) Identity of the oldest message in the browser's live window.
        // Preferred over `excludeRecentCount` — that count is measured in bubble
        // space but subtracted from collapsed-record space, so it overshoots
        // whenever collapse shrinks the set and leaves a silent hole. Absent from
        // older browsers, in which case the count path is used unchanged.
        const excludeFromIdentity = typeof args?.excludeFromIdentity === 'string' && args.excludeFromIdentity
            ? args.excludeFromIdentity
            : undefined;
        const workspace = typeof args?.workspace === 'string'
            ? args.workspace
            : typeof (h.currentSession as any)?.workspace === 'string'
                ? (h.currentSession as any).workspace
                : undefined;
        // Same runtime-fallback poison guard as the subscribe / history-only
        // paths (see resolveNativeHistoryReadSession): getHistorySessionId falls
        // back to targetSessionId (the ADHDev id) for an agy coordinator, and the
        // browser may also send that id back explicitly. Reading native history
        // keyed on it can never exact-bind (it is not the on-disk conv uuid). Drop
        // it here too so the pin / workspace-latest / owner-confirmed resolution
        // engages instead of fail-closing to pty-parser. A real DISTINCT provider
        // uuid is preserved.
        const {
            isRuntimeFallback: historySessionIdIsRuntimeFallback,
            pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
            effectiveHistorySessionId,
        } = resolveNativeHistoryReadSession(args, historySessionId);
        const exactNativeHistoryScope = Boolean(
            (typeof args?.targetSessionId === 'string' && args.targetSessionId.trim())
            || (typeof args?.historySessionId === 'string' && args.historySessionId.trim() && !historySessionIdIsRuntimeFallback)
            || (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
        );
        const result = supportsCliNativeTranscript(agentStr, provider) && isNativeSourceCanonicalHistory(provider?.nativeHistory)
            ? readCliProviderNativeHistory(agentStr, {
                canonicalHistory: provider?.nativeHistory,
                historySessionId: effectiveHistorySessionId,
                workspace,
                offset: offset || 0,
                limit: limit || 30,
                excludeRecentCount,
                excludeFromIdentity,
                historyBehavior: provider?.historyBehavior,
                scripts: provider?.scripts as any,
                sessionStartedAtMs: sessionStartedAtMsFromRegistry(h, args?.targetSessionId),
                envOverrides: sessionSpawnEnvFromAdapter(h, args?.targetSessionId),
                instanceId: effectiveReadSessionId(h, args?.targetSessionId) || undefined,
                pinnedProviderSessionId: pinnedProviderSessionIdForHistory,
                allowWorkspaceLatestFallback: !pinnedProviderSessionIdForHistory && historySessionIdIsRuntimeFallback,
                excludeActivity: !includeActivity,
            })
            : readProviderChatHistory(agentStr, {
                canonicalHistory: provider?.nativeHistory,
                historySessionId,
                workspace,
                offset: offset || 0,
                limit: limit || 30,
                excludeRecentCount,
                excludeFromIdentity,
                historyBehavior: provider?.historyBehavior,
                scripts: provider?.scripts as any,
                excludeActivity: !includeActivity,
            });
        if (supportsCliNativeTranscript(agentStr, provider) && isNativeSourceCanonicalHistory(provider?.nativeHistory)) {
            const lookup = (result as any).lookup === 'workspace' ? 'workspace' : 'session';
            const messages = Array.isArray((result as any).messages)
                ? normalizeAndFilterNativeHistory(h, agentStr, args, (result as any).messages as ChatMessage[], (result as any)?.providerSessionId)
                : [];
            const historyProviderSessionId = typeof (result as any)?.providerSessionId === 'string'
                ? (result as any).providerSessionId
                : readHistorySessionIdFromMessages(messages) || effectiveHistorySessionId;
            // Mirror of the subscribe path (see handleReadChat): an antigravity
            // workspace-latest read still surfaces the on-disk uuid, but that uuid is
            // only safe to persist / trust when it was OWNER-token-confirmed as this
            // session's own — a bare recency pick could be a co-located replica's
            // conversation. Gate the pin and the same-pass identity on ownerConfirmed.
            const resolvedProviderSessionId = typeof (result as any)?.providerSessionId === 'string'
                ? (result as any).providerSessionId.trim()
                : '';
            const resultLookupIsWorkspace = lookup === 'workspace';
            const resultOwnerConfirmed = (result as any)?.ownerConfirmed === true;
            const ownerConfirmedUuid = resultOwnerConfirmed && typeof historyProviderSessionId === 'string' && historyProviderSessionId.trim()
                ? historyProviderSessionId.trim()
                : '';
            if (resolvedProviderSessionId && (!resultLookupIsWorkspace || resultOwnerConfirmed)) {
                recordBoundProviderSessionId(h, effectiveReadSessionId(h, args?.targetSessionId), resolvedProviderSessionId);
            }
            const safeMapping = hasSafeNativeHistoryMapping({
                historySessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : effectiveHistorySessionId),
                providerSessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : historyProviderSessionId),
                workspace,
                nativeMessages: messages,
            });
            const nativeUnsafeMapping = (result as any).source === 'provider-native' && messages.length > 0 && !safeMapping;
            // LOAD-OLDER PTY FALLBACK (zero-bubble fix): an exact session-scoped
            // native read that is empty (the same transient gap that blanks the
            // live tail) or unsafe must not leave "Load older" returning []
            // forever when the session's own PTY transcript has safely
            // attributable rows. Fail-closed inside readSafeSessionPtyHistoryPage
            // (runtime identity + workspace checks), so untrusted cross-session
            // PTY content is never exposed.
            if ((nativeUnsafeMapping || messages.length === 0) && exactNativeHistoryScope) {
                const ptyPage = readSafeSessionPtyHistoryPage({
                    h,
                    readArgs: args,
                    provider,
                    sessionWorkspace: workspace,
                    excludeRecentCount,
                    offset: offset || 0,
                    limit: limit || 30,
                    excludeActivity: !includeActivity,
                });
                if (ptyPage) {
                    return {
                        success: true,
                        messages: ptyPage.messages,
                        hasMore: ptyPage.hasMore,
                        source: 'pty-parser',
                        agent: agentStr,
                    };
                }
            }
            if (nativeUnsafeMapping) {
                return {
                    success: true,
                    messages: [],
                    hasMore: false,
                    source: 'native-unavailable',
                    agent: agentStr,
                };
            }
        }
        return { success: true, ...result, agent: agentStr };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * read_chat — dispatch on the target's transport:
 *   CLI/ACP with a live adapter → chat-commands-read-cli.ts
 *   CLI/ACP without one         → chat-commands-read-history-only.ts
 *   extension / IDE DOM scripts → chat-commands-read-dom.ts
 */
export async function handleReadChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const scopeRefusal = refuseCrossWorktreeRead(h, args);
    if (scopeRefusal) return scopeRefusal;
    const provider = h.getProvider(resolveReadChatProviderHint(h, args));
    const transport = getTargetTransport(h, provider);
    const historySessionId = getHistorySessionId(h, args);

    // PTY / ACP transport: read from adapter
    if (isCliLikeTransport(transport)) {
        const req = { provider, transport, historySessionId };
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        return adapter ? readChatFromCliAdapter(h, args, adapter, req) : readChatFromHistoryOnly(h, args, req);
    }
    // Extension transport: evaluateInSession
    if (isExtensionTransport(transport)) return readChatFromExtension(h, args, { provider, historySessionId });
    // IDE category (default): cdp.evaluate
    return readChatFromIde(h, args, { provider, historySessionId });
}

/**
 * Node scope guard: a daemon hosting a base node + several worktree nodes must
 * not serve worktree A's transcript (or splice sibling worktree turns via the
 * native-history-by-workspace fallback) when a coordinator scoped the read to
 * worktree B. mesh_read_chat always passes the requested node's workspace as
 * args.workspace; refuse a CONFIRMED cross-workspace read rather than mix.
 */
function refuseCrossWorktreeRead(h: CommandHelpers, args: any): CommandResult | null {
    const guardSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!guardSessionId || typeof args?.workspace !== 'string' || !args.workspace.trim()) return null;
    const verdict = evaluateReadChatNodeWorkspaceScope({
        targetSessionId: guardSessionId,
        intendedWorkspace: args.workspace,
        sessionWorkspace: resolveTargetSessionActualWorkspace(h, guardSessionId),
    });
    if (!verdict.scoped) return null;
    LOG.info('Command', `[read_chat] node scope mismatch: session ${guardSessionId} workspace "${verdict.actual}" ≠ requested node workspace "${verdict.intended}" — refusing cross-worktree transcript`);
    return {
        success: false,
        code: 'read_chat_session_node_scope_mismatch',
        error: `Session ${guardSessionId} belongs to a different worktree (workspace "${verdict.actual}") than the requested node (workspace "${verdict.intended}"). Refusing to return a cross-worktree transcript — target the node that owns this session.`,
    };
}

/**
 * Resolve provider in order: explicit agentType/providerType > registered session.
 * Without this fallback, callers that only have a sessionId (e.g. a chat tail
 * controller that just got handed a session ID over WS) get an empty result
 * because getProvider(undefined) returns undefined and the rest of the pipeline
 * bails. This makes the UI look like the session "disappeared".
 */
function resolveReadChatProviderHint(h: CommandHelpers, args: any): string | undefined {
    const explicit: string | undefined = args?.agentType || args?.providerType;
    if (explicit) return explicit;
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (targetSessionId) {
        const session = (h.ctx as any)?.sessionRegistry?.get?.(targetSessionId);
        if (session && typeof session.providerType === 'string') return session.providerType;
    }
    return h.currentSession?.providerType || undefined;
}
