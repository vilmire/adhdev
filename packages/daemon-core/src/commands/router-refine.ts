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
import { resolveCoordinatorSelfIds, daemonIdListIncludes } from '../mesh/mesh-reconcile-identity.js';
import { fastForwardMeshNode } from '../mesh/mesh-fast-forward.js';
import { analyzeMeshRefineNodeChangeArea, orderMeshRefineBatchNodes } from '../mesh/mesh-refine-batch.js';
import { assessRefineBaseDivergence } from '../mesh/mesh-refine-base-divergence.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';
import { classifyChangedPackages } from '../git/git-status.js';
import type { ChangedPackageClassification } from '../git/git-status.js';
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
    classifyPatchEquivalenceFailure,
    collectTrivialFastForwardGitlinkResolutions,
    convergeDivergedSubmoduleGitlinks,
    recordMeshRefineStage,
    resolveRefineryAutoPublishSubmoduleMainCommits,
    rootRebaseResolvingGitlinks,
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
        /** Requesting coordinator SESSION (REFINE-EVENT-SESSION-SCOPED-UNICAST). */
        coordinatorSessionId?: string;
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
            ...(args.coordinatorSessionId ? { targetCoordinatorSessionId: args.coordinatorSessionId } : {}),
            eventDelivery: { pendingEvents: true, ledger: true },
            evidence: {
                pendingEventsCommand: 'get_pending_mesh_events',
                ledgerCommand: 'get_mesh_ledger_slice',
                taskHistoryKind: args.status === 'completed' ? 'task_completed' : args.status === 'failed' ? 'task_failed' : 'task_dispatched',
            },
        };
    }

/**
 * QW2: extract a compact failure diagnostic from a validation summary — the first
 * failing command's name, its exit code, its failureKind, and a bounded output tail.
 * Surfaced in BOTH the slim coordinator event and the ledger blockerContext so a
 * coordinator can decide next-step without pulling and parsing the full ledger record.
 *
 * A command record carries `passed` (boolean), never `success` (see QW1) — the first
 * record with passed===false is the gate's failing command. Returns undefined when the
 * summary did not fail on a command (e.g. bootstrap-stage failure with no commandsRun
 * entry), in which case the top-level failureCode/failureKind still describe the cause.
 */
export function extractValidationFailureDiagnostics(
    validationSummary: Record<string, unknown> | undefined,
): { firstFailedCommand?: string; exitCode?: unknown; failureKind?: unknown; outputTail?: string } | undefined {
    if (!validationSummary || typeof validationSummary !== 'object') return undefined;
    const commandsRun = Array.isArray(validationSummary.commandsRun)
        ? (validationSummary.commandsRun as Array<Record<string, unknown>>)
        : [];
    const failed = commandsRun.find(c => c.passed === false);
    const summaryFailureKind = validationSummary.failureKind;
    if (!failed) {
        // No per-command failure (bootstrap failure, spawn resolution before any
        // command ran, etc.) — still surface the summary-level failureKind so the
        // event isn't blank.
        return summaryFailureKind !== undefined ? { failureKind: summaryFailureKind } : undefined;
    }
    const firstFailedCommand = typeof failed.displayCommand === 'string' ? failed.displayCommand
        : typeof failed.command === 'string'
            ? [failed.command, ...(Array.isArray(failed.args) ? failed.args : [])].join(' ').trim()
            : undefined;
    const rawOutput = [failed.stderr, failed.stdout, failed.output]
        .filter(s => typeof s === 'string' && (s as string).length > 0)
        .join('\n');
    const outputTail = rawOutput.length > 600 ? rawOutput.slice(-600) : rawOutput;
    return {
        ...(firstFailedCommand ? { firstFailedCommand } : {}),
        ...(failed.exitCode !== undefined ? { exitCode: failed.exitCode } : {}),
        ...(failed.failureKind !== undefined ? { failureKind: failed.failureKind }
            : summaryFailureKind !== undefined ? { failureKind: summaryFailureKind } : {}),
        ...(outputTail ? { outputTail } : {}),
    };
}

