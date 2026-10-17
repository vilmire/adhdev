// Transcript assembly helpers extracted from cli-provider-instance.ts.

import { readOutgoingReceipt, sameOutgoingAttempt } from '../seqscribe/outgoing-receipt.js';
import { flattenContent } from './contracts.js';
import { buildChatMessage, normalizeChatMessages, resolveChatMessageKind, isUserFacingChatMessage } from './chat-message-normalization.js';
import type { ChatMessage } from '../types.js';
import type { ExternalTranscriptProbe } from './cli-provider-instance-types.js';

export function mergeConversationMessages(
    runtimeMessages: Array<{ key: string; message: ChatMessage }>,
    parsedMessages: any[],
): ChatMessage[] {
    if (runtimeMessages.length === 0) return normalizeChatMessages(parsedMessages);

    type MergeEntry = { message: ChatMessage; index: number; source: 'parsed' | 'runtime'; runtimeKey?: string };
    const parsedEntries: MergeEntry[] = parsedMessages.map((message, index) => ({
        message,
        index,
        source: 'parsed',
    }));
    const getRole = (message: ChatMessage): string => typeof message.role === 'string'
        ? message.role.trim().toLowerCase()
        : '';
    const metadata = (message: ChatMessage): Record<string, unknown> => message.meta && typeof message.meta === 'object' && !Array.isArray(message.meta) ? message.meta as Record<string, unknown> : {};
    // Index once, then look up. The ack-dedup below used to rescan every parsed
    // turn and every runtime message (re-flattening and regex-normalizing each)
    // for every runtime ack — O(n²) per getState(), which pinned the preview
    // daemon at 100% CPU on long sessions (2026-10-17). Only `content` and
    // `role` are indexed; both are never rewritten below (only `meta` is), so
    // the index stays valid while candidates are updated in place.
    const normalizeText = (message: ChatMessage): string => flattenContent(message.content).replace(/\s+/g, ' ').trim();
    const parsedUserTurnsByText = new Map<string, MergeEntry[]>();
    for (const parsedEntry of parsedEntries) {
        const parsedRole = getRole(parsedEntry.message);
        if (parsedRole !== 'user' && parsedRole !== 'human') continue;
        const text = normalizeText(parsedEntry.message);
        const bucket = parsedUserTurnsByText.get(text);
        if (bucket) bucket.push(parsedEntry); else parsedUserTurnsByText.set(text, [parsedEntry]);
    }
    const runtimeAckCountByText = new Map<string, number>();
    for (const r of runtimeMessages) {
        if (metadata(r.message).runtimeInputAck !== true) continue;
        const text = normalizeText(r.message);
        runtimeAckCountByText.set(text, (runtimeAckCountByText.get(text) ?? 0) + 1);
    }
    const runtimeEntries: MergeEntry[] = runtimeMessages.map((entry, index) => ({
        message: entry.message,
        index: parsedMessages.length + index,
        source: 'runtime' as const,
        runtimeKey: entry.key,
    })).filter((entry) => {
        const meta = entry.message.meta && typeof entry.message.meta === 'object' && !Array.isArray(entry.message.meta)
            ? entry.message.meta as Record<string, unknown>
            : {};
        if (meta.runtimeInputAck !== true) return true;
        const runtimeText = normalizeText(entry.message);
        if (!runtimeText) return !!(meta.sourceMessageId || meta.outgoingReceipt);
        const matches = parsedUserTurnsByText.get(runtimeText) ?? [];
        const sourceId = typeof meta.sourceMessageId === 'string' ? meta.sourceMessageId : null;
        const receipt = readOutgoingReceipt(meta.outgoingReceipt);
        // Text alone cannot distinguish repeated sends. An explicit native identity
        // can; otherwise both sides of the content match must be unique.
        const identified = sourceId ? matches.filter(p => metadata(p.message).sourceMessageId === sourceId) : [];
        const sameTextAckCount = runtimeAckCountByText.get(runtimeText) ?? 0;
        const candidate = identified.length === 1 ? identified[0]
            : matches.length === 1 && sameTextAckCount === 1 ? matches[0] : null;
        if (!candidate) return true;
        // A historical native turn cannot receive a later send's identity. A small
        // allowance covers native timestamps sampled just before the runtime ack.
        const nativeAt = candidate.message.receivedAt || candidate.message.timestamp || 0;
        const runtimeAt = entry.message.receivedAt || entry.message.timestamp || 0;
        if (!identified.length && nativeAt && runtimeAt && nativeAt < runtimeAt - 1000) return true;
        const nativeMeta = metadata(candidate.message);
        const nativeReceipt = readOutgoingReceipt(nativeMeta.outgoingReceipt);
        if (nativeMeta.sourceMessageId && nativeMeta.sourceMessageId !== sourceId) return true;
        if (meta.outgoingReceipt && !receipt) return true;
        if (receipt && (!sourceId || receipt.messageId !== sourceId)) return true;
        if (nativeMeta.outgoingReceipt && (!nativeReceipt || !receipt || !sameOutgoingAttempt(nativeReceipt, receipt))) return true;
        if (nativeReceipt && receipt && nativeReceipt.revision === receipt.revision
            && (nativeReceipt.state !== receipt.state || nativeReceipt.proof !== receipt.proof)) return true;
        candidate.message = { ...candidate.message, meta: { ...nativeMeta,
            ...(sourceId ? { sourceMessageId: sourceId } : {}),
            ...(receipt ? { outgoingReceipt: nativeReceipt && nativeReceipt.revision > receipt.revision ? nativeReceipt : receipt } : {}),
        } };
        return false;
    });
    const getTime = (message: ChatMessage): number => {
        const value = typeof message.receivedAt === 'number'
            ? message.receivedAt
            : typeof message.timestamp === 'number'
                ? message.timestamp
                : 0;
        return Number.isFinite(value) && value > 0 ? value : 0;
    };

    const isRuntimeOverlay = (entry: MergeEntry): boolean => {
        if (entry.source !== 'runtime') return false;
        const key = typeof entry.runtimeKey === 'string' ? entry.runtimeKey.trim().toLowerCase() : '';
        if (key.startsWith('auto_approval:')) return true;
        return !isUserFacingChatMessage(entry.message);
    };
    const shouldKeepParsedBeforeUntimedRuntime = (message: ChatMessage): boolean => {
        const role = getRole(message);
        return role === 'user' || role === 'human';
    };
    const shouldKeepParsedAfterUntimedRuntime = (message: ChatMessage): boolean => {
        const role = getRole(message);
        if (role !== 'assistant') return false;
        const kind = resolveChatMessageKind(message);
        return kind === 'standard' || kind === 'terminal';
    };

    return normalizeChatMessages([...parsedEntries, ...runtimeEntries]
        .sort((a, b) => {
            const aTime = getTime(a.message);
            const bTime = getTime(b.message);
            if (aTime && bTime && aTime !== bTime) return aTime - bTime;
            if (a.source !== b.source && aTime !== bTime) {
                const parsedEntry = a.source === 'parsed' ? a : b.source === 'parsed' ? b : null;
                const runtimeEntry = a.source === 'runtime' ? a : b.source === 'runtime' ? b : null;
                if (parsedEntry && runtimeEntry && isRuntimeOverlay(runtimeEntry) && getTime(parsedEntry.message) === 0 && getTime(runtimeEntry.message) > 0) {
                    if (shouldKeepParsedBeforeUntimedRuntime(parsedEntry.message)) {
                        return a.source === 'parsed' ? -1 : 1;
                    }
                    if (shouldKeepParsedAfterUntimedRuntime(parsedEntry.message)) {
                        return a.source === 'parsed' ? 1 : -1;
                    }
                }
            }
            // Many provider-owned CLI transcripts (including Hermes CLI in debug bundles)
            // do not carry timestamps on parsed messages. In that case there is no safe
            // clock basis for interleaving timestamped runtime/system messages into the
            // provider transcript. Keep user prompts before runtime overlays, but do not
            // let timed runtime/system/tool/internal overlays become the final chat turns
            // after an untimed parsed assistant transcript.
            return a.index - b.index;
        })
        .map((entry) => entry.message));
}

