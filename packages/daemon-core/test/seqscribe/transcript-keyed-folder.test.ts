import { describe, expect, it } from 'vitest';
import { CHAT_COMMIT_KIND, CHAT_PART_MAX_JCS_BYTES, CHAT_PART_KIND } from '../../src/seqscribe/transcript-keyed-codec.js';
import { KeyedTranscriptFolder, parseChatSubRow, type KeyedChatRow, type KeyedTranscriptFrameDelta } from '../../src/seqscribe/transcript-keyed-folder.js';
import { DAEMON, FrameDriver, SESSION, filler, observation, ordOf, type BubbleSpec } from './keyed-chat-fixtures.js';

/**
 * `KeyedTranscriptFolder` (design 2026-09-28 §4.5, §4.9): a reader never
 * shows a state no commit described.
 */

function specs(n: number, suffix = ''): BubbleSpec[] {
    return Array.from({ length: n }, (_, i) => ({ id: `d.f.${i + 1}`, ord: ordOf(i), text: `m${i}${suffix}` }));
}

function textsOf(folder: KeyedTranscriptFolder): string[] {
    return folder.view()?.messages.map((m) => m.content) ?? [];
}

/** Newest-per-key rows of all frames so far, in append order (what latestPerKey(W) serves). */
function snapshotRows(rowsSoFar: KeyedChatRow[], keysOf: Map<KeyedChatRow, string>): KeyedChatRow[] {
    const latest = new Map<string, KeyedChatRow>();
    for (const row of rowsSoFar) {
        const key = keysOf.get(row)!;
        latest.delete(key);
        latest.set(key, row);
    }
    return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

describe('KeyedTranscriptFolder — frame atomicity (I4)', () => {
    it('rows of a frame are invisible until its commit, then applied at once with a delta', () => {
        const driver = new FrameDriver();
        const deltas: KeyedTranscriptFrameDelta[] = [];
        const folder = new KeyedTranscriptFolder({ expectedSessionId: SESSION, onFrame: (d) => deltas.push(d) });
        folder.ingestRows(driver.rowsOf(driver.step(observation(specs(3)))!));
        expect(deltas[0]).toMatchObject({ reset: true, deletes: [] });
        expect(textsOf(folder)).toEqual(['m0', 'm1', 'm2']);

        const rows = driver.rowsOf(driver.step(observation(specs(3, '!')))!);
        folder.ingestRows(rows.slice(0, -1));
        expect(textsOf(folder)).toEqual(['m0', 'm1', 'm2']); // pending, not shown
        folder.ingestRows(rows.slice(-1));
        expect(textsOf(folder)).toEqual(['m0!', 'm1!', 'm2!']);
        expect(deltas[1]!.reset).toBe(false);
        expect(deltas[1]!.upserts.map((m) => m.messageId)).toEqual(['d.f.1', 'd.f.2', 'd.f.3']);
        expect(deltas[1]!.meta).toBeNull(); // meta unchanged → not re-sent
    });

    it('a torn frame (no commit) is discarded when the next epoch commits', () => {
        const driver = new FrameDriver();
        const folder = new KeyedTranscriptFolder();
        folder.ingestRows(driver.rowsOf(driver.step(observation(specs(2)))!));
        const torn = driver.rowsOf(driver.step(observation(specs(2, ' torn')))!).slice(0, -1);
        folder.ingestRows(torn);
        // A restarted producer (new epoch) re-writes from the committed state.
        const restarted = new FrameDriver(driver.writer, 'epoch-b');
        const persisted = { committed: [] as never[], torn: [] as never[] };
        restarted.state.restore(persisted, driver.writer);
        const frame = restarted.step(observation(specs(2, ' after')))!;
        const rows = restarted.rowsOf(frame).map((r, i) => ({ ...r, seq: 1000 + i }));
        folder.ingestRows(rows);
        expect(textsOf(folder)).toEqual(['m0 after', 'm1 after']);
        expect(folder.stats().tornFramesDropped).toBeGreaterThanOrEqual(1);
    });

    it('a digest mismatch keeps the previous committed view and flags a resync', () => {
        const driver = new FrameDriver();
        const folder = new KeyedTranscriptFolder();
        folder.ingestRows(driver.rowsOf(driver.step(observation(specs(2)))!));
        const rows = driver.rowsOf(driver.step(observation(specs(2, '?')))!);
        const commit = rows.at(-1)!;
        (commit.payload as { digest: string }).digest = 'f'.repeat(64);
        folder.ingestRows(rows);
        expect(textsOf(folder)).toEqual(['m0', 'm1']);
        expect(folder.needsResync).toBe('digest_mismatch');
        expect(folder.stats().digestMismatches).toBe(1);
    });

    it('a parted bubble whose parts did not all arrive is refused (incomplete_bubble)', () => {
        const driver = new FrameDriver();
        const folder = new KeyedTranscriptFolder();
        const rows = driver.rowsOf(driver.step(observation([{ id: 'd.big.1', ord: 'a0', text: filler(3, CHAT_PART_MAX_JCS_BYTES * 2 + 1) }]))!);
        folder.ingestRows(rows.filter((r, i) => !(r.kind === CHAT_PART_KIND && i === 1)));
        expect(folder.view()).toBeNull();
        expect(folder.needsResync).toBe('incomplete_bubble');
    });

    it('rejects commits of another session or another owner', () => {
        const driver = new FrameDriver();
        const rows = driver.rowsOf(driver.step(observation(specs(1)))!);
        const wrongSession = new KeyedTranscriptFolder({ expectedSessionId: 'other' });
        wrongSession.ingestRows(rows);
        expect(wrongSession.view()).toBeNull();
        const wrongOwner = new KeyedTranscriptFolder({ expectedOwnerDaemonId: 'daemon_mach_elsewhere' });
        wrongOwner.ingestRows(rows);
        expect(wrongOwner.view()).toBeNull();
        const rightOwner = new KeyedTranscriptFolder({ expectedOwnerDaemonId: DAEMON.replace('daemon_', '') });
        rightOwner.ingestRows(rows);
        expect(rightOwner.view()).not.toBeNull();
    });

    it("a new writer's base frame replaces the previous writer's state wholesale (§4.11)", () => {
        const oldWriter = new FrameDriver('adhdev-writer-old');
        const folder = new KeyedTranscriptFolder();
        folder.ingestRows(oldWriter.rowsOf(oldWriter.step(observation(specs(3)))!));
        const persisted = {
            committed: oldWriter.frames[0]!.rows.map((r) => ({ key: r.key, kind: r.kind, writer: 'adhdev-writer-old', payload: JSON.parse(JSON.stringify(r.payload)) })),
            torn: [],
        };
        const newWriter = new FrameDriver('adhdev-writer-new', 'epoch-n');
        newWriter.state.restore(persisted, 'adhdev-writer-new');
        const frame = newWriter.step(observation(specs(2)))!;
        expect(frame.commit.baseReason).toBe('writer_change');
        folder.ingestRows(newWriter.rowsOf(frame).map((r, i) => ({ ...r, seq: 500 + i })));
        expect(textsOf(folder)).toEqual(['m0', 'm1']);
        expect(folder.lastCommit()!.writer).toBe('adhdev-writer-new');
    });
});

describe('KeyedTranscriptFolder — SNAP (§4.9)', () => {
    it('a newest-per-key SNAP (tombstones included) folds to the committed state; rows after the last commit stay pending', () => {
        const driver = new FrameDriver();
        const all: KeyedChatRow[] = [];
        const keys = new Map<KeyedChatRow, string>();
        const take = (frame: NonNullable<ReturnType<FrameDriver['step']>>) => {
            const rows = driver.rowsOf(frame);
            rows.forEach((row, i) => keys.set(row, frame.rows[i]!.key));
            all.push(...rows);
            return rows;
        };
        take(driver.step(observation(specs(4)))!);
        take(driver.step(observation(specs(4).filter((_, i) => i !== 1)))!); // d.f.2 tombstoned
        take(driver.step(observation([...specs(4).filter((_, i) => i !== 1), { id: 'd.f.9', ord: ordOf(9), text: 'late' }]))!);
        const inFlightAll = take(driver.step(observation([{ id: 'd.f.1', ord: ordOf(0), text: 'in flight' }]))!);
        const inFlight = inFlightAll.slice(0, -1); // its commit has not landed yet

        const committedRows = snapshotRows(all.filter((r) => !inFlightAll.includes(r)), keys);
        const folder = new KeyedTranscriptFolder({ expectedSessionId: SESSION });
        const delta = folder.ingestSnapshot([...committedRows, ...inFlight]);
        expect(delta?.reset).toBe(true);
        expect(folder.view()!.messages.map((m) => m.messageId)).toEqual(['d.f.1', 'd.f.3', 'd.f.4', 'd.f.9']);
        // The in-flight frame applies when its commit arrives over DELTA.
        const commitRow = inFlightAll.at(-1)!;
        expect(commitRow.kind).toBe(CHAT_COMMIT_KIND);
        folder.ingestRows([commitRow]);
        expect(textsOf(folder)).toEqual(['in flight']);
    });

    it('an empty SNAP (nothing published, or all pruned) is no view; a commit-less one keeps the previous view', () => {
        const driver = new FrameDriver();
        const folder = new KeyedTranscriptFolder();
        folder.ingestRows(driver.rowsOf(driver.step(observation(specs(1)))!));
        const pendingOnly = driver.rowsOf(driver.step(observation(specs(1, 'x')))!).slice(0, -1);
        folder.ingestSnapshot(pendingOnly);
        expect(textsOf(folder)).toEqual(['m0']);
        folder.ingestSnapshot([]);
        expect(folder.view()).toBeNull();
    });

    it('parseChatSubRow reads a SUB Row (payload as JSON string), rejecting malformed ones', () => {
        expect(parseChatSubRow({ key: 'w:1', writer: 'w', seq: 1, kind: 'k', payload: '{"a":1}' })).toEqual({ writer: 'w', seq: 1, kind: 'k', payload: { a: 1 } });
        expect(parseChatSubRow({ key: 'w:1', writer: 'w', seq: 1, kind: 'k', payload: '{' })).toBeNull();
        expect(parseChatSubRow({ key: 'w:1', writer: 'w', seq: -1, kind: 'k', payload: '{}' })).toBeNull();
    });
});
