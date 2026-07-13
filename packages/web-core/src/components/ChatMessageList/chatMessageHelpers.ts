/**
 * chatMessageHelpers — pure helpers, types, and constants for ChatMessageList.
 *
 * Extracted verbatim from ChatMessageList.tsx (survey C9 3/3). No behaviour,
 * formatting, or logic change: these are the pure timestamp / key / structured-part
 * helpers the row renderers and the list body read.
 */

import { stringifyTextContent } from '../../utils/text';
import type { ChatMessage } from '../../types';

export interface ActionLog {
    text: string;
    timestamp: number;
}

export type MessageMeta = NonNullable<ChatMessage['meta']> & { renderMode?: unknown };

export function formatTime(ms?: number): string {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function getRenderableTimestamp(message: ChatMessage, index: number, receivedAtMap: Record<string, number>): number {
    return Number(
        message.receivedAt
        || receivedAtMap[getChatMessageStableKey(message, index)]
        || 0,
    ) || 0;
}

export function likelyNeedsMarkdownRender(content: string): boolean {
    return /[`*_#[\]()>-]|https?:\/\/|\n\s*[-*]\s|\n\s*\d+\.\s|\|/.test(content);
}

export type StructuredMessagePart = {
    type: string;
    text?: string;
    uri?: string;
    data?: string;
    mimeType?: string;
    alt?: string;
    transcript?: string;
    name?: string;
    title?: string;
    description?: string;
    posterUri?: string;
    resource?: {
        uri?: string;
        text?: string;
        blob?: string;
        mimeType?: string | null;
    };
};

export function isStructuredMessagePartArray(content: unknown): content is StructuredMessagePart[] {
    return Array.isArray(content) && content.some((part) => !!part && typeof part === 'object' && 'type' in part);
}

export function getResourceDisplayName(uri: string | undefined, fallback: string): string {
    if (!uri) return fallback;
    try {
        const withoutScheme = uri.startsWith('file://') ? new URL(uri).pathname : uri;
        const normalized = withoutScheme.split(/[\\/]/).filter(Boolean).pop();
        return normalized || fallback;
    } catch {
        const normalized = uri.split(/[\\/]/).filter(Boolean).pop();
        return normalized || fallback;
    }
}

export function buildMediaSrc(part: StructuredMessagePart): string | undefined {
    if (typeof part.uri === 'string' && part.uri) return part.uri;
    if (typeof part.data === 'string' && part.data && typeof part.mimeType === 'string' && part.mimeType) {
        return `data:${part.mimeType};base64,${part.data}`;
    }
    return undefined;
}

/**
 * Deterministic, position-independent hash of a string (djb2 xor variant),
 * returned as an unsigned base-36 digest. Used to fold full message content
 * into the stable-key fallback tier without depending on array position.
 */
function hashContent(input: string): string {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        // hash * 33 ^ charCode, kept in 32-bit range
        hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(36);
}

/**
 * Stable React key for a chat message.
 *
 * The key MUST be position-independent: the message list is data-windowed and
 * re-sorted on every user send (`buildVisibleConversationMessages`), which
 * renumbers array positions. If the key depended on the array index, a windowed
 * or re-sorted assistant bubble would change keys across a send and React would
 * unmount+remount it — a visible flash (CHAT-FLAP-LONG-CONVO).
 *
 * Preference order (all intrinsic to the message, none position-derived):
 *   id > _localId > _turnKey > bubbleId > providerUnitKey > message.index/sequence
 * Legacy CLI/native transcript bubbles carry none of those, so we fall back to a
 * position-independent digest of the message's own fields (role + full-content
 * hash + timestamp), NOT the array index.
 *
 * `index` is retained in the signature for call-site compatibility
 * (`getRenderableTimestamp` and existing callers pass it) but is intentionally
 * NOT part of the returned key.
 */
export function getChatMessageStableKey(message: ChatMessage, index: number): string {
    void index;
    const dashboardMessage = message as ChatMessage & { _localId?: string; _turnKey?: string }
    const content = stringifyTextContent(message.content, { joiner: '\n' });

    // Position-independent stable identity, most-authoritative first.
    const identity = [
        message.id ? `id:${message.id}` : '',
        dashboardMessage._localId ? `local:${dashboardMessage._localId}` : '',
        dashboardMessage._turnKey ? `turn:${dashboardMessage._turnKey}` : '',
        message.bubbleId ? `bubble:${message.bubbleId}` : '',
        message.providerUnitKey ? `unit:${message.providerUnitKey}` : '',
        typeof message.index === 'number' ? `msgIndex:${message.index}` : '',
        typeof message.sequence === 'number' ? `seq:${message.sequence}` : '',
    ].filter(Boolean);

    if (identity.length > 0) {
        return identity.join('|');
    }

    // Legacy bubbles with no intrinsic identity: derive a position-independent
    // fallback from the message's own fields. Hash the FULL content (not a
    // slice) to reduce collisions; include a timestamp when present to
    // disambiguate identical-content messages.
    const timestamp = message.receivedAt || message.timestamp || 0;
    const fallback = [
        message.role ? `role:${message.role}` : 'role:',
        `chash:${hashContent(content)}`,
        timestamp ? `ts:${timestamp}` : '',
    ].filter(Boolean);

    return fallback.join('|');
}
