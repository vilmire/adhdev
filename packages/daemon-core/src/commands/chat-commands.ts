/**
 * Chat Commands — readChat, sendChat, listChats, newChat, switchChat,
 *                 setMode, changeModel, setThoughtLevel, resolveAction, chatHistory
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { flattenContent, normalizeInputEnvelope, type InputEnvelope, type ProviderModule, type ProviderScripts } from '../providers/contracts.js';
import { assertProviderSupportsDeclaredInput, assertTextOnlyInput } from '../providers/provider-input-support.js';
import { validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import type { ProviderInstance } from '../providers/provider-instance.js';
import { readChatHistory } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { buildChatMessageSignature } from '../chat/chat-signatures.js';
import type { ChatMessage } from '../types.js';
import type { ReadChatCursor, ReadChatSyncMode, SessionTransport } from '../shared-types.js';
import { normalizeChatMessages } from '../providers/chat-message-normalization.js';

const RECENT_SEND_WINDOW_MS = 1200;
const recentSendByTarget = new Map<string, number>();

interface ApprovalSelectableInstance extends ProviderInstance {
    recordApprovalSelection?(buttonText: string): void;
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

function getTargetInstance(h: CommandHelpers, args: any): ApprovalSelectableInstance | null {
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const sessionId = targetSessionId || h.currentSession?.sessionId || '';
    if (!sessionId) return null;
    return (h.ctx.instanceManager?.getInstance(sessionId) as ApprovalSelectableInstance | undefined) || null;
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

function buildSendInputSignature(input: InputEnvelope): string {
    const text = typeof input.textFallback === 'string' ? input.textFallback.trim() : '';
    if (text) return text;
    return JSON.stringify(input.parts || []);
}

function getSendChatInputEnvelope(args: any): InputEnvelope {
    return normalizeInputEnvelope(args?.input ? { input: args.input } : args);
}

function getHistorySessionId(h: CommandHelpers, args: any): string | undefined {
    const explicit = typeof args?.historySessionId === 'string' ? args.historySessionId.trim() : '';
    if (explicit) return explicit;

    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!targetSessionId) return undefined;

    const instance = h.ctx.instanceManager?.getInstance(targetSessionId);
    const state = instance?.getState?.();
    const providerSessionId = typeof state?.providerSessionId === 'string' ? state.providerSessionId.trim() : '';
    return providerSessionId || targetSessionId;
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

function normalizeReadChatCursor(args: any): Required<ReadChatCursor> {
    const knownMessageCount = Math.max(0, Number(args?.knownMessageCount || 0));
    const lastMessageSignature = typeof args?.lastMessageSignature === 'string'
        ? args.lastMessageSignature
        : '';
    const tailLimit = Math.max(0, Number(args?.tailLimit || 0));
    return { knownMessageCount, lastMessageSignature, tailLimit };
}

function normalizeReadChatMessages(payload: Record<string, any>): ChatMessage[] {
    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    return normalizeChatMessages(messages);
}

function buildReadChatReplayCollapseSignature(message: ChatMessage | null | undefined): string {
    if (!message) return '';
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    const kind = typeof message.kind === 'string' ? message.kind.trim().toLowerCase() : 'standard';
    const senderName = typeof message.senderName === 'string' ? message.senderName.trim().toLowerCase() : '';
    const content = flattenContent(message.content || '').replace(/\s+/g, ' ').trim();
    return `${role}:${kind}:${senderName}:${content}`;
}

function shouldCollapseReadChatReplayDuplicate(message: ChatMessage | null | undefined): boolean {
    if (!message) return false;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'assistant' && role !== 'system') return false;
    const kind = typeof message.kind === 'string' ? message.kind.trim().toLowerCase() : 'standard';
    return kind === 'tool' || kind === 'terminal' || kind === 'thought' || kind === 'system';
}

function collapseReplayDuplicatesFromReadChat(messages: ChatMessage[]): ChatMessage[] {
    const collapsed: ChatMessage[] = [];
    let lastReplayTurnSignature = '';

    for (const message of messages) {
        const signature = buildReadChatReplayCollapseSignature(message);
        const previous = collapsed[collapsed.length - 1];
        const previousSignature = buildReadChatReplayCollapseSignature(previous);

        if (shouldCollapseReadChatReplayDuplicate(message) && signature) {
            if (previousSignature === signature) continue;
            if (lastReplayTurnSignature === signature) continue;
        }

        collapsed.push(message);
        if (shouldCollapseReadChatReplayDuplicate(message) && signature) {
            lastReplayTurnSignature = signature;
        } else if ((message.role || '').toLowerCase() === 'user') {
            lastReplayTurnSignature = '';
        }
    }

    return collapsed;
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

function computeReadChatSync(messages: ChatMessage[], cursor: Required<ReadChatCursor>): {
    syncMode: ReadChatSyncMode;
    replaceFrom: number;
    messages: ChatMessage[];
    totalMessages: number;
    lastMessageSignature: string;
} {
    const totalMessages = messages.length;
    const lastMessageSignature = getChatMessageSignature(messages[totalMessages - 1]);
    const { knownMessageCount, lastMessageSignature: knownSignature } = cursor;

    if (!knownMessageCount || !knownSignature) {
        return {
            syncMode: 'full',
            replaceFrom: 0,
            messages,
            totalMessages,
            lastMessageSignature,
        };
    }

    if (knownMessageCount > totalMessages) {
        return {
            syncMode: 'full',
            replaceFrom: 0,
            messages,
            totalMessages,
            lastMessageSignature,
        };
    }

    if (knownMessageCount === totalMessages && knownSignature === lastMessageSignature) {
        return {
            syncMode: 'noop',
            replaceFrom: totalMessages,
            messages: [],
            totalMessages,
            lastMessageSignature,
        };
    }

    if (knownMessageCount < totalMessages) {
        const anchorSignature = getChatMessageSignature(messages[knownMessageCount - 1]);
        if (anchorSignature === knownSignature) {
            return {
                syncMode: 'append',
                replaceFrom: knownMessageCount,
                messages: messages.slice(knownMessageCount),
                totalMessages,
                lastMessageSignature,
            };
        }
    }

    const replaceFrom = Math.max(0, Math.min(knownMessageCount - 1, totalMessages));
    return {
        syncMode: replaceFrom === 0 ? 'full' : 'replace_tail',
        replaceFrom,
        messages: replaceFrom === 0 ? messages : messages.slice(replaceFrom),
        totalMessages,
        lastMessageSignature,
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
            return hasNonEmptyModalButtons(activeModal) ? 'waiting_approval' : 'generating';
        case 'stopped':
        case 'disconnected':
        case 'not_monitored':
            return 'error';
        default:
            return raw;
    }
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
    const messages = collapseReplayDuplicatesFromReadChat(normalizeReadChatMessages(validatedPayload));
    const cursor = normalizeReadChatCursor(args);
    if (!cursor.knownMessageCount && !cursor.lastMessageSignature && cursor.tailLimit > 0 && messages.length > cursor.tailLimit) {
        const tailMessages = messages.slice(-cursor.tailLimit);
        const lastMessageSignature = getChatMessageSignature(tailMessages[tailMessages.length - 1]);
        return {
            success: true,
            ...validatedPayload,
            messages: tailMessages,
            syncMode: 'full',
            replaceFrom: 0,
            totalMessages: messages.length,
            lastMessageSignature,
            ...(debugReadChat ? { debugReadChat } : {}),
        };
    }
    const sync = computeReadChatSync(messages, cursor);
    return {
        success: true,
        ...validatedPayload,
        messages: sync.messages,
        syncMode: sync.syncMode,
        replaceFrom: sync.replaceFrom,
        totalMessages: sync.totalMessages,
        lastMessageSignature: sync.lastMessageSignature,
        ...(debugReadChat ? { debugReadChat } : {}),
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
        const evalResult = await h.evaluateProviderScript('readChat', undefined, 50000);
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
        let excludeRecentCount = Math.max(0, Number(args?.excludeRecentCount || 0));
        if (isCliLikeTransport(transport)) {
            const adapter = getTargetedCliAdapter(h, args, provider?.type);
            const status = adapter?.getStatus?.();
            const visibleCount = Array.isArray(status?.messages) ? status.messages.length : 0;
            if (visibleCount > excludeRecentCount) excludeRecentCount = visibleCount;
        }
        const result = readChatHistory(agentStr, offset || 0, limit || 30, historySessionId, excludeRecentCount);
        return { success: true, ...result, agent: agentStr };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

export async function handleReadChat(h: CommandHelpers, args: any): Promise<CommandResult> {
    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const historySessionId = getHistorySessionId(h, args);

    const _log = (msg: string) => LOG.debug('Command', `[read_chat] ${msg}`);

    // PTY / ACP transport: read from adapter
    if (isCliLikeTransport(transport)) {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        if (adapter) {
            _log(`${transport} adapter: ${adapter.cliType}`);
            let parsedStatus: any = null;
            if (typeof adapter.getScriptParsedStatus === 'function') {
                try {
                    parsedStatus = parseMaybeJson(adapter.getScriptParsedStatus());
                } catch (error: any) {
                    return { success: false, error: error?.message || String(error) };
                }
            }
            const parsedRecord = parsedStatus && typeof parsedStatus === 'object'
                ? parsedStatus as Record<string, any>
                : null;
            const adapterStatus = adapter.getStatus();
            const shouldPreferAdapterMessages =
                Array.isArray(adapterStatus.messages)
                && adapterStatus.messages.length > 0
                && Array.isArray(parsedRecord?.messages)
                && adapterStatus.messages.length > parsedRecord.messages.length;
            const parsedShowsApproval = hasNonEmptyModalButtons(parsedRecord?.activeModal)
                && parsedRecord?.status === 'waiting_approval';
            const status = parsedRecord
                ? {
                    ...parsedRecord,
                    messages: shouldPreferAdapterMessages ? adapterStatus.messages : parsedRecord.messages,
                    status: parsedShowsApproval
                        ? parsedRecord.status
                        : (adapterStatus.status !== 'idle'
                            ? adapterStatus.status
                            : (parsedRecord.status || adapterStatus.status)),
                    activeModal: parsedRecord.activeModal || adapterStatus.activeModal,
                }
                : adapterStatus;

            const title = typeof parsedRecord?.title === 'string' ? parsedRecord.title : undefined;
            const providerSessionId = typeof parsedRecord?.providerSessionId === 'string'
                ? parsedRecord.providerSessionId
                : undefined;
            if (status) {
                LOG.info('Command', `[read_chat] cli-like resolved provider=${adapter.cliType} target=${String(args?.targetSessionId || '')} adapterStatus=${String(adapterStatus.status || '')} parsedStatus=${String(parsedRecord?.status || '')} shouldPreferAdapterMessages=${String(shouldPreferAdapterMessages)} adapterMsgCount=${Array.isArray(adapterStatus.messages) ? adapterStatus.messages.length : 0} parsedMsgCount=${Array.isArray(parsedRecord?.messages) ? parsedRecord.messages.length : 0} returnedMsgCount=${Array.isArray((status as any).messages) ? (status as any).messages.length : 0}`);
                return buildReadChatCommandResult({
                    messages: (status as any).messages || [],
                    status: status.status,
                    activeModal: status.activeModal,
                    debugReadChat: {
                        provider: adapter.cliType,
                        targetSessionId: String(args?.targetSessionId || ''),
                        adapterStatus: String(adapterStatus.status || ''),
                        parsedStatus: String(parsedRecord?.status || ''),
                        returnedStatus: String(status.status || ''),
                        shouldPreferAdapterMessages,
                        adapterMsgCount: Array.isArray(adapterStatus.messages) ? adapterStatus.messages.length : 0,
                        parsedMsgCount: Array.isArray(parsedRecord?.messages) ? parsedRecord.messages.length : 0,
                        returnedMsgCount: Array.isArray((status as any).messages) ? (status as any).messages.length : 0,
                    },
                    ...(title ? { title } : {}),
                    ...(providerSessionId ? { providerSessionId } : {}),
                }, args);
            }
        }
        return { success: false, error: `${transport} adapter not found` };
    }

    // Extension transport: evaluateInSession
    if (isExtensionTransport(transport)) {
        try {
            const evalResult = await h.evaluateProviderScript('readChat', undefined, 50000);
            if (evalResult?.result) {
                let parsed = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
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
            }
        } catch (e: any) {
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
                if (stream?.agentType !== provider?.type) {
                    return buildReadChatCommandResult({ messages: [], status: 'idle' }, args);
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
        return buildReadChatCommandResult({ messages: [], status: 'idle' }, args);
    }

    // IDE category (default): cdp.evaluate
    const cdp = h.getCdp();
    if (!cdp?.isConnected) return { success: false, error: 'CDP not connected' };

    // webview IDE (Kiro, PearAI) → evaluateInWebviewFrame directly use
    const webviewScript = h.getProviderScript('webviewReadChat') || h.getProviderScript('webview_read_chat');
    if (webviewScript) {
        try {
            const matchText = provider?.webviewMatchText;
            const matchFn = matchText
                ? (body: string) => body.includes(matchText)
                : undefined;
            const raw = await cdp.evaluateInWebviewFrame(webviewScript, matchFn);
            if (raw) {
                let parsed: any = raw;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
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
            }
        } catch (e: any) {
            _log(`Webview readChat error: ${e.message}`);
        }
        return buildReadChatCommandResult({ messages: [], status: 'idle' }, args);
    }

    // Regular IDE (Cursor, Windsurf, Trae etc) → main DOM evaluate
    const script = h.getProviderScript('readChat') || h.getProviderScript('read_chat');
    if (script) {
        try {
            const evalResult = await h.evaluateProviderScript('readChat', undefined, 50000);
            if (evalResult?.result) {
                let parsed: any = evalResult.result;
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { } }
                if (parsed && typeof parsed === 'object' && parsed.messages?.length > 0) {
                    const validated = validateReadChatResultPayload(parsed, 'ide read_chat');
                    _log(`OK: ${validated.messages?.length} msgs`);
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
            }
        } catch (e: any) {
            LOG.info('Command', `[read_chat] Script error: ${e.message}`);
            traceProviderEvent(args, 'provider', 'ide.read_chat.error', {
                h,
                provider,
                level: 'warn',
                payload: { method: 'evaluate', error: e.message },
            });
        }
    }

    return buildReadChatCommandResult({ messages: [], status: 'idle' }, args);
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

    // PTY transport: text-only send via adapter
    if (transport === 'pty') {
        const adapter = getTargetedCliAdapter(h, args, provider?.type);
        if (adapter) {
            _log(`${transport} adapter: ${adapter.cliType}`);
            try {
                assertTextOnlyInput(provider, input);
                if (!text) return { success: false, error: 'text required for PTY send' };
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
        if (status?.status !== 'waiting_approval') {
            return { success: false, error: 'Not in approval state' };
        }
        const buttons: string[] = status.activeModal?.buttons || ['Allow once', 'Always allow', 'Deny'];
        // Resolve button index: explicit buttonIndex arg → button text match → action fallback
        let buttonIndex = typeof args?.buttonIndex === 'number' ? args.buttonIndex : -1;
        if (buttonIndex < 0) {
            const btnLower = button.toLowerCase();
            buttonIndex = buttons.findIndex(b => b.toLowerCase().includes(btnLower));
        }
        if (buttonIndex < 0) {
            if (action === 'reject' || action === 'deny') {
                buttonIndex = buttons.findIndex(b => /deny|reject|no/i.test(b));
                if (buttonIndex < 0) buttonIndex = buttons.length - 1;
            } else if (action === 'always' || /always/i.test(button)) {
                buttonIndex = buttons.findIndex(b => /always/i.test(b));
                if (buttonIndex < 0) buttonIndex = 1;
            } else {
                buttonIndex = 0; // approve → first option (default selected)
            }
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
