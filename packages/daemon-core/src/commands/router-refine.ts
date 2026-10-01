/**
 * Refinery job orchestration — extracted from router.ts (behavior-preserving code move).
 *
 * These functions were `DaemonCommandRouter` methods; they now take the router
 * instance as `self`. The class keeps thin delegating wrappers for the entry
 * points referenced elsewhere (startMeshRefineJob / batchRefineMeshNodes /
 * startMeshRefineBatchJob bound into MedFamilyContext; resumePendingRefineJobsOnStartup
 * called by the daemon boot lifecycle). No stage order, event, log string, error
 * message, or result shape was changed — only physical location + `this.` → `self.`.
 */
import { execFileSync } from 'node:child_process';
import type { DaemonCommandRouter, CommandRouterResult } from './router.js';
import { LOG } from '../logging/logger.js';
import { createInteractionId } from '../logging/debug-trace.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { assessRefineBaseDivergence } from '../mesh/mesh-refine-base-divergence.js';
// ★B1: slow-gate progress notification (threshold + throttle live in the module).
import { emitRefineProgress, isSlowRefineGate, type RefineProgressContext } from '../mesh/mesh-refine-progress.js';
// ★REFINE-ACCEPT-BASE-PREFLIGHT — see mesh-refine-accept-preflight.ts for the
// four-incident RCA this comes from.
import {
    assessRefineAcceptPreflight,
    buildRefineAcceptPreflightRefusal,
} from '../mesh/mesh-refine-accept-preflight.js';
// DURABLE-DUPLICATE-DISPATCH / WORKTREE-VANISHED-MIDFLIGHT (mesh-refine-inflight.ts).
import { findOpenLedgerRefineDispatch, refineWorktreeVanishedOutcome } from '../mesh/mesh-refine-inflight.js';
import { decideRefineTerminalWriteFromLedger } from '../mesh/mesh-refine-terminal-guard.js';
// GHOST-FAILURE terminal classification (mesh-refine-landing.ts).
import { classifyRefineTerminal, refineTerminalNextStep, buildRefineBlockerContext } from '../mesh/mesh-refine-landing.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { gitChildEnv, GIT_LOCAL_TIMEOUT_MS as REFINE_GIT_LOCAL_TIMEOUT_MS } from '../git/git-locale.js';
import { readStringValue } from '../mesh/mesh-node-identity.js';
import {
    MeshRefineJobHandle,
    MeshRefineTerminalJob,
    RefineContext,
    RefineStageOutcome,
    recordMeshRefineStage,
    runMeshRefineValidationGate,
} from '../mesh/mesh-refine-gates.js';
// DS2 base-movement CAS probe — tri-state, fail-closed on an unobtained verdict.
// REFINE-CONCURRENCY-CAP: process-wide serial execution of refine pipelines —
// see mesh-refine-concurrency.ts for the freeze RCA this comes from.
import { runWithRefineExecutionSlot } from '../mesh/mesh-refine-concurrency.js';
import {
    buildRefineJobKey,
    buildRefineJobHandle,
    extractValidationFailureDiagnostics,
    queueRefineJobEvent,
    appendRefineJobLedger,
} from './router-refine-jobs.js';

    /**
     * Synchronous refinery for a single worktree node — the gate pipeline that
     * validates, preflights (patch-equivalence / submodule-reachability /
     * no-op), merges, aligns submodules, cleans up the worktree node and
     * (optionally) pushes. The body is a flat sequence of stage methods; each
     * stage either returns a terminal CommandRouterResult (gate failure or a
     * successful already-merged short-circuit) or `continue` with the extended
     * context. Behavior — stage order, every early-exit, and every result shape —
     * is identical to the previous single inlined body.
     */
