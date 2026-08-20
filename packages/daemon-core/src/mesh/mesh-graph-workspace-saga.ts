/**
 * GRAPH-ORCHESTRATION Phase D — delayed workspace_ref saga + compensation.
 *
 * Design SoT: docs/design/2026-08-18-graph-orchestration-full.md :441-511.
 *
 * Worktree preparation is an idempotent, leased saga with owned-resource
 * compensation. It is NEVER a worker task or a scheduler vertex (design :987)
 * and NEVER claimed to be atomic with SQLite (design :993). Every git /
 * filesystem step runs OUTSIDE a transaction; the DB only records saga state,
 * leases, and the resolved node id.
 *
 * State machine:
 *   declared → preparing → ready
 *                         ↘ failed                  (clone/preflight failed; no leftover or leftover isolated)
 *                         ↘ compensating → compensated
 *                                       ↘ compensation_required  (safety refused delete)
 *
 * Crash recovery (design :493-507): a restart scans expired leases and
 * resumes. Clone-success-before-finalize is recovered by detecting the owned
 * worktree (owner tag) and finishing the same intent — never a second clone.
 *
 * Compensation (design :496-506, :994-995): verify owner tag; verify no
 * session / assigned task / ahead / dirty / stash / dependent graph ref;
 * only then use the safe requireClean remove path. Any failed check leaves
 * the tree in place and marks compensation_required.
 */

import { randomUUID } from 'crypto';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import {
    newMeshGraphOutboxId,
    type MeshGraphWorkspaceIntentRow,
    type MeshGraphWorkspaceSagaState,
} from './mesh-graph-types.js';
import { drainMeshGraphOutbox, graphMaterializationBlockReason, rematerializePendingGraphNodesForWorkspace } from './mesh-graph-transition-runner.js';
import { mergeWorktreeAffinityTag, resolveWorkspaceRefForMaterialize } from './mesh-graph-workspace-bind.js';
import {
    WORKSPACE_SAGA_LEASE_MS,
    deriveWorkspaceBranchIdentity,
    deriveWorkspaceCloneIdempotencyKey,
    deriveWorkspaceOwnerTag,
    readWorkspaceRefFromSpec,
    workspaceWorktreeAffinityTag,
} from './mesh-graph-workspace-identity.js';
import {
    classifyWorkspaceCompensationSafety,
    type WorkspaceInspectReport,
    type WorkspaceSafetySnapshot,
} from './mesh-graph-workspace-safety.js';
import {
    WorkspaceSagaPermanentError,
    createDefaultWorkspaceSagaPorts,
    type WorkspaceCloneResult,
    type WorkspaceSagaPorts,
} from './mesh-graph-workspace-ports.js';
import { LOG } from '../logging/logger.js';

const LEASE_OWNER = 'workspace-saga';
const ACTIVE_SAGA_STATES: MeshGraphWorkspaceSagaState[] = ['declared', 'preparing', 'compensating'];

export interface GraphWorkspaceDeclaration {
    ref: string;
    source_node_id?: string;
    purpose?: string;
    base_revision?: string;
    cleanup_on_graph_failure?: boolean;
    desired_path?: string;
}

export interface WorkspaceSagaFaultHooks {
    /** Throw to simulate process death after clone, before any identity persist. */
    afterCloneSuccess?: (created: WorkspaceCloneResult) => void;
    /** Throw after created_node_id/path are on the intent, before bind/ready. */
    afterPersistCreatedIdentity?: (created: WorkspaceCloneResult) => void;
    /** Throw inside bind (clone already persisted) — enqueue/finalize crash. */
    beforeFinalizeReady?: () => void;
}

export interface WorkspaceSagaStepResult {
    graphId: string;
    workspaceRef: string;
    sagaState: MeshGraphWorkspaceSagaState;
    action:
        | 'skipped_no_base'
        | 'skipped_lease_held'
        | 'resumed_owned_worktree'
        | 'cloned'
        | 'finalized_ready'
        | 'clone_failed'
        | 'compensated'
        | 'compensation_required'
        | 'already_terminal';
    createdNodeId?: string;
    createdWorktreePath?: string;
    boundTaskIds?: string[];
    refusals?: string[];
    error?: string;
}

export interface WorkspaceSagaTickResult {
    steps: WorkspaceSagaStepResult[];
    recovered: number;
    compensated: number;
    quarantined: number;
}

