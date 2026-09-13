/**
 * CLI provider persisted-history dedup — incremental append computation.
 *
 * Pure move out of cli-provider-instance.ts (no behavior change): the
 * shared-prefix diff that turns a full parsed transcript into the newly-added
 * tail to append to the persisted chat history. cli-provider-instance
 * re-exports buildIncrementalHistoryAppendMessages so existing importers/tests
 * keep their path.
 */

import { flattenContent } from './contracts.js';

export type PersistableCliHistoryMessage = {
    role: string;
    content: string;
    kind?: string;
    senderName?: string;
    receivedAt?: number;
    /**
     * (TOOL-EXPAND) Content-free address of the tool block this bubble was
     * truncated from — three integers, never text. Carried on the persisted
     * shape because the canonical-history branch of `buildProviderState`
     * projects these rows straight into `activeChat.messages`; dropping it here
     * stripped the ref from every restored tool bubble, so the dashboard's
     * ToolExpandControl never rendered and `expand_tool_block` had no address
     * to ask for.
     */
    toolBlockRef?: { sourceMtimeMs: number; recordIndex: number; blockIndex: number };
    /**
     * (TOOL-EXPAND) Producer-minted bubble identity, carried for the same reason
     * as `toolBlockRef`: these rows are projected straight into
     * `activeChat.messages`, and web-core keys bubbles off this identity. Dropping
     * it made every restored bubble fall back to an index-derived React key, which
     * renumbers as the tail grows (remount flash) and cannot address a single
     * bubble for expand/collapse state. Identifiers only — no content.
     */
    sequence?: number;
    _turnKey?: string;
    bubbleState?: string;
    providerUnitKey?: string;
    bubbleId?: string;
};

/**
 * (TOOL-EXPAND) Copy the producer-minted bubble identity by NAME and only when
 * present, so a bubble that never carried it does not gain `undefined` keys on
 * every row. Shared by the three field-by-field remaps that stand between the
 * native-history reader and `activeChat.messages`
 * (`toPersistableMessages` and the two remaps in cli-provider-state-projection),
 * so the identity cannot be preserved at one hop and silently dropped at the
 * next. Identifiers and ordinals only — never content, so this rides the same
 * lane as `toolBlockRef`.
 */
export function carryBubbleIdentity(message: {
    sequence?: number;
    _turnKey?: string;
    bubbleState?: string;
    providerUnitKey?: string;
    bubbleId?: string;
}): Partial<PersistableCliHistoryMessage> {
    return {
        ...(typeof message?.sequence === 'number' && Number.isFinite(message.sequence) ? { sequence: message.sequence } : {}),
        ...(message?._turnKey ? { _turnKey: message._turnKey } : {}),
        ...(message?.bubbleState ? { bubbleState: message.bubbleState } : {}),
        ...(message?.providerUnitKey ? { providerUnitKey: message.providerUnitKey } : {}),
        ...(message?.bubbleId ? { bubbleId: message.bubbleId } : {}),
    };
}

function normalizePersistableCliHistoryContent(content: unknown): string {
    return flattenContent(content as any).replace(/\s+/g, ' ').trim();
}

function buildPersistableCliHistorySignature(message: PersistableCliHistoryMessage): string {
    return [
        String(message.role || ''),
        String(message.kind || ''),
        String(message.senderName || ''),
        normalizePersistableCliHistoryContent(message.content),
    ].join('|');
}

function hasSamePersistableCliHistoryIdentity(a: PersistableCliHistoryMessage, b: PersistableCliHistoryMessage): boolean {
    return String(a?.role || '') === String(b?.role || '')
        && String(a?.kind || '') === String(b?.kind || '')
        && String(a?.senderName || '') === String(b?.senderName || '')
        && String(a?.content || '') === String(b?.content || '');
}

export function buildIncrementalHistoryAppendMessages(
    previousMessages: PersistableCliHistoryMessage[],
    currentMessages: PersistableCliHistoryMessage[],
): PersistableCliHistoryMessage[] {
    if (!Array.isArray(currentMessages) || currentMessages.length === 0) return [];
    if (!Array.isArray(previousMessages) || previousMessages.length === 0) return currentMessages;

    const comparableLength = Math.min(previousMessages.length, currentMessages.length);
    let sharedPrefixLength = 0;
    while (
        sharedPrefixLength < comparableLength
        && hasSamePersistableCliHistoryIdentity(previousMessages[sharedPrefixLength], currentMessages[sharedPrefixLength])
    ) {
        sharedPrefixLength += 1;
    }

    if (sharedPrefixLength === currentMessages.length) return [];
    if (sharedPrefixLength === previousMessages.length) return currentMessages.slice(sharedPrefixLength);

    // Rare fallback: preserve the older whitespace-normalized behavior only when
    // the cheap identity check detects a changed prefix. Recomputing normalized
    // signatures for the full transcript on every idle status poll was a CPU
    // hot path for long CLI sessions.
    while (
        sharedPrefixLength < comparableLength
        && buildPersistableCliHistorySignature(previousMessages[sharedPrefixLength])
            === buildPersistableCliHistorySignature(currentMessages[sharedPrefixLength])
    ) {
        sharedPrefixLength += 1;
    }

    if (sharedPrefixLength === currentMessages.length) return [];
    if (sharedPrefixLength === previousMessages.length) return currentMessages.slice(sharedPrefixLength);
    return currentMessages;
}
