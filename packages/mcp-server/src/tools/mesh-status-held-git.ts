// COORDINATOR-HELD NODE GIT for the MCP `mesh_status` tool.
//
// Owner principle (2026-09-26): nothing fetches fresh values from remote nodes on
// demand — the coordinator daemon always holds every node's latest git/submodule
// state (member pushes + its own background refresh, daemon-core
// mesh/mesh-node-git-state.ts) and answers from it. The dashboard already reads
// that way (daemon `mesh_status`, waves 31–32). This module makes the
// coordinator AGENT's `mesh_status` tool read the SAME held state, over ONE local
// IPC call to the coordinator daemon's `mesh_status` command, instead of probing
// every node's `git_status` (refreshUpstream) over P2P on each call — which made
// the request wait on the slowest peer and could disagree with the dashboard.
//
// `refresh: true` is forwarded to the daemon, which KICKS its background refresh
// and returns immediately; the kicked nodes report `gitObservation.refreshing`.
//
// RUNTIME (sessions / daemon build / upgrade marker / quota facts) of nodes served
// by ANOTHER daemon comes from the same read: members push a content-free runtime
// summary to the coordinator (daemon-core mesh/mesh-node-runtime-summary.ts), which
// stamps it as `heldRuntime` and marks the response `nodeRuntimeHeld: true`. With
// that marker this tool makes NO per-daemon get_status_metadata call for remote
// nodes; the coordinator's own nodes are still read directly (one local IPC call).
// A coordinator daemon without the marker (older build) keeps the legacy per-daemon
// probe — the only case a remote read remains, and it disappears with the daemon.
// Write paths that must see live git (refine, fast-forward, clone advisory,
// mesh_git_status detail read) are NOT routed through here.

