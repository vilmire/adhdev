import { describe, expect, it } from 'vitest';
import {
    CHAT_COMMIT_KIND,
    CHAT_DEL_KIND,
    CHAT_LIVE_BYTES_MAX,
    CHAT_META_KIND,
    CHAT_MSG_KIND,
    CHAT_PART_KIND,
    CHAT_PART_MAX_JCS_BYTES,
    chatMessageKey,
    computeChatCommitDigest,
    type ChatCommitV2,
    type ChatMsgV2,
} from '../../src/seqscribe/transcript-keyed-codec.js';
import { KeyedChatSessionState, type PersistedChatRow } from '../../src/seqscribe/transcript-keyed-frame.js';
import { KeyedTranscriptFolder } from '../../src/seqscribe/transcript-keyed-folder.js';
import { FrameDriver, SESSION, WRITER, filler, observation, ordOf, type BubbleSpec } from './keyed-chat-fixtures.js';

/**
 * Producer frames (design 2026-09-28 §4.3–§4.10): only changed bubbles are
 * written, parts are rewritten only where they changed, deletions tombstone,
 * window sources retain, the 16 MiB cap trims the oldest, and a restart
 * resumes from what the topic holds.
 */

function kinds(frame: { rows: readonly { kind: string }[] }): string[] {
    return frame.rows.map((r) => r.kind);
}

function bubbles(n: number, textOf: (i: number) => string = (i) => `bubble ${i}`): BubbleSpec[] {
    return Array.from({ length: n }, (_, i) => ({ id: `d.abc123.${i + 1}`, ord: ordOf(i), text: textOf(i) }));
}

describe('KeyedChatSessionState — changed bubbles only', () => {
    it('first frame writes every bubble + meta + commit; re-observing the same source writes ZERO rows (§8.1-2)', () => {
        const driver = new FrameDriver();
        const first = driver.step(observation(bubbles(3)))!;
        expect(kinds(first)).toEqual([CHAT_MSG_KIND, CHAT_MSG_KIND, CHAT_MSG_KIND, CHAT_META_KIND, CHAT_COMMIT_KIND]);
        expect(first.commit.liveCount).toBe(3);
        expect(first.commit.basis).toBe('delta');
        for (let i = 0; i < 5; i++) expect(driver.step(observation(bubbles(3)))).toBeNull();
    });

    it('a streaming tail writes one head + commit, never the other bubbles', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(50)));
        const specs = bubbles(50);
        specs[49] = { ...specs[49], text: `${specs[49].text} and more`, bubbleState: 'streaming', streaming: true };
        const frame = driver.step(observation(specs))!;
        expect(kinds(frame)).toEqual([CHAT_MSG_KIND, CHAT_COMMIT_KIND]);
        expect((frame.rows[0].payload as unknown as ChatMsgV2).rev).toBe(2);
        expect(frame.rewrittenBubbles).toBe(1);
    });

    it('meta is written only when it changed', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(2)));
        const frame = driver.step(observation(bubbles(2), { status: 'generating' }))!;
        expect(kinds(frame)).toEqual([CHAT_META_KIND, CHAT_COMMIT_KIND]);
    });

    it('a removed bubble is tombstoned; the commit digest covers exactly the live (id, rev) set', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(3)));
        const frame = driver.step(observation(bubbles(3).filter((_, i) => i !== 1)))!;
        expect(kinds(frame)).toEqual([CHAT_DEL_KIND, CHAT_COMMIT_KIND]);
        const commit = frame.commit as ChatCommitV2;
        expect(commit.liveCount).toBe(2);
        expect(commit.digest).toBe(computeChatCommitDigest([['d.abc123.1', 1], ['d.abc123.3', 1]], commit.metaRev));
    });

    it('window coverage retains ids the ledger kept (scrolled out) instead of tombstoning them (§3.5)', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(5)));
        const visible = bubbles(5).slice(2);
        const frame = driver.step(
            observation(visible, { coverage: { mode: 'window', omittedBefore: true, retainedMessageIds: ['d.abc123.1', 'd.abc123.2'] } }),
        )!;
        // meta changes (coverage), nothing is deleted
        expect(kinds(frame)).toEqual([CHAT_META_KIND, CHAT_COMMIT_KIND]);
        expect(frame.commit.liveCount).toBe(5);
    });

    it('refuses an observation whose bubbles carry no identity (the ledger failed) rather than inventing ids', () => {
        const state = new KeyedChatSessionState(SESSION, 'e');
        const obs = observation(bubbles(1));
        const built = state.build({ ...obs, messages: [{ ...obs.messages[0], messageId: undefined }] }, {
            writerId: WRITER, producerDaemonId: 'd', observedAt: 'now', nowMs: 0,
        });
        expect(built.status).toBe('unidentified');
    });
});