export async function executeMeshRefineNodeSynchronously(self: DaemonCommandRouter, meshId: string, nodeId: string, args: any): Promise<CommandRouterResult> {
        const refineStages: Array<Record<string, unknown>> = [];
        try {
            const resolved = await refineResolveRefsStage(self, meshId, nodeId, args, refineStages);
            if (resolved.kind === 'terminal') return resolved.result;
            const ctx = resolved.ctx;
            // ★B1: thread the caller's progress channel onto the context so the stages can
            // announce slow gates. Carried on `args` (which already flows through every
            // entry point) rather than as a new parameter, so the many existing callers of
            // this function — batch loop, resume path, tests — need no signature change.
            // Absent → ctx.progress stays undefined → no events, exactly as before.
            if (args?.progressContext) ctx.progress = args.progressContext as RefineProgressContext;

            // DS2 (widened): acquire the repoRoot+baseBranch refinement lease for the
            // WHOLE pipeline, not just the merge window. Previously the lease covered
            // only merge/finalize, so a sibling job could move the base while this job
            // was still in sync_base/validation/patch_equivalence/submodule_reachability
            // — the second job then validated against a base that no longer existed and
            // died with a ghost needs_rebase_with_conflicts. A contender now terminates
            // retryable (base_locked) up front and the coordinator retries after the
            // holder frees. The merge stage re-checks the same holder re-entrantly.
            const leaseKey = `${ctx.repoRoot}::${ctx.baseBranch}`;
            const leaseHolder = buildRefineJobKey(self, meshId, nodeId);
            if (self.refineBaseLeases.has(leaseKey) && self.refineBaseLeases.get(leaseKey) !== leaseHolder) {
                recordMeshRefineStage(refineStages, 'base_lease', 'skipped', Date.now(), {
                    leaseKey, heldBy: self.refineBaseLeases.get(leaseKey), retryable: true,
                });
                return {
                    success: false,
                    code: 'base_locked',
                    convergenceStatus: 'blocked_review',
                    retryable: true,
                    error: `Another refine holds the base lease for ${ctx.baseBranch} in this repo; retry after it completes.`,
                    branch: ctx.branch,
                    into: ctx.baseBranch,
                    refineStages,
                    finalBranchConvergenceState: {
                        branch: ctx.branch, baseBranch: ctx.baseBranch, merged: false, removed: false, status: 'blocked_review',
                    },
                };
            }
            self.refineBaseLeases.set(leaseKey, leaseHolder);
            try {
            // ★REFINE-BASE-PREFLIGHT: the FIRST thing the pipeline does, before sync_base
            // and before any of the ~35 validation gates.
            //
            // Every gate runs against the branch worktree, so a base that cannot receive a
            // merge stays invisible until the merge stage — which is how a dirty base cost
            // a 3-node batch 3 x 35 gates before failing with merge_failed (2026-09-22).
            //
            // ★It runs HERE and not on the accept path. The accept path is capped at
            // sub-250ms and node-count independent (IPC-ACCEPT-ASYNC-BOUNDARY, enforced by
            // 'returns before long validation completes...' in mesh-refine-validation.test.ts);
            // this probe measured ~55ms locally and blew that budget under concurrent load.
            // Running it as the pipeline's first stage keeps the entire saving — the
            // expensive thing avoided is the GATE RUN, not the accept — while leaving the
            // accept contract untouched.
            const basePreflight = await refineBasePreflightStage(self, ctx);
            if (basePreflight.kind === 'terminal') return basePreflight.result;

            // DS2: sync_base runs BEFORE validation. A branch that is behind base — whether
            // strictly behind (fast-forwardable) or DIVERGED (ahead>0 AND behind>0, the
            // laggard the old ancestor-only rebase missed) — is auto-rebased onto the pinned
            // baseHead here, so validation and every later gate see the FINAL rebased tree.
            const syncBase = await refineSyncBaseStage(self, ctx);
            if (syncBase.kind === 'terminal') return syncBase.result;

            // WORKTREE-VANISHED-MIDFLIGHT: re-check between stages, not only at
            // resolve_refs. The resolve_refs check is a point-in-time snapshot, and the
            // stages below run for MINUTES (typecheck/test/build). A sibling job that
            // merges and cleans up in that window pulls the directory out from under this
            // one, and whichever stage happens to be running then reports the tear-down as
            // its own failure — which is exactly why the observed duplicate dispatches
            // failed with *different* codes (validation_failed / dependency_bootstrap_failed)
            // purely as a function of timing. Naming the real cause here keeps a spurious
            // failure from reading like a genuine one.
            const afterSyncBase = refineWorktreeVanishedOutcome(ctx, 'validation');
            if (afterSyncBase) return afterSyncBase.result;

            const validation = await refineValidationStage(self, ctx);
            if (validation.kind === 'terminal') return validation.result;

            const afterValidation = refineWorktreeVanishedOutcome(ctx, 'patch_equivalence');
            if (afterValidation) return afterValidation.result;

            const patchEquivalence = await refinePatchEquivalenceStage(self, ctx);
            if (patchEquivalence.kind === 'terminal') return patchEquivalence.result;

            const submoduleReachability = await refineSubmoduleReachabilityStage(self, ctx);
            if (submoduleReachability.kind === 'terminal') return submoduleReachability.result;

            const effectiveDiff = await refineEffectiveDiffStage(self, ctx);
            if (effectiveDiff.kind === 'terminal') return effectiveDiff.result;

            // WORKTREE-VANISHED-MIDFLIGHT: last check before the only stage that MUTATES
            // the base. Merging from a worktree that has already been torn down (because a
            // sibling job merged this very branch and cleaned up) is the one case where a
            // spurious failure could do more than mislead.
            const beforeMerge = refineWorktreeVanishedOutcome(ctx, 'merge');
            if (beforeMerge) return beforeMerge.result;

            const merge = await refineMergeAndFinalizeStage(self, ctx);
            return (merge as { kind: 'terminal'; result: CommandRouterResult }).result;
            } finally {
                if (self.refineBaseLeases.get(leaseKey) === leaseHolder) self.refineBaseLeases.delete(leaseKey);
            }
        } catch (e: any) {
            return { success: false, error: e.message, refineStages };
        }
    }