import {
    assignFullGitSnapshot,
    buildBranchConvergence,
    countUncommittedChanges,
    extractSubmodules,
    isGitStatusDirty,
    meshNodeIdMatches,
    readNodeDaemonId,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';
import type { LocalMeshNodeEntry, MeshContext, MeshUpgradeFailureSummary } from './mesh-tools-internal.js';
import { extractDaemonBuildInfo, isLocalControlPlaneNode } from './mesh-tools-internal.js';
import { IpcTransport } from '../transports/ipc.js';

/** Mirror of daemon-core `RepoMeshNodeGitObservation` (wire contract). */
export interface HeldNodeGitObservation {
    source: 'self' | 'local' | 'member_push' | 'coordinator_probe' | 'none';
    observedAt: number | null;
    refreshing: boolean;
    unreachableSince: number | null;
    lastRefreshError?: string | null;
}

export interface CoordinatorHeldNodeState {
    /** Daemon-rendered node status, keyed by nodeId. */
    byNodeId: Map<string, Record<string, any>>;
    /** Set when the coordinator daemon could not answer (IPC failure / error result). */
    error?: string;
    /** The daemon answered with held runtime for foreign-daemon nodes (`nodeRuntimeHeld`). */
    runtimeHeld?: boolean;
}

/** Where a node's sessions / build came from on this call. */
export interface HeldNodeRuntimeObservation {
    /** 'local_read' = the coordinator's own daemon, read directly; 'none' = nothing held yet (sessions unknown, not zero). */
    source: 'local_read' | 'member_push' | 'coordinator_probe' | 'none';
    observedAt: number | null;
    refreshing: boolean;
}

/** Same shape as collectLiveStatusProbe's result. */
export interface NodeStatusProbe {
    sessions: any[];
    daemonId?: string;
    daemonBuild?: { commit: string; commitShort: string; version: string; builtAt?: string; track: 'stable' | 'preview' | 'unknown' };
    upgradeFailure?: MeshUpgradeFailureSummary;
}

function readRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

/**
 * ONE local read of the coordinator daemon's held mesh view. Never probes a
 * remote node: the daemon's `mesh_status` answers from its node-git store and
 * only kicks (never awaits) background refreshes. `awaitLiveProbes` is never
 * sent — that internal escape hatch is for daemon-side callers only.
 */
export async function readCoordinatorHeldNodeState(
    ctx: MeshContext,
    opts: { refresh?: boolean } = {},
): Promise<CoordinatorHeldNodeState> {
    const byNodeId = new Map<string, Record<string, any>>();
    let raw: any;
    try {
        raw = await ctx.transport.command('mesh_status', {
            meshId: ctx.mesh.id,
            ...(opts.refresh === true ? { refresh: true } : {}),
        });
    } catch (error: any) {
        return { byNodeId, error: error?.message || 'coordinator mesh_status read failed' };
    }
    const payload = unwrapCommandPayload(raw);
    const record = readRecord(payload) ?? readRecord(raw);
    if (!record || record.success === false) {
        return { byNodeId, error: typeof record?.error === 'string' ? record.error : 'coordinator mesh_status returned no node state' };
    }
    const nodes = Array.isArray(record.nodes) ? record.nodes : [];
    for (const node of nodes) {
        const status = readRecord(node);
        const nodeId = typeof status?.nodeId === 'string' ? status.nodeId : '';
        if (status && nodeId) byNodeId.set(nodeId, status);
    }
    return { byNodeId, ...(record.nodeRuntimeHeld === true ? { runtimeHeld: true } : {}) };
}

/**
 * Whether this node's runtime is answered from the coordinator-held state: the
 * daemon holds runtime (marker) and the node is served by another daemon — the
 * exact case in which the legacy path made a P2P get_status_metadata round trip
 * (commandForNode's remote branch).
 */
export function usesHeldNodeRuntime(ctx: MeshContext, node: LocalMeshNodeEntry, state: CoordinatorHeldNodeState): boolean {
    if (state.runtimeHeld !== true) return false;
    if (!(ctx.transport instanceof IpcTransport) || !node.daemonId) return false;
    return !isLocalControlPlaneNode(ctx, node);
}

/**
 * The held runtime as a status probe result — no transport call. A node with no
 * held runtime yet returns no sessions and `source: 'none'` (unknown, the
 * daemon's background refresh is kicked), never a live read.
 */
export function heldNodeStatusProbe(held: Record<string, any> | undefined): { probe: NodeStatusProbe; observation: HeldNodeRuntimeObservation } {
    const runtime = readRecord(held?.heldRuntime);
    const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const source = runtime?.source === 'member_push' || runtime?.source === 'coordinator_probe' ? runtime.source : 'none';
    const observation: HeldNodeRuntimeObservation = {
        source,
        observedAt: source === 'none' ? null : numberOrNull(runtime?.observedAt),
        refreshing: runtime?.refreshing === true,
    };
    if (!runtime || source === 'none') return { probe: { sessions: [] }, observation };
    const daemonBuild = extractDaemonBuildInfo({ daemonBuild: runtime.daemonBuild });
    const failure = readRecord(runtime.upgradeFailure);
    const targetVersion = typeof failure?.targetVersion === 'string' ? failure.targetVersion : undefined;
    const upgradeFailure: MeshUpgradeFailureSummary | undefined = failure
        ? {
            // The notice prose stays on the node (content-free push); the structured facts travel.
            summary: `Daemon upgrade${targetVersion ? ` to ${targetVersion}` : ''} failed on this node (rolled back); the full notice is on that node.`,
            ...(typeof failure.recordedAt === 'string' ? { recordedAt: failure.recordedAt } : {}),
            ...(targetVersion ? { targetVersion } : {}),
            noticePath: typeof failure.noticePath === 'string' ? failure.noticePath : '',
            logPath: typeof failure.logPath === 'string' ? failure.logPath : '',
        }
        : undefined;
    return {
        probe: {
            sessions: Array.isArray(runtime.sessions) ? runtime.sessions : [],
            ...(typeof runtime.daemonId === 'string' && runtime.daemonId ? { daemonId: runtime.daemonId } : {}),
            ...(daemonBuild ? { daemonBuild } : {}),
            ...(upgradeFailure ? { upgradeFailure } : {}),
        },
        observation,
    };
}

/** The daemon-rendered status for `node` (exact id, then canonical id-form match). */
export function findHeldNodeStatus(state: CoordinatorHeldNodeState, node: LocalMeshNodeEntry): Record<string, any> | undefined {
    const exact = state.byNodeId.get(node.id);
    if (exact) return exact;
    for (const [nodeId, status] of state.byNodeId) {
        if (meshNodeIdMatches(node as any, nodeId)) return status;
    }
    return undefined;
}

export function readHeldNodeGitObservation(held: Record<string, any> | undefined): HeldNodeGitObservation {
    const obs = readRecord(held?.gitObservation);
    const source = obs?.source;
    const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
        source: source === 'self' || source === 'local' || source === 'member_push' || source === 'coordinator_probe' ? source : 'none',
        observedAt: numberOrNull(obs?.observedAt),
        refreshing: obs?.refreshing === true,
        unreachableSince: numberOrNull(obs?.unreachableSince),
        ...(typeof obs?.lastRefreshError === 'string' ? { lastRefreshError: obs.lastRefreshError } : {}),
    };
}

