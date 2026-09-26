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
    collectLiveStatusProbe,
    collectLiveStatusSessionsVerified,
    countUncommittedChanges,
    extractSubmodules,
    isGitStatusDirty,
    meshNodeIdMatches,
    readNodeDaemonId,
    unwrapCommandPayload,
} from './mesh-tools-internal.js';
import type { LocalMeshNodeEntry, MeshContext } from './mesh-tools-internal.js';
import { isLocalControlPlaneNode } from './mesh-tools-internal.js';
import { IpcTransport } from '../transports/ipc.js';
import {
    cachedHeldNodeState,
    findHeldNodeStatus,
    heldNodeStatusProbe,
    usesHeldNodeRuntime,
} from './mesh-held-node-state.js';
import type { HeldNodeRuntimeObservation, NodeStatusProbe } from './mesh-held-node-state.js';

// The held-read primitive lives in mesh-held-node-state.ts (importable by
// mesh-tools-internal.ts without a cycle); re-exported so importers of this
// module keep working unchanged.
export {
    __resetNodeRuntimeCacheForTest,
    findHeldNodeStatus,
    heldNodeStatusProbe,
    readCoordinatorHeldNodeState,
    usesHeldNodeRuntime,
} from './mesh-held-node-state.js';
export type {
    CoordinatorHeldNodeState,
    HeldNodeRuntimeObservation,
    NodeStatusProbe,
} from './mesh-held-node-state.js';

function readRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

