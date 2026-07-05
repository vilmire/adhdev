/**
 * Aggregate mesh-status cache — extracted from router.ts (behavior-preserving code move).
 *
 * These functions were `DaemonCommandRouter` methods; they now take the router
 * instance as `self`. The class keeps thin delegating wrappers
 * (getCachedAggregateMeshStatus / rememberAggregateMeshStatus are bound into
 * HighFamilyContext — intra-cluster calls therefore go through `self.` so instance
 * dispatch is preserved). No log string, error message, refusal condition, or
 * result shape changed — only physical location + `this.` → `self.`.
 *
 * The group is self-contained: it reads only `self.aggregateMeshStatusCache` and
 * imported mesh-node-identity / mesh-work-queue helpers. It does NOT touch the
 * inline-mesh cache cluster, so the move is a pure lift.
 */
import type { DaemonCommandRouter } from './router.js';
import { normalizeMeshNodeId } from '@adhdev/mesh-shared';
import { getMeshQueueRevision } from '../mesh/mesh-work-queue.js';
import {
    applyInlineMeshBranchConvergence,
    buildInlineMeshTransitGitStatus,
    buildLivePeerGitConnection,
    deriveMeshNodeHealthFromGit,
    isDeadLocalWorktreeNode,
    readBooleanValue,
    readInlineMeshNodeId,
    readObjectRecord,
    readStringValue,
    shouldRefreshStalePendingAggregate,
    summarizeInlineMeshBranchConvergence,
} from '../mesh/mesh-node-identity.js';

export function cloneJsonValue<T>(value: T): T {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as T;
}

export function hydrateCachedAggregateMeshStatusFromInline(
    self: DaemonCommandRouter,
    snapshot: any,
    mesh: any,
    options?: { requireDirectPeerTruth?: boolean },
): any {
        if (!mesh || typeof mesh !== 'object' || !Array.isArray(mesh.nodes) || !Array.isArray(snapshot?.nodes)) return snapshot;
        const inlineNodesById = new Map<string, any>();
        for (const node of mesh.nodes) {
            const nodeId = readInlineMeshNodeId(node);
            if (nodeId) inlineNodesById.set(nodeId, node);
        }
        if (!inlineNodesById.size) return snapshot;

        let changed = false;
        const unavailableNodeIds = new Set<string>();
        const sourceOfTruth = readObjectRecord(snapshot.sourceOfTruth);
        const directPeerTruth = readObjectRecord(sourceOfTruth.directPeerTruth);
        // Dead local worktree nodes (isLocalWorktree, workspace deleted from disk)
        // carry no live truth and must never gate the aggregate as unavailable.
        // A cached snapshot built before the worktree was removed can still list
        // such a node in unavailableNodeIds, which would wedge the graph in a
        // permanent direct_peer_truth_unavailable; drop them here so the held
        // standing-state truth for the surviving nodes satisfies the aggregate.
        const deadNodeIds = new Set<string>();
        for (const node of mesh.nodes) {
            if (!isDeadLocalWorktreeNode(node)) continue;
            const deadId = readInlineMeshNodeId(node);
            if (deadId) deadNodeIds.add(deadId);
        }
        let droppedDeadUnavailable = false;
        for (const entry of Array.isArray(directPeerTruth.unavailableNodeIds) ? directPeerTruth.unavailableNodeIds : []) {
            const nodeId = readStringValue(entry);
            if (!nodeId) continue;
            if (deadNodeIds.has(nodeId)) {
                droppedDeadUnavailable = true;
                continue;
            }
            unavailableNodeIds.add(nodeId);
        }
        // Force a rewrite when a dead worktree was filtered out of a previously
        // built unavailable set, even if no live git was re-hydrated this pass —
        // otherwise the early-return below would hand back the stale snapshot that
        // still says direct_peer_truth_unavailable.
        if (droppedDeadUnavailable) changed = true;

        const nodes = snapshot.nodes.map((statusNode: any) => {
            const nodeId = normalizeMeshNodeId(statusNode);
            const inlineNode = nodeId ? inlineNodesById.get(nodeId) : undefined;
            if (!inlineNode) return statusNode;
            const liveGit = buildInlineMeshTransitGitStatus(inlineNode);
            if (!liveGit) return statusNode;
            const nextStatus = { ...statusNode };
            nextStatus.git = liveGit;
            nextStatus.health = deriveMeshNodeHealthFromGit(liveGit);
            applyInlineMeshBranchConvergence(mesh, inlineNode, nextStatus);
            nextStatus.launchReady = readBooleanValue(nextStatus.launchReady) ?? true;
            const connection = readObjectRecord(nextStatus.connection);
            const connectionState = readStringValue(connection.state);
            const connectionReported = readBooleanValue(connection.reported) ?? false;
            if (!connectionReported || connectionState === 'unknown') {
                nextStatus.connection = buildLivePeerGitConnection(connection);
            }
            delete nextStatus.gitProbePending;
            const error = readStringValue(nextStatus.error);
            if (error && /pending_git|git probe|live peer git snapshot|no peer git snapshot/i.test(error)) delete nextStatus.error;
            if (!readStringValue(nextStatus.machineStatus)) nextStatus.machineStatus = 'online';
            if (nodeId) unavailableNodeIds.delete(nodeId);
            changed = true;
            return nextStatus;
        });

        const aggregateDirectTruthSatisfied = sourceOfTruth.coordinatorOwnsLiveTruth === true
            || directPeerTruth.satisfied === true;
        if (!changed && !(options?.requireDirectPeerTruth && unavailableNodeIds.size > 0 && !aggregateDirectTruthSatisfied)) return snapshot;
        const nextSourceOfTruth = {
            ...sourceOfTruth,
            ...(Object.keys(directPeerTruth).length ? {
                directPeerTruth: {
                    ...directPeerTruth,
                    satisfied: options?.requireDirectPeerTruth === true
                        ? aggregateDirectTruthSatisfied || unavailableNodeIds.size === 0
                        : directPeerTruth.satisfied,
                    unavailableNodeIds: [...unavailableNodeIds],
                },
                ...(options?.requireDirectPeerTruth === true ? {
                    coordinatorOwnsLiveTruth: aggregateDirectTruthSatisfied || unavailableNodeIds.size === 0,
                    currentStatus: aggregateDirectTruthSatisfied || unavailableNodeIds.size === 0 ? 'live_git_and_session_probes' : 'direct_peer_truth_unavailable',
                } : {}),
            } : {}),
        };
        return {
            ...snapshot,
            ...(options?.requireDirectPeerTruth === true && unavailableNodeIds.size > 0 && !aggregateDirectTruthSatisfied ? {
                success: false,
                code: 'mesh_direct_peer_truth_unavailable',
                error: 'Selected coordinator could not confirm direct mesh truth for every remote node yet.',
            } : {}),
            sourceOfTruth: nextSourceOfTruth,
            branchConvergenceSummary: summarizeInlineMeshBranchConvergence(nodes),
            nodes,
        };
}

