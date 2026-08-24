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
 *   moved           — the base is not where resolve_refs pinned it. EITHER
 *                     origin/<base> advanced (a peer pushed), OR origin still
 *                     matches the pin but repoRoot's LOCAL base — the commit the
 *                     merge actually applies onto — has moved past it. Both mean
 *                     "re-pin and re-validate", so both share one state.
 *   unmoved         — the remote answered, it still matches the pin, and the local
 *                     base has not outrun it either. Safe to merge/push.
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
    /**
     * The LOCAL base HEAD in repoRoot, set only when it is what made the verdict
     * 'moved' (it advanced past the pin while origin/<base> did not). Lets the
     * caller's stage record and error message name the axis that actually moved
     * instead of reporting a remote advance that never happened.
     */
    localBaseHead?: string;
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
 * Compare the SHA pinned back in resolve_refs against BOTH bases it has to agree
 * with: the re-fetched origin/<baseBranch>, and repoRoot's local base HEAD (the
 * commit `git merge` will actually apply onto). Either one disagreeing means the
 * pin no longer describes reality and the node must be re-validated.
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
    /**
     * The branch being merged. Used only to tell an already-absorbed local base
     * (benign) from one the branch never rebased onto (the R3 defect). Optional:
     * omitting it skips the local-ahead check entirely rather than guessing, which
     * degrades to the pre-existing remote-only CAS.
     */
    branchHead?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<RefineBaseCasVerdict> {
    const { execFileAsync, repoRoot, baseBranch, pinnedBaseHead, branchHead, env } = params;

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

    if (liveBaseHead !== pinnedBaseHead) {
        return { state: 'moved', liveBaseHead };
    }

    // ★The remote agrees with the pin — but the pin is not what we are about to
    // merge INTO. The pin is `origin/<base>` (resolve_refs); the merge runs
    // `git merge <branch>` in repoRoot, against its LOCAL HEAD. The Refinery
    // merges locally and pushes later — and under `requireApprovalForPush` it
    // does not push at all — so the local base routinely accumulates commits the
    // pin has never seen. That gap is the NORMAL steady state, not a fault.
    //
    // Nothing compared those two SHAs before this check existed. sync_base
    // computes divergence against the PIN (router-refine.ts), so a branch behind
    // the local base still measured `behind === 0` and recorded
    // `branch_up_to_date_with_base`, skipping the rebase; then the CAS compared
    // pin↔origin — both stale, both equal — and returned 'unmoved', letting the
    // merge run against a base the branch had never absorbed. Observed: pin
    // 74820488 vs local 7df78f1a (9 commits ahead) → rebase skipped → merge_failed
    // with conflicts in `oss`.
    //
    // Reusing 'moved' is deliberate: it already means "the base is not where you
    // pinned it — re-run and re-validate against where it actually is", and a
    // re-run re-pins and rebases. A new state would need parallel handling in
    // every caller for an identical remedy.
    const localBaseHead = branchHead ? await resolveLocalBaseHead(execFileAsync, repoRoot, env) : undefined;
    if (localBaseHead && branchHead && localBaseHead !== pinnedBaseHead
        // Ancestry-gated, not plain inequality: a local base BEHIND the pin (a peer
        // pushed, this checkout has not fast-forwarded) is harmless — merging into
        // an older base loses nothing and the push then fast-forwards. Only a local
        // base PAST the pin can hold commits the branch never absorbed.
        && await isAncestor(execFileAsync, repoRoot, pinnedBaseHead, localBaseHead, env)
        // ★And only when branch and local base have genuinely DIVERGED. Local-ahead-of-pin
        // on its own is the ordinary case, in two distinct shapes that are both safe:
        //
        //   local base ⊆ branch — a worktree cut from the local base inherits those
        //     commits, so it is ahead of the local base and merges cleanly. (Blocking
        //     on the raw gap failed 7 existing fixtures.)
        //   branch ⊆ local base — the branch is ALREADY merged into the local base,
        //     which is what an auto-retry sees after a push failure: attempt 1 merged
        //     locally, so attempt 2 finds local ahead of the pin. Re-merging is a
        //     no-op. (Blocking here masked a real `push_failed` as `base_moved` —
        //     the 8th fixture, and the more dangerous miss, since it would have
        //     replaced a true blocker with a misleading one.)
        //
        // Neither direction can conflict, so the test is symmetric containment. What
        // actually broke R3 is neither: the branch was cut before the local commits
        // (or from origin), sync_base measured it against the stale pin and skipped
        // the rebase, and the two sides diverged.
        && !(await isAncestor(execFileAsync, repoRoot, localBaseHead, branchHead, env))
        && !(await isAncestor(execFileAsync, repoRoot, branchHead, localBaseHead, env))) {
        return { state: 'moved', liveBaseHead, localBaseHead };
    }

    return { state: 'unmoved', liveBaseHead };
}

