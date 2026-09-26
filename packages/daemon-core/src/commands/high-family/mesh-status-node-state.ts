/**
 * mesh_status ↔ coordinator-held node git state (mesh/mesh-node-git-state.ts).
 *
 * Three pure-ish steps the mesh_status handler runs on EVERY call (cached,
 * stale-while-revalidate and live paths alike):
 *   1. hydrate  — give each remote node the coordinator's last-known git as its
 *                 held truth (node.lastGit), so the existing standing-truth paths
 *                 render git + submodules immediately instead of "probe pending";
 *   2. kick     — start the coordinator's own background refresh for remote nodes
 *                 whose observation is missing/stale (or on an explicit refresh);
 *                 never awaited, so a slow or dead peer cannot hold the response;
 *   3. overlay  — stamp each returned node with `gitObservation` (source, age,
 *                 refreshing, unreachable-since) computed NOW, so even a cached
 *                 aggregate snapshot reports the current refresh state.
 */
import * as fs from 'fs';
import { daemonIdsEquivalent, normalizeMeshNodeId } from '@adhdev/mesh-shared';
import type { MeshNodeGitStateStore } from '../../mesh/mesh-node-git-state.js';
import type { MeshNodeGitRefresher } from '../../mesh/mesh-node-git-refresher.js';
import { buildInlineMeshTransitGitStatus } from '../../mesh/mesh-node-identity.js';
import type { RepoMeshNodeGitObservation } from '../../repo-mesh-types.js';

/** node.lastGit.source stamped on truth hydrated from the coordinator store. */
export const MESH_NODE_STATE_HELD_SOURCE = 'coordinator_node_state';
/** An explicit refresh re-probes a node only when its observation is at least this old. */
export const MESH_NODE_STATE_REFRESH_MAX_AGE_MS = 30_000;

