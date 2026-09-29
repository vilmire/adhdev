/**
 * Chat Commands — read side, live CLI/ACP adapter path of read_chat: parse the
 * adapter snapshot, read + safety-check provider-native history, drive the
 * chat-source machine (plus the codex live-workspace probe and unsafe-native
 * daemon mirror fallbacks), reconcile the status, and build the result.
 *
 * Split out of chat-commands-read.ts (file-size gate).
 */
import type { CliAdapter } from '../cli-adapter-types.js';
import type { ChatMessage } from '../types.js';
import { flattenContent, type ProviderModule } from '../providers/contracts.js';
import { readChatHistory, isNativeSourceCanonicalHistory } from '../config/chat-history.js';
import {
    normalizeChatMessages, filterUserFacingChatMessages, hasTrailingToolActivityAfterFinalAssistant,
} from '../providers/chat-message-normalization.js';
import { LOG } from '../logging/logger.js';
import { nativeHistoryObservedModel } from '../providers/native-history/observed-model.js';
import type { CommandHelpers, CommandResult } from './handler.js';
import {
    HOT_TAIL_MIN_LIMIT, normalizeComparableWorkspace, effectiveReadSessionId,
    hasSafeNativeHistoryMapping, readCliProviderNativeHistory, sessionSpawnEnvFromAdapter,
    sessionStartedAtMsFromRegistry,
} from './chat-commands-read-native.js';
import {
    type RuntimeChatMessageMerger, getCurrentProviderType, getTargetInstance, parseMaybeJson,
} from './chat-commands-shared.js';
import { normalizeReadChatTailLimit } from './read-chat-message-filters.js';
import { decideCliReadChatSource, supportsCliNativeTranscript } from './read-chat-source-decision.js';
import {
    readChatNativeTurnTerminalMarkers, readLiveCodexWorkspaceNativeHistory,
    selectAdapterTurnTerminalMarkers,
} from './chat-commands-read-turn-markers.js';
import {
    buildReadChatCommandResult, collapseAdjacentDuplicateChatMessages,
    finalizeStreamingMessagesWhenIdle, hasNonEmptyModalButtons,
} from './read-chat-presentation.js';
import {
    getExplicitHistorySessionId, recordBoundProviderSessionId, resolveCliNativeHistorySessionId,
    resolveNativeHistoryReadSession, shouldSkipLiveCliNativeHistoryWithoutProviderSession,
} from './chat-commands-read-session-id.js';
import {
    normalizeAndFilterNativeHistory, readHistorySessionIdFromMessages,
} from './chat-commands-read-native-normalize.js';

/**
 * Codex-only unsafe-native fallback: when the primary native fetch produced
 * unsafe-mapping data, v1 attempted to recover by reading exact runtime
 * mirror messages, runtime input ACK messages, or by trusting the current-
 * runtime PTY when safely attributed. None of this is the machine's
 * responsibility — the machine already decided pty-parser. This helper
 * preserves the daemon-side message selection and annotates messageSource.
 */
export function applyUnsafeNativeDaemonFallback(args: {
    providerType: string;
    adapter: CliAdapter;
    helpers: CommandHelpers;
    readChatArgs: any;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    ptyMessages: ChatMessage[];
    nativeHistoryLimit: number;
    provider?: ProviderModule;
    messageSourceRef: { set(value: Record<string, unknown>): void; get(): Record<string, unknown> };
    apply(selection: {
        messages: ChatMessage[];
        transcriptAuthority?: 'provider' | 'daemon';
        coverage?: 'full' | 'tail' | 'current-turn';
        status?: string;
    }): void;
    activeModal: unknown;
    returnedStatus: string;
    coverage?: 'full' | 'tail' | 'current-turn';
}): void {
    if (args.adapter.cliType !== 'codex-cli') {
        // Only codex-cli had v1 daemon mirror recovery. Other providers skip.
        return;
    }
    const ms = args.messageSourceRef.get();
    const fallbackReason = typeof ms.fallbackReason === 'string' ? ms.fallbackReason : '';
    if (!isUnsafeNativeTranscriptFallback(fallbackReason)) {
        return;
    }
    const safeCurrentRuntimePtyMessages = isCurrentRuntimePtySafelyAttributed({
        adapter: args.adapter,
        helpers: args.helpers,
        readChatArgs: args.readChatArgs,
        sessionWorkspace: args.sessionWorkspace,
        intendedWorkspace: args.intendedWorkspace,
        ptyMessages: args.ptyMessages,
    });
    if (safeCurrentRuntimePtyMessages) {
        args.apply({
            messages: args.ptyMessages,
            transcriptAuthority: 'daemon',
            coverage: args.coverage || 'current-turn',
            status: args.returnedStatus,
        });
        const next = { ...ms, selectedDaemonSource: 'current-runtime-pty', transcriptAuthority: 'daemon', runtimeMappingSafe: true };
        args.messageSourceRef.set(next);
        return;
    }
    const safeRuntimeAckMessages = selectRuntimeInputAckMessages(args.ptyMessages);
    if (safeRuntimeAckMessages.length > 0) {
        args.apply({
            messages: safeRuntimeAckMessages,
            transcriptAuthority: 'daemon',
            coverage: 'tail',
            status: coerceUnsafeNativeFallbackStatus(args.returnedStatus, args.activeModal),
        });
        const next = { ...ms, ptyStatusApprovalOnly: true };
        args.messageSourceRef.set(next);
        return;
    }
    const exactRuntimeMirrorMessages = readExactRuntimeMirrorMessages({
        providerType: args.providerType,
        targetSessionId: typeof args.readChatArgs?.targetSessionId === 'string' ? args.readChatArgs.targetSessionId : undefined,
        currentSessionId: typeof (args.helpers.currentSession as any)?.sessionId === 'string' ? (args.helpers.currentSession as any).sessionId : undefined,
        tailLimit: args.nativeHistoryLimit,
        historyBehavior: args.provider?.historyBehavior,
    });
    if (exactRuntimeMirrorMessages.length > 0) {
        args.apply({
            messages: exactRuntimeMirrorMessages,
            transcriptAuthority: 'daemon',
            coverage: 'tail',
            status: coerceUnsafeNativeFallbackStatus(args.returnedStatus, args.activeModal),
        });
        const next = { ...ms, selectedDaemonSource: 'exact-runtime-mirror', transcriptAuthority: 'daemon', ptyStatusApprovalOnly: true };
        args.messageSourceRef.set(next);
        return;
    }
    // No daemon mirror available — keep PTY messages as-is (still pty-parser
    // selection); just coerce status for waiting_approval consistency.
    args.apply({
        messages: args.ptyMessages,
        coverage: args.coverage,
        status: coerceUnsafeNativeFallbackStatus(args.returnedStatus, args.activeModal),
    });
    const next = { ...ms, ptyStatusApprovalOnly: true };
    args.messageSourceRef.set(next);
}