export async function refineValidationStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { mesh, node, branch, baseBranch, refineStages } = ctx;
            const validationStarted = Date.now();
            const validationSummary = await runMeshRefineValidationGate(mesh, node.workspace, {
                // (a) Scope the validation command set by coarse change-impact (resolved
                // in resolve_refs). Undefined → gate runs the full command set (fail-open).
                changeImpact: ctx.changeImpact,
                // BASE-REF-CONFIG-FALLBACK: a worktree cut before .adhdev/refine.json landed on
                // base (and whose rebase was skipped, e.g. already-merged / submodule paths)
                // still validates with the base branch's config instead of validation_unavailable.
                configBaseRefs: [ctx.baseHead, ctx.baseBranch ? `origin/${ctx.baseBranch}` : '', ctx.baseBranch].filter(Boolean),
                // M2-2: consume the node's persisted bootstrap state; persist re-runs.
                persistedBootstrapState: (node as any).worktreeBootstrap as WorktreeBootstrapState | undefined,
                onBootstrapStateChange: (state) => {
                    (node as any).worktreeBootstrap = state;
                    void import('../config/mesh-config.js')
                        .then(({ updateNode }) => updateNode(mesh.id, node.id, { worktreeBootstrap: state } as any))
                        .catch(() => { /* persistence is best-effort */ });
                },
                // ★C: did sync_base rebase this branch? Read from the recorded stage rather
                // than a separate flag, so the answer can never disagree with what the
                // pipeline actually did. A vendor-drift failure means something different
                // when the Refinery itself moved the bundle build base.
                branchWasRebased: didRefineRebaseBranch(refineStages),
                // ★B1: announce only the gates that actually cost time. The threshold and
                // the throttle live in mesh-refine-progress.ts; this stage just reports.
                onCommandComplete: ctx.progress
                    ? (info) => {
                        if (!isSlowRefineGate(info.durationMs)) return;
                        emitRefineProgress(ctx.progress!, {
                            phase: 'slow_gate',
                            nodeId: node.id,
                            gate: info.displayCommand,
                            durationMs: info.durationMs,
                        });
                    }
                    : undefined,
            });
            ctx.validationSummary = validationSummary;
            recordMeshRefineStage(
                refineStages,
                'validation',
                validationSummary.status === 'passed' ? 'passed' : validationSummary.status === 'failed' ? 'failed' : 'skipped',
                validationStarted,
                { validationStatus: validationSummary.status, commandsRun: validationSummary.commandsRun.length },
            );
            if (validationSummary.status === 'failed') {
                // QW1: command records carry `passed` (boolean), NOT `success`. The old
                // `c.success === false` predicate never matched any entry, so the first
                // failing command's name/output was always dropped from the error. The
                // failing command is the one with passed===false (skipped-but-passed=true
                // entries never fail the gate, so passed===false uniquely identifies it).
                const firstFailedCmd = Array.isArray(validationSummary.commandsRun)
                    ? (validationSummary.commandsRun as Array<Record<string, unknown>>).find(c => c.passed === false)
                    : undefined;
                const buildValidationFailedError = (): string => {
                    const base = validationSummary.failureCode === 'missing_dependencies'
                        ? 'Refinery validation dependencies are missing for a change-affected package; merge/refine was not attempted. '
                            + 'To make this self-service, either (1) configure .adhdev/worktree_bootstrap.json (or validation.bootstrapCommands in .adhdev/refine.json) so Refinery installs deps before validation, '
                            + 'or (2) converge the branch via the documented manual fast-forward-only bypass (rebase onto the fetched base, verify strict ancestry, then push ff-only) instead of the refine gate.'
                        : validationSummary.failureCode === 'dependency_bootstrap_failed'
                            ? 'Refinery dependency/bootstrap command failed; merge/refine was not attempted.'
                            : validationSummary.failureCode === 'spawn_resolution_failed'
                                ? (validationSummary.spawnResolutionError
                                    || 'Refinery validation command could not be spawned (executable not found); merge/refine was not attempted.')
                                : validationSummary.failureCode === 'output_limit_exceeded'
                                    ? 'Refinery validation command exceeded the output buffer and was KILLED mid-run, so its own exit status is unknown — the tests may well have been passing. '
                                        + 'This is an output-VOLUME problem, not a missing dependency and not a real test failure. '
                                        + 'Fix by reducing what the command prints (quiet the noisiest logs at their source, or pick a less verbose reporter), '
                                        + 'or raise outputLimitBytes for that command in .adhdev/refine.json.'
                                    : 'Refinery validation gate failed; merge/refine was not attempted.';
                    if (!firstFailedCmd) return base;
                    const cmdName = typeof firstFailedCmd.displayCommand === 'string' ? firstFailedCmd.displayCommand
                        : typeof firstFailedCmd.command === 'string'
                            ? [firstFailedCmd.command, ...(Array.isArray(firstFailedCmd.args) ? firstFailedCmd.args : [])].join(' ').trim()
                            : typeof firstFailedCmd.cmd === 'string' ? firstFailedCmd.cmd : '';
                    const rawOutput = [firstFailedCmd.stdout, firstFailedCmd.stderr, firstFailedCmd.output]
                        .filter(s => typeof s === 'string' && s.length > 0)
                        .join('\n');
                    const tail = rawOutput.length > 800 ? rawOutput.slice(-800) : rawOutput;
                    return [
                        base,
                        cmdName ? `First failing command: ${cmdName}` : '',
                        // ★C: lead the tail with the rebase explanation when the Refinery's own
                        // rebase invalidated the vendor bundles. Without it this failure reads
                        // as an opaque bundle diff (2026-09-22, incident 4).
                        validationSummary.vendorDriftHint ? `★ ${validationSummary.vendorDriftHint}` : '',
                        tail ? `Output (tail):\n${tail}` : '',
                    ].filter(Boolean).join('\n');
                };
                return { kind: 'terminal', result: {
                    success: false,
                    code: validationSummary.failureCode || 'validation_failed',
                    convergenceStatus: 'blocked_review',
                    error: buildValidationFailedError(),
                    branch,
                    into: baseBranch,
                    validationSummary,
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'failed',
                status: 'blocked_review',
                    },
                } };
            }
            if (validationSummary.status === 'skipped') {
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'validation_unavailable',
                    convergenceStatus: 'blocked_review',
                    error: 'Refinery validation gate is required but no allowlisted validation command was available; merge/refine was not attempted.',
                    branch,
                    into: baseBranch,
                    validationSummary,
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'unavailable',
                status: 'blocked_review',
                    },
                } };
            }

            return { kind: 'continue', ctx };
    }
