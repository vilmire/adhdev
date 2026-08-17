// ---------------------------------------------------------------------------
// mesh-refine-inflight — the DURABLE (cross-process) refine in-flight guard
// ---------------------------------------------------------------------------
// `runningRefineJobs` (router.ts) is an in-MEMORY map, so it only ever answers
// "is this daemon PROCESS already running a refine for this node?". A refine
// job's identity is mesh-wide, not process-wide, and the gap between those two
// scopes is what let a single coordinator `mesh_refine_node` call become TWO
// `task_dispatched` rows for the same node (observed 3/3 on 2026-08-17, the
// second dispatch landing 2–5 minutes after the first and always failing
// spuriously against the worktree the first job had just torn down).
//
// The in-memory map cannot close that gap, because a second dispatch reaches a
// DIFFERENT process in at least these ways — none of them exotic:
//
//   1. Routing divergence. `refine_mesh_node` (med-family/fast-forward.ts)
//      forwards to the owning daemon only when the resolved node view carries a
//      `daemonId` that differs from this daemon's. A view that resolves WITHOUT
//      a usable `daemonId` makes `isRemote` falsy and the coordinator executes
//      LOCALLY instead of forwarding. Call #1 forwarding to the worker while
//      call #2 runs on the coordinator puts the two jobs in two processes, each
//      with its own empty `runningRefineJobs`.
//   2. Daemon restart. The map is lost on restart; the boot resume scan
//      (router-refine-resume.ts) re-dispatches the SAME jobId, and an old/new
//      daemon overlap during an atomic upgrade handoff can briefly run both.
//
// The ledger is the durable, per-daemon record those paths already write to, so
// it — not the map — is the authority this guard consults. `task_dispatched`
// with no matching terminal row means "a refine for this node is open here".
//
// Deliberately ADVISORY-BUT-BOUNDED: an open dispatch only blocks while it is
// still plausibly alive (`freshnessMs`). An older one is ignored rather than
// wedging the node forever, which is the failure mode a naive durable lock
// would introduce — a crashed job would make its node permanently un-refinable.
// The boot resume scan owns closing out genuinely dead dispatches; this guard
// only refuses the DUPLICATE, and only inside the window where a duplicate is
// what the evidence actually indicates.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { selectOpenRefineDispatches } from './mesh-refine-zombie-sweep.js';
import { buildRefineWorktreeMissingResult } from './mesh-refine-landing.js';
import { recordMeshRefineStage, type RefineContext } from './mesh-refine-gates.js';
import { readStringValue } from './mesh-node-identity.js';
import { readLedgerEntries, readArchivedTerminalKeys } from './mesh-ledger.js';
import { LOG } from '../logging/logger.js';

/** How long an open dispatch keeps blocking a second one for the same node.
 *
 *  Sized against the observed defect, not guessed: the duplicate dispatches
 *  landed 2–5 minutes after the first, and a refine pass legitimately runs
 *  typecheck/test/build for minutes (REFINE_VALIDATION_TIMEOUT_MS alone is
 *  120s, and a gate may run several such commands). 30 minutes covers a slow
 *  real run with headroom while still guaranteeing a crashed dispatch cannot
 *  wedge its node indefinitely. */
export const REFINE_INFLIGHT_FRESHNESS_MS = 30 * 60_000;

export interface RefineInflightLedgerEntry {
    kind: string;
    nodeId?: string;
    timestamp: string;
    payload?: unknown;
}

export interface OpenRefineDispatchMatch {
    nodeId: string;
    jobId: string;
    timestamp: string;
    ageMs: number;
}

/**
 * Find an OPEN (dispatched, not terminal) refine dispatch for `nodeId` that is
 * recent enough to still be running.
 *
 * Returns the newest such dispatch, or null when the node has none — which is
 * the answer for the overwhelmingly common case, so callers stay cheap.
 *
 * `excludeJobId` exists for the resume path: re-dispatching an interrupted job
 * preserves its ORIGINAL jobId (JOBID-RESUME-PRESERVE), so that job's own open
 * dispatch row must not be read as a duplicate of itself.
 */
