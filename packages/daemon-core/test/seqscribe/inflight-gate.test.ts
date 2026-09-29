import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the mesh publisher's awaited in-flight slots (C7-1). The
 * load-shed gate this file also covered was deleted with the fleet.status
 * shadow ring (data-path audit 2026-09-29 P0-4).
 */

describe('createAwaitedSlots (C7-1 backpressure)', () => {
    it('grants up to max, queues the rest FIFO, and never refuses', async () => {
        const { createAwaitedSlots } = await import('../../src/seqscribe/inflight-gate.js');
        const slots = createAwaitedSlots(2);
        const order: number[] = [];
        const releases = await Promise.all([slots.acquire(), slots.acquire()]);
        const waiting = [3, 4, 5].map((n) => slots.acquire().then((release) => { order.push(n); return release; }));
        expect(slots.inflight()).toBe(2);
        expect(slots.waiting()).toBe(3);
        releases[0]!();
        const r3 = await waiting[0]!;
        releases[1]!();
        const r4 = await waiting[1]!;
        r3();
        const r5 = await waiting[2]!;
        expect(order).toEqual([3, 4, 5]);
        r4(); r5();
        expect(slots.inflight()).toBe(0);
    });

    it('a double release frees one slot only', async () => {
        const { createAwaitedSlots } = await import('../../src/seqscribe/inflight-gate.js');
        const slots = createAwaitedSlots(1);
        const release = await slots.acquire();
        release();
        release();
        expect(slots.inflight()).toBe(0);
        await slots.acquire();
        expect(slots.inflight()).toBe(1);
    });
});