import {
    refinePatchEquivalenceStage,
    refineSubmoduleReachabilityStage,
    refineEffectiveDiffStage,
} from './router-refine-preflight-stages.js';
import { refineResolveRefsStage, refineSyncBaseStage, didRefineRebaseBranch } from './router-refine-sync-stages.js';
import { refineMergeAndFinalizeStage } from './router-refine-merge.js';

/**
 * `skipped_chain_abort` is NOT a classifier output — `classifyBatchNodeConvergence`
 * can never produce it, because it describes a node that was never RUN. Only the
 * batch loop assigns it, when an earlier node's base-axis failure made the
 * remaining nodes' outcomes foregone (mesh-refine-batch-chain-abort.ts).
 */
export type BatchNodeConvergence = 'merged_to_main' | 'blocked_review' | 'skipped_patch_equivalent' | 'not_mergeable' | 'skipped_chain_abort';

/**
 * QW4: classify one node's per-node refine result into a batch convergence bucket.
 * Pure (a function of the result shape alone) so the not_mergeable-vs-blocked_review
 * decision is unit-testable without the whole async refine pipeline.
 *
 *   already_merged (+ alreadyMergedViaOtherPath) → skipped_patch_equivalent (non-error).
 *   success                                       → merged_to_main.
 *   merge_failed code OR the failing stage IS 'merge' → not_mergeable. A real `git merge`
 *     conflict is a distinct, structured state; classifying on the STAGE as well as the
 *     code means a merge conflict is never mislabeled blocked_review even if the code
 *     were ever dropped. (A rebase conflict fails at patch_equivalence_after_auto_rebase,
 *     NOT merge, so it correctly stays blocked_review.)
 *   everything else that failed                   → blocked_review.
 *
 * DS2: `retryable` is set for a base-movement family blocker (base_moved / base_locked /
 * base_cas_undeterminable) — the node did NOT converge because the base advanced, was
 * locked, or COULD NOT BE READ while it ran, not because of its own content. The batch
 * gives ONLY these a second pass (they may succeed once the base settles / the lease
 * frees / origin is reachable again); a real conflict is never retried.
 *
 * ★`base_cas_undeterminable` is retryable because nothing was merged: the CAS refuses
 * BEFORE `git merge`, so a retry costs one fetch. A transient failure is exactly what a
 * second pass fixes; a persistent one re-lands on the same fail-closed refusal.
 */
const RETRYABLE_BASE_MOVEMENT_CODES = new Set(['base_moved', 'base_locked', 'base_cas_undeterminable']);

export function classifyBatchNodeConvergence(result: Record<string, unknown>): { convergence: BatchNodeConvergence; code: string; stage?: string; retryable: boolean } {
    const code = typeof result.code === 'string' ? result.code : '';
    // The last failed refine stage (undefined on success). Computed BEFORE the
    // classification so it can back-stop the code-based verdict.
    const stage = Array.isArray(result.refineStages)
        ? (result.refineStages as Array<Record<string, unknown>>).filter(s => s.status === 'failed').map(s => s.stage).filter(Boolean).pop() as string | undefined
        : undefined;
    let convergence: BatchNodeConvergence;
    if (code === 'already_merged' && result.alreadyMergedViaOtherPath) {
        convergence = 'skipped_patch_equivalent';
    } else if (result.success === true) {
        convergence = 'merged_to_main';
    } else if (code === 'merge_failed' || stage === 'merge') {
        convergence = 'not_mergeable';
    } else {
        convergence = 'blocked_review';
    }
    // Retryable only for a base-movement blocker that left the node blocked_review — a
    // not_mergeable conflict is never retried.
    const retryable = convergence === 'blocked_review'
        && (result.retryable === true || RETRYABLE_BASE_MOVEMENT_CODES.has(code));
    return { convergence, code, retryable, ...(stage ? { stage } : {}) };
}

/**
 * ③ Decide whether a finished single-node refine attempt earns the ONE automatic
 * retry. Pure, so the bound is unit-testable without driving the whole pipeline.
 *
 * Delegates the retryable judgement to `classifyBatchNodeConvergence` — the exact
 * classifier the batch path's retryQueue uses — so the single-node and batch paths
 * cannot drift apart on what "retryable" means. Only the base-movement family
 * (base_moved / base_locked / base_cas_undeterminable) qualifies; a real conflict never
 * does.
 *
 * `alreadyRetried` is the bound: a result that already carries the retry marker is
 * terminal no matter what it failed with. This is what makes the retry exactly-once
 * rather than a loop that could starve a node while the base keeps moving.
 */
