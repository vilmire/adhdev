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

export function getChatMessageStableKey(message: ChatMessage, index: number): string {
    const dashboardMessage = message as ChatMessage & { _localId?: string; _turnKey?: string }
    const content = stringifyTextContent(message.content, { joiner: '\n' });
    const parts = [
        message.id ? `id:${message.id}` : '',
        dashboardMessage._localId ? `local:${dashboardMessage._localId}` : '',
        dashboardMessage._turnKey ? `turn:${dashboardMessage._turnKey}` : '',
        typeof message.index === 'number' ? `msgIndex:${message.index}` : '',
        message.role ? `role:${message.role}` : '',
        content ? `content:${content.slice(0, 80)}` : '',
        `fallback:${index}`,
    ].filter(Boolean);

    return parts.join('|');
}
