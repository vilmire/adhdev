/**
 * REFINE-TERMINAL-ONCE — at most one terminal row per refine jobId.
 *
 * ★The defect (observed 2026-08-20, jobs refine_ix_mt1d5wir_3226uh and
 * refine_ix_mt1ew71i_zobslj — 2/2 the same shape):
 *
 *     10:14:34  dispatch #1 (interaction ix_mt1d5wir_luwqpf) — the REAL job, running
 *               in daemon process A
 *     10:21:04  daemon restart
 *     10:21:04  boot resume scan re-dispatches the SAME jobId (JOBID-RESUME-PRESERVE)
 *     10:21:05  dispatch #2 (interaction ix_mt1de9pf_97sexk) — the GHOST, process B
 *     10:21:06  task_failed   ← the ghost, 1.5s in
 *     10:21:10  task_completed ← process A, still alive, actually merged
 *
 * This is NOT a retry loop. It is TWO INDEPENDENT EXECUTIONS of one jobId, in two
 * processes, each believing it owns the job — which breaks two invariants at once:
 * `selectOpenRefineDispatches` keys terminal rows `${nodeId}:${jobId}` (so a second
 * terminal row for one key is meaningless), and mesh-refine-inflight exists
 * specifically to enforce one execution per node.
 *
 * ★THE ORDERING TRAP. The obvious guard — "first terminal write wins" — makes the
 * situation WORSE, not better: in the observed timeline the ghost wrote FIRST. A
 * first-wins rule would enshrine the ghost's spurious failure and discard the real
 * job's success, i.e. it would guarantee the wrong answer in the one case we have
 * actual evidence for.
 *
 * So the rule is not chronological. It is:
 *
 *   1. CONVERGENCE BEATS NON-CONVERGENCE. A `task_completed` (the change reached
 *      origin) always supersedes a `task_failed`, regardless of which was written
 *      first. This is not a heuristic — convergence is a claim about the WORLD (a
 *      merge landed on origin/main) that the loser cannot contradict, while a
 *      failure is only a claim about one execution's local attempt. When a merge
 *      demonstrably landed, "it failed" is false no matter who said it first.
 *   2. AMONG EQUALS, FIRST WINS. Two failures (or two successes) for one jobId are
 *      genuinely redundant; keep the earliest and refuse the rest.
 *
 * ★NOTHING IS SWALLOWED SILENTLY. A refused write always produces a decision object
 * carrying the reason and both execution identities (`interactionId`), and the
 * caller logs it. A guard that quietly dropped the second row would remove the very
 * evidence that made this diagnosis possible.
 *
 * PURE by design: no ledger reads, no router. The caller supplies the already-known
 * prior terminal record; this module only decides.
 */

/** What a previously-written terminal row looked like. */
export interface ExistingRefineTerminal {
    /** 'task_completed' | 'task_failed' as written to the ledger. */
    kind: 'task_completed' | 'task_failed';
    /** The EXECUTION identity that wrote it — distinct per run, unlike jobId. */
    interactionId?: string;
    /** ISO-8601 write time. */
    completedAt?: string;
}

export interface IncomingRefineTerminal {
    kind: 'task_completed' | 'task_failed';
    interactionId?: string;
    completedAt?: string;
}

export type RefineTerminalDecision =
    | {
        allow: true;
        /**
         * True when this write is superseding a terminal row that already exists —
         * i.e. a genuine convergence-beats-failure correction, not a first write.
         */
        supersedes: boolean;
        reason: 'first_terminal' | 'convergence_supersedes_failure';
        note?: string;
    }
    | {
        allow: false;
        reason: 'duplicate_terminal_same_grade' | 'failure_cannot_supersede_convergence';
        note: string;
    };

/**
 * Decide whether `incoming` may be written as the terminal row for a jobId that
 * `existing` (possibly) already closed.
 *
 * `existing === undefined` — the overwhelmingly common case — always allows.
 */
