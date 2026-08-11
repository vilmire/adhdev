/**
 * Chat Commands — read side: shared message/argument normalizers.
 *
 * Leaf module: the few read_chat helpers needed by BOTH chat-commands-read.ts
 * and read-chat-presentation.ts. Kept here so neither of those has to import
 * the other, and so splitting the read path did not force these
 * previously-private helpers onto a public module surface.
 *
 * Split out of chat-commands-read.ts verbatim — no behaviour change.
 */

import type { CommandHelpers } from './handler.js';
import { flattenContent } from '../providers/contracts.js';
import { getCoordinatorForSession } from '../mesh/coordinator-registry.js';
import { LOG } from '../logging/logger.js';
import type { ChatMessage } from '../types.js';
import { normalizeChatMessages } from '../providers/chat-message-normalization.js';

export function normalizeReadChatTailLimit(args: any): number {
    const value = Number(args?.tailLimit || 0);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeReadChatMessages(payload: Record<string, any>): ChatMessage[] {
    const messages = Array.isArray(payload.messages) ? payload.messages as ChatMessage[] : [];
    return normalizeChatMessages(messages);
}

/**
 * Drop the synthetic "user" message some CLIs surface in their native
 * transcript when the daemon injects a coordinator system prompt
 * (codex puts the AGENTS.md / developer_instructions block in as
 * role=user; agy/claude/hermes have similar artifacts). The user can
 * opt back into seeing it via the provider setting
 * `showCoordinatorSystemPrompt`. Default is off — the prompt is still
 * fully visible from the chat-header ⓘ "Session info" dialog.
 *
 * Matching rules:
 *   1. Setting must be off (default).
 *   2. There must be a registered coordinator entry for the session.
 *   3. The candidate message is filtered when its role is user OR
 *      system and its content either contains the prompt body verbatim,
 *      OR contains the well-known coordinator marker
 *      `adhdev-mesh-coordinator-prompt`. The marker covers context-file
 *      cases (agy AGENTS.md / gemini GEMINI.md) where the CLI may wrap
 *      its own preamble around our block. Verbatim-content covers
 *      codex's developer_instructions echo.
 *
 * Returns the messages array unchanged when none of the rules match,
 * so this is safe to apply unconditionally to every read_chat result.
 */
export function maybeHideCoordinatorPromptMessage(
    h: CommandHelpers,
    providerType: string,
    sessionId: string | undefined,
    messages: ChatMessage[],
): ChatMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (!sessionId) return messages;
    const loader = h.ctx?.providerLoader;
    if (!loader) return messages;
    let showSetting: unknown = undefined;
    try {
        showSetting = (loader as any).getSettingValue?.(providerType, 'showCoordinatorSystemPrompt');
    } catch { /* unknown setting key for this provider — fall through */ }
    if (showSetting === true) return messages;
    const coord = getCoordinatorForSession(sessionId);
    if (!coord) return messages;
    const promptBody = typeof coord.systemPrompt === 'string' ? coord.systemPrompt : '';
    const MARKER = 'adhdev-mesh-coordinator-prompt';
    const filtered = messages.filter(m => {
        const role = String((m as any)?.role || '').toLowerCase();
        if (role !== 'user' && role !== 'system') return true;
        const content = flattenContent((m as any)?.content);
        if (!content) return true;
        if (content.includes(MARKER)) return false;
        if (promptBody && content.includes(promptBody.slice(0, Math.min(400, promptBody.length)))) return false;
        return true;
    });
    if (filtered.length !== messages.length) {
        LOG.debug('ChatFilter', `[${providerType}] hid ${messages.length - filtered.length} coordinator-prompt message(s) from ${sessionId}`);
    }
    return filtered;
}
