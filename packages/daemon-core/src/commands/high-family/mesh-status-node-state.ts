/**
 * mesh_status ↔ coordinator-held node state (mesh/mesh-node-git-state.ts).
 *
 * The coordinator is the one place a client reads mesh topology from, and it
 * answers ONLY from what it holds: members push their git + runtime state,
 * the coordinator's own background probe is merely the (re-)subscription
 * handshake. Steps the mesh_status handler runs on EVERY call (cached,
 * stale-while-revalidate and live paths alike):
 *   1. render view — `buildHeldRenderMesh`: nodes served by ANOTHER daemon are
 *                 rendered from the held store only. Their dashboard-echoed
 *                 transient fields (inline `cachedStatus` / `lastGit` / active
 *                 session / health …) are stripped from the render copy — an
 *                 echo of what some client once saw is not truth — and the held
 *                 git becomes their `lastGit`, so the standing-truth paths render
 *                 git + submodules immediately.
 *   2. kick     — the handshake probe for a node with nothing held / a member
 *                 that stopped pushing; on an explicit refresh a NUDGE asking
 *                 subscribed members to push now. Never awaited.
 *   3. overlay  — stamp each returned node with `gitObservation` (source, age,
 *                 refreshing, unreachable-since) and, for foreign-daemon nodes,
 *                 `heldRuntime` plus the sessions / facts derived from it,
 *                 computed NOW, so even a cached aggregate snapshot reports the
 *                 current held state.
 *
 * Without a mesh transport (standalone) the daemon holds nothing for other
 * daemons, so step 1 keeps the legacy inline view.
 */
import * as fs from 'fs';
import { daemonIdsEquivalent, meshNodeIdMatches, normalizeMeshNodeId } from '@adhdev/mesh-shared';
import type { MeshNodeGitStateEntry, MeshNodeGitStateStore } from '../../mesh/mesh-node-git-state.js';
import { isHeldRuntimeLive, MESH_NODE_STATE_STALE_MS, type MeshNodeGitRefresher } from '../../mesh/mesh-node-git-refresher.js';
import type { MeshNodeRuntimeSession } from '../../mesh/mesh-node-runtime-summary.js';
import type { RepoMeshNodeGitObservation, RepoMeshNodeHeldRuntime } from '../../repo-mesh-types.js';

/** node.lastGit.source stamped on truth hydrated from the coordinator store. */
export const MESH_NODE_STATE_HELD_SOURCE = 'coordinator_node_state';
/** An explicit refresh nudges a node only when its observation is at least this old. */
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

/**
 * A node served by ANOTHER daemon. Runtime (sessions / build) is per daemon, so
 * this — not workspace locality — decides whether the coordinator answers a
 * node's runtime from held state: a second daemon on this machine (stable +
 * preview) owns sessions this daemon cannot list either.
 */
export function isForeignDaemonMeshNode(node: any, locality: MeshNodeLocality): boolean {
    const daemonId = readString(node?.daemonId);
    if (!daemonId) return false;
    if (locality.localMachineId && daemonIdsEquivalent(daemonId, locality.localMachineId)) return false;
    if (locality.localDaemonId && daemonIdsEquivalent(daemonId, locality.localDaemonId)) return false;
    return true;
}

function heldCheckedAt(node: any): number | null {
    const lastGit = readRecord(node?.lastGit ?? node?.last_git);
    const checkedAt = lastGit.checkedAt ?? lastGit.checked_at;
    return typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? checkedAt : null;
}

/** Transient per-node fields a client echoes back in its inlineMesh — never truth for a foreign-daemon node. */
const ECHOED_TRANSIENT_NODE_KEYS = [
    'cachedStatus', 'lastGit', 'last_git', 'lastProbe', 'last_probe', 'error', 'health', 'machineStatus',
    'lastSeenAt', 'last_seen_at', 'updatedAt', 'updated_at', 'activeSession', 'active_session',
    'activeSessionId', 'active_session_id', 'sessionId', 'session_id', 'providerType', 'provider_type',
    'activeSessions', 'active_sessions', 'activeSessionDetails', 'active_session_details',
] as const;

