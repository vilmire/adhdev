/**
 * Refinery merge + finalize stage — the locked merge into base, submodule alignment,
 * worktree cleanup, optional push, and the coordinator-local catch-up request that
 * follows a landed merge. Split out of router-refine.ts, which keeps the pipeline
 * driver and the earlier stages.
 */
import type { DaemonCommandRouter } from './router.js';
import { RefineContext, RefineStageOutcome, recordMeshRefineStage, truncateValidationOutput, alignRefinerySubmodulesAfterMerge } from '../mesh/mesh-refine-gates.js';
import { daemonIdListIncludes, resolveCoordinatorSelfIds } from '../mesh/mesh-reconcile-identity.js';
import { readStringValue } from '../mesh/mesh-node-identity.js';
import { fastForwardMeshNode } from '../mesh/mesh-fast-forward.js';
import { notifyMeshCoordinator } from '../mesh/mesh-events.js';
import { buildRefineJobKey } from './router-refine-jobs.js';
import { probeRefineBaseCas, describeRefineBaseCasStage, buildRefineBaseCasBlockedResult } from '../mesh/mesh-refine-base-cas.js';
import { gitChildEnv } from '../git/git-locale.js';
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';

/**
 * DS3: after a successful Refinery push advanced origin/<baseBranch>, bring the
 * ORIGINATING COORDINATOR daemon's own local base checkout up to the pushed commit so
 * the coordinator isn't silently left behind (the "merged to main but my local main is
 * stale" gap). Guarded and NON-destructive:
 *
 *   - If the coordinator's base node is hosted by THIS daemon and is reachable locally,
 *     run fastForwardMeshNode(mode:'merge') on it directly. That helper is itself the
 *     guard: it only ff-only-merges when the workspace is clean, ahead=0 and behind>0;
 *     an ahead/diverged/dirty coordinator returns a structured block (never a rebase).
 *   - If the coordinator is a DIFFERENT daemon (remote), we cannot touch its checkout
 *     from here, so we queue a `coordinator_catchup` pending event targeted at that
 *     coordinator daemon; its reconcile loop / next mesh-tool call drains it and runs the
 *     same guarded fast-forward locally (busy → naturally deferred to the next idle edge).
 *
 * Best-effort and advisory: the caller never fails the refine on a catch-up problem. The
 * refine's own repoRoot IS the base it just merged+pushed, so when the coordinator IS this
 * daemon and IS repoRoot the ff is a no-op `already_up_to_date` — correct and harmless.
 * Returns a compact summary for the stage record, or undefined when there's nothing to do.
 */
