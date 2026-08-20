/**
 * REFINE-ZOMBIE-SWEEP — classification of un-terminated refine dispatches.
 *
 * A refine job has no dedicated table: its state is DERIVED by replaying the
 * generic mesh event ledger. `task_dispatched` with no matching
 * `task_completed`/`task_failed` for the same (nodeId, jobId) reads as "still
 * open". That derivation has two failure modes this module exists to bound:
 *
 *  1. ARCHIVE ASYMMETRY (the root cause of the 2026-08-09 → 08-16 false
 *     zombies): compactLedger archives terminal kinds after
 *     ARCHIVE_TERMINAL_OLDER_THAN_MS and DELETES them from SQLite, while
 *     `task_dispatched` is deliberately never archived. Past that age the
 *     dispatch row outlives its own completion, so a job that finished in
 *     90 seconds re-reads as eternally open. mesh-ledger.ts now keeps the pair
 *     atomic (a terminal row is only archived when its dispatch goes with it),
 *     which stops NEW occurrences; this module is what makes the reader robust
 *     to rows already stranded by the old policy, and to a removed node.
 *
 *  2. BOOT-ONLY EVALUATION: the zombie cutoff used to be evaluated exclusively
 *     in resumePendingRefineJobsOnStartup, so a stale dispatch survived until
 *     the next daemon restart and then every accumulated phantom fired at once
 *     into coordinator context. The classification below is pure so the same
 *     logic can run on a throttled reconcile tick as well as at boot.
 *
 * This module is deliberately pure + dependency-light: it takes ledger entries
 * and returns decisions. Ledger writes, event emission and job spawning stay in
 * the caller (router-refine.ts), which owns the router instance.
 */

export type RefineDispatchDisposition =
    /** Young enough that the original executor may still be alive — reconsider later. */
    | 'defer_grace'
    /**
     * ★REFINE-RESUME-LIVENESS: the process that dispatched this job is STILL RUNNING
     * (verified against the OS, not inferred from age). Resuming would start a second
     * execution of one jobId — the 2026-08-20 ghost. Reconsider next pass.
     */
    | 'defer_executor_alive'
    /** Genuinely interrupted mid-flight — safe to re-run, preserving the jobId. */
    | 'resume'
    /** Past the zombie cutoff with no terminal row — close out, do not re-run. */
    | 'close_stale'
    /** The node no longer exists in the mesh — close out; re-running is impossible. */
    | 'close_removed_node';

export interface RefineDispatchRecord {
    nodeId: string;
    jobId: string;
    /** ISO-8601 dispatch timestamp from the ledger entry. */
    timestamp: string;
    /**
     * ★The dispatching process's identity stamp, when the row carries one.
     * Absent on every row written before REFINE-RESUME-LIVENESS shipped and on rows
     * from other daemons — which is why an absent stamp must classify as 'unknown'
     * and resume exactly as before, never as 'alive'.
     */
    executor?: unknown;
}

export interface RefineDispatchDecision {
    nodeId: string;
    jobId: string;
    disposition: RefineDispatchDisposition;
    /** Age at classification time; undefined when the timestamp is unparseable. */
    ageMs?: number;
}

export interface ClassifyRefineDispatchOptions {
    nowMs: number;
    graceMs: number;
    zombieCutoffMs: number;
    /** True when the node is still a member of the mesh. */
    nodeExists: (nodeId: string) => boolean;
    /** True when a job for this node is already executing in THIS process. */
    isRunning: (nodeId: string) => boolean;
    /**
     * ★REFINE-RESUME-LIVENESS: does the process that DISPATCHED this row still exist?
     *
     * `isRunning` above answers a strictly narrower question — "is it running in THIS
     * process?" — and a daemon restart empties the map it reads, so it structurally
     * returns false for the exact case that matters (the old process still running the
     * job). This probe crosses that boundary.
     *
     * Optional: when omitted, every dispatch classifies as before. Returning 'unknown'
     * (no stamp, remote host, probe failure) is likewise the pre-existing behavior — an
     * absent answer must never masquerade as 'alive', or one unstamped row would wedge
     * its node forever.
     */
    executorLiveness?: (record: RefineDispatchRecord) => 'alive' | 'dead' | 'unknown';
}

