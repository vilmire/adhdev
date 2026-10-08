// Mesh node health, launch freshness and data-freshness derivation (git shape →
// health, behind-upstream gate, branch-convergence summary, freshness/staleness
// classification, final status assembly). Split out of mesh-node-identity.ts
// (re-exported there).

import {
    readObjectRecord,
    readBooleanValue,
    readStringValue,
    readNumberValue,
} from './mesh-node-record-readers.js';
import { buildInlineMeshTransitGitStatus, buildCachedInlineMeshGitStatus } from './mesh-inline-mesh-cache.js';
import * as fs from 'fs';
import { isWorktreeBootstrapStaleRunning, isRemoteWorktreeBootstrapStaleRunning } from './worktree-bootstrap-config.js';
import { readCachedInlineMeshActiveSessions, readCachedInlineMeshActiveSessionDetails } from './mesh-node-sessions.js';
import { toIsoTimestamp } from './mesh-node-record-readers.js';
import { applyMeshNodeLinkPresence } from './mesh-node-link-presence.js';

function hasGitWorktreeChanges(git: Record<string, unknown> | null | undefined): boolean {
    return countGitWorktreeChanges(git) > 0;
}

export function countGitWorktreeChanges(git: Record<string, unknown> | null | undefined): number {
    if (!git) return 0;
    return Number(git.staged || 0)
        + Number(git.modified || 0)
        + Number(git.untracked || 0)
        + Number(git.deleted || 0)
        + Number(git.renamed || 0);
}

function getGitSubmoduleDriftState(git: Record<string, unknown> | null | undefined): { dirty: boolean; outOfSync: boolean } {
    const submodules = Array.isArray(git?.submodules) ? git.submodules : [];
    let dirty = false;
    let outOfSync = false;
    for (const entry of submodules) {
        const submodule = readObjectRecord(entry);
        if (readBooleanValue(submodule.dirty) === true) dirty = true;
        if (readBooleanValue(submodule.outOfSync) === true || !!readStringValue(submodule.error)) outOfSync = true;
    }
    return { dirty, outOfSync };
}

export function isInlineMeshAutoFastForwardEligible(git: Record<string, unknown> | null | undefined): boolean {
    if (!git) return false;
    if (readBooleanValue(git.isGitRepo) !== true) return false;
    if (!readStringValue(git.branch)) return false;
    if (!readStringValue(git.upstream)) return false;
    const upstreamStatus = readStringValue(git.upstreamStatus, git.upstream_status);
    if (upstreamStatus !== 'fresh') return false;
    if ((readNumberValue(git.ahead) ?? 0) !== 0) return false;
    if ((readNumberValue(git.behind) ?? 0) <= 0) return false;
    const hasConflicts = readBooleanValue(git.hasConflicts)
        ?? (Array.isArray(git.conflictFiles) && git.conflictFiles.length > 0);
    if (hasConflicts) return false;
    if ((readNumberValue(git.stashCount, git.stash_count) ?? 0) > 0) return false;
    const submoduleDrift = getGitSubmoduleDriftState(git);
    if (submoduleDrift.dirty || submoduleDrift.outOfSync) return false;
    const dirty = readBooleanValue(git.dirty) ?? (countGitWorktreeChanges(git) > 0);
    return dirty !== true && countGitWorktreeChanges(git) === 0;
}

export function deriveMeshNodeHealthFromGit(git: Record<string, unknown> | null | undefined): 'online' | 'dirty' | 'degraded' {
    if (!git || readBooleanValue(git.isGitRepo) === false) return 'degraded';
    const branch = readStringValue(git.branch);
    if (!branch) return 'degraded';
    const submoduleDrift = getGitSubmoduleDriftState(git);
    if (submoduleDrift.outOfSync) return 'degraded';
    if (submoduleDrift.dirty || hasGitWorktreeChanges(git)) return 'dirty';
    return 'online';
}

/**
 * Resolve a node's EFFECTIVE health from whatever telemetry the node object carries,
 * in the same precedence the coordinator surfaces use (applyCachedInlineMeshNodeStatus):
 *   1. an explicit `node.health` scalar (set by a fresh mesh_status probe / status report),
 *   2. else the cached inline status health (`node.cachedStatus.health`),
 *   3. else derived from the node's git telemetry (`node.git` / cachedStatus.git) via
 *      deriveMeshNodeHealthFromGit,
 *   4. else 'unknown' (no telemetry — cannot prove unhealthy).
 *
 * This is the SINGLE source of truth for "what is this node's health right now" shared by
 * the auto-launch gate (isMeshNodeHealthLaunchable → isLaunchableNode) and every other
 * launch-readiness reader, so they never disagree about whether a degraded node is a viable target.
 * Returns a lowercased string (empty string is normalized to 'unknown').
 */
