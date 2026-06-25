/**
 * Chat Commands — shared private helpers used by more than one handler group.
 *
 * These were module-local helpers/consts/interfaces in chat-commands.ts. They
 * are exported here only so the split read/write/debug/scope sub-modules can
 * import them; they are NOT part of the public chat-commands surface (except
 * READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS and buildSendInputSignature, which the
 * chat-commands barrel re-exports).
 */

import type { CommandHelpers } from './handler.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import { type InputEnvelope, type ProviderModule } from '../providers/contracts.js';
import type { ProviderInstance } from '../providers/provider-instance.js';
import { buildChatMessageSignature, hashSignatureParts } from '../chat/chat-signatures.js';
import type { ChatMessage } from '../types.js';
import type { SessionTransport } from '../shared-types.js';

export const READ_CHAT_PROVIDER_EVAL_TIMEOUT_MS = 25_000;

export interface ApprovalSelectableInstance extends ProviderInstance {
    recordApprovalSelection?(buttonText: string): void;
}

export interface RuntimeChatMessageMerger extends ProviderInstance {
    mergeRuntimeChatMessages?(messages: ChatMessage[]): ChatMessage[];
    recordAcknowledgedUserInput?(input: InputEnvelope | string): void;
}

export function getCurrentProviderType(h: CommandHelpers, fallback = ''): string {
    return h.currentSession?.providerType || h.currentProviderType || fallback;
}

export function getCurrentManagerKey(h: CommandHelpers): string {
    return h.currentSession?.cdpManagerKey || h.currentManagerKey || '';
}

export function getTargetedCliAdapter(h: CommandHelpers, args: any, providerType?: string): CliAdapter | null {
    return h.getCliAdapter(args?.targetSessionId || providerType || h.currentSession?.providerType || h.currentManagerKey);
}

export function getTargetInstance(h: CommandHelpers, args: any): ApprovalSelectableInstance | null {
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const sessionId = targetSessionId || h.currentSession?.sessionId || '';
    if (!sessionId) return null;
    const session = h.ctx.sessionRegistry?.get(sessionId);
    const instanceKey = session?.adapterKey || session?.instanceKey || sessionId;
    return (h.ctx.instanceManager?.getInstance(instanceKey) as ApprovalSelectableInstance | undefined) || null;
}

export function getTargetTransport(h: CommandHelpers, provider?: ProviderModule): SessionTransport | null {
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

export function isCliLikeTransport(transport: SessionTransport | null): boolean {
    return transport === 'pty' || transport === 'acp';
}

export function isExtensionTransport(transport: SessionTransport | null): boolean {
    return transport === 'cdp-webview';
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

export function parseMaybeJson(value: any): any {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

export function getChatMessageSignature(message: ChatMessage | null | undefined): string {
    return buildChatMessageSignature(message);
}