export function declareWorkspaceIntents(args: {
    graphId: string;
    meshId: string;
    workspaces: GraphWorkspaceDeclaration[];
}): MeshGraphWorkspaceIntentRow[] {
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date().toISOString();
    return store.transaction(() => {
        const graphStore = store.graphStore();
        const out: MeshGraphWorkspaceIntentRow[] = [];
        for (const spec of args.workspaces) {
            const workspaceRef = spec.ref.trim();
            if (!workspaceRef) continue;
            const existing = graphStore.getWorkspaceIntent(args.graphId, workspaceRef);
            if (existing) {
                out.push(existing);
                continue;
            }
            const row: MeshGraphWorkspaceIntentRow = {
                graphId: args.graphId,
                workspaceRef,
                meshId: args.meshId,
                sourceNodeId: spec.source_node_id,
                baseRevision: spec.base_revision,
                branchIdentity: deriveWorkspaceBranchIdentity(args.graphId, workspaceRef, spec.purpose),
                desiredPath: spec.desired_path,
                sagaState: 'declared',
                leaseGeneration: 0,
                cleanupOnGraphFailure: spec.cleanup_on_graph_failure === true,
                createdAt: nowIso,
                updatedAt: nowIso,
            };
            graphStore.insertWorkspaceIntent(row);
            out.push(row);
        }
        return out;
    });
}

export function setWorkspaceBaseRevision(graphId: string, workspaceRef: string, baseRevision: string): boolean {
    const store = MeshRuntimeStore.getInstance();
    return store.transaction(() =>
        store.graphStore().patchWorkspaceIntent(graphId, workspaceRef, { baseRevision }, new Date().toISOString()),
    );
}

/**
 * Daemon restart / expired-lease reconciler (design :506-507). Same path as
 * the regular tick: claim with a higher fencing generation and resume.
 */
export async function recoverExpiredWorkspaceSagas(
    meshId: string,
    ports?: WorkspaceSagaPorts,
    faults?: WorkspaceSagaFaultHooks,
): Promise<WorkspaceSagaTickResult> {
    return runWorkspaceSagaTick(meshId, ports, faults);
}

export async function runWorkspaceSagaTick(
    meshId: string,
    ports?: WorkspaceSagaPorts,
    faults?: WorkspaceSagaFaultHooks,
): Promise<WorkspaceSagaTickResult> {
    const resolved = ports ?? createDefaultWorkspaceSagaPorts();
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date(resolved.nowMs()).toISOString();
    const candidates = store.transaction(() => {
        const graphStore = store.graphStore();
        const expired = graphStore.listExpiredWorkspaceLeases(meshId, nowIso);
        const byKey = new Map(expired.map(i => [`${i.graphId}:${i.workspaceRef}`, i]));
        // Also pick up preparing rows that already recorded a created identity
        // (crash between persist and finalize) even if the lease is still live
        // for THIS worker — the tick owner refreshes it.
        for (const row of graphStore.listWorkspaceIntentsByMesh(meshId, ACTIVE_SAGA_STATES)) {
            byKey.set(`${row.graphId}:${row.workspaceRef}`, row);
        }
        // Graph-failure compensation: ready + cleanup_on_graph_failure.
        for (const row of graphStore.listWorkspaceIntentsByMesh(meshId, ['ready'])) {
            const graph = graphStore.getGraph(row.graphId);
            if (!row.cleanupOnGraphFailure || !graph) continue;
            if (graph.status === 'failed' || graph.status === 'cancelled' || graph.status === 'compensation_required') {
                byKey.set(`${row.graphId}:${row.workspaceRef}`, row);
            }
        }
        return [...byKey.values()];
    });

    const steps: WorkspaceSagaStepResult[] = [];
    for (const intent of candidates) {
        try {
            const step = await advanceWorkspaceIntent(intent.graphId, intent.workspaceRef, resolved, faults);
            if (step) steps.push(step);
        } catch (e: any) {
            LOG.warn('MeshGraphWorkspace', `saga tick failed for ${intent.graphId}/${intent.workspaceRef}: ${e?.message || e}`);
            steps.push({
                graphId: intent.graphId,
                workspaceRef: intent.workspaceRef,
                sagaState: intent.sagaState,
                action: 'clone_failed',
                error: e?.message || String(e),
            });
        }
    }
    return {
        steps,
        recovered: steps.filter(s => s.action === 'resumed_owned_worktree' || s.action === 'finalized_ready').length,
        compensated: steps.filter(s => s.action === 'compensated').length,
        quarantined: steps.filter(s => s.action === 'compensation_required').length,
    };
}