// (A2.2) buildNativeHistoryFallbackReason removed. ChatSourceMachine emits a
// ChatSourceTransitionCause; causeToLegacyFallbackReason maps it back to the
// v1 vocabulary for response compatibility. A3 deletes the v1 vocabulary
// entirely and surfaces stateTransition/lockState directly.

export function isUnsafeNativeTranscriptFallback(reason?: string): boolean {
    const value = String(reason || '').trim();
    return value.startsWith('native_history_unavailable')
        || value === 'native_history_not_safely_mapped'
        || value === 'native_history_stale'
        || value === 'native_history_partial';
}

function coerceUnsafeNativeFallbackStatus(status: string, activeModal: unknown): string {
    if (status === 'waiting_approval' && activeModal) return status;
    return 'idle';
}

function isRuntimeInputAckMessage(message: ChatMessage | undefined): boolean {
    if (!message || typeof message !== 'object') return false;
    const role = String((message as any).role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'human') return false;
    const meta = (message as any).meta;
    return !!meta && typeof meta === 'object' && !Array.isArray(meta) && meta.runtimeInputAck === true;
}

function selectRuntimeInputAckMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter((message) => isRuntimeInputAckMessage(message));
}

function readExactRuntimeMirrorMessages(args: {
    providerType: string;
    targetSessionId?: string;
    currentSessionId?: string;
    tailLimit: number;
    historyBehavior?: ProviderModule['historyBehavior'];
}): ChatMessage[] {
    const targetSessionId = String(args.targetSessionId || '').trim();
    const currentSessionId = String(args.currentSessionId || '').trim();
    if (!targetSessionId || targetSessionId !== currentSessionId) return [];

    const history = readChatHistory(
        args.providerType,
        0,
        Math.max(args.tailLimit || 0, HOT_TAIL_MIN_LIMIT),
        targetSessionId,
        0,
        args.historyBehavior,
    );
    return normalizeChatMessages((history.messages || []) as ChatMessage[])
        .filter((message) => {
            const historySessionId = String((message as any).historySessionId || '').trim();
            const instanceId = String((message as any).instanceId || '').trim();
            return historySessionId === targetSessionId || instanceId === targetSessionId;
        });
}
export function isCurrentRuntimePtySafelyAttributed(args: {
    adapter: CliAdapter;
    helpers: CommandHelpers;
    readChatArgs: any;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
    ptyMessages: ChatMessage[];
}): boolean {
    if (args.adapter.cliType !== 'codex-cli') return false;
    if (!Array.isArray(args.ptyMessages) || args.ptyMessages.length === 0) return false;
    const targetSessionId = typeof args.readChatArgs?.targetSessionId === 'string'
        ? args.readChatArgs.targetSessionId.trim()
        : '';
    const currentSession = args.helpers.currentSession as any;
    const currentSessionId = typeof currentSession?.sessionId === 'string'
        ? currentSession.sessionId.trim()
        : '';
    if (!targetSessionId || !currentSessionId || targetSessionId !== currentSessionId) return false;

    const runtimeMeta = typeof (args.adapter as any).getRuntimeMetadata === 'function'
        ? (args.adapter as any).getRuntimeMetadata()
        : null;
    const runtimeId = typeof runtimeMeta?.runtimeId === 'string' ? runtimeMeta.runtimeId.trim() : '';
    if (!runtimeId || runtimeId !== targetSessionId) return false;
    const surfaceKind = typeof runtimeMeta?.surfaceKind === 'string' ? runtimeMeta.surfaceKind : '';
    if (surfaceKind === 'inactive_record' || surfaceKind === 'recovery_snapshot') return false;

    const sessionWorkspace = normalizeComparableWorkspace(args.sessionWorkspace);
    const adapterWorkspace = normalizeComparableWorkspace(args.adapter.workingDir);
    if (!sessionWorkspace || !adapterWorkspace || sessionWorkspace !== adapterWorkspace) return false;
    const intendedWorkspace = normalizeComparableWorkspace(args.intendedWorkspace);
    if (intendedWorkspace && intendedWorkspace !== sessionWorkspace) return false;

    const registryEntry = args.helpers.ctx?.sessionRegistry?.get?.(targetSessionId) as any;
    const registryInstanceKey = typeof registryEntry?.adapterKey === 'string' && registryEntry.adapterKey.trim()
        ? registryEntry.adapterKey.trim()
        : typeof registryEntry?.instanceKey === 'string' && registryEntry.instanceKey.trim()
            ? registryEntry.instanceKey.trim()
            : '';
    if (registryInstanceKey) {
        const targetInstance = args.helpers.ctx?.instanceManager?.getInstance?.(registryInstanceKey);
        if (targetInstance) {
            const instanceType = typeof (targetInstance as any).type === 'string' ? (targetInstance as any).type : '';
            if (instanceType && instanceType !== args.adapter.cliType) return false;
        }
    }

    return true;
}

export function isGeneratingLikeStatus(status: unknown): boolean {
    return status === 'generating' || status === 'streaming' || status === 'no_progress' || status === 'long_generating' || status === 'starting';
}

function hasVisibleAssistantMessage(messages: unknown[] | undefined): boolean {
    if (!Array.isArray(messages)) return false;
    return messages.some((message: any) => {
        if (!message || message.role !== 'assistant') return false;
        const kind = typeof message.kind === 'string' ? message.kind : 'standard';
        if (kind !== 'standard') return false;
        return String(message.content || '').trim().length > 0;
    });
}

