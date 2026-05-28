/**
 * Chat Commands — readChat, sendChat, listChats, newChat, switchChat,
 *                 setMode, changeModel, setThoughtLevel, resolveAction, chatHistory
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandResult, CommandHelpers } from './handler.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { flattenContent, normalizeInputEnvelope, type InputEnvelope, type ProviderModule, type ProviderScripts } from '../providers/contracts.js';
import { assertProviderSupportsDeclaredInput, assertTextOnlyInput } from '../providers/provider-input-support.js';
import { validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import { pickApprovalButton } from '../providers/approval-utils.js';
import type { ProviderInstance } from '../providers/provider-instance.js';
import { isNativeSourceCanonicalHistory, readProviderChatHistory } from '../config/chat-history.js';
import { LOG, getRecentLogs } from '../logging/logger.js';
import { getRecentDebugTrace, recordDebugTrace } from '../logging/debug-trace.js';
import { buildChatMessageSignature, hashSignatureParts } from '../chat/chat-signatures.js';
import type { ChatMessage } from '../types.js';
import type { SessionTransport } from '../shared-types.js';
import { filterUserFacingChatMessages, normalizeChatMessages } from '../providers/chat-message-normalization.js';

const RECENT_SEND_WINDOW_MS = 1200;
export const READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS = 25_000;
const HERMES_CLI_STARTING_SEND_SETTLE_MS = 2_000;
const CLI_NATIVE_HISTORY_FRESH_MS = 5 * 60_000;
const CLI_NATIVE_TRANSCRIPT_PROVIDERS = new Set(['codex-cli', 'claude-cli', 'hermes-cli', 'antigravity-cli']);
const recentSendByTarget = new Map<string, number>();

interface ApprovalSelectableInstance extends ProviderInstance {
    recordApprovalSelection?(buttonText: string): void;
}

interface RuntimeChatMessageMerger extends ProviderInstance {
    mergeRuntimeChatMessages?(messages: ChatMessage[]): ChatMessage[];
}

type LegacyStringScript = (params?: Record<string, unknown> | string) => string;

function getCurrentProviderType(h: CommandHelpers, fallback = ''): string {
    return h.currentSession?.providerType || h.currentProviderType || fallback;
}

function getCurrentManagerKey(h: CommandHelpers): string {
    return h.currentSession?.cdpManagerKey || h.currentManagerKey || '';
}

function getTargetedCliAdapter(h: CommandHelpers, args: any, providerType?: string): CliAdapter | null {
    return h.getCliAdapter(args?.targetSessionId || providerType || h.currentSession?.providerType || h.currentManagerKey);
}

function getExplicitHistorySessionId(args: any): string | undefined {
    const explicit = typeof args?.historySessionId === 'string' ? args.historySessionId.trim() : '';
    if (explicit) return explicit;

    const explicitProviderSessionId = typeof args?.providerSessionId === 'string' ? args.providerSessionId.trim() : '';
    if (explicitProviderSessionId) return explicitProviderSessionId;

    return undefined;
}

function getTargetInstance(h: CommandHelpers, args: any): ApprovalSelectableInstance | null {
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const sessionId = targetSessionId || h.currentSession?.sessionId || '';
    if (!sessionId) return null;
    const session = h.ctx.sessionRegistry?.get(sessionId);
    const instanceKey = session?.adapterKey || session?.instanceKey || sessionId;
    return (h.ctx.instanceManager?.getInstance(instanceKey) as ApprovalSelectableInstance | undefined) || null;
}

function getTargetTransport(h: CommandHelpers, provider?: ProviderModule): SessionTransport | null {
    if (h.currentSession?.transport) return h.currentSession.transport;
    switch (provider?.category) {
        case 'cli':
            return 'pty';
        case 'acp':
            return 'acp';
        case 'extension':
            return 'cdp-webview';
        case 'ide':
            return 'cdp-page';
        default:
            return null;
    }
}

function isCliLikeTransport(transport: SessionTransport | null): boolean {
    return transport === 'pty' || transport === 'acp';
}

function isExtensionTransport(transport: SessionTransport | null): boolean {
    return transport === 'cdp-webview';
}

function buildRecentSendKey(h: CommandHelpers, args: any, provider: ProviderModule | undefined, signature: string): string {
    const transport = getTargetTransport(h, provider) || 'unknown';
    const target =
        args?.targetSessionId
        || args?.agentType
        || h.currentSession?.providerType
        || h.currentProviderType
        || h.currentManagerKey
        || 'unknown';
    return `${transport}:${target}:${signature.trim()}`;
}

function summarizeSendInputPart(part: any): string {
    if (!part || typeof part !== 'object') return String(part ?? '');
    if (part.type === 'text') return `text:${String(part.text || '').trim()}`;
    const fields = [
        `type=${String(part.type || '')}`,
        `mime=${String(part.mimeType || '')}`,
        `uri=${String(part.uri || '')}`,
        `name=${String(part.name || '')}`,
    ];
    const data = typeof part.data === 'string'
        ? part.data
        : typeof part.resource?.blob === 'string'
            ? part.resource.blob
            : '';
    if (data) fields.push(`dataLen=${data.length}`, `dataHash=${hashSignatureParts([data]).slice(0, 12)}`);
    const textish = [part.alt, part.transcript, part.description, part.title, part.resource?.uri]
        .filter((value) => typeof value === 'string' && value.trim())
        .join('\u001f');
    if (textish) fields.push(`meta=${hashSignatureParts([textish]).slice(0, 12)}`);
    return fields.join(';');
}

export function buildSendInputSignature(input: InputEnvelope): string {
    const text = typeof input.textFallback === 'string' ? input.textFallback.trim() : '';
    const partSummaries = (input.parts || []).map(summarizeSendInputPart);
    return hashSignatureParts([text, ...partSummaries]);
}

function getSendChatInputEnvelope(args: any): InputEnvelope {
    return normalizeInputEnvelope(args?.input ? { input: args.input } : args);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitOnceForFreshHermesCliStart(adapter: CliAdapter, log: (msg: string) => void): Promise<void> {
    if (adapter.cliType !== 'hermes-cli') return;
    const status = typeof adapter.getStatus === 'function' ? adapter.getStatus()?.status : undefined;
    if (status !== 'starting') return;

    log(`Hermes CLI is still starting; waiting ${HERMES_CLI_STARTING_SEND_SETTLE_MS}ms before first send`);
    await sleep(HERMES_CLI_STARTING_SEND_SETTLE_MS);
}

function getHistorySessionId(h: CommandHelpers, args: any): string | undefined {
    const explicit = getExplicitHistorySessionId(args);
    if (explicit) return explicit;

    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!targetSessionId) return undefined;

    const session = h.ctx.sessionRegistry?.get(targetSessionId) as any;
    const registeredProviderSessionId = typeof session?.providerSessionId === 'string' ? session.providerSessionId.trim() : '';
    if (registeredProviderSessionId) return registeredProviderSessionId;

    const instance = getTargetInstance(h, args);
    const state = instance?.getState?.();
    const providerSessionId = typeof state?.providerSessionId === 'string' ? state.providerSessionId.trim() : '';
    if (providerSessionId) return providerSessionId;

    const currentSession = h.currentSession as any;
    if (currentSession?.sessionId === targetSessionId) {
        const currentProviderSessionId = typeof currentSession.providerSessionId === 'string'
            ? currentSession.providerSessionId.trim()
            : '';
        if (currentProviderSessionId) return currentProviderSessionId;
    }

    return targetSessionId;
}

function resolveCliNativeHistorySessionId(args: any, currentHistorySessionId: string | undefined, parsedProviderSessionId: string | undefined): string | undefined {
    const explicit = getExplicitHistorySessionId(args);
    if (explicit) return explicit;

    const parsed = typeof parsedProviderSessionId === 'string' ? parsedProviderSessionId.trim() : '';
    const current = typeof currentHistorySessionId === 'string' ? currentHistorySessionId.trim() : '';
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';

    // getHistorySessionId falls back to the runtime session id when no native
    // handle has been registered yet. For live CLI adapters the parser may
    // already know the provider-native handle; prefer it over the runtime id so
    // exact native reads do not miss the worker transcript and fall back to PTY
    // or same-workspace history.
    if (parsed && (!current || current === targetSessionId)) return parsed;
    return current || parsed || undefined;
}

function getInteractionId(args: any): string | undefined {
    return typeof args?._interactionId === 'string' && args._interactionId.trim()
        ? args._interactionId.trim()
        : undefined;
}

function traceProviderEvent(
    args: any,
    category: 'provider' | 'parser',
    stage: string,
    options: {
        h: CommandHelpers;
        provider?: ProviderModule;
        payload?: Record<string, unknown>;
        level?: 'debug' | 'info' | 'warn' | 'error';
    },
): void {
    recordDebugTrace({
        interactionId: getInteractionId(args),
        category,
        stage,
        level: options.level || 'info',
        sessionId: typeof args?.targetSessionId === 'string' ? args.targetSessionId : options.h.currentSession?.sessionId,
        providerType: options.provider?.type || options.h.currentProviderType || options.h.currentSession?.providerType,
        payload: options.payload,
    });
}

function callLegacyTextScript(script: ProviderScripts[keyof ProviderScripts] | undefined, text: string): string | null {
    if (typeof script !== 'function') return null;
    return (script as LegacyStringScript)(text);
}

function isRecentDuplicateSend(key: string): boolean {
    const now = Date.now();
    for (const [candidate, ts] of recentSendByTarget.entries()) {
        if (now - ts > RECENT_SEND_WINDOW_MS) recentSendByTarget.delete(candidate);
    }
    const previous = recentSendByTarget.get(key);
    if (previous && (now - previous) <= RECENT_SEND_WINDOW_MS) return true;
    recentSendByTarget.set(key, now);
    return false;
}

function parseMaybeJson(value: any): any {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function getChatMessageSignature(message: ChatMessage | null | undefined): string {
    return buildChatMessageSignature(message);
}

function normalizeReadChatTailLimit(args: any): number {
    const value = Number(args?.tailLimit || 0);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeReadChatMessages(payload: Record<string, any>): ChatMessage[] {
    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    return normalizeChatMessages(messages);
}

function getMessageNewestReceivedAt(messages: Array<{ receivedAt?: unknown; timestamp?: unknown }>): number {
    let newest = 0;
    for (const message of messages) {
        const receivedAt = Number(message?.receivedAt ?? message?.timestamp ?? 0);
        if (Number.isFinite(receivedAt) && receivedAt > newest) newest = receivedAt;
    }
    return newest;
}

function readHistorySessionIdFromMessages(messages: ChatMessage[]): string | undefined {
    for (const message of messages as Array<ChatMessage & { historySessionId?: unknown }>) {
        const historySessionId = typeof message?.historySessionId === 'string' ? message.historySessionId.trim() : '';
        if (historySessionId) return historySessionId;
    }
    return undefined;
}

function normalizeNativeHistoryMessages(providerType: string, messages: ChatMessage[]): ChatMessage[] {
    let turnIndex = 0;
    return normalizeChatMessages(messages).map((message, index) => {
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        const kind = typeof message.kind === 'string' && message.kind.trim() ? message.kind.trim() : (role === 'system' ? 'system' : 'standard');
        if ((role === 'user' || role === 'human') && index > 0) turnIndex += 1;
        const historySessionId = typeof (message as any).historySessionId === 'string'
            ? (message as any).historySessionId.trim()
            : '';
        const contentHash = hashSignatureParts([
            providerType,
            historySessionId,
            String(message.receivedAt || message.timestamp || index),
            role,
            kind,
            flattenContent(message.content),
        ]).slice(0, 12);
        const providerUnitKey = typeof message.providerUnitKey === 'string' && message.providerUnitKey.trim()
            ? message.providerUnitKey.trim()
            : `${providerType}:native:${historySessionId || 'workspace'}:${index}:${role || 'message'}:${kind}:${contentHash}`;
        const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : undefined;
        const isSystemSessionStart = role === 'system' || kind === 'system' || kind === 'session_start';
        const isActivity = role === 'assistant' && (kind === 'tool' || kind === 'terminal' || kind === 'thought');
        return {
            ...message,
            role: role === 'human' ? 'user' : (role || 'assistant'),
            kind: isSystemSessionStart ? 'system' : kind,
            providerUnitKey,
            bubbleId: typeof message.bubbleId === 'string' && message.bubbleId.trim()
                ? message.bubbleId.trim()
                : `bubble:${providerUnitKey}`,
            _turnKey: typeof message._turnKey === 'string' && message._turnKey.trim()
                ? message._turnKey.trim()
                : `${providerType}:native-turn:${historySessionId || 'workspace'}:${turnIndex}`,
            bubbleState: message.bubbleState || 'final',
            ...(isSystemSessionStart ? {
                visibility: message.visibility || 'hidden',
                transcriptVisibility: message.transcriptVisibility || 'hidden',
                audience: message.audience || 'internal',
                source: message.source || 'runtime_status',
            } : isActivity ? {
                source: message.source || (kind === 'terminal' ? 'terminal_command' : 'tool_call'),
                meta: { ...meta, label: message.senderName || meta?.label || (kind === 'terminal' ? 'Terminal' : 'Tool') },
            } : {
                source: message.source || (role === 'assistant' ? 'assistant_text' : undefined),
            }),
        } as ChatMessage;
    });
}

function buildCliMessageSourceProvenance(args: {
    selected: 'native-history' | 'pty-parser';
    provider: string;
    nativeHandle?: string;
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
    return {
        selected: args.selected,
        provider: args.provider,
        providerType: args.provider,
        ...(args.nativeHandle ? { nativeHandle: args.nativeHandle } : {}),
        ...(args.nativeHandle ? { nativeSessionId: args.nativeHandle } : {}),
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
        },
    };
}

function buildNativeHistoryFallbackReason(args: {
    providerType: string;
    provider?: ProviderModule;
    nativeSource?: string;
    nativeHistoryCoverage?: string;
    nativeMessageCount: number;
    safeMapping: boolean;
    freshEnough: boolean;
}): string {
    if (!supportsCliNativeTranscript(args.providerType, args.provider)) return 'provider_native_transcript_not_supported';
    if (args.nativeSource === 'native-unavailable') return 'native_history_unavailable';
    if (args.nativeHistoryCoverage === 'partial') return 'native_history_partial';
    if (args.nativeHistoryCoverage === 'unavailable') return 'native_history_unavailable';
    if (args.nativeSource && args.nativeSource !== 'provider-native') return `native_history_source_${args.nativeSource}`;
    if (args.nativeMessageCount <= 0) return 'native_history_empty';
    if (!args.safeMapping) return 'native_history_not_safely_mapped';
    if (!args.freshEnough) return 'native_history_stale';
    return 'native_history_not_selected';
}

function supportsCliNativeTranscript(providerType: string, provider?: ProviderModule): boolean {
    if (CLI_NATIVE_TRANSCRIPT_PROVIDERS.has(providerType)) return true;
    return provider?.category === 'cli' && isNativeSourceCanonicalHistory(provider?.canonicalHistory);
}

function getComparableVisibleText(message: ChatMessage | undefined): string {
    if (!message) return '';
    const role = String((message as any).role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'assistant') return '';
    const kind = String((message as any).kind || 'standard').trim().toLowerCase();
    if (kind && kind !== 'standard') return '';
    const content = flattenContent((message as any).content).replace(/\s+/g, ' ').trim();
    return content;
}

function hasOverlappingVisibleConversationText(nativeMessages: ChatMessage[], ptyMessages: ChatMessage[]): boolean {
    const nativeTexts = nativeMessages.map(getComparableVisibleText).filter(Boolean);
    const ptyTexts = ptyMessages.map(getComparableVisibleText).filter(Boolean);
    if (nativeTexts.length === 0 || ptyTexts.length === 0) return false;
    for (const nativeText of nativeTexts) {
        for (const ptyText of ptyTexts) {
            if (nativeText === ptyText) return true;
            const shorter = nativeText.length <= ptyText.length ? nativeText : ptyText;
            const longer = nativeText.length <= ptyText.length ? ptyText : nativeText;
            if (shorter.length >= 32 && longer.includes(shorter)) return true;
        }
    }
    return false;
}

function hasSafeNativeHistoryMapping(args: {
    historySessionId?: string;
    providerSessionId?: string;
    workspace?: string;
    nativeMessages: ChatMessage[];
    ptyMessages?: ChatMessage[];
    requireWorkspaceContentOverlap?: boolean;
}): boolean {
    const explicitSessionId = String(args.historySessionId || args.providerSessionId || '').trim();
    if (explicitSessionId) {
        const messageSessionIds = args.nativeMessages
            .map((message: any) => typeof message?.historySessionId === 'string' ? message.historySessionId.trim() : '')
            .filter(Boolean);
        if (messageSessionIds.length === 0) return true;
        return messageSessionIds.some((id) => id === explicitSessionId);
    }
    const workspace = String(args.workspace || '').trim();
    if (!workspace) return false;
    const workspaceMatches = args.nativeMessages.some((message: any) => String(message?.workspace || '').trim() === workspace);
    if (!workspaceMatches) return false;
    if (!args.requireWorkspaceContentOverlap) return true;
    return hasOverlappingVisibleConversationText(args.nativeMessages, args.ptyMessages || []);
}

function readCliProviderNativeHistory(agentStr: string, args: {
    canonicalHistory?: ProviderModule['canonicalHistory'];
    historySessionId?: string;
    workspace?: string;
    offset: number;
    limit: number;
    excludeRecentCount: number;
    historyBehavior?: ProviderModule['historyBehavior'];
    scripts?: ProviderScripts;
    exactSessionScoped?: boolean;
}): ReturnType<typeof readProviderChatHistory> & { lookup: 'session' | 'workspace' } {
    const sessionHistory = readProviderChatHistory(agentStr, {
        canonicalHistory: args.canonicalHistory,
        historySessionId: args.historySessionId,
        workspace: args.workspace,
        offset: args.offset,
        limit: args.limit,
        excludeRecentCount: args.excludeRecentCount,
        historyBehavior: args.historyBehavior,
        scripts: args.scripts as any,
    });
    // Exact runtime/provider transcript reads must not silently fall back to the
    // workspace's active or most recent native transcript: multiple Hermes/Gemini/
    // Codex sessions can run in the same workspace, and workspace fallback can make
    // read_chat/completion evidence point at a different runtime's prompt.
    if ((sessionHistory as any).source !== 'native-unavailable' || args.exactSessionScoped || !args.historySessionId || !args.workspace) {
        return { ...(sessionHistory as any), lookup: args.historySessionId ? 'session' : 'workspace' };
    }
    const workspaceHistory = readProviderChatHistory(agentStr, {
        canonicalHistory: args.canonicalHistory,
        historySessionId: undefined,
        workspace: args.workspace,
        offset: args.offset,
        limit: args.limit,
        excludeRecentCount: args.excludeRecentCount,
        historyBehavior: args.historyBehavior,
        scripts: args.scripts as any,
    });
    return { ...(workspaceHistory as any), lookup: 'workspace' };
}

function isNativeHistoryFreshEnough(args: {
    sourceMtimeMs?: number;
    nativeMessages: ChatMessage[];
    ptyMessages: ChatMessage[];
}): boolean {
    const nativeNewest = getMessageNewestReceivedAt(args.nativeMessages);
    const ptyNewest = getMessageNewestReceivedAt(args.ptyMessages);
    if (nativeNewest > 0 && nativeNewest >= ptyNewest) return true;
    const sourceMtimeMs = Number(args.sourceMtimeMs || 0);
    if (sourceMtimeMs > 0 && Date.now() - sourceMtimeMs <= CLI_NATIVE_HISTORY_FRESH_MS) return true;
    return ptyNewest === 0 && nativeNewest > 0;
}

function shouldPreserveReadChatPayloadField(key: string): boolean {
    return key === 'messageSource' || key === 'transcriptProvenance';
}

function updateMessageSourceReturnedCount(value: unknown, returnedMessageCount: number): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const coverage = record.coverage && typeof record.coverage === 'object' && !Array.isArray(record.coverage)
        ? record.coverage as Record<string, unknown>
        : undefined;
    if (!coverage) return value;
    return {
        ...record,
        coverage: {
            ...coverage,
            returnedMessageCount,
        },
    };
}

function deriveHistoryDedupKey(message: ChatMessage & { _unitKey?: string; _turnKey?: string }): string | undefined {
    const unitKey = typeof message._unitKey === 'string' ? message._unitKey.trim() : '';
    if (unitKey) return `read_chat:${unitKey}`;

    const turnKey = typeof message._turnKey === 'string' ? message._turnKey.trim() : '';
    if (!turnKey) return undefined;

    let content = '';
    try {
        content = JSON.stringify(message.content ?? '');
    } catch {
        content = String(message.content ?? '');
    }
    return `read_chat:${turnKey}:${String(message.role || '').toLowerCase()}:${content}`;
}

function toHistoryPersistedMessages(messages: ChatMessage[]): Array<{
    role: string;
    content: string;
    receivedAt?: number;
    kind?: string;
    senderName?: string;
    historyDedupKey?: string;
}> {
    return messages.map((message) => ({
        role: message.role,
        content: flattenContent(message.content),
        receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : undefined,
        kind: typeof message.kind === 'string' ? message.kind : undefined,
        senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
        historyDedupKey: deriveHistoryDedupKey(message as ChatMessage & { _unitKey?: string; _turnKey?: string }),
    }));
}

function buildFullTail(messages: ChatMessage[], tailLimit: number): {
    messages: ChatMessage[];
    totalMessages: number;
} {
    const totalMessages = messages.length;
    const tailMessages = tailLimit > 0 ? messages.slice(-tailLimit) : messages;
    return {
        messages: tailMessages,
        totalMessages,
    };
}

function hasNonEmptyModalButtons(activeModal: unknown): boolean {
    if (!activeModal || typeof activeModal !== 'object') return false;
    const buttons = (activeModal as { buttons?: unknown }).buttons;
    return Array.isArray(buttons) && buttons.some((button) => typeof button === 'string' && button.trim().length > 0);
}

function normalizeReadChatCommandStatus(status: unknown, activeModal: unknown): string {
    const raw = typeof status === 'string' ? status.trim() : '';
    if (!raw) {
        return hasNonEmptyModalButtons(activeModal) ? 'waiting_approval' : 'idle';
    }
    switch (raw) {
        case 'starting':
            return hasNonEmptyModalButtons(activeModal) ? 'waiting_approval' : 'starting';
        case 'stopped':
        case 'disconnected':
        case 'not_monitored':
            return 'error';
        default:
            return raw;
    }
}

function isGeneratingLikeStatus(status: unknown): boolean {
    return status === 'generating' || status === 'streaming' || status === 'long_generating' || status === 'starting';
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

function shouldTrustCliAdapterTerminalStatus(parsedStatus: unknown, activeModal: unknown, adapter: CliAdapter, adapterStatus: any): boolean {
    if (!isGeneratingLikeStatus(parsedStatus)) return false;
    if (hasNonEmptyModalButtons(activeModal)) return false;
    const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
    if (adapterRawStatus !== 'idle') return false;
    if (typeof adapter.isProcessing === 'function' && adapter.isProcessing()) return false;
    return true;
}

function normalizeCliReadChatStatus(parsedStatus: unknown, activeModal: unknown, adapter: CliAdapter, adapterStatus: any, parsedMessages?: unknown[]): string {
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

function finalizeStreamingMessagesWhenIdle(messages: ChatMessage[], status: string): ChatMessage[] {
    if (status !== 'idle') return messages;
    return messages.map((message) => {
        const meta = message.meta && typeof message.meta === 'object'
            ? message.meta as Record<string, unknown>
            : undefined;
        const hasStreamingMeta = meta?.streaming === true;
        if (message.bubbleState !== 'streaming' && !hasStreamingMeta) return message;
        return {
            ...message,
            ...(message.bubbleState === 'streaming' ? { bubbleState: 'final' as const } : {}),
            ...(hasStreamingMeta ? { meta: { ...meta, streaming: false } } : {}),
        };
    });
}

function buildReadChatCommandResult(payload: Record<string, any>, args: any): CommandResult {
    let validatedPayload: Record<string, any>;
    const debugReadChat = payload?.debugReadChat && typeof payload.debugReadChat === 'object'
        ? payload.debugReadChat
        : undefined;
    try {
        validatedPayload = validateReadChatResultPayload({
            ...payload,
            status: normalizeReadChatCommandStatus(payload?.status, payload?.activeModal),
        }, 'read_chat command result') as Record<string, any>;
    } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
    }
    const messages = normalizeReadChatMessages(validatedPayload);
    const visibleMessages = filterUserFacingChatMessages(messages);
    const sync = buildFullTail(visibleMessages, normalizeReadChatTailLimit(args));
    const hiddenMsgCount = Math.max(0, messages.length - visibleMessages.length);
    const preservedPayloadFields = Object.fromEntries(Object.entries(payload).filter(([key]) => shouldPreserveReadChatPayloadField(key)));
    if (preservedPayloadFields.messageSource) {
        preservedPayloadFields.messageSource = updateMessageSourceReturnedCount(preservedPayloadFields.messageSource, sync.messages.length);
    }
    if (preservedPayloadFields.transcriptProvenance) {
        preservedPayloadFields.transcriptProvenance = updateMessageSourceReturnedCount(preservedPayloadFields.transcriptProvenance, sync.messages.length);
    }
    const returnedDebugReadChat = debugReadChat
        ? {
            ...debugReadChat,
            fullMsgCount: typeof debugReadChat.fullMsgCount === 'number'
                ? debugReadChat.fullMsgCount
                : messages.length,
            visibleMsgCount: visibleMessages.length,
            hiddenMsgCount,
            returnedMsgCount: sync.messages.length,
        }
        : undefined;
    return {
        success: true,
        ...validatedPayload,
        ...preservedPayloadFields,
        messages: sync.messages,
        totalMessages: sync.totalMessages,
        ...(returnedDebugReadChat ? { debugReadChat: returnedDebugReadChat } : {}),
    };
}


interface DebugSanitizeOptions {
    maxDepth?: number;
    maxArrayLength?: number;
    maxObjectKeys?: number;
    maxStringLength?: number;
}

const DEFAULT_DEBUG_SANITIZE_OPTIONS: Required<DebugSanitizeOptions> = {
    maxDepth: 8,
    maxArrayLength: 80,
    maxObjectKeys: 120,
    maxStringLength: 16_000,
};

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|authorization|cookie|api[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|private[_-]?key)/i;

function truncateDebugString(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function redactDebugSecrets(value: string): string {
    return value
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s'"`]+/gi, '$1[REDACTED:bearer]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/gi, '$1[REDACTED:bearer]')
        .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]')
        .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]')
        .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, '[REDACTED:slack-token]')
        .replace(/\b(?:adk|adm)_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:adhdev-token]')
        .replace(/((?:api[_-]?key|token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*)[^\s,'"`}&]+/gi, '$1[REDACTED:secret]')
        .replace(/([?&](?:api[_-]?key|token|secret|password|client_secret)=)[^&#\s]+/gi, '$1[REDACTED:secret]');
}

export function sanitizeDebugBundleValue(
    value: unknown,
    options: DebugSanitizeOptions = {},
    depth = 0,
    keyHint = '',
): unknown {
    const normalizedOptions = { ...DEFAULT_DEBUG_SANITIZE_OPTIONS, ...options };
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'string') {
        if (SECRET_KEY_PATTERN.test(keyHint) && value.trim()) return '[REDACTED:secret-field]';
        return truncateDebugString(redactDebugSecrets(value), normalizedOptions.maxStringLength);
    }
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value !== 'object') return String(value);
    if (depth >= normalizedOptions.maxDepth) return '[MaxDepth]';

    if (Array.isArray(value)) {
        const items = value
            .slice(0, normalizedOptions.maxArrayLength)
            .map((item) => sanitizeDebugBundleValue(item, normalizedOptions, depth + 1, keyHint));
        if (value.length > normalizedOptions.maxArrayLength) {
            items.push(`[truncated ${value.length - normalizedOptions.maxArrayLength} items]`);
        }
        return items;
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const entries = Object.entries(record).slice(0, normalizedOptions.maxObjectKeys);
    for (const [key, item] of entries) {
        result[key] = sanitizeDebugBundleValue(item, normalizedOptions, depth + 1, key);
    }
    const remaining = Object.keys(record).length - entries.length;
    if (remaining > 0) result.__truncatedKeys = remaining;
    return result;
}

function summarizeProviderForDebug(provider: ProviderModule | undefined): Record<string, unknown> | null {
    if (!provider) return null;
    const scripts = provider.scripts && typeof provider.scripts === 'object'
        ? Object.keys(provider.scripts)
        : [];
    const controls = Array.isArray((provider as any).controls)
        ? (provider as any).controls.map((control: any) => ({
            id: control?.id,
            label: control?.label,
            type: control?.type,
            settingKey: control?.settingKey,
            invokeScript: control?.invokeScript,
            listScript: control?.listScript,
            location: control?.location,
        }))
        : [];
    return {
        type: provider.type,
        name: provider.name,
        category: provider.category,
        version: (provider as any).version,
        canonicalHistory: provider.canonicalHistory,
        historyBehavior: provider.historyBehavior,
        webviewMatchText: provider.webviewMatchText,
        scriptNames: scripts,
        controls,
        resume: provider.resume,
    };
}

function summarizeSessionForDebug(session: any): Record<string, unknown> | null {
    if (!session || typeof session !== 'object') return null;
    return {
        sessionId: session.sessionId,
        instanceKey: session.instanceKey,
        adapterKey: session.adapterKey,
        providerType: session.providerType,
        providerName: session.providerName,
        transport: session.transport,
        kind: session.kind,
        cdpManagerKey: session.cdpManagerKey,
        parentSessionId: session.parentSessionId,
        providerSessionId: session.providerSessionId,
        workspace: session.workspace,
        title: session.title,
        status: session.status,
        mode: session.mode,
        capabilities: session.capabilities,
    };
}

function summarizeStateForDebug(state: any): Record<string, unknown> | null {
    if (!state || typeof state !== 'object') return null;
    const activeChat = state.activeChat && typeof state.activeChat === 'object' ? state.activeChat : null;
    return {
        type: state.type,
        name: state.name,
        category: state.category,
        status: state.status,
        instanceId: state.instanceId,
        providerSessionId: state.providerSessionId,
        title: state.title,
        transport: state.transport,
        mode: state.mode,
        workspace: state.workspace,
        runtime: state.runtime,
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        activeChat: activeChat ? {
            status: activeChat.status,
            title: activeChat.title,
            messageCount: Array.isArray(activeChat.messages) ? activeChat.messages.length : undefined,
            activeModal: activeChat.activeModal,
            messagesTail: Array.isArray(activeChat.messages) ? activeChat.messages.slice(-10) : undefined,
        } : null,
        controlValues: state.controlValues,
        summaryMetadata: state.summaryMetadata,
    };
}

function buildDebugBundleText(bundle: Record<string, unknown>): string {
    return [
        '# ADHDev Chat Debug Bundle',
        '',
        '```json',
        JSON.stringify(bundle, null, 2),
        '```',
    ].join('\n');
}

function getChatDebugBundleDir(): string {
    const override = typeof process.env.ADHDEV_DEBUG_BUNDLE_DIR === 'string'
        ? process.env.ADHDEV_DEBUG_BUNDLE_DIR.trim()
        : '';
    return override || path.join(os.homedir(), '.adhdev', 'debug-bundles', 'chat');
}

function safeBundleIdSegment(value: unknown, fallback: string): string {
    const normalized = String(value || fallback)
        .trim()
        .replace(/[^A-Za-z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return normalized || fallback;
}

function createChatDebugBundleId(targetSessionId: string): string {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
    const sessionSegment = safeBundleIdSegment(targetSessionId, 'unknown-session');
    return `chat-debug-${timestamp}-${sessionSegment}-${randomUUID().slice(0, 8)}`;
}

function buildChatDebugBundleSummary(bundle: Record<string, unknown>): Record<string, unknown> {
    const target = bundle.target && typeof bundle.target === 'object' ? bundle.target as Record<string, unknown> : {};
    const readChat = bundle.readChat && typeof bundle.readChat === 'object' ? bundle.readChat as Record<string, unknown> : {};
    const cli = bundle.cli && typeof bundle.cli === 'object' ? bundle.cli as Record<string, unknown> : null;
    const frontend = bundle.frontend && typeof bundle.frontend === 'object' ? bundle.frontend as Record<string, unknown> : null;
    const debugReadChat = readChat.debugReadChat && typeof readChat.debugReadChat === 'object'
        ? readChat.debugReadChat as Record<string, unknown>
        : {};
    const parsedStatus = cli?.parsedStatus && typeof cli.parsedStatus === 'object'
        ? cli.parsedStatus as Record<string, unknown>
        : null;
    const cliParsedMessageCount = Array.isArray(parsedStatus?.messages) ? parsedStatus.messages.length : undefined;
    const readChatReturnedMessages = Array.isArray(readChat.messagesTail) ? readChat.messagesTail.length : undefined;
    const cliPartialResponse = typeof cli?.partialResponse === 'string' ? cli.partialResponse : '';
    const readChatStatus = typeof readChat.status === 'string' ? readChat.status : '';
    const cliStatus = typeof cli?.status === 'string' ? cli.status : '';
    const cliParsedStatus = typeof parsedStatus?.status === 'string' ? parsedStatus.status : '';
    return {
        createdAt: bundle.createdAt,
        targetSessionId: target.targetSessionId,
        providerType: target.providerType,
        transport: target.transport,
        readChatSuccess: readChat.success,
        readChatStatus: readChat.status,
        readChatTotalMessages: readChat.totalMessages,
        readChatReturnedMessages,
        cliStatus: cli?.status,
        cliParsedStatus: cliParsedStatus || undefined,
        cliMessageCount: cli?.messageCount,
        cliParsedMessageCount,
        cliPartialResponseChars: cliPartialResponse.length,
        parserAdapterStatusMismatch: Boolean(cliStatus && cliParsedStatus && cliStatus !== cliParsedStatus),
        parserReadChatStatusMismatch: Boolean(readChatStatus && cliParsedStatus && readChatStatus !== cliParsedStatus),
        readChatDebug: Object.keys(debugReadChat).length ? {
            adapterStatus: debugReadChat.adapterStatus,
            parsedStatus: debugReadChat.parsedStatus,
            returnedStatus: debugReadChat.returnedStatus,
            selectedMessageSource: debugReadChat.selectedMessageSource,
            messageSource: debugReadChat.messageSource,
            parsedMsgCount: debugReadChat.parsedMsgCount,
            returnedMsgCount: debugReadChat.returnedMsgCount,
            shouldPreferAdapterMessages: debugReadChat.shouldPreferAdapterMessages,
        } : undefined,
        hasFrontendSnapshot: !!frontend,
    };
}

function storeChatDebugBundleOnDaemon(bundle: Record<string, unknown>, targetSessionId: string): { bundleId: string; savedPath: string; sizeBytes: number } {
    const bundleId = createChatDebugBundleId(targetSessionId);
    const dir = getChatDebugBundleDir();
    fs.mkdirSync(dir, { recursive: true });
    const savedPath = path.join(dir, `${bundleId}.json`);
    const json = `${JSON.stringify(bundle, null, 2)}\n`;
    fs.writeFileSync(savedPath, json, { encoding: 'utf8', mode: 0o600 });
    return { bundleId, savedPath, sizeBytes: Buffer.byteLength(json, 'utf8') };
}

function isDaemonFileDebugDelivery(args: any): boolean {
    return args?.delivery === 'daemon_file' || args?.delivery === 'file';
}

export async function handleGetChatDebugBundle(h: CommandHelpers, args: any): Promise<CommandResult> {
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!targetSessionId && !h.currentSession) {
        return { success: false, error: 'No targetSessionId specified — cannot route command' };
    }

    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const providerType = provider?.type || getCurrentProviderType(h, args?.agentType || '');
    const adapter = isCliLikeTransport(transport) ? getTargetedCliAdapter(h, args, provider?.type) : null;
    const targetInstance = getTargetInstance(h, args);

    let adapterStatus: unknown = null;
    let parsedStatus: unknown = null;
    let adapterDebugSnapshot: unknown = null;
    let partialResponse = '';
    if (adapter) {
        try { adapterStatus = adapter.getStatus?.(); } catch (error: any) { adapterStatus = { error: error?.message || String(error) }; }
        try { parsedStatus = typeof adapter.getScriptParsedStatus === 'function' ? parseMaybeJson(adapter.getScriptParsedStatus()) : null; } catch (error: any) { parsedStatus = { error: error?.message || String(error) }; }
        try { adapterDebugSnapshot = typeof adapter.getDebugSnapshot === 'function' ? adapter.getDebugSnapshot() : null; } catch (error: any) { adapterDebugSnapshot = { error: error?.message || String(error) }; }
        try { partialResponse = adapter.getPartialResponse?.() || ''; } catch { partialResponse = ''; }
    }

    let instanceState: unknown = null;
    if (targetInstance?.getState) {
        try { instanceState = summarizeStateForDebug(targetInstance.getState()); } catch (error: any) { instanceState = { error: error?.message || String(error) }; }
    }

    let readChat: unknown = null;
    try {
        const readResult = await handleReadChat(h, { ...args, tailLimit: Math.max(1, Math.min(40, Number(args?.tailLimit || 40))) });
        readChat = readResult.success
            ? {
                success: true,
                status: readResult.status,
                title: readResult.title,
                totalMessages: readResult.totalMessages,
                providerSessionId: readResult.providerSessionId,
                transcriptAuthority: readResult.transcriptAuthority,
                coverage: readResult.coverage,
                messageSource: readResult.messageSource,
                transcriptProvenance: readResult.transcriptProvenance,
                activeModal: readResult.activeModal,
                messagesTail: Array.isArray(readResult.messages) ? readResult.messages.slice(-20) : [],
                debugReadChat: readResult.debugReadChat,
            }
            : { success: false, error: readResult.error };
    } catch (error: any) {
        readChat = { success: false, error: error?.message || String(error) };
    }

    const cdp = h.getCdp();
    const rawBundle: Record<string, unknown> = {
        version: 1,
        createdAt: new Date().toISOString(),
        target: {
            targetSessionId,
            providerType,
            transport,
            routeManagerKey: h.currentManagerKey,
            currentIdeType: h.currentIdeType,
        },
        session: summarizeSessionForDebug(h.currentSession),
        provider: summarizeProviderForDebug(provider),
        daemon: {
            pid: process.pid,
            platform: process.platform,
            nodeVersion: process.version,
            cwd: process.cwd(),
        },
        cdp: {
            requested: !!cdp,
            connected: !!cdp?.isConnected,
            managerKey: getCurrentManagerKey(h),
        },
        instanceState,
        cli: adapter ? {
            cliType: adapter.cliType,
            cliName: adapter.cliName,
            workingDir: adapter.workingDir,
            status: (adapterStatus as any)?.status,
            activeModal: (adapterStatus as any)?.activeModal,
            messageCount: Array.isArray((adapterStatus as any)?.messages) ? (adapterStatus as any).messages.length : undefined,
            messagesTail: Array.isArray((adapterStatus as any)?.messages) ? (adapterStatus as any).messages.slice(-20) : undefined,
            parsedStatus,
            partialResponse,
            ready: typeof adapter.isReady === 'function' ? adapter.isReady() : undefined,
            processing: typeof adapter.isProcessing === 'function' ? adapter.isProcessing() : undefined,
            debugSnapshot: adapterDebugSnapshot,
        } : null,
        readChat,
        frontend: args?.frontendSnapshot && typeof args.frontendSnapshot === 'object' ? args.frontendSnapshot : null,
        recentLogs: getRecentLogs(80, 'debug'),
        recentDebugTrace: getRecentDebugTrace({ limit: 120 }),
    };

    const bundle = sanitizeDebugBundleValue(rawBundle) as Record<string, unknown>;
    if (isDaemonFileDebugDelivery(args)) {
        const summary = buildChatDebugBundleSummary(bundle);
        const stored = storeChatDebugBundleOnDaemon(bundle, targetSessionId || String(summary.targetSessionId || 'unknown-session'));
        LOG.info('Command', `[get_chat_debug_bundle] saved daemon_file bundle id=${stored.bundleId} path=${stored.savedPath} sizeBytes=${stored.sizeBytes} targetSessionId=${summary.targetSessionId || ''} providerType=${summary.providerType || ''} transport=${summary.transport || ''}`);
        return {
            success: true,
            delivery: 'daemon_file',
            bundleId: stored.bundleId,
            savedPath: stored.savedPath,
            sizeBytes: stored.sizeBytes,
            createdAt: bundle.createdAt,
            summary,
        };
    }
    return {
        success: true,
        bundle,
        text: buildDebugBundleText(bundle),
    };
}

function didProviderConfirmSend(result: any): boolean {
    const parsed = parseMaybeJson(result);
    if (parsed === true) return true;
    if (typeof parsed === 'string') {
        const normalized = parsed.trim().toLowerCase();
        return normalized === 'ok' || normalized === 'sent' || normalized === 'success' || normalized === 'true';
    }
    if (!parsed || typeof parsed !== 'object') return false;

    return parsed.sent === true
        || parsed.success === true
        || parsed.ok === true
        || parsed.submitted === true
        || parsed.dispatched === true;
}

async function readExtensionChatState(h: CommandHelpers): Promise<any | null> {
    try {
        const evalResult = await h.evaluateProviderScript('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS);
        if (!evalResult?.result) return null;
        const parsed = parseMaybeJson(evalResult.result);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function getStateMessageCount(state: any): number {
    return Array.isArray(state?.messages) ? state.messages.length : 0;
}

function getStateLastSignature(state: any): string {
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    const last = messages[messages.length - 1];
    if (!last) return '';
    return `${last.role || ''}:${String(last.content || '').replace(/\s+/g, ' ').trim()}`;
}

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

async function getStableExtensionBaseline(h: CommandHelpers): Promise<any | null> {
    const first = await readExtensionChatState(h);
    if (getStateMessageCount(first) > 0 || getStateLastSignature(first)) return first;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await readExtensionChatState(h);
    return getStateMessageCount(second) >= getStateMessageCount(first) ? second : first;
}

async function verifyExtensionSendObserved(h: CommandHelpers, before: any): Promise<boolean> {
    const beforeCount = getStateMessageCount(before);
    const beforeSignature = getStateLastSignature(before);
    for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const state = await readExtensionChatState(h);
        if (state?.status === 'waiting_approval') return true;
        const afterCount = getStateMessageCount(state);
        const afterSignature = getStateLastSignature(state);
        if (afterCount > beforeCount) return true;
        if (afterSignature && afterSignature !== beforeSignature) return true;
    }
    return false;
}

export async function handleChatHistory(h: CommandHelpers, args: any): Promise<CommandResult> {
    const { agentType, offset, limit } = args;
    const historySessionId = getHistorySessionId(h, args);
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
        const workspace = typeof args?.workspace === 'string'
            ? args.workspace
            : typeof (h.currentSession as any)?.workspace === 'string'
                ? (h.currentSession as any).workspace
                : undefined;
        const result = readProviderChatHistory(agentStr, {
            canonicalHistory: provider?.canonicalHistory,
            historySessionId,
            workspace,
            offset: offset || 0,
            limit: limit || 30,
            excludeRecentCount,
            historyBehavior: provider?.historyBehavior,
            scripts: provider?.scripts as any,
        });
        return { success: true, ...result, agent: agentStr };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleReadChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType || args?.providerType);
    const transport = getTargetTransport(h, provider);
    const historySessionId = getHistorySessionId(h, args);

    const _log = (msg: string) => LOG.debug('Command', `[read_chat] ${msg}`);

    // PTY / ACP transport: read from adapter
    if (isCliLikeTransport(transport)) {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        if (adapter) {
            _log(`${transport} adapter: ${adapter.cliType}`);
            if (typeof adapter.getScriptParsedStatus !== 'function') {
                return { success: false, error: `${transport} adapter parseSession unavailable` };
            }
            let parsedStatus: any = null;
            try {
                parsedStatus = parseMaybeJson(adapter.getScriptParsedStatus());
            } catch (error: any) {
                return { success: false, error: error?.message || String(error) };
            }
            const parsedRecord = parsedStatus && typeof parsedStatus === 'object'
                ? parsedStatus as Record<string, any>
                : null;
            if (!parsedRecord || !Array.isArray(parsedRecord.messages)) {
                return { success: false, error: `${transport} parser did not return messages` };
            }
            const adapterStatus = typeof adapter.getStatus === 'function'
                ? adapter.getStatus()
                : {};
            const title = typeof parsedRecord.title === 'string' ? parsedRecord.title : undefined;
            const providerSessionId = typeof parsedRecord.providerSessionId === 'string'
                ? parsedRecord.providerSessionId
                : undefined;
            const transcriptAuthority = parsedRecord.transcriptAuthority === 'provider' || parsedRecord.transcriptAuthority === 'daemon'
                ? parsedRecord.transcriptAuthority
                : undefined;
            const coverage = parsedRecord.coverage === 'full' || parsedRecord.coverage === 'tail' || parsedRecord.coverage === 'current-turn'
                ? parsedRecord.coverage
                : undefined;
            const activeModal = parsedRecord.activeModal ?? parsedRecord.modal ?? null;
            const returnedStatus = normalizeCliReadChatStatus(parsedRecord.status, activeModal, adapter, adapterStatus, parsedRecord.messages);
            const runtimeMessageMerger = getTargetInstance(h, args) as RuntimeChatMessageMerger | null;
            const parsedMessages = finalizeStreamingMessagesWhenIdle(parsedRecord.messages as ChatMessage[], returnedStatus);
            const returnedMessages = runtimeMessageMerger?.category === 'cli'
                && runtimeMessageMerger.type === adapter.cliType
                && typeof runtimeMessageMerger.mergeRuntimeChatMessages === 'function'
                ? runtimeMessageMerger.mergeRuntimeChatMessages(parsedMessages)
                : parsedMessages;
            const providerType = provider?.type || adapter.cliType;
            let selectedMessages = returnedMessages;
            let selectedTitle = title;
            let selectedProviderSessionId = providerSessionId;
            let selectedTranscriptAuthority = transcriptAuthority;
            let selectedCoverage = coverage;
            let messageSource = buildCliMessageSourceProvenance({
                selected: 'pty-parser',
                provider: adapter.cliType,
                fallbackReason: supportsCliNativeTranscript(providerType, provider) ? 'native_history_not_checked' : 'provider_native_transcript_not_supported',
                ptyMessages: returnedMessages,
                returnedMessages,
                ptyStatusApprovalOnly: false,
            });

            if (supportsCliNativeTranscript(providerType, provider) && isNativeSourceCanonicalHistory(provider?.canonicalHistory)) {
                const agentStr = provider?.type || args?.agentType || getCurrentProviderType(h, adapter.cliType);
                const workspace = typeof args?.workspace === 'string'
                    ? args.workspace
                    : typeof (h.currentSession as any)?.workspace === 'string'
                        ? (h.currentSession as any).workspace
                        : typeof adapter.workingDir === 'string'
                            ? adapter.workingDir
                            : undefined;
                const nativeHistoryLimit = Math.max(
                    normalizeReadChatTailLimit(args) || 0,
                    returnedMessages.length,
                    200,
                );
                const nativeHistorySessionId = resolveCliNativeHistorySessionId(args, historySessionId, providerSessionId);
                const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
                const exactNativeHistoryScope = Boolean(
                    (typeof args?.historySessionId === 'string' && args.historySessionId.trim())
                    || (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
                    || providerSessionId
                    || (nativeHistorySessionId && nativeHistorySessionId !== targetSessionId)
                    || ((h.currentSession as any)?.sessionId === args?.targetSessionId && typeof (h.currentSession as any)?.providerSessionId === 'string' && (h.currentSession as any).providerSessionId.trim())
                );
                let nativeHistory: (ReturnType<typeof readProviderChatHistory> & { lookup?: 'session' | 'workspace' }) | null = null;
                try {
                    nativeHistory = readCliProviderNativeHistory(agentStr, {
                        canonicalHistory: provider?.canonicalHistory,
                        historySessionId: nativeHistorySessionId,
                        workspace,
                        offset: 0,
                        limit: nativeHistoryLimit,
                        excludeRecentCount: 0,
                        historyBehavior: provider?.historyBehavior,
                        scripts: provider?.scripts as any,
                        exactSessionScoped: exactNativeHistoryScope,
                    });
                } catch (error: any) {
                    const fallbackReason = `native_history_error:${error?.message || String(error)}`;
                    messageSource = buildCliMessageSourceProvenance({
                        selected: 'pty-parser',
                        provider: adapter.cliType,
                        fallbackReason,
                        ptyMessages: returnedMessages,
                        returnedMessages,
                        ptyStatusApprovalOnly: false,
                    });
                    nativeHistory = null;
                }

                if (nativeHistory) {
                    const nativeMessages = Array.isArray((nativeHistory as any).messages)
                        ? normalizeNativeHistoryMessages(agentStr, (nativeHistory as any).messages as ChatMessage[])
                        : [];
                    const historyProviderSessionId = typeof (nativeHistory as any)?.providerSessionId === 'string'
                        ? (nativeHistory as any).providerSessionId
                        : readHistorySessionIdFromMessages(nativeMessages) || nativeHistorySessionId || historySessionId;
                    const nativeHistoryCoverage = typeof (nativeHistory as any)?.nativeHistoryCoverage === 'string'
                        ? (nativeHistory as any).nativeHistoryCoverage
                        : undefined;
                    const partialReason = typeof (nativeHistory as any)?.partialReason === 'string'
                        ? (nativeHistory as any).partialReason
                        : undefined;
                    const unavailableReason = typeof (nativeHistory as any)?.unavailableReason === 'string'
                        ? (nativeHistory as any).unavailableReason
                        : undefined;
                    const lookup = (nativeHistory as any).lookup === 'workspace' ? 'workspace' : 'session';
                    const nativeHistorySessionForMapping = adapter.cliType === 'antigravity-cli'
                        && historyProviderSessionId
                        && nativeHistorySessionId
                        && historyProviderSessionId !== nativeHistorySessionId
                        ? undefined
                        : nativeHistorySessionId;
                    const safeMapping = hasSafeNativeHistoryMapping({
                        historySessionId: lookup === 'workspace' ? undefined : nativeHistorySessionForMapping,
                        providerSessionId: lookup === 'workspace' ? undefined : historyProviderSessionId || providerSessionId,
                        workspace,
                        nativeMessages,
                        ptyMessages: returnedMessages,
                        requireWorkspaceContentOverlap: lookup === 'workspace' && !exactNativeHistoryScope,
                    });
                    const freshEnough = isNativeHistoryFreshEnough({
                        sourceMtimeMs: (nativeHistory as any).sourceMtimeMs,
                        nativeMessages,
                        ptyMessages: returnedMessages,
                    });
                    if ((nativeHistory as any).source === 'provider-native' && nativeMessages.length > 0 && nativeHistoryCoverage !== 'partial' && nativeHistoryCoverage !== 'unavailable' && safeMapping && freshEnough) {
                        selectedMessages = finalizeStreamingMessagesWhenIdle(nativeMessages, returnedStatus);
                        selectedProviderSessionId = historyProviderSessionId || providerSessionId;
                        selectedTranscriptAuthority = 'provider';
                        selectedCoverage = (nativeHistory as any).hasMore ? 'tail' : 'full';
                        messageSource = buildCliMessageSourceProvenance({
                            selected: 'native-history',
                            provider: adapter.cliType,
                            nativeHandle: selectedProviderSessionId || nativeHistorySessionId || historySessionId,
                            nativeSource: (nativeHistory as any).source,
                            sourcePath: (nativeHistory as any).sourcePath,
                            sourceMtimeMs: (nativeHistory as any).sourceMtimeMs,
                            nativeHistoryCoverage,
                            partialReason,
                            unavailableReason,
                            nativeMessages,
                            ptyMessages: returnedMessages,
                            returnedMessages: selectedMessages,
                            safeMapping,
                            freshEnough,
                            ptyStatusApprovalOnly: true,
                        });
                    } else {
                        const fallbackReason = buildNativeHistoryFallbackReason({
                            providerType,
                            provider,
                            nativeSource: (nativeHistory as any).source,
                            nativeHistoryCoverage,
                            nativeMessageCount: nativeMessages.length,
                            safeMapping,
                            freshEnough,
                        });
                        messageSource = buildCliMessageSourceProvenance({
                            selected: 'pty-parser',
                            provider: adapter.cliType,
                            nativeHandle: historyProviderSessionId || nativeHistorySessionId || historySessionId,
                            fallbackReason,
                            nativeSource: (nativeHistory as any).source,
                            sourcePath: (nativeHistory as any).sourcePath,
                            sourceMtimeMs: (nativeHistory as any).sourceMtimeMs,
                            nativeHistoryCoverage,
                            partialReason,
                            unavailableReason,
                            nativeMessages,
                            ptyMessages: returnedMessages,
                            returnedMessages,
                            safeMapping,
                            freshEnough,
                            ptyStatusApprovalOnly: false,
                        });
                    }
                }
            }
            LOG.debug('Command', `[read_chat] cli-like parsed provider=${adapter.cliType} target=${String(args?.targetSessionId || '')} adapterStatus=${String(adapterStatus.status || '')} parsedStatus=${String(parsedRecord.status || '')} parsedMsgCount=${parsedRecord.messages.length} returnedMsgCount=${returnedMessages.length}`);
            return buildReadChatCommandResult({
                messages: selectedMessages,
                status: returnedStatus,
                activeModal,
                messageSource,
                transcriptProvenance: messageSource,
                debugReadChat: {
                    provider: adapter.cliType,
                    targetSessionId: String(args?.targetSessionId || ''),
                    adapterStatus: String(adapterStatus.status || ''),
                    parsedStatus: String(parsedRecord.status || ''),
                    returnedStatus: String(returnedStatus || ''),
                    selectedMessageSource: (messageSource as any).selected,
                    messageSource,
                    shouldPreferAdapterMessages: supportsCliNativeTranscript(providerType, provider)
                        && isNativeSourceCanonicalHistory(provider?.canonicalHistory)
                        && (messageSource as any).selected !== 'native-history'
                        && typeof (messageSource as any).fallbackReason === 'string'
                        && (messageSource as any).fallbackReason.startsWith('native_history_')
                        && (messageSource as any).fallbackReason !== 'native_history_not_checked'
                        && !(selectedTranscriptAuthority === 'provider' && selectedCoverage === 'full'),
                    parsedMsgCount: parsedRecord.messages.length,
                    returnedMsgCount: selectedMessages.length,
                },
                ...(selectedTitle ? { title: selectedTitle } : {}),
                ...(selectedProviderSessionId ? { providerSessionId: selectedProviderSessionId } : {}),
                ...(selectedTranscriptAuthority ? { transcriptAuthority: selectedTranscriptAuthority } : {}),
                ...(selectedCoverage ? { coverage: selectedCoverage } : {}),
            }, args);
        }
        const historyLimit = normalizeReadChatTailLimit(args);
        try {
            const agentStr = provider?.type || args?.agentType || getCurrentProviderType(h);
            const workspace = typeof args?.workspace === 'string'
                ? args.workspace
                : typeof (h.currentSession as any)?.workspace === 'string'
                    ? (h.currentSession as any).workspace
                    : undefined;
            const exactNativeHistoryScope = Boolean(
                (typeof args?.targetSessionId === 'string' && args.targetSessionId.trim())
                || (typeof args?.historySessionId === 'string' && args.historySessionId.trim())
                || (typeof args?.providerSessionId === 'string' && args.providerSessionId.trim())
                || ((h.currentSession as any)?.sessionId === args?.targetSessionId && typeof (h.currentSession as any)?.providerSessionId === 'string' && (h.currentSession as any).providerSessionId.trim())
            );
            const history = supportsCliNativeTranscript(agentStr, provider) && isNativeSourceCanonicalHistory(provider?.canonicalHistory)
                ? readCliProviderNativeHistory(agentStr, {
                    canonicalHistory: provider?.canonicalHistory,
                    historySessionId,
                    workspace,
                    offset: 0,
                    limit: historyLimit,
                    excludeRecentCount: 0,
                    historyBehavior: provider?.historyBehavior,
                    scripts: provider?.scripts as any,
                    exactSessionScoped: exactNativeHistoryScope,
                })
                : readProviderChatHistory(agentStr, {
                canonicalHistory: provider?.canonicalHistory,
                historySessionId,
                workspace,
                offset: 0,
                limit: historyLimit,
                excludeRecentCount: 0,
                historyBehavior: provider?.historyBehavior,
                scripts: provider?.scripts as any,
            });
            const lookup = (history as any).lookup === 'workspace' ? 'workspace' : 'session';
            const historyMessages = Array.isArray((history as any)?.messages)
                ? normalizeNativeHistoryMessages(agentStr, (history as any).messages as ChatMessage[])
                : [];
            const historyProviderSessionId = typeof (history as any)?.providerSessionId === 'string'
                ? (history as any).providerSessionId
                : readHistorySessionIdFromMessages(historyMessages) || historySessionId;
            const nativeHistoryCoverage = typeof (history as any)?.nativeHistoryCoverage === 'string'
                ? (history as any).nativeHistoryCoverage
                : undefined;
            const partialReason = typeof (history as any)?.partialReason === 'string'
                ? (history as any).partialReason
                : undefined;
            const unavailableReason = typeof (history as any)?.unavailableReason === 'string'
                ? (history as any).unavailableReason
                : undefined;
            const safeMapping = supportsCliNativeTranscript(agentStr, provider)
                ? hasSafeNativeHistoryMapping({
                    historySessionId: lookup === 'workspace' ? undefined : historySessionId,
                    providerSessionId: lookup === 'workspace' ? undefined : historyProviderSessionId,
                    workspace,
                    nativeMessages: historyMessages,
                })
                : false;
            const nativeSelected = supportsCliNativeTranscript(agentStr, provider)
                && (history as any).source === 'provider-native'
                && historyMessages.length > 0
                && nativeHistoryCoverage !== 'partial'
                && nativeHistoryCoverage !== 'unavailable'
                && safeMapping;
            const messageSource = buildCliMessageSourceProvenance({
                selected: nativeSelected ? 'native-history' : 'pty-parser',
                provider: agentStr,
                nativeHandle: historyProviderSessionId || historySessionId,
                fallbackReason: nativeSelected
                    ? undefined
                    : buildNativeHistoryFallbackReason({
                        providerType: agentStr,
                        provider,
                        nativeSource: (history as any).source,
                        nativeHistoryCoverage,
                        nativeMessageCount: historyMessages.length,
                        safeMapping,
                        freshEnough: true,
                    }),
                nativeSource: (history as any).source,
                sourcePath: (history as any).sourcePath,
                sourceMtimeMs: (history as any).sourceMtimeMs,
                nativeHistoryCoverage,
                partialReason,
                unavailableReason,
                nativeMessages: historyMessages,
                returnedMessages: historyMessages,
                safeMapping,
                freshEnough: true,
                ptyStatusApprovalOnly: false,
            });
            const requiresNativeSource = supportsCliNativeTranscript(agentStr, provider)
                && isNativeSourceCanonicalHistory(provider?.canonicalHistory);
            if (requiresNativeSource && !nativeSelected) {
                return {
                    success: false,
                    code: 'native_history_not_safely_available',
                    error: 'Provider-native history was not safely available for the requested CLI session.',
                    providerSessionId: historyProviderSessionId,
                    messageSource,
                    transcriptProvenance: messageSource,
                };
            }
            return buildReadChatCommandResult({
                messages: historyMessages,
                status: 'idle',
                messageSource,
                transcriptProvenance: messageSource,
                ...(typeof (history as any)?.title === 'string' ? { title: (history as any).title } : {}),
                ...(historyProviderSessionId ? { providerSessionId: historyProviderSessionId } : {}),
                ...(((provider?.historyBehavior as any)?.transcriptAuthority === 'provider' || (provider?.historyBehavior as any)?.transcriptAuthority === 'daemon')
                    ? { transcriptAuthority: (provider?.historyBehavior as any).transcriptAuthority }
                    : {}),
                coverage: 'tail',
            }, args);
        } catch (error: any) {
            return { success: false, error: error?.message || `${transport} adapter not found` };
        }
    }

    // Extension transport: evaluateInSession
    if (isExtensionTransport(transport)) {
        let extensionReadChatError = '';
        try {
            const evalResult = await h.evaluateProviderScript('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') {
                    try {
                        parsed = JSON.parse(parsed);
                    } catch (e: any) {
                        extensionReadChatError = `extension read_chat parse failed: ${e?.message || String(e)}`;
                    }
                }
                if (parsed && typeof parsed === 'object') {
                    const validated = validateReadChatResultPayload(parsed, 'extension read_chat');
                    _log(`Extension OK: ${validated.messages?.length || 0} msgs`);
                    traceProviderEvent(args, 'provider', 'extension.read_chat.success', {
                        h,
                        provider,
                        payload: {
                            method: 'evaluateProviderScript',
                            result: evalResult.result,
                            parsed: validated,
                            messageCount: Array.isArray(validated.messages) ? validated.messages.length : 0,
                        },
                    });
                    h.historyWriter.appendNewMessages(
                        provider?.type || 'unknown_extension',
                        toHistoryPersistedMessages(normalizeReadChatMessages(validated)),
                        validated.title,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult(validated as Record<string, any>, args);
                }
                if (!extensionReadChatError) {
                    extensionReadChatError = 'extension read_chat returned a non-object payload';
                }
            } else {
                extensionReadChatError = 'extension read_chat returned no payload';
            }
        } catch (e: any) {
            extensionReadChatError = `extension read_chat failed: ${e?.message || String(e)}`;
            _log(`Extension error: ${e.message}`);
            traceProviderEvent(args, 'provider', 'extension.read_chat.error', {
                h,
                provider,
                level: 'warn',
                payload: { method: 'evaluateProviderScript', error: e.message },
            });
        }
        // Alternative: AgentStreamManager (script fail when)
        if (h.agentStream) {
            const cdp = h.getCdp();
            const parentSessionId = h.currentSession?.parentSessionId;
            if (cdp && parentSessionId) {
                const stream = await h.agentStream.collectActiveSession(cdp, parentSessionId);
                if (stream && stream.agentType !== provider?.type) {
                    return { success: false, error: `extension read_chat stream agent mismatch for ${provider?.type || 'unknown_extension'}` };
                }
                if (stream) {
                    h.historyWriter.appendNewMessages(
                        stream.agentType,
                        toHistoryPersistedMessages(stream.messages || []),
                        undefined,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult({
                        messages: stream.messages || [],
                        status: stream.status,
                        agentType: stream.agentType,
                    }, args);
                }
            }
        }
        return { success: false, error: extensionReadChatError || 'extension read_chat unavailable' };
    }

    // IDE category (default): cdp.evaluate
    const cdp = h.getCdp();
    if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };

    // webview IDE (Kiro, PearAI) → evaluateInWebviewFrame directly use
    const webviewScript = h.getProviderScript('webviewReadChat') || h.getProviderScript('webview_read_chat');
    if (webviewScript) {
        let webviewReadChatError = '';
        try {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText
                ? (body: string) => body.includes(matchText)
                : undefined;
            const raw = await cdp.evaluateInWebviewFrame(webviewScript, matchFn);
            if (raw) {
                let parsed: any = raw;
                if (typeof parsed === 'string') {
                    try {
                        parsed = JSON.parse(parsed);
                    } catch (e: any) {
                        webviewReadChatError = `webview read_chat parse failed: ${e?.message || String(e)}`;
                    }
                }
                if (parsed && typeof parsed === 'object') {
                    const validated = validateReadChatResultPayload(parsed, 'webview read_chat');
                    _log(`Webview OK: ${validated.messages?.length || 0} msgs`);
                    h.historyWriter.appendNewMessages(
                        provider?.type || getCurrentProviderType(h, 'unknown_webview'),
                        toHistoryPersistedMessages(normalizeReadChatMessages(validated)),
                        validated.title,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult(validated as Record<string, any>, args);
                }
                if (!webviewReadChatError) {
                    webviewReadChatError = 'webview read_chat returned a non-object payload';
                }
            } else {
                webviewReadChatError = 'webview read_chat returned no payload';
            }
        } catch (e: any) {
            webviewReadChatError = `webview read_chat failed: ${e?.message || String(e)}`;
            _log(`Webview readChat error: ${e.message}`);
        }
        return { success: false, error: webviewReadChatError || 'webview read_chat unavailable' };
    }

    // Regular IDE (Cursor, Windsurf, Trae etc) → main DOM evaluate
    const script = h.getProviderScript('readChat') || h.getProviderScript('read_chat');
    if (script) {
        let ideReadChatError = '';
        try {
            const evalResult = await h.evaluateProviderScript('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS);
            if (evalResult?.result) {
                let parsed: any = evalResult.result;
                if (typeof parsed === 'string') {
                    try {
                        parsed = JSON.parse(parsed);
                    } catch (e: any) {
                        ideReadChatError = `ide read_chat parse failed: ${e?.message || String(e)}`;
                    }
                }
                if (parsed && typeof parsed === 'object') {
                    const validated = validateReadChatResultPayload(parsed, 'ide read_chat');
                    _log(`OK: ${validated.messages?.length || 0} msgs`);
                    traceProviderEvent(args, 'provider', 'ide.read_chat.success', {
                        h,
                        provider,
                        payload: {
                            method: 'evaluate',
                            result: evalResult.result,
                            parsed: validated,
                            messageCount: Array.isArray(validated.messages) ? validated.messages.length : 0,
                        },
                    });
                    h.historyWriter.appendNewMessages(
                        provider?.type || getCurrentProviderType(h, 'unknown_ide'),
                        toHistoryPersistedMessages(normalizeReadChatMessages(validated)),
                        validated.title,
                        args?.targetSessionId,
                        historySessionId,
                    );
                    return buildReadChatCommandResult(validated as Record<string, any>, args);
                }
                if (!ideReadChatError) {
                    ideReadChatError = 'ide read_chat returned a non-object payload';
                }
            } else {
                ideReadChatError = 'ide read_chat returned no payload';
            }
        } catch (e: any) {
            ideReadChatError = `ide read_chat failed: ${e?.message || String(e)}`;
            LOG.info('Command', `[read_chat] Script error: ${e.message}`);
            traceProviderEvent(args, 'provider', 'ide.read_chat.error', {
                h,
                provider,
                level: 'warn',
                payload: { method: 'evaluate', error: e.message },
            });
        }
        return { success: false, error: ideReadChatError || 'ide read_chat unavailable' };
    }

    return { success: false, error: 'read_chat unavailable' };
}

export async function handleSendChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const input = getSendChatInputEnvelope(args);
    const text = input.textFallback;
    const hasInput = input.parts.length > 0 || (typeof text === 'string' && text.trim().length > 0);
    if (!hasInput) return { success: false, error: 'input required' };
    const _log = (msg: string) => LOG.debug('Command', `[send_chat] ${msg}`);
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const dedupeKey = buildRecentSendKey(h, args, provider, buildSendInputSignature(input));

    const _logSendSuccess = (method: string, targetAgent?: string) => {
        // Sending and transcript persistence are intentionally decoupled.
        // User turns should reach history through read_chat/runtime transcript sync,
        // not by eagerly appending the outgoing input here.
        return { success: true, sent: true, method, targetAgent };
    };

    if (isRecentDuplicateSend(dedupeKey)) {
        _log(`Suppressed duplicate send for ${dedupeKey}`);
        return { success: true, sent: false, deduplicated: true };
    }

    if (transport === 'acp') {
        const target = getTargetInstance(h, args);
        if (!target || target.category !== 'acp') {
            return { success: false, error: `ACP instance not found for ${provider?.type || args?.agentType || 'unknown'}` };
        }
        try {
            assertProviderSupportsDeclaredInput(provider, input);
            target.onEvent('send_message', { input });
            return _logSendSuccess('acp-instance', target.type);
        } catch (e: any) {
            return { success: false, error: `acp send failed: ${e.message}` };
        }
    }

    // PTY transport: route structured input through the provider instance so
    // provider-specific CLI attachment strategies (for example Hermes file-path
    // image prompts) are applied instead of collapsing everything to text.
    if (transport === 'pty') {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        if (adapter) {
            _log(`${transport} adapter: ${adapter.cliType}`);
            try {
                const hasStructuredParts = input.parts.some((part) => part.type !== 'text');
                if (hasStructuredParts) {
                    const target = getTargetInstance(h, args);
                    if (!target || target.category !== 'cli') {
                        return { success: false, error: `CLI instance not found for ${provider?.type || args?.agentType || 'unknown'}` };
                    }
                    assertProviderSupportsDeclaredInput(provider, input);
                    await waitOnceForFreshHermesCliStart(adapter, _log);
                    target.onEvent('send_message', { input });
                    return _logSendSuccess(`${transport}-instance`, target.type);
                }
                assertTextOnlyInput(provider, input);
                if (!text) return { success: false, error: 'text required for PTY send' };
                await waitOnceForFreshHermesCliStart(adapter, _log);
                await adapter.sendMessage(text);
                return _logSendSuccess(`${transport}-adapter`, adapter.cliType);
            } catch (e: any) {
                return { success: false, error: `${transport} send failed: ${e.message}` };
            }
        }
    }

    assertTextOnlyInput(provider, input);
    if (!text) return { success: false, error: 'text required' };

    // Extension transport: via AgentStreamManager
    if (isExtensionTransport(transport)) {
        _log(`Extension: ${provider?.type || 'unknown_extension'}`);
        // Method 1: provider sendMessage script via evaluateInSession
        try {
            const beforeState = await getStableExtensionBaseline(h);
            const evalResult = await h.evaluateProviderScript('sendMessage', { message: text }, 30000);
            if (evalResult?.result) {
                const parsed = parseMaybeJson(evalResult.result);
                if (didProviderConfirmSend(parsed)) {
                    const observed = await verifyExtensionSendObserved(h, beforeState);
                    if (observed) {
                        _log(`Extension script sent OK`);
                        return _logSendSuccess('extension-script');
                    }
                    _log(`Extension script reported send but no chat-state change was observed`);
                }
                if (parsed?.needsTypeAndSend) {
                    _log(`Extension needsTypeAndSend → AgentStreamManager`);
                }
            }
        } catch (e: any) {
            _log(`Extension script error: ${e.message}`);
        }
        // Method 2: AgentStreamManager
        const extensionSessionId = h.currentSession?.sessionId;
        if (h.agentStream && h.getCdp() && extensionSessionId) {
            const ok = await h.agentStream.sendToSession(h.getCdp()!, extensionSessionId, text);
            if (ok) {
                _log(`AgentStreamManager sent OK`);
                return _logSendSuccess('agent-stream');
            }
        }
        return { success: false, error: `Extension '${provider?.type || 'unknown_extension'}' send failed` };
    }

    // IDE category (default): provider sendMessage script is authoritative when present.
    const targetCdp = h.getCdp();
    if (!targetCdp?.isConnected) {
        const managerKey = getCurrentManagerKey(h);
        _log(`No CDP for ${managerKey}`);
        return { success: false, error: `CDP for ${managerKey || 'unknown'} not connected` };
    }

    _log(`Targeting IDE: ${getCurrentManagerKey(h)}`);
    const sendScript = h.getProviderScript('sendMessage', { message: text });
    if (sendScript) {
        try {
            const result = await targetCdp.evaluate(sendScript, 30000);
            const parsed: any = parseMaybeJson(result);
            if (didProviderConfirmSend(parsed)) {
                _log(`sendMessage script OK`);
                return _logSendSuccess('script');
            }
            if (parsed?.needsTypeAndSend && parsed?.selector) {
                try {
                    const sent = await targetCdp.typeAndSend(parsed.selector, text);
                    if (sent) {
                        _log(`typeAndSend(script.selector=${parsed.selector}) success`);
                        return _logSendSuccess('typeAndSend-script');
                    }
                } catch (e: any) {
                    _log(`typeAndSend(script.selector) failed: ${e.message}`);
                }
            }
            if (parsed?.needsTypeAndSend && parsed?.clickCoords) {
                try {
                    const { x, y } = parsed.clickCoords;
                    const sent = await targetCdp.typeAndSendAt(x, y, text);
                    if (sent) {
                        _log(`typeAndSendAt(${x},${y}) success`);
                        return _logSendSuccess('typeAndSendAt-script');
                    }
                } catch (e: any) {
                    _log(`typeAndSendAt failed: ${e.message}`);
                }
            }
            if (parsed?.needsTypeAndSend && provider?.inputMethod === 'cdp-type-and-send' && provider.inputSelector) {
                try {
                    const sent = await targetCdp.typeAndSend(provider.inputSelector, text);
                    if (sent) {
                        _log(`typeAndSend(provider.inputSelector=${provider.inputSelector}) success`);
                        return _logSendSuccess('typeAndSend-provider');
                    }
                } catch (e: any) {
                    _log(`typeAndSend(provider) failed: ${e.message}`);
                }
            }
            if (parsed?.needsTypeAndSend && provider?.webviewMatchText && provider?.scripts?.webviewSendMessage) {
                try {
                    const webviewScript = callLegacyTextScript(provider.scripts.webviewSendMessage, text);
                    if (webviewScript && targetCdp.evaluateInWebviewFrame) {
                        const matchText = provider.webviewMatchText;
                        const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                        const wvResult = await targetCdp.evaluateInWebviewFrame(webviewScript, matchFn);
                        const wvParsed: any = parseMaybeJson(wvResult);
                        if (didProviderConfirmSend(wvParsed)) {
                            _log(`webviewSendMessage OK`);
                            return _logSendSuccess('webview-script');
                        }
                    }
                } catch (e: any) {
                    _log(`webviewSendMessage failed: ${e.message}`);
                }
            }
            return { success: false, error: parsed?.error || 'Provider sendMessage did not confirm send' };
        } catch (e: any) {
            _log(`sendMessage script failed: ${e.message}`);
            return { success: false, error: `Provider sendMessage failed: ${e.message}` };
        }
    }

    if (provider?.webviewMatchText && provider?.scripts?.webviewSendMessage) {
        try {
            const webviewScript = callLegacyTextScript(provider.scripts.webviewSendMessage, text);
            if (webviewScript && targetCdp.evaluateInWebviewFrame) {
                const matchText = provider.webviewMatchText;
                const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                const wvResult = await targetCdp.evaluateInWebviewFrame(webviewScript, matchFn);
                const wvParsed: any = parseMaybeJson(wvResult);
                if (didProviderConfirmSend(wvParsed)) {
                    _log(`webviewSendMessage OK`);
                    return _logSendSuccess('webview-script');
                }
            }
        } catch (e: any) {
            _log(`webviewSendMessage failed: ${e.message}`);
        }
    }

    if (provider?.inputMethod === 'cdp-type-and-send' && provider.inputSelector) {
        try {
            const sent = await targetCdp.typeAndSend(provider.inputSelector, text);
            if (sent) {
                _log(`typeAndSend(provider.inputSelector=${provider.inputSelector}) success`);
                return _logSendSuccess('typeAndSend-provider');
            }
        } catch (e: any) {
            _log(`typeAndSend(provider) failed: ${e.message}`);
        }
    }

    _log('All methods failed');
    return { success: false, error: 'No provider method could send the message' };
}

export async function handleListChats(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);

    // Extension transport: via AgentStreamManager
    if (isExtensionTransport(transport) && h.agentStream && h.getCdp() && h.currentSession?.sessionId) {
        try {
            const chats = await h.agentStream.listSessionChats(h.getCdp()!, h.currentSession.sessionId);
            LOG.info('Command', `[list_chats] Extension: ${chats.length} chats`);
            return { success: true, chats };
        } catch (e: any) {
            LOG.info('Command', `[list_chats] Extension error: ${e.message}`);
        }
    }

    // webview IDE
    try {
        const webviewScript = h.getProviderScript('webviewListSessions') || h.getProviderScript('webview_list_sessions');
        if (webviewScript) {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
            const raw = await h.getCdp()?.evaluateInWebviewFrame?.(webviewScript, matchFn);
            let parsed: any = raw;
            if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
            if (parsed?.sessions) {
                LOG.info('Command', `[list_chats] Webview OK: ${parsed.sessions.length} chats`);
                return { success: true, chats: parsed.sessions };
            }
        }
    } catch (e: any) {
        LOG.info('Command', `[list_chats] Webview error: ${e.message}`);
    }

    // IDE/default: evaluateProviderScript
    try {
        const evalResult = await h.evaluateProviderScript('listSessions');
        if (evalResult) {
            let parsed = evalResult.result;
            if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
            if (parsed?.sessions && Array.isArray(parsed.sessions)) {
                LOG.info('Command', `[list_chats] OK: ${parsed.sessions.length} chats`);
                return { success: true, chats: parsed.sessions };
            }
            if (parsed?.chats && Array.isArray(parsed.chats)) {
                LOG.info('Command', `[list_chats] OK: ${parsed.chats.length} chats`);
                return { success: true, chats: parsed.chats };
            }
            if (Array.isArray(parsed)) {
                LOG.info('Command', `[list_chats] OK: ${parsed.length} chats`);
                return { success: true, chats: parsed };
            }
        }
    } catch (e: any) {
        LOG.info('Command', `[list_chats] error: ${e.message}`);
    }

    return { success: false, error: 'listSessions script not available for this provider' };
}

export async function handleNewChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);

    if (transport === 'pty') {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        if (!adapter) return { success: false, error: 'CLI adapter not running' };
        if (typeof adapter.clearHistory === 'function') {
            adapter.clearHistory();
            return { success: true, cleared: true };
        }
        return { success: false, error: 'new_chat not supported by this CLI provider' };
    }

    if (isExtensionTransport(transport) && h.agentStream && h.getCdp() && h.currentSession?.sessionId) {
        const ok = await h.agentStream.newSession(h.getCdp()!, h.currentSession.sessionId);
        return { success: ok };
    }

    // webview IDE
    try {
        const webviewScript = h.getProviderScript('webviewNewSession') || h.getProviderScript('webview_new_session');
        if (webviewScript) {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
            const raw = await h.getCdp()?.evaluateInWebviewFrame?.(webviewScript, matchFn);
            if (raw) return { success: true, result: raw };
        }
    } catch (e: any) {
        return { success: false, error: `webviewNewSession failed: ${e.message}` };
    }

    try {
        const evalResult = await h.evaluateProviderScript('newSession');
        if (evalResult) return { success: true };
    } catch (e: any) {
        return { success: false, error: `newSession failed: ${e.message}` };
    }

    return { success: false, error: 'newSession script not available for this provider' };
}

export async function handleSwitchChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const managerKey = getCurrentManagerKey(h);
    const sessionId = args?.sessionId || args?.id || args?.chatId;
    if (!sessionId) return { success: false, error: 'sessionId required' };
    LOG.info('Command', `[switch_chat] sessionId=${sessionId}, manager=${managerKey}`);

    if (isExtensionTransport(transport) && h.agentStream && h.getCdp() && h.currentSession?.sessionId) {
        const ok = await h.agentStream.switchConversation(h.getCdp()!, h.currentSession.sessionId, sessionId);
        return { success: ok, result: ok ? 'switched' : 'failed' };
    }

    const cdp = h.getCdp(managerKey);
    if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };

    // webview IDE
    try {
        const webviewScript = h.getProviderScript('webviewSwitchSession', { SESSION_ID: JSON.stringify(sessionId) });
        if (webviewScript) {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
            const raw = await cdp.evaluateInWebviewFrame?.(webviewScript, matchFn);
            if (raw) return { success: true, result: raw };
        }
    } catch (e: any) {
        return { success: false, error: `webviewSwitchSession failed: ${e.message}` };
    }

    const switchParams = {
        sessionId,
        title: sessionId,
        id: sessionId,
        SESSION_ID: JSON.stringify(sessionId),
    };
    const script = h.getProviderScript('switchSession', switchParams)
        || h.getProviderScript('switch_session', switchParams);
    if (!script) return { success: false, error: 'switch_session script not available' };

    try {
        const raw = await cdp.evaluate(script, 15000);
        LOG.info('Command', `[switch_chat] result: ${raw}`);

        let parsed: any = null;
        try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { }

        if (parsed?.action === 'click' && parsed.clickX && parsed.clickY) {
            const x = Math.round(parsed.clickX);
            const y = Math.round(parsed.clickY);
            LOG.info('Command', `[switch_chat] CDP click at (${x}, ${y}) for "${parsed.title}"`);
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button: 'left', clickCount: 1
            });
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, button: 'left', clickCount: 1
            });
            await new Promise(r => setTimeout(r, 2000));

            // Auto-handle workspace selection dialog
            const wsResult = await cdp.evaluate(`
                (() => {
                    const inp = Array.from(document.querySelectorAll('input[type="text"]'))
                        .find(i => i.offsetWidth > 0 && (i.placeholder || '').includes('Select where'));
                    if (!inp) return null;
                    const rows = inp.closest('[class*="quickInput"]')?.querySelectorAll('[class*="cursor-pointer"]');
                    if (rows && rows.length > 0) {
                        const r = rows[0].getBoundingClientRect();
                        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
                    }
                    return null;
                })()
            `, 5000);
            if (wsResult) {
                try {
                    const ws = JSON.parse(wsResult as string);
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: ws.x, y: ws.y, button: 'left', clickCount: 1
                    });
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x: ws.x, y: ws.y, button: 'left', clickCount: 1
                    });
                } catch { }
            }
            return { success: true, result: 'switched' };
        }

        if (parsed?.error) return { success: false, error: parsed.error };
        return { success: true, result: raw };
    } catch (e: any) {
        LOG.error('Command', `[switch_chat] error: ${e.message}`);
        return { success: false, error: e.message };
    }
}

export async function handleSetMode(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const mode = args?.mode || 'agent';

    // ACP transport
    if (transport === 'acp') {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        const acpInstance = adapter?._acpInstance;
        if (acpInstance && typeof acpInstance.setMode === 'function') {
                await acpInstance.setMode(mode);
                return { success: true, mode };
        }
        return { success: false, error: 'ACP adapter not found' };
    }

    // 1. webview setMode
    const webviewScript = h.getProviderScript('webviewSetMode', { MODE: JSON.stringify(mode) });
    if (webviewScript) {
        const cdp = h.getCdp();
        if (cdp?.isConnected) {
            try {
                const matchText = provider?.webviewMatchText;
                const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                const raw = await cdp.evaluateInWebviewFrame?.(webviewScript, matchFn);
                let result: any = raw;
                if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch { } }
                if (result?.success) return { success: true, mode, method: 'webview-script' };
            } catch (e: any) {
                LOG.info('Command', `[set_mode] webview script error: ${e.message}`);
            }
        }
    }

    // 2. main frame setMode
    const mainScript = h.getProviderScript('setMode', { MODE: JSON.stringify(mode) });
    if (mainScript) {
        try {
            const evalResult = await h.evaluateProviderScript('setMode', { MODE: JSON.stringify(mode) }, 15000);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed?.success) return { success: true, mode, method: 'script' };
            }
        } catch (e: any) {
            LOG.info('Command', `[set_mode] script error: ${e.message}`);
        }
    }

    return { success: false, error: `setMode '${mode}' not supported by this provider` };
}

export async function handleChangeModel(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const model = args?.model;

    LOG.info('Command', `[change_model] model=${model} provider=${provider?.type} transport=${transport} manager=${getCurrentManagerKey(h)} providerType=${getCurrentProviderType(h)}`);

    // ACP transport
    if (transport === 'acp') {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        LOG.info('Command', `[change_model] ACP adapter found: ${!!adapter}, type=${adapter?.cliType}, hasAcpInstance=${!!adapter?._acpInstance}`);
        const acpInstance = adapter?._acpInstance;
        if (acpInstance && typeof acpInstance.setConfigOption === 'function') {
                await acpInstance.setConfigOption('model', model);
                LOG.info('Command', `[change_model] Updated ACP model to ${model}`);
                return { success: true, model };
        }
        return { success: false, error: 'ACP adapter not found' };
    }

    // 1. webview setModel
    const webviewScript = h.getProviderScript('webviewSetModel', { MODEL: JSON.stringify(model) });
    if (webviewScript) {
        const cdp = h.getCdp();
        if (cdp?.isConnected) {
            try {
                const matchText = provider?.webviewMatchText;
                const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                const raw = await cdp.evaluateInWebviewFrame?.(webviewScript, matchFn);
                let result: any = raw;
                if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch { } }
                if (result?.success) return { success: true, model, method: 'webview-script' };
            } catch (e: any) {
                LOG.info('Command', `[change_model] webview script error: ${e.message}`);
            }
        }
    }

    // 2. main frame setModel
    const mainScript = h.getProviderScript('setModel', { MODEL: JSON.stringify(model) });
    if (mainScript) {
        try {
            const evalResult = await h.evaluateProviderScript('setModel', { MODEL: JSON.stringify(model) }, 15000);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed?.success) return { success: true, model, method: 'script' };
            }
        } catch (e: any) {
            LOG.info('Command', `[change_model] script error: ${e.message}`);
        }
    }

    return { success: false, error: 'changeModel not supported by this IDE provider' };
}

export async function handleSetThoughtLevel(h: CommandHelpers, args: any): Promise<CommandResult> {
    const configId = args?.configId;
    const value = args?.value;
    if (!configId || !value) return { success: false, error: 'configId and value required' };

    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    if (transport !== 'acp') {
        return { success: false, error: 'set_thought_level only for ACP providers' };
    }
    const adapter = getTargetedCliAdapter(h, args, provider?.type);
    const acpInstance = adapter?._acpInstance;
    if (!acpInstance) return { success: false, error: 'ACP instance not found' };
    if (typeof acpInstance.setConfigOption !== 'function') {
        return { success: false, error: 'ACP setConfigOption not available' };
    }

    try {
        await acpInstance.setConfigOption(configId, value);
        LOG.info('Command', `[set_thought_level] ${configId}=${value} for ${provider?.type || 'unknown_acp'}`);
        return { success: true, configId, value };
    } catch (e: any) {
        return { success: false, error: e?.message };
    }
}

export async function handleResolveAction(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const action = args?.action || 'approve';
    const button = args?.button || args?.buttonText
        || (action === 'approve' ? 'Accept' : action === 'reject' ? 'Reject' : 'Accept');

    LOG.info('Command', `[resolveAction] action=${action} button="${button}" provider=${provider?.type}`);

    // 0. PTY transport: navigate approval dialog via PTY arrow keys + Enter
    if (transport === 'pty') {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        if (!adapter) return { success: false, error: 'CLI adapter not running' };

        // Handle data-driven resolve actions (like from the dashboard 'Fix' button)
        if (args?.data && typeof adapter.resolveAction === 'function') {
            try {
                await adapter.resolveAction(args.data);
                LOG.info('Command', `[resolveAction] CLI PTY → resolveAction triggered with data payload`);
                return { success: true, method: 'cli-resolve-action' };
            } catch (e: any) {
                return { success: false, error: `CLI resolveAction failed: ${e.message}` };
            }
        }

        const status = adapter.getStatus();
        const targetInstance = getTargetInstance(h, args);
        const targetState = targetInstance?.getState?.() as { activeChat?: { status?: string; activeModal?: { message?: string; buttons?: string[] } | null } } | undefined;
        const surfacedModal = targetState?.activeChat?.activeModal && Array.isArray(targetState.activeChat.activeModal.buttons)
            && targetState.activeChat.activeModal.buttons.some((candidate) => typeof candidate === 'string' && candidate.trim())
            ? targetState.activeChat.activeModal
            : null;
        const statusModal = status?.activeModal && Array.isArray(status.activeModal.buttons)
            && status.activeModal.buttons.some((candidate) => typeof candidate === 'string' && candidate.trim())
            ? status.activeModal
            : null;
        const parsedStatus = !statusModal && !surfacedModal && typeof adapter.getScriptParsedStatus === 'function'
            ? (() => {
                try {
                    return parseMaybeJson(adapter.getScriptParsedStatus());
                } catch {
                    return null;
                }
            })()
            : null;
        const parsedModal = parsedStatus?.status === 'waiting_approval'
            && parsedStatus?.activeModal
            && Array.isArray(parsedStatus.activeModal.buttons)
            && parsedStatus.activeModal.buttons.some((candidate: unknown) => typeof candidate === 'string' && candidate.trim())
            ? parsedStatus.activeModal
            : null;
        const effectiveModal = statusModal || surfacedModal || parsedModal;
        const effectiveStatus = status?.status === 'waiting_approval' || targetState?.activeChat?.status === 'waiting_approval' || parsedStatus?.status === 'waiting_approval'
            ? 'waiting_approval'
            : status?.status;
        LOG.info('Command', `[resolveAction] CLI PTY gate target=${String(args?.targetSessionId || '')} rawStatus=${String(status?.status || '')} effectiveStatus=${String(effectiveStatus || '')} statusModal=${statusModal ? 'yes' : 'no'} surfacedModal=${surfacedModal ? 'yes' : 'no'} parsedModal=${parsedModal ? 'yes' : 'no'} instance=${targetInstance ? 'yes' : 'no'}`);
        if (!effectiveModal) {
            return { success: false, error: 'Not in approval state' };
        }
        const buttons: string[] = Array.isArray(effectiveModal.buttons) ? effectiveModal.buttons : [];
        // Resolve button index: explicit buttonIndex arg → exact text match → explicit action mapping
        let buttonIndex = typeof args?.buttonIndex === 'number' ? args.buttonIndex : -1;
        if (buttonIndex < 0 && button) {
            const btnLower = button.toLowerCase();
            buttonIndex = buttons.findIndex(b => b.toLowerCase().includes(btnLower));
        }
        if (buttonIndex < 0 && (action === 'reject' || action === 'deny')) {
            buttonIndex = buttons.findIndex(b => /deny|reject|no/i.test(b));
        }
        if (buttonIndex < 0 && (action === 'always' || /always/i.test(button))) {
            buttonIndex = buttons.findIndex(b => /always/i.test(b));
        }
        if (buttonIndex < 0 && (action === 'approve' || action === 'accept')) {
            buttonIndex = pickApprovalButton(buttons, provider).index;
        }
        if (buttonIndex < 0) {
            return { success: false, error: 'Approval action did not match any visible button' };
        }
        if (typeof adapter.resolveModal === 'function') {
            adapter.resolveModal(buttonIndex);
        } else {
            const keys = '\x1B[B'.repeat(Math.max(0, buttonIndex)) + '\r';
            adapter.writeRaw?.(keys);
        }
        LOG.info('Command', `[resolveAction] CLI PTY → buttonIndex=${buttonIndex} "${buttons[buttonIndex] ?? '?'}"`);
        getTargetInstance(h, args)?.recordApprovalSelection?.(buttons[buttonIndex] ?? button);
        return { success: true, buttonIndex, button: buttons[buttonIndex] ?? button };
    }

    // 1. Extension transport: via AgentStreamManager
    if (isExtensionTransport(transport) && h.agentStream && h.getCdp() && h.currentSession?.sessionId) {
        const ok = await h.agentStream.resolveSessionAction(h.getCdp()!, h.currentSession.sessionId, action, button);
        return { success: ok };
    }

    // 1.5 ACP transport: resolve protocol permission request directly
    if (transport === 'acp') {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        const acpInstance = adapter?._acpInstance;
        if (!acpInstance) return { success: false, error: 'ACP instance not found' };
        if (typeof acpInstance.resolvePermission !== 'function') {
            return { success: false, error: 'ACP resolvePermission not available' };
        }

        try {
            await acpInstance.resolvePermission(action === 'approve' || action === 'accept' || action === 'always');
            LOG.info('Command', `[resolveAction] ACP → ${action}`);
            return { success: true, action };
        } catch (e: any) {
            return { success: false, error: e?.message || 'ACP resolve action failed' };
        }
    }

    // 2. Webview Provider script
    if (provider?.scripts?.webviewResolveAction || provider?.scripts?.webview_resolve_action) {
        const script = h.getProviderScript('webviewResolveAction', { action, button, buttonText: button })
            || h.getProviderScript('webview_resolve_action', { action, button, buttonText: button });
        if (script) {
            const cdp = h.getCdp();
            if (cdp?.isConnected) {
                try {
                    const matchText = provider?.webviewMatchText;
                    const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                    const raw = await cdp.evaluateInWebviewFrame?.(script, matchFn);
                    let result: any = raw;
                    if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch { } }
                    LOG.info('Command', `[resolveAction] webview script result: ${JSON.stringify(result)}`);

                    if (result?.resolved) return { success: true, clicked: result.clicked };
                    if (result?.found && result.x != null && result.y != null) {
                        LOG.info('Command', `[resolveAction] Webview coordinate click not fully supported via CDP. Click directly in script.`);
                    }
                    if (result?.found || result?.resolved) return { success: true };
                } catch (e: any) {
                    return { success: false, error: `webviewResolveAction failed: ${e.message}` };
                }
            }
        }
    }

    // 3. Provider script (Main DOM) → returns coords → CDP mouse click
    if (provider?.scripts?.resolveAction) {
        const script = provider.scripts.resolveAction({ action, button, buttonText: button });
        if (script) {
            const cdp = h.getCdp();
            if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };
            try {
                const raw = await cdp.evaluate(script, 30000);
                let result: any = raw;
                if (typeof raw === 'string') { try { result = JSON.parse(raw); } catch {} }
                LOG.info('Command', `[resolveAction] script result: ${JSON.stringify(result)}`);

                if (result?.resolved) {
                    LOG.info('Command', `[resolveAction] script-click resolved — "${result.clicked}"`);
                    return { success: true, clicked: result.clicked };
                }
                if (result?.found && result.x != null && result.y != null) {
                    const x = result.x;
                    const y = result.y;
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x, y, button: 'left', clickCount: 1
                    });
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
                    });
                    LOG.info('Command', `[resolveAction] CDP click at (${x}, ${y}) — "${result.text}"`);
                    return { success: true, clicked: result.text };
                }
                return { success: false, error: result?.found === false ? `Button not found: ${button}` : 'No coordinates' };
            } catch (e: any) {
                return { success: false, error: `resolveAction failed: ${e.message}` };
            }
        }
    }

    return { success: false, error: 'resolveAction script not available for this provider' };
}