export interface MeshNodeLocality {
    localMachineId?: string;
    localDaemonId?: string;
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function workspaceExistsLocally(workspace: string): boolean {
    if (!workspace) return false;
    try { return fs.existsSync(workspace); } catch { return false; }
}

/**
 * A node whose git truth the coordinator cannot read itself: it belongs to
 * another daemon and its workspace is not on this machine.
 */
export function isRemoteMeshNodeForState(node: any, locality: MeshNodeLocality): boolean {
    const daemonId = readString(node?.daemonId);
    if (!daemonId) return false;
    if (locality.localMachineId && daemonIdsEquivalent(daemonId, locality.localMachineId)) return false;
    if (locality.localDaemonId && daemonIdsEquivalent(daemonId, locality.localDaemonId)) return false;
    return !workspaceExistsLocally(readString(node?.workspace));
}

function heldCheckedAt(node: any): number | null {
    const lastGit = readRecord(node?.lastGit ?? node?.last_git);
    const checkedAt = lastGit.checkedAt ?? lastGit.checked_at;
    return typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? checkedAt : null;
}

/**
 * Step 1. Returns the ids of nodes whose held truth now comes from the store.
 * A node that already carries newer held truth (an inline cache fed by a live
 * probe this process made) keeps it.
 */
export function hydrateMeshNodesFromGitState(args: {
    meshId: string;
    mesh: any;
    store: MeshNodeGitStateStore;
    locality: MeshNodeLocality;
}): Set<string> {
    const hydrated = new Set<string>();
    const nodes = Array.isArray(args.mesh?.nodes) ? args.mesh.nodes : [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        if (!isRemoteMeshNodeForState(node, args.locality)) continue;
        const nodeId = normalizeMeshNodeId(node) ?? '';
        if (!nodeId) continue;
        let entry = args.store.get(args.meshId, nodeId);
        const existingAt = heldCheckedAt(node);
        const heldGit = buildInlineMeshTransitGitStatus(node);
        if (heldGit && existingAt !== null && (!entry || entry.observedAt === null || existingAt > entry.observedAt)) {
            // Newer held truth than the store (an inline cache fed by this
            // process's own direct probe, e.g. get_mesh): it IS an observation —
            // record it so the store stays the single latest view and the
            // background refresher does not re-probe a node just confirmed.
            args.store.recordObservation({
                meshId: args.meshId,
                nodeId,
                workspace: readString(node.workspace),
                git: heldGit,
                source: 'coordinator_probe',
                observedAt: existingAt,
            });
            continue;
        }
        entry = entry ?? args.store.get(args.meshId, nodeId);
        if (!entry?.git || entry.observedAt === null) continue;
        if (heldGit && existingAt !== null && existingAt >= entry.observedAt) continue;
        node.lastGit = {
            source: MESH_NODE_STATE_HELD_SOURCE,
            checkedAt: entry.observedAt,
            status: { ...entry.git, lastCheckedAt: entry.observedAt },
        };
        node.last_git = node.lastGit;
        hydrated.add(nodeId);
    }
    return hydrated;
}

/** Step 2. Non-blocking; returns how many background probes were started. */
export function kickMeshNodeGitRefreshes(args: {
    meshId: string;
    mesh: any;
    store: MeshNodeGitStateStore;
    refresher: MeshNodeGitRefresher;
    locality: MeshNodeLocality;
    /** Explicit refresh: probe any remote node whose observation is ≥ MESH_NODE_STATE_REFRESH_MAX_AGE_MS old. */
    refresh: boolean;
    now?: number;
}): number {
    const now = args.now ?? Date.now();
    let started = 0;
    const nodes = Array.isArray(args.mesh?.nodes) ? args.mesh.nodes : [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        if (!isRemoteMeshNodeForState(node, args.locality)) continue;
        const nodeId = normalizeMeshNodeId(node) ?? '';
        const daemonId = readString(node.daemonId);
        const workspace = readString(node.workspace);
        if (!nodeId || !daemonId || !workspace) continue;
        const entry = args.store.get(args.meshId, nodeId);
        const force = args.refresh
            && (!entry || entry.observedAt === null || now - entry.observedAt >= MESH_NODE_STATE_REFRESH_MAX_AGE_MS);
        if (args.refresher.kick({ meshId: args.meshId, nodeId, daemonId, workspace }, { force })) started += 1;
    }
    return started;
}

const LIVE_PEER_REASON_PREFIX = 'Live peer git snapshot';

/**
 * Step 3. Mutates `snapshot.nodes` in place (the caller passes a clone it is
 * about to return). Also corrects the connection claim for nodes rendered from
 * the store: held truth is not a live peer confirmation.
 */
export function overlayMeshNodeGitObservations(snapshot: any, args: {
    meshId: string;
    store: MeshNodeGitStateStore;
    refresher: MeshNodeGitRefresher;
}): void {
    if (!snapshot || !Array.isArray(snapshot.nodes)) return;
    for (const status of snapshot.nodes) {
        if (!status || typeof status !== 'object') continue;
        const nodeId = readString(status.nodeId);
        const connection = readRecord(status.connection);
        const git = readRecord(status.git);
        const workspace = readString(status.workspace);
        const isSelf = connection.state === 'self';
        const isLocal = !isSelf && workspaceExistsLocally(workspace);
        if (isSelf || isLocal) {
            const checkedAt = typeof git.lastCheckedAt === 'number' ? git.lastCheckedAt : null;
            status.gitObservation = {
                source: isSelf ? 'self' : 'local',
                observedAt: checkedAt,
                refreshing: false,
                unreachableSince: null,
            } satisfies RepoMeshNodeGitObservation;
            continue;
        }
        const entry = nodeId ? args.store.get(args.meshId, nodeId) : undefined;
        const refreshing = nodeId ? args.refresher.isRefreshing(args.meshId, nodeId) : false;
        const observation: RepoMeshNodeGitObservation = {
            source: entry?.source ?? 'none',
            observedAt: entry?.observedAt ?? null,
            refreshing,
            unreachableSince: entry?.unreachableSince ?? null,
            ...(entry?.unreachableSince ? { lastRefreshError: entry.lastFailureReason ?? null } : {}),
        };
        status.gitObservation = observation;
        const liveThisCall = readRecord(status.dataFreshness).dataSource === 'live';
        if (!liveThisCall && entry?.git && connection.authority === 'live_peer'
            && readString(connection.reason).startsWith(LIVE_PEER_REASON_PREFIX)) {
            status.connection = {
                ...connection,
                state: 'unknown',
                reported: false,
                directPeerTruthSatisfied: false,
                authority: MESH_NODE_STATE_HELD_SOURCE,
                cached: true,
                reason: 'Last-known git state held by the coordinator; no live peer telemetry for this node yet.',
            };
        }
    }
}