export function hasFinalVisibleAssistantMessage(messages: unknown[] | undefined): boolean {
    if (!Array.isArray(messages)) return false;
    const visible = filterUserFacingChatMessages(messages as ChatMessage[]);
    const last = visible[visible.length - 1] as ChatMessage | undefined;
    const role = typeof last?.role === 'string' ? last.role.trim().toLowerCase() : '';
    const content = last ? flattenContent(last.content).trim() : '';
    return (role === 'assistant' || role === 'model') && content.length > 0;
}

function shouldTrustCliAdapterTerminalStatus(parsedStatus: unknown, activeModal: unknown, adapter: CliAdapter, adapterStatus: any): boolean {
    if (!isGeneratingLikeStatus(parsedStatus)) return false;
    if (hasNonEmptyModalButtons(activeModal)) return false;
    const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
    if (adapterRawStatus !== 'idle') return false;
    if (typeof adapter.isProcessing === 'function' && adapter.isProcessing()) return false;
    return true;
}

export function normalizeCliReadChatStatus(parsedStatus: unknown, activeModal: unknown, adapter: CliAdapter, adapterStatus: any, parsedMessages?: unknown[]): string {
    const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
    if (adapterRawStatus === 'starting'
        && isGeneratingLikeStatus(parsedStatus)
        && !hasNonEmptyModalButtons(activeModal)
        && Array.isArray(parsedMessages)
        && parsedMessages.length === 0
        && Array.isArray(adapterStatus?.messages)
        && adapterStatus.messages.length === 0
        && !(typeof adapter.isProcessing === 'function' && adapter.isProcessing())) {
        return 'starting';
    }
    if (
        isGeneratingLikeStatus(adapterRawStatus)
        && parsedStatus === 'idle'
        && !hasNonEmptyModalButtons(activeModal)
        && !hasVisibleAssistantMessage(parsedMessages)
    ) {
        return adapterRawStatus;
    }
    if (shouldTrustCliAdapterTerminalStatus(parsedStatus, activeModal, adapter, adapterStatus)) return 'idle';
    return typeof parsedStatus === 'string' && parsedStatus.trim() ? parsedStatus : 'idle';
}

// ─────────────────────────────────────────────────────────────────────────
// read_chat — live CLI/ACP adapter path, as a pipeline of named stages:
//   readCliAdapterSnapshot → readCliNativeHistoryForReadChat
//   → selectCliReadChatMessages → reconcileNativeFinalAssistantStatus
//   → buildCliReadChatResult
// ─────────────────────────────────────────────────────────────────────────

type Coverage = 'full' | 'tail' | 'current-turn';

/** What handleReadChat resolved before choosing the CLI adapter path. */
export interface CliReadChatRequest {
    provider: ProviderModule | undefined;
    transport: string | null;
    historySessionId: string | undefined;
}

/** Stage 1 output: the adapter's parsed snapshot plus the read's workspace scope. */
interface CliAdapterSnapshot {
    parsedRecord: Record<string, any>;
    adapterStatus: any;
    title?: string;
    providerSessionId?: string;
    transcriptAuthority?: 'provider' | 'daemon';
    coverage?: Coverage;
    activeModal: unknown;
    returnedStatus: string;
    returnedMessages: ChatMessage[];
    providerType: string;
    sessionWorkspace?: string;
    intendedWorkspace?: string;
}

/** Stage 2 output: the provider-native read and its ownership verdict. */
interface CliNativeRead {
    supportsNative: boolean;
    agentStr: string;
    nativeHistoryLimit: number;
    nativeHistoryReadSessionId?: string;
    skipLiveNativeHistoryWithoutProviderSession: boolean;
    nativeHistory: any | null;
    nativeHistoryError?: unknown;
    historyProviderSessionId?: string;
    safeMapping: boolean;
    trustedExactNativeIdentity: boolean;
}

/** Stage 3 output (mutated by the fallbacks and stage 4). */
interface CliReadChatSelection {
    messages: ChatMessage[];
    providerSessionId?: string;
    transcriptAuthority?: 'provider' | 'daemon';
    coverage?: Coverage;
    status: string;
    messageSource: Record<string, unknown>;
    primaryNativeSelected: boolean;
    /** (NATIVE-TURN-SIGNAL) Markers captured from the codex live-workspace
     *  native probe when THAT read is the one the machine selects (the
     *  primary nativeHistory may be unread/unsafe in that branch). */
    liveSelectedNativeTurnTerminalMarkers?: unknown[];
}

export function readChatFromCliAdapter(
    h: CommandHelpers,
    args: any,
    adapter: CliAdapter,
    req: CliReadChatRequest,
): CommandResult {
    LOG.debug('Command', `[read_chat] ${req.transport} adapter: ${adapter.cliType}`);
    const snapshot = readCliAdapterSnapshot(h, args, adapter, req);
    if ('error' in snapshot) return snapshot.error;
    const native = readCliNativeHistoryForReadChat(h, args, adapter, req, snapshot);
    const selection = selectCliReadChatMessages(h, args, adapter, req, snapshot, native);
    reconcileNativeFinalAssistantStatus(selection, snapshot);
    LOG.debug('Command', `[read_chat] cli-like parsed provider=${adapter.cliType} target=${String(args?.targetSessionId || '')} adapterStatus=${String(snapshot.adapterStatus.status || '')} parsedStatus=${String(snapshot.parsedRecord.status || '')} parsedMsgCount=${snapshot.parsedRecord.messages.length} returnedMsgCount=${snapshot.returnedMessages.length}`);
    return buildCliReadChatResult(h, args, adapter, req, snapshot, native, selection);
}

