/**
 * runtime-slot — the ONE process-wide seqscribe binding (wiring-unification B4).
 *
 * Before B4, ten independently-ordered `configure*` module globals were armed
 * one by one in boot and nulled one by one at shutdown. What remains is this
 * single slot: bound atomically when the projections are armed
 * (boot/stages/seqscribe-projections.ts) and cleared in that stage's disposer.
 *
 * It exists only for readers that have no components/ctx in scope — the mesh
 * read-readiness gate, the handoff-note writer, the status reporter's fleet
 * producer fallback. Anything that already holds a `DaemonComponents` or a
 * command ctx reads `components.seqscribe` explicitly instead.
 */

import type { SeqscribeRuntime } from './runtime.js';

let current: SeqscribeRuntime | null = null;

/** Bind (or clear with null) the process's armed seqscribe runtime. */
export function bindSeqscribeRuntime(runtime: SeqscribeRuntime | null): void {
    current = runtime;
}

export const seqscribeSlot = {
    /** The armed runtime, or null before arming / after shutdown / with no node. */
    current(): SeqscribeRuntime | null {
        return current;
    },
};