export async function compensateWorkspaceIntent(
    graphId: string,
    workspaceRef: string,
    ports?: WorkspaceSagaPorts,
    reason = 'explicit_compensate',
): Promise<WorkspaceSagaStepResult> {
    const resolved = ports ?? createDefaultWorkspaceSagaPorts();
    const store = MeshRuntimeStore.getInstance();
    store.transaction(() => {
        const graphStore = store.graphStore();
        const intent = graphStore.getWorkspaceIntent(graphId, workspaceRef);
        if (!intent) throw new Error(`workspace_intent_not_found: ${graphId}/${workspaceRef}`);
        if (intent.sagaState === 'compensated' || intent.sagaState === 'compensation_required') return;
        graphStore.patchWorkspaceIntent(graphId, workspaceRef, {
            sagaState: 'compensating',
            lastError: reason,
        }, new Date(resolved.nowMs()).toISOString());
    });
    const step = await advanceWorkspaceIntent(graphId, workspaceRef, resolved);
    if (!step) {
        return { graphId, workspaceRef, sagaState: 'compensating', action: 'skipped_lease_held' };
    }
    return step;
}

async function advanceWorkspaceIntent(
    graphId: string,
    workspaceRef: string,
    ports: WorkspaceSagaPorts,
    faults?: WorkspaceSagaFaultHooks,
): Promise<WorkspaceSagaStepResult | null> {
    const store = MeshRuntimeStore.getInstance();
    const nowMs = ports.nowMs();
    const nowIso = new Date(nowMs).toISOString();
    const leaseUntil = new Date(nowMs + WORKSPACE_SAGA_LEASE_MS).toISOString();
    const fencingToken = randomUUID();

    const claimed = store.transaction(() => {
        const graphStore = store.graphStore();
        const intent = graphStore.getWorkspaceIntent(graphId, workspaceRef);
        if (!intent) return null;
        if (intent.sagaState === 'compensated' || intent.sagaState === 'failed') {
            return { intent, lease: { claimed: true, generation: intent.leaseGeneration, fencingToken: intent.fencingToken, refreshed: true }, terminal: true as const };
        }
        const lease = graphStore.claimWorkspaceIntentLease(graphId, workspaceRef, LEASE_OWNER, fencingToken, leaseUntil, nowIso);
        return { intent: graphStore.getWorkspaceIntent(graphId, workspaceRef)!, lease, terminal: false as const };
    });
    if (!claimed) return null;
    if (!claimed.lease.claimed) {
        return { graphId, workspaceRef, sagaState: claimed.intent.sagaState, action: 'skipped_lease_held' };
    }
    if (claimed.terminal) {
        return { graphId, workspaceRef, sagaState: claimed.intent.sagaState, action: 'already_terminal' };
    }

    const intent = claimed.intent;
    const generation = claimed.lease.generation;
    const ownerTag = intent.ownerTag || deriveWorkspaceOwnerTag(graphId, workspaceRef, generation);

    if (intent.sagaState === 'ready') {
        const graph = store.graphStore().getGraph(graphId);
        if (intent.cleanupOnGraphFailure && graph && (graph.status === 'failed' || graph.status === 'cancelled' || graph.status === 'compensation_required')) {
            store.transaction(() => {
                store.graphStore().patchWorkspaceIntent(graphId, workspaceRef, { sagaState: 'compensating' }, nowIso, { leaseGeneration: generation });
            });
            return compensateClaimedIntent({ ...intent, sagaState: 'compensating', ownerTag }, ports, generation);
        }
        return { graphId, workspaceRef, sagaState: 'ready', action: 'already_terminal', createdNodeId: intent.createdNodeId, createdWorktreePath: intent.createdWorktreePath };
    }

    if (intent.sagaState === 'compensating' || intent.sagaState === 'compensation_required') {
        if (intent.sagaState === 'compensation_required') {
            return { graphId, workspaceRef, sagaState: 'compensation_required', action: 'compensation_required', refusals: parseRefusals(intent.lastError) };
        }
        return compensateClaimedIntent({ ...intent, ownerTag }, ports, generation);
    }

    let baseRevision = intent.baseRevision;
    if (intent.sagaState === 'declared' && !baseRevision) {
        // A declaration that named a source node but omitted base_revision used to
        // park here FOREVER: this branch wrote nothing, logged nothing, and the
        // reconcile tick re-entered it every few seconds. The one designed escape
        // (setWorkspaceBaseRevision) has no production caller, so the graph could
        // never leave 'declared'. Derive the base from the source node the SAME way
        // clone_mesh_node does — that node is precisely the evidence needed to
        // interpret "base revision", and it was on the declaration all along.
        const derived = await ports.resolveBaseRevision({
            meshId: intent.meshId,
            graphId,
            workspaceRef,
            sourceNodeId: intent.sourceNodeId,
        }).catch(() => undefined);
        if (derived) {
            store.transaction(() => {
                store.graphStore().patchWorkspaceIntent(graphId, workspaceRef, {
                    baseRevision: derived,
                }, nowIso, { leaseGeneration: generation });
            });
            baseRevision = derived;
            LOG.info('MeshGraphWorkspace', `derived base revision '${derived}' for ${graphId}/${workspaceRef} from source node ${intent.sourceNodeId ?? 'base'}`);
        } else {
            // design :509-511 — still no base: stay declared. Unlike before, the
            // reason is now visible (mesh_graph_view surfaces a declared_no_base
            // action) instead of failing silently.
            LOG.debug('MeshGraphWorkspace', `${graphId}/${workspaceRef} stays declared: no base_revision and none derivable from source node ${intent.sourceNodeId ?? '(none declared)'}`);
            return { graphId, workspaceRef, sagaState: 'declared', action: 'skipped_no_base' };
        }
    }

    store.transaction(() => {
        store.graphStore().patchWorkspaceIntent(graphId, workspaceRef, {
            sagaState: 'preparing',
            ownerTag,
        }, nowIso, { leaseGeneration: generation });
    });

    return prepareClaimedIntent({ ...intent, baseRevision, sagaState: 'preparing', ownerTag }, ports, generation, faults);
}

