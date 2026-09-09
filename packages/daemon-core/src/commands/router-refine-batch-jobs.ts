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
import {
    classifyBatchNodeConvergence,
    executeMeshRefineNodeSynchronously,
    type BatchNodeConvergence,
} from './router-refine.js';

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
                const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
                if (stdout.trim()) baseBranch = stdout.trim();
            } catch { /* fall back to main */ }
            let baseRef = 'HEAD';
            try {
                // `timeout` mirrors the async sibling call sites in `mesh-fast-forward.ts`:
                // without it an unreachable remote hangs this await forever, so the refine
                // job never completes and holds its node slot indefinitely.
                await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv(), timeout: 30_000 });
            } catch { /* offline / no remote — fall through to local refs */ }
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
                baseRef = stdout.trim();
            } catch {
                try {
                    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
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
                const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8', env: gitChildEnv() });
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
                    const { stdout } = await execFileAsync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], { cwd: repoRoot, encoding: 'utf8', env: gitChildEnv() });
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
                const { stdout } = await execFileAsync('git', ['rev-parse', branch], { cwd: node.workspace, encoding: 'utf8', env: gitChildEnv() });
                branchRef = stdout.trim() || branch;
            } catch { /* use branch name */ }
            changeAreas.push(await analyzeMeshRefineNodeChangeArea({
                nodeId: node.id,
                workspace: node.workspace,
                branch,
                baseRef,
                branchRef,
                diffCwd: node.workspace,
                repoRoot,
                submodulePaths: submodulePathsByRepoRoot.get(repoRoot)!,
            }));
        }

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
                // Name the failed nodes inline — the aggregate nextStep used to hide
                // WHICH nodes blocked, forcing a manual git-log cross-check.
                nextStep: `Resolve blocked_review / not_mergeable nodes manually — failed: ${results.filter(r => r.convergence === 'blocked_review' || r.convergence === 'not_mergeable').map(r => `${r.nodeId}${r.code ? ` [${r.code}]` : ''}`).join(', ')} (see per-node code/stage/error), then re-run mesh_refine_batch for the remaining nodes.`,
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
            // REFINE-CONCURRENCY-CAP: the batch pipeline runs through the shared
            // execution slot — a second accepted job waits instead of overlapping
            // its 19-gate npm/vitest load with the running one.
            void runWithRefineExecutionSlot(`batch ${handle.jobId} (mesh ${meshId})`,
                () => finishMeshRefineBatchJob(self, handle, orderedNodes, ordering, args));
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
