// Mesh scheduling-runtime view — a read-only, derived projection of how the queue
// scheduler currently sees the mesh: which tie-break strategy is live, the global
// parallel caps and how much of them is consumed, and per-node load / priority /
// per-(node, provider) caps plus a structured "why this node can't take more write
// work right now" reason set.
//
// This is OBSERVABILITY ONLY. It re-derives the same numbers the live claim path
// (maybeAutoLaunchOneQueueSession → orderEligibleNodes → claimNextQueueTask) acts
// on, but never mutates anything and never drives a scheduling decision. It is built
// from the in-memory mesh config + the queue snapshot, so callers (mesh_status) get a
// consistent picture without touching the SQLite claim transaction. Keeping the
// derivation here — next to the constants it mirrors — means the exposed numbers and
// the enforced numbers stay defined in one module family.

import type { RepoMeshNodePolicy, RepoMeshSchedulingStrategy } from '../repo-mesh-types.js';
import {
    normalizeMeshSchedulingStrategy,
    resolveMaxParallelTasks,
    resolveNodeSchedulingPriority,
    resolveProviderMaxParallel,
} from '../repo-mesh-types.js';
import { normalizeMeshNodeId } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue.js';

/** Per-(node, provider) cap and its current consumption. */
export interface MeshNodeProviderSchedulingRuntime {
    providerType: string;
    /** Declared maxParallel cap for this (node, provider). Omitted when uncapped. */
    maxParallel?: number;
    /** Active (status='assigned') tasks on this node claimed by this provider. */
    activeAssigned: number;
    /** True when activeAssigned has reached maxParallel (a further claim is refused). */
    capReached: boolean;
}

/** Per-node scheduling-runtime projection. */
export interface MeshNodeSchedulingRuntime {
    nodeId: string;
    /** Active (status='assigned') task count on this node — the least-loaded rank key. */
    load: number;
    /** Soft scheduling priority (PRIORITY rank key; higher = preferred). */
    schedulingPriority: number;
    /** Per-node concurrent-session cap, when configured. */
    maxConcurrentSessions?: number;
    /** Per-(node, provider) caps + consumption, when providerRoles declares any. */
    providerRoles?: MeshNodeProviderSchedulingRuntime[];
    /**
     * True when the node currently cannot claim a NEW write (non-readonly) task —
     * either the global write cap is exhausted or a node-local gate (active write
     * assignment / a fully-consumed provider cap / session cap) blocks it.
     */
    capReached: boolean;
    /** Structured reasons backing capReached (empty when the node can take work). */
    capReasons: string[];
}

/** Mesh-level scheduling-runtime projection. */
export interface MeshSchedulingRuntime {
    /** Resolved tie-break strategy (defaults to 'first_eligible'). */
    strategy: RepoMeshSchedulingStrategy;
    /** Effective global write-task parallel cap (clamped). */
    maxParallelTasks: number;
    /** Derived read-only diagnosis cap (max(2, 2× write cap)) — mirrors the claim path. */
    maxReadonlyParallelTasks: number;
    /** Current global write (non-readonly) assigned-task load. */
    activeWriteAssigned: number;
    /** Current global read-only assigned-task load. */
    activeReadonlyAssigned: number;
    /** True when the global write cap is exhausted (no new write task can launch). */
    globalWriteCapReached: boolean;
    /** True when the read-only diagnosis cap is exhausted. */
    globalReadonlyCapReached: boolean;
    /** Per-node projections, in mesh config order. */
    nodes: MeshNodeSchedulingRuntime[];
}

interface MeshLike {
    policy?: { schedulingStrategy?: unknown; maxParallelTasks?: unknown } | null;
    nodes?: Array<{ id?: string; nodeId?: string; node_id?: string; policy?: RepoMeshNodePolicy | null; isLocalWorktree?: boolean }> | null;
}

function isReadonly(task: MeshWorkQueueEntry): boolean {
    return task.taskMode === 'live_debug_readonly';
}

function isAssigned(task: MeshWorkQueueEntry): boolean {
    return task.status === 'assigned';
}

/**
 * Build the scheduling-runtime projection for a mesh from its config + a snapshot of
 * its work queue. Pure and side-effect free — safe to call on any read path.
 *
 * The derivation deliberately mirrors maybeAutoLaunchOneQueueSession's gates so the
 * exposed "capReached/capReasons" match why a real claim would be refused:
 *   • global write cap   → activeWriteAssigned >= maxParallelTasks
 *   • node write conflict→ a node already holding an assigned write task (worktree isolation)
 *   • provider cap       → a (node, provider) at its declared maxParallel
 * It does NOT re-evaluate eligibility/required-tags (those are task-specific); it only
 * reports the capacity picture, which is what an operator needs to read load balance.
 */