async function prepareClaimedIntent(
    intent: MeshGraphWorkspaceIntentRow,
    ports: WorkspaceSagaPorts,
    generation: number,
    faults?: WorkspaceSagaFaultHooks,
): Promise<WorkspaceSagaStepResult> {
    const store = MeshRuntimeStore.getInstance();
    let created: WorkspaceCloneResult | null = null;
    let resumed = false;

    if (intent.createdWorktreePath && intent.createdNodeId) {
        created = {
            nodeId: intent.createdNodeId,
            worktreePath: intent.createdWorktreePath,
            ownerTag: intent.ownerTag || '',
            alreadyExisted: true,
        };
        resumed = true;
    } else {
        const found = await ports.findOwnedWorktree({
            meshId: intent.meshId,
            graphId: intent.graphId,
            workspaceRef: intent.workspaceRef,
            worktreePath: intent.desiredPath || intent.createdWorktreePath,
            createdNodeId: intent.createdNodeId,
            ownerTag: intent.ownerTag,
            baseRevision: intent.baseRevision,
            sourceNodeId: intent.sourceNodeId,
        });
        if (found) {
            created = found;
            resumed = true;
        }
    }

    if (!created) {
        try {
            created = await ports.createWorktree({
                meshId: intent.meshId,
                graphId: intent.graphId,
                workspaceRef: intent.workspaceRef,
                sourceNodeId: intent.sourceNodeId,
                baseRevision: intent.baseRevision,
                branchIdentity: intent.branchIdentity || deriveWorkspaceBranchIdentity(intent.graphId, intent.workspaceRef),
                ownerTag: intent.ownerTag!,
                desiredPath: intent.desiredPath,
                idempotencyKey: deriveWorkspaceCloneIdempotencyKey(intent.graphId, intent.workspaceRef),
            });
        } catch (e: any) {
            if (e instanceof WorkspaceSagaPermanentError) {
                return failOrCompensateAfterCloneError(intent, ports, generation, e);
            }
            const nowIso = new Date(ports.nowMs()).toISOString();
            store.transaction(() => {
                store.graphStore().patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
                    sagaState: 'failed',
                    lastError: e?.message || String(e),
                }, nowIso, { leaseGeneration: generation });
            });
            return {
                graphId: intent.graphId,
                workspaceRef: intent.workspaceRef,
                sagaState: 'failed',
                action: 'clone_failed',
                error: e?.message || String(e),
            };
        }
        faults?.afterCloneSuccess?.(created);
    }

    // Persist created identity BEFORE bind. Crash between this write and
    // finalize is the resume point (design :493-494).
    const persistIso = new Date(ports.nowMs()).toISOString();
    store.transaction(() => {
        store.graphStore().patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
            sagaState: 'preparing',
            createdNodeId: created!.nodeId,
            createdWorktreePath: created!.worktreePath,
            ownerTag: created!.ownerTag || intent.ownerTag,
        }, persistIso, { leaseGeneration: generation });
    });
    faults?.afterPersistCreatedIdentity?.(created);

    // Publish membership as soon as the created identity is durable, NOT at
    // 'ready'. Two reasons this is the correct point:
    //   1. It is the first moment the node id + path are recoverable. A crash
    //      between here and finalize resumes through this same function, so the
    //      registration is retried (it is idempotent) — whereas registering only
    //      at finalize would strand a real, on-disk worktree with no membership
    //      after a crash, which is precisely the invisible-worktree class of bug
    //      this fix exists to close.
    //   2. Visibility and dispatchability are separated by the bootstrap stamp
    //      below, so early publication is not early dispatch.
    // The node is stamped bootstrap 'running' here, which the pre-existing
    // worktree-bootstrap gate already reads as "do not dispatch into a half-built
    // worktree"; finalizeWorkspaceReady re-stamps 'complete'. Failure to publish
    // never fails the saga — the worktree itself is correct either way.
    await registerWorkspaceNodeBestEffort(intent, created, ports, 'running');

    try {
        faults?.beforeFinalizeReady?.();
        const bound = finalizeWorkspaceReady(intent.graphId, intent.workspaceRef, created, generation, ports.nowMs());
        await registerWorkspaceNodeBestEffort(intent, created, ports, 'complete');
        return {
            graphId: intent.graphId,
            workspaceRef: intent.workspaceRef,
            sagaState: 'ready',
            action: resumed ? 'resumed_owned_worktree' : (bound.justCloned ? 'cloned' : 'finalized_ready'),
            createdNodeId: created.nodeId,
            createdWorktreePath: created.worktreePath,
            boundTaskIds: bound.boundTaskIds,
        };
    } catch (e: any) {
        if (e instanceof WorkspaceSagaPermanentError) {
            store.transaction(() => {
                store.graphStore().patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
                    sagaState: 'compensating',
                    lastError: e.message,
                }, new Date(ports.nowMs()).toISOString(), { leaseGeneration: generation });
            });
            return compensateClaimedIntent({
                ...intent,
                sagaState: 'compensating',
                createdNodeId: created.nodeId,
                createdWorktreePath: created.worktreePath,
            }, ports, generation);
        }
        // Retryable finalize failure: leave preparing with the created identity.
        store.transaction(() => {
            store.graphStore().patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
                lastError: e?.message || String(e),
            }, new Date(ports.nowMs()).toISOString(), { leaseGeneration: generation });
        });
        throw e;
    }
}