/**
 * Classify one un-terminated dispatch.
 *
 * Order matters. The removed-node check runs BEFORE the grace window because a
 * node that is gone from the mesh cannot be refined no matter how recent the
 * dispatch is — deferring it would just re-ask the same unanswerable question on
 * every future pass. It runs AFTER the in-process running check so a live local
 * job is never closed out from under itself.
 */
export function classifyRefineDispatch(
    record: RefineDispatchRecord,
    opts: ClassifyRefineDispatchOptions,
): RefineDispatchDecision | undefined {
    if (opts.isRunning(record.nodeId)) return undefined;

    const dispatchedAtMs = new Date(record.timestamp).getTime();
    const ageMs = Number.isFinite(dispatchedAtMs) ? opts.nowMs - dispatchedAtMs : undefined;
    const base = { nodeId: record.nodeId, jobId: record.jobId, ...(ageMs !== undefined ? { ageMs } : {}) };

    // REMOVED-NODE: the worktree node was removed (mesh_remove_node / worktree
    // retention cleanup) while a dispatch row stayed behind. Nothing ever
    // reconciled those rows, so the job outlived its own target and fired a
    // failure notification for a node the coordinator can no longer act on.
    if (!opts.nodeExists(record.nodeId)) {
        return { ...base, disposition: 'close_removed_node' };
    }

    // ★REFINE-RESUME-LIVENESS: the OS-verified answer, which supersedes both
    // age-based heuristics below.
    //
    // Placement is deliberate. It runs BEFORE the grace window and BEFORE the zombie
    // cutoff because both of those are proxies for the question "is the original
    // executor still alive?", and this is the question itself. Specifically:
    //
    //   - vs. defer_grace: grace defers for 60s and then assumes death. The two
    //     observed ghost dispatches were 6m30s and 3m51s old — long past grace, and
    //     both original processes were still running. Age cannot answer this; a
    //     refine pipeline's length is whatever `.adhdev/refine.json` configures.
    //   - vs. close_stale: closing out a job whose executor is DEMONSTRABLY ALIVE
    //     would write a terminal row for a running job, which is a worse version of
    //     the same bug (the ghost would then be the close-out itself).
    //
    // Only 'alive' — a positive, verified answer — defers. 'dead' and 'unknown' fall
    // through to the unchanged age-based logic, so a crashed executor still resumes
    // and an unstamped row behaves exactly as it did before this existed.
    if (opts.executorLiveness) {
        let liveness: 'alive' | 'dead' | 'unknown';
        try {
            liveness = opts.executorLiveness(record);
        } catch {
            // A probe that throws is not evidence; fall through to age-based logic.
            liveness = 'unknown';
        }
        if (liveness === 'alive') {
            return { ...base, disposition: 'defer_executor_alive' };
        }
    }

    // RESUME-DISPATCH-GRACE: too young to assume the original process is dead
    // (e.g. an old/new daemon overlap during an atomic upgrade handoff).
    if (ageMs !== undefined && ageMs >= 0 && ageMs < opts.graceMs) {
        return { ...base, disposition: 'defer_grace' };
    }

    // RESUME-ZOMBIE-CUTOFF: outlived any plausible single refine run.
    if (ageMs !== undefined && ageMs >= opts.zombieCutoffMs) {
        return { ...base, disposition: 'close_stale' };
    }

    return { ...base, disposition: 'resume' };
}

/**
 * Reduce ledger entries to the set of dispatches with no terminal counterpart.
 *
 * `terminalKeys` is keyed `${nodeId}:${jobId}` — the same composite the resume
 * scanner has always used, kept so a retry chain (retryOfJobId) closes out the
 * specific attempt that was dispatched rather than the whole node.
 */
