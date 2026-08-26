/**
 * assistant.journal — the Phase 1 greenfield consumer path (design §2).
 *
 * The cross-daemon assistant journal is the first topic with a real producer
 * and consumer. The assistant FEATURE itself is unbuilt; this module is its
 * official API surface so tests and simulators exercise the exact calls the
 * feature will make, rather than poking `node.log()` directly.
 *
 * ── Why a wrapper at all ────────────────────────────────────────────────────
 * Two things the raw library calls cannot say:
 *
 *   1. AUTHORITY-LESS MODE. Without the fleet secret the node defines metadata
 *      topics only (node.ts), so `assistant.journal` may simply not exist.
 *      `appendAssistantJournal` turns that into a clear, actionable error
 *      instead of the library's `ERR_UNKNOWN_TOPIC`.
 *   2. CURSOR SEMANTICS. `onEntry` cursors are durable — the library persists
 *      them in seqscribe.db (`sq_cursors`) — so the consumer NAME is an
 *      identity with a resume guarantee, and callers should treat it as such.
 */

import type { EntryId, JsonValue, LogEntry, Unsub } from 'seqscribe';
import type { SeqscribeNodeHandle } from './node.js';
import { ASSISTANT_JOURNAL_TOPIC } from './topics.js';

/**
 * Append one entry to the assistant journal.
 *
 * Throws a plain Error when the topic is not defined on this node — the
 * authority-less (provisional) boot mode skips every content topic, and the
 * remedy is always the same: the fleet secret, from
 * ADHDEV_SEQSCRIBE_FLEET_SECRET or the auth_ok-delivered store.
 */
export async function appendAssistantJournal(
    handle: SeqscribeNodeHandle,
    kind: string,
    payload: JsonValue,
): Promise<EntryId> {
    if (!handle.topics.some((d) => d.topic === ASSISTANT_JOURNAL_TOPIC)) {
        throw new Error(
            `cannot append to ${ASSISTANT_JOURNAL_TOPIC}: the topic is not defined on this node. ` +
            'Content topics require the fleet secret (ADHDEV_SEQSCRIBE_FLEET_SECRET env var or the auth_ok-delivered store); ' +
            'without it the node runs metadata-topics-only.',
        );
    }
    return handle.node.log(ASSISTANT_JOURNAL_TOPIC).append(kind, payload);
}

/**
 * Consume the assistant journal under a durable consumer name.
 *
 * The cursor is DURABLE: the library persists it in seqscribe.db (`sq_cursors`),
 * so re-registering the same consumer name after a restart resumes exactly
 * where it left off — no duplicates, no gaps. A new name starts a fresh,
 * independent tail from the beginning of the retained log.
 *
 * Delivery is PROVISIONAL until finality (host-guide §4): entries arrive in
 * rowid order as they sync, and only a finality certificate makes a prefix
 * normative. Consumers that need the finalized view track `node.finality()`
 * themselves; nothing here filters on it.
 */
export function consumeAssistantJournal(
    handle: SeqscribeNodeHandle,
    consumer: string,
    cb: (entry: LogEntry) => void | Promise<void>,
): Unsub {
    if (typeof consumer !== 'string' || consumer.trim().length === 0) {
        throw new Error('consumeAssistantJournal requires a non-empty consumer name');
    }
    return handle.node.onEntry(ASSISTANT_JOURNAL_TOPIC, consumer, cb);
}