/**
 * The local base HEAD in repoRoot — literally the commit `git merge` will apply
 * onto, so this reads `HEAD` rather than `refs/heads/<baseBranch>`. They are the
 * same ref by construction (resolve_refs DEFINES baseBranch as repoRoot's
 * checked-out branch), and reading the one the merge actually uses keeps this
 * honest if that ever stops holding.
 *
 * Best-effort: an unreadable local HEAD returns undefined and the CAS falls
 * through to its pre-existing verdict. That is NOT the fail-closed compromise it
 * looks like — the fail-closed property protects the REMOTE comparison, which has
 * already succeeded by this point. This check only ever converts 'unmoved' into
 * 'moved'; failing to run it restores exactly the prior behaviour rather than
 * authorizing anything new.
 */
async function resolveLocalBaseHead(
    execFileAsync: RefineExecFileAsync,
    repoRoot: string,
    env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', env });
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * `git merge-base --is-ancestor` as a boolean: exit 0 = ancestor, exit 1 = not.
 * Any other failure (unknown SHA, corrupt repo) also lands in the catch and
 * reads as "not an ancestor", which is the conservative direction here — it
 * leaves the verdict untouched instead of inventing movement.
 */
async function isAncestor(
    execFileAsync: RefineExecFileAsync,
    repoRoot: string,
    maybeAncestor: string,
    descendant: string,
    env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
    try {
        await execFileAsync('git', ['merge-base', '--is-ancestor', maybeAncestor, descendant], { cwd: repoRoot, encoding: 'utf8', env });
        return true;
    } catch {
        return false;
    }
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
            return { status: 'failed', detail: {
                pinnedBaseHead, retryable: true, liveBaseHead: cas.liveBaseHead,
                // Present only on the local-ahead variant, so the record distinguishes
                // "a peer pushed" from "this checkout's own base outran the pin".
                ...(cas.localBaseHead ? { localBaseHead: cas.localBaseHead, movedAxis: 'local' } : {}),
            } };
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
            : cas.localBaseHead
                // ★Must not say "advanced" about origin here: origin/<base> still matches
                // the pin exactly. It is the LOCAL base — the actual merge target — that
                // outran it, so the prescription is a rebase onto the local base, and
                // naming the wrong axis would send a coordinator hunting a peer push that
                // never happened.
                ? `Local base ${baseBranch} in the source repo is ahead of the pinned ${pinnedBaseHead.slice(0, 7)} (now ${cas.localBaseHead.slice(0, 7)}) while origin/${baseBranch} still matches the pin; this branch was validated against the stale pin and never rebased onto those local commits, so merging would conflict. Re-run refine to re-pin and rebase onto the current local base.`
                : `Base ${baseBranch} advanced from ${pinnedBaseHead.slice(0, 7)} to ${(cas.liveBaseHead || '').slice(0, 7)} after this node was validated; re-run refine to rebase onto and re-validate the new base.`,
        branch,
        into: baseBranch,
        pinnedBaseHead,
        ...(undeterminable
            ? { baseCasUndeterminable: cas.reason }
            : { liveBaseHead: cas.liveBaseHead, ...(cas.localBaseHead ? { localBaseHead: cas.localBaseHead } : {}) }),
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