function heldLastGit(entry: MeshNodeGitStateEntry): Record<string, unknown> {
    return {
        source: MESH_NODE_STATE_HELD_SOURCE,
        checkedAt: entry.observedAt,
        status: { ...entry.git, lastCheckedAt: entry.observedAt },
    };
}

/**
 * Step 1 (in place, for readers that return the mesh record itself — get_mesh):
 * give each remote node the coordinator's held git as its `lastGit`. The store
 * is the single source: a node's own `lastGit` (possibly a client echo) never
 * flows back INTO the store. Returns the ids of nodes hydrated.
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
        const entry = args.store.get(args.meshId, nodeId);
        if (!entry?.git || entry.observedAt === null) continue;
        node.lastGit = heldLastGit(entry);
        node.last_git = node.lastGit;
        hydrated.add(nodeId);
    }
    return hydrated;
}

/**
 * Step 1 for mesh_status: a render COPY of the mesh in which every node served
 * by another daemon carries only held state — echoed transient fields stripped,
 * the held git as `lastGit` (remote workspaces), `machineStatus: 'online'` while
 * the member is still pushing. Nodes of this daemon are the same objects (the
 * render loop's local stamps keep landing on the record). Without a transport
 * (`heldOnly` false) the mesh is returned unchanged.
 */
export function buildHeldRenderMesh(args: {
    meshId: string;
    mesh: any;
    store: MeshNodeGitStateStore;
    locality: MeshNodeLocality;
    heldOnly: boolean;
    now?: number;
}): any {
    if (!args.heldOnly || !args.mesh || !Array.isArray(args.mesh.nodes)) return args.mesh;
    const now = args.now ?? Date.now();
    let replaced = false;
    const nodes = args.mesh.nodes.map((node: any) => {
        if (!node || typeof node !== 'object' || !isForeignDaemonMeshNode(node, args.locality)) return node;
        const nodeId = normalizeMeshNodeId(node) ?? '';
        const view: Record<string, any> = { ...node };
        for (const key of ECHOED_TRANSIENT_NODE_KEYS) delete view[key];
        const entry = nodeId ? args.store.get(args.meshId, nodeId) : undefined;
        if (entry?.git && entry.observedAt !== null && isRemoteMeshNodeForState(node, args.locality)) {
            view.lastGit = heldLastGit(entry);
            view.last_git = view.lastGit;
        }
        const gitLive = !!entry?.git && entry.source === 'member_push' && entry.observedAt !== null
            && now - entry.observedAt < MESH_NODE_STATE_STALE_MS && entry.unreachableSince === null;
        if (gitLive || isHeldRuntimeLive(entry, now)) view.machineStatus = 'online';
        replaced = true;
        return view;
    });
    return replaced ? { ...args.mesh, nodes } : args.mesh;
}

/** Step 2. Non-blocking; returns how many background probes / nudges were started. */
export function kickMeshNodeGitRefreshes(args: {
    meshId: string;
    mesh: any;
    store: MeshNodeGitStateStore;
    refresher: MeshNodeGitRefresher;
    locality: MeshNodeLocality;
    /**
     * Explicit refresh: ask every remote member whose observation is at least
     * MESH_NODE_STATE_REFRESH_MAX_AGE_MS old to push now (nudge). Never a forced
     * probe of a subscribed member.
     */
    refresh: boolean;
    now?: number;
}): number {
    const now = args.now ?? Date.now();
    let started = 0;
    const nodes = Array.isArray(args.mesh?.nodes) ? args.mesh.nodes : [];
    const runtimeTargetsByDaemon = new Map<string, Array<{ nodeId: string; workspace: string; force: boolean }>>();
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        if (!isForeignDaemonMeshNode(node, args.locality)) continue;
        const nodeId = normalizeMeshNodeId(node) ?? '';
        const daemonId = readString(node.daemonId);
        const workspace = readString(node.workspace);
        if (!nodeId || !daemonId || !workspace) continue;
        const entry = args.store.get(args.meshId, nodeId);
        const target = { meshId: args.meshId, nodeId, daemonId, workspace };
        const gitOld = !entry || entry.observedAt === null || now - entry.observedAt >= MESH_NODE_STATE_REFRESH_MAX_AGE_MS;
        const runtimeOld = !entry || entry.runtimeObservedAt === null || now - entry.runtimeObservedAt >= MESH_NODE_STATE_REFRESH_MAX_AGE_MS;
        if (isRemoteMeshNodeForState(node, args.locality)) {
            // The handshake probe first (nothing held / member stopped pushing);
            // otherwise an explicit refresh nudges the member to push now.
            if (args.refresher.kick(target)) started += 1;
            else if (args.refresh && (gitOld || runtimeOld) && args.refresher.nudge(target)) started += 1;
        }
        const targets = runtimeTargetsByDaemon.get(daemonId) ?? [];
        // `force` only reaches members that do not push their runtime (older builds).
        targets.push({ nodeId, workspace, force: args.refresh && runtimeOld });
        runtimeTargetsByDaemon.set(daemonId, targets);
    }
    for (const [daemonId, targets] of runtimeTargetsByDaemon) {
        if (args.refresher.kickRuntime(args.meshId, daemonId, targets)) started += 1;
    }
    return started;
}