export function shouldAutoRetryRefine(result: Record<string, unknown>): { retry: boolean; code: string } {
    const alreadyRetried = result.refineRetried === true;
    const { retryable, code } = classifyBatchNodeConvergence(result);
    return { retry: retryable && !alreadyRetried, code };
}

/**
 * ③ Run the refine pipeline once, capturing a thrown error as a failure result.
 * Shared by the first attempt and the single automatic retry below.
 */
async function runRefinePipelineOnce(
    self: DaemonCommandRouter,
    meshId: string,
    nodeId: string,
    args: any,
): Promise<Record<string, unknown>> {
    try {
        return await executeMeshRefineNodeSynchronously(self, meshId, nodeId, args) as Record<string, unknown>;
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
}

export async function finishMeshRefineJob(self: DaemonCommandRouter, handle: MeshRefineJobHandle, args: any): Promise<void> {
        const key = buildRefineJobKey(self, handle.meshId, handle.targetNodeId);
        // ★B1: a single-node refine is also minutes of silence, and its slow gates are the
        // same ones. The channel carries the job's own return address so progress routes
        // exactly like its terminal event.
        const progressContext: RefineProgressContext = {
            meshId: handle.meshId,
            jobId: handle.jobId,
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
            coordinatorSessionId: handle.targetCoordinatorSessionId,
        };
        const argsWithProgress = { ...args, progressContext };
        let result = await runRefinePipelineOnce(self, handle.meshId, handle.targetNodeId, argsWithProgress);

        // ③ Single automatic retry for a base-movement blocker (base_moved / base_locked).
        //
        // The batch path has had this second pass since DS2 (runMeshRefineBatchConvergence's
        // retryQueue); the single-node async path had NO automatic retry at all, so a
        // coordinator received task_failed for a blocker that is transient by construction:
        // the node did not converge because a PEER advanced the base or held the lease while
        // it ran, not because of anything about its own content. That is exactly the failure
        // a re-run fixes, and it is what forced four manual rebases in a single day.
        //
        // Retryability is decided by the SAME classifier the batch uses
        // (classifyBatchNodeConvergence), so the two paths cannot drift: a real conflict is
        // never retried, only the base-movement family. The batch path itself is untouched.
        //
        // No new recovery logic is needed on the retry — the full pipeline re-runs, so
        // refineSyncBaseStage re-fetches and auto-rebases onto the NEW base (aborting to
        // blocked_review on a real conflict), the validation gate re-runs the repo's
        // configured commands (which is where this repo's vendor-drift check lives, so a
        // rebase that invalidated the vendor bundle is caught), and patch-equivalence
        // re-verifies against the new base.
        //
        // Bounded to exactly ONE retry, matching the batch. There is deliberately no loop
        // and no re-queue: a base that keeps moving must surface to a human rather than
        // starve the node in an unbounded retry cycle.
        const firstAttempt = shouldAutoRetryRefine(result);
        if (firstAttempt.retry) {
            LOG.info('Mesh', `[Refinery] Base-movement blocker (${firstAttempt.code}) for node ${handle.targetNodeId}`
                + ` (jobId=${handle.jobId}); retrying once automatically.`);
            result = await runRefinePipelineOnce(self, handle.meshId, handle.targetNodeId, argsWithProgress);
            // Whatever this attempt produced is terminal — success, a different failure, or
            // the same base-movement blocker. It is NOT retried again.
            result = { ...result, refineRetried: true, refineRetryOfCode: firstAttempt.code };
        }

        const completedAt = new Date().toISOString();

        // B1 + GHOST-FAILURE: discriminated terminal status. `converged` answers "did
        // the change land on origin?" (decides the completed-vs-failed NOTIFICATION);
        // `clean` answers "is there nothing left to do?" (decides blockerContext).
        // See classifyRefineTerminal for why these must stay two separate questions.
        const refineCode = typeof result.code === 'string' ? result.code : '';
        const { kind: refineTerminalKind, landing, isPostMergeWarning, converged: isTerminalConverged, clean: isTerminalClean } =
            classifyRefineTerminal(result);

        // Structured blocker context for task_failed ledger entries so coordinators can
        // inspect the failure cause without parsing free-form error strings. The body is
        // a pure move to mesh-refine-landing.ts (file-size gate) — same inputs, same
        // shape; it lives next to classifyRefineTerminal, whose terminalKind it branches on.
        const blockerContext = buildRefineBlockerContext(result, {
            terminalKind: refineTerminalKind,
            isTerminalClean,
            extractValidationDiagnostics: extractValidationFailureDiagnostics,
        });

        const normalizedResult = {
            ...result,
            terminalKind: refineTerminalKind,
            ...(blockerContext ? { blockerContext } : {}),
            ...(result.nextStep === undefined && !isTerminalClean
                ? { nextStep: refineTerminalNextStep(refineTerminalKind) } : {}),
            // GHOST-FAILURE: explicit machine-readable landing verdict, present on EVERY
            // terminal result (plain failures read merged:false) so a coordinator never
            // has to run `git log` to tell whether the work landed.
            refineLanding: {
                merged: landing.merged,
                pushed: landing.pushed,
                converged: isTerminalConverged,
            },
            ...(isPostMergeWarning ? {
                postMergeWarning: `Merge landed and was pushed to origin/${typeof result.into === 'string' ? result.into : 'base'}, but a post-merge step failed (${refineCode || 'unknown'}). This node is CONVERGED — do not re-refine it.`,
            } : {}),
        };

        const terminalHandle = buildRefineJobHandle(self, {
            meshId: handle.meshId,
            nodeId: handle.targetNodeId,
            status: isTerminalConverged ? 'completed' : 'failed',
            startedAt: handle.startedAt,
            completedAt,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            retryOfJobId: handle.retryOfJobId,
            node: { daemonId: handle.targetDaemonId, workspace: handle.workspace },
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
            // REFINE-EVENT-SESSION-SCOPED-UNICAST: carry the requester's session from the
            // accepted handle onto the TERMINAL handle. Dropping it here would leave the
            // completed/failed event — the one the coordinator actually waits on — back at
            // daemon-level addressing, i.e. the original defect.
            coordinatorSessionId: handle.targetCoordinatorSessionId,
        });
        const terminal: MeshRefineTerminalJob = { ...terminalHandle, result: normalizedResult };
        const terminalKind: 'task_completed' | 'task_failed' = isTerminalConverged ? 'task_completed' : 'task_failed';

        // ★REFINE-TERMINAL-ONCE: refuse a SECOND terminal row for this jobId. A restart
        // mid-refine re-dispatches the same jobId into a fresh process while the original
        // still runs it — two executions, two terminal writes (2/2 on 2026-08-20). The
        // precedence rule is NOT "first write wins" (the ghost wrote first); see
        // mesh-refine-terminal-guard.ts.
        const terminalDecision = await decideRefineTerminalWriteFromLedger({
            meshId: handle.meshId,
            nodeId: handle.targetNodeId,
            jobId: handle.jobId,
            kind: terminalKind,
            interactionId: handle.interactionId,
            completedAt,
            onReadError: (m) => LOG.warn('Mesh', `[Refinery] ${m}`),
        });

        if (!terminalDecision.allow) {
            // ★NEVER SILENT: the refusal names both execution identities and which won —
            // the most diagnostic evidence this failure mode produces. Local bookkeeping
            // still settles (leaving the job in runningRefineJobs would make the node look
            // permanently busy); terminalRefineJobs is NOT overwritten, so the winner stays.
            LOG.warn('Mesh', `[Refinery] ${terminalDecision.note}`);
            self.runningRefineJobs.delete(key);
            self.invalidateAggregateMeshStatus(handle.meshId);
            return;
        }

        self.terminalRefineJobs.set(key, terminal);
        self.runningRefineJobs.delete(key);
        self.invalidateAggregateMeshStatus(handle.meshId);
        if (terminalDecision.supersedes) {
            LOG.warn('Mesh', `[Refinery] ${terminalDecision.note}`);
        }
        // GHOST-FAILURE: ledger kind and coordinator event key off CONVERGENCE, not
        // cleanliness — a merge that reached origin is task_completed even when a
        // trailing local step failed. The unclean detail still rides on normalizedResult
        // (terminalKind / blockerContext / postMergeWarning / nextStep), so nothing is lost.
        await appendRefineJobLedger(self, terminalKind, terminalHandle, normalizedResult);
        queueRefineJobEvent(self, isTerminalConverged ? 'refine:completed' : 'refine:failed', terminalHandle, normalizedResult);
    }

/**
 * ⓪ Run the accept-time base-divergence pre-check and record its verdict on the
 * live job handle (and the running-jobs map entry, which is the same object).
 *
 * Signal-only by design: with no serialization queue yet there is nowhere to park a
 * diverged job, so the honest behaviour is to record and let the job proceed exactly
 * as it does today — the pipeline's own sync_base stage still rebases it. A later
 * queue reads `handle.baseDivergence` to decide what may run in parallel.
 *
 * Never throws and never blocks: it runs detached from the accept path, and any
 * failure leaves the handle without a verdict rather than disturbing the job.
 */
export async function recordRefineAcceptBaseDivergence(
    self: DaemonCommandRouter,
    handle: MeshRefineJobHandle,
    node: any,
): Promise<void> {
    try {
        const mesh = (await self.getMeshForCommand(handle.meshId, undefined, { preferInline: true }))?.mesh;
        const sourceNode = node?.clonedFromNodeId
            ? mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, node.clonedFromNodeId))
            : mesh?.nodes?.find((n: any) => !n.isLocalWorktree);
        const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
        const workspace = readStringValue(node?.workspace);
        if (!repoRoot || !workspace) return;

        const branch = typeof node?.worktreeBranch === 'string' && node.worktreeBranch.trim()
            ? node.worktreeBranch.trim()
            : (() => {
                try {
                    return execFileSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8', timeout: REFINE_GIT_LOCAL_TIMEOUT_MS, windowsHide: true, env: gitChildEnv() }).trim();
                } catch { return ''; }
            })();
        if (!branch) return;

        const baseBranch = (() => {
            try {
                return execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8', timeout: REFINE_GIT_LOCAL_TIMEOUT_MS, windowsHide: true, env: gitChildEnv() }).trim() || 'main';
            } catch { return 'main'; }
        })();

        const assessment = await assessRefineBaseDivergence({ repoRoot, workspace, baseBranch, branch });
        handle.baseDivergence = {
            verdict: assessment.verdict,
            scopes: assessment.scopes,
            touchedSubmodulePaths: assessment.touchedSubmodulePaths,
            durationMs: assessment.durationMs,
        };
        LOG.debug('Mesh', `[Refinery] accept base-divergence pre-check for node ${handle.targetNodeId}`
            + ` (jobId=${handle.jobId}): verdict=${assessment.verdict}`
            + ` touchedSubmodules=[${assessment.touchedSubmodulePaths.join(', ')}]`
            + ` in ${assessment.durationMs}ms`);
    } catch {
        // Signal-only: a failed pre-check must never disturb the refine job itself.
    }
}

