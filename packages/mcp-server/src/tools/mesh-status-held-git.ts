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
// stamps it as `heldRuntime` (mesh-held-node-state.ts reads it). No tool reads a
// member's status.
// Write paths that must see live git (refine, fast-forward, clone advisory,
// mesh_git_status detail read) are NOT routed through here.

import {
    assignFullGitSnapshot,
    countUncommittedChanges,
    extractSubmodules,
    isGitStatusDirty,
} from './mesh-tools-internal-core.js';
import { readNodeDaemonId } from './mesh-node-identity.js';
import type { MeshContext } from './mesh-tools-internal.js';
import type { LocalMeshNodeEntry } from '@adhdev/daemon-core';
import { readOptionalRecord } from '@adhdev/mesh-shared';

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/** Mirror of daemon-core `RepoMeshNodeGitObservation` (wire contract). */
interface HeldNodeGitObservation {
    source: 'self' | 'local' | 'member_push' | 'coordinator_probe' | 'none';
    observedAt: number | null;
    refreshing: boolean;
    unreachableSince: number | null;
    lastRefreshError?: string | null;
}

export function readHeldNodeGitObservation(held: Record<string, any> | undefined): HeldNodeGitObservation {
    const obs = readOptionalRecord(held?.gitObservation);
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
    const daemon = readOptionalRecord(args.daemonFreshness);
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
 * and never touches the transport. `health` and `branchConvergence` are the
 * daemon's own verdicts (deriveMeshNodeHealthFromGit /
 * applyInlineMeshBranchConvergence), passed through — never re-derived here.
 */
export function applyHeldNodeGitToEntry(entry: Record<string, any>, args: {
    mesh: MeshContext['mesh'];
    node: LocalMeshNodeEntry;
    held: Record<string, any> | undefined;
    heldStateError?: string;
    now?: number;
}): void {
    const { node, held } = args;
    const observation = readHeldNodeGitObservation(held);
    const status = readOptionalRecord(held?.git);
    const hasGit = !!status && (typeof status.isGitRepo === 'boolean' || typeof status.branch === 'string');
    const daemonHealth = typeof held?.health === 'string' ? held.health : undefined;
    const daemonBranchConvergence = readOptionalRecord(held?.branchConvergence);
    if (hasGit && status) {
        const uncommittedChanges = countUncommittedChanges(status);
        const dirty = isGitStatusDirty(status);
        entry.health = daemonHealth ?? 'unknown';
        assignFullGitSnapshot(entry, status);
        entry.branch = status.branch;
        entry.isDirty = dirty;
        entry.uncommittedChanges = uncommittedChanges;
        if (daemonBranchConvergence) entry.branchConvergence = daemonBranchConvergence;
        const buildBehind = readOptionalRecord(status.daemonBuildBehind) ?? readOptionalRecord(held?.staleDaemonBuild);
        // The verdict was computed by the process that pushed this git snapshot. If
        // the daemon has since restarted on another build (held runtime reports the
        // running commit), the verdict describes a process that no longer exists —
        // drop it rather than report a live, up-to-date daemon as stale.
        const runningCommit = nonEmptyString(readOptionalRecord(readOptionalRecord(held?.heldRuntime)?.daemonBuild)?.commit);
        const verdictCommit = buildBehind ? nonEmptyString(buildBehind.buildCommit) : undefined;
        const verdictIsForOtherProcess = !!(runningCommit && verdictCommit && runningCommit !== verdictCommit);
        if (buildBehind && !verdictIsForOtherProcess) entry.staleDaemonBuild = buildBehind;
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
    const quota = readOptionalRecord(readOptionalRecord(held?.nodeFacts)?.quota);
    if (quota && Object.keys(quota).length > 0) entry.quota = quota;

    entry.gitObservation = observation;
    entry.dataFreshness = deriveDataFreshnessFromObservation({
        observation,
        daemonFreshness: readOptionalRecord(held?.dataFreshness),
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
