/**
 * Chat Commands — read side, DOM-script paths of read_chat: the extension
 * transport (evaluateInSession, then the AgentStreamManager fallback), webview
 * IDEs (Kiro, PearAI — evaluateInWebviewFrame) and regular IDEs (Cursor,
 * Windsurf, Trae, … — main DOM evaluate).
 *
 * All three share one tail — parse the script's JSON, validate + stamp message
 * sources, persist to the chat history, build the result — which lives in
 * {@link acceptDomReadChatPayload}.
 *
 * Split out of chat-commands-read.ts (file-size gate).
 */
import type { CommandHelpers, CommandResult } from './handler.js';
import type { ChatMessage } from '../types.js';
import type { ProviderModule } from '../providers/contracts.js';
import { flattenContent } from '../providers/contracts.js';
import { validateReadChatResultPayload } from '../providers/read-chat-contract.js';
import { LOG } from '../logging/logger.js';
import { READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS, getCurrentProviderType } from './chat-commands-shared.js';
import { normalizeReadChatMessages } from './read-chat-message-filters.js';
import { stampDomScriptMessageSources } from './read-chat-message-identity.js';
import { buildReadChatCommandResult } from './read-chat-presentation.js';
import { traceProviderEvent } from './chat-commands-read-session-id.js';

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

/** What the DOM read paths share from handleReadChat. */
export interface DomReadChatRequest {
    provider: ProviderModule | undefined;
    historySessionId: string | undefined;
}

/**
 * Parse (when a string), validate, persist and build a DOM-script read_chat
 * payload. Returns a CommandResult on success, or `{ error }` describing why
 * the payload was rejected — `label` prefixes the error ('extension read_chat'
 * / 'webview read_chat' / 'ide read_chat').
 */
function acceptDomReadChatPayload(
    h: CommandHelpers,
    args: any,
    req: DomReadChatRequest,
    raw: unknown,
    opts: { label: string; historyProviderType: string; onValidated?: (validated: any) => void },
): { result: CommandResult } | { error: string } {
    let parsed: any = raw;
    let parseError = '';
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch (e: any) {
            parseError = `${opts.label} parse failed: ${e?.message || String(e)}`;
        }
    }
    if (!parsed || typeof parsed !== 'object') {
        return { error: parseError || `${opts.label} returned a non-object payload` };
    }
    const validated = validateReadChatResultPayload(stampDomScriptMessageSources(parsed, req.historySessionId || args?.targetSessionId), opts.label);
    opts.onValidated?.(validated);
    h.historyWriter.appendNewMessages(
        opts.historyProviderType,
        toHistoryPersistedMessages(normalizeReadChatMessages(validated)),
        validated.title,
        args?.targetSessionId,
        req.historySessionId,
    );
    return { result: buildReadChatCommandResult(validated as Record<string, any>, args, h, { identityCoverage: 'window' }) };
}

/** Extension transport: evaluateInSession, then the AgentStreamManager fallback. */
export async function readChatFromExtension(h: CommandHelpers, args: any, req: DomReadChatRequest): Promise<CommandResult> {
    const { provider } = req;
    let extensionReadChatError = '';
    try {
        const evalResult = await h.evaluateProviderScript('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS);
        if (evalResult?.result) {
            const accepted = acceptDomReadChatPayload(h, args, req, evalResult.result, {
                label: 'extension read_chat',
                historyProviderType: provider?.type || 'unknown_extension',
                onValidated: (validated) => {
                    LOG.debug('Command', `[read_chat] Extension OK: ${validated.messages?.length || 0} msgs`);
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
                },
            });
            if ('result' in accepted) return accepted.result;
            extensionReadChatError = accepted.error;
        } else {
            extensionReadChatError = 'extension read_chat returned no payload';
        }
    } catch (e: any) {
        extensionReadChatError = `extension read_chat failed: ${e?.message || String(e)}`;
        LOG.debug('Command', `[read_chat] Extension error: ${e.message}`);
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
                    req.historySessionId,
                );
                return buildReadChatCommandResult({
                    messages: stream.messages || [],
                    status: stream.status,
                    agentType: stream.agentType,
                }, args, h, { identityCoverage: 'window' });
            }
        }
    }
    return { success: false, error: extensionReadChatError || 'extension read_chat unavailable' };
}

/** IDE category (default): cdp.evaluate — webview IDEs first, then the main DOM. */
export async function readChatFromIde(h: CommandHelpers, args: any, req: DomReadChatRequest): Promise<CommandResult> {
    const { provider } = req;
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
                const accepted = acceptDomReadChatPayload(h, args, req, raw, {
                    label: 'webview read_chat',
                    historyProviderType: provider?.type || getCurrentProviderType(h, 'unknown_webview'),
                    onValidated: (validated) => LOG.debug('Command', `[read_chat] Webview OK: ${validated.messages?.length || 0} msgs`),
                });
                if ('result' in accepted) return accepted.result;
                webviewReadChatError = accepted.error;
            } else {
                webviewReadChatError = 'webview read_chat returned no payload';
            }
        } catch (e: any) {
            webviewReadChatError = `webview read_chat failed: ${e?.message || String(e)}`;
            LOG.debug('Command', `[read_chat] Webview readChat error: ${e.message}`);
        }
        return { success: false, error: webviewReadChatError || 'webview read_chat unavailable' };
    }

    // Regular IDE (Cursor, Windsurf, Trae etc) → main DOM evaluate
    const script = h.getProviderScript('readChat') || h.getProviderScript('read_chat');
    if (!script) return { success: false, error: 'read_chat unavailable' };
    let ideReadChatError = '';
    try {
        const evalResult = await h.evaluateProviderScript('readChat', undefined, READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS);
        if (evalResult?.result) {
            const accepted = acceptDomReadChatPayload(h, args, req, evalResult.result, {
                label: 'ide read_chat',
                historyProviderType: provider?.type || getCurrentProviderType(h, 'unknown_ide'),
                onValidated: (validated) => {
                    LOG.debug('Command', `[read_chat] OK: ${validated.messages?.length || 0} msgs`);
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
                },
            });
            if ('result' in accepted) return accepted.result;
            ideReadChatError = accepted.error;
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
