/**
 * Refinery progress notifications — the "big trunk and the slow parts" only.
 *
 * ## What this is for
 *
 * A refine batch is minutes of silence followed by one terminal event. The
 * coordinator cannot tell a batch that is working from one that is wedged, so it
 * either waits blind or polls — and polling a generating job is itself a
 * documented coordinator failure (CLAUDE.md, Repo Mesh operating rules). Progress
 * events replace both: the job says where it is, and the coordinator waits.
 *
 * ## What it is deliberately NOT
 *
 * Not a per-gate feed. A 3-node batch runs ~35 gates per node; emitting one
 * event each would be ~105 events for a single batch. That is not observability,
 * it is a denial-of-service on the coordinator's context window — the exact
 * failure mode the mesh rules already warn about for status polling. The owner's
 * framing was "big trunk and things that take a long time", and this module
 * encodes that as three admission rules:
 *
 *   1. **Node transitions** always pass. There are N of them for N nodes, they
 *      are the batch's real structure, and "2 of 3 starting" is the single most
 *      useful fact a waiting coordinator can have.
 *   2. **Gates pass only if slow.** A gate is announced when it has been running
 *      longer than {@link SLOW_GATE_THRESHOLD_MS} — which is knowable only
 *      AFTER the fact, so the event is emitted on gate COMPLETION and reports
 *      duration. A fast gate emits nothing at all, so the ~35-gate set collapses
 *      to the handful that actually cost time.
 *   3. **Terminal-ish milestones** always pass: merge landed, submodule
 *      published, chain abort, node failed.
 *
 * On top of that, {@link MIN_EVENT_INTERVAL_MS} rate-limits the whole stream,
 * with an explicit carve-out: failure and abort events are NEVER throttled,
 * because suppressing the one event a coordinator must act on to save a few
 * tokens inverts the entire point.
 *
 * ## Why the existing pending-event channel, not a new one
 *
 * `queuePendingMeshCoordinatorEvent` already solves delivery: session-scoped
 * unicast addressing, survival across daemon restarts, dedup, and a drain the
 * coordinator already consumes. A second channel would have to re-derive all of
 * it, and would arrive out of order relative to the terminal event that shares
 * the job's identity. The events are marked `refine:progress` so an existing
 * consumer that only handles the accepted/completed/failed triplet ignores them
 * rather than mis-rendering them as terminal.
 */
import { LOG } from '../logging/logger.js';
import { queuePendingMeshCoordinatorEvent } from './mesh-events.js';

/**
 * A gate slower than this is worth announcing. Set at 30s per the owner's
 * "minute-scale gate" framing, which in this repo means typecheck, the
 * daemon-core vitest suites, and the build steps — while lint, the shape/size
 * guards, and the config checks stay silent.
 */
export const SLOW_GATE_THRESHOLD_MS = 30_000;

/**
 * Floor on the interval between NON-critical progress events. Bounds a
 * pathological batch (many slow gates across many nodes) to a readable stream
 * rather than a scroll.
 */
export const MIN_EVENT_INTERVAL_MS = 15_000;

/** Phases that must never be throttled or suppressed. */
const CRITICAL_PHASES: ReadonlySet<string> = new Set(['node_failed', 'chain_abort', 'job_failed']);

export type RefineProgressPhase =
    | 'node_started'
    | 'node_finished'
    | 'node_failed'
    | 'slow_gate'
    | 'merge_landed'
    | 'submodule_published'
    | 'chain_abort'
    | 'job_failed';

export interface RefineProgressEvent {
    phase: RefineProgressPhase;
    nodeId?: string;
    nodeIndex?: number;
    nodeCount?: number;
    /** Gate display command, for `slow_gate`. */
    gate?: string;
    /** Gate duration in ms, for `slow_gate`. */
    durationMs?: number;
    convergence?: string;
    code?: string;
    stage?: string;
    reason?: string;
    /** Bounded tail of the failing output, for `node_failed`. */
    errorTail?: string;
}