/**
 * ★REFINE-BASE-PREFLIGHT stage — the pipeline's first stage, before sync_base and
 * before every validation gate.
 *
 * Terminates the refine when the BASE checkout cannot receive a merge, so the
 * ~35-gate run is never spent on an outcome that is already determined. This is
 * where the saving actually lives: what the four 2026-09-22 incidents cost was
 * the gate runs, not the accept.
 *
 * ★Why a stage and not an accept-path check. Accept is contractually sub-250ms
 * and node-count independent (IPC-ACCEPT-ASYNC-BOUNDARY); this probe measured
 * ~55ms and exceeded that budget under concurrent load, failing the regression
 * test that guards the contract. Nothing is lost by moving it here — the gates
 * still have not run — and the accept path stays exactly as fast as before.
 *
 * Fails open on every uncertainty (base unresolvable, git unreadable): the
 * downstream base_cas stage and the merge itself enforce the same conditions, so
 * an indeterminate verdict restores exactly today's behaviour rather than
 * inventing a new way for refine to be unavailable.
 */
export async function refineBasePreflightStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
    const startedAt = Date.now();
    let verdict: Awaited<ReturnType<typeof assessRefineAcceptPreflight>>;
    try {
        verdict = await assessRefineAcceptPreflight({ repoRoot: ctx.repoRoot });
    } catch (e: any) {
        recordMeshRefineStage(ctx.refineStages, 'base_preflight', 'skipped', startedAt, {
            reason: 'probe_failed', error: e?.message || String(e),
        });
        return { kind: 'continue', ctx };
    }

    if (verdict.ok) {
        recordMeshRefineStage(ctx.refineStages, 'base_preflight',
            verdict.indeterminate ? 'skipped' : 'passed', startedAt,
            verdict.indeterminate ? { reason: 'base_not_inspectable' } : { repoRoot: ctx.repoRoot });
        return { kind: 'continue', ctx };
    }

    recordMeshRefineStage(ctx.refineStages, 'base_preflight', 'failed', startedAt, {
        code: verdict.code,
        repoRoot: ctx.repoRoot,
        findings: verdict.findings,
        retryable: true,
    });
    LOG.warn('Mesh', `[Refinery] Base preflight blocked node ${ctx.nodeId} before any gate ran`
        + ` — base ${ctx.repoRoot} is not mergeable (${verdict.code}), checked in ${verdict.durationMs}ms.`);
    return {
        kind: 'terminal',
        result: {
            ...buildRefineAcceptPreflightRefusal({ verdict, meshId: ctx.meshId, nodeId: ctx.nodeId }),
            branch: ctx.branch,
            into: ctx.baseBranch,
            refineStages: ctx.refineStages,
            finalBranchConvergenceState: {
                branch: ctx.branch, baseBranch: ctx.baseBranch, merged: false, removed: false, status: 'blocked_review',
            },
        } as CommandRouterResult,
    };
}