/** Stage 1 — parse the adapter's current snapshot and resolve the workspace scope. */
function readCliAdapterSnapshot(
    h: CommandHelpers,
    args: any,
    adapter: CliAdapter,
    req: CliReadChatRequest,
): CliAdapterSnapshot | { error: CommandResult } {
    if (typeof adapter.getScriptParsedStatus !== 'function') {
        return { error: { success: false, error: `${req.transport} adapter parseSession unavailable` } };
    }
    let parsedStatus: any = null;
    try {
        parsedStatus = parseMaybeJson(adapter.getScriptParsedStatus());
    } catch (error: any) {
        return { error: { success: false, error: error?.message || String(error) } };
    }
    const parsedRecord = parsedStatus && typeof parsedStatus === 'object'
        ? parsedStatus as Record<string, any>
        : null;
    if (!parsedRecord || !Array.isArray(parsedRecord.messages)) {
        return { error: { success: false, error: `${req.transport} parser did not return messages` } };
    }
    const adapterStatus = typeof adapter.getStatus === 'function'
        ? adapter.getStatus()
        : {};
    const activeModal = parsedRecord.activeModal ?? parsedRecord.modal ?? null;
    const returnedStatus = normalizeCliReadChatStatus(parsedRecord.status, activeModal, adapter, adapterStatus, parsedRecord.messages);
    const runtimeMessageMerger = getTargetInstance(h, args) as RuntimeChatMessageMerger | null;
    const parsedMessages = collapseAdjacentDuplicateChatMessages(
        finalizeStreamingMessagesWhenIdle(parsedRecord.messages as ChatMessage[], returnedStatus),
    );
    const returnedMessages = runtimeMessageMerger?.category === 'cli'
        && runtimeMessageMerger.type === adapter.cliType
        && typeof runtimeMessageMerger.mergeRuntimeChatMessages === 'function'
        ? runtimeMessageMerger.mergeRuntimeChatMessages(parsedMessages)
        : parsedMessages;
    const targetSid = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const registryWs = targetSid
        ? (h.ctx?.sessionRegistry?.get?.(targetSid) as any)?.workspace
        : undefined;
    const currentSessionWs = typeof (h.currentSession as any)?.workspace === 'string'
        ? (h.currentSession as any).workspace
        : typeof adapter.workingDir === 'string'
            ? adapter.workingDir
            : undefined;
    return {
        parsedRecord,
        adapterStatus,
        title: typeof parsedRecord.title === 'string' ? parsedRecord.title : undefined,
        providerSessionId: typeof parsedRecord.providerSessionId === 'string'
            ? parsedRecord.providerSessionId
            : undefined,
        transcriptAuthority: parsedRecord.transcriptAuthority === 'provider' || parsedRecord.transcriptAuthority === 'daemon'
            ? parsedRecord.transcriptAuthority
            : undefined,
        coverage: parsedRecord.coverage === 'full' || parsedRecord.coverage === 'tail' || parsedRecord.coverage === 'current-turn'
            ? parsedRecord.coverage
            : undefined,
        activeModal,
        returnedStatus,
        returnedMessages,
        providerType: req.provider?.type || adapter.cliType,
        sessionWorkspace: targetSid
            ? (typeof registryWs === 'string' ? registryWs : (typeof args?.workspace === 'string' ? args.workspace : undefined) ?? currentSessionWs)
            : currentSessionWs,
        intendedWorkspace: typeof args?.workspace === 'string' ? args.workspace : undefined,
    };
}

/**
 * Stage 2 — read provider-native history for this session and decide whether
 * it is safely this session's own (the observation the source machine sees).
 *
 * Chat source decision via ChatSourceMachine (A2 big-bang) replaced the
 * ~300-line if-ladder that mixed source decision with native fetch, anchor
 * mutation, and runtime mirror selection. The machine decides only between
 * native-history and pty-parser; downstream selection of which message array
 * to surface happens in stage 3. Behavioural changes vs v1:
 *   - No more nativeHistoryAnchoredAt mutation on the adapter. Lock state
 *     lives in CHAT_SOURCE_REGISTRY keyed by (providerType, sessionId).
 *   - No PTY-vs-native freshness comparison. The lock holds across arbitrary
 *     PTY arrival; only native regression / unavailability unlocks. This is
 *     the plipping fix.
 *   - 6 trigger strings (native_history_partial / _stale /
 *     _not_safely_mapped / _empty / _error / _unavailable) collapse to 3
 *     events with diagnostic causes preserved and mapped back to legacy
 *     fallbackReason strings for response compatibility.
 *   - Codex live-workspace native probe and unsafe-native daemon mirror
 *     fallbacks are preserved as additional input rounds to the machine; they
 *     were never the source decision itself, they were retries.
 */
