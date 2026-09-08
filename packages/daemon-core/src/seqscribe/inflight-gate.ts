/**
 * Shared in-flight accounting for the fire-and-forget shadow legs.
 *
 * `mesh-dual-write.ts` and `fleet-status-shadow.ts` both append asynchronously
 * off a hot path (the ledger write / the status reporting tick) and both bound
 * themselves with a `MAX_INFLIGHT` load-shed. They hand-rolled that accounting
 * separately and grew the SAME two defects, so the counter lives here now: a
 * bug fixed in one leg is fixed in the other by construction.
 *
 * The gate is deliberately tiny. It owns one question — "how many appends are
 * genuinely outstanding right now" — and it owns it correctly:
 *
 * ── Why a slot is taken AFTER the append call, not before ───────────────────
 * seqscribe v3.5 P11 moved every data-dependent append failure onto the
 * returned Promise, but ONE synchronous throw survives normatively (SPEC §11.1:
 * a raw append on a register topic is static API misuse). A slot taken before
 * that throw is never returned — neither settle handler runs — so repeated
 * misuse walks the counter monotonically up to the cap and parks it there. The
 * leg then sheds every record for the life of the process while the topic is
 * perfectly healthy: a silent, permanent, fail-closed drop. `run()` therefore
 * takes the slot only once the append has actually returned a promise, and
 * reports a synchronous throw as a failure with no slot consumed.
 *
 * ── Why reconfigure stamps a generation instead of zeroing ──────────────────
 * Zeroing the counter while appends are outstanding is not a reset: those
 * appends still settle, and each one decrements from the new zero. The counter
 * goes NEGATIVE, and a negative baseline puts `>= MAX_INFLIGHT` out of reach —
 * the cap silently stops bounding anything, which is the exact failure the cap
 * exists to prevent. So `reconfigure()` bumps a generation and starts a fresh
 * count at zero, while every outstanding append keeps a reference to the
 * generation it was admitted under and settles against THAT. A late settle from
 * a retired generation is accounted where it belongs and cannot perturb the
 * live counter in either direction.
 *
 * This is exact rather than clamped on purpose. A `Math.max(0, ...)` would hide
 * the same mis-accounting it papers over; here the invariant `count >= 0` holds
 * because every decrement is paired with the increment that admitted it.
 */

/** Outcome of an attempted append, for the caller's counters. */
export type InflightAttempt =
    | { admitted: true }
    | { admitted: false; reason: 'shed' | 'threw'; error?: unknown };

export interface InflightGate {
    /**
     * Attempt one append.
     *
     * `start` must call the underlying `append` and return its promise. It is
     * invoked at most once, and only when a slot is available.
     *
     * Returns `{admitted: true}` when the append was handed to the topic and a
     * slot is held until it settles; `shed` when the cap was already reached
     * (nothing was attempted); `threw` when `start` threw synchronously, in
     * which case NO slot is consumed and `error` carries the throw.
     */
    run(
        start: () => Promise<unknown>,
        onSettled: (ok: true) => void,
        onRejected: (error: unknown) => void,
    ): InflightAttempt;
    /** Appends genuinely outstanding under the current generation. */
    count(): number;
    /**
     * Retire the current generation and start counting from zero. Appends
     * already outstanding settle against the retired generation and never touch
     * the new count.
     */
    reconfigure(): void;
}

export function createInflightGate(maxInflight: number): InflightGate {
    // The live generation's outstanding count. Retired generations keep their
    // own counter in the closure each admitted append captured, so a late
    // settle decrements a number nobody reads — never this one.
    let count = 0;
    let generation = 0;

    return {
        run(start, onSettled, onRejected) {
            if (count >= maxInflight) return { admitted: false, reason: 'shed' };

            const admittedGeneration = generation;
            let promise: Promise<unknown>;
            try {
                // ★ The append call happens BEFORE the slot is taken. If it
                // throws synchronously (P11's surviving static-misuse case) we
                // leave with the counter untouched — see the header.
                promise = start();
            } catch (error) {
                return { admitted: false, reason: 'threw', error };
            }

            count++;
            const release = (): void => {
                // Only the generation that admitted this append may release its
                // slot. After a reconfigure the admitting generation is retired
                // and its count is no longer the live one.
                if (admittedGeneration === generation) count--;
            };
            void promise.then(
                () => {
                    release();
                    onSettled(true);
                },
                (error: unknown) => {
                    release();
                    onRejected(error);
                },
            );
            return { admitted: true };
        },

        count() {
            return count;
        },

        reconfigure() {
            generation++;
            count = 0;
        },
    };
}
