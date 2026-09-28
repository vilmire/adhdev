/**
 * Producer-side parity `actual` reader for the keyed chat topic — design
 * 2026-09-28 (message-keyed storage) §5.5.
 *
 * Reads back what this node's OWN `session.<id>.chat` topic holds at a commit
 * watermark W — the newest row per key at or below W (`scanLatestPerKey`) —
 * and folds it through a `KeyedTranscriptFolder` exactly as a subscriber's
 * SNAP would. The result is the "actual" side of the parity comparison
 * (transcript-parity.ts); the "expected" side is the frame the publisher just
 * built from the legacy read_chat observation.
 *
 * Audit-only: live consumers read through the `tail` SUB
 * (transcript-replica-store.ts), never by scanning. This path shares no state
 * with them — only the folder class, so a folder defect shows up here too.
 */

import type { LogEntry } from 'seqscribe';
import type { SeqscribeNodeHandle } from './node.js';
import { sessionChatTopic } from './topics.js';
import { CHAT_COMMIT_KEY } from './transcript-keyed-codec.js';
import { KeyedTranscriptFolder, type KeyedChatRow } from './transcript-keyed-folder.js';
import type { TranscriptParityActual } from './transcript-parity.js';

/** Page size for the newest-per-key scans (the vendor caps a page at 10,000). */
export const CHAT_SCAN_PAGE_ROWS = 2_000;

/**
 * Every newest-per-key row of `topic` in rowid order, paging until complete.
 * `uptoRowid` is the watermark (rows above it neither returned nor
 * superseding); `afterRowid` keeps only rows ABOVE it (the torn tail).
 */
export function scanAllLatestPerKey(
    node: Pick<SeqscribeNodeHandle, 'node'>,
    topic: string,
    options: { uptoRowid?: number; afterRowid?: number } = {},
): { entry: LogEntry; rowid: number }[] {
    const out: { entry: LogEntry; rowid: number }[] = [];
    let after = options.afterRowid ?? 0;
    for (;;) {
        const page = node.node.scanLatestPerKey(topic, {
            ...(options.uptoRowid !== undefined ? { uptoRowid: options.uptoRowid } : {}),
            afterRowid: after,
            limit: CHAT_SCAN_PAGE_ROWS,
        });
        out.push(...page.entries);
        if (page.complete || page.nextAfterRowid === undefined || page.nextAfterRowid <= after) break;
        after = page.nextAfterRowid;
    }
    return out;
}

/** `LogEntry` → folder row (its payload is already parsed, unlike a SUB `Row`). */
export function chatRowFromEntry(entry: LogEntry): KeyedChatRow {
    return { writer: entry.writer, seq: entry.seq, kind: entry.kind, payload: entry.payload };
}

/**
 * The committed view this node's chat topic holds for `rawSessionId` at the
 * newest commit (or at `uptoRowid`), or `{status:'missing'}` when there is no
 * verifiable commit. Never throws — parity is diagnostics.
 */
export function readLocalChatParityActual(
    node: SeqscribeNodeHandle,
    rawSessionId: string,
    options: { uptoRowid?: number } = {},
): TranscriptParityActual {
    const topic = sessionChatTopic(rawSessionId);
    try {
        const watermark = options.uptoRowid ?? node.node.keyHead(topic, CHAT_COMMIT_KEY)?.rowid;
        if (watermark === undefined) return { status: 'missing' };
        const rows = scanAllLatestPerKey(node, topic, { uptoRowid: watermark }).map(({ entry }) => chatRowFromEntry(entry));
        const folder = new KeyedTranscriptFolder({ expectedSessionId: rawSessionId });
        folder.ingestSnapshot(rows);
        const view = folder.view();
        const commit = folder.lastCommit();
        if (!view || !commit) return { status: 'missing' };
        return { status: 'found', view, commit };
    } catch {
        return { status: 'missing' };
    }
}
