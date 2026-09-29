/**
 * Refinery early-pipeline stages — resolve_refs and sync_base (fetch, rebase onto the
 * live base with gitlink auto-resolution, submodule convergence), each taking the
 * router instance as `self` and either returning a terminal result or continuing with
 * the extended RefineContext. Split out of router-refine.ts, which keeps the pipeline
 * driver and the later stages.
 */
import type { DaemonCommandRouter } from './router.js';
import { RefineStageOutcome, recordMeshRefineStage, RefineExecFileAsync, RefineContext, runMeshRefinePatchEquivalenceGate, resolveRefineryAutoPublishSubmoduleMainCommits, convergeDivergedSubmoduleGitlinks, describeMintedUnpublishedCommits, buildSubmoduleConvergeDeclineDetails, describeSubmoduleConvergeDecline, collectTrivialFastForwardGitlinkResolutions, rootRebaseResolvingGitlinks, buildGeneratedBundleResolutionStageDetail, classifyAndWarnPatchEquivalenceFailure } from '../mesh/mesh-refine-gates.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { existsSync } from 'node:fs';
import { buildRefineWorktreeMissingResult } from '../mesh/mesh-refine-landing.js';
import { gitChildEnv, GIT_LOCAL_TIMEOUT_MS as REFINE_GIT_LOCAL_TIMEOUT_MS } from '../git/git-locale.js';
import { classifyChangedPackages, type ChangedPackageClassification } from '../git/git-status.js';
import { LOG } from '../logging/logger.js';
import { hiddenExecFileSync } from '../process/hidden-spawn.js';
import { classifyRefineRebaseFailure, buildRefineRebaseFailureError } from '../mesh/mesh-refine-rebase-failure.js';

    /**
     * resolve_refs stage: resolve the mesh / worktree node / source node /
     * repoRoot, then the worktree branch, base branch, fetched base head and
     * branch head. Seeds the RefineContext consumed by every later stage.
     */