export function resolveEffectiveMeshNodeHealth(node: any): string {
    const explicit = (readStringValue(node?.health) ?? '').toLowerCase();
    if (explicit) return explicit;
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const cachedHealth = (readStringValue(cachedStatus.health) ?? '').toLowerCase();
    if (cachedHealth) return cachedHealth;
    const git = readObjectRecord(node?.git);
    if (Object.keys(git).length > 0) return deriveMeshNodeHealthFromGit(git).toLowerCase();
    const cachedGit = readObjectRecord(cachedStatus.git);
    if (Object.keys(cachedGit).length > 0) return deriveMeshNodeHealthFromGit(cachedGit).toLowerCase();
    return 'unknown';
}

/**
 * Whether a node's health permits launching / assigning a fresh worker session onto it.
 * Mirrors the auto-launch gate in mesh-queue-assignment.isLaunchableNode: 'online' and
 * 'unknown' (and an absent/empty health, treated as unknown) pass — we never block on
 * missing telemetry; every other resolved health ('degraded', 'offline', 'dirty',
 * 'wrong_branch') is NOT launchable. A task assigned to a non-launchable node parks in
 * `pending` forever (isLaunchableNode skips it → node_health_not_launchable) with no
 * re-assignment, so a planner must exclude such nodes UP FRONT rather than emit a
 * task that can never run.
 */
export function isMeshNodeHealthLaunchable(node: any): boolean {
    const health = resolveEffectiveMeshNodeHealth(node);
    return health === 'online' || health === 'unknown';
}

/** Resolve the git telemetry object a node carries, in the same precedence
 *  resolveEffectiveMeshNodeHealth uses: a fresh `node.git`, else the cached inline
 *  status git (`node.cachedStatus.git`). Returns an empty record when neither is
 *  present (no telemetry). */
function resolveEffectiveNodeGit(node: any): Record<string, any> {
    const git = readObjectRecord(node?.git);
    if (Object.keys(git).length > 0) return git;
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    return readObjectRecord(cachedStatus.git);
}

/**
 * Launch FRESHNESS gate — distinct from the health gate above.
 *
 * `deriveMeshNodeHealthFromGit` reports a clean-tree node with `behind > 0` as
 * 'online', so the health gate (isMeshNodeHealthLaunchable) happily lets a STALE
 * node — one whose branch is N commits behind its upstream — win auto-launch fitness
 * routing and run a fresh worker against out-of-date code. `behind` is deliberately
 * NOT folded into deriveMeshNodeHealthFromGit because "behind" is not universally
 * unhealthy (other callers share that resolver); it is only
 * unhealthy for *spawning new work*. This gate encodes exactly that launch-time axis.
 *
 * Returns false (NOT fresh → skip / de-rank) only when git telemetry is PRESENT and
 * proves staleness:
 *   - behind count exceeds `maxBehind` (default 0 — any behind blocks), OR
 *   - a submodule is out of sync (gitlink points off upstream — cannot be caught up
 *     by a simple worktree ff and would launch against a mismatched submodule).
 *
 * When telemetry is absent it returns true (fresh), preserving the online/unknown-pass
 * philosophy: we never block on missing data, only on data that proves the node stale.
 */
export function isMeshNodeFreshEnoughToLaunch(node: any, opts?: { maxBehind?: number }): boolean {
    const git = resolveEffectiveNodeGit(node);
    // No git telemetry at all → cannot prove stale → do not block.
    if (Object.keys(git).length === 0) return true;
    // Not a git repo / no branch: leave this to the health gate (it returns 'degraded'
    // and blocks there); freshness has nothing to add.
    if (readBooleanValue(git.isGitRepo) === false) return true;
    const submoduleDrift = getGitSubmoduleDriftState(git);
    if (submoduleDrift.outOfSync) return false;
    const behind = readNumberValue(git.behind);
    // No behind datum reported → treat as fresh (don't infer staleness from absence).
    if (behind === undefined) return true;
    const maxBehind = Number.isFinite(opts?.maxBehind as number) && (opts?.maxBehind as number) >= 0
        ? Math.floor(opts!.maxBehind as number)
        : 0;
    return behind <= maxBehind;
}