function readCliNativeHistoryForReadChat(
    h: CommandHelpers,
    args: any,
    adapter: CliAdapter,
    req: CliReadChatRequest,
    snap: CliAdapterSnapshot,
): CliNativeRead {
    const { provider, historySessionId } = req;
    const supportsNative = supportsCliNativeTranscript(snap.providerType, provider)
        && isNativeSourceCanonicalHistory(provider?.nativeHistory);
    const agentStr = provider?.type || args?.agentType || getCurrentProviderType(h, adapter.cliType);
    const workspace = snap.sessionWorkspace;
    const nativeHistoryLimit = Math.max(
        normalizeReadChatTailLimit(args) || 0,
        snap.returnedMessages.length,
        HOT_TAIL_MIN_LIMIT,
    );
    const nativeHistorySessionId = supportsNative
        ? resolveCliNativeHistorySessionId(args, historySessionId, snap.providerSessionId)
        : undefined;
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const skipLiveNativeHistoryWithoutProviderSession = shouldSkipLiveCliNativeHistoryWithoutProviderSession({
        adapter,
        providerType: snap.providerType,
        readChatArgs: args,
        nativeHistorySessionId,
        parsedProviderSessionId: snap.providerSessionId,
    });
    const nativeHistoryReadSessionId = skipLiveNativeHistoryWithoutProviderSession
        ? undefined
        : nativeHistorySessionId;
    const exactNativeHistoryScope = Boolean(
        (typeof args?.historySessionId === 'string' && args.historySessionId.trim())
        || (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
        || snap.providerSessionId
        || (nativeHistoryReadSessionId && nativeHistoryReadSessionId !== targetSessionId)
        || ((h.currentSession as any)?.sessionId === args?.targetSessionId && typeof (h.currentSession as any)?.providerSessionId === 'string' && (h.currentSession as any).providerSessionId.trim())
    );
    const readOpts = {
        canonicalHistory: provider?.nativeHistory,
        workspace,
        offset: 0,
        limit: nativeHistoryLimit,
        excludeRecentCount: 0,
        historyBehavior: provider?.historyBehavior,
        scripts: provider?.scripts as any,
        excludeInProgressTurn: snap.returnedStatus === 'waiting_approval',
        envOverrides: sessionSpawnEnvFromAdapter(h, args?.targetSessionId),
        instanceId: effectiveReadSessionId(h, args?.targetSessionId) || undefined,
    };

    // 1. Fetch native history (or skip if provider does not support it).
    let nativeHistory: any | null = null;
    let nativeHistoryError: unknown | undefined;
    if (supportsNative) {
        // Runtime-fallback → pin substitution (see resolveNativeHistoryReadSession):
        // nativeHistoryReadSessionId is the bare runtime/session id when no explicit
        // provider handle was supplied and none was parsed (antigravity takes no
        // --session-id, so its this.providerSessionId stays empty and
        // getHistorySessionId falls back to targetSessionId). That runtime id is not
        // the on-disk conversations/<uuid>.db name, so a native read keyed on it can
        // never exact-bind and falls to the recency heuristic — which drops an idle
        // (or restored, spawnedAtMs=0) session's own store. Prefer a pin (a real
        // conversation id a prior read resolved for THIS session, now also persisted
        // across restart) over the runtime id, else drop the runtime id so
        // readCliProviderNativeHistory's pin / workspace-latest paths can engage.
        // Mirrors the handleChatHistory path's established handling.
        const {
            pinnedProviderSessionId: pinnedProviderSessionIdForRead,
            effectiveHistorySessionId: effectiveNativeReadSessionId,
        } = resolveNativeHistoryReadSession(args, nativeHistoryReadSessionId);
        try {
            nativeHistory = readCliProviderNativeHistory(agentStr, {
                ...readOpts,
                historySessionId: effectiveNativeReadSessionId,
                sessionStartedAtMs: sessionStartedAtMsFromRegistry(h, args?.targetSessionId),
                pinnedProviderSessionId: pinnedProviderSessionIdForRead,
                // Last-resort only when no pin was ever recorded for this session;
                // the downstream workspace-overlap safety gate still filters an
                // aliased session out.
                allowWorkspaceLatestFallback: !pinnedProviderSessionIdForRead,
            });
            maybePinResolvedProviderSessionId(h, targetSessionId, nativeHistory);
        } catch (error: any) {
            nativeHistoryError = error;
            nativeHistory = null;
        }
    }

    // 2. Compute safeMapping with the same rules the v1 code used so the
    //    machine sees the same observation it always would have.
    let nativeMessages: ChatMessage[] = nativeHistory && Array.isArray(nativeHistory.messages)
        ? normalizeAndFilterNativeHistory(h, agentStr, args, nativeHistory.messages as ChatMessage[], nativeHistory.providerSessionId)
        : [];
    const sessionStartedAtMs = sessionStartedAtMsFromRegistry(h, args?.targetSessionId);
    let historyProviderSessionId = typeof nativeHistory?.providerSessionId === 'string'
        ? nativeHistory.providerSessionId
        : readHistorySessionIdFromMessages(nativeMessages) || nativeHistoryReadSessionId || historySessionId;
    let lookup = nativeHistory?.lookup === 'workspace' ? 'workspace' : 'session';
    // Owner-confirmed uuid for THIS read (antigravity): the dispatcher resolved a
    // conversation and confirmed it is this session's own via the owner token
    // (exact uuid bind, or a spawn-floor/birth pick) — NOT a bare recency pick.
    // When present it is the authoritative conversation identity for the
    // same-pass safe-mapping check below, even on a workspace-latest
    // (lookup === 'workspace') read where the coordinator has no pin. A
    // coordinator session hits this path (agy takes no --session-id,
    // spawnedAtMs=0 after attach-restore); without it the safe-mapping check saw
    // undefined identity → workspace-overlap branch → the PTY snapshot has only
    // the user echo → fail-closed → regress to pty-parser (user-echo only).
    // Trusting the owner-confirmed uuid lets the assistant answer reach the
    // dashboard on the FIRST read.
    const ownerConfirmedUuid = adapter.cliType === 'antigravity-cli'
        && (nativeHistory as any)?.ownerConfirmed === true
        && typeof historyProviderSessionId === 'string'
        && historyProviderSessionId.trim()
        ? historyProviderSessionId.trim()
        : '';
    const nativeHistorySessionForMapping = ownerConfirmedUuid
        ? ownerConfirmedUuid
        : adapter.cliType === 'antigravity-cli'
            && historyProviderSessionId
            && nativeHistoryReadSessionId
            && historyProviderSessionId !== nativeHistoryReadSessionId
            ? undefined
            : nativeHistoryReadSessionId;
    // For an owner-confirmed uuid, feed the uuid as the explicit session identity
    // to the safe-mapping check even on a workspace-latest read so the
    // session-branch identity test runs uuid-to-uuid (messages carry the uuid as
    // historySessionId) and trusts the assistant in this same pass.
    let safeMapping = supportsNative && nativeHistory
        ? hasSafeNativeHistoryMapping({
            historySessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : nativeHistorySessionForMapping),
            providerSessionId: ownerConfirmedUuid || (lookup === 'workspace' ? undefined : historyProviderSessionId || snap.providerSessionId),
            workspace,
            nativeMessages,
            ptyMessages: snap.returnedMessages,
            requireWorkspaceContentOverlap: lookup === 'workspace' && !exactNativeHistoryScope && !ownerConfirmedUuid,
        })
        : false;
    if (skipLiveNativeHistoryWithoutProviderSession && (!safeMapping || snap.returnedMessages.length === 0)) {
        nativeHistory = null;
        nativeMessages = [];
        historyProviderSessionId = undefined;
        lookup = 'session';
        safeMapping = false;
    }
    const mayRetryUnsafeAutoDetectedCodexSession = adapter.cliType === 'codex-cli'
        && !getExplicitHistorySessionId(args)
        && Boolean(sessionStartedAtMs && sessionStartedAtMs > 0)
        && !skipLiveNativeHistoryWithoutProviderSession
        && !safeMapping;
    if (mayRetryUnsafeAutoDetectedCodexSession) {
        try {
            nativeHistory = readCliProviderNativeHistory(agentStr, {
                ...readOpts,
                historySessionId: undefined,
                sessionStartedAtMs,
            });
            nativeHistoryError = undefined;
            nativeMessages = nativeHistory && Array.isArray(nativeHistory.messages)
                ? normalizeAndFilterNativeHistory(h, agentStr, args, nativeHistory.messages as ChatMessage[], nativeHistory.providerSessionId)
                : [];
            historyProviderSessionId = typeof nativeHistory?.providerSessionId === 'string'
                ? nativeHistory.providerSessionId
                : readHistorySessionIdFromMessages(nativeMessages);
            lookup = nativeHistory?.lookup === 'workspace' ? 'workspace' : 'session';
            safeMapping = supportsNative && nativeHistory
                ? hasSafeNativeHistoryMapping({
                    historySessionId: lookup === 'workspace' ? undefined : historyProviderSessionId,
                    providerSessionId: lookup === 'workspace' ? undefined : historyProviderSessionId,
                    workspace,
                    nativeMessages,
                    ptyMessages: snap.returnedMessages,
                    requireWorkspaceContentOverlap: lookup === 'workspace' && !exactNativeHistoryScope,
                })
                : false;
        } catch (error: any) {
            nativeHistoryError = error;
            nativeHistory = null;
            nativeMessages = [];
            historyProviderSessionId = undefined;
            safeMapping = false;
        }
    }
    return {
        supportsNative,
        agentStr,
        nativeHistoryLimit,
        nativeHistoryReadSessionId,
        skipLiveNativeHistoryWithoutProviderSession,
        nativeHistory,
        nativeHistoryError,
        historyProviderSessionId,
        safeMapping,
        trustedExactNativeIdentity: lookup !== 'workspace'
            && Boolean(nativeHistoryReadSessionId)
            && Boolean(historyProviderSessionId)
            && nativeHistoryReadSessionId === historyProviderSessionId,
    };
}

