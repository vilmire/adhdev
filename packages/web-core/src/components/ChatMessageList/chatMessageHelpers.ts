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

const SAFE_RESOURCE_HREF_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'file:']);

/**
 * Validate a resource_link/resource URI before rendering it as an anchor href.
 * These URIs come from agent/tool output and could otherwise smuggle a
 * `javascript:` URI that executes on click. Allow-list only — `file:` is
 * included because agents legitimately reference local workspace files this
 * way (see buildMediaSrc's identical `file://` usage for image/audio/video
 * src), which is inert (no script execution) unlike `javascript:`/`data:`.
 */
export function safeResourceHref(uri: string | undefined): string | undefined {
    if (!uri) return undefined;
    try {
        const parsed = new URL(uri);
        return SAFE_RESOURCE_HREF_PROTOCOLS.has(parsed.protocol) ? uri : undefined;
    } catch {
        return undefined;
    }
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
 *
 * ── ★ Why a TURN-GRAINED-ONLY identity is not enough ───────────────────────
 * `_turnKey` is turn-grained: the producer mints one value per user message, so
 * every bubble of a multi-bubble turn (prompt → tool → output → answer) shares
 * it. It only yields a per-BUBBLE key when a per-message field (`bubbleId`,
 * `providerUnitKey`, `index`, `sequence`) joins it in the composite.
 *
 * On the replica path that is NOT guaranteed. `ReplicatedTranscriptMessageV1.
 * sequence` is `number | null` BY DESIGN ("null means UNKNOWN, never 0"), and
 * `transcript-chat-pane-adapter.ts` deliberately maps `turnKey` → `_turnKey`
 * while leaving `bubbleId`/`providerUnitKey` unset (the former would collapse
 * the turn, the latter embeds a content hash the wire allow-list excludes). So
 * a producer that emits `turnKey` without a numeric `sequence` — the identity
 * stamping in `chat-commands-read.ts` / `parse-session.ts` is per-path, not a
 * property of `ChatMessage` itself — reduces the whole composite to
 * `turn:<turnKey>` and EVERY bubble of that turn collides on one React key.
 * React then reconciles distinct bubbles into each other: the turn renders
 * fewer rows than it has, and a surviving row can show another bubble's
 * content. That is the same failure `transcript-adapter-bubble-identity.test.ts`
 * guards on the adapter side, reached through the nullable-`sequence` door.
 *
 * The guard below therefore adds a content-derived discriminator ONLY when the
 * identity found so far is turn-grained-only. Keys for messages that DO carry a
 * per-message field are byte-identical to before, so no bubble remounts (the
 * CHAT-FLAP-LONG-CONVO scroll/flash regression) as a result of this fix, and a
 * given bubble hashes the same in the live and history stores — seam-stable.
 */
export function getChatMessageStableKey(message: ChatMessage, index: number): string {
    void index;
    const dashboardMessage = message as ChatMessage & { _localId?: string; _turnKey?: string }
    const content = stringifyTextContent(message.content, { joiner: '\n' });

    // Position-independent stable identity, most-authoritative first.
    // `perMessage` fields identify ONE bubble; `_turnKey` identifies the turn
    // that contains it and is shared by that turn's siblings.
    const perMessageIdentity = [
        message.id ? `id:${message.id}` : '',
        dashboardMessage._localId ? `local:${dashboardMessage._localId}` : '',
        message.bubbleId ? `bubble:${message.bubbleId}` : '',
        message.providerUnitKey ? `unit:${message.providerUnitKey}` : '',
        typeof message.index === 'number' ? `msgIndex:${message.index}` : '',
        typeof message.sequence === 'number' ? `seq:${message.sequence}` : '',
    ].filter(Boolean);

    // Preserved emission order (id > _localId > _turnKey > bubbleId > ...) so
    // every key that was already unique keeps its exact previous value.
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
        // ★ Turn-grained-only: `_turnKey` is the sole identity we have, so it is
        // shared with every sibling bubble of this turn. Discriminate with the
        // same position-independent material the no-identity fallback uses
        // (role + full-content hash + timestamp) rather than the array index,
        // which would shift under windowing/re-sort and remount the bubble.
        if (perMessageIdentity.length === 0) {
            const turnTimestamp = message.receivedAt || message.timestamp || 0;
            return [
                ...identity,
                `role:${message.role ?? ''}`,
                `chash:${hashContent(content)}`,
                ...(turnTimestamp ? [`ts:${turnTimestamp}`] : []),
            ].join('|');
        }
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

/**
 * List-level React keys for a rendered message array — the call sites' entry
 * point. Use this instead of mapping `getChatMessageStableKey` yourself.
 *
 * ── The residual collision this closes ─────────────────────────────────────
 * `getChatMessageStableKey`'s two derived tiers (turn-grained-only, and
 * no-identity-at-all) discriminate with `role + content-hash + timestamp`.
 * That separates bubbles that DIFFER in any of those, but two sibling bubbles
 * of one turn that match on ALL of them still return one key. Measured:
 *   { role:'assistant', content:'same', _turnKey:'_turn' } × 2
 *   → both `turn:_turn|role:assistant|chash:yjccrj`.
 * This is reachable, not theoretical: `collapseAdjacentDuplicateChatMessages`
 * (daemon-core `read-chat-presentation.ts`) collapses only *adjacent*
 * duplicates — its own test pins that `A, B, A` in one turn survives as three
 * messages. A turn whose producer emits no numeric `sequence` therefore renders
 * bubbles 1 and 3 under a single React key, and React reconciles them into each
 * other: the turn shows fewer rows than it has.
 *
 * ── Why an OCCURRENCE ordinal, not the array index ─────────────────────────
 * The array index is exactly the position-dependent material
 * `getChatMessageStableKey` exists to avoid (CHAT-FLAP-LONG-CONVO): windowing
 * and re-sorting renumber it, and a key that moves remounts its bubble.
 *
 * The ordinal here is instead "the Nth message in this list carrying this same
 * base key", and it is applied ONLY to base keys that actually repeat. That
 * makes it stable under both mutations the pipeline performs:
 *  - Windowing drops from the HEAD (`buildVisibleConversationMessages` slices
 *    `liveMessages.slice(-visibleLiveCount)`), which never reorders survivors.
 *  - The chronological sort is stable and tie-breaks on original index
 *    (`sortMessagesChronologically`), so two siblings with identical timestamps
 *    keep their relative order across every re-sort.
 * So a duplicate's ordinal is derived from its position *within its own
 * duplicate group*, not within the list — a group whose members never reorder.
 *
 * Seam consequence, stated honestly: if head-windowing drops an EARLIER member
 * of a duplicate group, the survivor's ordinal shifts (`#1` → `#0`) and that one
 * bubble remounts. That is strictly better than the status quo, where the same
 * bubble does not merely remount but is *reconciled away* and can display a
 * sibling's content. It costs a remount only for genuinely indistinguishable
 * bubbles — every message carrying any per-message identity (`id`/`_localId`/
 * `bubbleId`/`providerUnitKey`/`index`/`sequence`) has a unique base key, never
 * enters a duplicate group, and keeps a byte-identical key. The live and history
 * stores feed one merged array here, so a given bubble is keyed once per render
 * from the same material regardless of which store produced it.
 */
export function buildChatMessageStableKeys(messages: readonly ChatMessage[]): string[] {
    const baseKeys = messages.map((message, index) => getChatMessageStableKey(message, index));

    // Only base keys that actually repeat get an ordinal, so every already-unique
    // key (i.e. every message with per-message identity) is returned unchanged.
    const totals = new Map<string, number>();
    for (const key of baseKeys) totals.set(key, (totals.get(key) ?? 0) + 1);

    const seen = new Map<string, number>();
    return baseKeys.map((key) => {
        if ((totals.get(key) ?? 0) < 2) return key;
        const ordinal = seen.get(key) ?? 0;
        seen.set(key, ordinal + 1);
        return `${key}|dup:${ordinal}`;
    });
}
