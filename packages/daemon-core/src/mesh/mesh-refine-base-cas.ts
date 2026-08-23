/**
 * DS2 base-movement compare-and-swap: the time-of-check guard that runs
 * immediately before the Refinery's `git merge` and `git push origin <base>`.
 *
 * Extracted from `router-refine.ts` (which sits on the file-size gate's frozen
 * baseline) so the probe is a small, independently testable unit rather than
 * another block inside a 3,000-line orchestrator. The stage recording, the
 * terminal results, and the merge/push flow stay at the call site — this module
 * answers exactly one question: *did the base move, and do we actually know?*
 *
 * ★WHY IT IS TRI-STATE. The two-state predecessor ran
 *
 *     git fetch origin <base>
 *     git rev-parse origin/<base>
 *
 * under ONE shared `catch` that left `baseMoved = false` — which is also the
 * value meaning "the remote confirmed the base has not moved". A failure to
 * CONSULT the remote was therefore indistinguishable from a successful
 * consultation that found nothing, so the caller recorded `base_cas: passed` and
 * fell through to the merge and, when `requireApprovalForPush` was false, to a
 * real push. A transient network failure could publish a merge onto a base that
 * had moved underneath it.
 *
 * The precondition is ordinary, not exotic: on 2026-08-23 a dead macOS DNS
 * resolver broke `git fetch` in every worktree on the coordinator machine and
 * left zero lines in 17MB of daemon log — the shared catch swallowed it whole.
 *
 * So the fetch and the comparison are separate steps with separate failure
 * handling, and an unobtained verdict is `undeterminable`, never `unmoved`. Not
 * merging costs one retry; merging and pushing onto a base nobody verified is
 * unreviewed history on origin.
 */
import type { RefineExecFileAsync } from './mesh-refine-gates.js';

/**
 * The outcome of the base CAS.
 *
 *   moved           — the remote answered, and origin/<base> is not the pinned SHA.
 *   unmoved         — the remote answered, and it still is. Safe to merge/push.
 *   undeterminable  — we never got an answer (fetch failed, ref would not resolve).
 *                     Fail-closed: the caller must NOT merge or push.
 *   no_origin       — there is no `origin` remote configured at all. This is a
 *                     determinate answer, not a missing one: no remote base exists
 *                     to move, and nothing will be published. A local-only mesh
 *                     converges normally.
 */
export type RefineBaseCasState = 'moved' | 'unmoved' | 'undeterminable' | 'no_origin';

export type RefineBaseCasVerdict = {
    state: RefineBaseCasState;
    /** The live origin/<base> SHA. Only set for 'moved' / 'unmoved'. */
    liveBaseHead?: string;
    /** Human-readable cause. Only set for 'undeterminable'. */
    reason?: string;
    /**
     * The `git fetch` error message, when that is what made the verdict
     * undeterminable. Kept separate from `reason` so the stage record can
     * distinguish "could not reach the remote" from "reached it, but the ref did
     * not resolve" — the old code discarded this entirely.
     */
    fetchError?: string;
};

/**
 * Whether an `origin` remote is configured at all.
 *
 * ★`git fetch` cannot make this distinction on its own: a missing remote and an
 * unreachable one both produce "does not appear to be a git repository / Could
 * not read from remote repository". Asking for the configured URL separates them
 * without parsing error strings — which matters because the two cases must be
 * handled in opposite ways (converge vs refuse).
 */
async function hasOriginRemote(
    execFileAsync: RefineExecFileAsync,
    repoRoot: string,
    env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', env });
        return !!stdout.trim();
    } catch {
        return false;
    }
}

/**
 * Re-fetch origin/<baseBranch> and compare it against the SHA pinned back in
 * resolve_refs.
 *
 * Never throws: every failure mode is reported as a state, so the caller's
 * control flow is a switch rather than a try/catch that could re-introduce the
 * shared-catch defect.
 */
