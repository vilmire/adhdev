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
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../mesh/mesh-events.js';
import { analyzeMeshRefineNodeChangeArea, orderMeshRefineBatchNodes } from '../mesh/mesh-refine-batch.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';
import { readStringValue } from '../mesh/mesh-node-identity.js';
import {
    alignRefinerySubmodulesAfterMerge,
    buildMeshRefineValidationPlan,
    buildSubmodulePublishRequiredNextStep,
    MeshRefineAsyncJobStatus,
    MeshRefineBatchJobHandle,
    MeshRefineBatchJobStatus,
    MeshRefineBatchTerminalJob,
    MeshRefineJobHandle,
    MeshRefineTerminalJob,
    RefineContext,
    RefineExecFileAsync,
    RefineStageOutcome,
    recordMeshRefineStage,
    resolveRefineryAutoPublishSubmoduleMainCommits,
    runMeshRefineEffectiveDiffGate,
    runMeshRefinePatchEquivalenceGate,
    runMeshRefineSubmoduleReachabilityGate,
    runMeshRefineValidationGate,
    truncateValidationOutput,
} from '../mesh/mesh-refine-gates.js';

export function buildRefineJobKey(self: DaemonCommandRouter, meshId: string, nodeId: string): string {
        return `${meshId}:${nodeId}`;
    }

export function buildRefineJobHandle(self: DaemonCommandRouter, args: {
        meshId: string;
        nodeId: string;
        node?: any;
        status?: MeshRefineAsyncJobStatus;
        startedAt?: string;
        completedAt?: string;
        jobId?: string;
        interactionId?: string;
        retryOfJobId?: string;
        coordinatorDaemonId?: string;
    }): MeshRefineJobHandle {
        return {
            success: true,
            async: true,
            status: args.status || 'accepted',
            jobId: args.jobId || `refine_${createInteractionId()}`,
            interactionId: args.interactionId || createInteractionId(),
            meshId: args.meshId,
            nodeId: args.nodeId,
            targetNodeId: args.nodeId,
            targetDaemonId: readStringValue(args.node?.daemonId),
            workspace: readStringValue(args.node?.workspace),
            startedAt: args.startedAt || new Date().toISOString(),
            ...(args.completedAt ? { completedAt: args.completedAt } : {}),
            ...(args.retryOfJobId ? { retryOfJobId: args.retryOfJobId } : {}),
            ...(args.coordinatorDaemonId ? { targetCoordinatorDaemonId: args.coordinatorDaemonId } : {}),
            eventDelivery: { pendingEvents: true, ledger: true },
            evidence: {
                pendingEventsCommand: 'get_pending_mesh_events',
                ledgerCommand: 'get_mesh_ledger_slice',
                taskHistoryKind: args.status === 'completed' ? 'task_completed' : args.status === 'failed' ? 'task_failed' : 'task_dispatched',
            },
        };
    }

export function queueRefineJobEvent(self: DaemonCommandRouter, event: 'refine:accepted' | 'refine:completed' | 'refine:failed', handle: MeshRefineJobHandle, result?: Record<string, unknown>): void {
        const metadataEvent = {
            source: 'refine_mesh_node_async_job',
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            meshId: handle.meshId,
            nodeId: handle.targetNodeId,
            targetDaemonId: handle.targetDaemonId,
            workspace: handle.workspace,
            status: handle.status,
            startedAt: handle.startedAt,
            completedAt: handle.completedAt,
            retryOfJobId: handle.retryOfJobId,
            ...(result ? { result } : {}),
        };
        const eventPayload = {
            event,
            meshId: handle.meshId,
            nodeLabel: handle.targetNodeId,
            nodeId: handle.targetNodeId,
            workspace: handle.workspace,
            metadataEvent,
            queuedAt: Date.now(),
            ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
        };
        if (typeof self.deps.instanceManager?.getByCategory === 'function') {
            const forwarded = handleMeshForwardEvent(
                { instanceManager: self.deps.instanceManager } as any,
                {
                    event,
                    meshId: handle.meshId,
                    nodeId: handle.targetNodeId,
                    workspace: handle.workspace,
                    jobId: handle.jobId,
                    interactionId: handle.interactionId,
                    status: handle.status,
                    targetDaemonId: handle.targetDaemonId,
                    startedAt: handle.startedAt,
                    completedAt: handle.completedAt,
                    retryOfJobId: handle.retryOfJobId,
                    ...(result ? { result } : {}),
                },
            );
            if (forwarded?.success === true) return;
            LOG.warn('Mesh', `[Refinery] Failed to forward async refine event ${event}: ${forwarded?.error || 'unknown error'}`);
        }
        queuePendingMeshCoordinatorEvent(eventPayload);
    }