export async function requestCoordinatorLocalCatchup(
    self: DaemonCommandRouter,
    params: { meshId: string; ctx: RefineContext; mesh: any; baseBranch: string; repoRoot: string },
): Promise<Record<string, unknown> | undefined> {
    const { meshId, ctx, mesh, baseBranch, repoRoot } = params;
    // Originating coordinator daemon id: explicit arg wins, else this daemon's own id.
    const coordinatorDaemonId = (typeof ctx.args?.coordinatorDaemonId === 'string' && ctx.args.coordinatorDaemonId.trim())
        ? ctx.args.coordinatorDaemonId.trim()
        : (self.deps.statusInstanceId || undefined);
    if (!coordinatorDaemonId) return undefined;
    if (!Array.isArray(mesh?.nodes)) return undefined;

    // The coordinator's base checkout is the non-worktree node owned by the coordinator
    // daemon. Prefer an exact daemon-id match; the coordinator is a base (non-worktree) node.
    const coordinatorBaseNode = mesh.nodes.find((n: any) =>
        !n?.isLocalWorktree && daemonIdListIncludes([coordinatorDaemonId], readStringValue(n?.daemonId)));
    if (!coordinatorBaseNode) return undefined;
    const coordinatorWorkspace = readStringValue(coordinatorBaseNode.repoRoot) || readStringValue(coordinatorBaseNode.workspace);
    if (!coordinatorWorkspace) return undefined;

    // Is the coordinator base node hosted by THIS daemon? Resolve this daemon's self ids
    // for the mesh (status id + machineId forms + config-form node ids) and check the node.
    const drainIds = [self.deps.statusInstanceId].filter((v): v is string => typeof v === 'string' && v.length > 0);
    const selfIds = resolveCoordinatorSelfIds(mesh as any, drainIds);
    const coordinatorIsSelf = daemonIdListIncludes(selfIds, readStringValue(coordinatorBaseNode.daemonId));

    if (coordinatorIsSelf) {
        // Run the guarded ff-only catch-up directly on the local coordinator base checkout.
        // fastForwardMeshNode gates on clean/ahead=0/behind>0 internally and never rebases.
        try {
            const ff = await fastForwardMeshNode({
                meshId,
                nodeId: readStringValue(coordinatorBaseNode.id),
                workspace: coordinatorWorkspace,
                branch: baseBranch,
                mode: 'merge',
                execute: true,
                trigger: 'refine_post_push_catchup',
                allowAutoPublishSubmoduleMainCommits: mesh?.policy?.allowAutoPublishSubmoduleMainCommits === true,
            });
            return {
                mode: 'local_fast_forward',
                coordinatorWorkspace,
                sameAsRepoRoot: coordinatorWorkspace === repoRoot,
                code: ff.code,
                executed: ff.executed,
                success: ff.success,
                ...(ff.blockingReasons?.length ? { blockingReasons: ff.blockingReasons } : {}),
            };
        } catch (e: any) {
            return { mode: 'local_fast_forward', coordinatorWorkspace, error: e?.message || String(e) };
        }
    }

    // Remote coordinator: queue a targeted pending marker for its reconcile loop / next
    // mesh-tool call to pick up and fast-forward locally (guarded, deferrable when busy).
    try {
        notifyMeshCoordinator({
            event: 'coordinator_catchup',
            meshId,
            nodeLabel: readStringValue(coordinatorBaseNode.id) || 'coordinator-base',
            nodeId: readStringValue(coordinatorBaseNode.id),
            workspace: coordinatorWorkspace,
            metadataEvent: {
                source: 'refine_post_push_coordinator_catchup',
                operation: 'coordinator_catchup',
                baseBranch,
                coordinatorDaemonId,
                reason: 'post_push_base_advanced',
            },
            queuedAt: Date.now(),
            targetCoordinatorDaemonId: coordinatorDaemonId,
        });
        return { mode: 'pending_marker_queued', coordinatorDaemonId, coordinatorWorkspace, baseBranch };
    } catch (e: any) {
        return { mode: 'pending_marker_queued', coordinatorDaemonId, error: e?.message || String(e) };
    }
}

    /**
     * merge + finalize stage: perform the --no-ff merge, align submodule
     * checkouts after merge, clean up (remove) the worktree node per policy,
     * append the refinery ledger entry, and (unless approval is required) push the
     * base branch. Always terminal — produces the final CommandRouterResult.
     */
export async function refineMergeAndFinalizeStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { meshId, nodeId, repoRoot, branch, baseBranch, validationSummary, patchEquivalence, submoduleReachability, refineStages } = ctx;

            // DS2: acquire the repoRoot+baseBranch refinement lease for the base-mutating
            // window (CAS → merge → push → cleanup). Serializes overlapping single-node
            // async refines targeting the same base so they cannot both validate against one
            // baseHead and then race their merges. The batch path is already sequential, so
            // this only contends across independent async jobs. If another refine holds it,
            // terminate retryable (base_locked) — the coordinator/batch retries after it
            // frees. Released in the finally below. Note the pipeline-level lease (acquired
            // in executeMeshRefineNodeSynchronously right after resolve_refs) already covers
            // this window; this stage-level acquire is the fallback for direct stage callers
            // and is re-entrant for the same holder.
            const leaseKey = `${repoRoot}::${baseBranch}`;
            const leaseHolder = buildRefineJobKey(self, meshId, nodeId);
            // Re-entrant: executeMeshRefineNodeSynchronously already holds this lease
            // for the whole pipeline (DS2 widened) — a same-holder arrival just runs
            // the locked core without re-acquiring (and must NOT release it here).
            const alreadyHeld = self.refineBaseLeases.get(leaseKey) === leaseHolder;
            if (!alreadyHeld && self.refineBaseLeases.has(leaseKey)) {
                recordMeshRefineStage(refineStages, 'base_lease', 'skipped', Date.now(), {
                    leaseKey, heldBy: self.refineBaseLeases.get(leaseKey), retryable: true,
                });
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'base_locked',
                    convergenceStatus: 'blocked_review',
                    retryable: true,
                    error: `Another refine holds the base lease for ${baseBranch} in this repo; retry after it completes.`,
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    refineStages,
                    finalBranchConvergenceState: {
                        branch, baseBranch, merged: false, removed: false, status: 'blocked_review',
                    },
                } };
            }
            if (!alreadyHeld) self.refineBaseLeases.set(leaseKey, leaseHolder);
            try {
                return await runRefineMergeAndFinalizeLocked(self, ctx);
            } finally {
                if (!alreadyHeld && self.refineBaseLeases.get(leaseKey) === leaseHolder) self.refineBaseLeases.delete(leaseKey);
            }
    }

    /**
     * DS2 CAS + DS1 order: the base-lease-protected core of merge/finalize. Before the
     * merge it re-fetches origin/<baseBranch> and compare-and-swaps the live origin SHA
     * against the pinned baseHead from resolve_refs; if the base moved, it terminates
     * retryable (base_moved) WITHOUT merging so a re-run rebases onto and validates the
     * new base. DS1: on the auto-push path the order is merge → push → cleanup, so a push
     * failure leaves the worktree/branch intact (cleanup withheld) and is reported as a
     * terminal blocked state — the batch never counts an un-pushed node as merged.
     */