export async function probeRefineBaseCas(params: {
    execFileAsync: RefineExecFileAsync;
    repoRoot: string;
    baseBranch: string;
    pinnedBaseHead: string;
    env?: NodeJS.ProcessEnv;
}): Promise<RefineBaseCasVerdict> {
    const { execFileAsync, repoRoot, baseBranch, pinnedBaseHead, env } = params;

    if (!(await hasOriginRemote(execFileAsync, repoRoot, env))) {
        return { state: 'no_origin' };
    }

    try {
        await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8', env });
    } catch (e: any) {
        // The remote was never reached, so `refs/remotes/origin/<base>` is stale or
        // absent. Comparing against it would read off state the remote never
        // confirmed — do not even run the comparison.
        const fetchError = e?.message || String(e);
        return { state: 'undeterminable', reason: `git fetch origin ${baseBranch} failed: ${fetchError}`, fetchError };
    }

    let liveBaseHead: string;
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8', env });
        liveBaseHead = stdout.trim();
    } catch (e: any) {
        return { state: 'undeterminable', reason: `git rev-parse origin/${baseBranch} failed: ${e?.message || String(e)}` };
    }
    // A fetch can succeed while the ref still does not resolve (no such branch on
    // the remote). An empty answer is not "unmoved".
    if (!liveBaseHead) {
        return { state: 'undeterminable', reason: `git rev-parse origin/${baseBranch} produced no SHA` };
    }

    return { state: liveBaseHead === pinnedBaseHead ? 'unmoved' : 'moved', liveBaseHead };
}

/**
 * The `base_cas` stage record for a verdict: status plus detail, one record per
 * state.
 *
 * ★Returning a single record (rather than letting the call site emit one per
 * branch) is what makes double-recording structurally impossible — the
 * no_origin path and the pass path previously both ran, putting `base_cas` in
 * the stage list twice.
 */
export function describeRefineBaseCasStage(cas: RefineBaseCasVerdict, pinnedBaseHead: string): {
    status: 'passed' | 'failed' | 'skipped';
    detail: Record<string, unknown>;
} {
    switch (cas.state) {
        case 'no_origin':
            return { status: 'skipped', detail: { pinnedBaseHead, reason: 'no_origin_remote' } };
        case 'undeterminable':
            return { status: 'failed', detail: {
                pinnedBaseHead, retryable: true, undeterminable: true, reason: cas.reason,
                ...(cas.fetchError ? { fetchError: cas.fetchError } : {}),
            } };
        case 'moved':
            return { status: 'failed', detail: { pinnedBaseHead, retryable: true, liveBaseHead: cas.liveBaseHead } };
        default:
            return { status: 'passed', detail: { pinnedBaseHead, liveBaseHead: cas.liveBaseHead } };
    }
}

/**
 * The blocked-before-merge result shared by both CAS refusals.
 *
 * `base_moved` and `base_cas_undeterminable` differ only in code, message and
 * which SHA they can name — the convergence shape is identical (nothing merged,
 * nothing removed, retryable blocked_review), so it is built once here rather
 * than duplicated at the call site.
 */
export function buildRefineBaseCasBlockedResult(params: {
    cas: RefineBaseCasVerdict;
    baseBranch: string;
    branch: string;
    pinnedBaseHead: string;
    validationSummary: unknown;
    patchEquivalence: unknown;
    submoduleReachability: unknown;
    refineStages: Array<Record<string, unknown>>;
    // Structural match for `CommandRouterResult` (success + index signature). Declared
    // locally rather than imported from ../commands/router.js so this mesh module stays
    // free of a dependency on the command layer.
}): { success: boolean;[key: string]: unknown } {
    const { cas, baseBranch, branch, pinnedBaseHead, validationSummary, patchEquivalence, submoduleReachability, refineStages } = params;
    const undeterminable = cas.state === 'undeterminable';
    return {
        success: false,
        code: undeterminable ? 'base_cas_undeterminable' : 'base_moved',
        convergenceStatus: 'blocked_review',
        retryable: true,
        error: undeterminable
            ? `Could not verify whether base ${baseBranch} is still at the pinned ${pinnedBaseHead.slice(0, 7)} (${cas.reason}); refusing to merge or push onto an unverified base. Restore access to origin and re-run refine.`
            : `Base ${baseBranch} advanced from ${pinnedBaseHead.slice(0, 7)} to ${(cas.liveBaseHead || '').slice(0, 7)} after this node was validated; re-run refine to rebase onto and re-validate the new base.`,
        branch,
        into: baseBranch,
        pinnedBaseHead,
        ...(undeterminable ? { baseCasUndeterminable: cas.reason } : { liveBaseHead: cas.liveBaseHead }),
        validationSummary,
        patchEquivalence,
        submoduleReachability,
        refineStages,
        finalBranchConvergenceState: {
            branch, baseBranch, merged: false, removed: false, status: 'blocked_review',
            ...(undeterminable
                ? { nextStep: 'Restore access to origin (the base compare-and-swap could not run), then re-run refine for this node.' }
                : {}),
        },
    };
}
