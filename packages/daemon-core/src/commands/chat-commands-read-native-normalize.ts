/**
 * chat-commands-read-native-normalize — native-history message identity and
 * normalization for the read path.
 *
 * Extracted from chat-commands-read.ts as a pure move ahead of the file-size
 * gate; logic is unchanged and chat-commands-read.ts keeps its exact public
 * export surface by re-exporting normalizeNativeHistoryMessages from here.
 *
 * Owns the (CHAT-FLAP-LONG-CONVO) position-independent providerUnitKey /
 * bubbleId stamping: native history is re-derived on every read_chat, so a key
 * that embedded an array index changed for every pre-existing bubble whenever
 * the tail grew, remounting the whole list in the dashboard.
 *
 * Leaf placement note: read-chat-source-decision.ts previously imported
 * normalizeNativeHistoryMessages back out of chat-commands-read.ts, a cycle
 * between two non-leaf modules. Hosting it here lets that module depend on a
 * leaf instead, with no behaviour change.
 */

import type { CommandHelpers } from './handler.js';
import type { ChatMessage } from '../types.js';
import { flattenContent } from '../providers/contracts.js';
import { normalizeChatMessages } from '../providers/chat-message-normalization.js';
import { hashSignatureParts } from '../chat/chat-signatures.js';
import { maybeHideCoordinatorPromptMessage } from './read-chat-message-filters.js';

export function readHistorySessionIdFromMessages(messages: ChatMessage[]): string | undefined {
    for (const message of messages as Array<ChatMessage & { historySessionId?: unknown }>) {
        const historySessionId = typeof message?.historySessionId === 'string' ? message.historySessionId.trim() : '';
        if (historySessionId) return historySessionId;
    }
    return undefined;
}

function shouldPreserveNativeIdentity(providerType: string, sessionId: string, message: ChatMessage): boolean {
    const providerUnitKey = typeof message.providerUnitKey === 'string' ? message.providerUnitKey.trim() : '';
    const turnKey = typeof message._turnKey === 'string' ? message._turnKey.trim() : '';
    if (!providerUnitKey) return false;
    // (A2.3) v2 stamped identity is producer-owned and globally stable; trust it
    // unconditionally. Producers may omit _turnKey (the daemon recomputes it
    // from the current ordering), so do not require turnKey for v2 messages.
    // (CHAT-FLAP-LONG-CONVO) v3 native identity is daemon-stamped and
    // position-independent (see normalizeNativeHistoryMessages); trust it the
    // same way so a re-read of an already-normalized message preserves its key.
    if (providerUnitKey.startsWith('v2:') || providerUnitKey.startsWith('v2-pty:') || providerUnitKey.startsWith('v3:')) {
        return true;
    }
    // v1 identity always required both keys to be present.
    if (!turnKey) return false;
    if (providerType === 'hermes-cli' && sessionId) {
        return providerUnitKey.startsWith(`${providerType}:native:${sessionId}:`)
            && turnKey.startsWith(`${providerType}:native-turn:${sessionId}:`);
    }
    return true;
}

/**
 * Convenience wrapper used at every native-history call site: normalize +
 * conditionally drop the coordinator system-prompt message. Avoids
 * duplicating the filter at four read_chat code paths.
 */
export function normalizeAndFilterNativeHistory(
    h: CommandHelpers,
    providerType: string,
    args: any,
    messages: ChatMessage[],
    nativeSessionId?: string,
): ChatMessage[] {
    const normalized = normalizeNativeHistoryMessages(providerType, messages, nativeSessionId);
    const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId
        : typeof args?.sessionId === 'string' ? args.sessionId
        : undefined;
    return maybeHideCoordinatorPromptMessage(h, providerType, sessionId, normalized);
}

