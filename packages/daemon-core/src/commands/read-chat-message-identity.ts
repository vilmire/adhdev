/**
 * read_chat ↔ message identity ledger glue.
 *
 * Design: docs/design/2026-09-28-transcript-message-keyed-storage.md §3.3.
 * `buildReadChatCommandResult` (the read_chat choke point) runs every observed
 * bubble through the session's `MessageIdentityLedger` and stamps the resulting
 * opaque `messageId` onto what it returns. This module owns the ChatMessage-
 * specific parts: what the ledger sees of a message, which coverage a read
 * implies, and the final stamp (which is also where the daemon-internal `_src`
 * is dropped for good).
 *
 * The ledger itself is pure and lives in `chat/`; this adapter stays in
 * `commands/` next to the choke point that is its only caller.
 */

import type { ChatMessage } from '../types.js';
import { flattenContent } from '../providers/contracts.js';
import {
    getMessageIdentityLedger,
    type MessageIdentityCoverage,
    type MessageIdentityFrame,
    type MessageIdentityInput,
} from '../chat/message-identity-ledger.js';
import { keyedNativeAddress, nativeSourceAddress, readMessageSourceAddress } from '../chat/message-source-address.js';

function normalizedRole(message: ChatMessage): string {
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    return role === 'human' ? 'user' : role;
}

function normalizedKind(message: ChatMessage): string {
    return typeof message.kind === 'string' && message.kind.trim() ? message.kind.trim() : 'standard';
}

function flattenedText(message: ChatMessage): string {
    try {
        return flattenContent(message.content as any);
    } catch {
        return '';
    }
}

/**
 * Presentation fingerprint whose change bumps a bubble's `rev`. Covers the
 * fields a consumer renders; local only (the ledger never emits it).
 */
export function messageIdentityRevisionKey(message: ChatMessage, text = flattenedText(message)): string {
    const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : undefined;
    return JSON.stringify([
        normalizedRole(message),
        normalizedKind(message),
        text,
        message.bubbleState ?? null,
        message._turnKey ?? null,
        message.senderName ?? null,
        message.toolName ?? null,
        typeof message.receivedAt === 'number' ? message.receivedAt : null,
        typeof message.timestamp === 'number' ? message.timestamp : null,
        meta?.streaming === true,
    ]);
}

export function toMessageIdentityInput(message: ChatMessage): MessageIdentityInput {
    const text = flattenedText(message);
    const src = readMessageSourceAddress((message as { _src?: unknown })._src);
    return {
        role: normalizedRole(message),
        kind: normalizedKind(message),
        text,
        ...(src ? { src } : {}),
        revisionKey: messageIdentityRevisionKey(message, text),
    };
}

/**
 * Which coverage a read implies (§3.5). Anything short of a declared `'full'`
 * read — a native tail window, a current-turn view, and every IDE/extension
 * DOM read (virtualized scrollback) — is a window: bubbles that fell off the
 * front were not deleted.
 */
export function resolveReadChatIdentityCoverage(
    payloadCoverage: unknown,
    forced?: MessageIdentityCoverage,
): MessageIdentityCoverage {
    if (forced) return forced;
    if (payloadCoverage === undefined || payloadCoverage === null || payloadCoverage === 'full') return 'full';
    return 'window';
}

/**
 * Run one observation through the session ledger. Returns each observed
 * message's id keyed by the message OBJECT, so the caller can stamp any subset
 * (visible slice, tail) that shares those objects.
 */
export function assignReadChatMessageIds(
    sessionKey: string,
    messages: readonly ChatMessage[],
    coverage: MessageIdentityCoverage,
): { ids: Map<ChatMessage, string>; frame: MessageIdentityFrame } {
    const ledger = getMessageIdentityLedger(sessionKey);
    const frame = ledger.observe(messages.map(toMessageIdentityInput), { coverage });
    const ids = new Map<ChatMessage, string>();
    for (let i = 0; i < messages.length; i += 1) ids.set(messages[i], frame.assignments[i].messageId);
    return { ids, frame };
}

/**
 * The outgoing message: `messageId` added, `id` overwritten with it (§5.4 —
 * an IDE script's positional `'msg_'+i` must not travel as identity), and the
 * daemon-internal `_src` removed.
 */
export function withMessageIdentity(message: ChatMessage, messageId: string | undefined): ChatMessage {
    const { _src, ...rest } = message as ChatMessage & { _src?: unknown };
    void _src;
    if (!messageId) return rest as ChatMessage;
    return { ...rest, id: messageId, messageId } as ChatMessage;
}

/**
 * IDE / extension DOM scripts MAY report a DOM-native message id as
 * `messageId` (optional script contract field, design §3.1 IDE row). When
 * present it becomes a native `_src` (`n.<L>.k<id>.0`), so the bubble keeps its
 * id however the DOM virtualizes around it; without it the bubble falls to the
 * aligner. The script's own value never travels further: the read_chat
 * contract drops `messageId` and the choke point mints the outgoing one.
 *
 * Returns a shallow copy of `parsed` with fresh message objects where a source
 * was stamped; `parsed` itself is not mutated.
 */
export function stampDomScriptMessageSources(parsed: unknown, lineageSeed: unknown): unknown {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.messages)) return parsed;
    const seed = [record.providerSessionId, record.id, lineageSeed]
        .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    if (!seed) return parsed;
    let stamped = false;
    const messages = record.messages.map((message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
        const nativeId = (message as Record<string, unknown>).messageId;
        const src = nativeSourceAddress(seed, keyedNativeAddress(nativeId, 0));
        if (!src) return message;
        stamped = true;
        return { ...(message as Record<string, unknown>), _src: src };
    });
    return stamped ? { ...record, messages } : parsed;
}