/**
 * The IDE / extension instances' merge: parsed chat messages and runtime messages
 * interleaved by receive time, stable on ties. (The CLI path uses the richer
 * mergeConversationMessages above — it must also place untimed parsed turns.)
 */
export function mergeRuntimeMessagesByTime(
    runtimeMessages: Array<{ key: string; message: ChatMessage }>,
    messages: any[],
): ChatMessage[] {
    if (runtimeMessages.length === 0) return normalizeChatMessages(messages);
    return normalizeChatMessages([...messages, ...runtimeMessages.map((entry) => entry.message)]
        .map((message, index) => ({ message, index }))
        .sort((a, b) => {
            const aTime = a.message.receivedAt || a.message.timestamp || 0;
            const bTime = b.message.receivedAt || b.message.timestamp || 0;
            if (aTime !== bTime) return aTime - bTime;
            return a.index - b.index;
        })
        .map((entry) => entry.message));
}

/**
 * Normalize a runtime message for an instance's runtime-message list: stamp both
 * clocks, and refuse an empty message or a dedup key the list already holds.
 * Returns the normalized message with its trimmed text, and the history row to
 * persist when that text is non-empty.
 */
export function prepareRuntimeMessage(
    runtimeMessages: ReadonlyArray<{ key: string }>,
    message: ChatMessage,
    dedupKey: string,
): { message: ChatMessage; historyRow: { role: ChatMessage['role']; senderName?: string; kind?: ChatMessage['kind']; content: string; receivedAt?: number; historyDedupKey: string } | null } | null {
    const normalizedMessage = buildChatMessage({
        ...message,
        receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : (message.timestamp || Date.now()),
        timestamp: typeof message.timestamp === 'number' ? message.timestamp : (message.receivedAt || Date.now()),
    } as ChatMessage);
    const normalizedContent = typeof normalizedMessage.content === 'string'
        ? normalizedMessage.content.trim()
        : flattenContent(normalizedMessage.content).trim();
    if (!normalizedContent && (!Array.isArray(normalizedMessage.content) || normalizedMessage.content.length === 0)) return null;
    if (runtimeMessages.some((entry) => entry.key === dedupKey)) return null;
    return {
        message: normalizedMessage,
        historyRow: normalizedContent
            ? {
                role: normalizedMessage.role,
                senderName: normalizedMessage.senderName,
                kind: normalizedMessage.kind,
                content: normalizedContent,
                receivedAt: normalizedMessage.receivedAt || normalizedMessage.timestamp,
                historyDedupKey: dedupKey,
            }
            : null,
    };
}

export function buildExternalTranscriptProbe(messages: unknown[], sourcePath?: string, sourceMtimeMs?: number): ExternalTranscriptProbe {
    const visibleMessages = messages.filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
    const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
    const readAt = Date.now();
    const mtimeMs = Number(sourceMtimeMs) || 0;
    return {
        readAt,
        msgCount: messages.length,
        lastRole: typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : null,
        lastKind: typeof (lastVisible as any)?.kind === 'string' ? (lastVisible as any).kind : null,
        contentLen: lastVisible ? flattenContent(lastVisible.content).trim().length : 0,
        sourcePath: typeof sourcePath === 'string' && sourcePath ? sourcePath : null,
        sourceMtimeMs: mtimeMs || null,
        mtimeAgeMs: mtimeMs ? Math.max(0, readAt - mtimeMs) : null,
    };
}
