/**
 * Refinery mid-pipeline preflight stages — patch_equivalence, submodule_reachability,
 * effective_diff.
 *
 * Pure move out of router-refine.ts to keep that file under the file-size gate; the
 * same three stage functions, in the same order, taking the router instance as `self`.
 * No stage order, gate call, result shape, error message, or `finalBranchConvergenceState`
 * field was changed — only physical location. router-refine.ts re-exports all three, so
 * existing import sites (and their tests) are unaffected.
 *
 * These three share one concern: they run AFTER validation and BEFORE the merge, each
 * consuming the `RefineContext` produced by sync_base and either returning a terminal
 * blocked_review result or continuing with the context extended by its own verdict.
 */
import type { DaemonCommandRouter } from './router.js';
import {
    buildSubmodulePublishRequiredNextStep,
    classifyAndWarnPatchEquivalenceFailure,
    recordMeshRefineStage,
    resolveRefineryAutoPublishSubmoduleMainCommits,
    runMeshRefineEffectiveDiffGate,
    runMeshRefinePatchEquivalenceGate,
    runMeshRefineSubmoduleReachabilityGate,
} from '../mesh/mesh-refine-gates.js';
import type { RefineContext, RefineStageOutcome } from '../mesh/mesh-refine-gates.js';

    /**
     * patch_equivalence stage: preflight that the worktree branch's cumulative patch is
     * equivalent to base+branch. The DS2 sync_base stage already rebased any behind/diverged
     * branch onto the pinned baseHead, so this is now a pure check: equivalent → continue;
     * empty merge-tree with real branch changes → already-merged-via-another-path
     * short-circuit to cleanup; otherwise → patch_equivalence_failed / blocked_review.
     */
