import { describe, expect, it } from 'vitest';
import { createInflightGate } from '../../src/seqscribe/inflight-gate.js';

/**
 * Unit tests for the shared in-flight gate.
 *
 * The two shadow legs test it through their own public surface
 * (`mesh-dual-write-inflight.test.ts`, `fleet-status-shadow-inflight.test.ts`);
 * these pin the gate's own contract directly, including the cases the legs
 * cannot reach cheaply — most importantly that the load-shed still engages
 * exactly at the cap after a reconfigure, which is the property both defects
 * ultimately destroyed.
 */

const noop = (): void => {};

describe('createInflightGate', () => {
    it('admits up to the cap and sheds beyond it', () => {
        const gate = createInflightGate(3);
        const pending = () => new Promise<void>(() => {});

        for (let i = 0; i < 3; i++) {
            expect(gate.run(pending, noop, noop)).toEqual({ admitted: true });
        }
        expect(gate.count()).toBe(3);

        const shed = gate.run(pending, noop, noop);
        expect(shed).toEqual({ admitted: false, reason: 'shed' });
        // A shed attempt must not call `start` — nothing was handed to the topic.
        expect(gate.count()).toBe(3);
    });

    it('consumes no slot when start throws synchronously', () => {
        const gate = createInflightGate(2);
        const boom = new Error('static API misuse');

        const attempt = gate.run(
            () => {
                throw boom;
            },
            noop,
            noop,
        );

        expect(attempt).toEqual({ admitted: false, reason: 'threw', error: boom });
        expect(gate.count()).toBe(0);
    });

    it('never wedges: repeated synchronous throws leave the gate fully open', () => {
        const gate = createInflightGate(4);
        for (let i = 0; i < 100; i++) {
            gate.run(
                () => {
                    throw new Error('misuse');
                },
                noop,
                noop,
            );
        }
        expect(gate.count()).toBe(0);
        expect(gate.run(() => Promise.resolve(), noop, noop)).toEqual({ admitted: true });
    });

    it('releases the slot on resolve and on reject', async () => {
        const gate = createInflightGate(4);
        let settled = 0;
        let rejected = 0;

        gate.run(
            () => Promise.resolve('ok'),
            () => {
                settled++;
            },
            noop,
        );
        gate.run(
            () => Promise.reject(new Error('nope')),
            noop,
            () => {
                rejected++;
            },
        );
        expect(gate.count()).toBe(2);

        await new Promise((resolve) => setImmediate(resolve));

        expect(settled).toBe(1);
        expect(rejected).toBe(1);
        expect(gate.count()).toBe(0);
    });

    it('does not go negative when appends settle after a reconfigure', async () => {
        const gate = createInflightGate(8);
        const resolvers: Array<() => void> = [];
        const held = () => new Promise<void>((resolve) => resolvers.push(() => resolve()));

        for (let i = 0; i < 5; i++) gate.run(held, noop, noop);
        expect(gate.count()).toBe(5);

        gate.reconfigure();
        expect(gate.count()).toBe(0);

        for (const r of resolvers.splice(0)) r();
        await new Promise((resolve) => setImmediate(resolve));

        // The retired generation's settles are accounted against the generation
        // that admitted them — the live count is untouched, not negative.
        expect(gate.count()).toBe(0);
    });

    it('still sheds exactly at the cap after a reconfigure', async () => {
        const gate = createInflightGate(3);
        const resolvers: Array<() => void> = [];
        const held = () => new Promise<void>((resolve) => resolvers.push(() => resolve()));

        for (let i = 0; i < 3; i++) gate.run(held, noop, noop);
        gate.reconfigure();
        for (const r of resolvers.splice(0)) r();
        await new Promise((resolve) => setImmediate(resolve));

        // With a negative baseline the gate would admit 3 + the deficit here.
        for (let i = 0; i < 3; i++) {
            expect(gate.run(held, noop, noop)).toEqual({ admitted: true });
        }
        expect(gate.run(held, noop, noop)).toEqual({ admitted: false, reason: 'shed' });
        expect(gate.count()).toBe(3);
    });

    it('counts each generation independently across repeated reconfigures', async () => {
        const gate = createInflightGate(4);
        const resolvers: Array<() => void> = [];
        const held = () => new Promise<void>((resolve) => resolvers.push(() => resolve()));

        gate.run(held, noop, noop);
        gate.reconfigure();
        gate.run(held, noop, noop);
        gate.reconfigure();
        gate.run(held, noop, noop);
        expect(gate.count()).toBe(1);

        for (const r of resolvers.splice(0)) r();
        await new Promise((resolve) => setImmediate(resolve));

        // Only the newest append belonged to the live generation.
        expect(gate.count()).toBe(0);
    });
});
