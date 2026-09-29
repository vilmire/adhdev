/**
 * Awaited, bounded in-flight accounting for the mesh publisher's asynchronous
 * seqscribe appends (wiring-unification C7-1: publish WAITS, never drops).
 *
 * (The fire-and-forget load-shed gate that used to live here served only the
 * `fleet.status` shadow ring; both were deleted — data-path audit 2026-09-29
 * P0-4.)
 */

/**
 * Awaited, bounded concurrency — C7-1's "publish waits, never drops".
 *
 * `acquire()` resolves with a release function once fewer than `max` holders
 * are outstanding; waiters are served FIFO so publishes keep their order of
 * arrival. There is no refusal path: the bound limits memory held by in-flight
 * appends, and the queue of waiters is the caller's backpressure. Callers that
 * cannot afford an unbounded waiter queue bound it themselves (the publisher
 * does, with a mesh-visible ERROR rather than a silent drop).
 *
 * A release is idempotent (a double release cannot free a slot twice), and a
 * `reset()` rejects nobody: outstanding holders keep their release, but it is
 * scoped to the generation that granted it — the same exactness argument as
 * `reconfigure()` above.
 */
export interface AwaitedSlots {
    acquire(): Promise<() => void>;
    /** Holders currently outstanding (live generation). */
    inflight(): number;
    /** Callers waiting for a slot. */
    waiting(): number;
    /** Retire the live generation: fresh zero count; waiters are carried over and served. */
    reset(): void;
}

export function createAwaitedSlots(max: number): AwaitedSlots {
    if (!Number.isInteger(max) || max < 1) throw new Error(`createAwaitedSlots: max must be a positive integer (got ${max})`);
    let held = 0;
    let generation = 0;
    const waiters: Array<(release: () => void) => void> = [];

    const grant = (): (() => void) => {
        held++;
        const grantedGeneration = generation;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (grantedGeneration === generation) held--;
            pump();
        };
    };

    const pump = (): void => {
        while (held < max && waiters.length > 0) {
            const next = waiters.shift()!;
            next(grant());
        }
    };

    return {
        acquire() {
            if (held < max && waiters.length === 0) return Promise.resolve(grant());
            return new Promise<() => void>((resolve) => {
                waiters.push(resolve);
            });
        },
        inflight: () => held,
        waiting: () => waiters.length,
        reset() {
            generation++;
            held = 0;
            pump();
        },
    };
}