export function getCachedAggregateMeshStatus(
    self: DaemonCommandRouter,
    meshId: string,
    mesh?: any,
    options?: { requireDirectPeerTruth?: boolean; allowStalePending?: boolean },
): any | null {
        const cached = self.aggregateMeshStatusCache.get(meshId);
        if (!cached?.snapshot || cached.snapshot.success !== true || !Array.isArray(cached.snapshot.nodes)) return null;
        // Genuine invalidation still forces truth: a queue mutation bumps the
        // revision, so a stale-revision snapshot is never served (even under the
        // SWR allowStalePending path below).
        if (cached.queueRevision !== getMeshQueueRevision(meshId)) return null;
        let snapshot = cloneJsonValue(cached.snapshot);
        snapshot = hydrateCachedAggregateMeshStatusFromInline(self, snapshot, mesh, options);
        // SWR: allowStalePending lets the interactive detail-open serve a snapshot
        // that still has pending peer-git nodes (would otherwise miss here) so the
        // graph paints instantly; the caller fires a background freshen. The
        // queueRevision guard above is NOT relaxed — only the pending-git freshness
        // gate is, so a genuine queue/identity mutation still forces a live rebuild.
        if (!options?.allowStalePending && shouldRefreshStalePendingAggregate(snapshot, options)) return null;
        const ageMs = Math.max(0, Date.now() - cached.builtAt);
        const sourceOfTruth = snapshot.sourceOfTruth && typeof snapshot.sourceOfTruth === 'object'
            ? snapshot.sourceOfTruth
            : {};
        snapshot.sourceOfTruth = {
            ...sourceOfTruth,
            aggregateSnapshot: {
                ...(sourceOfTruth.aggregateSnapshot && typeof sourceOfTruth.aggregateSnapshot === 'object'
                    ? sourceOfTruth.aggregateSnapshot
                    : {}),
                owner: 'coordinator_daemon_memory',
                cached: true,
                source: 'memory',
                refreshReason: 'memory_cache_hit',
                ageMs,
                cachedAt: new Date(cached.builtAt).toISOString(),
                returnedAt: new Date().toISOString(),
            },
        };
        return snapshot;
}

export function rememberAggregateMeshStatus(
    self: DaemonCommandRouter,
    meshId: string,
    snapshot: any,
    refreshReason: string,
): any {
        if (!snapshot || typeof snapshot !== 'object' || snapshot.success !== true || !Array.isArray(snapshot.nodes)) return snapshot;
        const builtAt = Date.now();
        const next = cloneJsonValue(snapshot);
        const sourceOfTruth = next.sourceOfTruth && typeof next.sourceOfTruth === 'object'
            ? next.sourceOfTruth
            : {};
        next.sourceOfTruth = {
            ...sourceOfTruth,
            aggregateSnapshot: {
                owner: 'coordinator_daemon_memory',
                cached: false,
                source: 'live_refresh',
                refreshReason,
                ageMs: 0,
                cachedAt: new Date(builtAt).toISOString(),
                returnedAt: new Date(builtAt).toISOString(),
            },
        };
        self.aggregateMeshStatusCache.set(meshId, { builtAt, snapshot: cloneJsonValue(next), queueRevision: getMeshQueueRevision(meshId) });
        return next;
}
