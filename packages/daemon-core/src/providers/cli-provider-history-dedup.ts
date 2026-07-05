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
};

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