export async function appendRefineJobLedger(self: DaemonCommandRouter, kind: 'task_dispatched' | 'task_completed' | 'task_failed', handle: MeshRefineJobHandle, result?: Record<string, unknown>): Promise<void> {
        try {
            const { appendLedgerEntry, buildLedgerOriginatingCoordinatorStamp } = await import('../mesh/mesh-ledger.js');
            // B2a: on dispatch, stamp the originating coordinator so a later completion
            // emit can restore `dispatchedBy` and route the terminal event back (unicast).
            // Refine jobs carry only a coordinator DAEMON id (no session), which is enough
            // to route to the daemon-level coordinator. Absent → omitted (v1 entry).
            const originatingStamp = kind === 'task_dispatched'
                ? buildLedgerOriginatingCoordinatorStamp({ coordinatorDaemonId: handle.targetCoordinatorDaemonId })
                : undefined;
            appendLedgerEntry(handle.meshId, {
                kind,
                nodeId: handle.targetNodeId,
                payload: {
                    source: 'refine_mesh_node_async_job',
                    refineJob: {
                        jobId: handle.jobId,
                        interactionId: handle.interactionId,
                        status: handle.status,
                        meshId: handle.meshId,
                        nodeId: handle.targetNodeId,
                        targetDaemonId: handle.targetDaemonId,
                        targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId,
                        workspace: handle.workspace,
                        startedAt: handle.startedAt,
                        completedAt: handle.completedAt,
                        retryOfJobId: handle.retryOfJobId,
                    },
                    async: true,
                    retryOfJobId: handle.retryOfJobId,
                    ...(originatingStamp ? { originatingCoordinator: originatingStamp } : {}),
                    ...(result ? {
                        success: result.success === true,
                        result,
                        finalBranchConvergenceState: result.finalBranchConvergenceState,
                        ...(result.blockerContext ? { blockerContext: result.blockerContext } : {}),
                    } : {}),
                },
            });
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] Failed to append async refine ledger entry: ${e?.message || e}`);
        }
    }

    /**
     * On daemon restart, scan all mesh ledgers for refine jobs that were dispatched
     * but never completed/failed (i.e. the daemon died mid-job).  Re-queue each one
     * so the job runs to completion automatically without coordinator intervention.
     */
export async function resumePendingRefineJobsOnStartup(self: DaemonCommandRouter): Promise<void> {
        try {
            const { listMeshes } = await import('../config/mesh-config.js');
            const { readLedgerEntries } = await import('../mesh/mesh-ledger.js');
            const meshIds: string[] = listMeshes().map(m => m.id).filter(Boolean) as string[];
            for (const meshId of meshIds) {
                const entries = readLedgerEntries(meshId, { kind: ['task_dispatched', 'task_completed', 'task_failed'] });
                // Build set of nodeIds that already have a terminal entry.
                const terminal = new Set<string>();
                for (const e of entries) {
                    if ((e.kind === 'task_completed' || e.kind === 'task_failed') && e.nodeId) {
                        const jobId = (e.payload as any)?.refineJob?.jobId;
                        if (jobId) terminal.add(`${e.nodeId}:${jobId}`);
                    }
                }
                // Re-dispatch dispatched jobs with no matching terminal entry.
                for (const e of entries) {
                    if (e.kind !== 'task_dispatched' || !e.nodeId) continue;
                    const source = (e.payload as any)?.source;
                    if (source !== 'refine_mesh_node_async_job') continue;
                    const jobId = (e.payload as any)?.refineJob?.jobId;
                    if (!jobId || terminal.has(`${e.nodeId}:${jobId}`)) continue;
                    const key = buildRefineJobKey(self, meshId, e.nodeId);
                    if (self.runningRefineJobs.has(key)) continue;
                    const coordinatorDaemonId = (e.payload as any)?.refineJob?.targetCoordinatorDaemonId;
                    LOG.info('Mesh', `[Refinery] Auto-resuming interrupted refine job for node ${e.nodeId} (jobId=${jobId})`);
                    void startMeshRefineJob(self, meshId, e.nodeId, {
                        coordinatorDaemonId,
                    });
                }
            }
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] resumePendingRefineJobsOnStartup failed: ${e?.message || e}`);
        }
    }

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

            const validation = await refineValidationStage(self, ctx);
            if (validation.kind === 'terminal') return validation.result;

            const patchEquivalence = await refinePatchEquivalenceStage(self, ctx);
            if (patchEquivalence.kind === 'terminal') return patchEquivalence.result;

            const submoduleReachability = await refineSubmoduleReachabilityStage(self, ctx);
            if (submoduleReachability.kind === 'terminal') return submoduleReachability.result;

            const effectiveDiff = await refineEffectiveDiffStage(self, ctx);
            if (effectiveDiff.kind === 'terminal') return effectiveDiff.result;

            const merge = await refineMergeAndFinalizeStage(self, ctx);
            return (merge as { kind: 'terminal'; result: CommandRouterResult }).result;
        } catch (e: any) {
            return { success: false, error: e.message, refineStages };
        }
    }

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

            const sourceNode = node.clonedFromNodeId
                ? mesh?.nodes.find((n: any) => meshNodeIdMatches(n, node.clonedFromNodeId))
                : mesh?.nodes.find((n: any) => !n.isLocalWorktree);
            const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
            if (!repoRoot) return { kind: 'terminal', result: { success: false, error: 'Source node repoRoot not found', refineStages } };

            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile) as unknown as RefineExecFileAsync;

            const resolveStarted = Date.now();
            const { stdout: branchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8' });
            const branch = branchStdout.trim();
            if (!branch) return { kind: 'terminal', result: { success: false, error: 'Could not determine branch of the worktree node', refineStages } };

            const { stdout: baseBranchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' });
            const baseBranch = baseBranchStdout.trim();

            // Fetch origin so baseHead reflects the latest pushed state, not a stale local HEAD.
            // This prevents patch_equivalence failures when sequential Refines push to origin/main
            // but the local main checkout hasn't been fast-forwarded yet.
            let fetchWarning: string | undefined;
            try {
                await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
            } catch (e: any) {
                fetchWarning = `git fetch origin ${baseBranch} failed (proceeding with local HEAD): ${e?.message}`;
            }

            // Prefer origin/<baseBranch> as the authoritative base; fall back to local HEAD if fetch failed.
            let baseHeadRaw: string;
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' });
                baseHeadRaw = stdout.trim();
            } catch {
                const { stdout: localHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
                baseHeadRaw = localHead.trim();
            }

            const { stdout: branchHeadStdout } = await execFileAsync('git', ['rev-parse', branch], { cwd: node.workspace, encoding: 'utf8' });
            const baseHead = baseHeadRaw;
            const branchHead = branchHeadStdout.trim();
            recordMeshRefineStage(refineStages, 'resolve_refs', 'passed', resolveStarted, { branch, baseBranch, baseHead, branchHead, ...(fetchWarning ? { fetchWarning } : {}) });

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
                    validationSummary: undefined as any,
                    patchEquivalence: undefined as any,
                    submoduleReachability: undefined as any,
                },
            };
    }

    /**
     * validation stage: run the refinery validation gate (typecheck / test /
     * lint / build per node config) and block on failure or when no allowlisted
     * command was available. On pass, stores the summary on the context.
     */
