import { describe, expect, it } from 'vitest';
import { CHAT_COMMIT_KIND, CHAT_DEL_KIND, CHAT_LIVE_BYTES_MAX } from '../../src/seqscribe/transcript-keyed-codec.js';
import { KeyedTranscriptFolder, type KeyedChatRow } from '../../src/seqscribe/transcript-keyed-folder.js';
import { FrameDriver, SESSION, WRITER, filler, observation, ordOf, type BubbleSpec } from './keyed-chat-fixtures.js';

/**
 * Bounded first view for a long transcript (2026-11-01): a coordinator with
 * ~2,000 bubbles served over a slow relay must not need its whole history in the
 * first tail SNAP. The SNAP is `latestPerKey(W) ∪ rowsAfter(W)` (transcript-tail-
 * snapshot.ts); the digest-preserving way to bound it is to bound the live set
 * (`CHAT_LIVE_BYTES_MAX`), with older bubbles tombstoned and served through
 * history pagination (`coverage.omittedBefore`).
 */

const BUBBLES = 2000;
/** Realistic mix: short user turns, mid-size answers, big tool output. */
function bubble(i: number): BubbleSpec {
    const m = i % 5;
    if (m === 0) return { id: `d.long.${i + 1}`, ord: ordOf(i), role: 'user', text: filler(i, 240) };
    if (m === 1 || m === 2) return { id: `d.long.${i + 1}`, ord: ordOf(i), kind: 'tool', role: 'assistant', text: filler(i, 3200) };
    return { id: `d.long.${i + 1}`, ord: ordOf(i), role: 'assistant', text: filler(i, 1400) };
}

/** What the daemon's tail selector would hand a new subscriber, after compaction. */
function tailSnapshot(allRows: Array<{ key: string; row: KeyedChatRow }>): KeyedChatRow[] {
    const newest = new Map<string, { idx: number; row: KeyedChatRow }>();
    allRows.forEach((r, idx) => newest.set(r.key, { idx, row: r.row }));
    return [...newest.values()]
        .filter((e) => e.row.kind !== CHAT_DEL_KIND) // pruneSuperseded (b): a lone tombstone is compacted away
        .sort((a, b) => a.idx - b.idx)
        .map((e) => e.row);
}

/** JSON+base64 wire size of a SNAP: SUB rows carry the payload as a JSON string. */
function wireBytes(rows: KeyedChatRow[]): number {
    const json = JSON.stringify(rows.map((r) => ({ ...r, payload: JSON.stringify(r.payload) })));
    return Math.ceil((Buffer.byteLength(json) * 4) / 3);
}

describe('long-transcript first view is bounded (2,000 bubbles)', () => {
    const driver = new FrameDriver();
    const rows: Array<{ key: string; row: KeyedChatRow }> = [];
    const all = Array.from({ length: BUBBLES }, (_, i) => bubble(i));
    // grow in 20 batches, as a live coordinator would
    for (let n = 100; n <= BUBBLES; n += 100) {
        const frame = driver.step(observation(all.slice(0, n)));
        if (!frame) continue;
        const delivered = driver.rowsOf(frame);
        frame.rows.forEach((fr, k) => rows.push({ key: fr.key, row: delivered[k] }));
    }
    const snap = tailSnapshot(rows);

    it('the SNAP payload stays within a fixed bound regardless of transcript length', () => {
        const totalBodyBytes = all.reduce((n, b) => n + b.text.length, 0);
        expect(totalBodyBytes).toBeGreaterThan(3 * 1024 * 1024); // the full transcript is far larger than the SNAP
        // bound: live cap + head/meta/commit framing, ×4/3 base64, ×~1.1 JSON escaping of payload strings
        const bound = Math.ceil(CHAT_LIVE_BYTES_MAX * 1.5);
        expect(wireBytes(snap)).toBeLessThanOrEqual(bound);
        expect(wireBytes(snap)).toBeLessThanOrEqual(800 * 1024);
    });

    it('the reader verifies the windowed SNAP (digest ok) and its first view shows the newest bubbles', () => {
        const folder = new KeyedTranscriptFolder({ expectedSessionId: SESSION });
        const delta = folder.ingestSnapshot(snap);
        expect(delta).not.toBeNull();
        expect(folder.needsResync).toBeNull();
        expect(folder.stats().rejectedRows).toBe(0);
        const view = folder.view()!;
        expect(view.messages.at(-1)!.messageId).toBe(`d.long.${BUBBLES}`);
        expect(view.messages.length).toBeGreaterThan(50);
        expect(view.messages.length).toBeLessThan(BUBBLES);
        // contiguous newest window
        const ids = view.messages.map((m) => m.messageId);
        const firstIdx = BUBBLES - ids.length + 1;
        expect(ids).toEqual(ids.map((_, k) => `d.long.${firstIdx + k}`));
        expect(snap.at(-1)!.kind).toBe(CHAT_COMMIT_KIND);
    });

    it('older bubbles are advertised for history pagination (omittedBefore) and a later DELTA still folds', () => {
        const folder = new KeyedTranscriptFolder({ expectedSessionId: SESSION });
        folder.ingestSnapshot(snap);
        expect(folder.view()!.coverage.omittedBefore).toBe(true);
        // stream one more bubble: the reader that started from the windowed SNAP stays consistent
        const next = driver.step(observation([...all, { id: `d.long.${BUBBLES + 1}`, ord: ordOf(BUBBLES), text: 'newest' }]))!;
        const deltas = folder.ingestRows(driver.rowsOf(next));
        expect(deltas).toHaveLength(1);
        expect(folder.needsResync).toBeNull();
        expect(folder.view()!.messages.at(-1)!.messageId).toBe(`d.long.${BUBBLES + 1}`);
    });
});