/**
 * Refresh the per-mesh-session pin whenever a native read resolves a concrete
 * provider-native session id. A later post-turn read (live binding gone) can
 * then reuse it instead of fail-closing. Only a non-empty resolved id updates
 * the pin; an empty result never clears a known one.
 *
 * Pin gating for the antigravity workspace-latest branch: a coordinator session
 * has no pin (agy takes no --session-id) and spawnedAtMs=0 after
 * attach-restore, so the read resolves via the workspace-latest fallback
 * (lookup === 'workspace') rather than an exact bind. The dispatcher STILL
 * surfaces the on-disk conversation uuid there — but that uuid is only safe to
 * persist as a pin when it was OWNER-token-confirmed (exact uuid bind, or a
 * spawn-floor/birth pick). A bare recency/newest-by-mtime pick
 * (ownerConfirmed=false) could be a co-located replica's conversation, so
 * recording it would hard-wire the coordinator↔replica crosswire permanently —
 * never pin that. Exact-bind / session-scoped reads (lookup === 'session') are
 * already owner-scoped by construction, so keep pinning them as before.
 */
function maybePinResolvedProviderSessionId(h: CommandHelpers, targetSessionId: string, nativeHistory: any): void {
    const resolvedProviderSessionId = typeof nativeHistory?.providerSessionId === 'string'
        ? nativeHistory.providerSessionId.trim()
        : '';
    const resolvedLookupIsWorkspace = nativeHistory?.lookup === 'workspace';
    const nativeOwnerConfirmed = nativeHistory?.ownerConfirmed === true;
    if (resolvedProviderSessionId && (!resolvedLookupIsWorkspace || nativeOwnerConfirmed)) {
        recordBoundProviderSessionId(h, effectiveReadSessionId(h, targetSessionId), resolvedProviderSessionId);
    }
}

/**
 * Stage 3 — drive ChatSourceMachine (one observation per readChat call, keyed
 * by (providerType, sessionKey-for-this-call)) and apply the selected source.
 * targetSessionId is the most specific session anchor we have; fall back to
 * historySessionId so we never leak state across distinct sessions.
 */
function selectCliReadChatMessages(
    h: CommandHelpers,
    args: any,
    adapter: CliAdapter,
    req: CliReadChatRequest,
    snap: CliAdapterSnapshot,
    native: CliNativeRead,
): CliReadChatSelection {
    const { provider } = req;
    const machineSessionKey = String(
        args?.targetSessionId
        || snap.providerSessionId
        || req.historySessionId
        || (h.currentSession as any)?.sessionId
        || ''
    );
    const primary = decideCliReadChatSource({
        providerType: snap.providerType,
        provider,
        sessionId: machineSessionKey,
        nativeHistoryResult: native.nativeHistory,
        nativeHistoryError: native.nativeHistoryError,
        safeMapping: native.safeMapping,
        trustedExactNativeIdentity: native.trustedExactNativeIdentity,
        sessionWorkspace: snap.sessionWorkspace,
        intendedWorkspace: snap.intendedWorkspace,
        ptyMessages: snap.returnedMessages,
        // Start with PTY visible; decideCliReadChatSource flips this
        // to true when the machine actually selects native-history.
        ptyStatusApprovalOnly: false,
    });
    const selection: CliReadChatSelection = {
        messages: snap.returnedMessages,
        providerSessionId: snap.providerSessionId,
        transcriptAuthority: snap.transcriptAuthority,
        coverage: snap.coverage,
        status: snap.returnedStatus,
        messageSource: primary.messageSource,
        primaryNativeSelected: primary.nativeSelected,
    };

    if (primary.nativeSelected) {
        selection.messages = finalizeStreamingMessagesWhenIdle(primary.nativeMessages, snap.returnedStatus);
        selection.providerSessionId = native.historyProviderSessionId || snap.providerSessionId;
        selection.transcriptAuthority = 'provider';
        selection.coverage = native.nativeHistory?.hasMore ? 'tail' : 'full';
        if (selection.providerSessionId && selection.providerSessionId !== snap.providerSessionId) {
            adapter.updateRuntimeMeta?.({ providerSessionId: selection.providerSessionId });
        }
        // Phase E: the selected transcript is this session's own, so the model
        // its usage records name is an OBSERVATION for the launch record
        // (monotonic on time inside observeLaunchAxis — re-reads cannot roll back).
        const observedModel = nativeHistoryObservedModel(native.nativeHistory);
        if (observedModel) {
            const observedSessionId = (typeof args?.targetSessionId === 'string' && args.targetSessionId.trim())
                || h.currentSession?.sessionId;
            h.ctx.sessionRegistry?.observeLaunchAxis?.(observedSessionId, 'model', observedModel.value, observedModel.at);
        }
    } else if (native.supportsNative) {
        applyNativeNotSelectedFallbacks(h, args, adapter, req, snap, native, machineSessionKey, selection);
    }
    return selection;
}