/**
 * Per-job emission state. Held by the caller (the batch/job loop) rather than in
 * a module-level map, so two concurrent jobs cannot throttle each other and
 * nothing has to be cleaned up when a job ends.
 */
export interface RefineProgressContext {
    meshId: string;
    jobId: string;
    /** Return address — same fields the terminal events use. */
    coordinatorDaemonId?: string;
    coordinatorSessionId?: string;
    /** Mutable: timestamp of the last emitted non-critical event. */
    lastEmittedAt?: number;
    /** Mutable: count of suppressed events, reported on the next emission. */
    suppressedCount?: number;
}

/**
 * Whether a gate deserves an event. Exported so the threshold is testable
 * without driving a batch, and so a caller cannot accidentally use a different
 * rule than the one documented here.
 */
export function isSlowRefineGate(durationMs: number): boolean {
    return durationMs >= SLOW_GATE_THRESHOLD_MS;
}

/**
 * Decide whether to emit, given the context's throttle state.
 *
 * Pure and separately exported so the throttle can be tested directly: the
 * interesting property (a critical event is never suppressed, no matter how
 * recently anything else was emitted) is one assertion here and an integration
 * test otherwise.
 */
export function shouldEmitRefineProgress(
    context: RefineProgressContext,
    phase: RefineProgressPhase,
    now: number,
): boolean {
    if (CRITICAL_PHASES.has(phase)) return true;
    const last = context.lastEmittedAt;
    if (last === undefined) return true;
    return now - last >= MIN_EVENT_INTERVAL_MS;
}

/**
 * Build the pending-event payload for a progress event.
 *
 * Mirrors the field layout of `queueRefineJobEvent`'s payload (including both
 * spellings of the coordinator session, which is what survives the P2P relay) so
 * a progress event routes exactly like the terminal events of the same job.
 */
export function buildRefineProgressEventPayload(
    context: RefineProgressContext,
    event: RefineProgressEvent,
    suppressedSinceLast: number,
): Record<string, unknown> {
    const metadataEvent = {
        source: 'refine_mesh_node_async_job',
        progress: true,
        jobId: context.jobId,
        meshId: context.meshId,
        nodeId: event.nodeId,
        ...event,
        ...(suppressedSinceLast > 0 ? { suppressedSinceLast } : {}),
        ...(context.coordinatorSessionId ? { meshCoordinatorSessionId: context.coordinatorSessionId } : {}),
    };
    return {
        event: 'refine:progress',
        meshId: context.meshId,
        nodeId: event.nodeId,
        nodeLabel: event.nodeId,
        metadataEvent,
        queuedAt: Date.now(),
        ...(context.coordinatorDaemonId ? { targetCoordinatorDaemonId: context.coordinatorDaemonId } : {}),
        ...(context.coordinatorSessionId ? { targetCoordinatorSessionId: context.coordinatorSessionId } : {}),
    };
}

/**
 * Emit one progress event, honouring the throttle.
 *
 * ★Never throws. Progress is an observability aid layered onto a job that must
 * converge regardless; a failure to describe the work must not become a failure
 * of the work. Every error is logged and swallowed.
 */
export function emitRefineProgress(context: RefineProgressContext, event: RefineProgressEvent): void {
    try {
        const now = Date.now();
        if (!shouldEmitRefineProgress(context, event.phase, now)) {
            context.suppressedCount = (context.suppressedCount ?? 0) + 1;
            return;
        }
        const suppressed = context.suppressedCount ?? 0;
        context.suppressedCount = 0;
        // A critical event does not reset the throttle clock: it is out-of-band, and
        // letting it do so would let a burst of failures starve the ordinary stream.
        if (!CRITICAL_PHASES.has(event.phase)) context.lastEmittedAt = now;
        queuePendingMeshCoordinatorEvent(buildRefineProgressEventPayload(context, event, suppressed) as any);
    } catch (e: any) {
        LOG.debug('Mesh', `[Refinery] progress event dropped (${event.phase}): ${e?.message || e}`);
    }
}