/**
 * Membership publication is best-effort by contract: the git worktree is the
 * real resource and it is already correct, so a registry write that fails (no
 * config twin, no router/inline cache, a mocked mesh-config in tests) must not
 * fail or retry-loop the saga. It is logged, never thrown.
 */
async function registerWorkspaceNodeBestEffort(
    intent: MeshGraphWorkspaceIntentRow,
    created: WorkspaceCloneResult,
    ports: WorkspaceSagaPorts,
    bootstrapStatus: 'running' | 'complete',
): Promise<void> {
    try {
        await ports.registerNode({
            meshId: intent.meshId,
            nodeId: created.nodeId,
            worktreePath: created.worktreePath,
            branchIdentity: intent.branchIdentity || deriveWorkspaceBranchIdentity(intent.graphId, intent.workspaceRef),
            sourceNodeId: intent.sourceNodeId,
            bootstrapStatus,
        });
    } catch (e: any) {
        LOG.warn('MeshGraphWorkspace', `node registration (${bootstrapStatus}) failed for ${intent.graphId}/${intent.workspaceRef}: ${e?.message || e}`);
    }
}

function finalizeWorkspaceReady(
    graphId: string,
    workspaceRef: string,
    created: WorkspaceCloneResult,
    generation: number,
    nowMs: number,
): { boundTaskIds: string[]; justCloned: boolean } {
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date(nowMs).toISOString();
    const boundTaskIds = store.transaction(() => {
        const graphStore = store.graphStore();
        const graph = graphStore.getGraph(graphId);
        if (!graph) throw new WorkspaceSagaPermanentError('graph_gone', `graph '${graphId}' disappeared before workspace finalize`);
        const patched = graphStore.patchWorkspaceIntent(graphId, workspaceRef, {
            sagaState: 'ready',
            createdNodeId: created.nodeId,
            createdWorktreePath: created.worktreePath,
            ownerTag: created.ownerTag,
            lastError: null,
        }, nowIso, { leaseGeneration: generation });
        if (!patched) throw new Error('workspace_lease_fenced: finalize lost the generation CAS');

        const bound = bindWorkspaceTargetsInTransaction(store, graphId, workspaceRef, created.nodeId);
        const intents = graphStore.listWorkspaceIntents(graphId);
        const allReady = intents.every(i => i.sagaState === 'ready' || i.sagaState === 'compensated');
        if (allReady && (graph.status === 'preparing' || graph.status === 'active')) {
            if (graph.status === 'preparing') graphStore.updateGraphStatus(graphId, 'active', nowIso);
            graphStore.insertOutboxEvent({
                id: newMeshGraphOutboxId(),
                meshId: graph.meshId,
                graphId,
                kind: 'graph_workspaces_ready',
                payload: JSON.stringify({ graphId, workspaceRef, createdNodeId: created.nodeId }),
                status: 'pending',
                attemptCount: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
            });
            graphStore.insertOutboxEvent({
                id: newMeshGraphOutboxId(),
                meshId: graph.meshId,
                graphId,
                kind: 'queue_wake',
                payload: JSON.stringify({ meshId: graph.meshId, reason: 'workspace_ready', graphId }),
                status: 'pending',
                attemptCount: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
            });
        }
        return bound;
    });
    rematerializePendingGraphNodesForWorkspace(graphId, workspaceRef);
    try { drainMeshGraphOutbox(store.graphStore().getGraph(graphId)?.meshId ?? ''); } catch { /* drain is best-effort */ }
    return { boundTaskIds, justCloned: !created.alreadyExisted };
}