export function summarizeInlineMeshBranchConvergence(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
    const followUps = nodes
        .filter(node => {
            if (readObjectRecord(node.branchConvergence).needsConvergence !== true) return false;
            const workspace = typeof node.workspace === 'string' ? node.workspace : '';
            if (workspace && !fs.existsSync(workspace)) return false;
            return true;
        })
        .map(node => {
            const convergence = readObjectRecord(node.branchConvergence);
            return {
                nodeId: node.nodeId,
                workspace: node.workspace,
                branch: convergence.branch,
                status: convergence.status,
                reason: convergence.reason,
                nextStep: convergence.nextStep,
            };
        });

    return {
        needsFollowUp: followUps.length > 0,
        unresolvedCount: followUps.length,
        requiredFinalStates: ['merged_to_main', 'pushed_feature_branch_needs_merge', 'blocked_review', 'cleanup_candidate', 'not_mergeable'],
        followUps,
    };
}

function synthesizeMeshNodeFreshnessFromConnection(status: Record<string, unknown>): void {
    const connection = readObjectRecord(status.connection);
    const connectionFreshAt = toIsoTimestamp(connection.lastCommandAt ?? connection.lastConnectedAt ?? connection.lastStateChangeAt);
    const git = readObjectRecord(status.git);
    const gitCheckedAt = toIsoTimestamp(git.lastCheckedAt);
    if (!status.lastSeenAt && connectionFreshAt) status.lastSeenAt = connectionFreshAt;
    if (!status.updatedAt && (gitCheckedAt || connectionFreshAt)) {
        status.updatedAt = gitCheckedAt ?? connectionFreshAt;
    }
}

/**
 * Transient per-node marker the mesh_status render loop stamps onto a node
 * `status` at the two sites that obtain git truth from a FRESH probe this call
 * (a successful local `getGitRepoStatus`, or a successful P2P `git_status`
 * round-trip). finalizeMeshNodeStatus consumes and deletes it. Held/standing
 * truth (node.lastGit / cachedStatus / inline transit) is deliberately NOT
 * stamped — its absence is exactly how the freshness marker tells "live" apart
 * from "cached". Internal only; never serialized in the response.
 */
export const MESH_NODE_LIVE_TRUTH_MARKER = '__liveTruthProbed';

type MeshNodeDataSource =
    | 'self'          // the selected coordinator's own node — local truth
    | 'live'          // git/session truth confirmed by a fresh probe THIS call
    | 'cached'        // rendered from held standing truth (possibly old — see staleness)
    | 'pending'       // reachable/known but no probe attempted yet (default load)
    | 'unreachable'   // peer could not be reached (P2P probe failed / not connected, no held truth)
    | 'empty'         // reachable but genuinely no session + git data
    | 'unconfigured'; // node has no daemonId, so transport truth cannot be reported

type MeshNodeStaleness = 'fresh' | 'recent' | 'stale' | 'unknown';

// Staleness buckets (ms). Held/cached truth younger than FRESH reads as fresh,
// younger than RECENT as recent, older as stale. Kept coarse on purpose — the
// coordinator only needs "just-now / minutes-old / old", not millisecond precision.
const MESH_FRESHNESS_FRESH_MS = 30_000;
const MESH_FRESHNESS_RECENT_MS = 300_000;

function classifyMeshNodeStaleness(dataSource: MeshNodeDataSource, ageMs: number | null): MeshNodeStaleness {
    if (dataSource === 'self' || dataSource === 'live') return 'fresh';
    if (ageMs === null) return 'unknown';
    if (ageMs < MESH_FRESHNESS_FRESH_MS) return 'fresh';
    if (ageMs < MESH_FRESHNESS_RECENT_MS) return 'recent';
    return 'stale';
}

/**
 * Build the additive per-node `dataFreshness` marker. This NEVER mutates any
 * existing field — it only adds an explicit, machine-readable answer to the
 * question the legacy fields blurred: is this node's data live (just probed),
 * cached (held truth, maybe old), or absent because the peer was unreachable?
 *
 * The crucial separation: an UNREACHABLE peer (P2P probe failed / not connected)
 * is no longer indistinguishable from an idle/EMPTY node. Both used to render as
 * `health:'unknown'` with no sessions; now `dataFreshness.dataSource` and
 * `reachable` tell them apart so a coordinator never reads a dead peer as "online
 * but doing nothing".
 */