export async function runRefineMergeAndFinalizeLocked(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { meshId, nodeId, args, repoRoot, baseHead, node, branch, baseBranch, sourceNode, validationSummary, patchEquivalence, submoduleReachability, mesh, refineStages, execFileAsync } = ctx;

            // DS2 base-movement CAS: re-fetch origin/<baseBranch> and compare its live
            // SHA against the baseHead pinned in resolve_refs. If it advanced (a peer
            // pushed while this node validated), the merge would be onto a stale base —
            // bail retryable so the re-run rebases onto and re-validates the NEW base.
            //
            // ★TRI-STATE and fail-CLOSED; see ./mesh/mesh-refine-base-cas.ts for why an
            // unobtained verdict must not read as "unmoved". This is the only
            // guard before the merge/push, and it also checks repoRoot's LOCAL base.
            const casStarted = Date.now();
            const cas = await probeRefineBaseCas({
                execFileAsync, repoRoot, baseBranch, pinnedBaseHead: baseHead, branchHead: ctx.branchHead, env: gitChildEnv(),
            });
            const casStage = describeRefineBaseCasStage(cas, baseHead);
            recordMeshRefineStage(refineStages, 'base_cas', casStage.status, casStarted, casStage.detail);
            // 'moved' and 'undeterminable' both refuse BEFORE the merge. 'no_origin' and
            // 'unmoved' fall through and converge.
            if (cas.state === 'undeterminable' || cas.state === 'moved') {
                return { kind: 'terminal', result: buildRefineBaseCasBlockedResult({
                    cas, baseBranch, branch, pinnedBaseHead: baseHead,
                    validationSummary, patchEquivalence, submoduleReachability, refineStages,
                }) };
            }

            let mergeResult: Record<string, unknown> | undefined;
            const mergeStarted = Date.now();
            try {
                const result = await execFileAsync('git', ['merge', '--no-ff', branch, '-m', `Auto-merge branch '${branch}' via Refinery`], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
                mergeResult = {
                    stdout: truncateValidationOutput(result.stdout),
                    stderr: truncateValidationOutput(result.stderr),
                    durationMs: Date.now() - mergeStarted,
                };
                recordMeshRefineStage(refineStages, 'merge', 'passed', mergeStarted, mergeResult);
            } catch (e: any) {
                // QW4: a `git merge` conflict is a distinct, structured terminal state —
                // stamp a stable code='merge_failed' (batch keys not_mergeable off it) and
                // surface the conflicting paths so a coordinator can classify + report
                // without abort-and-reparse. git writes "CONFLICT (...): Merge conflict in
                // <path>" to stdout; abort the half-applied merge so the base workspace is
                // left clean for the next sibling in a batch.
                const mergeOutput = `${e?.stdout || ''}\n${e?.stderr || ''}`;
                const conflictPaths = [...mergeOutput.matchAll(/Merge conflict in (.+)/g)]
                    .map(m => m[1].trim())
                    .filter(Boolean);
                try {
                    await execFileAsync('git', ['merge', '--abort'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv() });
                } catch { /* nothing to abort (e.g. merge never started) — best-effort */ }
                recordMeshRefineStage(refineStages, 'merge', 'failed', mergeStarted, {
                    error: e?.message || String(e),
                    stdout: truncateValidationOutput(e?.stdout),
                    stderr: truncateValidationOutput(e?.stderr),
                    ...(conflictPaths.length ? { conflictPaths } : {}),
                });
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'merge_failed',
                    convergenceStatus: 'not_mergeable',
                    error: conflictPaths.length
                        ? `Merge failed — conflicts in ${conflictPaths.length} path(s): ${conflictPaths.join(', ')}. The branch cannot fast-forward-merge onto ${baseBranch}; resolve conflicts (rebase the branch onto the fetched base) and retry.`
                        : `Merge failed (conflicts?): ${e?.message || String(e)}`,
                    branch,
                    into: baseBranch,
                    ...(conflictPaths.length ? { conflictPaths } : {}),
                    validationSummary,
                    patchEquivalence,
                    mergeResult: {
                        stdout: truncateValidationOutput(e?.stdout),
                        stderr: truncateValidationOutput(e?.stderr),
                    },
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'passed',
                patchEquivalence: 'passed',
                status: 'not_mergeable',
                    },
                } };
            }

            const submoduleAlignmentStarted = Date.now();
            const submoduleAlignment = await alignRefinerySubmodulesAfterMerge(repoRoot, baseHead, 'HEAD', {
                submoduleIgnorePaths: Array.isArray(sourceNode?.policy?.submoduleIgnorePaths)
                    ? sourceNode.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
                    : undefined,
            });
            if (submoduleAlignment.status !== 'skipped') {
                recordMeshRefineStage(refineStages, 'submodule_alignment', submoduleAlignment.status, submoduleAlignmentStarted, {
                    changedGitlinkPaths: submoduleAlignment.changedGitlinkPaths,
                    outOfSyncPaths: submoduleAlignment.outOfSyncPaths,
                    updatedPaths: submoduleAlignment.updatedPaths,
                    verifiedPaths: submoduleAlignment.verifiedPaths,
                    command: submoduleAlignment.command,
                    error: submoduleAlignment.error,
                });
            }
            if (submoduleAlignment.status === 'failed') {
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'post_merge_submodule_alignment_failed',
                    error: 'Refinery merge completed but post-merge submodule checkout alignment failed; run the reported git submodule update command and re-check base workspace status.',
                    merged: true,
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    submoduleAlignment,
                    mergeResult,
                    refineStages,
                    finalBranchConvergenceState: {
                branch: baseBranch,
                mergedBranch: branch,
                baseBranch,
                merged: true,
                removed: false,
                validation: 'passed',
                patchEquivalence: 'passed',
                submoduleReachability: 'passed',
                submoduleAlignment: 'failed',
                status: 'post_merge_alignment_failed',
                nextStep: submoduleAlignment.command || 'Run git submodule update --init --recursive for the reported path(s), then re-check base workspace status.',
                    },
                } };
            }

            // ── DS1: push BEFORE cleanup ──────────────────────────────────────────
            // The merge has landed on the local base. The contract is "success ⇒ the
            // change is on origin (or, for the approval path, on local base awaiting an
            // approved push)". So push (or defer for approval) FIRST, and only run the
            // destructive worktree/branch cleanup once the push is proven — a push failure
            // must leave the worktree + branch ref intact so a retry can re-push without
            // reconstructing anything, and the batch must NOT count the node as merged.
            const requireApprovalForPush: boolean = (mesh as any)?.policy?.requireApprovalForPush ?? DEFAULT_MESH_POLICY.requireApprovalForPush;

            let pushResult: Record<string, unknown> | undefined;
            if (!requireApprovalForPush) {
                const pushStarted = Date.now();
                try {
                    // `timeout` mirrors the async sibling call sites in `mesh-fast-forward.ts`:
                    // an unreachable remote must surface as a push FAILURE (which the catch
                    // below already reports) rather than an await that never settles.
                    await execFileAsync('git', ['push', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: gitChildEnv(), timeout: 30_000 });
                    pushResult = { pushed: true, remote: 'origin', branch: baseBranch, durationMs: Date.now() - pushStarted };
                    recordMeshRefineStage(refineStages, 'push', 'passed', pushStarted, pushResult);
                } catch (e: any) {
                    pushResult = {
                        pushed: false,
                        remote: 'origin',
                        branch: baseBranch,
                        error: e?.message || String(e),
                        stderr: e?.stderr,
                        durationMs: Date.now() - pushStarted,
                    };
                    recordMeshRefineStage(refineStages, 'push', 'failed', pushStarted, pushResult);
                    // DS1: push failed AFTER a good merge. Do NOT clean up — leave the
                    // worktree + branch ref intact so the coordinator can retry the push.
                    // Terminal blocked (retryable); the batch counts this as NOT merged.
                    // The local base HAS the merge commit, so a bare `git push origin
                    // <base>` from repoRoot converges it; the branch ref is preserved as a
                    // safety net.
                    return { kind: 'terminal', result: {
                        success: false,
                        code: 'push_failed',
                        convergenceStatus: 'blocked_review',
                        retryable: true,
                        merged: true,
                        mergedLocal: true,
                        pushed: false,
                        error: `Refinery merged '${branch}' into local ${baseBranch} but the push to origin failed; the worktree and branch ref were preserved (NOT cleaned up) so the push can be retried. Run: git -C ${repoRoot} push origin ${baseBranch}`,
                        branch,
                        into: baseBranch,
                        pushResult,
                        pushCommand: `git push origin ${baseBranch}`,
                        validationSummary,
                        patchEquivalence,
                        submoduleReachability,
                        submoduleAlignment,
                        mergeResult,
                        refineStages,
                        finalBranchConvergenceState: {
                            branch: baseBranch,
                            mergedBranch: branch,
                            baseBranch,
                            merged: true,
                            pushed: false,
                            removed: false,
                            validation: 'passed',
                            patchEquivalence: 'passed',
                            submoduleAlignment: submoduleAlignment.status,
                            status: 'merged_push_failed',
                            nextStep: `Retry the push (git -C ${repoRoot} push origin ${baseBranch}); then the worktree can be cleaned up.`,
                        },
                    } };
                }
            } else {
                // DS1 approval path: the merge is on local base but must NOT be pushed
                // without approval, and cleanup is WITHHELD until the push is approved and
                // proven to reach origin (removing the worktree now would drop the branch
                // ref before the push is authorized). Distinct convergence state so the
                // batch/coordinator treats it as "landed locally, remote pending" — never
                // as remote-converged.
                recordMeshRefineStage(refineStages, 'push', 'skipped', Date.now(), {
                    reason: 'require_approval_for_push',
                });
                return { kind: 'terminal', result: {
                    success: true,
                    merged: true,
                    mergedLocal: true,
                    pushed: false,
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    submoduleAlignment,
                    mergeResult,
                    refineStages,
                    pushReady: true,
                    pushCommand: `git push origin ${baseBranch}`,
                    pushNote: 'requireApprovalForPush is enabled — the merge landed on the local base but was NOT pushed and the worktree was NOT cleaned up. Run the push (or approve it), then re-run refine/cleanup to remove the worktree.',
                    finalBranchConvergenceState: {
                        branch: baseBranch,
                        mergedBranch: branch,
                        baseBranch,
                        merged: true,
                        pushed: false,
                        removed: false,
                        validation: 'passed',
                        patchEquivalence: 'passed',
                        submoduleAlignment: submoduleAlignment.status,
                        status: 'merged_local_pending_push',
                        nextStep: `Approve and run the push (git -C ${repoRoot} push origin ${baseBranch}); the worktree is retained until then.`,
                    },
                } };
            }

            // ── Push succeeded (auto-push path) → now run cleanup ─────────────────
            const cleanupStarted = Date.now();
            // Honor the mesh policy for delegated-session cleanup on the auto-removed
            // worktree node (previously hardcoded to 'preserve', which orphaned the
            // delegate session as an idle record on the coordinator daemon).
            //
            // REFINE-CLEANUP-DEFAULT: pass sessionCleanupMode ONLY when the policy sets
            // it explicitly, and OMIT the key otherwise — mirroring mcp-server's
            // buildRemoveNodeArgs. Always computing the mode meant an unset policy
            // resolved to DEFAULT_MESH_POLICY's 'preserve', which is a *string* and so
            // won the `??` chain in remove_mesh_node, suppressing the worktree default
            // ('stop_and_delete'). The delegate session then stayed alive and held a
            // lock on the worktree directory, so the whole cleanup failed — while a
            // manual mesh_remove_node (which omits the key) succeeded on the identical
            // code path. Omitting restores that default; an explicitly configured
            // policy (including an explicit 'preserve') is still honored verbatim.
            const explicitRefineSessionCleanupPolicy = mesh?.policy?.sessionCleanupOnNodeRemove;
            const refineSessionCleanupMode = explicitRefineSessionCleanupPolicy
                ? self.normalizeMeshSessionCleanupMode(explicitRefineSessionCleanupPolicy)
                : undefined;
            // The delegate session launched for a clone worktree is frequently matched
            // by workspace ONLY (no meta.meshNodeId binding), which remove_mesh_node's
            // shared-daemon guard skips. Since refine knows exactly which workspace it
            // just merged, collect that workspace's live session ids explicitly and pass
            // them through — explicit sessionIds bypass the workspace-only-match guard so
            // the policy-driven stop/delete actually runs. An omitted mode resolves to
            // the worktree default 'stop_and_delete' downstream, so collect the ids in
            // that case too — only an explicit 'preserve' skips the sweep.
            let refineSessionIds: string[] | undefined;
            if (refineSessionCleanupMode !== 'preserve' && self.deps.sessionHostControl) {
                try {
                    const liveSessions = await self.deps.sessionHostControl.listSessions();
                    const workspace = typeof node.workspace === 'string' ? node.workspace : '';
                    refineSessionIds = liveSessions
                        .filter((record: any) => {
                            const sid = typeof record?.sessionId === 'string' ? record.sessionId : '';
                            if (!sid) return false;
                            // Never sweep the coordinator's own session for this mesh.
                            if (readStringValue(record?.meta?.meshCoordinatorFor) === meshId) return false;
                            const boundToNode = readStringValue(record?.meta?.meshNodeId) === nodeId;
                            const matchedByWorkspace = !!workspace && record?.workspace === workspace;
                            return boundToNode || matchedByWorkspace;
                        })
                        .map((record: any) => String(record.sessionId));
                } catch {
                    // listSessions failure is non-fatal — fall back to the policy-mode
                    // cleanup without explicit ids (still better than hardcoded preserve).
                    refineSessionIds = undefined;
                }
            }
            const removeResult = await self.execute('remove_mesh_node', {
                meshId,
                nodeId,
                ...(refineSessionCleanupMode ? { sessionCleanupMode: refineSessionCleanupMode } : {}),
                ...(refineSessionIds && refineSessionIds.length > 0 ? { sessionIds: refineSessionIds } : {}),
                inlineMesh: args?.inlineMesh,
                // REFINE-CLEANUP: refine reaches cleanup only AFTER a verified merge AND a
                // successful push (DS1), so any residual worktree dirtiness here is
                // incidental (e.g. a bootstrap lockfile rewrite) — never unmerged work.
                // `force` sets requireClean=false so a plain-dirty worktree no longer aborts
                // removal with merged_cleanup_failed. Branch-ref deletion still keys off
                // mergeConvergence (NOT the force flag), so no merged work can be lost.
                force: true,
            });
            recordMeshRefineStage(refineStages, 'cleanup', removeResult?.success === false ? 'failed' : 'passed', cleanupStarted, {
                removed: removeResult?.removed,
                code: removeResult?.code,
                error: removeResult?.error,
            });

            let ledgerError: string | undefined;
            const ledgerStarted = Date.now();
            try {
                const { meshRecord } = await import('../mesh/mesh-record.js');
                meshRecord(meshId, 'node_removed', {
                    nodeId,
                    payload: { refined: true, mergedBranch: branch, into: baseBranch, pushed: true, validationSummary, patchEquivalence, submoduleReachability, submoduleAlignment },
                }, { local: true });
                recordMeshRefineStage(refineStages, 'ledger', 'passed', ledgerStarted);
            } catch (e: any) {
                ledgerError = e?.message || String(e);
                recordMeshRefineStage(refineStages, 'ledger', 'failed', ledgerStarted, { error: ledgerError });
            }

            const finalBranchConvergenceState = {
                branch: baseBranch,
                mergedBranch: branch,
                baseBranch,
                merged: true,
                pushed: true,
                removed: removeResult?.success !== false,
                validation: 'passed',
                patchEquivalence: 'passed',
                submoduleAlignment: submoduleAlignment.status,
                status: removeResult?.success === false ? 'merged_cleanup_failed' : 'merged_pushed',
            };

            if (removeResult?.success === false) {
                // Push already succeeded — the change IS on origin; only the local worktree
                // cleanup failed. Report cleanup_failed but note remote convergence is done.
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'cleanup_failed',
                    error: 'Refinery merge + push completed but worktree cleanup failed; the change is on origin — manual worktree cleanup/retry is required.',
                    merged: true,
                    pushed: true,
                    branch,
                    into: baseBranch,
                    removeResult,
                    pushResult,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    submoduleAlignment,
                    mergeResult,
                    refineStages,
                    ...(ledgerError ? { ledgerError } : {}),
                    finalBranchConvergenceState,
                } };
            }

            // DS3: the push advanced origin/<baseBranch>. Request a guarded catch-up so the
            // originating coordinator daemon's own local base checkout fast-forwards to the
            // pushed commit (never auto-rebase; a diverged coordinator gets a structured
            // blocker instead). Best-effort — a catch-up failure never fails the refine.
            let coordinatorCatchup: Record<string, unknown> | undefined;
            try {
                coordinatorCatchup = await requestCoordinatorLocalCatchup(self, {
                    meshId, ctx, mesh, baseBranch, repoRoot,
                });
                if (coordinatorCatchup) {
                    recordMeshRefineStage(refineStages, 'coordinator_catchup', 'passed', Date.now(), coordinatorCatchup);
                }
            } catch { /* catch-up is advisory; never gate refine success on it */ }

            // QW5: promote the worktree-cleanup warnings from inside removeResult to the
            // top level so a coordinator sees them without descending into removeResult:
            //   branchRefWarning — the feature branch ref was preserved (not merged-proof),
            //   residueWarning   — the worktree dir couldn't be fully removed,
            //   branchRefDeleted — whether the branch ref was deleted (from the nested
            //                      worktreeCleanup record).
            // All are best-effort/non-gating; refine still reports success:true.
            const cleanupBranchRefWarning = typeof (removeResult as any)?.branchRefWarning === 'string'
                ? (removeResult as any).branchRefWarning : undefined;
            const cleanupResidueWarning = typeof (removeResult as any)?.residueWarning === 'string'
                ? (removeResult as any).residueWarning : undefined;
            const cleanupBranchRefDeleted = typeof (removeResult as any)?.worktreeCleanup?.branchRefDeleted === 'boolean'
                ? (removeResult as any).worktreeCleanup.branchRefDeleted : undefined;

            return { kind: 'terminal', result: {
                success: true,
                merged: true,
                pushed: true,
                branch,
                into: baseBranch,
                removeResult,
                pushResult,
                ...(coordinatorCatchup ? { coordinatorCatchup } : {}),
                ...(cleanupBranchRefWarning ? { branchRefWarning: cleanupBranchRefWarning } : {}),
                ...(cleanupResidueWarning ? { residueWarning: cleanupResidueWarning } : {}),
                ...(cleanupBranchRefDeleted !== undefined ? { branchRefDeleted: cleanupBranchRefDeleted } : {}),
                validationSummary,
                patchEquivalence,
                submoduleReachability,
                submoduleAlignment,
                mergeResult,
                refineStages,
                ...(ledgerError ? { ledgerError } : {}),
                finalBranchConvergenceState,
            } };
    }