export function decideRefineTerminalWrite(
    incoming: IncomingRefineTerminal,
    existing: ExistingRefineTerminal | undefined,
    ctx: { jobId: string; nodeId: string },
): RefineTerminalDecision {
    if (!existing) {
        return { allow: true, supersedes: false, reason: 'first_terminal' };
    }

    const incomingConverged = incoming.kind === 'task_completed';
    const existingConverged = existing.kind === 'task_completed';

    // ★RULE 1a: a real success supersedes an earlier (ghost) failure. This is the
    // observed 2026-08-20 case and the reason "first write wins" is wrong.
    if (incomingConverged && !existingConverged) {
        return {
            allow: true,
            supersedes: true,
            reason: 'convergence_supersedes_failure',
            note: `Refine job ${ctx.jobId} (node ${ctx.nodeId}) already had a task_failed row from execution `
                + `${existing.interactionId || 'unknown'}${existing.completedAt ? ` at ${existing.completedAt}` : ''}, but execution `
                + `${incoming.interactionId || 'unknown'} converged (the merge reached origin). Convergence is a claim about the `
                + `repository, not about one execution, so it supersedes the earlier failure. Two executions for one jobId means a `
                + `ghost dispatch ran alongside the real job — see REFINE-RESUME-LIVENESS.`,
        };
    }

    // ★RULE 1b: the mirror image — a failure may NEVER overwrite a convergence.
    // The merge is on origin; reporting failure would tell the coordinator to
    // re-refine an already-merged branch, which is the destructive direction.
    if (!incomingConverged && existingConverged) {
        return {
            allow: false,
            reason: 'failure_cannot_supersede_convergence',
            note: `Refused a task_failed terminal write for refine job ${ctx.jobId} (node ${ctx.nodeId}) from execution `
                + `${incoming.interactionId || 'unknown'}: that job ALREADY converged via execution `
                + `${existing.interactionId || 'unknown'}${existing.completedAt ? ` at ${existing.completedAt}` : ''}. The merge is on `
                + `origin; recording a failure would tell the coordinator to re-refine an already-merged branch. This is a GHOST `
                + `execution — the two interactionIds prove two independent runs of one jobId. See REFINE-RESUME-LIVENESS.`,
        };
    }

    // ★RULE 2: same grade (failure vs failure, or success vs success) — redundant.
    // Keep the first; the second carries no new information about the outcome.
    return {
        allow: false,
        reason: 'duplicate_terminal_same_grade',
        note: `Refused a duplicate ${incoming.kind} terminal write for refine job ${ctx.jobId} (node ${ctx.nodeId}) from execution `
            + `${incoming.interactionId || 'unknown'}: execution ${existing.interactionId || 'unknown'} already wrote a `
            + `${existing.kind}${existing.completedAt ? ` at ${existing.completedAt}` : ''} for this jobId. Two executions for one `
            + `jobId means a ghost dispatch ran alongside the real job — see REFINE-RESUME-LIVENESS.`,
    };
}

/**
 * Reduce ledger entries to the terminal row (if any) already recorded for `jobId`.
 *
 * Reads the SAME payload shape `appendRefineJobLedger` writes and matches on
 * (nodeId, jobId) — the same composite `selectOpenRefineDispatches` keys on, kept
 * deliberately in step so "is this dispatch open?" and "did this job already
 * terminate?" can never disagree.
 *
 * Returns the EARLIEST terminal row when several exist. Later rows are exactly what
 * this guard is meant to prevent, so if the store already holds some (written
 * before this fix shipped), the first one is the one the rest were compared against.
 */
export function findExistingRefineTerminal(
    entries: ReadonlyArray<{ kind: string; nodeId?: string; timestamp: string; payload?: unknown }>,
    nodeId: string,
    jobId: string,
): ExistingRefineTerminal | undefined {
    let earliest: ExistingRefineTerminal | undefined;
    let earliestMs = Number.POSITIVE_INFINITY;
    for (const e of entries) {
        if (e.kind !== 'task_completed' && e.kind !== 'task_failed') continue;
        if (e.nodeId !== nodeId) continue;
        const job = (e.payload as any)?.refineJob;
        if (job?.jobId !== jobId) continue;
        const ts = Date.parse(e.timestamp);
        // An unparseable timestamp still counts as a terminal row — dropping it would
        // reopen the duplicate window on exactly the corrupt data most likely to
        // confuse a reader. It just sorts last.
        const ms = Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
        if (ms < earliestMs) {
            earliestMs = ms;
            earliest = {
                kind: e.kind as 'task_completed' | 'task_failed',
                interactionId: typeof job?.interactionId === 'string' ? job.interactionId : undefined,
                completedAt: typeof job?.completedAt === 'string' ? job.completedAt : e.timestamp,
            };
        }
    }
    return earliest;
}

/**
 * Ledger-backed form of `decideRefineTerminalWrite`: read this daemon's ledger for a
 * terminal row already recorded under `jobId`, then decide.
 *
 * The I/O shell around the pure decision above, kept here (rather than inline in
 * finishMeshRefineJob) so the read shape and the decision stay in one place — and so
 * router-refine.ts stays under the repo file-size gate.
 *
 * FAIL-OPEN, matching `findOpenLedgerRefineDispatch`: a guard that blocked on its own
 * read error would turn a transient store problem into a job that never reports at
 * all, which is strictly worse than the duplicate it prevents. `onReadError` lets the
 * caller log that (it owns the logger).
 */
export async function decideRefineTerminalWriteFromLedger(args: {
    meshId: string;
    nodeId: string;
    jobId: string;
    kind: 'task_completed' | 'task_failed';
    interactionId?: string;
    completedAt?: string;
    onReadError?: (message: string) => void;
}): Promise<RefineTerminalDecision> {
    try {
        const { readLedgerEntries } = await import('./mesh-ledger.js');
        const existing = findExistingRefineTerminal(
            readLedgerEntries(args.meshId, { kind: ['task_completed', 'task_failed'] }),
            args.nodeId,
            args.jobId,
        );
        return decideRefineTerminalWrite(
            { kind: args.kind, interactionId: args.interactionId, completedAt: args.completedAt },
            existing,
            { jobId: args.jobId, nodeId: args.nodeId },
        );
    } catch (e: any) {
        args.onReadError?.(`Terminal-once check failed for job ${args.jobId} (allowing write): ${e?.message || e}`);
        return { allow: true, supersedes: false, reason: 'first_terminal' };
    }
}