// Same buckets as daemon-core buildMeshNodeDataFreshness (30 s / 5 min).
const FRESH_MS = 30_000;
const RECENT_MS = 300_000;

function classifyStaleness(dataSource: string, ageMs: number | null): string {
    if (dataSource === 'self' || dataSource === 'live') return 'fresh';
    if (ageMs === null) return 'unknown';
    if (ageMs < FRESH_MS) return 'fresh';
    if (ageMs < RECENT_MS) return 'recent';
    return 'stale';
}

/**
 * The node's `dataFreshness` marker, kept wire-compatible with the old shape
 * ({dataSource, probeOk, reachable, directPeerTruthSatisfied, projection,
 * lastProbeAt, ageMs, staleness}) and DERIVED FROM `gitObservation`:
 *   - self / local            → 'self' / 'live' (read on the coordinator's machine)
 *   - member_push / probe     → 'cached' with the observation's age
 *   - none                    → 'pending' (refresh in flight / reachable),
 *                               'unreachable' (refreshes failing), 'unconfigured'
 * `unreachableSince` always forces `reachable:false`. The daemon's own marker is
 * used for the fields the observation cannot tell (connection-derived
 * reachability of a cached node) so both surfaces agree.
 */
export function deriveDataFreshnessFromObservation(args: {
    observation: HeldNodeGitObservation;
    daemonFreshness?: Record<string, any> | null;
    hasGit: boolean;
    isSelfNode: boolean;
    daemonId?: string;
    now?: number;
}): Record<string, unknown> {
    const { observation, hasGit, isSelfNode, daemonId } = args;
    const daemon = readRecord(args.daemonFreshness);
    const now = args.now ?? Date.now();
    const unreachable = observation.unreachableSince !== null;
    let dataSource: string;
    let reachable: boolean | null;
    if (observation.source === 'self' || (isSelfNode && observation.source === 'none' && hasGit)) {
        dataSource = 'self';
        reachable = true;
    } else if (observation.source === 'local') {
        dataSource = 'live';
        reachable = true;
    } else if (hasGit && (observation.source === 'member_push' || observation.source === 'coordinator_probe' || observation.observedAt !== null)) {
        dataSource = 'cached';
        reachable = unreachable ? false : (typeof daemon?.reachable === 'boolean' ? daemon.reachable : null);
    } else if (!daemonId) {
        dataSource = 'unconfigured';
        reachable = null;
    } else if (unreachable) {
        dataSource = 'unreachable';
        reachable = false;
    } else {
        dataSource = 'pending';
        reachable = typeof daemon?.reachable === 'boolean' ? daemon.reachable : null;
    }
    const probeOk = dataSource === 'self' || dataSource === 'live';
    const lastProbeAt = observation.observedAt !== null
        ? new Date(observation.observedAt).toISOString()
        : (typeof daemon?.lastProbeAt === 'string' ? daemon.lastProbeAt : null);
    const lastProbeMs = lastProbeAt ? Date.parse(lastProbeAt) : NaN;
    const ageMs = Number.isFinite(lastProbeMs) ? Math.max(0, now - lastProbeMs) : null;
    return {
        dataSource,
        probeOk,
        reachable,
        directPeerTruthSatisfied: probeOk,
        projection: dataSource === 'cached' ? 'cached' : 'live_or_absent',
        lastProbeAt,
        ageMs,
        staleness: classifyStaleness(dataSource, ageMs),
    };
}

/**
 * Stamp one coordinator-surface node entry from the daemon-held node status:
 * health / git / branch / dirty / branchConvergence / staleDaemonBuild / quota /
 * submodule warning (same derivations as the old live-probe path), plus
 * `gitObservation` and a `dataFreshness` derived from it. Never throws and never
 * touches the transport.
 */