/**
 * Slim the terminal-stage refine result down to the fields a coordinator needs to
 * decide next-step, dropping the heavy per-command / per-entry detail.
 *
 * The full `CommandRouterResult` (with `validationSummary.commandsRun[]` carrying
 * per-command stdout/stderr, `rejectedCommands`, `suggestions`, `suggestedConfig`,
 * the full `patchEquivalence`, and `submoduleReachability.entries[]`/`.unreachable[]`)
 * routinely exceeds 70KB and overflows the coordinator token limit when surfaced as a
 * coordinator event payload. The full detail is still persisted verbatim to the ledger
 * (`appendRefineJobLedger`) and `terminalRefineJobs`, so slimming only the EVENT loses
 * nothing — the coordinator can pull the full record on demand via
 * `evidence.ledgerCommand` / `taskHistoryKind`.
 */
export function slimRefineEventResult(result: Record<string, unknown>): Record<string, unknown> {
        const slim: Record<string, unknown> = {};
        // Top-level scalars the coordinator branches on.
        for (const key of [
            'success', 'code', 'error', 'convergenceStatus', 'blockedReason',
            'branch', 'into', 'terminalKind', 'nextStep', 'finalBranchConvergenceState',
            // QW4: merge conflict paths; QW5: cleanup branch-ref / residue warnings.
            'conflictPaths', 'branchRefWarning', 'residueWarning', 'branchRefDeleted',
        ] as const) {
            if (result[key] !== undefined) slim[key] = result[key];
        }
        // Mapped subset of the unreachable-submodule commits (path + autoPublishAllowed),
        // not the full commit records.
        if (Array.isArray(result.unreachableSubmoduleCommits)) {
            slim.unreachableSubmoduleCommits = (result.unreachableSubmoduleCommits as Array<Record<string, unknown>>)
                .map(e => ({ path: e?.path, autoPublishAllowed: e?.autoPublishAllowed }));
        }
        // Reduced validation summary — status + failure classification + config source
        // + a count of commands run (drop the full commandsRun/rejectedCommands/
        // suggestions/suggestedConfig detail).
        if (result.validationSummary && typeof result.validationSummary === 'object') {
            const vs = result.validationSummary as Record<string, unknown>;
            // QW2: attach compact failure diagnostics (first failing command + exit code
            // + failureKind + bounded output tail) so a coordinator can decide next-step
            // straight from the event without pulling the full ledger record.
            const diagnostics = vs.status === 'failed'
                ? extractValidationFailureDiagnostics(vs)
                : undefined;
            slim.validationSummary = {
                status: vs.status,
                failureCode: vs.failureCode,
                failureKind: vs.failureKind,
                configSource: vs.configSource,
                configSourceType: vs.configSourceType,
                commandsRunCount: Array.isArray(vs.commandsRun) ? vs.commandsRun.length : undefined,
                ...(diagnostics ? { failure: diagnostics } : {}),
            };
        }
        // Reduce patch-equivalence to just its verdict.
        if (result.patchEquivalence && typeof result.patchEquivalence === 'object') {
            const pe = result.patchEquivalence as Record<string, unknown>;
            slim.patchEquivalence = { status: pe.status, equivalent: pe.equivalent };
        }
        // Reduce submodule reachability to counts; drop the full entries/unreachable arrays.
        if (result.submoduleReachability && typeof result.submoduleReachability === 'object') {
            const sr = result.submoduleReachability as Record<string, unknown>;
            slim.submoduleReachability = {
                checked: Array.isArray(sr.entries) ? sr.entries.length : undefined,
                unreachable: Array.isArray(sr.unreachable) ? sr.unreachable.length : undefined,
            };
        }
        return slim;
}