export function buildMeshNodeDataFreshness(args: {
    status: Record<string, unknown>;
    node?: any;
    isSelfNode: boolean;
    daemonId?: string;
    /** True when this node was stamped with a fresh live git probe this call. */
    liveTruthProbed: boolean;
    /** True when direct-peer-truth accounting classified this node unavailable. */
    directTruthUnavailable?: boolean;
    now?: () => number;
}): Record<string, unknown> {
    const { status, node, isSelfNode, daemonId, liveTruthProbed, directTruthUnavailable } = args;
    const now = args.now ?? Date.now;
    const connection = readObjectRecord(status.connection);
    const connectionState = readStringValue(connection.state);
    const directPeerTruthSatisfied = readBooleanValue(connection.directPeerTruthSatisfied);
    const git = readObjectRecord(status.git);
    const hasGit = readBooleanValue(git.isGitRepo) === true
        || !!readStringValue(git.branch, git.headCommit, git.head, git.upstream);
    const connectionFreshAt = toIsoTimestamp(connection.lastCommandAt ?? connection.lastConnectedAt ?? connection.lastStateChangeAt);
    // Provenance-aware probe time. A FRESH probe this call writes a genuine
    // git.lastCheckedAt, so trust it for live nodes. Held/standing truth can predate
    // that field, so for cached nodes prefer the authoritative peer probe time on
    // node.lastGit.checkedAt / cachedStatus before the normalized status value.
    const liveGitCheckedAt = liveTruthProbed ? toIsoTimestamp(git.lastCheckedAt) : null;
    const heldGit = readObjectRecord(node?.lastGit ?? node?.last_git);
    const heldCheckedAt = toIsoTimestamp(heldGit.checkedAt ?? heldGit.checked_at);
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const cachedGitCheckedAt = toIsoTimestamp(readObjectRecord(cachedStatus.git).lastCheckedAt);
    const lastProbeAt = liveGitCheckedAt
        ?? heldCheckedAt
        ?? cachedGitCheckedAt
        ?? toIsoTimestamp(git.lastCheckedAt)
        ?? connectionFreshAt
        ?? toIsoTimestamp(status.updatedAt)
        ?? toIsoTimestamp(status.lastSeenAt);

    // connectionReachable: true (connected) / false (terminally down) / null (unknown,
    // not yet reported) — used so a cached/pending node carries the coordinator's last
    // known transport state rather than guessing.
    const connectionReachable: boolean | null = connectionState === 'connected'
        ? true
        : (!connectionState || connectionState === 'unknown' || connectionState === 'connecting')
            ? (connectionState === 'connecting' ? true : null)
            : false;

    let dataSource: MeshNodeDataSource;
    let reachable: boolean | null;
    if (isSelfNode) {
        dataSource = 'self';
        reachable = true;
    } else if (liveTruthProbed) {
        dataSource = 'live';
        reachable = true;
    } else if (readBooleanValue(status.gitProbePending) === true) {
        dataSource = 'pending';
        reachable = connectionReachable;
    } else if (hasGit) {
        // Held git/session metadata remains useful for projection, but never
        // satisfies live peer authority. Classify it as cached even when the direct
        // probe failed so callers see both its age and the unreachable transport.
        dataSource = 'cached';
        reachable = directTruthUnavailable ? false : connectionReachable;
    } else if (directTruthUnavailable) {
        dataSource = 'unreachable';
        reachable = false;
    } else if (!daemonId) {
        dataSource = 'unconfigured';
        reachable = null;
    } else if (connectionState === 'connected') {
        dataSource = 'empty';
        reachable = true;
    } else {
        dataSource = 'unreachable';
        reachable = false;
    }

    const probeOk = dataSource === 'live' || dataSource === 'self';
    let ageMs: number | null = null;
    if (lastProbeAt) {
        const parsed = Date.parse(lastProbeAt);
        if (Number.isFinite(parsed)) ageMs = Math.max(0, now() - parsed);
    }
    const staleness = classifyMeshNodeStaleness(dataSource, ageMs);

    return {
        dataSource,
        probeOk,
        reachable,
        directPeerTruthSatisfied: isSelfNode || liveTruthProbed
            ? true
            : directPeerTruthSatisfied ?? false,
        projection: dataSource === 'cached' ? 'cached' : 'live_or_absent',
        lastProbeAt: lastProbeAt ?? null,
        ageMs,
        staleness,
    };
}