function factsReportedAt(facts: unknown): number {
    const reportedAt = readRecord(facts).reportedAt;
    return typeof reportedAt === 'number' && Number.isFinite(reportedAt) ? reportedAt : 0;
}

function toIso(value: unknown): string | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

/**
 * Whether a held session belongs to this node: stamped with the node's id
 * (id-form tolerant) on this mesh, or — for the mesh's coordinator node — the
 * mesh's coordinator session.
 */
function heldSessionBelongsToNode(session: MeshNodeRuntimeSession, meshId: string, nodeId: string, isCoordinatorNode: boolean): boolean {
    const settings = session.settings ?? {};
    const sessionMesh = settings.meshNodeFor;
    if (settings.meshNodeId && (!sessionMesh || sessionMesh === meshId)
        && (daemonIdsEquivalent(settings.meshNodeId, nodeId) || meshNodeIdMatches({ id: nodeId }, settings.meshNodeId))) {
        return true;
    }
    return isCoordinatorNode && (settings.meshCoordinatorFor === meshId || session.coordinator?.meshId === meshId);
}

/** A held session in the activeSessionDetails shape the dashboard already renders (held = cached, not live here). */
function heldSessionDetail(session: MeshNodeRuntimeSession, meshId: string): Record<string, unknown> {
    const isCoordinator = session.settings?.meshCoordinatorFor === meshId || session.coordinator?.meshId === meshId;
    const chatStatus = session.activeChat?.status ?? session.status;
    return {
        sessionId: session.id,
        providerType: session.providerType,
        state: session.status,
        chatStatus,
        ...(session.turn?.attemptId ? { attemptId: session.turn.attemptId } : {}),
        ...(session.turn?.stage ? { turnStage: session.turn.stage } : {}),
        lifecycle: undefined,
        recoveryState: null,
        workspace: null,
        title: null,
        role: isCoordinator ? 'coordinator' : null,
        isSelfCoordinator: isCoordinator,
        statusNote: null,
        createdAt: null,
        startedAt: null,
        lastActivityAt: toIso(session.lastMessageAt),
        ...(session.lastMessageRole ? { lastMessageRole: session.lastMessageRole } : {}),
        ...(typeof session.lastMessageAt === 'number' ? { lastMessageAt: session.lastMessageAt } : {}),
        ...(typeof session.surfaceHidden === 'boolean' ? { surfaceHidden: session.surfaceHidden } : {}),
        ...(typeof session.muted === 'boolean' ? { muted: session.muted } : {}),
        ...(typeof session.settings?.userHidden === 'boolean' ? { userHidden: session.settings.userHidden } : {}),
        ...(typeof session.settings?.userMuted === 'boolean' ? { userMuted: session.settings.userMuted } : {}),
        isCached: true,
        heldSource: 'coordinator_node_state',
    };
}

/**
 * The held runtime of one foreign-daemon node, rendered NOW: `heldRuntime`, the
 * newest facts bundle (quota / build) and the version chips derived from it,
 * and — when `renderSessions` — the node's active sessions from the held
 * summary (the ONLY session source for a node served by another daemon).
 */