export function selectOpenRefineDispatches(
    entries: Array<{ kind: string; nodeId?: string; timestamp: string; payload?: unknown }>,
    /**
     * ARCHIVE-TERMINAL-KEY-INDEX (A): pair keys (`refine:<nodeId>:<jobId>`) whose
     * terminal row was archived out of the live set. Rows stranded by the old
     * asymmetric policy have no readable terminal entry, so without this the
     * scanner re-reads a long-finished job as open. Optional — omitted by callers
     * that only have the live set, which keeps the previous behavior.
     */
    archivedTerminalKeys?: ReadonlySet<string>,
): RefineDispatchRecord[] {
    const terminalKeys = new Set<string>();
    for (const e of entries) {
        if (e.kind !== 'task_completed' && e.kind !== 'task_failed') continue;
        if (!e.nodeId) continue;
        const jobId = (e.payload as any)?.refineJob?.jobId;
        if (jobId) terminalKeys.add(`${e.nodeId}:${jobId}`);
    }

    const open: RefineDispatchRecord[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
        if (e.kind !== 'task_dispatched' || !e.nodeId) continue;
        const payload = e.payload as any;
        if (payload?.source !== 'refine_mesh_node_async_job') continue;
        const jobId = payload?.refineJob?.jobId;
        if (!jobId) continue;
        const key = `${e.nodeId}:${jobId}`;
        if (terminalKeys.has(key) || seen.has(key)) continue;
        // ARCHIVE-TERMINAL-KEY-INDEX (A): the terminal row may have been archived out
        // of `entries` entirely. `refineArchivePairKey` mirrors mesh-ledger's
        // ledgerPairKey spelling for refine jobs — the two MUST stay in step, which is
        // what the cross-module key-format test pins.
        if (archivedTerminalKeys?.has(refineArchivePairKey(e.nodeId, jobId))) continue;
        seen.add(key);
        // ★REFINE-RESUME-LIVENESS: carry the dispatching process's stamp forward so the
        // classifier can ask the OS whether that process still exists. Absent on
        // pre-fix rows — which classifyRefineDispatch treats as 'unknown', i.e. the
        // previous behavior.
        const executor = payload?.refineJob?.executor;
        open.push({ nodeId: e.nodeId, jobId, timestamp: e.timestamp, ...(executor ? { executor } : {}) });
    }
    return open;
}

/**
 * The archived-terminal-key spelling for a refine job. Mirrors mesh-ledger's
 * `ledgerPairKey` refine branch; kept here so this module stays dependency-light
 * and pure. A cross-module test asserts the two agree.
 */
export function refineArchivePairKey(nodeId: string, jobId: string): string {
    return `refine:${nodeId}:${jobId}`;
}

/**
 * NOTIFY-GRADE: should closing out this dispatch reach the coordinator as a
 * live `refine:failed` event?
 *
 * A close-out is bookkeeping, not news. Emitting one per stranded row is what
 * flooded coordinator context on 2026-08-16 (five week-old jobs surfacing as
 * same-priority failures alongside in-flight work). Ledger truth is unchanged
 * either way — a `task_failed` entry is always written, so the history and the
 * mesh_refine_status surfaces stay complete and auditable. Only the *push* into
 * an agent's turn is suppressed.
 *
 * The one case that still notifies: a job that was plausibly in flight this
 * session (younger than the notify horizon) and whose node still exists. That
 * is a real failure the coordinator may be actively waiting on.
 */
export function shouldNotifyRefineCloseOut(
    decision: Pick<RefineDispatchDecision, 'disposition' | 'ageMs'>,
    notifyHorizonMs: number,
): boolean {
    // A node that no longer exists has no actionable follow-up — never notify.
    if (decision.disposition === 'close_removed_node') return false;
    if (decision.disposition !== 'close_stale') return false;
    // FAIL-OPEN on an unparseable dispatch timestamp, mirroring the DISPATCH-ACK-EVIDENCE
    // precedent in mesh-skip-notify.ts (STALE-SCAN-BLOCKER): silently swallowing a real
    // blocker is the worse failure than an occasional over-notify. classifyRefineDispatch
    // can only ever PRODUCE 'close_stale' with ageMs defined (it is gated behind `ageMs !==
    // undefined && ageMs >= zombieCutoffMs`), so this branch is unreachable through the real
    // classifier today — but the type here is a Pick, not the classifier's return type, so a
    // future caller (or a refactor of the classifier) could still hand this function a
    // 'close_stale' decision with no age. When that happens we cannot tell "plausibly still
    // running this session" from "ancient" — the accurate answer is unknown, not "safe to
    // suppress" — so treat it as notify-worthy rather than let a corrupt/unparseable
    // timestamp silently eat a real close-out.
    if (decision.ageMs === undefined) return true;
    return decision.ageMs < notifyHorizonMs;
}