export async function refineResolveRefsStage(self: DaemonCommandRouter, 
        meshId: string,
        nodeId: string,
        args: any,
        refineStages: Array<Record<string, unknown>>,
    ): Promise<RefineStageOutcome> {
            // preferInline: same as startMeshRefineJob — inline-cache-only clone nodes must resolve.
            const meshRecord = await self.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!node) return { kind: 'terminal', result: { success: false, error: `Node '${nodeId}' not found in mesh`, refineStages } };

            if (!node.isLocalWorktree || !node.workspace) {
                return { kind: 'terminal', result: { success: false, error: `Refinery requires a local worktree node`, refineStages } };
            }

            // GHOST-FAILURE: the worktree directory is already GONE — almost always
            // because a PRIOR refine merged, pushed and cleaned it up. Terminate with a
            // named blocker instead of spawning git/bootstrap into a deleted directory,
            // which is what produced ghost dependency_bootstrap_failed / merge_failed
            // notifications for nodes whose work was already on origin. Rationale and the
            // exact result shape live in buildRefineWorktreeMissingResult.
            if (!existsSync(node.workspace)) {
                recordMeshRefineStage(refineStages, 'resolve_refs', 'failed', Date.now(), {
                    workspace: node.workspace, workspaceMissing: true,
                });
                return { kind: 'terminal', result: buildRefineWorktreeMissingResult(nodeId, node.workspace, refineStages) };
            }

            const sourceNode = node.clonedFromNodeId
                ? mesh?.nodes.find((n: any) => meshNodeIdMatches(n, node.clonedFromNodeId))
                : mesh?.nodes.find((n: any) => !n.isLocalWorktree);
            const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
            if (!repoRoot) return { kind: 'terminal', result: { success: false, error: 'Source node repoRoot not found', refineStages } };

            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile) as unknown as RefineExecFileAsync;

            const resolveStarted = Date.now();
            const { stdout: branchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
            const branch = branchStdout.trim();
            if (!branch) return { kind: 'terminal', result: { success: false, error: 'Could not determine branch of the worktree node', refineStages } };

            const { stdout: baseBranchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
            const baseBranch = baseBranchStdout.trim();

            // Fetch origin so baseHead reflects the latest pushed state, not a stale local HEAD.
            // This prevents patch_equivalence failures when sequential Refines push to origin/main
            // but the local main checkout hasn't been fast-forwarded yet.
            let fetchWarning: string | undefined;
            try {
                // `timeout` mirrors the async sibling call sites in `mesh-fast-forward.ts`:
                // without it an unreachable remote hangs this await forever, so the refine
                // job never completes and holds its node slot indefinitely.
                await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv(), timeout: 30_000 });
            } catch (e: any) {
                fetchWarning = `git fetch origin ${baseBranch} failed (proceeding with local HEAD): ${e?.message}`;
            }

            // Prefer origin/<baseBranch> as the authoritative base.
            //
            // ★The fallback is narrower than "if fetch failed" (what this comment used to
            // claim): `rev-parse origin/<base>` reads the LOCAL remote-tracking ref, which
            // survives a failed fetch, so a failed fetch normally still pins a STALE origin
            // SHA here — only `fetchWarning` records it. Local HEAD is reached solely when
            // no remote-tracking ref exists at all. That is fine as a STARTING point
            // because base_cas re-checks before merging — which is why it must stay
            // fail-closed.
            let baseHeadRaw: string;
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
                baseHeadRaw = stdout.trim();
            } catch {
                const { stdout: localHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
                baseHeadRaw = localHead.trim();
            }

            const { stdout: branchHeadStdout } = await execFileAsync('git', ['rev-parse', branch], { cwd: node.workspace, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
            const baseHead = baseHeadRaw;
            const branchHead = branchHeadStdout.trim();

            // Coarse daemon-vs-web change-impact for baseHead..branchHead, computed
            // against the worktree so the same policy (.adhdev/change-impact.*) as the
            // stale-build detector applies. Threaded onto ctx so the validation gate
            // can scope its command set: a web-only branch skips daemon-scoped commands.
            // FAIL-OPEN: any classification error leaves changeImpact undefined → the
            // gate runs the full command set (never skip on uncertainty).
            let changeImpact: ChangedPackageClassification | undefined;
            try {
                changeImpact = await classifyChangedPackages(node.workspace, baseHead, branchHead);
            } catch {
                changeImpact = undefined;
            }
            recordMeshRefineStage(refineStages, 'resolve_refs', 'passed', resolveStarted, {
                branch, baseBranch, baseHead, branchHead,
                ...(changeImpact ? { changeImpact } : {}),
                ...(fetchWarning ? { fetchWarning } : {}),
            });

            return {
                kind: 'continue',
                ctx: {
                    meshId,
                    nodeId,
                    args,
                    refineStages,
                    execFileAsync,
                    mesh,
                    node,
                    sourceNode,
                    repoRoot,
                    branch,
                    baseBranch,
                    baseHead,
                    branchHead,
                    changeImpact,
                    validationSummary: undefined as any,
                    patchEquivalence: undefined as any,
                    submoduleReachability: undefined as any,
                },
            };
    }

/**
 * DS2: compute the branch↔base divergence explicitly via merge-base + rev-list, so a
 * DIVERGED laggard (ahead>0 AND behind>0) is identified — not just the strict-ancestor
 * "simply behind" case the old auto-rebase handled. Returns ahead/behind counts and the
 * merge-base; behind>0 means base has commits the branch lacks (rebase target), ahead>0
 * means the branch has its own commits. All counts are best-effort (0 on any git error).
 */
async function computeBranchBaseDivergence(
    execFileAsync: RefineExecFileAsync,
    cwd: string,
    baseHead: string,
    branchHead: string,
): Promise<{ mergeBase?: string; ahead: number; behind: number; diverged: boolean; isStrictlyBehind: boolean }> {
    let mergeBase: string | undefined;
    try {
        const { stdout } = await execFileAsync('git', ['merge-base', baseHead, branchHead], { cwd, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
        mergeBase = stdout.trim() || undefined;
    } catch { /* unresolved base/branch — treat as no shared history */ }
    let ahead = 0;
    let behind = 0;
    try {
        // `--left-right --count base...branch` → "<behind>\t<ahead>": left (base-only) =
        // commits the branch is BEHIND; right (branch-only) = commits the branch is AHEAD.
        const { stdout } = await execFileAsync('git', ['rev-list', '--left-right', '--count', `${baseHead}...${branchHead}`], { cwd, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
        const [left, right] = stdout.trim().split(/\s+/).map(n => Number.parseInt(n, 10));
        behind = Number.isFinite(left) ? left : 0;
        ahead = Number.isFinite(right) ? right : 0;
    } catch { /* keep zero counts on error */ }
    return {
        mergeBase,
        ahead,
        behind,
        diverged: ahead > 0 && behind > 0,
        // Strictly behind = base is a descendant of branch (branch is an ancestor of base):
        // behind>0 with ahead===0.
        isStrictlyBehind: behind > 0 && ahead === 0,
    };
}

    /**
     * DS2 sync_base stage: bring the worktree branch up to the pinned baseHead BEFORE
     * validation, so every later gate (validation, patch_equivalence, merge) sees the
     * final rebased tree rather than a stale pre-rebase one.
     *
     * The old auto-rebase lived inside patch_equivalence and only fired when branchHead
     * was a STRICT ANCESTOR of baseHead (`merge-base --is-ancestor`). A diverged laggard
     * — the branch has its own commits AND base moved underneath it (ahead>0 AND behind>0)
     * — failed that ancestor check, so it was never rebased and fell straight to
     * patch_equivalence_failed / blocked_review even though a clean rebase would have
     * converged it. Here we compute ahead/behind explicitly and rebase whenever behind>0
     * (strictly-behind OR diverged), aborting to blocked_review only on a real conflict.
     *
     * On a successful rebase we recompute branchHead and re-derive changeImpact against
     * the rebased tree (its baseHead..branchHead diff changed), and record the
     * `patch_equivalence_after_auto_rebase` stage so the batch/ancestry assertions can see
     * the rebase happened. When the branch is already up to date (behind===0), this is a
     * no-op passed stage.
     */
export async function refineSyncBaseStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { repoRoot, baseHead, node, branch, baseBranch, refineStages, execFileAsync } = ctx;
            let branchHead = ctx.branchHead;
            // Converged submodule gitlink resolutions (path → rebased commit) from STEP 1;
            // consumed by the gitlink-aware root rebase (STEP 2) to resolve gitlink conflicts.
            let gitlinkResolutions: Array<{ path: string; rebasedCommit: string }> = [];
            const syncStarted = Date.now();
            const divergence = await computeBranchBaseDivergence(execFileAsync, node.workspace, baseHead, branchHead);

            if (divergence.behind === 0) {
                // Branch already contains baseHead — nothing to sync. (ahead>0 is fine; that
                // is the normal "branch is ahead, ready to merge" case.)
                recordMeshRefineStage(refineStages, 'sync_base', 'passed', syncStarted, {
                    ahead: divergence.ahead,
                    behind: divergence.behind,
                    rebased: false,
                    reason: 'branch_up_to_date_with_base',
                });
                return { kind: 'continue', ctx };
            }

            // Pre-rebase gate probe (MUST precede the rebase) — two cases where rebasing is
            // the wrong move and we defer to the patch_equivalence stage with the branch
            // intact:
            //   (1) already-merged-via-another-path — the branch's changes are already in
            //       base (merge-tree produces no diff: actualPatchId empty, expectedPatchId
            //       non-empty). A rebase would drop every commit as empty and leave a
            //       degenerate no-commit branch patch_equivalence can no longer recognize.
            //   (2) submodule gitlink conflict — base and branch advanced the SAME submodule
            //       to divergent commits. A blind root rebase would silently take the
            //       branch-side gitlink and hide the conflict (surfacing it later, without
            //       the actionable hint); the patch_equivalence gate instead describes it
            //       richly (which submodule, base vs branch commit, how to resolve).
            // In both cases skip the rebase and continue → patch_equivalence handles it.
            try {
                const preRebasePe = await runMeshRefinePatchEquivalenceGate(repoRoot, baseHead, branchHead);
                const alreadyMerged = !preRebasePe.actualPatchId && !!preRebasePe.expectedPatchId;
                const submoduleConflict = preRebasePe.actionableHint?.kind === 'submodule_conflict';
                if (alreadyMerged) {
                    recordMeshRefineStage(refineStages, 'sync_base', 'passed', syncStarted, {
                        ahead: divergence.ahead,
                        behind: divergence.behind,
                        rebased: false,
                        reason: 'already_merged_via_other_path_skip_rebase',
                    });
                    return { kind: 'continue', ctx };
                }
                if (submoduleConflict) {
                    // DS3: a "submodule conflict" here means base and branch advanced the
                    // SAME submodule to DIVERGED sibling commits (neither an ancestor of the
                    // other), so the gitlink stays in the diff and patch-equivalence fails.
                    // Attempt to auto-converge it (STEP 1): rebase the branch-side submodule
                    // commit onto the base-side commit INSIDE the worktree submodule, so the
                    // base-side commit becomes a strict ancestor of the rebased tip. The root
                    // rebase below (STEP 2) then resolves the gitlink conflict to that rebased
                    // commit. Together this automates the documented manual strict-ff bypass
                    // and keeps the landed oss history linear. On any real submodule content
                    // conflict it backs out cleanly → we FALL BACK to the historical
                    // defer→patch_equivalence path below.
                    // ★Auto-publish decides whether MINTING a submodule commit is legitimate:
                    // with it off a minted commit can never be reachable, so converge declines.
                    const convergeAutoPublish = resolveRefineryAutoPublishSubmoduleMainCommits(ctx.mesh, node.workspace);
                    const converge = convergeDivergedSubmoduleGitlinks(node.workspace, repoRoot, baseHead, branchHead,
                        { allowAutoPublishSubmoduleMainCommits: convergeAutoPublish.enabled });
                    if (converge.converged) {
                        gitlinkResolutions = converge.resolutions;
                        recordMeshRefineStage(refineStages, 'submodule_gitlink_converge', 'passed', syncStarted, {
                            reason: 'submodule_diverged_auto_rebased',
                            gitlinks: converge.gitlinks,
                        });
                        LOG.info('Mesh', `[Refinery] Auto-converged diverged submodule gitlink(s) onto base for node ${node.id}: `
                            + converge.resolutions.map(r => `${r.path}→${r.rebasedCommit.slice(0, 12)}`).join(', '));
                        // ★Loud when a commit was SYNTHESIZED, not merely re-pointed.
                        const minted = describeMintedUnpublishedCommits(node.id, converge.gitlinks, convergeAutoPublish.enabled);
                        if (minted) LOG.warn('Mesh', minted);
                        // Falls through (no return) → the gitlink-aware root rebase below runs.
                    } else {
                        // Fail-safe: declined (conflict / unreachable / publish-required / not a
                        // real divergence) → preserve the historical defer→blocked_review path.
                        recordMeshRefineStage(refineStages, 'submodule_gitlink_converge', 'skipped', syncStarted, {
                            reason: 'submodule_conflict_defer_to_patch_equivalence',
                            convergeReason: converge.reason,
                            gitlinks: converge.gitlinks,
                            // ★Structural next step, so the coordinator is told to PUBLISH
                            // rather than retry the rebase (retrying re-mints the orphan).
                            ...buildSubmoduleConvergeDeclineDetails(converge.reason, convergeAutoPublish.enabled),
                        });
                        // ★Loud for the two reasons that do NOT mean "nothing to converge".
                        const declined = describeSubmoduleConvergeDecline(node.id, converge.reason, converge.gitlinks);
                        if (declined) LOG.warn('Mesh', declined);
                        recordMeshRefineStage(refineStages, 'sync_base', 'passed', syncStarted, {
                            ahead: divergence.ahead,
                            behind: divergence.behind,
                            rebased: false,
                            reason: 'submodule_conflict_defer_to_patch_equivalence',
                        });
                        return { kind: 'continue', ctx };
                    }
                }
            } catch { /* fail-open: on gate error, fall through to the rebase */ }

            // TRIVIAL-FF GITLINK: the diverged path above only fills gitlinkResolutions
            // when base and branch advanced the SAME submodule to NON-ff (sibling) commits.
            // When the changed gitlink is instead a strict fast-forward (base advanced the
            // submodule to an ancestor/descendant of the branch-side commit — the common
            // case when a sibling branch already merged its oss bump), the pre-rebase gate
            // reports NO submodule_conflict, so gitlinkResolutions stays empty and the plain
            // `git rebase baseHead` below runs. That plain rebase still hits the same gitlink
            // and aborts ("Recursive merging with submodules currently only supports trivial
            // cases"), wrongly blocking the branch. So when behind>0 and any changed gitlink
            // remains (and the diverged path did not already resolve them), collect the
            // trivial-ff resolutions and take the gitlink-aware root rebase too. Direction is
            // the same as the diverged rule: resolve to the more-advanced (descendant) commit.
            if (gitlinkResolutions.length === 0) {
                try {
                    const ffResolutions = collectTrivialFastForwardGitlinkResolutions(
                        node.workspace, repoRoot, baseHead, branchHead,
                    );
                    if (ffResolutions.length > 0) {
                        gitlinkResolutions = ffResolutions;
                        recordMeshRefineStage(refineStages, 'submodule_gitlink_converge', 'passed', syncStarted, {
                            reason: 'submodule_trivial_ff_gitlink_aware_rebase',
                            gitlinks: ffResolutions.map(r => ({ path: r.path, rebasedCommit: r.rebasedCommit })),
                        });
                        LOG.info('Mesh', `[Refinery] Trivial fast-forward submodule gitlink(s) for node ${node.id} — using gitlink-aware rebase: `
                            + ffResolutions.map(r => `${r.path}→${r.rebasedCommit.slice(0, 12)}`).join(', '));
                    }
                } catch { /* fail-open: on collection error, fall through to the plain rebase */ }
            }

            // behind>0: strictly-behind OR diverged. Rebase the branch onto the pinned
            // baseHead. A conflict aborts and terminates blocked_review (retryable=false —
            // a real content conflict needs human resolution, not a base-movement retry).
            //
            // The rebase is ALWAYS driven through rootRebaseResolvingGitlinks (STEP 2),
            // which resolves two conflict classes git cannot auto-merge and a human would
            // never hand-merge, then `--continue`s:
            //   - submodule gitlinks converged by STEP 1 ("Recursive merging with
            //     submodules currently only supports trivial cases");
            //   - ★generated vendor bundles, when a sibling branch landed a re-bundle
            //     first (rationale: mesh-refine-generated-bundles.ts). That false-block has
            //     no gitlink divergence at all, so it used to take a plain `git rebase` here
            //     and abort on build output alone.
            // Anything else — a genuine authored conflict included — still aborts and falls
            // through to the blocked_review handling below (via the thrown error), and an
            // empty resolution map leaves the gitlink handling inert.
            const rebaseStarted = Date.now();
            const rebaseExec = { cwd: node.workspace, stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[], timeout: REFINE_GIT_LOCAL_TIMEOUT_MS, windowsHide: true, env: gitChildEnv() }; // ★bounds the SYNCHRONOUS rebase pair (blocks the event loop)
            try {
                const drivenRebase = rootRebaseResolvingGitlinks(node.workspace, baseHead, gitlinkResolutions);
                if (!drivenRebase.ok) {
                    // Surface as a rebase failure so the shared blocked_review handling
                    // (submodule-hint recovery included) runs — the driver already aborted.
                    const err: any = new Error(`gitlink-aware rebase aborted: ${drivenRebase.reason || 'unknown'}`);
                    err.gitlinkRebaseReason = drivenRebase.reason;
                    err.gitlinkRebaseConflicts = drivenRebase.conflictPaths;
                    err.alreadyAborted = true;
                    throw err;
                }
                // Name what was auto-resolved instead of resolving it invisibly.
                if (drivenRebase.resolvedGeneratedBundlePaths?.length) {
                    recordMeshRefineStage(refineStages, 'generated_bundle_conflict_resolved', 'passed', rebaseStarted,
                        buildGeneratedBundleResolutionStageDetail(drivenRebase.resolvedGeneratedBundlePaths));
                }
            } catch (rebaseErr: any) {
                if (!rebaseErr?.alreadyAborted) {
                    try { hiddenExecFileSync('git', ['rebase', '--abort'], { ...rebaseExec, stdio: 'ignore' }); } catch { /* ignore */ }
                }
                // ★REBASE-FAILURE-CLASSIFY: read what git ACTUALLY said before naming the
                // failure. This branch used to hardcode `needs_rebase_with_conflicts` for
                // every rebase failure without inspecting the error, so a rebase that
                // REFUSED TO START ("cannot rebase: You have unstaged changes.") was
                // reported as a content conflict on a branch with no conflict anywhere.
                // See mesh-refine-rebase-failure.ts.
                const rebaseFailure = classifyRefineRebaseFailure(rebaseErr);
                // A rebase conflict on a submodule/gitlink divergence is a SPECIAL case the
                // patch-equivalence gate describes with a rich actionable hint (which
                // submodule, base vs branch commit, how to resolve). Run that gate against
                // the original branchHead to recover the hint; when it IS a submodule
                // conflict, surface the richer patch_equivalence_failed result (preserving
                // the pre-DS2 UX) instead of the generic needs_rebase_with_conflicts.
                let submoduleHintPatchEquivalence: Awaited<ReturnType<typeof runMeshRefinePatchEquivalenceGate>> | undefined;
                try {
                    submoduleHintPatchEquivalence = await runMeshRefinePatchEquivalenceGate(repoRoot, baseHead, ctx.branchHead);
                } catch { /* hint is best-effort */ }
                const submoduleConflict = submoduleHintPatchEquivalence?.actionableHint?.kind === 'submodule_conflict';
                recordMeshRefineStage(refineStages, 'sync_base', 'failed', syncStarted, {
                    ahead: divergence.ahead,
                    behind: divergence.behind,
                    diverged: divergence.diverged,
                    error: rebaseErr?.message || String(rebaseErr),
                    // ★The raw git output, UNTRUNCATED. This stage record is the only
                    // reason the 2026-08-20 false-conflict was diagnosable at all; the
                    // classification below is derived from it, so keeping both means a
                    // future reader can check the derivation rather than trust it.
                    rebaseStderr: rebaseFailure.originalStderr,
                    rebaseFailureCode: rebaseFailure.code,
                    rebaseFailureDetail: rebaseFailure.detail,
                    rebaseConflict: rebaseFailure.conflict,
                    ...(submoduleConflict ? { submoduleConflict: true } : {}),
                });
                if (submoduleConflict && submoduleHintPatchEquivalence) {
                    // Mirror the pre-DS2 patch_equivalence_failed shape (code, hint, stage).
                    recordMeshRefineStage(refineStages, 'patch_equivalence', 'failed', rebaseStarted, {
                        equivalent: submoduleHintPatchEquivalence.equivalent,
                        expectedPatchId: submoduleHintPatchEquivalence.expectedPatchId,
                        actualPatchId: submoduleHintPatchEquivalence.actualPatchId,
                        error: submoduleHintPatchEquivalence.error,
                        actionableHint: submoduleHintPatchEquivalence.actionableHint,
                    });
                    const classification = await classifyAndWarnPatchEquivalenceFailure(node.id, repoRoot, baseHead, ctx.branchHead, submoduleHintPatchEquivalence, {
                        targetBaseRef: baseHead, worktreeRoot: node.workspace,
                        autoPublishSubmoduleMainCommits: resolveRefineryAutoPublishSubmoduleMainCommits(ctx.mesh, node.workspace).enabled,
                    });
                    return { kind: 'terminal', result: {
                        success: false,
                        code: 'patch_equivalence_failed',
                        detailedReason: classification.detailedReason,
                        detailedReasonDescription: classification.detailedReasonDescription,
                        recommendedAction: classification.recommendedAction,
                        evidence: classification.evidence,
                        convergenceStatus: 'blocked_review',
                        error: 'Refinery patch-equivalence preflight failed (submodule gitlink conflict); merge/refine was not attempted.',
                        branch,
                        into: baseBranch,
                        patchEquivalence: submoduleHintPatchEquivalence,
                        refineStages,
                        finalBranchConvergenceState: {
                            branch, baseBranch, merged: false, removed: false, patchEquivalence: 'failed', status: 'blocked_review',
                        },
                    } };
                }
                // Record patch_equivalence_after_auto_rebase failed so the failing-stage
                // classification and the ancestry regression see that a rebase was
                // ATTEMPTED — true even when it refused to start, which is itself the
                // thing a reader needs to know.
                recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', 'failed', rebaseStarted, {
                    error: rebaseErr?.message || String(rebaseErr),
                    rebaseStderr: rebaseFailure.originalStderr,
                    rebaseFailureCode: rebaseFailure.code,
                    rebaseFailureDetail: rebaseFailure.detail,
                    rebaseConflict: rebaseFailure.conflict,
                });
                return { kind: 'terminal', result: {
                    success: false,
                    // ★Only a classification that actually SAW conflict markers may say
                    // "conflicts". Everything else gets a code that describes what
                    // happened (worktree_dirty / rebase_precondition_failed) or admits it
                    // does not know (rebase_failed) — never a confident lie.
                    code: rebaseFailure.code,
                    rebaseFailureDetail: rebaseFailure.detail,
                    rebaseConflict: rebaseFailure.conflict,
                    // ★The original git output on the RESULT, not just the stage record:
                    // the coordinator sees the slim event, and "read the ledger" is not a
                    // reasonable prerequisite for telling a dirty worktree from a conflict.
                    rebaseStderr: rebaseFailure.originalStderr,
                    // A dirty worktree may be transient (stray build output); let the
                    // single automatic retry in finishMeshRefineJob take one more pass at
                    // it. A real conflict stays non-retryable, exactly as before.
                    ...(rebaseFailure.retryable ? { retryable: true } : {}),
                    convergenceStatus: 'blocked_review',
                    error: buildRefineRebaseFailureError(rebaseFailure, {
                        baseBranch,
                        diverged: divergence.diverged,
                        ahead: divergence.ahead,
                        behind: divergence.behind,
                    }),
                    branch,
                    into: baseBranch,
                    refineStages,
                    finalBranchConvergenceState: {
                        branch,
                        baseBranch,
                        merged: false,
                        removed: false,
                        status: 'blocked_review',
                    },
                } };
            }

            // Rebase succeeded — recompute branchHead and re-derive changeImpact against the
            // rebased tree (baseHead..branchHead changed, so the change area may have too).
            const { stdout: rebasedHeadStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: node.workspace, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
            branchHead = rebasedHeadStdout.trim();
            ctx.branchHead = branchHead;
            let changeImpact: ChangedPackageClassification | undefined = ctx.changeImpact;
            try {
                changeImpact = await classifyChangedPackages(node.workspace, baseHead, branchHead);
                ctx.changeImpact = changeImpact;
            } catch { /* fail-open: keep the prior changeImpact (or undefined → full validation) */ }

            recordMeshRefineStage(refineStages, 'sync_base', 'passed', syncStarted, {
                ahead: divergence.ahead,
                behind: divergence.behind,
                diverged: divergence.diverged,
                rebased: true,
                rebasedBranchHead: branchHead,
                ...(changeImpact ? { changeImpact } : {}),
            });
            // Mirror the historical stage name so downstream (batch ancestry regression,
            // failing-stage classification) can observe that a rebase-to-base happened.
            recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', 'passed', rebaseStarted, {
                rebasedBranchHead: branchHead,
                rebasedOnto: baseHead,
            });
            return { kind: 'continue', ctx };
    }

    /**
     * validation stage: run the refinery validation gate (typecheck / test /
     * lint / build per node config) and block on failure or when no allowlisted
     * command was available. On pass, stores the summary on the context.
     */
/**
 * ★C: did this refine run rebase the branch?
 *
 * Reads the recorded `sync_base` stage rather than tracking a parallel flag, so
 * the answer is always exactly what the pipeline did. `recordMeshRefineStage`
 * spreads stage details flat onto the record, so `rebased` is read directly.
 *
 * Deliberately checks only sync_base: the gitlink/bundle conflict resolvers
 * record their own stages, but they run INSIDE the sync_base rebase — counting
 * them separately would report a rebase that never happened when the resolvers
 * merely planned resolutions and the rebase was then skipped.
 */
export function didRefineRebaseBranch(refineStages: Array<Record<string, unknown>>): boolean {
    if (!Array.isArray(refineStages)) return false;
    return refineStages.some(stage => stage?.stage === 'sync_base' && stage?.rebased === true);
}