export function applyHeldNodeGitToEntry(entry: Record<string, any>, args: {
    mesh: MeshContext['mesh'];
    node: LocalMeshNodeEntry;
    held: Record<string, any> | undefined;
    heldStateError?: string;
    now?: number;
}): void {
    const { mesh, node, held } = args;
    const observation = readHeldNodeGitObservation(held);
    const status = readRecord(held?.git);
    const hasGit = !!status && (typeof status.isGitRepo === 'boolean' || typeof status.branch === 'string');
    if (hasGit && status) {
        const uncommittedChanges = countUncommittedChanges(status);
        const dirty = isGitStatusDirty(status);
        entry.health = status.isGitRepo ? (dirty ? 'dirty' : 'online') : 'degraded';
        assignFullGitSnapshot(entry, status);
        entry.branch = status.branch;
        entry.isDirty = dirty;
        entry.uncommittedChanges = uncommittedChanges;
        entry.branchConvergence = buildBranchConvergence(mesh as any, node, status, dirty, uncommittedChanges);
        const buildBehind = readRecord(status.daemonBuildBehind) ?? readRecord(held?.staleDaemonBuild);
        if (buildBehind) entry.staleDaemonBuild = buildBehind;
        const policy = (node.policy as any) ?? {};
        const submodules = policy.autoDiscoverSubmodules === false
            ? undefined
            : extractSubmodules({ status }, policy.submoduleIgnorePaths || []);
        if (submodules && submodules.some((s: any) => s?.outOfSync)) {
            entry.submoduleWarning = 'One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.';
            entry.outOfSyncSubmodules = submodules.filter((s: any) => s?.outOfSync).map((s: any) => s.path);
        }
    } else if (args.heldStateError) {
        entry.health = 'unknown';
        entry.degradedReason = 'coordinator_state_unavailable';
        entry.error = `Coordinator daemon node state unavailable: ${args.heldStateError}`;
    } else if (observation.unreachableSince !== null) {
        entry.health = 'degraded';
        entry.degradedReason = 'node_unreachable';
        entry.error = `No git state held for this node; the coordinator's background refresh has failed since ${new Date(observation.unreachableSince).toISOString()}${observation.lastRefreshError ? ` (${observation.lastRefreshError})` : ''}.`;
    } else {
        // Held state not yet observed (new node / member not pushing yet): the
        // daemon has a background refresh kicked; report it as pending, not failed.
        entry.health = 'unknown';
        entry.gitProbePending = true;
        if (typeof held?.error === 'string' && held.error) entry.error = held.error;
    }
    // Provider quota facts, as last reported by the node that owns the credentials
    // (held on the coordinator's node record — the same bundle quota routing reads).
    const quota = readRecord(readRecord(held?.nodeFacts)?.quota);
    if (quota && Object.keys(quota).length > 0) entry.quota = quota;

    entry.gitObservation = observation;
    entry.dataFreshness = deriveDataFreshnessFromObservation({
        observation,
        daemonFreshness: readRecord(held?.dataFreshness),
        hasGit,
        isSelfNode: (entry.machine as any)?.sameMachine === true,
        daemonId: readNodeDaemonId(node),
        now: args.now,
    });
}

/**
 * Top-level `nodeGitState` block: where node git came from, and — on an explicit
 * `refresh` — which nodes the coordinator is refreshing in the background right
 * now (the call itself never waits for them; a later mesh_status shows the result).
 */
export function buildNodeGitStateSummary(entries: Array<Record<string, any>>, error: string | undefined, refreshRequested: boolean): { nodeGitState: Record<string, unknown> } {
    const refreshingNodeIds = entries
        .filter((entry) => entry?.gitObservation?.refreshing === true)
        .map((entry) => String(entry.nodeId));
    return {
        nodeGitState: {
            source: 'coordinator_held',
            ...(error ? { error } : {}),
            ...(refreshRequested ? { refreshRequested: true } : {}),
            refreshing: refreshingNodeIds.length > 0,
            ...(refreshingNodeIds.length > 0 ? { refreshingNodeIds } : {}),
        },
    };
}
