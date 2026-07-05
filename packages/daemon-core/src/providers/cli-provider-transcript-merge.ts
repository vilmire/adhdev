// Transcript assembly helpers extracted from cli-provider-instance.ts.
// Pure move — no behavior change. `mergeConversationMessages` was a private
// method reading only `this.runtimeMessages`; it now takes that array as a
// parameter. `buildExternalTranscriptProbe` used no instance state.

import { flattenContent } from './contracts.js';
import { normalizeChatMessages, resolveChatMessageKind, isUserFacingChatMessage } from './chat-message-normalization.js';
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
        const runtimeText = flattenContent(entry.message.content).replace(/\s+/g, ' ').trim();
        if (!runtimeText) return false;
        return !parsedEntries.some((parsedEntry) => {
            const parsedRole = getRole(parsedEntry.message);
            if (parsedRole !== 'user' && parsedRole !== 'human') return false;
            const parsedText = flattenContent(parsedEntry.message.content).replace(/\s+/g, ' ').trim();
            return parsedText === runtimeText;
        });
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
