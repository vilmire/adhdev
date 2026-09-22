/**
 * Batch Refinery job orchestration — extracted from router-refine.ts (pure move,
 * no behavior change) to keep that file under the repo file-size gate, following
 * the router-refine-resume.ts precedent.
 *
 * This module owns the multi-node batch pipeline: plan/ordering (batchRefineMeshNodes),
 * the shared convergence core (runMeshRefineBatchConvergence), the async batch job
 * lifecycle (startMeshRefineBatchJob / finishMeshRefineBatchJob) and its event/ledger
 * plumbing. The per-node refine pipeline and the shared convergence CLASSIFIER
 * (classifyBatchNodeConvergence — also used by the single-node auto-retry) stay in
 * router-refine.ts; this module calls back into them, mirroring how
 * router-refine-resume.ts consumes single-node helpers. router-refine.ts re-exports
 * everything here, so existing import sites are unaffected.
 */
import type { DaemonCommandRouter, CommandRouterResult } from './router.js';
import { LOG } from '../logging/logger.js';
import { createInteractionId } from '../logging/debug-trace.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../mesh/mesh-events.js';
import { analyzeMeshRefineNodeChangeArea, orderMeshRefineBatchNodes } from '../mesh/mesh-refine-batch.js';
import { buildMeshRefineBatchDryRunResult } from '../mesh/mesh-refine-submodule-preflight.js';
import { gitChildEnv } from '../git/git-locale.js';
import {
    MeshRefineBatchJobHandle,
    MeshRefineBatchJobStatus,
    MeshRefineBatchTerminalJob,
} from '../mesh/mesh-refine-gates.js';
// REFINE-CONCURRENCY-CAP: process-wide serial execution of refine pipelines —
// see mesh-refine-concurrency.ts for the freeze RCA this comes from.
import { runWithRefineExecutionSlot } from '../mesh/mesh-refine-concurrency.js';
// ★B3/B4 chain abort — base-axis vs node-local failure classification.
import {
    decideRefineBatchChainAbort,
    buildSkippedChainNodeOutcome,
    buildChainAbortNextStep,
    type RefineBatchChainAbortDecision,
} from '../mesh/mesh-refine-batch-chain-abort.js';
// ★B1/B2 progress + immediate failure notification.
import { emitRefineProgress, type RefineProgressContext, type RefineProgressEvent } from '../mesh/mesh-refine-progress.js';
// ★REFINE-BASE-PREFLIGHT — the batch uses it only to WARN on the dry-run plan; the
// blocking check is the per-node pipeline's first stage (refineBasePreflightStage).
import {
    assessRefineAcceptPreflight,
    buildRefineAcceptPreflightWarning,
    resolveRefineBaseRepoRoot,
} from '../mesh/mesh-refine-accept-preflight.js';
import {
    classifyBatchNodeConvergence,
    executeMeshRefineNodeSynchronously,
    type BatchNodeConvergence,
} from './router-refine.js';

/**
 * IPC-ACCEPT-ASYNC-BOUNDARY (2026-09-13): budget for the PLAN-phase `git fetch origin
 * <base>` that seeds change-area ordering. Deliberately shorter than the shared
 * GIT_NETWORK_TIMEOUT_MS (30s): this fetch is a best-effort ordering input, not a
 * correctness requirement — on timeout resolveBaseRef falls through to local refs and the
 * batch still converges, because every node's own refine re-fetches origin/<base> under
 * the full network budget before its patch-equivalence check. The old 30s exactly equalled
 * the caller's outer IPC deadline, so a single slow remote consumed the entire budget.
 */
const BATCH_PLAN_FETCH_TIMEOUT_MS = 10_000;

/**
 * Emit a batch progress event when a progress channel was supplied.
 *
 * A no-op without a context, so every pre-existing caller of
 * runMeshRefineBatchConvergence (the synchronous entry, tests) behaves exactly as
 * before. Delegates the throttle/admission decision to mesh-refine-progress.ts
 * rather than re-implementing it here.
 */