export async function refineValidationStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { mesh, node, branch, baseBranch, refineStages } = ctx;
            const validationStarted = Date.now();
            const validationSummary = await runMeshRefineValidationGate(mesh, node.workspace, {
                // M2-2: consume the node's persisted bootstrap state; persist re-runs.
                persistedBootstrapState: (node as any).worktreeBootstrap as WorktreeBootstrapState | undefined,
                onBootstrapStateChange: (state) => {
                    (node as any).worktreeBootstrap = state;
                    void import('../config/mesh-config.js')
                        .then(({ updateNode }) => updateNode(mesh.id, node.id, { worktreeBootstrap: state } as any))
                        .catch(() => { /* persistence is best-effort */ });
                },
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
                const firstFailedCmd = Array.isArray(validationSummary.commandsRun)
                    ? (validationSummary.commandsRun as Array<Record<string, unknown>>).find(c => c.success === false)
                    : undefined;
                const buildValidationFailedError = (): string => {
                    const base = validationSummary.failureCode === 'missing_dependencies'
                        ? 'Refinery validation dependencies are missing; merge/refine was not attempted. Configure validation.bootstrapCommands if Refinery should bootstrap dependencies before validation.'
                        : validationSummary.failureCode === 'dependency_bootstrap_failed'
                            ? 'Refinery dependency/bootstrap command failed; merge/refine was not attempted.'
                            : validationSummary.failureCode === 'spawn_resolution_failed'
                                ? (validationSummary.spawnResolutionError
                                    || 'Refinery validation command could not be spawned (executable not found); merge/refine was not attempted.')
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

    /**
     * patch_equivalence stage: preflight that the worktree branch's cumulative
     * patch is equivalent to base+branch. On a "behind base" branch, auto-rebase
     * once and re-check; on an empty merge-tree with real branch changes, treat as
     * already-merged-via-another-path and short-circuit to cleanup. Mutates the
     * context's branchHead (after rebase) and patchEquivalence (rebased gate).
     */
export async function refinePatchEquivalenceStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { meshId, nodeId, args, repoRoot, baseHead, node, branch, baseBranch, validationSummary, refineStages, execFileAsync } = ctx;
            let branchHead = ctx.branchHead;
            const patchEquivalenceStarted = Date.now();
            let patchEquivalence = await runMeshRefinePatchEquivalenceGate(repoRoot, baseHead, branchHead);
            recordMeshRefineStage(refineStages, 'patch_equivalence', patchEquivalence.status, patchEquivalenceStarted, {
                equivalent: patchEquivalence.equivalent,
                expectedPatchId: patchEquivalence.expectedPatchId,
                actualPatchId: patchEquivalence.actualPatchId,
                error: patchEquivalence.error,
                actionableHint: patchEquivalence.actionableHint,
            });
            if (!patchEquivalence.equivalent) {
                // Auto-rebase: if branch is simply behind base, attempt rebase automatically before failing.
                let didAutoRebase = false;
                let isBehindBase = false;
                try {
                    execFileSync('git', ['merge-base', '--is-ancestor', branchHead, baseHead], {
                        cwd: node.workspace,
                        stdio: 'ignore',
                    });
                    isBehindBase = true;
                } catch { /* non-zero exit means branchHead is not an ancestor of baseHead */ }

                if (isBehindBase) {
                    const autoRebaseStarted = Date.now();
                    try {
                        execFileSync('git', ['rebase', baseHead], {
                            cwd: node.workspace,
                            stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        const { stdout: rebasedHeadStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: node.workspace, encoding: 'utf8' });
                        branchHead = rebasedHeadStdout.trim();
                        const rebasedPatchEquivalence = await runMeshRefinePatchEquivalenceGate(repoRoot, baseHead, branchHead);
                        recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', rebasedPatchEquivalence.status, autoRebaseStarted, {
                            equivalent: rebasedPatchEquivalence.equivalent,
                            expectedPatchId: rebasedPatchEquivalence.expectedPatchId,
                            actualPatchId: rebasedPatchEquivalence.actualPatchId,
                            error: rebasedPatchEquivalence.error,
                            rebasedBranchHead: branchHead,
                        });
                        if (rebasedPatchEquivalence.equivalent) {
                            patchEquivalence = rebasedPatchEquivalence;
                            didAutoRebase = true;
                        } else {
                            return { kind: 'terminal', result: {
                                success: false,
                                code: 'needs_rebase',
                                convergenceStatus: 'blocked_review',
                                error: 'Branch was rebased onto base but patch equivalence still failed; manual intervention required.',
                                branch,
                                into: baseBranch,
                                validationSummary,
                                patchEquivalence: rebasedPatchEquivalence,
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
                    } catch (rebaseErr: any) {
                        try { execFileSync('git', ['rebase', '--abort'], { cwd: node.workspace, stdio: 'ignore' }); } catch { /* ignore */ }
                        recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', 'failed', autoRebaseStarted, {
                            error: rebaseErr?.message || String(rebaseErr),
                        });
                        return { kind: 'terminal', result: {
                            success: false,
                            code: 'needs_rebase_with_conflicts',
                            convergenceStatus: 'blocked_review',
                            error: 'Branch is behind base and auto-rebase failed due to conflicts; resolve conflicts manually and retry.',
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
                }

                // If the actual patch-id is empty, the merge-tree produces no diff vs base —
                // meaning the branch content is already present in base (landed via a different
                // path, e.g. cherry-pick or direct commit).  Treat this as "already merged":
                // skip the merge step but still run cleanup so the worktree node is removed.
                // "already merged via another path": the branch has real changes
                // (expectedPatchId non-empty) but the merge-tree produces no diff
                // against base (actualPatchId empty) — meaning every change in the
                // branch is already present in base via a cherry-pick or direct commit.
                // If both patch-ids are empty, the branch itself has no changes; that
                // is a degenerate worktree case, not an "already merged" scenario.
                const alreadyMergedViaOtherPath = !patchEquivalence.actualPatchId && !!patchEquivalence.expectedPatchId;
                if (!didAutoRebase && !alreadyMergedViaOtherPath) {
                    return { kind: 'terminal', result: {
                        success: false,
                        code: 'patch_equivalence_failed',
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

                if (!didAutoRebase && alreadyMergedViaOtherPath) {
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
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'submodule_reachability_failed',
                    convergenceStatus: 'blocked_review',
                    publishRequired: true,
                    blockedReason: 'submodule_publish_required',
                    error: 'Refinery submodule reachability preflight failed because one or more submodule gitlink commits are not reachable from their configured remote main branch; merge/refine cleanup was not attempted.',
                    nextStep,
                    nextSteps: [
                        'Ask the user for explicit approval before pushing or publishing any submodule commit.',
                        'Push/publish each unreachable submodule commit to the configured submodule remote main branch shown in the evidence.',
                        'Rerun mesh_refine_node after remote reachability is confirmed.',
                        'Do not merge the root branch until every submodule gitlink commit is reachable from submodule origin/main.',
                    ],
                    unreachableSubmoduleCommits: submoduleReachability.unreachable.map(entry => ({
                        path: entry.path,
                        commit: entry.commit,
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
                reason: 'submodule_publish_required',
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

    /**
     * merge + finalize stage: perform the --no-ff merge, align submodule
     * checkouts after merge, clean up (remove) the worktree node per policy,
     * append the refinery ledger entry, and (unless approval is required) push the
     * base branch. Always terminal — produces the final CommandRouterResult.
     */
export async function refineMergeAndFinalizeStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { meshId, nodeId, args, repoRoot, baseHead, node, branch, baseBranch, sourceNode, validationSummary, patchEquivalence, submoduleReachability, mesh, refineStages, execFileAsync } = ctx;
            let mergeResult: Record<string, unknown> | undefined;
            const mergeStarted = Date.now();
            try {
                const result = await execFileAsync('git', ['merge', '--no-ff', branch, '-m', `Auto-merge branch '${branch}' via Refinery`], { cwd: repoRoot, encoding: 'utf8' });
                mergeResult = {
                    stdout: truncateValidationOutput(result.stdout),
                    stderr: truncateValidationOutput(result.stderr),
                    durationMs: Date.now() - mergeStarted,
                };
                recordMeshRefineStage(refineStages, 'merge', 'passed', mergeStarted, mergeResult);
            } catch (e: any) {
                recordMeshRefineStage(refineStages, 'merge', 'failed', mergeStarted, {
                    error: e?.message || String(e),
                    stdout: truncateValidationOutput(e?.stdout),
                    stderr: truncateValidationOutput(e?.stderr),
                });
                return { kind: 'terminal', result: {
                    success: false,
                    error: `Merge failed (conflicts?): ${e.message}`,
                    validationSummary,
                    patchEquivalence,
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

            const cleanupStarted = Date.now();
            // Honor the mesh policy for delegated-session cleanup on the auto-removed
            // worktree node (previously hardcoded to 'preserve', which orphaned the
            // delegate session as an idle record on the coordinator daemon). Fall back
            // to 'preserve' when no policy is set.
            const refineSessionCleanupMode = self.normalizeMeshSessionCleanupMode(
                mesh?.policy?.sessionCleanupOnNodeRemove,
            );
            // The delegate session launched for a clone worktree is frequently matched
            // by workspace ONLY (no meta.meshNodeId binding), which remove_mesh_node's
            // shared-daemon guard skips. Since refine knows exactly which workspace it
            // just merged, collect that workspace's live session ids explicitly and pass
            // them through — explicit sessionIds bypass the workspace-only-match guard so
            // the policy-driven stop/delete actually runs.
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
                sessionCleanupMode: refineSessionCleanupMode,
                ...(refineSessionIds && refineSessionIds.length > 0 ? { sessionIds: refineSessionIds } : {}),
                inlineMesh: args?.inlineMesh,
                // REFINE-CLEANUP: refine reaches cleanup only AFTER a verified merge
                // convergence, so any residual worktree dirtiness here is incidental
                // (e.g. a bootstrap lockfile rewrite) — never unmerged work. `force`
                // sets requireClean=false so a plain-dirty worktree no longer aborts
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
                const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                appendLedgerEntry(meshId, {
                    kind: 'node_removed',
                    nodeId,
                    payload: { refined: true, mergedBranch: branch, into: baseBranch, validationSummary, patchEquivalence, submoduleReachability, submoduleAlignment },
                });
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
                removed: removeResult?.success !== false,
                validation: 'passed',
                patchEquivalence: 'passed',
                submoduleAlignment: submoduleAlignment.status,
                status: removeResult?.success === false ? 'merged_cleanup_failed' : 'merged',
            };

            if (removeResult?.success === false) {
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'cleanup_failed',
                    error: 'Refinery merge completed but worktree cleanup failed; manual cleanup/retry is required.',
                    merged: true,
                    branch,
                    into: baseBranch,
                    removeResult,
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

            // Push logic: after a successful merge, either auto-push or surface push info
            // so coordinators don't need manual discovery after each refine.
            const requireApprovalForPush: boolean = (mesh as any)?.policy?.requireApprovalForPush ?? DEFAULT_MESH_POLICY.requireApprovalForPush;
            let pushResult: Record<string, unknown> | undefined;
            if (!requireApprovalForPush) {
                const pushStarted = Date.now();
                try {
                    await execFileAsync('git', ['push', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
                    pushResult = { pushed: true, remote: 'origin', branch: baseBranch, durationMs: Date.now() - pushStarted };
                    recordMeshRefineStage(refineStages, 'push', 'passed', pushStarted, pushResult);
                    finalBranchConvergenceState.status = 'merged_pushed';
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
                }
            }

            return { kind: 'terminal', result: {
                success: true,
                merged: true,
                branch,
                into: baseBranch,
                removeResult,
                validationSummary,
                patchEquivalence,
                submoduleReachability,
                submoduleAlignment,
                mergeResult,
                refineStages,
                ...(ledgerError ? { ledgerError } : {}),
                finalBranchConvergenceState,
                // Push outcome or readiness info for coordinator.
                ...(pushResult
                    ? { pushResult }
                    : {
                        pushReady: true,
                        pushCommand: `git push origin ${baseBranch}`,
                        pushNote: 'requireApprovalForPush is enabled — run the push command or obtain user approval before pushing.',
                    }),
            } };
    }

    /**
     * Batch refinery: converge multiple sibling worktree nodes onto the base branch
     * in one sequential pipeline, absorbing the rebase + patch-equivalence churn that
     * arises when several siblings touch the same submodule.
     *
     * Reuses executeMeshRefineNodeSynchronously per node — every node goes through the
     * exact same validation / patch-equivalence / submodule-reachability / merge / cleanup
     * gates, including its built-in auto-rebase onto fresh origin/<base>. Because each
     * node fetches origin/<base> at the start of its own refine, a node merged earlier in
     * the batch advances the base, and the next node's refine auto-rebases onto it before
     * re-running patch-equivalence. No force-push, no reset — conflicting nodes are
     * isolated as blocked_review while the rest of the batch proceeds.
     */
export async function batchRefineMeshNodes(self: DaemonCommandRouter, meshId: string, requestedNodeIds: string[] | undefined, args: any): Promise<CommandRouterResult> {
        // preferInline: same membership authority as refine_mesh_node — inline-cache-only
        // clone nodes (created in this MCP session) must resolve.
        const meshRecord = await self.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        if (!mesh) return { success: false, error: `Mesh '${meshId}' not found` };

        const allNodes: any[] = Array.isArray(mesh.nodes) ? mesh.nodes : [];
        const isConvergeable = (n: any) => n?.isLocalWorktree && typeof n.workspace === 'string' && n.workspace;

        let targetNodes: any[];
        if (Array.isArray(requestedNodeIds) && requestedNodeIds.length > 0) {
            targetNodes = [];
            const missing: string[] = [];
            const nonWorktree: string[] = [];
            for (const nodeId of requestedNodeIds) {
                const node = allNodes.find(n => meshNodeIdMatches(n, nodeId));
                if (!node) { missing.push(nodeId); continue; }
                if (!isConvergeable(node)) { nonWorktree.push(nodeId); continue; }
                targetNodes.push(node);
            }
            if (missing.length || nonWorktree.length) {
                return {
                    success: false,
                    error: 'One or more requested nodes are not convergeable local worktree nodes.',
                    ...(missing.length ? { missingNodeIds: missing } : {}),
                    ...(nonWorktree.length ? { nonWorktreeNodeIds: nonWorktree } : {}),
                };
            }
        } else {
            // Auto-collect: every local worktree node is a convergence candidate.
            targetNodes = allNodes.filter(isConvergeable);
        }

        if (targetNodes.length === 0) {
            return { success: true, batch: true, dryRun: args?.dryRun !== false, nodeCount: 0, order: [], results: [], note: 'No convergeable local worktree nodes found.' };
        }

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        // Resolve the base repo root and a base ref to analyze change areas against.
        const resolveRepoRootFor = (node: any): string | undefined => {
            const sourceNode = node.clonedFromNodeId
                ? allNodes.find(n => meshNodeIdMatches(n, node.clonedFromNodeId))
                : allNodes.find(n => !n.isLocalWorktree);
            return sourceNode?.repoRoot || sourceNode?.workspace;
        };

        // Analyze change areas for ordering. The repoRoot is shared across siblings of
        // the same source; resolve a base ref (origin/<base> preferred) once per repoRoot.
        const repoRootBaseRef = new Map<string, string>();
        const submodulePathsByRepoRoot = new Map<string, Set<string>>();
        const resolveBaseRef = async (repoRoot: string): Promise<string> => {
            const cached = repoRootBaseRef.get(repoRoot);
            if (cached) return cached;
            let baseBranch = 'main';
            try {
                const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' });
                if (stdout.trim()) baseBranch = stdout.trim();
            } catch { /* fall back to main */ }
            let baseRef = 'HEAD';
            try {
                await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
            } catch { /* offline / no remote — fall through to local refs */ }
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' });
                baseRef = stdout.trim();
            } catch {
                try {
                    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
                    baseRef = stdout.trim();
                } catch { /* leave HEAD */ }
            }
            repoRootBaseRef.set(repoRoot, baseRef);
            return baseRef;
        };

        const changeAreas: Array<Awaited<ReturnType<typeof analyzeMeshRefineNodeChangeArea>>> = [];
        for (const node of targetNodes) {
            const repoRoot = resolveRepoRootFor(node);
            let branch = typeof node.worktreeBranch === 'string' ? node.worktreeBranch : '';
            try {
                const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8' });
                if (stdout.trim()) branch = stdout.trim();
            } catch { /* use stored worktreeBranch */ }

            if (!repoRoot || !branch) {
                changeAreas.push({
                    nodeId: node.id, workspace: node.workspace, branch: branch || '(unknown)',
                    changedTopLevelPaths: [], changedFiles: [], touchedSubmodulePaths: [],
                    touchesSubmodule: false, aheadCount: 0,
                    error: !repoRoot ? 'source repoRoot not found' : 'branch not resolved',
                });
                continue;
            }
            if (!submodulePathsByRepoRoot.has(repoRoot)) {
                // Resolve declared submodule paths once per repo root.
                let subPaths = new Set<string>();
                try {
                    const { stdout } = await execFileAsync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], { cwd: repoRoot, encoding: 'utf8' });
                    for (const line of stdout.split('\n')) {
                        const trimmed = line.trim();
                        const spaceIdx = trimmed.indexOf(' ');
                        if (spaceIdx === -1) continue;
                        const value = trimmed.slice(spaceIdx + 1).trim();
                        if (value) subPaths.add(value);
                    }
                } catch { subPaths = new Set(); }
                submodulePathsByRepoRoot.set(repoRoot, subPaths);
            }
            const baseRef = await resolveBaseRef(repoRoot);
            let branchRef = branch;
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', branch], { cwd: node.workspace, encoding: 'utf8' });
                branchRef = stdout.trim() || branch;
            } catch { /* use branch name */ }
            changeAreas.push(await analyzeMeshRefineNodeChangeArea({
                nodeId: node.id,
                workspace: node.workspace,
                branch,
                baseRef,
                branchRef,
                diffCwd: node.workspace,
                submodulePaths: submodulePathsByRepoRoot.get(repoRoot)!,
            }));
        }

        const ordering = orderMeshRefineBatchNodes(changeAreas);
        const orderedNodes = ordering.order
            .map(nodeId => targetNodes.find(n => meshNodeIdMatches(n, nodeId)))
            .filter((n): n is any => !!n);

        const dryRun = args?.dryRun !== false && args?.execute !== true;
        if (dryRun) {
            return {
                success: true,
                batch: true,
                dryRun: true,
                nodeCount: orderedNodes.length,
                order: ordering.order,
                orderingRationale: ordering.rationale,
                changeAreas: ordering.changeAreas,
                plan: orderedNodes.map(node => ({
                    nodeId: node.id,
                    workspace: node.workspace,
                    validationPlan: buildMeshRefineValidationPlan(mesh, node.workspace),
                    mergeWillRun: false,
                })),
                note: 'Dry-run: no validation, rebase, or merge was executed. Re-run with execute=true to converge nodes in this order.',
            };
        }

        // Execute: refine each node in order via the shared convergence core.
        return runMeshRefineBatchConvergence(self, meshId, orderedNodes, ordering, args);
    }

    /**
     * Convergence core shared by the synchronous batch entry and the async batch job.
     * Refines each node in order: the per-node refine pipeline fetches origin/<base>
     * fresh, so each merged sibling advances the base before the next node's auto-rebase
     * + patch-equivalence re-check. A blocked/failed node is isolated; the batch
     * continues with the remaining nodes. Does NOT touch the per-node merge logic — it
     * only sequences calls to executeMeshRefineNodeSynchronously and aggregates outcomes.
     */
export async function runMeshRefineBatchConvergence(self: DaemonCommandRouter, 
        meshId: string,
        orderedNodes: any[],
        ordering: { order: string[]; rationale?: unknown },
        args: any,
    ): Promise<CommandRouterResult> {
        type BatchNodeOutcome = {
            nodeId: string;
            workspace: string;
            convergence: 'merged_to_main' | 'blocked_review' | 'skipped_patch_equivalent' | 'not_mergeable';
            code?: string;
            reason?: string;
            stage?: string;
            error?: string;
            finalBranchConvergenceState?: Record<string, unknown>;
        };
        const results: BatchNodeOutcome[] = [];
        for (const node of orderedNodes) {
            let result: Record<string, unknown>;
            try {
                result = await executeMeshRefineNodeSynchronously(self, meshId, node.id, args) as Record<string, unknown>;
            } catch (e: any) {
                result = { success: false, error: e?.message || String(e) };
            }
            const code = typeof result.code === 'string' ? result.code : '';
            // already_merged (branch content already on base via another path) is a
            // non-error skip regardless of success flag — the worktree converges with
            // no new merge. A real `git merge` conflict surfaces as merge_failed →
            // not_mergeable. Everything else that failed is isolated as blocked_review.
            let convergence: BatchNodeOutcome['convergence'];
            if (code === 'already_merged' && result.alreadyMergedViaOtherPath) {
                convergence = 'skipped_patch_equivalent';
            } else if (result.success === true) {
                convergence = 'merged_to_main';
            } else if (code === 'merge_failed') {
                convergence = 'not_mergeable';
            } else {
                convergence = 'blocked_review';
            }
            const fbcs = (result.finalBranchConvergenceState && typeof result.finalBranchConvergenceState === 'object')
                ? result.finalBranchConvergenceState as Record<string, unknown>
                : undefined;
            const stage = Array.isArray(result.refineStages)
                ? (result.refineStages as Array<Record<string, unknown>>).filter(s => s.status === 'failed').map(s => s.stage).filter(Boolean).pop() as string | undefined
                : undefined;
            results.push({
                nodeId: node.id,
                workspace: node.workspace,
                convergence,
                ...(code ? { code } : {}),
                ...(typeof result.blockedReason === 'string' ? { reason: result.blockedReason } : {}),
                ...(stage ? { stage } : {}),
                ...(typeof result.error === 'string' ? { error: result.error } : {}),
                ...(fbcs ? { finalBranchConvergenceState: fbcs } : {}),
            });
        }

        const summary = {
            merged: results.filter(r => r.convergence === 'merged_to_main').length,
            skipped: results.filter(r => r.convergence === 'skipped_patch_equivalent').length,
            blocked: results.filter(r => r.convergence === 'blocked_review').length,
            notMergeable: results.filter(r => r.convergence === 'not_mergeable').length,
        };
        const allConverged = summary.blocked === 0 && summary.notMergeable === 0;
        return {
            success: true,
            batch: true,
            dryRun: false,
            nodeCount: orderedNodes.length,
            order: ordering.order,
            orderingRationale: ordering.rationale,
            summary,
            allConverged,
            results,
            ...(allConverged ? {} : {
                nextStep: 'Resolve blocked_review / not_mergeable nodes manually (see per-node code/stage/error), then re-run mesh_refine_batch for the remaining nodes.',
            }),
        };
    }

export function buildRefineBatchJobKey(self: DaemonCommandRouter, meshId: string): string {
        return `${meshId}::batch`;
    }

export function buildRefineBatchJobHandle(self: DaemonCommandRouter, args: {
        meshId: string;
        nodeIds: string[];
        order: string[];
        status?: MeshRefineBatchJobStatus;
        startedAt?: string;
        completedAt?: string;
        jobId?: string;
        interactionId?: string;
        coordinatorDaemonId?: string;
    }): MeshRefineBatchJobHandle {
        return {
            success: true,
            async: true,
            batch: true,
            status: args.status || 'accepted',
            jobId: args.jobId || `refine_batch_${createInteractionId()}`,
            interactionId: args.interactionId || createInteractionId(),
            meshId: args.meshId,
            batchLabel: `batch:${args.nodeIds.length} node${args.nodeIds.length === 1 ? '' : 's'}`,
            nodeIds: args.nodeIds,
            nodeCount: args.nodeIds.length,
            order: args.order,
            startedAt: args.startedAt || new Date().toISOString(),
            ...(args.completedAt ? { completedAt: args.completedAt } : {}),
            ...(args.coordinatorDaemonId ? { targetCoordinatorDaemonId: args.coordinatorDaemonId } : {}),
            eventDelivery: { pendingEvents: true, ledger: true },
            evidence: {
                pendingEventsCommand: 'get_pending_mesh_events',
                ledgerCommand: 'get_mesh_ledger_slice',
                taskHistoryKind: args.status === 'completed' ? 'task_completed' : args.status === 'failed' ? 'task_failed' : 'task_dispatched',
            },
        };
    }

    /**
     * Emit a batch Refinery terminal/accepted event through the SAME pending-event +
     * forward mechanism single-node refine uses (queueRefineJobEvent), so the
     * coordinator's existing refine:accepted/completed/failed handling and message
     * renderer apply unchanged. The aggregate per-node results ride along in `result`.
     */
export function queueRefineBatchJobEvent(self: DaemonCommandRouter, 
        event: 'refine:accepted' | 'refine:completed' | 'refine:failed',
        handle: MeshRefineBatchJobHandle,
        result?: Record<string, unknown>,
    ): void {
        const metadataEvent = {
            source: 'refine_mesh_node_async_job',
            batch: true,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            meshId: handle.meshId,
            nodeId: handle.batchLabel,
            nodeIds: handle.nodeIds,
            workspace: undefined,
            status: handle.status,
            startedAt: handle.startedAt,
            completedAt: handle.completedAt,
            order: handle.order,
            ...(result ? { result } : {}),
        };
        const eventPayload = {
            event,
            meshId: handle.meshId,
            nodeLabel: handle.batchLabel,
            nodeId: handle.batchLabel,
            metadataEvent,
            queuedAt: Date.now(),
            ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
        };
        if (typeof self.deps.instanceManager?.getByCategory === 'function') {
            const forwarded = handleMeshForwardEvent(
                { instanceManager: self.deps.instanceManager } as any,
                {
                    event,
                    meshId: handle.meshId,
                    nodeId: handle.batchLabel,
                    jobId: handle.jobId,
                    interactionId: handle.interactionId,
                    status: handle.status,
                    startedAt: handle.startedAt,
                    completedAt: handle.completedAt,
                    ...(result ? { result } : {}),
                },
            );
            if (forwarded?.success === true) return;
            LOG.warn('Mesh', `[Refinery] Failed to forward async refine batch event ${event}: ${forwarded?.error || 'unknown error'}`);
        }
        queuePendingMeshCoordinatorEvent(eventPayload);
    }

export async function appendRefineBatchJobLedger(self: DaemonCommandRouter, 
        kind: 'task_dispatched' | 'task_completed' | 'task_failed',
        handle: MeshRefineBatchJobHandle,
        result?: Record<string, unknown>,
    ): Promise<void> {
        try {
            const { appendLedgerEntry, buildLedgerOriginatingCoordinatorStamp } = await import('../mesh/mesh-ledger.js');
            // B2a: stamp the originating coordinator on dispatch (see appendRefineJobLedger).
            const originatingStamp = kind === 'task_dispatched'
                ? buildLedgerOriginatingCoordinatorStamp({ coordinatorDaemonId: handle.targetCoordinatorDaemonId })
                : undefined;
            appendLedgerEntry(handle.meshId, {
                kind,
                nodeId: handle.batchLabel,
                payload: {
                    source: 'refine_mesh_node_async_job',
                    refineJob: {
                        batch: true,
                        jobId: handle.jobId,
                        interactionId: handle.interactionId,
                        status: handle.status,
                        meshId: handle.meshId,
                        nodeIds: handle.nodeIds,
                        order: handle.order,
                        targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId,
                        startedAt: handle.startedAt,
                        completedAt: handle.completedAt,
                    },
                    async: true,
                    batch: true,
                    ...(originatingStamp ? { originatingCoordinator: originatingStamp } : {}),
                    ...(result ? {
                        success: result.success === true,
                        result,
                    } : {}),
                },
            });
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] Failed to append async refine batch ledger entry: ${e?.message || e}`);
        }
    }

export async function finishMeshRefineBatchJob(self: DaemonCommandRouter, 
        handle: MeshRefineBatchJobHandle,
        orderedNodes: any[],
        ordering: { order: string[]; rationale?: unknown },
        args: any,
    ): Promise<void> {
        const key = buildRefineBatchJobKey(self, handle.meshId);
        let result: Record<string, unknown>;
        try {
            result = await runMeshRefineBatchConvergence(self, handle.meshId, orderedNodes, ordering, args) as Record<string, unknown>;
        } catch (e: any) {
            result = { success: false, error: e?.message || String(e), batch: true };
        }
        const completedAt = new Date().toISOString();

        // The batch as a whole "completed" only when every node converged (no blocked /
        // not_mergeable). A partial batch is reported as a terminal failure so the
        // coordinator inspects the per-node blockers rather than assuming a clean merge.
        const summary = (result.summary && typeof result.summary === 'object') ? result.summary as Record<string, number> : undefined;
        const allConverged = result.allConverged === true;
        const isTerminalSuccess = result.success === true && allConverged;

        const nextStep = typeof result.nextStep === 'string' && result.nextStep
            ? result.nextStep
            : isTerminalSuccess
                ? 'All batched nodes converged onto base. Continue from the updated mesh state.'
                : 'Resolve blocked_review / not_mergeable nodes (see per-node code/stage/error in result.results), then re-run mesh_refine_batch for the remaining nodes.';
        const normalizedResult = {
            ...result,
            batch: true,
            nextStep,
            ...(summary ? {
                convergenceStatus: allConverged ? 'all_converged' : 'partial',
            } : {}),
        };

        const terminalHandle = buildRefineBatchJobHandle(self, {
            meshId: handle.meshId,
            nodeIds: handle.nodeIds,
            order: handle.order,
            status: isTerminalSuccess ? 'completed' : 'failed',
            startedAt: handle.startedAt,
            completedAt,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
        });
        const terminal: MeshRefineBatchTerminalJob = { ...terminalHandle, result: normalizedResult };
        self.terminalRefineBatchJobs.set(key, terminal);
        self.runningRefineBatchJobs.delete(key);
        self.invalidateAggregateMeshStatus(handle.meshId);
        await appendRefineBatchJobLedger(self, isTerminalSuccess ? 'task_completed' : 'task_failed', terminalHandle, normalizedResult);
        queueRefineBatchJobEvent(self, isTerminalSuccess ? 'refine:completed' : 'refine:failed', terminalHandle, normalizedResult);
    }

    /**
     * Async entry for the batch Refinery execute path. Mirrors startMeshRefineJob:
     * resolves the plan synchronously (so target/ordering errors and the dry-run shape
     * stay synchronous), then for execute=true registers an in-flight batch job, returns
     * {async:true, status:'accepted', batch:true, ...plan} immediately, and runs the
     * convergence loop in the background — emitting the same terminal refine event.
     * Idempotent: a batch already in flight for this mesh returns the running handle
     * with duplicate:true rather than spawning a second background job.
     */
export async function startMeshRefineBatchJob(self: DaemonCommandRouter, meshId: string, requestedNodeIds: string[] | undefined, args: any): Promise<CommandRouterResult> {
        // Resolve the plan up-front. For dry-run this returns the synchronous plan; for
        // execute it returns the same plan shape but we hand convergence to the bg job.
        const plan = await batchRefineMeshNodes(self, meshId, requestedNodeIds, { ...args, dryRun: true, execute: false });
        const planRecord = plan as Record<string, unknown>;
        if (planRecord.success !== true) return plan;

        // If the caller actually asked for a dry-run, return the plan as-is (sync).
        if (args?.dryRun === true && args?.execute !== true) return plan;

        const order = Array.isArray(planRecord.order) ? (planRecord.order as unknown[]).filter((v): v is string => typeof v === 'string') : [];
        const nodeIds = order.slice();
        if (nodeIds.length === 0) {
            // No convergeable nodes — nothing to dispatch; return the empty plan synchronously.
            return { ...planRecord, success: true, batch: true, dryRun: false, async: false };
        }

        const key = buildRefineBatchJobKey(self, meshId);
        const running = self.runningRefineBatchJobs.get(key);
        if (running) return { ...running, duplicate: true };

        // Re-resolve the ordered node objects against current membership so the bg job
        // refines real nodes (the plan only carries ids). preferInline matches refine_mesh_node.
        const meshRecord = await self.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const allNodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
        const orderedNodes = nodeIds
            .map(id => allNodes.find(n => meshNodeIdMatches(n, id)))
            .filter((n): n is any => !!n);
        if (orderedNodes.length === 0) {
            return { success: false, error: 'Batch nodes no longer resolvable in mesh', batch: true };
        }
        const ordering = {
            order,
            rationale: planRecord.orderingRationale,
        };

        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : (self.deps.statusInstanceId || undefined);
        const handle = buildRefineBatchJobHandle(self, { meshId, nodeIds, order, coordinatorDaemonId });
        self.runningRefineBatchJobs.set(key, handle);
        await appendRefineBatchJobLedger(self, 'task_dispatched', handle);
        queueRefineBatchJobEvent(self, 'refine:accepted', handle);

        setImmediate(() => {
            void finishMeshRefineBatchJob(self, handle, orderedNodes, ordering, args);
        });

        // Return the accepted handle plus the plan so the coordinator sees the target set.
        return {
            ...handle,
            order,
            orderingRationale: planRecord.orderingRationale,
            plan: planRecord.plan,
            note: 'Batch convergence accepted and running in the background. Completion/failure (with per-node results) will be delivered as a terminal refine event; do not poll repeatedly.',
        };
    }

export async function finishMeshRefineJob(self: DaemonCommandRouter, handle: MeshRefineJobHandle, args: any): Promise<void> {
        const key = buildRefineJobKey(self, handle.meshId, handle.targetNodeId);
        let result: Record<string, unknown>;
        try {
            result = await executeMeshRefineNodeSynchronously(self, handle.meshId, handle.targetNodeId, args) as Record<string, unknown>;
        } catch (e: any) {
            result = { success: false, error: e?.message || String(e) };
        }
        const completedAt = new Date().toISOString();

        // B1: Discriminated terminal status — do not rely solely on result.success.
        // Map known failure codes to structured terminal kinds.
        type RefineTerminalKind = 'completed' | 'blocked_review' | 'validation_failed' | 'submodule_reachability_failed' | 'merge_failed' | 'cleanup_failed';
        const refineCode = typeof result.code === 'string' ? result.code : '';
        const refineTerminalKind: RefineTerminalKind = result.success === true
            ? 'completed'
            : refineCode === 'blocked_review'
                ? 'blocked_review'
                : refineCode === 'validation_failed' || refineCode === 'validation_dependencies_missing'
                    ? 'validation_failed'
                    : refineCode === 'submodule_reachability_failed'
                        ? 'submodule_reachability_failed'
                        : refineCode === 'merge_failed' || refineCode === 'patch_equivalence_failed' || refineCode === 'needs_rebase' || refineCode === 'needs_rebase_with_conflicts'
                            ? 'merge_failed'
                            : refineCode === 'cleanup_failed'
                                ? 'cleanup_failed'
                                : 'merge_failed'; // fallback for unclassified failures
        const isTerminalSuccess = refineTerminalKind === 'completed';

        // Build structured blocker context for task_failed ledger entries so coordinators
        // can inspect the failure cause without parsing free-form error strings.
        const blockerContext: Record<string, unknown> | undefined = isTerminalSuccess ? undefined : (() => {
            const code = typeof result.code === 'string' ? result.code : refineTerminalKind;
            const stage = refineTerminalKind === 'validation_failed' ? 'validation'
                : refineTerminalKind === 'submodule_reachability_failed' ? 'submodule_reachability'
                : refineCode === 'patch_equivalence_failed' ? 'patch_equivalence'
                : refineCode === 'needs_rebase' || refineCode === 'needs_rebase_with_conflicts' ? 'patch_equivalence'
                : refineTerminalKind === 'merge_failed' ? 'merge'
                : refineTerminalKind === 'cleanup_failed' ? 'cleanup'
                : 'unknown';
            const ctx: Record<string, unknown> = {
                stage,
                reason: code,
                terminalKind: refineTerminalKind,
            };
            if (typeof result.error === 'string') ctx.error = result.error;
            if (typeof result.blockedReason === 'string') ctx.blockedReason = result.blockedReason;
            // Patch equivalence details
            if (stage === 'patch_equivalence' && result.patchEquivalence) {
                const pe = result.patchEquivalence as Record<string, unknown>;
                ctx.details = {
                    expectedPatchId: pe.expectedPatchId,
                    actualPatchId: pe.actualPatchId,
                    status: pe.status,
                    actionableHint: pe.actionableHint,
                    error: pe.error,
                };
            }
            // Submodule reachability details
            if (stage === 'submodule_reachability' && Array.isArray(result.unreachableSubmoduleCommits)) {
                ctx.details = {
                    unreachableCount: (result.unreachableSubmoduleCommits as unknown[]).length,
                    paths: (result.unreachableSubmoduleCommits as Array<Record<string, unknown>>).map(e => e.path),
                    autoPublishAllowed: (result.unreachableSubmoduleCommits as Array<Record<string, unknown>>)[0]?.autoPublishAllowed,
                };
            }
            // Validation details
            if (stage === 'validation' && result.validationSummary) {
                const vs = result.validationSummary as Record<string, unknown>;
                ctx.details = {
                    failureCode: vs.failureCode,
                    commandsRun: Array.isArray(vs.commandsRun) ? vs.commandsRun.length : undefined,
                };
            }
            return ctx;
        })();

        const normalizedResult = {
            ...result,
            terminalKind: refineTerminalKind,
            ...(blockerContext ? { blockerContext } : {}),
            ...(result.nextStep === undefined && !isTerminalSuccess ? {
                nextStep: refineTerminalKind === 'blocked_review'
                    ? 'Request user review/approval before attempting to merge again.'
                    : refineTerminalKind === 'validation_failed'
                        ? 'Fix failing tests or configure validation.bootstrapCommands and retry mesh_refine_node.'
                        : refineTerminalKind === 'submodule_reachability_failed'
                            ? 'Push unreachable submodule commits to origin/main, then retry mesh_refine_node.'
                            : refineTerminalKind === 'merge_failed'
                                ? 'Resolve merge conflicts or patch equivalence issues, then retry mesh_refine_node.'
                                : refineTerminalKind === 'cleanup_failed'
                                    ? 'Manually remove the worktree and retry or use mesh_remove_node.'
                                    : 'Inspect refineStages for the failing stage and retry.',
            } : {}),
        };

        const terminalHandle = buildRefineJobHandle(self, {
            meshId: handle.meshId,
            nodeId: handle.targetNodeId,
            status: isTerminalSuccess ? 'completed' : 'failed',
            startedAt: handle.startedAt,
            completedAt,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            retryOfJobId: handle.retryOfJobId,
            node: { daemonId: handle.targetDaemonId, workspace: handle.workspace },
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
        });
        const terminal: MeshRefineTerminalJob = { ...terminalHandle, result: normalizedResult };
        self.terminalRefineJobs.set(key, terminal);
        self.runningRefineJobs.delete(key);
        self.invalidateAggregateMeshStatus(handle.meshId);
        await appendRefineJobLedger(self, isTerminalSuccess ? 'task_completed' : 'task_failed', terminalHandle, normalizedResult);
        queueRefineJobEvent(self, isTerminalSuccess ? 'refine:completed' : 'refine:failed', terminalHandle, normalizedResult);
    }

export async function startMeshRefineJob(self: DaemonCommandRouter, meshId: string, nodeId: string, args: any): Promise<CommandRouterResult> {
        const key = buildRefineJobKey(self, meshId, nodeId);
        const running = self.runningRefineJobs.get(key);
        if (running) return { ...running, duplicate: true };
        const terminal = self.terminalRefineJobs.get(key);

        // preferInline so inline-cache-only clone worktree nodes resolve — same
        // membership authority as clone_mesh_node / get_mesh. Without it refine reads
        // config-first and misses nodes that only live in the inline cache.
        const meshRecord = await self.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
        if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };
        if (!node.isLocalWorktree || !node.workspace) return { success: false, error: `Refinery requires a local worktree node` };

        // Capture the caller's coordinator daemon ID so completed/failed events are
        // scoped to that coordinator's pending-events queue and survive daemon restarts.
        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : (self.deps.statusInstanceId || undefined);
        const handle = buildRefineJobHandle(self, { meshId, nodeId, node, retryOfJobId: terminal?.jobId, coordinatorDaemonId });
        self.runningRefineJobs.set(key, handle);
        await appendRefineJobLedger(self, 'task_dispatched', handle);
        queueRefineJobEvent(self, 'refine:accepted', handle);

        setImmediate(() => {
            void finishMeshRefineJob(self, handle, args);
        });

        return handle;
    }