export function queueRefineJobEvent(self: DaemonCommandRouter, event: 'refine:accepted' | 'refine:completed' | 'refine:failed', handle: MeshRefineJobHandle, result?: Record<string, unknown>): void {
        const slimResult = result ? slimRefineEventResult(result) : undefined;
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
            ...(slimResult ? { result: slimResult } : {}),
        };
        const eventPayload = {
            event,
            meshId: handle.meshId,
            nodeLabel: handle.targetNodeId,
            nodeId: handle.targetNodeId,
            workspace: handle.workspace,
            metadataEvent: {
                ...metadataEvent,
                // REFINE-EVENT-SESSION-SCOPED-UNICAST: mirror the session INSIDE
                // metadataEvent too. handleMeshForwardEvent reads the coordinator session
                // anchor from `metadataEvent.meshCoordinatorSessionId` (a top-level field
                // alone is dropped when the event crosses a machine boundary), so this is
                // what survives the P2P relay for a remote-executing refine.
                ...(handle.targetCoordinatorSessionId
                    ? { meshCoordinatorSessionId: handle.targetCoordinatorSessionId }
                    : {}),
            },
            queuedAt: Date.now(),
            ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
            // THE FIX: address the terminal event to the requesting coordinator SESSION,
            // not just its daemon. stampPendingEventV2 folds this into the v2 unicast
            // `intendedFor`, so identityDeliversTo's both-sides-session branch excludes a
            // sibling coordinator session on the same daemon. Absent (legacy requester) →
            // session-less intendedFor → daemon-level delivery exactly as before.
            ...(handle.targetCoordinatorSessionId ? { targetCoordinatorSessionId: handle.targetCoordinatorSessionId } : {}),
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
                    // RC32: carry the return address through the forward payload too (it
                    // already rode the queued eventPayload below). Sessionless refine has
                    // no live worker session, so injectMeshSystemMessage can only recover
                    // the coordinator anchor from this relayed field — without it the
                    // re-queued event self-fallbacks to THIS (the executing/worker)
                    // daemon and the real coordinator's drain excludes it.
                    ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
                    // REFINE-EVENT-SESSION-SCOPED-UNICAST: carry the SESSION half of the
                    // return address across the relay as well. buildRelayMetadataEvent
                    // reads meshCoordinatorSessionId (falling back to
                    // targetCoordinatorSessionId), so both spellings are supplied.
                    ...(handle.targetCoordinatorSessionId
                        ? {
                            targetCoordinatorSessionId: handle.targetCoordinatorSessionId,
                            meshCoordinatorSessionId: handle.targetCoordinatorSessionId,
                        }
                        : {}),
                    ...(slimResult ? { result: slimResult } : {}),
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

            // DS2: sync_base runs BEFORE validation. A branch that is behind base — whether
            // strictly behind (fast-forwardable) or DIVERGED (ahead>0 AND behind>0, the
            // laggard the old ancestor-only rebase missed) — is auto-rebased onto the pinned
            // baseHead here, so validation and every later gate see the FINAL rebased tree.
            const syncBase = await refineSyncBaseStage(self, ctx);
            if (syncBase.kind === 'terminal') return syncBase.result;

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
        const { stdout } = await execFileAsync('git', ['merge-base', baseHead, branchHead], { cwd, encoding: 'utf8' });
        mergeBase = stdout.trim() || undefined;
    } catch { /* unresolved base/branch — treat as no shared history */ }
    let ahead = 0;
    let behind = 0;
    try {
        // `--left-right --count base...branch` → "<behind>\t<ahead>": left (base-only) =
        // commits the branch is BEHIND; right (branch-only) = commits the branch is AHEAD.
        const { stdout } = await execFileAsync('git', ['rev-list', '--left-right', '--count', `${baseHead}...${branchHead}`], { cwd, encoding: 'utf8' });
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
                    const converge = convergeDivergedSubmoduleGitlinks(node.workspace, repoRoot, baseHead, branchHead);
                    if (converge.converged) {
                        gitlinkResolutions = converge.resolutions;
                        recordMeshRefineStage(refineStages, 'submodule_gitlink_converge', 'passed', syncStarted, {
                            reason: 'submodule_diverged_auto_rebased',
                            gitlinks: converge.gitlinks,
                        });
                        LOG.info('Mesh', `[Refinery] Auto-converged diverged submodule gitlink(s) onto base for node ${node.id}: `
                            + converge.resolutions.map(r => `${r.path}→${r.rebasedCommit.slice(0, 12)}`).join(', '));
                        // Fall through (do NOT return) → the gitlink-aware root rebase below runs.
                    } else {
                        // Fail-safe: convergence declined (conflict / unreachable / not a real
                        // divergence) → preserve the historical defer→blocked_review behavior.
                        recordMeshRefineStage(refineStages, 'submodule_gitlink_converge', 'skipped', syncStarted, {
                            reason: 'submodule_conflict_defer_to_patch_equivalence',
                            convergeReason: converge.reason,
                            gitlinks: converge.gitlinks,
                        });
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
            // When STEP 1 converged a diverged submodule gitlink, use the gitlink-aware
            // root rebase (STEP 2): git's recursive merge refuses to auto-merge the still-
            // diverged intermediate gitlink, so we drive the rebase and resolve each
            // submodule-gitlink conflict to the converged commit. A non-gitlink conflict
            // aborts and falls through to the same blocked_review handling as a plain
            // rebase conflict below (via the thrown gitlinkRebaseError).
            const rebaseStarted = Date.now();
            try {
                if (gitlinkResolutions.length > 0) {
                    const gitlinkRebase = rootRebaseResolvingGitlinks(node.workspace, baseHead, gitlinkResolutions);
                    if (!gitlinkRebase.ok) {
                        // Surface as a rebase failure so the shared blocked_review handling
                        // (submodule-hint recovery included) runs — nothing was left mid-rebase
                        // (rootRebaseResolvingGitlinks aborts on failure).
                        const err: any = new Error(`gitlink-aware rebase aborted: ${gitlinkRebase.reason || 'unknown'}`);
                        err.gitlinkRebaseReason = gitlinkRebase.reason;
                        err.gitlinkRebaseConflicts = gitlinkRebase.conflictPaths;
                        err.alreadyAborted = true;
                        throw err;
                    }
                } else {
                    execFileSync('git', ['rebase', baseHead], { cwd: node.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
                }
            } catch (rebaseErr: any) {
                if (!rebaseErr?.alreadyAborted) {
                    try { execFileSync('git', ['rebase', '--abort'], { cwd: node.workspace, stdio: 'ignore' }); } catch { /* ignore */ }
                }
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
                    const classification = await classifyPatchEquivalenceFailure(
                        repoRoot, baseHead, ctx.branchHead, submoduleHintPatchEquivalence,
                        {
                            targetBaseRef: baseHead,
                            autoPublishSubmoduleMainCommits: resolveRefineryAutoPublishSubmoduleMainCommits(ctx.mesh, node.workspace).enabled,
                        },
                    );
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
                // Generic content conflict → record patch_equivalence_after_auto_rebase failed
                // so the failing-stage classification and the ancestry regression see the
                // rebase attempt.
                recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', 'failed', rebaseStarted, {
                    error: rebaseErr?.message || String(rebaseErr),
                });
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'needs_rebase_with_conflicts',
                    convergenceStatus: 'blocked_review',
                    error: divergence.diverged
                        ? `Branch has diverged from ${baseBranch} (ahead ${divergence.ahead}, behind ${divergence.behind}) and auto-rebase onto the fetched base hit conflicts; resolve conflicts manually and retry.`
                        : `Branch is behind ${baseBranch} and auto-rebase failed due to conflicts; resolve conflicts manually and retry.`,
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
            const { stdout: rebasedHeadStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: node.workspace, encoding: 'utf8' });
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
export async function refineValidationStage(self: DaemonCommandRouter, ctx: RefineContext): Promise<RefineStageOutcome> {
            const { mesh, node, branch, baseBranch, refineStages } = ctx;
            const validationStarted = Date.now();
            const validationSummary = await runMeshRefineValidationGate(mesh, node.workspace, {
                // (a) Scope the validation command set by coarse change-impact (resolved
                // in resolve_refs). Undefined → gate runs the full command set (fail-open).
                changeImpact: ctx.changeImpact,
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
                    const classification = await classifyPatchEquivalenceFailure(
                        repoRoot, baseHead, branchHead, patchEquivalence,
                        {
                            targetBaseRef: baseHead,
                            autoPublishSubmoduleMainCommits: resolveRefineryAutoPublishSubmoduleMainCommits(mesh, node.workspace).enabled,
                        },
                    );
                    recordMeshRefineStage(refineStages, 'patch_equivalence_classification', 'failed', patchEquivalenceStarted, {
                        detailedReason: classification.detailedReason,
                        recommendedAction: classification.recommendedAction,
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
        queuePendingMeshCoordinatorEvent({
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
            const { meshId, nodeId, args, repoRoot, baseHead, node, branch, baseBranch, sourceNode, validationSummary, patchEquivalence, submoduleReachability, mesh, refineStages, execFileAsync } = ctx;

            // DS2: acquire the repoRoot+baseBranch refinement lease for the base-mutating
            // window (CAS → merge → push → cleanup). Serializes overlapping single-node
            // async refines targeting the same base so they cannot both validate against one
            // baseHead and then race their merges. The batch path is already sequential, so
            // this only contends across independent async jobs. If another refine holds it,
            // terminate retryable (base_locked) — the coordinator/batch retries after it
            // frees. Released in the finally below.
            const leaseKey = `${repoRoot}::${baseBranch}`;
            const leaseHolder = buildRefineJobKey(self, meshId, nodeId);
            if (self.refineBaseLeases.has(leaseKey) && self.refineBaseLeases.get(leaseKey) !== leaseHolder) {
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
            self.refineBaseLeases.set(leaseKey, leaseHolder);
            try {
                return await runRefineMergeAndFinalizeLocked(self, ctx);
            } finally {
                if (self.refineBaseLeases.get(leaseKey) === leaseHolder) self.refineBaseLeases.delete(leaseKey);
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

            // DS2 base-movement CAS: re-fetch origin/<baseBranch> and compare its live SHA
            // against the baseHead pinned in resolve_refs. If it advanced (a sibling/peer
            // pushed while this node validated), the merge would be onto a stale base — bail
            // retryable so the re-run rebases onto and re-validates the NEW base. Fail-open:
            // a fetch/parse error skips the check (proceed with the merge as before).
            const casStarted = Date.now();
            let baseMoved = false;
            let liveBaseHead: string | undefined;
            try {
                await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
                const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' });
                liveBaseHead = stdout.trim();
                baseMoved = !!liveBaseHead && liveBaseHead !== baseHead;
            } catch { /* fail-open: cannot verify → proceed (merge itself still guards) */ }
            if (baseMoved) {
                recordMeshRefineStage(refineStages, 'base_cas', 'failed', casStarted, {
                    pinnedBaseHead: baseHead, liveBaseHead, retryable: true,
                });
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'base_moved',
                    convergenceStatus: 'blocked_review',
                    retryable: true,
                    error: `Base ${baseBranch} advanced from ${baseHead.slice(0, 7)} to ${(liveBaseHead || '').slice(0, 7)} after this node was validated; re-run refine to rebase onto and re-validate the new base.`,
                    branch,
                    into: baseBranch,
                    pinnedBaseHead: baseHead,
                    liveBaseHead,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    refineStages,
                    finalBranchConvergenceState: {
                        branch, baseBranch, merged: false, removed: false, status: 'blocked_review',
                    },
                } };
            }
            recordMeshRefineStage(refineStages, 'base_cas', 'passed', casStarted, { pinnedBaseHead: baseHead });

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
                    await execFileAsync('git', ['merge', '--abort'], { cwd: repoRoot, encoding: 'utf8' });
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
                    await execFileAsync('git', ['push', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
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
                const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                appendLedgerEntry(meshId, {
                    kind: 'node_removed',
                    nodeId,
                    payload: { refined: true, mergedBranch: branch, into: baseBranch, pushed: true, validationSummary, patchEquivalence, submoduleReachability, submoduleAlignment },
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

export type BatchNodeConvergence = 'merged_to_main' | 'blocked_review' | 'skipped_patch_equivalent' | 'not_mergeable';

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
 * DS2: `retryable` is set for a base-movement family blocker (base_moved / base_locked)
 * — the node did NOT converge because the base advanced or was locked WHILE it ran, not
 * because of its own content. The batch gives ONLY these a second pass (they may succeed
 * once the base settles / the lease frees); a real conflict is never retried.
 */
const RETRYABLE_BASE_MOVEMENT_CODES = new Set(['base_moved', 'base_locked']);

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
            convergence: BatchNodeConvergence;
            code?: string;
            reason?: string;
            stage?: string;
            error?: string;
            retryable?: boolean;
            retried?: boolean;
            finalBranchConvergenceState?: Record<string, unknown>;
        };
        const refineOne = async (node: any): Promise<BatchNodeOutcome> => {
            let result: Record<string, unknown>;
            try {
                result = await executeMeshRefineNodeSynchronously(self, meshId, node.id, args) as Record<string, unknown>;
            } catch (e: any) {
                result = { success: false, error: e?.message || String(e) };
            }
            const { convergence, code, stage, retryable } = classifyBatchNodeConvergence(result);
            const fbcs = (result.finalBranchConvergenceState && typeof result.finalBranchConvergenceState === 'object')
                ? result.finalBranchConvergenceState as Record<string, unknown>
                : undefined;
            return {
                nodeId: node.id,
                workspace: node.workspace,
                convergence,
                ...(code ? { code } : {}),
                ...(typeof result.blockedReason === 'string' ? { reason: result.blockedReason } : {}),
                ...(stage ? { stage } : {}),
                ...(typeof result.error === 'string' ? { error: result.error } : {}),
                ...(retryable ? { retryable: true } : {}),
                ...(fbcs ? { finalBranchConvergenceState: fbcs } : {}),
            };
        };

        const results: BatchNodeOutcome[] = [];
        const retryQueue: any[] = [];
        for (const node of orderedNodes) {
            const outcome = await refineOne(node);
            results.push(outcome);
            // DS2: a base-movement blocker (base_moved / base_locked) did not converge for a
            // reason the earlier merges in THIS batch may have caused (base advanced / lease
            // held). Defer it to a single second pass AFTER the first pass finishes, when the
            // base has settled — but never retry a real conflict.
            if (outcome.retryable) retryQueue.push(node);
        }

        // ── DS2 second pass: retry ONLY the base-movement retryable nodes, once ─────
        for (const node of retryQueue) {
            const idx = results.findIndex(r => r.nodeId === node.id);
            const retried = await refineOne(node);
            retried.retried = true;
            if (idx >= 0) results[idx] = retried; else results.push(retried);
        }

        const summary = {
            merged: results.filter(r => r.convergence === 'merged_to_main').length,
            skipped: results.filter(r => r.convergence === 'skipped_patch_equivalent').length,
            blocked: results.filter(r => r.convergence === 'blocked_review').length,
            notMergeable: results.filter(r => r.convergence === 'not_mergeable').length,
            ...(retryQueue.length ? { retried: retryQueue.length } : {}),
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
        /** Requesting coordinator SESSION (REFINE-EVENT-SESSION-SCOPED-UNICAST). */
        coordinatorSessionId?: string;
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
            ...(args.coordinatorSessionId ? { targetCoordinatorSessionId: args.coordinatorSessionId } : {}),
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
            metadataEvent: {
                ...metadataEvent,
                // REFINE-EVENT-SESSION-SCOPED-UNICAST — see queueRefineJobEvent.
                ...(handle.targetCoordinatorSessionId
                    ? { meshCoordinatorSessionId: handle.targetCoordinatorSessionId }
                    : {}),
            },
            queuedAt: Date.now(),
            ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
            // THE FIX (batch half) — address the batch terminal event to the requesting
            // coordinator SESSION so a sibling session cannot consume it.
            ...(handle.targetCoordinatorSessionId ? { targetCoordinatorSessionId: handle.targetCoordinatorSessionId } : {}),
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
                    // RC32: same return-address passthrough as queueRefineJobEvent —
                    // the sessionless batch job's terminal event must stay targeted
                    // at the originating coordinator, not self-fallback to this daemon.
                    ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
                    // REFINE-EVENT-SESSION-SCOPED-UNICAST — session half of the return
                    // address, both spellings (see queueRefineJobEvent).
                    ...(handle.targetCoordinatorSessionId
                        ? {
                            targetCoordinatorSessionId: handle.targetCoordinatorSessionId,
                            meshCoordinatorSessionId: handle.targetCoordinatorSessionId,
                        }
                        : {}),
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
            // REFINE-EVENT-SESSION-SCOPED-UNICAST — carry the requester's session onto the
            // terminal batch handle (see the single-node path).
            coordinatorSessionId: handle.targetCoordinatorSessionId,
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
        // REFINE-EVENT-SESSION-SCOPED-UNICAST — see startMeshRefineJob for the rationale
        // (no self-fallback; absent → daemon-level delivery, unchanged).
        const coordinatorSessionId = typeof args?.coordinatorSessionId === 'string' && args.coordinatorSessionId.trim()
            ? args.coordinatorSessionId.trim()
            : undefined;
        const handle = buildRefineBatchJobHandle(self, { meshId, nodeIds, order, coordinatorDaemonId, coordinatorSessionId });
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

/**
 * ③ Decide whether a finished single-node refine attempt earns the ONE automatic
 * retry. Pure, so the bound is unit-testable without driving the whole pipeline.
 *
 * Delegates the retryable judgement to `classifyBatchNodeConvergence` — the exact
 * classifier the batch path's retryQueue uses — so the single-node and batch paths
 * cannot drift apart on what "retryable" means. Only the base-movement family
 * (base_moved / base_locked) qualifies; a real conflict never does.
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
        let result = await runRefinePipelineOnce(self, handle.meshId, handle.targetNodeId, args);

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
            result = await runRefinePipelineOnce(self, handle.meshId, handle.targetNodeId, args);
            // Whatever this attempt produced is terminal — success, a different failure, or
            // the same base-movement blocker. It is NOT retried again.
            result = { ...result, refineRetried: true, refineRetryOfCode: firstAttempt.code };
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
                // QW3: the validation stage returns `code: validationSummary.failureCode`,
                // so a dependency/spawn failure surfaces as one of these codes — NOT the
                // literal 'validation_failed'. They must map to the validation_failed
                // terminal kind too, otherwise they fell through to the merge_failed
                // fallback and coordinators saw a merge failure for a missing-deps block.
                : refineCode === 'validation_failed' || refineCode === 'validation_dependencies_missing'
                    || refineCode === 'missing_dependencies' || refineCode === 'dependency_bootstrap_failed'
                    || refineCode === 'spawn_resolution_failed' || refineCode === 'validation_unavailable'
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
            // Detailed patch-equivalence sub-cause classification (base_divergence,
            // submodule_unreachable, actual_patch_diff, trivial_ff_misjudgment,
            // already_converged, unclassified) + recommended action + evidence.
            // Promoted onto blockerContext so coordinators reading task_failed ledger
            // entries see the cause without parsing the free-form error string.
            if (typeof result.detailedReason === 'string') ctx.detailedReason = result.detailedReason;
            if (typeof result.detailedReasonDescription === 'string') ctx.detailedReasonDescription = result.detailedReasonDescription;
            if (typeof result.recommendedAction === 'string') ctx.recommendedAction = result.recommendedAction;
            if (result.evidence && typeof result.evidence === 'object') ctx.evidence = result.evidence;
            // Patch equivalence details
            if (stage === 'patch_equivalence' && result.patchEquivalence) {
                const pe = result.patchEquivalence as Record<string, unknown>;
                ctx.details = {
                    expectedPatchId: pe.expectedPatchId,
                    actualPatchId: pe.actualPatchId,
                    status: pe.status,
                    actionableHint: pe.actionableHint,
                    error: pe.error,
                    ...(typeof result.detailedReason === 'string' ? { detailedReason: result.detailedReason } : {}),
                    ...(typeof result.recommendedAction === 'string' ? { recommendedAction: result.recommendedAction } : {}),
                    ...(result.evidence && typeof result.evidence === 'object' ? { evidence: result.evidence } : {}),
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
                // QW2: same compact failure diagnostics the slim event carries, so the
                // ledger blockerContext is self-describing (first failing command + exit
                // code + failureKind + output tail) without a second commandsRun lookup.
                const diagnostics = extractValidationFailureDiagnostics(vs);
                ctx.details = {
                    failureCode: vs.failureCode,
                    failureKind: vs.failureKind,
                    commandsRun: Array.isArray(vs.commandsRun) ? vs.commandsRun.length : undefined,
                    ...(diagnostics ? { failure: diagnostics } : {}),
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
            // REFINE-EVENT-SESSION-SCOPED-UNICAST: carry the requester's session from the
            // accepted handle onto the TERMINAL handle. Dropping it here would leave the
            // completed/failed event — the one the coordinator actually waits on — back at
            // daemon-level addressing, i.e. the original defect.
            coordinatorSessionId: handle.targetCoordinatorSessionId,
        });
        const terminal: MeshRefineTerminalJob = { ...terminalHandle, result: normalizedResult };
        self.terminalRefineJobs.set(key, terminal);
        self.runningRefineJobs.delete(key);
        self.invalidateAggregateMeshStatus(handle.meshId);
        await appendRefineJobLedger(self, isTerminalSuccess ? 'task_completed' : 'task_failed', terminalHandle, normalizedResult);
        queueRefineJobEvent(self, isTerminalSuccess ? 'refine:completed' : 'refine:failed', terminalHandle, normalizedResult);
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
                    return execFileSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8' }).trim();
                } catch { return ''; }
            })();
        if (!branch) return;

        const baseBranch = (() => {
            try {
                return execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim() || 'main';
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
        const handle = buildRefineJobHandle(self, { meshId, nodeId, node, retryOfJobId: terminal?.jobId, coordinatorDaemonId, coordinatorSessionId });
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
            void finishMeshRefineJob(self, handle, args);
        });

        return handle;
    }