/** Mirror of daemon-core `RepoMeshNodeGitObservation` (wire contract). */
export interface HeldNodeGitObservation {
    source: 'self' | 'local' | 'member_push' | 'coordinator_probe' | 'none';
    observedAt: number | null;
    refreshing: boolean;
    unreachableSince: number | null;
    lastRefreshError?: string | null;
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
 * submodule warning, plus `gitObservation` and a `dataFreshness`. Never throws
 * and never touches the transport.
 *
 * AUDIT FIX (owner principle 2026-09-26): the daemon's `mesh_status` handler
 * already computes `health` (deriveMeshNodeHealthFromGit) and
 * `branchConvergence` (applyInlineMeshBranchConvergence) on every node object
 * in the SAME response this reads (daemon-core mesh-status.ts / mesh-node-
 * identity.ts / mesh-branch-convergence.ts) — re-deriving them here from the
 * raw git snapshot duplicated logic the daemon already ran. When the daemon
 * supplies them (`held.health` / `held.branchConvergence`), they are passed
 * through as-is; the MCP-side derivation below runs ONLY as a fallback for an
 * older daemon whose `mesh_status` response predates these fields (or a test
 * fixture answering the bare git shape).
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
    const daemonHealth = typeof held?.health === 'string' ? held.health : undefined;
    const daemonBranchConvergence = readRecord(held?.branchConvergence);
    if (hasGit && status) {
        const uncommittedChanges = countUncommittedChanges(status);
        const dirty = isGitStatusDirty(status);
        entry.health = daemonHealth ?? (status.isGitRepo ? (dirty ? 'dirty' : 'online') : 'degraded');
        assignFullGitSnapshot(entry, status);
        entry.branch = status.branch;
        entry.isDirty = dirty;
        entry.uncommittedChanges = uncommittedChanges;
        entry.branchConvergence = daemonBranchConvergence ?? buildBranchConvergence(mesh as any, node, status, dirty, uncommittedChanges);
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

// ─── readNodeRuntime — the ONE held-first entry point for a node's runtime ────
//
// AUDIT FIX (owner principle 2026-09-26, held-node-state audit): before this,
// four different call sites each re-derived "is this node's runtime available
// without a live probe" — mesh_status's own inline usesHeldNodeRuntime/
// heldNodeStatusProbe branch (still inlined there, since it already shares the
// held read across many other fields in the same call), and three OTHER raw
// `commandForNode(...'get_status_metadata')` / `transport.meshCommand(daemonId,
// 'get_status_metadata')` call sites (mesh_view_queue, mesh_send_task /
// mesh_launch_session session lookups, MAGI idle checks, mesh_node_slots
// propose) that always went live, one per node, even for a REMOTE node whose
// runtime the coordinator daemon already holds from a member push.
//
// `readNodeRuntime` collapses that decision into one helper: read the
// coordinator daemon's held mesh_status ONCE per MeshContext per call (cached —
// see `cachedHeldNodeState` in mesh-held-node-state.ts), and for each node either answer from the
// held runtime (no transport call) or fall back to a live `get_status_metadata`
// probe when:
//   - the daemon predates `nodeRuntimeHeld` (older daemon — the marker is
//     absent), or
//   - the node's held source is 'none' (nothing pushed/observed yet for it), or
//   - the caller explicitly passes `allowLive: true` (a caller that needs a
//     guaranteed-fresh read regardless of what is held, e.g. a destructive
//     dup-guard check right before a mutation).

export interface NodeRuntimeResult {
    probe: NodeStatusProbe;
    /** Present whenever the answer did not require a live transport call. */
    observation?: HeldNodeRuntimeObservation;
    /** 'held' when answered from the coordinator's held state; 'live' otherwise. */
    source: 'held' | 'live';
}

/**
 * The held-first entry point every call site enumerated in the audit should
 * use instead of its own raw `get_status_metadata` probe. Never throws — a
 * live-probe failure resolves to `{ sessions: [] }` (matching
 * `collectLiveStatusProbe`'s existing failure contract) so callers keep their
 * current fail-open behavior.
 */
export async function readNodeRuntime(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    opts: { allowLive?: boolean; refresh?: boolean } = {},
): Promise<NodeRuntimeResult> {
    // Cheap locality check FIRST — no transport call. usesHeldNodeRuntime's other
    // preconditions (IpcTransport + daemonId + not-local) never depend on the
    // fetched held state, only `state.runtimeHeld` does; checking them before
    // fetching held state means a LOCAL node (the common single-machine/self
    // case) never issues the held-state `mesh_status` read at all — it goes
    // straight to the SAME live get_status_metadata call it always made.
    const canUseHeld = !opts.allowLive
        && ctx.transport instanceof IpcTransport
        && !!node.daemonId
        && !isLocalControlPlaneNode(ctx, node);
    if (canUseHeld) {
        const heldState = await cachedHeldNodeState(ctx);
        if (usesHeldNodeRuntime(ctx, node, heldState)) {
            const heldNode = findHeldNodeStatus(heldState, node);
            const held = heldNodeStatusProbe(heldNode);
            // A 'none' source means nothing is held for this node yet (new node /
            // member not pushing) — fall through to a live probe rather than
            // reporting an empty session list as if it were authoritative.
            if (held.observation.source !== 'none') {
                return { probe: held.probe, observation: held.observation, source: 'held' };
            }
        }
    }
    const probe = await collectLiveStatusProbe(ctx, node, opts.refresh ? { refresh: true } : undefined);
    return { probe, source: 'live' };
}

/**
 * mesh_view_queue / mesh_list_pending_approvals node-decoration, held-first.
 * Same output shape as the legacy `collectMeshViewQueueNodesWithLiveSessionsVerified`
 * (mesh-tools-internal.ts) — `sessions` replaced + `__liveProbeVerified` stamped for
 * a node whose runtime is now KNOWN (held or a verified live probe), left
 * unstamped (`false`) only when neither source could confirm anything (a stale
 * daemon predating the held-runtime marker AND a failed live probe — the same
 * "probe failed, never treat as evidence of absence" contract the legacy
 * function documented).
 */
/**
 * mesh_list_pending_approvals node decoration, held-first — the simpler,
 * unverified sibling of collectMeshViewQueueNodesHeldOrLive (matches the shape
 * the legacy collectMeshViewQueueNodesWithLiveSessions produced: sessions
 * replaced only when non-empty, no __liveProbeVerified stamp, since this
 * caller does not consume it).
 */
export async function collectPendingApprovalNodesHeldOrLive(
    ctx: MeshContext,
    opts?: { refresh?: boolean },
): Promise<any[]> {
    return Promise.all(ctx.mesh.nodes.map(async (node) => {
        const result = await readNodeRuntime(ctx, node as LocalMeshNodeEntry, opts);
        return result.probe.sessions.length > 0
            ? { ...node, sessions: result.probe.sessions }
            : node;
    }));
}

export async function collectMeshViewQueueNodesHeldOrLive(
    ctx: MeshContext,
    opts?: { refresh?: boolean },
): Promise<any[]> {
    return Promise.all(ctx.mesh.nodes.map(async (node) => {
        const result = await readNodeRuntime(ctx, node as LocalMeshNodeEntry, opts);
        if (result.source === 'held') {
            // Held state answers authoritatively (even a confirmed-empty session
            // list — see readNodeRuntime's 'none' fallthrough) without a live probe.
            return { ...node, sessions: result.probe.sessions, __liveProbeVerified: true };
        }
        // source === 'live': readNodeRuntime's own collectLiveStatusProbe swallows a
        // failed probe into `{sessions: []}`, which is NOT distinguishable from a
        // verified-empty probe — re-derive that distinction the same way the legacy
        // collectMeshViewQueueNodesWithLiveSessionsVerified did. This reuses the
        // shared probe cache (probeStatusMetadataForNode), so it is a cache hit, not
        // a second network round trip.
        const { sessions, verified } = await collectLiveStatusSessionsVerified(ctx, node as LocalMeshNodeEntry, opts);
        return verified
            ? { ...node, sessions, __liveProbeVerified: true }
            : { ...node, __liveProbeVerified: false };
    }));
}