function bindWorkspaceTargetsInTransaction(
    store: MeshRuntimeStore,
    graphId: string,
    workspaceRef: string,
    createdNodeId: string,
): string[] {
    const graphStore = store.graphStore();
    const intent = graphStore.getWorkspaceIntent(graphId, workspaceRef);
    const tag = intent?.branchIdentity ? workspaceWorktreeAffinityTag(intent.branchIdentity) : undefined;
    const bound: string[] = [];
    for (const node of graphStore.listNodes(graphId)) {
        if (node.kind !== 'worker_task' || !node.queueTaskId) continue;
        let spec: unknown;
        try { spec = JSON.parse(node.baseSpecJson); } catch { continue; }
        if (readWorkspaceRefFromSpec(spec) !== workspaceRef) continue;
        const entry = store.findQueueEntryById(node.meshId, node.queueTaskId);
        if (!entry || entry.status !== 'pending') continue;
        entry.targetNodeId = createdNodeId;
        entry.requiredTags = mergeWorktreeAffinityTag(entry.requiredTags, tag);
        store.updateQueueEntry(entry);
        bound.push(entry.id);
    }
    return bound;
}

async function compensateClaimedIntent(
    intent: MeshGraphWorkspaceIntentRow,
    ports: WorkspaceSagaPorts,
    generation: number,
): Promise<WorkspaceSagaStepResult> {
    const store = MeshRuntimeStore.getInstance();
    const inspect = await gatherCompensationInspect(intent, ports);
    const snapshot = classifyWorkspaceCompensationSafety({
        expectedOwnerTag: intent.ownerTag,
        inspect,
    });
    const nowIso = new Date(ports.nowMs()).toISOString();

    if (!snapshot.deletable) {
        store.transaction(() => quarantineCompensation(store, intent, snapshot, nowIso, generation));
        try { drainMeshGraphOutbox(intent.meshId); } catch { /* best-effort */ }
        return {
            graphId: intent.graphId,
            workspaceRef: intent.workspaceRef,
            sagaState: 'compensation_required',
            action: 'compensation_required',
            createdNodeId: intent.createdNodeId,
            createdWorktreePath: intent.createdWorktreePath,
            refusals: snapshot.refusals,
        };
    }

    if (inspect.pathExists && intent.createdWorktreePath) {
        const removed = await ports.removeWorktree({
            meshId: intent.meshId,
            worktreePath: intent.createdWorktreePath,
            createdNodeId: intent.createdNodeId,
            sourceNodeId: intent.sourceNodeId,
        });
        if (!removed.removed) {
            const failed: WorkspaceSafetySnapshot = {
                deletable: false,
                refusals: ['ambiguous'],
                evidence: { ...snapshot.evidence, removeError: removed.error || 'remove_failed' },
            };
            store.transaction(() => quarantineCompensation(store, intent, failed, nowIso, generation));
            try { drainMeshGraphOutbox(intent.meshId); } catch { /* best-effort */ }
            return {
                graphId: intent.graphId,
                workspaceRef: intent.workspaceRef,
                sagaState: 'compensation_required',
                action: 'compensation_required',
                createdNodeId: intent.createdNodeId,
                createdWorktreePath: intent.createdWorktreePath,
                refusals: failed.refusals,
                error: removed.error,
            };
        }
    }

    // Drop membership only on the SUCCESS path — the worktree is gone (or was
    // already gone), so leaving the node registered would strand a ghost that
    // mesh_list_nodes advertises and tasks can be pinned to. The quarantine
    // paths above deliberately do NOT unregister: compensation_required means
    // the tree is still on disk and possibly holding work, so its node must stay
    // addressable for the operator resolving it.
    if (intent.createdNodeId) {
        try {
            await ports.unregisterNode({ meshId: intent.meshId, nodeId: intent.createdNodeId });
        } catch (e: any) {
            LOG.warn('MeshGraphWorkspace', `node unregistration failed for ${intent.graphId}/${intent.workspaceRef}: ${e?.message || e}`);
        }
    }

    store.transaction(() => {
        const graphStore = store.graphStore();
        graphStore.patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
            sagaState: 'compensated',
            lastError: null,
        }, nowIso, { leaseGeneration: generation });
        graphStore.insertOutboxEvent({
            id: newMeshGraphOutboxId(),
            meshId: intent.meshId,
            graphId: intent.graphId,
            kind: 'workspace_compensated',
            payload: JSON.stringify({
                graphId: intent.graphId,
                workspaceRef: intent.workspaceRef,
                createdNodeId: intent.createdNodeId,
                createdWorktreePath: intent.createdWorktreePath,
                evidence: snapshot.evidence,
            }),
            status: 'pending',
            attemptCount: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
        });
        holdAffectedWorkspaceNodes(store, intent, 'workspace_compensated', nowIso);
    });
    try { drainMeshGraphOutbox(intent.meshId); } catch { /* best-effort */ }
    return {
        graphId: intent.graphId,
        workspaceRef: intent.workspaceRef,
        sagaState: 'compensated',
        action: 'compensated',
        createdNodeId: intent.createdNodeId,
        createdWorktreePath: intent.createdWorktreePath,
    };
}