describe('KeyedChatSessionState — large bubbles (§4.6)', () => {
    it('a body over 24 KiB is parted; streaming appends rewrite only the last part', () => {
        const driver = new FrameDriver();
        const base = filler(1, CHAT_PART_MAX_JCS_BYTES * 3 + 100);
        const first = driver.step(observation([{ id: 'd.x.1', ord: 'a0', text: base }]))!;
        expect(kinds(first).filter((k) => k === CHAT_PART_KIND)).toHaveLength(4);
        const grown = driver.step(observation([{ id: 'd.x.1', ord: 'a0', text: `${base}tail` }]))!;
        expect(kinds(grown)).toEqual([CHAT_PART_KIND, CHAT_MSG_KIND, CHAT_COMMIT_KIND]);
        expect((grown.rows[0].payload as { k: number }).k).toBe(3);
        const head = grown.rows[1].payload as unknown as ChatMsgV2;
        expect('parts' in head.body && head.body.partRevs).toEqual([1, 1, 1, 2]);
    });

    it('a bubble that shrinks back inline tombstones its old parts', () => {
        const driver = new FrameDriver();
        driver.step(observation([{ id: 'd.x.1', ord: 'a0', text: filler(2, CHAT_PART_MAX_JCS_BYTES * 2) }]));
        const frame = driver.step(observation([{ id: 'd.x.1', ord: 'a0', text: 'short now' }]))!;
        expect(kinds(frame)).toEqual([CHAT_DEL_KIND, CHAT_DEL_KIND, CHAT_MSG_KIND, CHAT_COMMIT_KIND]);
    });
});

describe('KeyedChatSessionState — live cap (§11 Q1)', () => {
    it('beyond 16 MiB the oldest bubbles are tombstoned and coverage.omittedBefore turns true', () => {
        const driver = new FrameDriver();
        const big = Math.floor(CHAT_LIVE_BYTES_MAX / 3) - 1024; // three fit (with head overhead), four do not
        const specs = [0, 1, 2, 3].map((i) => ({ id: `d.c.${i + 1}`, ord: ordOf(i), text: filler(i, big) }));
        const frame = driver.step(observation(specs))!;
        expect(frame.capped).toBe(true);
        expect(frame.commit.liveCount).toBe(3);
        expect(frame.rows.some((r) => r.kind === CHAT_MSG_KIND && r.key === chatMessageKey('d.c.1'))).toBe(false);
        const meta = frame.rows.find((r) => r.kind === CHAT_META_KIND)!.payload as { coverage: { omittedBefore: boolean } };
        expect(meta.coverage.omittedBefore).toBe(true);
        expect(driver.state.liveBytes()).toBeLessThanOrEqual(CHAT_LIVE_BYTES_MAX);
    }, 30_000);
});

describe('KeyedChatSessionState — base frames and tripwire (I5, §8.2c)', () => {
    it('a delta frame that rewrites most live bubbles trips the tripwire', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(20)));
        const frame = driver.step(observation(bubbles(20, (i) => `rewrapped ${i}`)))!;
        expect(frame.commit.basis).toBe('delta');
        expect(frame.tripwire).toBe(true);
    });

    it('a requested base frame rewrites every live bubble, is labelled, and is not a tripwire', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(20)));
        driver.state.requestBase('resync_request');
        const frame = driver.step(observation(bubbles(20)))!;
        expect(frame.commit).toMatchObject({ basis: 'base', baseReason: 'resync_request' });
        expect(frame.rewrittenBubbles).toBe(20);
        expect(frame.tripwire).toBe(false);
        // a second base within 10 minutes is flagged
        driver.state.requestBase('resync_request');
        expect(driver.step(observation(bubbles(20)))!.baseRateExceeded).toBe(true);
    });

    it('a history-session switch is labelled lineage_switch', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(3)));
        const frame = driver.step(observation(bubbles(3), { historySessionId: 'hist-2' }))!;
        expect(frame.commit).toMatchObject({ basis: 'base', baseReason: 'lineage_switch' });
    });
});