/**
 * Canonical live-probe → freshness adapter. The coordinator-facing mesh_status
 * (mcp-server `meshStatus`) builds each node entry from a SINGLE fresh git_status
 * probe that either returns (live truth) or throws (peer unreachable). It used to
 * hand-reconstruct the freshness INPUT inline — a synthetic `{ git, connection }`
 * status plus the directTruthUnavailable/liveTruthProbed wiring — which is exactly
 * how a field added to `buildMeshNodeDataFreshness`'s input contract ends up "wired
 * on the daemon surface, null on the coordinator surface" (the rc.371
 * null-everywhere regression). Routing every live-probe surface through this one
 * adapter keeps the marker derivation canonical: there is a SINGLE place that turns
 * a probe outcome into freshness args, so the two mesh_status surfaces cannot drift.
 *
 * `liveTruthProbed` true → the probe returned (live/self truth); false → it threw,
 * so a configured peer is unreachable while an unconfigured node (no daemonId) falls
 * through to the classifier's `unconfigured` branch.
 */
export function buildMeshNodeProbeFreshness(args: {
    /** The git snapshot this probe stamped on the node entry (entry.git). */
    git: unknown;
    /** True when the fresh git_status probe RETURNED (live truth); false when it threw. */
    liveTruthProbed: boolean;
    isSelfNode: boolean;
    /** The node's resolved daemonId; absent → unconfigured node. */
    daemonId?: string;
    /** The mesh node record, for held-git fallback when the probe did not return live. */
    node?: any;
    now?: () => number;
}): Record<string, unknown> {
    const { git, liveTruthProbed, isSelfNode, daemonId, node, now } = args;
    const status: Record<string, unknown> = {
        git,
        connection: { state: liveTruthProbed ? 'connected' : 'disconnected' },
    };
    if (liveTruthProbed) status[MESH_NODE_LIVE_TRUTH_MARKER] = true;
    return buildMeshNodeDataFreshness({
        status,
        node,
        isSelfNode,
        daemonId,
        liveTruthProbed,
        directTruthUnavailable: !liveTruthProbed && !!daemonId,
        now,
    });
}