export function buildMeshSchedulingRuntime(
    mesh: MeshLike | null | undefined,
    queue: MeshWorkQueueEntry[],
): MeshSchedulingRuntime {
    const strategy = normalizeMeshSchedulingStrategy(mesh?.policy?.schedulingStrategy);
    const maxParallelTasks = resolveMaxParallelTasks(mesh?.policy?.maxParallelTasks);
    // Read-only diagnoses are exempt from the write cap and get their own higher
    // safety cap (2× the write cap, floor 2) — identical to the claim path.
    const maxReadonlyParallelTasks = Math.max(2, maxParallelTasks * 2);

    const assignedTasks = (Array.isArray(queue) ? queue : []).filter(isAssigned);
    const activeWriteAssigned = assignedTasks.filter(t => !isReadonly(t)).length;
    const activeReadonlyAssigned = assignedTasks.filter(isReadonly).length;
    const globalWriteCapReached = activeWriteAssigned >= maxParallelTasks;
    const globalReadonlyCapReached = activeReadonlyAssigned >= maxReadonlyParallelTasks;

    // Pre-bucket assigned tasks by node so per-node load and per-provider counts are
    // a single pass rather than O(nodes × queue).
    const writeAssignedByNode = new Map<string, number>();
    const assignedByNode = new Map<string, number>();
    const providerCountByNode = new Map<string, Map<string, number>>();
    for (const task of assignedTasks) {
        const nodeId = typeof task.assignedNodeId === 'string' ? task.assignedNodeId.trim() : '';
        if (!nodeId) continue;
        assignedByNode.set(nodeId, (assignedByNode.get(nodeId) ?? 0) + 1);
        if (!isReadonly(task)) {
            writeAssignedByNode.set(nodeId, (writeAssignedByNode.get(nodeId) ?? 0) + 1);
        }
        const provider = typeof task.assignedProviderType === 'string' ? task.assignedProviderType : '';
        if (provider) {
            let byProvider = providerCountByNode.get(nodeId);
            if (!byProvider) { byProvider = new Map(); providerCountByNode.set(nodeId, byProvider); }
            byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
        }
    }

    const nodes: MeshNodeSchedulingRuntime[] = [];
    for (const rawNode of (Array.isArray(mesh?.nodes) ? mesh!.nodes! : [])) {
        const nodeId = normalizeMeshNodeId(rawNode);
        if (!nodeId) continue;
        const policy = (rawNode?.policy || undefined) as RepoMeshNodePolicy | undefined;
        const load = assignedByNode.get(nodeId) ?? 0;
        const schedulingPriority = resolveNodeSchedulingPriority(policy);

        const capReasons: string[] = [];
        if (globalWriteCapReached) capReasons.push('global_max_parallel_tasks_reached');
        // Write isolation: a node already holding an assigned write task can't take another.
        if ((writeAssignedByNode.get(nodeId) ?? 0) > 0) capReasons.push('node_has_active_assignment');

        // Per-(node, provider) caps, with live consumption.
        let providerRoles: MeshNodeProviderSchedulingRuntime[] | undefined;
        const declaredRoles = Array.isArray(policy?.providerRoles) ? policy!.providerRoles! : [];
        if (declaredRoles.length) {
            const byProvider = providerCountByNode.get(nodeId);
            providerRoles = [];
            for (const role of declaredRoles) {
                if (!role || typeof role !== 'object') continue;
                const providerType = typeof role.providerType === 'string' ? role.providerType.trim() : '';
                if (!providerType) continue;
                const maxParallel = resolveProviderMaxParallel(policy, providerType);
                const activeAssigned = byProvider?.get(providerType) ?? 0;
                const capReached = maxParallel !== undefined && activeAssigned >= maxParallel;
                providerRoles.push({
                    providerType,
                    ...(maxParallel !== undefined ? { maxParallel } : {}),
                    activeAssigned,
                    capReached,
                });
                if (capReached) capReasons.push(`max_provider_parallel_reached:${providerType}`);
            }
            if (!providerRoles.length) providerRoles = undefined;
        }

        const maxConcurrentSessions = Number(policy?.maxConcurrentSessions);
        const hasSessionCap = Number.isFinite(maxConcurrentSessions) && maxConcurrentSessions >= 0;

        nodes.push({
            nodeId,
            load,
            schedulingPriority,
            ...(hasSessionCap ? { maxConcurrentSessions: Math.floor(maxConcurrentSessions) } : {}),
            ...(providerRoles ? { providerRoles } : {}),
            capReached: capReasons.length > 0,
            capReasons,
        });
    }

    return {
        strategy,
        maxParallelTasks,
        maxReadonlyParallelTasks,
        activeWriteAssigned,
        activeReadonlyAssigned,
        globalWriteCapReached,
        globalReadonlyCapReached,
        nodes,
    };
}