describe('KeyedChatSessionState — restart (§4.10)', () => {
    function persisted(driver: FrameDriver, tornFrame?: ReturnType<FrameDriver['step']>) {
        // Newest row per key across all committed frames = what latestPerKey(W) returns.
        const latest = new Map<string, PersistedChatRow>();
        for (const frame of driver.frames) {
            if (frame === tornFrame) continue;
            for (const row of frame.rows) latest.set(row.key, { key: row.key, kind: row.kind, writer: driver.writer, payload: JSON.parse(JSON.stringify(row.payload)) });
        }
        const torn = tornFrame
            ? tornFrame.rows
                  .filter((r) => r.kind !== CHAT_COMMIT_KIND)
                  .map((r) => ({ key: r.key, kind: r.kind, writer: driver.writer, payload: JSON.parse(JSON.stringify(r.payload)) }))
            : [];
        return { committed: [...latest.values()], torn };
    }

    it('a restored state re-observing the unchanged source writes zero rows, and revs continue', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(4)));
        const specs = bubbles(4);
        specs[3] = { ...specs[3], text: 'edited' };
        driver.step(observation(specs));

        const restored = new FrameDriver(WRITER, 'epoch-b');
        restored.state.restore(persisted(driver), WRITER);
        expect(restored.step(observation(specs))).toBeNull();
        specs[3] = { ...specs[3], text: 'edited again' };
        const frame = restored.step(observation(specs))!;
        expect((frame.rows[0].payload as unknown as ChatMsgV2).rev).toBe(3);
        expect(frame.commit.epoch).toBe('epoch-b');
    });

    it('a frame whose commit never landed is rewritten or tombstoned by the first frame, rev above the torn row', () => {
        const driver = new FrameDriver();
        driver.step(observation(bubbles(3)));
        const specs = [...bubbles(3), { id: 'd.abc123.9', ord: ordOf(9), text: 'torn new bubble' }];
        specs[0] = { ...specs[0], text: 'torn edit' };
        const torn = driver.step(observation(specs))!; // pretend its commit never landed

        const restored = new FrameDriver(WRITER, 'epoch-b');
        restored.state.restore(persisted(driver, torn), WRITER);
        // the source reverted: bubble 1 back to its committed text, bubble 9 gone
        const frame = restored.step(observation(bubbles(3)))!;
        const byKey = new Map(frame.rows.map((r) => [r.key, r]));
        expect(byKey.get('m:d.abc123.1')?.kind).toBe(CHAT_MSG_KIND);
        expect((byKey.get('m:d.abc123.1')!.payload as unknown as ChatMsgV2).rev).toBe(3);
        expect(byKey.get('m:d.abc123.9')?.kind).toBe(CHAT_DEL_KIND);
        expect(frame.commit.liveCount).toBe(3);
    });

    it('re-restoring within the SAME producer epoch keeps numbering frames forward (no reused frame number)', () => {
        const driver = new FrameDriver(WRITER, 'epoch-a');
        driver.step(observation(bubbles(2)));
        driver.step(observation(bubbles(2, (i) => `x${i}`)));
        const again = new FrameDriver(WRITER, 'epoch-a');
        again.state.restore(persisted(driver), WRITER);
        const frame = again.step(observation(bubbles(3, (i) => `x${i}`)))!;
        expect(frame.frame).toBe(3);
    });

    it('rows committed by another writer make the first frame a writer_change base frame', () => {
        const driver = new FrameDriver('adhdev-writer-old');
        driver.step(observation(bubbles(3)));
        const restored = new FrameDriver(WRITER, 'epoch-b');
        restored.state.restore(persisted(driver), WRITER);
        const frame = restored.step(observation(bubbles(3)))!;
        expect(frame.commit).toMatchObject({ basis: 'base', baseReason: 'writer_change', writer: WRITER });
        expect(frame.rewrittenBubbles).toBe(3);
    });
});

describe('frames fold back into the same view (producer ↔ KeyedTranscriptFolder)', () => {
    it('every frame of a stream verifies and the folded view equals the last observation', () => {
        const driver = new FrameDriver();
        const folder = new KeyedTranscriptFolder({ expectedSessionId: SESSION });
        let specs = bubbles(6);
        const steps: BubbleSpec[][] = [];
        steps.push(specs);
        specs = [...specs, { id: 'd.abc123.7', ord: ordOf(7), text: filler(7, CHAT_PART_MAX_JCS_BYTES * 2 + 5) }];
        steps.push(specs);
        specs = specs.map((s, i) => (i === 6 ? { ...s, text: `${s.text}!!` } : s));
        steps.push(specs);
        specs = specs.filter((_, i) => i !== 2);
        steps.push(specs);
        specs = specs.map((s, i) => (i === 6 - 1 ? { ...s, text: 'short again' } : s));
        steps.push(specs);
        for (const step of steps) {
            const frame = driver.step(observation(step));
            if (!frame) continue;
            const deltas = folder.ingestRows(driver.rowsOf(frame));
            expect(deltas).toHaveLength(1);
            expect(folder.needsResync).toBeNull();
        }
        const view = folder.view()!;
        expect(view.messages.map((m) => [m.messageId, m.content])).toEqual(specs.map((s) => [s.id, s.text]));
        expect(folder.stats().rejectedRows).toBe(0);
    });
});