export async function startMeshRefineJob(self: DaemonCommandRouter, meshId: string, nodeId: string, args: any): Promise<CommandRouterResult> {
        const key = buildRefineJobKey(self, meshId, nodeId);
        const terminal = self.terminalRefineJobs.get(key);

        // CONCURRENT-FIRE: reserve the slot with a placeholder SYNCHRONOUSLY, before the
        // first `await` below. Two `startMeshRefineJob` calls for the same meshId:nodeId
        // can land back-to-back (observed ~1ms apart): the OLD code checked
        // `runningRefineJobs.get(key)` and only set it after `await
        // getMeshForCommand(...)`, so both calls could pass the check and both proceed —
        // the second one racing a cleanup (remove_mesh_node) that was mid-flight for the
        // first, landing on a disappearing worktree and failing with
        // dependency_bootstrap_failed / commandsRun: 0. Reserving here (get+set with no
        // await between them) closes that window: the second caller's `get` always
        // observes the first caller's placeholder and returns `duplicate: true` instead
        // of ever reaching the mesh lookup.
        const alreadyRunning = self.runningRefineJobs.get(key);
        if (alreadyRunning) return { ...alreadyRunning, duplicate: true };
        // Mint jobId/interactionId once, up front, and carry them into the FINAL handle
        // below too — otherwise a poller (mesh_status → activeRefineJobs) that reads the
        // placeholder in this narrow window would see a jobId that immediately vanishes
        // and gets replaced by a different one once the real handle overwrites it.
        //
        // JOBID-RESUME-PRESERVE: resumePendingRefineJobsOnStartup passes the interrupted
        // job's ORIGINAL jobId via args.jobId so the resumed run terminates that SAME
        // job. Minting a fresh one here left the original un-terminated forever (zombie
        // re-resume every boot) and ran a second, ghost job against an already-converged
        // node.
        const jobId = typeof args?.jobId === 'string' && args.jobId.trim() ? args.jobId.trim() : `refine_${createInteractionId()}`;
        const interactionId = createInteractionId();
        const placeholder = buildRefineJobHandle(self, { meshId, nodeId, jobId, interactionId, retryOfJobId: terminal?.jobId });
        self.runningRefineJobs.set(key, placeholder);

        // preferInline so inline-cache-only clone worktree nodes resolve — same
        // membership authority as clone_mesh_node / get_mesh. Without it refine reads
        // config-first and misses nodes that only live in the inline cache.
        const meshRecord = await self.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
        if (!node) {
            self.runningRefineJobs.delete(key);
            return { success: false, error: `Node '${nodeId}' not found in mesh` };
        }
        if (!node.isLocalWorktree || !node.workspace) {
            self.runningRefineJobs.delete(key);
            return { success: false, error: `Refinery requires a local worktree node` };
        }

        // DURABLE-DUPLICATE-DISPATCH: the `runningRefineJobs` check above is in-MEMORY,
        // so it only answers "is this PROCESS already refining this node?". A refine
        // job's identity is mesh-wide, and a second dispatch reaches a different process
        // routinely — a node view that resolves without a usable `daemonId` makes
        // `isRemote` falsy in the refine_mesh_node handler and the coordinator executes
        // LOCALLY instead of forwarding to the owning daemon, so call #1 can run on the
        // worker while call #2 runs on the coordinator, each with its own empty map. That
        // is how ONE coordinator call became TWO `task_dispatched` rows for the same node
        // (3/3 on 2026-08-17), the second landing 2–5 minutes after the first and always
        // failing spuriously against the worktree the first had just torn down.
        //
        // Consult the LEDGER — the durable record both processes write to — for an open
        // dispatch on this node before adding a second one. Bounded by freshness so a
        // crashed dispatch cannot wedge the node forever (the boot resume scan owns
        // closing those out); this only refuses the duplicate.
        const duplicateDispatch = findOpenLedgerRefineDispatch(meshId, nodeId, jobId);
        if (duplicateDispatch) {
            self.runningRefineJobs.delete(key);
            LOG.warn('Mesh', `[Refinery] Refusing duplicate refine dispatch for node ${nodeId}`
                + ` — job ${duplicateDispatch.jobId} was dispatched ${duplicateDispatch.ageMs}ms ago and has no terminal entry.`);
            return {
                success: true,
                async: true,
                duplicate: true,
                status: 'accepted',
                code: 'duplicate_refine_dispatch',
                meshId,
                jobId: duplicateDispatch.jobId,
                targetNodeId: nodeId,
                startedAt: duplicateDispatch.timestamp,
                note: `A refine job for node '${nodeId}' is already in flight (jobId=${duplicateDispatch.jobId}, dispatched ${duplicateDispatch.timestamp}). `
                    + `This call was NOT dispatched again — a second job would race the first and fail against the worktree the first removes on success. `
                    + `Wait for that job's terminal event instead of re-invoking.`,
            };
        }

        // Capture the caller's coordinator daemon ID so completed/failed events are
        // scoped to that coordinator's pending-events queue and survive daemon restarts.
        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : (self.deps.statusInstanceId || undefined);
        // REFINE-EVENT-SESSION-SCOPED-UNICAST: capture the caller's coordinator SESSION
        // too. The daemon id alone routes to the right MACHINE; on a machine running more
        // than one coordinator session the terminal event then went to whichever polled
        // first. There is NO self-fallback here on purpose: this daemon's own session is
        // not the requester, and inventing one would address the event to a coordinator
        // that never asked. Absent → daemon-level delivery, i.e. exactly the old
        // behaviour, never a stuck event.
        const coordinatorSessionId = typeof args?.coordinatorSessionId === 'string' && args.coordinatorSessionId.trim()
            ? args.coordinatorSessionId.trim()
            : undefined;
        const handle = buildRefineJobHandle(self, { meshId, nodeId, node, jobId, interactionId, retryOfJobId: terminal?.jobId, coordinatorDaemonId, coordinatorSessionId });
        self.runningRefineJobs.set(key, handle);
        await appendRefineJobLedger(self, 'task_dispatched', handle);
        queueRefineJobEvent(self, 'refine:accepted', handle);

        setImmediate(() => {
            // ⓪ Accept-time base-divergence pre-check. Recorded onto the live handle as a
            // signal for a later serialization queue; it never gates or delays acceptance.
            // Deliberately runs HERE, off the accept path, so accept latency stays exactly
            // 0 no matter how large the repo or how many submodules the branch touches —
            // measured at ~63ms on a small repo, but the accept path must not pay it at all.
            void recordRefineAcceptBaseDivergence(self, handle, node);
            // REFINE-CONCURRENCY-CAP: the pipeline runs through the shared execution
            // slot — a second accepted job waits instead of overlapping its gate load
            // with the running one (the accept above already returned `accepted`).
            void runWithRefineExecutionSlot(`job ${handle.jobId} (node ${handle.targetNodeId})`,
                () => finishMeshRefineJob(self, handle, args));
        });

        return handle;
    }
