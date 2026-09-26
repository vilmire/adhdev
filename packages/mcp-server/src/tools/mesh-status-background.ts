// Background work kicked by the MCP `mesh_status` tool — never awaited by it.
//
// Owner principle (2026-09-26): the request path answers from what the
// coordinator already holds; it does not wait on a remote machine. The
// direct-dispatch transcript reconcile (mesh-direct-dispatch-reconcile.ts) reads
// the worker's transcript — a replica read and, on a miss, a live `read_chat` to
// the worker's daemon — to report `transcript_final` evidence to the daemon's turn
// ledger. That is a WRITE-side nudge, not something the answer needs: its only
// visible effect is a terminal the daemon commits, which the next mesh_status
// (or the coordinator's completion notice) shows. So it runs here, after the
// response is built:
//   - single-flight per MeshContext: a poll while one is running starts nothing;
//   - errors are swallowed (the pass is advisory; the watchdog / completion
//     paths remain the primary completion route);
//   - `awaitMeshStatusBackgroundWork` lets tests (and a shutdown) wait for it.

import { buildDirectDispatchReconciliationCandidates, reconcileDirectDispatchesFromTranscriptEvidence } from './mesh-direct-dispatch-reconcile.js';
import type { MeshContext } from './mesh-tools-internal.js';

const inflightReconcile = new WeakMap<MeshContext, Promise<void>>();

/** Returns true when a background reconcile pass was started. */
export function scheduleBackgroundDirectReconcile(
    ctx: MeshContext,
    nodes: any[],
    directDispatches: any[],
    records: any[],
): boolean {
    if (inflightReconcile.has(ctx)) return false;
    if (buildDirectDispatchReconciliationCandidates(directDispatches, records).length === 0) return false;
    const run = reconcileDirectDispatchesFromTranscriptEvidence(ctx, nodes, directDispatches, records)
        .then(() => undefined, () => undefined)
        .finally(() => {
            if (inflightReconcile.get(ctx) === run) inflightReconcile.delete(ctx);
        });
    inflightReconcile.set(ctx, run);
    return true;
}

/** Resolves once the background work kicked by mesh_status for this context has settled. */
export async function awaitMeshStatusBackgroundWork(ctx: MeshContext): Promise<void> {
    while (inflightReconcile.has(ctx)) {
        await inflightReconcile.get(ctx);
    }
}