export async function refinePatchEquivalenceStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            // DS2: node/execFileAsync are no longer needed here — the rebase moved to
            // sync_base — and branchHead/patchEquivalence are no longer mutated in-stage.
            const { meshId, nodeId, args, repoRoot, baseHead, branch, baseBranch, mesh, node, validationSummary, refineStages } = ctx;
            const branchHead = ctx.branchHead;
            const patchEquivalenceStarted = Date.now();
            const patchEquivalence = await runMeshRefinePatchEquivalenceGate(repoRoot, baseHead, branchHead);
            recordMeshRefineStage(refineStages, 'patch_equivalence', patchEquivalence.status, patchEquivalenceStarted, {
                equivalent: patchEquivalence.equivalent,
                expectedPatchId: patchEquivalence.expectedPatchId,
                actualPatchId: patchEquivalence.actualPatchId,
                error: patchEquivalence.error,
                actionableHint: patchEquivalence.actionableHint,
            });
            if (!patchEquivalence.equivalent) {
                // DS2: the sync_base stage already rebased a behind/diverged branch onto
                // the pinned baseHead BEFORE validation, so by here the branch is either
                // equivalent (handled above) or genuinely non-equivalent for a reason a
                // rebase cannot fix. The old in-stage auto-rebase (ancestor-only) is gone.
                //
                // The one benign non-equivalent case that remains is "already merged via
                // another path": the branch has real changes (expectedPatchId non-empty)
                // but the merge-tree produces no diff against base (actualPatchId empty) —
                // every change is already present in base via a cherry-pick or direct
                // commit. Short-circuit merge → cleanup. If both patch-ids are empty the
                // branch itself has no changes (degenerate), which is NOT already-merged.
                const alreadyMergedViaOtherPath = !patchEquivalence.actualPatchId && !!patchEquivalence.expectedPatchId;
                if (!alreadyMergedViaOtherPath) {
                    const classification = await classifyAndWarnPatchEquivalenceFailure(node.id, repoRoot, baseHead, branchHead, patchEquivalence, {
                        targetBaseRef: baseHead, worktreeRoot: node.workspace,
                        autoPublishSubmoduleMainCommits: resolveRefineryAutoPublishSubmoduleMainCommits(mesh, node.workspace).enabled,
                    });
                    recordMeshRefineStage(refineStages, 'patch_equivalence_classification', 'failed', patchEquivalenceStarted, {
                        detailedReason: classification.detailedReason,
                        recommendedAction: classification.recommendedAction,
                        ...(classification.evidence.submoduleReachabilityUndeterminable ? { submoduleReachabilityUndeterminable: true } : {}),
                    });
                    return { kind: 'terminal', result: {
                        success: false,
                        code: 'patch_equivalence_failed',
                        detailedReason: classification.detailedReason,
                        detailedReasonDescription: classification.detailedReasonDescription,
                        recommendedAction: classification.recommendedAction,
                        evidence: classification.evidence,
                        convergenceStatus: 'blocked_review',
                        error: 'Refinery patch-equivalence preflight failed; merge/refine was not attempted.',
                        branch,
                        into: baseBranch,
                        validationSummary,
                        patchEquivalence,
                        refineStages,
                        finalBranchConvergenceState: {
                            branch,
                            baseBranch,
                            merged: false,
                            removed: false,
                            validation: 'passed',
                            patchEquivalence: 'failed',
                            status: 'blocked_review',
                        },
                    } };
                }

                {
                    // Content already in base — skip merge, go straight to cleanup.
                    recordMeshRefineStage(refineStages, 'merge', 'skipped', Date.now(), {
                        reason: 'already_merged_via_other_path',
                        note: 'actualPatchId is empty; branch content is already present in base via a different commit path',
                    });
                    const cleanupStarted = Date.now();
                    const removeResult = await self.execute('remove_mesh_node', {
                        meshId,
                        nodeId,
                        sessionCleanupMode: 'preserve',
                        inlineMesh: args?.inlineMesh,
                    });
                    recordMeshRefineStage(refineStages, 'cleanup', removeResult?.success === false ? 'failed' : 'passed', cleanupStarted, {
                        removed: removeResult?.removed,
                        code: removeResult?.code,
                        error: removeResult?.error,
                    });
                    try {
                        const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'node_removed',
                            nodeId,
                            payload: { alreadyMergedViaOtherPath: true, branch, into: baseBranch, validationSummary, patchEquivalence },
                        });
                    } catch { /* ledger append is best-effort */ }
                    return { kind: 'terminal', result: {
                        success: removeResult?.success !== false,
                        code: 'already_merged',
                        merged: false,
                        alreadyMergedViaOtherPath: true,
                        branch,
                        into: baseBranch,
                        removeResult,
                        validationSummary,
                        patchEquivalence,
                        refineStages,
                        finalBranchConvergenceState: {
                            branch: baseBranch,
                            mergedBranch: branch,
                            baseBranch,
                            merged: false,
                            alreadyMergedViaOtherPath: true,
                            removed: removeResult?.success !== false,
                            validation: 'passed',
                            patchEquivalence: 'already_merged',
                            status: removeResult?.success === false ? 'merged_cleanup_failed' : 'merged_to_main',
                        },
                    } };
                }
            }

            ctx.branchHead = branchHead;
            ctx.patchEquivalence = patchEquivalence;
            return { kind: 'continue', ctx };
    }

    /**
     * submodule_reachability stage: verify every submodule gitlink commit that
     * would land via the merge is reachable from its configured remote main
     * branch (optionally auto-publishing when policy allows). Blocks the merge
     * when any commit is unreachable. Stores the result on the context.
     */
export async function refineSubmoduleReachabilityStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { mesh, node, repoRoot, branch, baseBranch, branchHead, validationSummary, patchEquivalence, refineStages } = ctx;
            const submoduleReachabilityStarted = Date.now();
            const autoPublishSubmoduleMainCommits = resolveRefineryAutoPublishSubmoduleMainCommits(mesh, node.workspace);
            const submoduleReachability = await runMeshRefineSubmoduleReachabilityGate(repoRoot, patchEquivalence.mergedTree || branchHead, {
                allowAutoPublishSubmoduleMainCommits: autoPublishSubmoduleMainCommits.enabled,
                autoPublishPolicySource: autoPublishSubmoduleMainCommits.source,
                worktreeRoot: node.workspace,
            });
            recordMeshRefineStage(refineStages, 'submodule_reachability', submoduleReachability.status, submoduleReachabilityStarted, {
                checked: submoduleReachability.checked,
                autoPublishAllowed: submoduleReachability.autoPublishAllowed,
                autoPublishPolicySource: submoduleReachability.autoPublishPolicySource,
                autoPublished: submoduleReachability.entries
                    .filter(entry => entry.autoPublishAttempted)
                    .map(entry => ({
                        path: entry.path,
                        commit: entry.commit,
                        remote: entry.remote,
                        remoteUrl: entry.remoteUrl,
                        remoteMainBranch: entry.remoteMainBranch,
                        refspec: entry.autoPublishRefspec,
                        succeeded: entry.autoPublishSucceeded,
                        verified: entry.autoPublishVerified,
                        remoteMainReachable: entry.remoteMainReachable,
                        error: entry.error,
                    })),
                autoPublishSkipped: submoduleReachability.entries
                    .filter(entry => entry.autoPublishAllowed === true && entry.autoPublishAttempted !== true)
                    .map(entry => ({
                        path: entry.path,
                        commit: entry.commit,
                        remote: entry.remote,
                        remoteUrl: entry.remoteUrl,
                        remoteMainBranch: entry.remoteMainBranch,
                        reason: entry.autoPublishSkippedReason || entry.error || 'auto-publish was allowed but no publish attempt was possible',
                    })),
                unreachable: submoduleReachability.unreachable.map(entry => ({
                    path: entry.path,
                    commit: entry.commit,
                    equivalentPublishedCommit: entry.equivalentPublishedCommit,
                    publishRequired: entry.publishRequired === true,
                    autoPublishAllowed: entry.autoPublishAllowed,
                    autoPublishAttempted: entry.autoPublishAttempted,
                    autoPublishSucceeded: entry.autoPublishSucceeded,
                        autoPublishVerified: entry.autoPublishVerified,
                        autoPublishRefspec: entry.autoPublishRefspec,
                        autoPublishSkippedReason: entry.autoPublishSkippedReason,
                        remote: entry.remote,
                    remoteUrl: entry.remoteUrl,
                    remoteReachable: entry.remoteReachable,
                    remoteMainBranch: entry.remoteMainBranch,
                    remoteMainReachable: entry.remoteMainReachable,
                    error: entry.error,
                })),
                error: submoduleReachability.error,
            });
            if (submoduleReachability.status === 'failed') {
                const nextStep = buildSubmodulePublishRequiredNextStep(submoduleReachability.unreachable);
                // Gap #2: when EVERY unreachable gitlink has an already-published
                // equivalent (identical tree) on the submodule remote main, the
                // blockage is not "publish needed" but "converge to the published
                // twin" — surface that distinct reason and guidance.
                const convergeToPublished = submoduleReachability.unreachable.length > 0
                    && submoduleReachability.unreachable.every(entry => !!entry.equivalentPublishedCommit);
                const blockedReason = convergeToPublished ? 'submodule_converge_to_published' : 'submodule_publish_required';
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'submodule_reachability_failed',
                    convergenceStatus: 'blocked_review',
                    publishRequired: !convergeToPublished,
                    ...(convergeToPublished ? { convergeToPublished: true } : {}),
                    blockedReason,
                    error: convergeToPublished
                        ? 'Refinery submodule reachability preflight found submodule gitlink commit(s) that are not reachable from their configured remote main branch, but each has an equivalent commit (identical tree) already published there; converge the gitlink(s) to the published commit(s) instead of publishing same-content twins. Merge/refine cleanup was not attempted.'
                        : 'Refinery submodule reachability preflight failed because one or more submodule gitlink commits are not reachable from their configured remote main branch; merge/refine cleanup was not attempted.',
                    nextStep,
                    nextSteps: convergeToPublished ? [
                        'Do NOT publish the local submodule commit(s): an equivalent commit (identical tree) is already published on the submodule remote main branch for every unreachable gitlink.',
                        'Retarget each submodule gitlink to the already-published equivalent commit shown in the evidence (equivalentPublishedCommit), commit the root pointer update, and push the submodule checkout to that commit.',
                        'Rerun mesh_refine_node after the gitlink points at the published commit.',
                        'Do not merge the root branch until every submodule gitlink commit is reachable from submodule origin/main.',
                    ] : [
                        'Ask the user for explicit approval before pushing or publishing any submodule commit.',
                        'Push/publish each unreachable submodule commit to the configured submodule remote main branch shown in the evidence.',
                        'Rerun mesh_refine_node after remote reachability is confirmed.',
                        'Do not merge the root branch until every submodule gitlink commit is reachable from submodule origin/main.',
                    ],
                    unreachableSubmoduleCommits: submoduleReachability.unreachable.map(entry => ({
                        path: entry.path,
                        commit: entry.commit,
                        equivalentPublishedCommit: entry.equivalentPublishedCommit,
                        remote: entry.remote,
                        remoteUrl: entry.remoteUrl,
                        remoteReachable: entry.remoteReachable,
                        remoteMainBranch: entry.remoteMainBranch,
                        remoteMainReachable: entry.remoteMainReachable,
                        autoPublishAllowed: entry.autoPublishAllowed,
                        autoPublishAttempted: entry.autoPublishAttempted,
                        autoPublishSucceeded: entry.autoPublishSucceeded,
                        autoPublishVerified: entry.autoPublishVerified,
                        autoPublishRefspec: entry.autoPublishRefspec,
                        autoPublishSkippedReason: entry.autoPublishSkippedReason,
                        error: entry.error,
                    })),
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'passed',
                patchEquivalence: 'passed',
                submoduleReachability: 'failed',
                status: 'blocked_review',
                reason: blockedReason,
                nextStep,
                    },
                } };
            }

            ctx.submoduleReachability = submoduleReachability;
            return { kind: 'continue', ctx };
    }

    /**
     * effective_diff stage (no-op guard): block a silent no-op merge where the
     * branch produces no effective root-tree diff against base — typically a
     * submodule that has commits but whose root-level gitlink (pointer) bump was
     * never committed, so the merge would land nothing real on main.
     */