export function finalizeMeshNodeStatus(args: {
    status: Record<string, unknown>;
    node: any;
    daemonId?: string;
    isSelfNode: boolean;
    /** True when direct-peer-truth accounting classified this node unavailable. */
    directTruthUnavailable?: boolean;
}): void {
    const { status, node, daemonId, isSelfNode, directTruthUnavailable } = args;
    if (!readStringValue(status.machineStatus)) {
        const cachedStatus = readObjectRecord(node?.cachedStatus);
        const machineStatus = readStringValue(cachedStatus.machineStatus, cachedStatus.machine_status, node?.machineStatus);
        if (machineStatus) status.machineStatus = machineStatus;
    }
    // A presence link (standalone direct WS) overrides the held machineStatus /
    // git-derived health: a member whose link is down is offline, not 'online'
    // from its last push (mesh-node-link-presence.ts).
    applyMeshNodeLinkPresence(status);
    synthesizeMeshNodeFreshnessFromConnection(status);
    // Stamp the additive freshness/reachability marker before any early return so
    // every node — including bootstrap-blocked ones — carries it. Consume and drop
    // the transient live-probe marker so it never leaks into the response.
    const liveTruthProbed = readBooleanValue(status[MESH_NODE_LIVE_TRUTH_MARKER]) === true;
    delete status[MESH_NODE_LIVE_TRUTH_MARKER];
    status.dataFreshness = buildMeshNodeDataFreshness({
        status,
        node,
        isSelfNode,
        daemonId,
        liveTruthProbed,
        directTruthUnavailable,
    });
    // Deploy-lag visibility: surface the git probe's daemonBuildBehind as the
    // top-level staleDaemonBuild node field — same contract as the MCP
    // mesh_status surface (mesh-tools-status.ts). The dashboard Status tab's
    // stale-build badge reads this field; before this stamp the dashboard
    // surface never received it (and normalizeGitStatus additionally dropped
    // it from relayed remote statuses), so the badge was a dead path.
    const gitForBuildLag = readObjectRecord(status.git);
    if (gitForBuildLag.daemonBuildBehind && typeof gitForBuildLag.daemonBuildBehind === 'object') {
        status.staleDaemonBuild = gitForBuildLag.daemonBuildBehind;
    }
    const bootstrap = readObjectRecord(node?.worktreeBootstrap);
    if (node?.isLocalWorktree && readStringValue(bootstrap.status)) {
        status.worktreeBootstrap = bootstrap;
        if (bootstrap.status === 'failed' && bootstrap.required !== false) {
            status.launchReady = false;
            status.launchBlockedReason = 'worktree_bootstrap_failed';
            status.launchBlockedMessage = readStringValue(bootstrap.error)
                || 'Required worktree bootstrap failed; resolve it before launching an agent into this node.';
            status.recoveryHint = 'Run retry_mesh_node_bootstrap to retry';
            return;
        }
        if (bootstrap.status === 'running' && bootstrap.required !== false) {
            // Stale-'running' backstop (mirrors the auto-launch gate's shouldDeferDispatchForBootstrap
            // — see worktree-bootstrap-config.ts): a 'running' state far older than any real
            // bootstrap, proven clean/settled since, means the terminal stamp likely never reached
            // this daemon's mesh view. Without this, mesh_status's launchReady stayed permanently
            // false for exactly the node class shouldDeferDispatchForBootstrap already recovers —
            // a REMOTE worktree node has no local workspace to shell-`git status` into, so only the
            // remote (P2P transit-git) variant of the backstop can ever apply here. Node stays
            // silently treated as bootstrap-complete: fall through to the formula below instead of
            // early-returning launchReady:false.
            if (!(isWorktreeBootstrapStaleRunning(node, Date.now()) || isRemoteWorktreeBootstrapStaleRunning(node, Date.now()))) {
                status.launchReady = false;
                status.launchBlockedReason = 'worktree_bootstrap_running';
                status.launchBlockedMessage = 'Required worktree bootstrap is still running; wait for it to finish before launching an agent into this node.';
                return;
            }
        }
    }
    const connectionState = readStringValue(readObjectRecord(status.connection).state);
    status.launchReady = !!daemonId && (
        readStringValue(status.machineStatus) === 'online'
        || connectionState === 'connected'
        || isSelfNode
    );
}

export function applyCachedInlineMeshNodeStatus(
    status: Record<string, unknown>,
    node: any,
    options?: { skipGit?: boolean; skipError?: boolean; skipHealth?: boolean },
): boolean {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const liveGit = buildInlineMeshTransitGitStatus(node);
    const git = options?.skipGit ? undefined : (liveGit ?? buildCachedInlineMeshGitStatus(node));
    const error = options?.skipError ? undefined : (liveGit ? undefined : readStringValue(cachedStatus.error, node?.error));
    const health = options?.skipHealth ? undefined : (liveGit ? undefined : readStringValue(cachedStatus.health, node?.health));
    const machineStatus = readStringValue(cachedStatus.machineStatus, node?.machineStatus);
    const lastSeenAt = toIsoTimestamp(cachedStatus.lastSeenAt ?? cachedStatus.last_seen_at ?? node?.lastSeenAt ?? node?.last_seen_at);
    const updatedAt = toIsoTimestamp(cachedStatus.updatedAt ?? cachedStatus.updated_at ?? node?.updatedAt ?? node?.updated_at);
    const activeSessions = readCachedInlineMeshActiveSessions(node);
    const activeSessionDetails = readCachedInlineMeshActiveSessionDetails(node);
    if (!git && !error && !health && !machineStatus && !lastSeenAt && !updatedAt && activeSessions.length === 0) return false;
    if (git) status.git = git;
    if (error) status.error = error;
    if (machineStatus) status.machineStatus = machineStatus;
    if (lastSeenAt) status.lastSeenAt = lastSeenAt;
    if (updatedAt) status.updatedAt = updatedAt;
    if (activeSessions.length > 0) status.activeSessions = activeSessions;
    if (activeSessionDetails.length > 0) status.activeSessionDetails = activeSessionDetails;
    if (health) {
        status.health = health;
        return true;
    }
    if (git) {
        status.health = deriveMeshNodeHealthFromGit(git);
        return true;
    }
    return activeSessions.length > 0 || !!machineStatus || !!lastSeenAt || !!updatedAt;
}