function overlayHeldRuntime(
    status: Record<string, any>,
    entry: ReturnType<MeshNodeGitStateStore['get']>,
    refreshing: boolean,
    opts: { meshId: string; nodeId: string; isCoordinatorNode: boolean; renderSessions: boolean },
): void {
    const runtime = entry?.runtime ?? null;
    const held: RepoMeshNodeHeldRuntime = {
        source: runtime ? (entry?.runtimeSource ?? 'member_push') : 'none',
        observedAt: runtime ? (entry?.runtimeObservedAt ?? null) : null,
        refreshing,
        sessions: runtime ? runtime.sessions : [],
        ...(runtime?.daemonId ? { daemonId: runtime.daemonId } : {}),
        ...(runtime?.daemonBuild ? { daemonBuild: runtime.daemonBuild } : {}),
        ...(runtime?.upgradeFailure ? { upgradeFailure: runtime.upgradeFailure } : {}),
        ...(runtime?.sessionsTruncated ? { sessionsTruncated: true } : {}),
        ...(runtime?.providers ? { providers: runtime.providers } : {}),
        ...(runtime?.sessionStampVersion ? { sessionStampVersion: runtime.sessionStampVersion } : {}),
    };
    status.heldRuntime = held;
    // Quota / build facts: the pushed bundle wins when it is newer than the one
    // stamped on the node record (which only a git probe's envelope refreshes).
    if (runtime?.nodeFacts && factsReportedAt(runtime.nodeFacts) > factsReportedAt(status.nodeFacts)) {
        status.nodeFacts = runtime.nodeFacts;
    }
    // Version chips come from the held facts bundle, not from whatever a past
    // probe persisted on the node record.
    const facts = runtime?.nodeFacts;
    if (facts?.providerVersions && typeof facts.providerVersions === 'object' && Object.keys(facts.providerVersions).length > 0) {
        status.providerVersions = facts.providerVersions;
    }
    const buildVersion = readString(facts?.daemonBuild?.version) || readString(runtime?.daemonBuild?.version);
    if (buildVersion) status.daemonBuildVersion = buildVersion;
    if (!opts.renderSessions) return;
    const sessions = runtime
        ? runtime.sessions.filter((session) => heldSessionBelongsToNode(session, opts.meshId, opts.nodeId, opts.isCoordinatorNode))
        : [];
    status.activeSessions = sessions.map((session) => session.id);
    status.activeSessionDetails = sessions.map((session) => heldSessionDetail(session, opts.meshId));
    const providerTypes = sessions.map((session) => readString(session.providerType)).filter(Boolean);
    if (providerTypes.length > 0) {
        status.providers = Array.from(new Set([...(Array.isArray(status.providers) ? status.providers : []), ...providerTypes]));
    }
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
    /** Enables the held-runtime overlay (sessions / build / quota of nodes served by another daemon). */
    locality?: MeshNodeLocality;
    /**
     * Render foreign-daemon nodes' active sessions from the held runtime only
     * (the coordinator has a mesh transport, so it holds that state). Off in
     * standalone, where nothing is held for other daemons.
     */
    heldSessions?: boolean;
    /** The mesh's coordinator node (its held coordinator session renders on it). */
    coordinatorNodeId?: string;
}): void {
    if (!snapshot || !Array.isArray(snapshot.nodes)) return;
    if (args.locality) snapshot.nodeRuntimeHeld = true;
    for (const status of snapshot.nodes) {
        if (!status || typeof status !== 'object') continue;
        const nodeId = readString(status.nodeId);
        const daemonId = readString(status.daemonId);
        if (args.locality && status.connection?.state !== 'self' && isForeignDaemonMeshNode(status, args.locality)) {
            overlayHeldRuntime(
                status,
                nodeId ? args.store.get(args.meshId, nodeId) : undefined,
                daemonId ? args.refresher.isRuntimeRefreshing(args.meshId, daemonId) : false,
                {
                    meshId: args.meshId,
                    nodeId,
                    isCoordinatorNode: !!nodeId && !!args.coordinatorNodeId && nodeId === args.coordinatorNodeId,
                    renderSessions: args.heldSessions === true,
                },
            );
        }
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