export async function refineEffectiveDiffStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { repoRoot, baseHead, branchHead, branch, baseBranch, validationSummary, patchEquivalence, refineStages } = ctx;
            // No-op guard: block a silent no-op merge where the root tree is identical to base.
            // This catches the trap where a submodule has commits but the root branch never
            // committed the gitlink (oss-pointer) bump — merging would report success while the
            // real change never lands on main. A committed gitlink bump shows up in the root
            // diff, so legitimate oss-pointer refines pass through untouched.
            const effectiveDiffStarted = Date.now();
            const effectiveDiff = await runMeshRefineEffectiveDiffGate(repoRoot, baseHead, branchHead);
            recordMeshRefineStage(refineStages, 'effective_diff', effectiveDiff.status, effectiveDiffStarted, {
                hasEffectiveDiff: effectiveDiff.hasEffectiveDiff,
                changedPaths: effectiveDiff.changedPaths,
                submoduleHints: effectiveDiff.submoduleHints,
                ...(effectiveDiff.error ? { error: effectiveDiff.error } : {}),
            });
            if (effectiveDiff.status === 'failed' && !effectiveDiff.hasEffectiveDiff) {
                const hintLines = (effectiveDiff.submoduleHints || []).map(h => `  - ${h.path}: ${h.reason}`);
                const message = [
                    `Refinery no-op guard: branch '${branch}' has no effective root-tree diff against '${baseBranch}' (${baseHead.slice(0, 12)}); nothing would merge.`,
                    'This usually means a submodule (e.g. oss) has commits but the root branch never committed the gitlink (pointer) bump, so the merge would be a silent no-op while the real change never reaches main.',
                    hintLines.length ? `Submodules with uncommitted pointer bumps:\n${hintLines.join('\n')}` : '',
                    `Fix: commit the submodule pointer bump on '${branch}' (git add <submodule-path> && git commit), then re-run refine.`,
                ].filter(Boolean).join('\n');
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'no_effective_diff',
                    convergenceStatus: 'blocked_review',
                    error: message,
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    effectiveDiff,
                    refineStages,
                    finalBranchConvergenceState: {
                        branch,
                        baseBranch,
                        merged: false,
                        removed: false,
                        validation: 'passed',
                        patchEquivalence: 'passed',
                        effectiveDiff: 'no_effective_diff',
                        status: 'blocked_review',
                        reason: 'no_effective_diff',
                        ...(effectiveDiff.submoduleHints?.length ? { submoduleHints: effectiveDiff.submoduleHints } : {}),
                    },
                } };
            }

            return { kind: 'continue', ctx };
    }