/**
 * Stage 3b — native not selected. Two preserved v1 fallbacks before settling
 * on PTY: (a) Codex-only live workspace native probe; (b) unsafe-native daemon
 * mirror selection. The machine sees each retry as an additional observation.
 */
function applyNativeNotSelectedFallbacks(
    h: CommandHelpers,
    args: any,
    adapter: CliAdapter,
    req: CliReadChatRequest,
    snap: CliAdapterSnapshot,
    native: CliNativeRead,
    machineSessionKey: string,
    selection: CliReadChatSelection,
): void {
    const { provider } = req;
    const unsafeFallback = () => applyUnsafeNativeDaemonFallback({
        providerType: snap.providerType,
        adapter,
        helpers: h,
        readChatArgs: args,
        sessionWorkspace: snap.sessionWorkspace,
        intendedWorkspace: snap.intendedWorkspace,
        ptyMessages: snap.returnedMessages,
        nativeHistoryLimit: native.nativeHistoryLimit,
        provider,
        messageSourceRef: { set(value) { selection.messageSource = value; }, get() { return selection.messageSource; } },
        apply(picked) {
            selection.messages = picked.messages;
            selection.transcriptAuthority = picked.transcriptAuthority;
            selection.coverage = picked.coverage ?? snap.coverage;
            selection.status = picked.status ?? snap.returnedStatus;
        },
        activeModal: snap.activeModal,
        returnedStatus: snap.returnedStatus,
        coverage: snap.coverage,
    });
    const liveCurrentRuntimePtySafe = isCurrentRuntimePtySafelyAttributed({
        adapter,
        helpers: h,
        readChatArgs: args,
        sessionWorkspace: snap.sessionWorkspace,
        intendedWorkspace: snap.intendedWorkspace,
        ptyMessages: snap.returnedMessages,
    });
    const mayProbeLiveCodexWorkspaceNative = adapter.cliType === 'codex-cli'
        && liveCurrentRuntimePtySafe
        && !(typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
        && !(snap.providerSessionId && snap.providerSessionId.trim())
        && !native.nativeHistoryReadSessionId
        && (!native.historyProviderSessionId || native.historyProviderSessionId === native.nativeHistoryReadSessionId || native.historyProviderSessionId === req.historySessionId)
        && !native.skipLiveNativeHistoryWithoutProviderSession;
    const liveWorkspaceNativeHistory: any = mayProbeLiveCodexWorkspaceNative
        ? readLiveCodexWorkspaceNativeHistory(native.agentStr, {
            canonicalHistory: provider?.nativeHistory,
            workspace: snap.sessionWorkspace,
            offset: 0,
            limit: native.nativeHistoryLimit,
            excludeRecentCount: 0,
            historyBehavior: provider?.historyBehavior,
            scripts: provider?.scripts as any,
        })
        : null;
    if (!liveWorkspaceNativeHistory) {
        unsafeFallback();
        return;
    }
    const liveWorkspaceNativeMessages = Array.isArray(liveWorkspaceNativeHistory?.messages)
        ? normalizeAndFilterNativeHistory(h, native.agentStr, args, liveWorkspaceNativeHistory.messages as ChatMessage[], liveWorkspaceNativeHistory?.providerSessionId)
        : [];
    const liveWorkspaceNativeProviderSessionId = typeof liveWorkspaceNativeHistory?.providerSessionId === 'string'
        ? liveWorkspaceNativeHistory.providerSessionId
        : readHistorySessionIdFromMessages(liveWorkspaceNativeMessages);
    const liveWorkspaceNativeSafeMapping = liveWorkspaceNativeMessages.length > 0
        && hasSafeNativeHistoryMapping({
            workspace: snap.sessionWorkspace,
            nativeMessages: liveWorkspaceNativeMessages,
            ptyMessages: snap.returnedMessages,
            requireWorkspaceContentOverlap: true,
        });
    const liveDecision = decideCliReadChatSource({
        providerType: snap.providerType,
        provider,
        // Distinct session key so a transient codex live-probe does not
        // clobber the primary session's lock. The machine treats this
        // as its own session; the primary session's state is untouched.
        sessionId: `${machineSessionKey}::live-workspace`,
        nativeHistoryResult: liveWorkspaceNativeHistory,
        safeMapping: liveWorkspaceNativeSafeMapping,
        sessionWorkspace: snap.sessionWorkspace,
        intendedWorkspace: snap.intendedWorkspace,
        ptyMessages: snap.returnedMessages,
        ptyStatusApprovalOnly: true,
    });
    if (!liveDecision.nativeSelected) {
        // Live probe also rejected: apply unsafe-native daemon mirror selection
        // (codex-only) using the primary decision's fallbackReason.
        unsafeFallback();
        return;
    }
    selection.messages = finalizeStreamingMessagesWhenIdle(liveDecision.nativeMessages, snap.returnedStatus);
    selection.providerSessionId = liveWorkspaceNativeProviderSessionId || snap.providerSessionId;
    selection.transcriptAuthority = 'provider';
    selection.coverage = liveWorkspaceNativeHistory.hasMore ? 'tail' : 'full';
    selection.liveSelectedNativeTurnTerminalMarkers = readChatNativeTurnTerminalMarkers(liveWorkspaceNativeHistory);
    if (selection.providerSessionId && selection.providerSessionId !== snap.providerSessionId) {
        adapter.updateRuntimeMeta?.({ providerSessionId: selection.providerSessionId });
    }
    selection.messageSource = liveDecision.messageSource;
    (selection.messageSource as any).selectedDaemonSource = 'live-workspace-native-history';
    (selection.messageSource as any).runtimeMappingSafe = true;
}

/**
 * Stage 4 — RC17-NATIVE-FINAL-ASSISTANT-MIDTURN status reconciliation.
 *
 * hasFinalVisibleAssistantMessage only checks that the LAST visible
 * native-transcript message is a non-empty assistant/model bubble — it has no
 * notion of whether that bubble is actually the end of the turn. A live Claude
 * repro showed this reconciling generating→idle on an INTERIM narration bubble
 * ("Starting the collector now, before the two-turn protocol.") emitted
 * mid-turn, well before the real two-turn protocol/tool work ran — exactly the
 * false-completion class rc.16 (9452bd03/6677a565) closed for the mesh-event
 * ingress via hasTrailingToolActivityAfterFinalAssistant +
 * hasLiveTurnPendingEvidence. This read_chat status ingress is a SEPARATE
 * consumer of the same native-final-assistant signal (it feeds the `status`
 * field returned to read_chat/dashboard, not the mesh
 * agent:generating_completed event) and never got the equivalent veto. This
 * reconciliation exists precisely for a PTY/adapter status detector that never
 * transitions to idle on its own (see read-chat-completed-session-fallback.test.ts's
 * antigravity stuck-busy case: isProcessing() stays true forever, empty PTY
 * messages, and native history is the only signal that ever resolves it) — so
 * gating on the adapter's own pending-response bit here would neuter this
 * reconciliation for that exact intended case. Apply only STRUCTURAL,
 * evidence-based vetoes instead, mirroring rc.16's hasLiveTurnPendingEvidence:
 * trailing tool/terminal activity after the final-looking assistant bubble,
 * scanned in (a) the native messages being judged — the transcript's own
 * admission that its "final" bubble kept going — and (b) the live PTY-parsed
 * tail (returnedMessages), which carries no native-transcript write-lag and is
 * exactly how a live Claude repro was caught: the native JSONL's last row was
 * still the interim narration bubble (no trailing tool row landed there yet),
 * but the PTY had already rendered the very next "Auto-approved: Yes\nBash
 * command" tool activity. The antigravity stuck-busy case has an EMPTY PTY
 * message list, so (b) is a no-op there (the function short-circuits false on
 * an empty/absent array) and the existing regression is unaffected.
 */
function reconcileNativeFinalAssistantStatus(selection: CliReadChatSelection, snap: CliAdapterSnapshot): void {
    if (
        isGeneratingLikeStatus(selection.status)
        && selection.transcriptAuthority === 'provider'
        && !hasNonEmptyModalButtons(snap.activeModal)
        && hasFinalVisibleAssistantMessage(selection.messages)
        && !hasTrailingToolActivityAfterFinalAssistant(selection.messages as any)
        && !hasTrailingToolActivityAfterFinalAssistant(snap.returnedMessages as any)
    ) {
        selection.status = 'idle';
        selection.messages = finalizeStreamingMessagesWhenIdle(selection.messages, selection.status);
        selection.messageSource = {
            ...selection.messageSource,
            statusReconciled: {
                from: snap.returnedStatus,
                to: 'idle',
                reason: 'provider_native_final_assistant',
            },
        };
    }
}

/** Stage 5 — assemble the read_chat command result for the adapter path. */
function buildCliReadChatResult(
    h: CommandHelpers,
    args: any,
    adapter: CliAdapter,
    req: CliReadChatRequest,
    snap: CliAdapterSnapshot,
    native: CliNativeRead,
    selection: CliReadChatSelection,
): CommandResult {
    const { provider } = req;
    const { messageSource } = selection;
    // (NATIVE-TURN-SIGNAL) marker selection — see chat-commands-read-turn-markers.ts.
    const turnTerminalMarkers = selectAdapterTurnTerminalMarkers({
        nativeSelected: selection.primaryNativeSelected,
        safeMapping: native.safeMapping,
        nativeHistory: native.nativeHistory,
        liveSelected: selection.liveSelectedNativeTurnTerminalMarkers,
    });
    return buildReadChatCommandResult({
        messages: selection.messages,
        status: selection.status,
        activeModal: snap.activeModal,
        messageSource,
        transcriptProvenance: messageSource,
        ...(turnTerminalMarkers !== undefined ? { turnTerminalMarkers } : {}),
        debugReadChat: {
            provider: adapter.cliType,
            targetSessionId: String(args?.targetSessionId || ''),
            adapterStatus: String(snap.adapterStatus.status || ''),
            parsedStatus: String(snap.parsedRecord.status || ''),
            returnedStatus: String(selection.status || ''),
            selectedMessageSource: (messageSource as any).selected,
            messageSource,
            shouldPreferAdapterMessages: supportsCliNativeTranscript(snap.providerType, provider)
                && isNativeSourceCanonicalHistory(provider?.nativeHistory)
                && (messageSource as any).selected !== 'native-history'
                && typeof (messageSource as any).fallbackReason === 'string'
                && (messageSource as any).fallbackReason.startsWith('native_history_')
                && (messageSource as any).fallbackReason !== 'native_history_not_checked'
                && !isUnsafeNativeTranscriptFallback((messageSource as any).fallbackReason)
                && !(selection.transcriptAuthority === 'provider' && selection.coverage === 'full'),
            parsedMsgCount: snap.parsedRecord.messages.length,
            returnedMsgCount: selection.messages.length,
        },
        ...(snap.title ? { title: snap.title } : {}),
        ...(selection.providerSessionId ? { providerSessionId: selection.providerSessionId } : {}),
        ...(selection.transcriptAuthority ? { transcriptAuthority: selection.transcriptAuthority } : {}),
        ...(selection.coverage ? { coverage: selection.coverage } : {}),
    }, args, h);
}
