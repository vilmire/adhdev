// ---------------------------------------------------------------------------
// mesh-refine-concurrency — REFINE-CONCURRENCY-CAP: process-wide execution cap
// for Refinery pipelines.
//
// Background (2026-08-18 daemon-freeze RCA, investigation 9855083d, verdict D):
// two independent 19-gate refine pipelines (npm build + vitest each) overlapped
// on a 16GB / 10-core host and saturated the machine, blacking out the daemon
// event loop for 28–34s stretches (reconcile ticks went to zero; IPC probes
// timed out 0.6s before the process resumed). The fix at the source is to stop
// overlapping the pipelines, not to lengthen the probes' deadlines.
//
// Scope of the cap: the EXECUTION of the background pipeline only. The accept
// path (startMeshRefineJob / startMeshRefineBatchJob) stays async-ack — it
// returns `{ async: true, status: 'accepted' }` immediately, exactly as before.
// What changes is when the accepted job's pipeline actually starts: a second
// job is NOT rejected and the caller never re-invokes; it waits in this FIFO
// queue and starts automatically when the running job reaches a terminal state.
// Single-node jobs and batch jobs share the one queue — a batch is internally
// sequential, so one queue slot per batch is the right granularity.
//
// Default limit is 1 (fully serial). Override with
// ADHDEV_REFINE_MAX_CONCURRENT_JOBS (positive integer); anything unparseable or
// < 1 falls back to the default. On the 16GB / 10-core host where the freeze
// was observed, 1 is the correct value — raising it re-opens the overlap.
// ---------------------------------------------------------------------------

import { LOG } from '../logging/logger.js';

export const REFINE_MAX_CONCURRENT_JOBS_ENV = 'ADHDEV_REFINE_MAX_CONCURRENT_JOBS';
export const DEFAULT_REFINE_MAX_CONCURRENT_JOBS = 1;

export function resolveRefineMaxConcurrentJobs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env[REFINE_MAX_CONCURRENT_JOBS_ENV];
    if (raw === undefined || raw.trim() === '') return DEFAULT_REFINE_MAX_CONCURRENT_JOBS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_REFINE_MAX_CONCURRENT_JOBS;
    return parsed;
}

let activeExecutions = 0;
const waitQueue: Array<() => void> = [];

/** Snapshot for observability/tests: how many pipelines run and park right now. */
export function refineExecutionQueueStats(): { active: number; waiting: number; limit: number } {
    return { active: activeExecutions, waiting: waitQueue.length, limit: resolveRefineMaxConcurrentJobs() };
}

/**
 * Run `task` (one refine pipeline) holding a process-wide execution slot.
 *
 * When `activeExecutions` is already at the limit the caller is parked on a FIFO
 * wait queue and resumed once a running pipeline releases its slot — the job was
 * already accepted at the IPC layer, so waiting here is invisible to the caller
 * except through the log lines below (which is also how an operator tells
 * "queued behind another refine" apart from "daemon hung").
 *
 * The slot is released in `finally`, so a pipeline that throws still unblocks
 * the next queued job; a crashed job can wedge the queue no worse than it could
 * wedge the daemon before this cap existed.
 */
export async function runWithRefineExecutionSlot<T>(label: string, task: () => Promise<T>): Promise<T> {
    const limit = resolveRefineMaxConcurrentJobs();
    if (activeExecutions >= limit) {
        LOG.info('Mesh', `[Refinery] ${label} QUEUED — ${activeExecutions} refine job(s) already executing`
            + ` (limit ${limit}), ${waitQueue.length + 1} waiting. It starts automatically; do not re-invoke.`);
        await new Promise<void>((resolve) => { waitQueue.push(resolve); });
        LOG.info('Mesh', `[Refinery] ${label} dequeued — starting now (${activeExecutions} other job(s) still executing).`);
    }
    activeExecutions += 1;
    try {
        return await task();
    } finally {
        activeExecutions -= 1;
        const next = waitQueue.shift();
        if (next) next();
    }
}