export function findOpenRefineDispatchForNode(args: {
    entries: readonly RefineInflightLedgerEntry[];
    nodeId: string;
    nowMs: number;
    freshnessMs?: number;
    excludeJobId?: string;
    archivedTerminalKeys?: ReadonlySet<string>;
}): OpenRefineDispatchMatch | null {
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
    if (!nodeId) return null;
    const freshnessMs = typeof args.freshnessMs === 'number' && args.freshnessMs > 0
        ? args.freshnessMs
        : REFINE_INFLIGHT_FRESHNESS_MS;

    const open = selectOpenRefineDispatches(
        args.entries as Array<{ kind: string; nodeId?: string; timestamp: string; payload?: unknown }>,
        args.archivedTerminalKeys,
    );

    let newest: OpenRefineDispatchMatch | null = null;
    for (const record of open) {
        // Node ids are compared as the ledger stores them (the same spelling
        // selectOpenRefineDispatches keys on); the caller passes the id it is
        // about to dispatch under, so both sides come from the same source.
        if (record.nodeId !== nodeId) continue;
        if (args.excludeJobId && record.jobId === args.excludeJobId) continue;
        const dispatchedAt = Date.parse(record.timestamp);
        if (!Number.isFinite(dispatchedAt)) continue;
        const ageMs = args.nowMs - dispatchedAt;
        // A future-dated row (clock skew) has a negative age; treat it as fresh
        // rather than ignoring it — skew must not open the duplicate window.
        if (ageMs > freshnessMs) continue;
        if (!newest || dispatchedAt > Date.parse(newest.timestamp)) {
            newest = { nodeId: record.nodeId, jobId: record.jobId, timestamp: record.timestamp, ageMs };
        }
    }
    return newest;
}

/**
 * DURABLE-DUPLICATE-DISPATCH: read this daemon's ledger for an OPEN refine dispatch
 * on `nodeId` — a `task_dispatched` with no matching terminal row, recent enough to
 * still be running. The cross-process half of the in-flight guard that
 * `runningRefineJobs` (in-memory, per-process) structurally cannot provide.
 *
 * `selfJobId` is excluded so the resume path — which re-dispatches an interrupted job
 * under its ORIGINAL jobId (JOBID-RESUME-PRESERVE) — does not read that job's own open
 * row as a duplicate of itself and refuse to resume it.
 *
 * FAIL-OPEN: any ledger read failure returns null (dispatch proceeds). A guard that
 * blocked on its own read error would turn a transient store problem into an
 * un-refinable node, which is strictly worse than the duplicate it prevents.
 */
export function findOpenLedgerRefineDispatch(
    meshId: string,
    nodeId: string,
    selfJobId?: string,
): OpenRefineDispatchMatch | null {
    try {
        // Filter by kind with NO tail — the same read shape the resume scanner uses.
        // A tailed read would let unrelated ledger churn evict an in-flight dispatch
        // row and silently reopen the duplicate window this guard exists to close.
        const entries = readLedgerEntries(meshId, { kind: ['task_dispatched', 'task_completed', 'task_failed'] });
        return findOpenRefineDispatchForNode({
            entries,
            nodeId,
            nowMs: Date.now(),
            excludeJobId: selfJobId,
            archivedTerminalKeys: readArchivedTerminalKeys(meshId),
        });
    } catch (e: any) {
        LOG.warn('Mesh', `[Refinery] Durable duplicate-dispatch check failed for node ${nodeId} (allowing dispatch): ${e?.message || e}`);
        return null;
    }
}

/**
 * WORKTREE-VANISHED-MIDFLIGHT: stage-boundary re-check of the worktree directory.
 *
 * resolve_refs already refuses a worktree that is missing when the job STARTS. This
 * covers the other half: a worktree that disappears WHILE the job runs, which is the
 * shape the duplicate-dispatch defect actually produced — a second job resolving refs
 * a few seconds before the first job's cleanup removed the directory, then falling
 * over in whichever stage happened to be running when it vanished. That is why the
 * observed duplicates failed with DIFFERENT codes (validation_failed once,
 * dependency_bootstrap_failed twice): the code recorded whichever stage was running,
 * not the actual cause.
 *
 * Returns a terminal outcome carrying the SAME `worktree_missing` classification the
 * start-of-job check uses (one code covers both), stamped with the stage that was
 * about to run. Returns null — the common case — when the workspace is intact.
 */
export function refineWorktreeVanishedOutcome(
    ctx: RefineContext,
    nextStage: string,
): { kind: 'terminal'; result: { success: false } & Record<string, unknown> } | null {
    const workspace = (ctx as any)?.node?.workspace;
    if (typeof workspace !== 'string' || !workspace) return null;
    if (existsSync(workspace)) return null;
    recordMeshRefineStage(ctx.refineStages, nextStage, 'failed', Date.now(), {
        workspace, workspaceMissing: true, vanishedMidFlight: true,
    });
    const nodeId = readStringValue((ctx as any)?.node?.id) || 'unknown';
    const result = buildRefineWorktreeMissingResult(nodeId, workspace, ctx.refineStages);
    return {
        kind: 'terminal',
        result: {
            ...result,
            // Distinguish "gone before we started" from "removed out from under a running
            // job". Same terminal code, but only the latter implicates a concurrent job,
            // and that difference is what tells a reader whether to look for a duplicate.
            vanishedMidFlight: true,
            failedStage: nextStage,
        },
    };
}
