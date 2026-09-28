/**
 * Tail-SNAP selector for `session.<id>.chat` topics — design 2026-09-28
 * (message-keyed storage) §4.9, §5.7.
 *
 * A keyed topic's SNAP must describe one COMMITTED state plus the frame in
 * flight, never "the last N rows" (with more than N bubbles that would be a
 * wrong transcript). So the SNAP is
 *
 *     latestPerKey(W) ∪ rowsAfter(W),   W = rowid of the newest `commit` row
 *
 * in rowid order: every key's newest row at or below the last commit (the
 * committed state, tombstones included — a reader folds them as absent),
 * ending with that commit, then every row appended after it (the next frame,
 * still pending on the reader side). `KeyedTranscriptFolder.ingestSnapshot`
 * relies on exactly this shape.
 *
 * ── Fallbacks ──────────────────────────────────────────────────────────────
 * No commit yet → every row is pending: `rowsAfter(0)`. A throwing selector
 * degrades to the vendor's keyed default (`latestPerKey(null)`), which a
 * reader still folds correctly unless a torn frame is present — in which case
 * the digest check fails and the reader resubscribes. The v1 "last 500 rows"
 * window is never used for a keyed topic.
 */

import type { LogEntry, SeqscribeNodeExt, TailSource } from 'seqscribe';
import { sessionSegmentFromChatTopic } from './topics.js';
import { CHAT_COMMIT_KEY } from './transcript-keyed-codec.js';

/** `session.<safeSessionId>.chat` (topics.ts#sessionChatTopic). */
export function isSessionChatTopic(topic: string): boolean {
    return sessionSegmentFromChatTopic(topic) !== null;
}

/** The rows a `.chat` tail SNAP carries — see the header. */
export function selectChatTailSnapshot(src: TailSource): LogEntry[] | null {
    if (!src.keyed) return null;
    const head = src.keyHead(CHAT_COMMIT_KEY);
    if (!head) return src.rowsAfter(0).map((r) => r.entry);
    const committed = src.latestPerKey(head.rowid);
    const after = src.rowsAfter(head.rowid);
    return [...committed.map((r) => r.entry), ...after.map((r) => r.entry)];
}

/**
 * Install the chat selector on the daemon's node. Every other tail topic
 * (`fleet.status`, …) keeps the vendor default.
 */
export function installTranscriptTailSnapshotSelector(node: Pick<SeqscribeNodeExt, 'setTailSnapshotSelector'>): void {
    node.setTailSnapshotSelector((src) => (isSessionChatTopic(src.topic) ? selectChatTailSnapshot(src) : null));
}