function quarantineCompensation(
    store: MeshRuntimeStore,
    intent: MeshGraphWorkspaceIntentRow,
    snapshot: WorkspaceSafetySnapshot,
    nowIso: string,
    generation: number,
): void {
    const graphStore = store.graphStore();
    const evidence = JSON.stringify({
        code: 'compensation_required',
        refusals: snapshot.refusals,
        evidence: snapshot.evidence,
        at: nowIso,
    });
    graphStore.patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
        sagaState: 'compensation_required',
        lastError: evidence,
    }, nowIso, { leaseGeneration: generation });
    graphStore.updateGraphStatus(intent.graphId, 'compensation_required', nowIso);
    graphStore.insertOutboxEvent({
        id: newMeshGraphOutboxId(),
        meshId: intent.meshId,
        graphId: intent.graphId,
        kind: 'workspace_compensation_required',
        payload: evidence,
        status: 'pending',
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
    holdAffectedWorkspaceNodes(store, intent, 'workspace_compensation_required', nowIso);
}

/**
 * Hold (do not cancel) affected worker nodes. Cancel would be a terminal
 * queue write and must go through commitTaskTerminalAndAdvanceGraph; holding
 * keeps the existing graph-owned block so the unchanged scheduler predicate
 * still refuses the claim.
 */
function holdAffectedWorkspaceNodes(
    store: MeshRuntimeStore,
    intent: MeshGraphWorkspaceIntentRow,
    reason: string,
    nowIso: string,
): void {
    const graphStore = store.graphStore();
    for (const node of graphStore.listNodes(intent.graphId)) {
        if (node.kind !== 'worker_task') continue;
        let spec: unknown;
        try { spec = JSON.parse(node.baseSpecJson); } catch { continue; }
        if (readWorkspaceRefFromSpec(spec) !== intent.workspaceRef) continue;
        if (node.state === 'completed' || node.state === 'cancelled' || node.state === 'failed' || node.state === 'skipped') continue;
        graphStore.updateNodeState(intent.graphId, node.nodeId, 'blocked', nowIso, { failureReason: reason });
        if (!node.queueTaskId) continue;
        const entry = store.findQueueEntryById(node.meshId, node.queueTaskId);
        if (!entry || entry.status !== 'pending') continue;
        const existing = entry.blockedReason;
        const graphOwned = !existing || existing.startsWith('graph_materialization_pending:');
        if (graphOwned) {
            entry.blockedReason = graphMaterializationBlockReason(node.nodeId, node.materializationVersion);
            store.updateQueueEntry(entry);
        }
    }
}

async function gatherCompensationInspect(
    intent: MeshGraphWorkspaceIntentRow,
    ports: WorkspaceSagaPorts,
): Promise<WorkspaceInspectReport> {
    const inspect = await ports.inspectWorktree({
        meshId: intent.meshId,
        graphId: intent.graphId,
        workspaceRef: intent.workspaceRef,
        worktreePath: intent.createdWorktreePath,
        createdNodeId: intent.createdNodeId,
        ownerTag: intent.ownerTag,
        baseRevision: intent.baseRevision,
        sourceNodeId: intent.sourceNodeId,
    });
    const sessions = intent.createdNodeId
        ? await ports.listLiveSessionsOnNode(intent.createdNodeId)
        : { sessionIds: [] as string[] };
    const assigned = intent.createdNodeId
        ? await ports.listAssignedTasksOnNode(intent.meshId, intent.createdNodeId)
        : [];
    const dependents = intent.createdNodeId
        ? MeshRuntimeStore.getInstance().graphStore()
            .listWorkspaceIntentsByCreatedNodeId(intent.meshId, intent.createdNodeId)
            .filter(other => other.graphId !== intent.graphId || other.workspaceRef !== intent.workspaceRef)
            .map(other => ({ graphId: other.graphId, workspaceRef: other.workspaceRef }))
        : [];
    return {
        ...inspect,
        sessionBound: sessions.sessionIds.length > 0 || inspect.sessionBound,
        sessionIds: sessions.sessionIds,
        sessionInventoryUnknown: sessions.unknown === true,
        sessionInventoryError: sessions.error,
        assignedTaskIds: assigned,
        dependentGraphRefs: dependents,
    };
}

async function failOrCompensateAfterCloneError(
    intent: MeshGraphWorkspaceIntentRow,
    ports: WorkspaceSagaPorts,
    generation: number,
    error: WorkspaceSagaPermanentError,
): Promise<WorkspaceSagaStepResult> {
    const store = MeshRuntimeStore.getInstance();
    const nowIso = new Date(ports.nowMs()).toISOString();
    if (error.code === 'identity_conflict' && (intent.createdWorktreePath || intent.desiredPath)) {
        store.transaction(() => {
            store.graphStore().patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
                sagaState: 'compensating',
                lastError: error.message,
            }, nowIso, { leaseGeneration: generation });
        });
        return compensateClaimedIntent({ ...intent, sagaState: 'compensating' }, ports, generation);
    }
    store.transaction(() => {
        store.graphStore().patchWorkspaceIntent(intent.graphId, intent.workspaceRef, {
            sagaState: 'failed',
            lastError: error.message,
        }, nowIso, { leaseGeneration: generation });
    });
    return {
        graphId: intent.graphId,
        workspaceRef: intent.workspaceRef,
        sagaState: 'failed',
        action: 'clone_failed',
        error: error.message,
    };
}

function parseRefusals(lastError?: string): string[] | undefined {
    if (!lastError) return undefined;
    try {
        const parsed = JSON.parse(lastError);
        return Array.isArray(parsed?.refusals) ? parsed.refusals : undefined;
    } catch {
        return undefined;
    }
}

/** Test helper: expose binding lookup without running the saga. */
export function peekWorkspaceBinding(graphId: string, baseSpec: unknown) {
    return resolveWorkspaceRefForMaterialize(MeshRuntimeStore.getInstance().graphStore(), graphId, baseSpec);
}
