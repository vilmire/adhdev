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
import { recordProjectionCarry } from '../shared/projection-carry-counters.js';

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
export type BubbleIdentityFields = {
    sequence?: number;
    _turnKey?: string;
    bubbleState?: string;
    providerUnitKey?: string;
    bubbleId?: string;
};

/**
 * (G1) Set only while `carryMessageRefs` delegates into `carryBubbleIdentity`,
 * so one message is counted once rather than twice.
 *
 * A module-level boolean is safe here because both helpers are synchronous and
 * allocation-free — there is no await between set and clear, so no other
 * message can interleave on the event loop.
 */
let suppressCarryCounting = false;

export function carryBubbleIdentity(message: BubbleIdentityFields): BubbleIdentityFields {
    // (G1) See `carryMessageRefs` below: it records on the caller's behalf and
    // then delegates here, so recording again would double-count. This flag is
    // set only for that internal delegation, never by an outside caller.
    if (!suppressCarryCounting) {
        // ★ `true` for the ref, NOT false. This helper is the identity-only hop
        // by design (the on-disk writer must not persist an mtime-sealed ref),
        // so a ref on the input is a deliberate non-carry, not a drop. Passing
        // `true` means "no drop to report" without having to allocate a stripped
        // copy of the message on a per-message hot path.
        recordProjectionCarry(message, true);
    }
    return {
        ...(typeof message?.sequence === 'number' && Number.isFinite(message.sequence) ? { sequence: message.sequence } : {}),
        ...(message?._turnKey ? { _turnKey: message._turnKey } : {}),
        ...(message?.bubbleState ? { bubbleState: message.bubbleState } : {}),
        ...(message?.providerUnitKey ? { providerUnitKey: message.providerUnitKey } : {}),
        ...(message?.bubbleId ? { bubbleId: message.bubbleId } : {}),
    };
}

/**
 * The daemon-internal carry set: bubble identity PLUS the tool-block ref.
 *
 * `carryBubbleIdentity` covers identity alone because one hop — the on-disk
 * incremental-append writer — must carry identity but must NOT persist the ref
 * (it is sealed by `sourceMtimeMs`, so a stored ref is dead on the next read).
 * Every OTHER daemon-internal hop wants both, and hand-rolling the pair at each
 * one is what let `toolBlockRef` go missing at three separate hops.
 *
 * Both fields are copied by NAME and only when present, so a bubble that never
 * carried them does not gain `undefined` keys — the activeChat projection feeds
 * `ChatMessage` objects straight to the dashboard, where an always-present
 * `toolBlockRef: undefined` would be indistinguishable from a real ref to a
 * `in` check.
 *
 * Identifiers, ordinals and three integers — never content. This is L3 only:
 * `providerUnitKey` embeds a content hash and must not reach the replica wire
 * (see `seqscribe/transcript-projection.ts`).
 */
export function carryMessageRefs(message: BubbleIdentityFields & {
    toolBlockRef?: { sourceMtimeMs: number; recordIndex: number; blockIndex: number };
}): Partial<Pick<PersistableCliHistoryMessage, 'toolBlockRef'>> & BubbleIdentityFields {
    const carriedToolBlockRef = Boolean(message?.toolBlockRef);
    // (G1) Measured HERE rather than inside `carryBubbleIdentity`, even though
    // that is the deeper helper: this function calls it, so instrumenting both
    // would double-count every message that comes through this path. The
    // identity-only hop is counted at its own call site instead.
    recordProjectionCarry(message, carriedToolBlockRef);
    suppressCarryCounting = true;
    try {
        return {
            ...(carriedToolBlockRef ? { toolBlockRef: message.toolBlockRef } : {}),
            ...carryBubbleIdentity(message),
        };
    } finally {
        // `finally` rather than a plain reset after the return: `carryBubbleIdentity`
        // is allocation-only and should not throw, but leaving this flag stuck on
        // would silently stop counting for the rest of the process — a failure
        // mode strictly worse than the one the counters exist to detect.
        suppressCarryCounting = false;
    }
}

