import { describe, expect, it } from 'vitest';
import { CHAT_PART_MAX_JCS_BYTES, chatJcsTextBytes, splitChatBody } from '../../src/seqscribe/transcript-keyed-codec.js';
import { FrameDriver, observation, ordOf, type BubbleSpec } from './keyed-chat-fixtures.js';

/**
 * ★ Gate (b) of design 2026-09-28 §8.2 — the size-invariance test.
 *
 * The v1 lane re-wrote the WHOLE transcript per change: bytes per tick grew
 * linearly with the transcript (55 KB typical, ~11 MB for the largest session,
 * 2.3 GB in 27.7 h for one session). The keyed lane writes only what changed,
 * so a streaming tick must cost the same whether the transcript holds 10
 * bubbles or 2,000.
 *
 * Both sessions receive the IDENTICAL 500-tick streaming sequence on their
 * last bubble (it grows past 24 KiB, so the part path is exercised too). The
 * p95 of bytes written per tick must agree within ±10%, and every tick may
 * write at most (keys it changed) + 2 rows (meta, commit). Any regression that
 * rewrites unchanged bubbles makes the 2,000-bubble side hundreds of times
 * larger and fails immediately.
 */

const TICKS = 500;
const CHUNK = 97; // chars appended per tick → the stream crosses the 24 KiB part boundary

function streamText(tick: number): string {
    let s = '';
    for (let i = 0; i <= tick; i += 1) s += `tick ${i.toString().padStart(4, '0')} ${'•'.repeat(CHUNK - 10)}`;
    return s;
}

function history(n: number): BubbleSpec[] {
    return Array.from({ length: n - 1 }, (_, i) => ({
        id: `d.hist.${i + 1}`,
        ord: ordOf(i),
        text: `history bubble ${i} — ${'lorem ipsum '.repeat(8)}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
    }));
}

function p95(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function partsOf(text: string): string[] {
    return chatJcsTextBytes(text) <= CHAT_PART_MAX_JCS_BYTES ? [] : splitChatBody(text);
}

function run(bubbleCount: number): { bytes: number[]; rows: number[]; changedKeys: number[] } {
    const driver = new FrameDriver();
    const base = history(bubbleCount);
    const streaming = (tick: number): BubbleSpec => ({
        id: 'd.stream.1',
        ord: ordOf(bubbleCount + 1),
        text: streamText(tick),
        bubbleState: 'streaming',
        streaming: true,
    });
    driver.step(observation([...base, streaming(0)], { status: 'generating' }));
    const bytes: number[] = [];
    const rows: number[] = [];
    const changedKeys: number[] = [];
    for (let tick = 1; tick <= TICKS; tick += 1) {
        const frame = driver.step(observation([...base, streaming(tick)], { status: 'generating' }));
        if (!frame) throw new Error(`tick ${tick} wrote nothing although the stream grew`);
        bytes.push(frame.bytes);
        rows.push(frame.rows.length);
        // Keys this tick changed, derived from the INPUT (not from the frame):
        // the streaming head, plus each part whose text changed or appeared.
        const before = partsOf(streamText(tick - 1));
        const after = partsOf(streamText(tick));
        let parts = 0;
        for (let k = 0; k < after.length; k += 1) if (before[k] !== after[k]) parts += 1;
        parts += Math.max(0, before.length - after.length);
        changedKeys.push(1 + parts);
    }
    return { bytes, rows, changedKeys };
}

describe('keyed chat — bytes per streaming tick are independent of transcript size (§8.2b)', () => {
    it('10 vs 2,000 bubbles: p95 bytes/tick within ±10%, rows/tick ≤ changed keys + 2', () => {
        const small = run(10);
        const large = run(2_000);

        const smallP95 = p95(small.bytes);
        const largeP95 = p95(large.bytes);
        console.log(`[size-invariance] p95 bytes/tick: 10 bubbles=${smallP95}, 2000 bubbles=${largeP95}, ratio=${(largeP95 / smallP95).toFixed(3)}`);
        expect(largeP95 / smallP95).toBeGreaterThanOrEqual(0.9);
        expect(largeP95 / smallP95).toBeLessThanOrEqual(1.1);

        for (const side of [small, large]) {
            side.rows.forEach((count, i) => expect(count).toBeLessThanOrEqual(side.changedKeys[i] + 2));
        }
        // Constant cost, not merely "similar": a tick never exceeds one part + head + commit (§7.1).
        expect(Math.max(...large.bytes)).toBeLessThan(2 * CHAT_PART_MAX_JCS_BYTES + 4096);
    }, 120_000);
});