function emitRefineBatchProgress(
    context: RefineProgressContext | undefined,
    event: RefineProgressEvent,
): void {
    if (!context) return;
    emitRefineProgress(context, event);
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
        //
        // IPC-ACCEPT-ASYNC-BOUNDARY: the per-node loop below runs in PARALLEL, so these
        // caches memoize the in-flight PROMISE, not the settled value. Caching the value
        // only (the previous shape, safe under a sequential loop) would let N concurrent
        // siblings of one repoRoot all miss the cache and each run their own `git fetch`,
        // turning the dedup into an N-way stampede on the same remote.
        const repoRootBaseRef = new Map<string, Promise<string>>();
        const submodulePathsByRepoRoot = new Map<string, Promise<Set<string>>>();
        const resolveBaseRef = (repoRoot: string): Promise<string> => {
            const cached = repoRootBaseRef.get(repoRoot);
            if (cached) return cached;
            const pending = (async (): Promise<string> => {
                let baseBranch = 'main';
                try {
                    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
                    if (stdout.trim()) baseBranch = stdout.trim();
                } catch { /* fall back to main */ }
                let baseRef = 'HEAD';
                try {
                    // `timeout` mirrors the async sibling call sites in `mesh-fast-forward.ts`:
                    // without it an unreachable remote hangs this await forever, so the refine
                    // job never completes and holds its node slot indefinitely.
                    //
                    // IPC-ACCEPT-ASYNC-BOUNDARY: bounded by the PLAN-scoped 10s budget, not the
                    // 30s network default. This fetch is an ordering-input optimization — on
                    // timeout the catch below falls through to local refs and the batch still
                    // converges (each node's own refine re-fetches origin/<base> anyway). The
                    // old 30s exactly equalled the caller's outer IPC deadline, leaving zero
                    // headroom for everything else in the plan.
                    await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv(), timeout: BATCH_PLAN_FETCH_TIMEOUT_MS });
                } catch { /* offline / no remote / timed out — fall through to local refs */ }
                try {
                    const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
                    baseRef = stdout.trim();
                } catch {
                    try {
                        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
                        baseRef = stdout.trim();
                    } catch { /* leave HEAD */ }
                }
                return baseRef;
            })();
            repoRootBaseRef.set(repoRoot, pending);
            return pending;
        };

        const resolveSubmodulePaths = (repoRoot: string): Promise<Set<string>> => {
            const cached = submodulePathsByRepoRoot.get(repoRoot);
            if (cached) return cached;
            const pending = (async (): Promise<Set<string>> => {
                // Resolve declared submodule paths once per repo root.
                const subPaths = new Set<string>();
                try {
                    const { stdout } = await execFileAsync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
                    for (const line of stdout.split('\n')) {
                        const trimmed = line.trim();
                        const spaceIdx = trimmed.indexOf(' ');
                        if (spaceIdx === -1) continue;
                        const value = trimmed.slice(spaceIdx + 1).trim();
                        if (value) subPaths.add(value);
                    }
                } catch { return new Set<string>(); }
                return subPaths;
            })();
            submodulePathsByRepoRoot.set(repoRoot, pending);
            return pending;
        };

        // IPC-ACCEPT-ASYNC-BOUNDARY: probe every node CONCURRENTLY. Each node's probes read
        // only its own workspace (plus the per-repoRoot caches above, which dedup themselves
        // by memoized promise), so there is no cross-node dependency to serialize on — the
        // old sequential loop simply paid N x (branch + rev-parse + diff) in wall-clock, and
        // the first node of each repoRoot additionally blocked its siblings behind the fetch.
        // Promise.all preserves INPUT order in its result, which orderMeshRefineBatchNodes
        // relies on for its stable tie-break — do not switch to push-on-completion.
        const changeAreas: Array<Awaited<ReturnType<typeof analyzeMeshRefineNodeChangeArea>>> = await Promise.all(
            targetNodes.map(async (node) => {
                const repoRoot = resolveRepoRootFor(node);
                let branch = typeof node.worktreeBranch === 'string' ? node.worktreeBranch : '';
                try {
                    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8', env: gitChildEnv() });
                    if (stdout.trim()) branch = stdout.trim();
                } catch { /* use stored worktreeBranch */ }

                if (!repoRoot || !branch) {
                    return {
                        nodeId: node.id, workspace: node.workspace, branch: branch || '(unknown)',
                        changedTopLevelPaths: [], changedFiles: [], touchedSubmodulePaths: [],
                        touchesSubmodule: false, aheadCount: 0,
                        error: !repoRoot ? 'source repoRoot not found' : 'branch not resolved',
                    };
                }

                const [submodulePaths, baseRef] = await Promise.all([
                    resolveSubmodulePaths(repoRoot),
                    resolveBaseRef(repoRoot),
                ]);
                let branchRef = branch;
                try {
                    const { stdout } = await execFileAsync('git', ['rev-parse', branch], { cwd: node.workspace, encoding: 'utf8', env: gitChildEnv() });
                    branchRef = stdout.trim() || branch;
                } catch { /* use branch name */ }
                return analyzeMeshRefineNodeChangeArea({
                    nodeId: node.id,
                    workspace: node.workspace,
                    branch,
                    baseRef,
                    branchRef,
                    diffCwd: node.workspace,
                    repoRoot,
                    submodulePaths,
                });
            }),
        );

        const ordering = orderMeshRefineBatchNodes(changeAreas);
        const orderedNodes = ordering.order
            .map(nodeId => targetNodes.find(n => meshNodeIdMatches(n, nodeId)))
            .filter((n): n is any => !!n);

        const dryRun = args?.dryRun !== false && args?.execute !== true;
        if (dryRun) {
            // Dry-run result assembly + the submodule reachability preflight live in
            // mesh-refine-submodule-preflight.ts (this file is at its frozen size baseline).
            return buildMeshRefineBatchDryRunResult({ mesh, orderedNodes, ordering });
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
        /**
         * ★B1/B2 progress channel. Optional so the synchronous batch entry (and every
         * existing caller/test) keeps working unchanged — absent means no progress
         * events, never an error. The async job path supplies it.
         */
        progressContext?: RefineProgressContext,
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
                // ★B1: hand the node's pipeline the batch progress channel so slow gates
                // are announced under the batch's job identity.
                result = await executeMeshRefineNodeSynchronously(self, meshId, node.id,
                    progressContext ? { ...args, progressContext } : args) as Record<string, unknown>;
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
        // ★B3 CHAIN-ABORT state. Set when a node fails on the BASE axis, at which point
        // every remaining node is determined to fail for the same reason — see
        // mesh-refine-batch-chain-abort.ts for why this is base-axis-only and why a
        // node-local failure must still let the batch continue.
        let chainAbort: { precursorNodeId: string; decision: RefineBatchChainAbortDecision } | undefined;
        const skippedNodeIds: string[] = [];
        for (const [index, node] of orderedNodes.entries()) {
            if (chainAbort) {
                // Not attempted — recorded as skipped, never as a failure (nothing was measured).
                results.push(buildSkippedChainNodeOutcome({
                    nodeId: node.id,
                    workspace: node.workspace,
                    precursorNodeId: chainAbort.precursorNodeId,
                    decision: chainAbort.decision,
                }) as unknown as BatchNodeOutcome);
                skippedNodeIds.push(node.id);
                continue;
            }
            // ★B1 PROGRESS: node transition — one event per node, not per gate.
            emitRefineBatchProgress(progressContext, {
                phase: 'node_started',
                nodeId: node.id,
                nodeIndex: index + 1,
                nodeCount: orderedNodes.length,
            });
            const outcome = await refineOne(node);
            results.push(outcome);
            // ★B2 IMMEDIATE FAILURE NOTIFICATION: emit the moment a node fails, rather
            // than only in the batch's terminal event. A coordinator can start fixing while
            // the remaining nodes are still running (or, on a chain abort, immediately).
            if (outcome.convergence === 'blocked_review' || outcome.convergence === 'not_mergeable') {
                emitRefineBatchProgress(progressContext, {
                    phase: 'node_failed',
                    nodeId: node.id,
                    nodeIndex: index + 1,
                    nodeCount: orderedNodes.length,
                    convergence: outcome.convergence,
                    ...(outcome.code ? { code: outcome.code } : {}),
                    ...(outcome.stage ? { stage: outcome.stage } : {}),
                    ...(outcome.error ? { errorTail: outcome.error.slice(-600) } : {}),
                });
            } else {
                emitRefineBatchProgress(progressContext, {
                    phase: 'node_finished',
                    nodeId: node.id,
                    nodeIndex: index + 1,
                    nodeCount: orderedNodes.length,
                    convergence: outcome.convergence,
                });
            }
            // DS2: a base-movement blocker (base_moved / base_locked) did not converge for a
            // reason the earlier merges in THIS batch may have caused (base advanced / lease
            // held). Defer it to a single second pass AFTER the first pass finishes, when the
            // base has settled — but never retry a real conflict.
            //
            // ★Ordering matters: a retryable base-movement node goes to the retry queue and
            // does NOT abort the chain, because the second pass is exactly the mechanism that
            // resolves it. Only a base-axis failure with no retry left stops the batch.
            if (outcome.retryable) {
                retryQueue.push(node);
                continue;
            }
            const decision = decideRefineBatchChainAbort(outcome);
            if (decision.abort) {
                chainAbort = { precursorNodeId: outcome.nodeId, decision };
                LOG.warn('Mesh', `[Refinery] Batch chain-abort after node ${outcome.nodeId}: ${decision.reason}`);
                emitRefineBatchProgress(progressContext, {
                    phase: 'chain_abort',
                    nodeId: outcome.nodeId,
                    nodeIndex: index + 1,
                    nodeCount: orderedNodes.length,
                    ...(decision.code ? { code: decision.code } : {}),
                    ...(decision.stage ? { stage: decision.stage } : {}),
                    reason: decision.reason,
                });
            }
        }

        // ── DS2 second pass: retry ONLY the base-movement retryable nodes, once ─────
        // Skipped when the chain aborted: the base is known-bad, so a retry would spend a
        // full gate set to re-derive the failure the abort already established.
        for (const node of chainAbort ? [] : retryQueue) {
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
            // ★Counted separately from `skipped` (patch-equivalent, a SUCCESS state):
            // a chain-skipped node was never attempted and still needs a run, so folding
            // the two together would report un-run work as converged.
            ...(skippedNodeIds.length ? { chainSkipped: skippedNodeIds.length } : {}),
            ...(retryQueue.length && !chainAbort ? { retried: retryQueue.length } : {}),
        };
        // A chain-aborted batch has NOT converged even if no node is blocked/not_mergeable:
        // the skipped nodes are outstanding work, and reporting allConverged would tell the
        // coordinator the batch is done.
        const allConverged = summary.blocked === 0 && summary.notMergeable === 0 && !chainAbort;
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
            ...(chainAbort ? {
                chainAbort: {
                    precursorNodeId: chainAbort.precursorNodeId,
                    code: chainAbort.decision.code,
                    stage: chainAbort.decision.stage,
                    reason: chainAbort.decision.reason,
                    skippedNodeIds,
                },
            } : {}),
            ...(allConverged ? {} : {
                // ★B4: when the batch aborted, lead with the ROOT CAUSE and say the rest was
                // never attempted — otherwise N lookalike failures read as N problems.
                nextStep: chainAbort
                    ? buildChainAbortNextStep({
                        precursorNodeId: chainAbort.precursorNodeId,
                        decision: chainAbort.decision,
                        skippedNodeIds,
                    })
                    // Name the failed nodes inline — the aggregate nextStep used to hide
                    // WHICH nodes blocked, forcing a manual git-log cross-check.
                    : `Resolve blocked_review / not_mergeable nodes manually — failed: ${results.filter(r => r.convergence === 'blocked_review' || r.convergence === 'not_mergeable').map(r => `${r.nodeId}${r.code ? ` [${r.code}]` : ''}`).join(', ')} (see per-node code/stage/error), then re-run mesh_refine_batch for the remaining nodes.`,
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
        // ★B1/B2: the async batch job is the path a coordinator WAITS on, so it is the
        // path that reports progress. The context carries the same return address as the
        // terminal events, so progress and completion route identically.
        const progressContext: RefineProgressContext = {
            meshId: handle.meshId,
            jobId: handle.jobId,
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
            coordinatorSessionId: handle.targetCoordinatorSessionId,
        };
        try {
            result = await runMeshRefineBatchConvergence(self, handle.meshId, orderedNodes, ordering, args, progressContext) as Record<string, unknown>;
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
     * Resolve the batch plan and run the convergence loop. Everything here happens AFTER
     * the caller has already been told `accepted` (IPC-ACCEPT-ASYNC-BOUNDARY), so this
     * function must never throw into its caller and must always drive the job to a
     * terminal event — a plan failure is a terminal FAILURE event, not a thrown rejection.
     *
     * The plan's `order` / `orderingRationale` / `plan` are unknown at accept time, so they
     * are published here on the refine:accepted event instead of in the accept response.
     */
async function planThenRunMeshRefineBatchJob(self: DaemonCommandRouter,
        handle: MeshRefineBatchJobHandle,
        meshId: string,
        requestedNodeIds: string[] | undefined,
        args: any,
    ): Promise<void> {
        const key = buildRefineBatchJobKey(self, meshId);
        const failTerminally = async (error: string, extra?: Record<string, unknown>): Promise<void> => {
            const completedAt = new Date().toISOString();
            const terminalHandle = buildRefineBatchJobHandle(self, {
                meshId,
                nodeIds: handle.nodeIds,
                order: handle.order,
                status: 'failed',
                startedAt: handle.startedAt,
                completedAt,
                jobId: handle.jobId,
                interactionId: handle.interactionId,
                coordinatorDaemonId: handle.targetCoordinatorDaemonId,
                coordinatorSessionId: handle.targetCoordinatorSessionId,
            });
            const result = { success: false, batch: true, error, ...(extra ?? {}) };
            self.terminalRefineBatchJobs.set(key, { ...terminalHandle, result });
            self.runningRefineBatchJobs.delete(key);
            self.invalidateAggregateMeshStatus(meshId);
            await appendRefineBatchJobLedger(self, 'task_failed', terminalHandle, result);
            queueRefineBatchJobEvent(self, 'refine:failed', terminalHandle, result);
        };

        let planRecord: Record<string, unknown>;
        try {
            planRecord = await batchRefineMeshNodes(self, meshId, requestedNodeIds, { ...args, dryRun: true, execute: false }) as Record<string, unknown>;
        } catch (e: any) {
            await failTerminally(e?.message || String(e), { stage: 'plan' });
            return;
        }
        if (planRecord.success !== true) {
            // Target/ordering errors used to surface synchronously in the accept reply.
            // They are now terminal failure events carrying the same plan fields.
            await failTerminally(
                typeof planRecord.error === 'string' ? planRecord.error : 'Batch plan failed',
                { stage: 'plan', plan: planRecord },
            );
            return;
        }

        const order = Array.isArray(planRecord.order) ? (planRecord.order as unknown[]).filter((v): v is string => typeof v === 'string') : [];
        const nodeIds = order.slice();

        // Re-resolve the ordered node objects against current membership so the job refines
        // real nodes (the plan only carries ids). preferInline matches refine_mesh_node.
        const meshRecord = await self.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const allNodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
        const orderedNodes = nodeIds
            .map(id => allNodes.find(n => meshNodeIdMatches(n, id)))
            .filter((n): n is any => !!n);

        if (nodeIds.length === 0 || orderedNodes.length === 0) {
            // No convergeable nodes. Previously returned synchronously as a non-async success;
            // now a terminal event so the already-accepted job still reaches a terminal state.
            const completedAt = new Date().toISOString();
            const terminalHandle = buildRefineBatchJobHandle(self, {
                meshId,
                nodeIds,
                order,
                status: 'completed',
                startedAt: handle.startedAt,
                completedAt,
                jobId: handle.jobId,
                interactionId: handle.interactionId,
                coordinatorDaemonId: handle.targetCoordinatorDaemonId,
                coordinatorSessionId: handle.targetCoordinatorSessionId,
            });
            const result = {
                ...planRecord,
                success: true,
                batch: true,
                dryRun: false,
                nodeCount: 0,
                results: [],
                note: nodeIds.length === 0
                    ? 'No convergeable local worktree nodes found.'
                    : 'Batch nodes no longer resolvable in mesh.',
            };
            self.terminalRefineBatchJobs.set(key, { ...terminalHandle, result });
            self.runningRefineBatchJobs.delete(key);
            self.invalidateAggregateMeshStatus(meshId);
            await appendRefineBatchJobLedger(self, 'task_completed', terminalHandle, result);
            queueRefineBatchJobEvent(self, 'refine:completed', terminalHandle, result);
            return;
        }

        const ordering = { order, rationale: planRecord.orderingRationale };

        // Publish the resolved plan on the accepted event — this is where order /
        // orderingRationale / plan now reach the coordinator (they left the accept reply
        // because resolving them is exactly the pre-accept cost this fix removed). The
        // handle is re-built so nodeIds/order/nodeCount/batchLabel are the REAL values
        // rather than the empty placeholders the accept reply carried.
        const plannedHandle = buildRefineBatchJobHandle(self, {
            meshId,
            nodeIds,
            order,
            status: 'accepted',
            startedAt: handle.startedAt,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
            coordinatorSessionId: handle.targetCoordinatorSessionId,
        });
        self.runningRefineBatchJobs.set(key, plannedHandle);
        await appendRefineBatchJobLedger(self, 'task_dispatched', plannedHandle);
        queueRefineBatchJobEvent(self, 'refine:accepted', plannedHandle, {
            success: true,
            batch: true,
            phase: 'planned',
            order,
            orderingRationale: planRecord.orderingRationale,
            plan: planRecord.plan,
            nodeIds,
            nodeCount: nodeIds.length,
        });

        // REFINE-CONCURRENCY-CAP: the batch pipeline runs through the shared execution
        // slot — a second accepted job waits instead of overlapping its 19-gate npm/vitest
        // load with the running one.
        await runWithRefineExecutionSlot(`batch ${plannedHandle.jobId} (mesh ${meshId})`,
            () => finishMeshRefineBatchJob(self, plannedHandle, orderedNodes, ordering, args));
    }

    /**
     * Async entry for the batch Refinery execute path.
     *
     * IPC-ACCEPT-ASYNC-BOUNDARY (2026-09-13): this used to be only HALF async. It awaited
     * the FULL plan (per-node git branch/rev-parse/diff probes plus a 30s-bounded
     * `git fetch origin <base>`, scaling with node count) and only then replied `accepted`,
     * so a local batch_refine over several nodes routinely blew the caller's IPC deadline.
     * The job still ran to completion in the background, so the coordinator read a
     * TIMEOUT on work that was actually succeeding — and a retry would have double-dispatched.
     *
     * Now the accept reply is sub-ms and node-count independent: handle → register →
     * refine:accepted → setImmediate(plan → convergence).
     *
     * ★Contract change: the accept response no longer carries `order`, `orderingRationale`
     * or `plan` — those cannot exist before the plan runs. They are delivered on the
     * refine:accepted event (`result.phase === 'planned'`) and again on the terminal event,
     * which is the channel the coordinator already consumes for this job. Target/ordering
     * errors likewise became terminal refine:failed events rather than a synchronous error.
     *
     * dryRun is UNCHANGED and still fully synchronous — the plan IS the dry-run's product,
     * so there is nothing to defer (and plan_mesh_refine_node carries its own 45s budget).
     *
     * Idempotent: a batch already in flight for this mesh returns the running handle with
     * duplicate:true rather than spawning a second background job.
     */
/**
 * The base repo root a batch would merge into: the first target node that
 * resolves one. Shared by the execute refusal and the dry-run warning so the two
 * can never disagree about WHICH base they are describing.
 */
async function resolveBatchBaseRepoRoot(
    self: DaemonCommandRouter,
    meshId: string,
    requestedNodeIds: string[] | undefined,
    args: any,
): Promise<string | undefined> {
    const mesh = (await self.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true }))?.mesh;
    const allNodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    const candidates = Array.isArray(requestedNodeIds) && requestedNodeIds.length > 0
        ? requestedNodeIds.map(id => allNodes.find(n => meshNodeIdMatches(n, id))).filter(Boolean)
        : allNodes.filter(n => n?.isLocalWorktree && typeof n.workspace === 'string' && n.workspace);
    for (const node of candidates) {
        const repoRoot = resolveRefineBaseRepoRoot({ node, nodes: allNodes, nodeIdMatches: meshNodeIdMatches });
        if (repoRoot) return repoRoot;
    }
    return undefined;
}

/**
 * ★REFINE-ACCEPT-BASE-PREFLIGHT (batch dry-run). The same verdict, attached to
 * the PLAN as a warning instead of refusing it.
 *
 * Design judgement (owner-posed): a dry-run is a planning aid, and a plan
 * computed on a dirty base is still a correct plan — the ordering and the change
 * areas do not depend on base cleanliness. Refusing it would remove a useful
 * capability to prevent nothing, since a dry-run mutates and dispatches nothing.
 * But a coordinator that reads a clean-looking plan and then calls execute walks
 * into the refusal, so the plan carries the finding and says so explicitly.
 */
async function attachBatchBasePreflightWarning(
    self: DaemonCommandRouter,
    meshId: string,
    requestedNodeIds: string[] | undefined,
    args: any,
    plan: CommandRouterResult,
): Promise<CommandRouterResult> {
    try {
        const repoRoot = await resolveBatchBaseRepoRoot(self, meshId, requestedNodeIds, args);
        if (!repoRoot) return plan;
        // ★refreshUpstream here and ONLY here: the dry-run is synchronous and has already
        // paid a `git fetch` to compute change-area ordering, and it is bound by the
        // planning budget rather than the sub-250ms accept contract. This is therefore the
        // one place the divergence axis can be evaluated without a latency regression —
        // and the useful one, since a coordinator plans before it executes.
        const verdict = await assessRefineAcceptPreflight({ repoRoot, refreshUpstream: true });
        if (verdict.ok) return plan;
        return { ...plan, ...buildRefineAcceptPreflightWarning(verdict) };
    } catch {
        // A warning that cannot be computed is simply absent — never a plan failure.
        return plan;
    }
}

export async function startMeshRefineBatchJob(self: DaemonCommandRouter, meshId: string, requestedNodeIds: string[] | undefined, args: any): Promise<CommandRouterResult> {
        // Dry-run: the plan IS the deliverable, so resolve it synchronously as before.
        // The med-family handler already routes dry-run to batchRefineMeshNodes directly,
        // so this is defence-in-depth for any other caller — the condition is kept
        // character-identical to that handler's so the two can never disagree.
        if (args?.dryRun !== false && args?.execute !== true) {
            const plan = await batchRefineMeshNodes(self, meshId, requestedNodeIds, { ...args, dryRun: true, execute: false });
            // ★Warn-only on the dry-run: the plan is still valid, but execute would be
            // refused, and the coordinator should learn that here rather than one call later.
            return attachBatchBasePreflightWarning(self, meshId, requestedNodeIds, args, plan);
        }

        const key = buildRefineBatchJobKey(self, meshId);
        const running = self.runningRefineBatchJobs.get(key);
        if (running) return { ...running, duplicate: true };

        // ★No base preflight here: it runs as the per-node pipeline's FIRST STAGE
        // (refineBasePreflightStage), which is both cheaper for the accept path — bound
        // by IPC-ACCEPT-ASYNC-BOUNDARY — and strictly better for the batch. The first
        // node's stage blocks in milliseconds, its verdict is a base-axis failure, and
        // the chain abort then skips every remaining node without running a single gate.
        // That is the full saving from incident 2, with no accept-time cost at all.

        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : (self.deps.statusInstanceId || undefined);
        // REFINE-EVENT-SESSION-SCOPED-UNICAST — see startMeshRefineJob for the rationale
        // (no self-fallback; absent → daemon-level delivery, unchanged).
        const coordinatorSessionId = typeof args?.coordinatorSessionId === 'string' && args.coordinatorSessionId.trim()
            ? args.coordinatorSessionId.trim()
            : undefined;

        // The target set is not known yet (that is the plan's job, now deferred), so the
        // accept handle carries empty nodeIds/order. planThenRunMeshRefineBatchJob replaces
        // this registration with the planned handle as soon as the plan resolves, and the
        // jobId/interactionId are stable across both so the coordinator can correlate.
        const handle = buildRefineBatchJobHandle(self, { meshId, nodeIds: [], order: [], coordinatorDaemonId, coordinatorSessionId });
        self.runningRefineBatchJobs.set(key, handle);

        setImmediate(() => {
            void planThenRunMeshRefineBatchJob(self, handle, meshId, requestedNodeIds, args)
                .catch(async (e: any) => {
                    // Last-resort guard: the accept reply is already out, so a leaked
                    // rejection would strand the job in runningRefineBatchJobs forever and
                    // block every subsequent batch for this mesh on the duplicate check.
                    LOG.warn('Mesh', `[Refinery] Async refine batch job ${handle.jobId} failed outside its terminal path: ${e?.message || e}`);
                    self.runningRefineBatchJobs.delete(key);
                    self.invalidateAggregateMeshStatus(meshId);
                });
        });

        return {
            ...handle,
            note: 'Batch convergence accepted. The target set and ordering are resolved in the background and arrive on the refine:accepted event; completion/failure (with per-node results) arrives as a terminal refine event. Do not poll repeatedly.',
        };
    }