/**
 * The canonical daemon-internal chat-message projection.
 *
 * @message-projection l3 identity
 *
 * ── What this replaced ─────────────────────────────────────────────────────
 * Three hops between the native-history reader and `activeChat.messages` each
 * wrote their own field-by-field remap of the SAME five fields plus the carry
 * set: the hydration read (`toPersistableMessages`), the activeChat projection
 * and the persisted-tail projection. They drifted independently — which is how
 * `toolBlockRef` came to be fixed at one hop while still missing at the next,
 * three times. One function now owns the field list.
 *
 * ── The one real difference, made explicit ─────────────────────────────────
 * The persisted-tail hop needs two things the other two do not, and both are
 * genuine, not incidental:
 *   - `content` must be FLATTENED (`MessagePart[]` → string), because the
 *     persisted shape is text-only.
 *   - `receivedAt` falls back to the parser's `timestamp`, which only live
 *     parser output carries.
 * These are passed as explicit resolvers rather than a boolean flag, so the
 * call site states what it wants instead of naming a mode whose meaning has to
 * be looked up. Callers that want neither simply omit them.
 *
 * Fields are copied by NAME and only when present — never a spread of the
 * source. The rows this produces are handed to the dashboard, where an
 * always-present `toolBlockRef: undefined` is not the same as an absent one.
 *
 * ── What this deliberately does NOT absorb ─────────────────────────────────
 * Other chat-message mappings exist and stay separate ON PURPOSE. They are not
 * leftover duplication:
 *
 *   read-chat-contract.ts `validateMessage` — a VALIDATOR, not a projection.
 *     It preserves any producer-supplied field verbatim (the contract is
 *     deliberately open) and its job is to reject malformed input, not to
 *     narrow a known shape.
 *
 *   seqscribe/transcript-projection.ts `encodeTranscriptMessage` — the L2
 *     replica wire. A CONTENT BOUNDARY, not a convenience remap: it must
 *     exclude `providerUnitKey` (a content hash) and carries a different,
 *     narrower field set. Merging it here would put a boundary decision behind
 *     a shared helper where a future field addition could widen it silently.
 *
 *   mesh/transcript-read-chat-adapter.ts + web-core's
 *   transcript-chat-pane-adapter.ts — the two wire DECODERS. They run on the
 *     far side of the boundary, reconstruct from nullable wire scalars rather
 *     than optional daemon fields, and one of them lives in a different
 *     package. Their shared discipline is enforced by
 *     `check:message-projection-parity`, not by a shared function.
 *
 *   config/chat-history.ts `appendNewMessages` — carries identity but must NOT
 *     persist `toolBlockRef` (mtime-sealed; dead once written). It delegates to
 *     `carryBubbleIdentity` for exactly that reason.
 */
export function projectCliChatMessage(
    message: PersistableCliHistoryMessage & { timestamp?: number },
    options: {
        /**
         * Flatten `MessagePart[]` content to text (persisted shape only).
         * Typed on the projection's OWN content type rather than `unknown`, so
         * passing `flattenContent` directly type-checks without a cast.
         */
        flattenContent?: (content: PersistableCliHistoryMessage['content']) => string;
        /** Accept the parser's `timestamp` when `receivedAt` is absent. */
        fallBackToParserTimestamp?: boolean;
    } = {},
): PersistableCliHistoryMessage {
    return {
        role: message.role,
        content: options.flattenContent
            ? options.flattenContent(message.content)
            : message.content,
        kind: typeof message.kind === 'string' ? message.kind : undefined,
        senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
        receivedAt: typeof message.receivedAt === 'number'
            ? message.receivedAt
            : (options.fallBackToParserTimestamp ? message.timestamp : undefined),
        ...carryMessageRefs(message),
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