export function normalizeNativeHistoryMessages(providerType: string, messages: ChatMessage[], nativeSessionId?: string): ChatMessage[] {
    let turnIndex = 0;
    // (CHAT-FLAP-LONG-CONVO root fix) The providerUnitKey / bubbleId MUST be
    // position-independent: native history is re-derived on every read_chat, so
    // sending a user message grows the tail and shifts every array index by one.
    // A key that embeds `index` therefore changes for every pre-existing bubble
    // across a send → web-core getChatMessageStableKey (which correctly trusts
    // bubbleId/providerUnitKey as identity) sees a new React key → unmount+remount
    // flash. The invariant we enforce here: the same logical message keeps the
    // same key as the tail grows; different messages get different keys.
    //
    // Position-independent identity = (role, kind, content-signature) plus, for
    // messages whose (role, kind, content-signature) collides (e.g. an identical
    // reply repeated in the transcript, or ts-less messages), a stable occurrence
    // ordinal: the count of prior messages sharing the same signature. Appending
    // to the tail never renumbers earlier occurrences, so the ordinal is stable.
    // A provider-supplied native id (message.id) short-circuits the ordinal — it
    // is already globally unique and position-independent.
    const signatureOccurrences = new Map<string, number>();
    // Anchor for the ts-less sequence fallback (see below): the last real
    // timestamp seen, plus a running offset so consecutive ts-less messages stay
    // strictly ordered after it.
    let lastSequenceAnchor = 0;
    let anchorOffset = 0;
    return normalizeChatMessages(messages).map((message, index) => {
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        const kind = typeof message.kind === 'string' && message.kind.trim() ? message.kind.trim() : (role === 'system' ? 'system' : 'standard');
        if ((role === 'user' || role === 'human') && index > 0) turnIndex += 1;
        const historySessionId = typeof (message as any).historySessionId === 'string'
            ? (message as any).historySessionId.trim()
            : '';
        // Content signature is intentionally position-independent: the ts fallback
        // is '' (NOT `index`) so a message with no timestamp still hashes the same
        // regardless of where it sits in the array. Hash the FULL flattened content
        // (no slice) so distinct long messages that share a 12-char prefix do not
        // collide.
        const contentSignature = hashSignatureParts([
            providerType,
            historySessionId,
            String(message.receivedAt || message.timestamp || ''),
            role,
            kind,
            flattenContent(message.content),
        ]);
        const contentHash = contentSignature.slice(0, 12);
        const nativeIdentitySessionId = historySessionId || (typeof nativeSessionId === 'string' ? nativeSessionId.trim() : '');
        // Stable occurrence ordinal for signature collisions (0 for the first,
        // 1 for the second identical-signature message, …). A provider-native id,
        // when present, is preferred as the collision discriminator because it is
        // globally unique and never renumbers.
        const nativeMessageId = typeof message.id === 'string' && message.id.trim() ? message.id.trim() : '';
        const occurrence = signatureOccurrences.get(contentSignature) ?? 0;
        signatureOccurrences.set(contentSignature, occurrence + 1);
        const collisionDiscriminator = nativeMessageId || `#${occurrence}`;
        const preserveNativeIdentity = shouldPreserveNativeIdentity(providerType, nativeIdentitySessionId, message);
        const existingProviderUnitKey = typeof message.providerUnitKey === 'string' ? message.providerUnitKey.trim() : '';
        const existingTurnKey = typeof message._turnKey === 'string' ? message._turnKey.trim() : '';
        const providerUnitKey = preserveNativeIdentity
            ? existingProviderUnitKey
            : `v3:${providerType}:native:${nativeIdentitySessionId || 'workspace'}:${role || 'message'}:${kind}:${contentHash}:${collisionDiscriminator}`;
        const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : undefined;
        const isSystemSessionStart = role === 'system' || kind === 'system' || kind === 'session_start';
        const isActivity = role === 'assistant' && (kind === 'tool' || kind === 'terminal' || kind === 'thought');
        // (A2.3) sequence emit. Producer-supplied wins (v2-stamped messages
        // bring their own monotonic sequence); otherwise derive from
        // receivedAt/timestamp; otherwise positional. Always present on the
        // output so consumers (ChatSourceMachine) have a stable ordering key.
        const existingSequence = typeof (message as any).sequence === 'number'
            && Number.isFinite((message as any).sequence)
                ? (message as any).sequence
                : null;
        const tsCandidate = Number(message.receivedAt || message.timestamp || 0);
        // (CHAT-FLAP-LONG-CONVO) sequence is part of web-core's React-key
        // composite, so a ts-less fallback of `index` would also shift the key
        // across a send. Anchor a ts-less message to the last real timestamp
        // seen (plus its occurrence offset within that anchor) so the value stays
        // ordered AND stable under tail-append instead of tracking the raw
        // array position.
        let sequence: number;
        if (existingSequence !== null) {
            sequence = existingSequence;
        } else if (tsCandidate > 0) {
            sequence = tsCandidate;
            lastSequenceAnchor = tsCandidate;
            anchorOffset = 0;
        } else {
            anchorOffset += 1;
            sequence = lastSequenceAnchor + anchorOffset;
        }
        return {
            ...message,
            role: role === 'human' ? 'user' : (role || 'assistant'),
            kind: isSystemSessionStart ? 'system' : kind,
            ...(nativeIdentitySessionId ? { historySessionId: nativeIdentitySessionId } : {}),
            providerUnitKey,
            bubbleId: typeof message.bubbleId === 'string' && message.bubbleId.trim()
                && preserveNativeIdentity
                ? message.bubbleId.trim()
                : `bubble:${providerUnitKey}`,
            sequence,
            _turnKey: preserveNativeIdentity
                ? existingTurnKey
                : `${providerType}:native-turn:${nativeIdentitySessionId || 'workspace'}:${turnIndex}`,
            bubbleState: message.bubbleState || 'final',
            ...(isSystemSessionStart ? {
                visibility: message.visibility || 'hidden',
                transcriptVisibility: message.transcriptVisibility || 'hidden',
                audience: message.audience || 'internal',
                source: message.source || 'runtime_status',
            } : isActivity ? {
                source: message.source || (kind === 'terminal' ? 'terminal_command' : 'tool_call'),
                meta: { ...meta, label: message.senderName || meta?.label || (kind === 'terminal' ? 'Terminal' : 'Tool') },
            } : {
                source: message.source || (role === 'assistant' ? 'assistant_text' : undefined),
            }),
        } as ChatMessage;
    });
}
