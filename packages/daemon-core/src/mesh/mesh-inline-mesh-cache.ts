// Inline mesh cache: direct git-truth recording, reported member facts and
// reporter platform, transient-state stripping, identity folding and the cache
// reconcile. Split out of mesh-node-identity.ts (re-exported there).

import {
    normalizeGitStatus as sharedNormalizeGitStatus,
    pickBestTransitGitStatus as sharedPickBestTransitGitStatus,
    normalizeMeshNodeFacts,
    normalizeMeshNodeId,
} from '@adhdev/mesh-shared';
import {
    readObjectRecord,
    readBooleanValue,
    readStringValue,
    readNumberValue,
} from './mesh-node-record-readers.js';
import type { MeshReportedMemberState } from '../repo-mesh-types.js';
import { getMachineNickname } from '../config/config.js';
import { buildLocalNodeFacts } from './node-facts.js';
import { getCachedProviderVersions } from '../detection/cli-detector.js';
import { getDaemonBuildInfo } from '../build-info.js';
import * as fs from 'fs';
import { LOG } from '../logging/logger.js';

// normalizeInlineMeshGitStatus / scoreInlineMeshGitStatus /
// buildInlineMeshTransitGitStatus were the standalone-side copies of the cloud
// transit git normalizers. They now delegate to @adhdev/mesh-shared so the two
// transports can no longer drift (e.g. on the submodule drop / evidence rules).

function normalizeInlineMeshGitStatus(
    status: Record<string, unknown>,
    node: any,
    options?: { lastCheckedAt?: number },
): Record<string, unknown> | undefined {
    return sharedNormalizeGitStatus(status, readObjectRecord(node), options) as Record<string, unknown> | undefined;
}

export function buildInlineMeshTransitGitStatus(node: any): Record<string, unknown> | undefined {
    return sharedPickBestTransitGitStatus(readObjectRecord(node)) as Record<string, unknown> | undefined;
}

export function shouldRefreshStalePendingAggregate(snapshot: any, options?: { requireDirectPeerTruth?: boolean }): boolean {
    if (options?.requireDirectPeerTruth !== true || !Array.isArray(snapshot?.nodes)) return false;
    return snapshot.nodes.some((node: any) => {
        if (node?.gitProbePending !== true) return false;
        const git = readObjectRecord(node?.git);
        return !readBooleanValue(git.isGitRepo) && !readStringValue(git.branch, git.headCommit, git.upstream);
    });
}

export function buildLivePeerGitConnection(connection: Record<string, unknown>, timestamp = new Date().toISOString()): Record<string, unknown> {
    const source = readStringValue(connection.source);
    const transport = readStringValue(connection.transport);
    return {
        ...connection,
        perspective: readStringValue(connection.perspective) ?? 'selected_coordinator',
        source: source && source !== 'not_reported' ? source : 'mesh_peer_status',
        state: 'connected',
        transport: transport && transport !== 'unknown' ? transport : 'direct',
        reported: true,
        directPeerTruthSatisfied: true,
        authority: 'live_peer',
        cached: false,
        reason: 'Live peer git snapshot reported by the selected coordinator.',
        lastStateChangeAt: readStringValue(connection.lastStateChangeAt) ?? timestamp,
    };
}

export function recordInlineMeshDirectGitTruth(
    node: any,
    git: Record<string, unknown>,
    source: 'selected_coordinator_local_git' | 'selected_coordinator_mesh_p2p_git',
): {
    reporterPlatform: string | null;
    reporterArch: string | null;
    reporterMachineNickname: string | null;
    reporterProviderVersions: Record<string, string> | null;
    reporterDaemonBuildVersion: string | null;
    reportedMemberState: MeshReportedMemberState | null;
    nodeFacts: import('@adhdev/mesh-shared').MeshNodeFacts | null;
} {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return {
            reporterPlatform: null,
            reporterArch: null,
            reporterMachineNickname: null,
            reporterProviderVersions: null,
            reporterDaemonBuildVersion: null,
            reportedMemberState: null,
            nodeFacts: null,
        };
    }
    const checkedAt = readNumberValue(git.lastCheckedAt) ?? Date.now();
    const updatedAt = new Date(checkedAt).toISOString();
    const nextGit: Record<string, unknown> = {
        ...git,
        lastCheckedAt: checkedAt,
    };
    node.lastGit = {
        source,
        checkedAt,
        status: nextGit,
    };
    node.last_git = node.lastGit;
    node.machineStatus = 'online';
    node.updatedAt = updatedAt;
    node.lastSeenAt = updatedAt;
    const repoRoot = readStringValue(nextGit.repoRoot);
    if (repoRoot && !readStringValue(node.repoRoot)) node.repoRoot = repoRoot;
    // Self-heal per-node platform/arch from the live probe. For a remote member
    // this is the platform the member daemon reported in its git_status envelope
    // (threaded through as reporter*); for the local coordinator's own / worktree
    // nodes the git was computed locally (source 'selected_coordinator_local_git'
    // ⇒ the workspace lives on THIS machine), so process.platform/process.arch is
    // the correct value. Stamp into userOverrides — the exact fields
    // buildMeshNodeCapabilityTags reads — only when absent, so an operator's
    // explicit override is preserved and the value is corrected once per reconnect
    // without any migration.
    const isLocalSource = source === 'selected_coordinator_local_git';
    const reporterPlatform = readStringValue(git.reporterPlatform) ?? (isLocalSource ? process.platform : null);
    const reporterArch = readStringValue(git.reporterArch) ?? (isLocalSource ? process.arch : null);
    stampNodeReporterPlatform(node, reporterPlatform, reporterArch);
    // Mirror onto the in-memory node's dedicated reporter fields too (distinct
    // from userOverrides). For a local_config mesh the caller also persists these
    // to meshes.json via updateNode so the value survives a coordinator restart;
    // for an inline/cache mesh this keeps the runtime object self-consistent.
    if (reporterPlatform) node.reportedPlatform = reporterPlatform;
    if (reporterArch) node.reportedArch = reporterArch;
    // Machine nickname: only a remote member self-reports it (reporterMachineNickname
    // rides the git_status envelope). For a local_source probe the workspace lives on
    // THIS machine, but the self/base node already carries the local config nickname
    // (addNode stamps it), so we only stamp from an explicit report here — never
    // overwrite an existing nickname with an empty value.
    const reporterMachineNickname = readStringValue(git.reporterMachineNickname) ?? null;
    if (reporterMachineNickname) node.machineNickname = reporterMachineNickname;
    // T7: self-heal provider versions + daemon build version from the same git_status
    // envelope. These are best-effort observability (never routing), so the raw
    // reported map is stamped onto dedicated node fields and overwritten by the next
    // report — never merged with a stale value the way an operator override would be.
    // For a remote member these ride the git_status envelope (git-commands.ts folds
    // them in from getReporterProviderVersions). The local coordinator's own / worktree
    // nodes probe getGitRepoStatus() directly, which bypasses handleGitCommand and so
    // carries no reporter* versions — mirror the platform/arch self-heal above and read
    // this daemon's own warm version cache directly, so the coordinator's self node gets
    // the same provider/build chips a remote node does.
    // Direction-B: parse the UNIFIED reportedMemberState envelope first (versions +
    // build + the member's own resolved slots), falling back to the flat legacy
    // fields so a mixed-version mesh during rollout still ingests. This is the single
    // place the coordinator mirrors a remote member's reported state wholesale.
    const unified = normalizeReportedMemberState(git.reporterMemberState);
    const reporterProviderVersions =
        (unified?.providerVersions ? readProviderVersionsRecord(unified.providerVersions) : null)
        ?? readProviderVersionsRecord(git.reporterProviderVersions)
        ?? (isLocalSource ? readLocalReporterProviderVersions() : null);
    if (reporterProviderVersions) node.reportedProviderVersions = reporterProviderVersions;
    const reporterDaemonBuildVersion =
        (readStringValue(unified?.daemonBuildVersion)
            ?? readStringValue(git.reporterDaemonBuildVersion)
            ?? (isLocalSource ? readLocalReporterDaemonBuildVersion() : null))
        ?? null;
    if (reporterDaemonBuildVersion) node.reportedDaemonBuildVersion = reporterDaemonBuildVersion;
    // Mirror the unified state onto the node record for observability. Only stamped
    // for a REMOTE member (!isLocalSource): the coordinator's own / worktree nodes
    // read their runtime facts from the local warm cache above, so a self node
    // deliberately carries NO reportedMemberState. Carries the per-machine RUNTIME
    // facts (provider versions + daemon build) — NOT slots, which are coordinator-
    // owned config resolved from node.policy.slots, not reported
    // (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix). Synthesizes from the legacy flat
    // fields when a node reports only those (no unified envelope yet).
    if (!isLocalSource) {
        const mirrored: {
            providerVersions?: Record<string, string>;
            daemonBuildVersion?: string;
            lastReportedAt?: number;
        } = {
            ...(reporterProviderVersions ? { providerVersions: reporterProviderVersions } : {}),
            ...(reporterDaemonBuildVersion ? { daemonBuildVersion: reporterDaemonBuildVersion } : {}),
            lastReportedAt: readNumberValue(unified?.lastReportedAt) ?? checkedAt,
        };
        // Only stamp when there's actual reported content beyond the timestamp — a
        // bare {lastReportedAt} carries no observability and would just churn the
        // record on every probe.
        if (mirrored.providerVersions || mirrored.daemonBuildVersion) {
            node.reportedMemberState = mirrored;
        }
    }
    // Versioned facts bundle (deploy-lag visibility design §a). Remote: ingest the
    // envelope's reporterNodeFacts WHOLESALE (opaque — unknown future fields ride
    // through). Self/worktree: the local probe bypasses handleGitCommand, so build
    // the bundle with the SAME producer the envelope uses — the two paths cannot
    // drift on a per-field basis anymore. Skipped (no stamp churn) when a remote
    // envelope predates the bundle.
    if (!isLocalSource) {
        const remoteFacts = normalizeMeshNodeFacts((git as { reporterNodeFacts?: unknown }).reporterNodeFacts);
        if (remoteFacts) node.nodeFacts = remoteFacts;
    } else {
        try {
            // machineNickname: without it the LOCAL machine's facts bundle was
            // the only one lacking a nickname (remote members self-report it on
            // the envelope), so machine-label resolution worked everywhere but
            // on the coordinator's own machine.
            let localNickname: string | null = null;
            try {
                localNickname = readStringValue(getMachineNickname()) ?? null;
            } catch { /* config read is best-effort */ }
            node.nodeFacts = buildLocalNodeFacts({
                providerVersions: reporterProviderVersions ?? null,
                machineNickname: localNickname,
            });
        } catch { /* facts stamp is best-effort observability */ }
    }
    return {
        reporterPlatform,
        reporterArch,
        reporterMachineNickname,
        reporterProviderVersions,
        reporterDaemonBuildVersion,
        reportedMemberState: (!isLocalSource ? (node.reportedMemberState ?? null) : null) as MeshReportedMemberState | null,
        // Bundle rides to persistence so the facts (incl. build COMMIT — the
        // deploy-lag anchor) survive a config reload / coordinator restart.
        nodeFacts: (node.nodeFacts ?? null) as import('@adhdev/mesh-shared').MeshNodeFacts | null,
    };
}

/**
 * Self-heal a node record from the facts bundle its member PUSHED (held runtime,
 * mesh-node-runtime-summary.ts) — the push-path counterpart of the probe-envelope
 * self-heal in recordInlineMeshDirectGitTruth. Stamps platform / arch into
 * userOverrides only when absent (an operator override wins), and the reported*
 * mirror fields + nodeFacts. Returns the reporter fields for
 * persistNodeReporterPlatform, or null when nothing a config record carries
 * changed (quota / timestamps alone never rewrite meshes.json).
 */
export function recordReportedNodeFacts(node: any, rawFacts: unknown): {
    reporterPlatform: string | null;
    reporterArch: string | null;
    reporterMachineNickname: string | null;
    reporterProviderVersions: Record<string, string> | null;
    reporterDaemonBuildVersion: string | null;
    reportedMemberState: MeshReportedMemberState | null;
    nodeFacts: import('@adhdev/mesh-shared').MeshNodeFacts | null;
} | null {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const facts = normalizeMeshNodeFacts(rawFacts);
    if (!facts) return null;
    const platform = readStringValue(facts.platform) ?? null;
    const arch = readStringValue(facts.arch) ?? null;
    const nickname = readStringValue(facts.machineNickname) ?? null;
    const providerVersions = readProviderVersionsRecord(facts.providerVersions);
    const buildVersion = readStringValue(readObjectRecord(facts.daemonBuild).version) ?? null;
    const buildCommit = readStringValue(readObjectRecord(facts.daemonBuild).commit) ?? null;
    const previousCommit = readStringValue(readObjectRecord(readObjectRecord(node.nodeFacts).daemonBuild).commit) ?? null;
    const configChanged = (platform && platform !== readStringValue(node.reportedPlatform))
        || (arch && arch !== readStringValue(node.reportedArch))
        || (nickname && nickname !== readStringValue(node.machineNickname))
        || (buildVersion && buildVersion !== readStringValue(node.reportedDaemonBuildVersion))
        || (buildCommit && buildCommit !== previousCommit)
        || (providerVersions && JSON.stringify(providerVersions) !== JSON.stringify(readProviderVersionsRecord(node.reportedProviderVersions)));
    stampNodeReporterPlatform(node, platform, arch);
    if (platform) node.reportedPlatform = platform;
    if (arch) node.reportedArch = arch;
    if (nickname) node.machineNickname = nickname;
    if (providerVersions) node.reportedProviderVersions = providerVersions;
    if (buildVersion) node.reportedDaemonBuildVersion = buildVersion;
    if (providerVersions || buildVersion) {
        node.reportedMemberState = {
            ...(providerVersions ? { providerVersions } : {}),
            ...(buildVersion ? { daemonBuildVersion: buildVersion } : {}),
            lastReportedAt: facts.reportedAt,
        };
    }
    node.nodeFacts = facts;
    if (!configChanged) return null;
    return {
        reporterPlatform: platform,
        reporterArch: arch,
        reporterMachineNickname: nickname,
        reporterProviderVersions: providerVersions,
        reporterDaemonBuildVersion: buildVersion,
        reportedMemberState: (node.reportedMemberState ?? null) as MeshReportedMemberState | null,
        nodeFacts: facts,
    };
}

/**
 * Coerce an unknown git-envelope `reporterMemberState` into a clean
 * {@link MeshReportedMemberState}. Reuses readProviderVersionsRecord for the version
 * map. Carries the per-machine RUNTIME facts (provider versions + daemon build) only
 * — slots are coordinator-owned config, not reported (REMOTE-NODE-SLOTS-COORDINATOR-
 * LOCAL fix), and any stray `slots` on a legacy envelope is ignored. Returns null
 * when nothing usable is present (bare/absent envelope) so callers fall back to the
 * legacy flat fields. Best-effort, never throws.
 */
export function normalizeReportedMemberState(value: unknown): MeshReportedMemberState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const providerVersions = readProviderVersionsRecord(raw.providerVersions);
    const daemonBuildVersion = readStringValue(raw.daemonBuildVersion);
    const lastReportedAt = readNumberValue(raw.lastReportedAt);
    if (!providerVersions && !daemonBuildVersion && lastReportedAt === undefined) {
        return null;
    }
    return {
        ...(providerVersions ? { providerVersions } : {}),
        ...(daemonBuildVersion ? { daemonBuildVersion } : {}),
        ...(lastReportedAt !== undefined ? { lastReportedAt } : {}),
    };
}

/**
 * Coerce an unknown git-envelope `reporterProviderVersions` field into a clean
 * `{ providerId: version }` record: only string→non-empty-string entries survive.
 * Returns null when nothing usable is present so callers can skip the stamp.
 */
export function readProviderVersionsRecord(value: unknown): Record<string, string> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof key !== 'string' || !key.trim()) continue;
        const version = typeof raw === 'string' ? raw.trim() : '';
        if (!version) continue;
        out[key] = version;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * This daemon's own provider-version map, read from the same warm cache the
 * git_status envelope self-reports from (getReporterProviderVersions is wired to
 * getCachedProviderVersions at boot). The local self/worktree probe path calls
 * getGitRepoStatus() directly — bypassing handleGitCommand — so it never gets the
 * reporter* envelope; reading the cache here is the local-source analogue of the
 * process.platform/process.arch self-heal. Returns null on a cold cache so the
 * stamp is skipped rather than clearing an existing value.
 */
function readLocalReporterProviderVersions(): Record<string, string> | null {
    try {
        return readProviderVersionsRecord(getCachedProviderVersions());
    } catch {
        return null;
    }
}

/**
 * The facts bundle recordInlineMeshDirectGitTruth stamps on a LOCAL node after a
 * git read (same producer + inputs), without the git read — for get_mesh
 * `membershipOnly`, which skips the git hydration but must still hand callers
 * current local facts (quota gate reads nodeFacts.quota). Cheap, synchronous.
 */
export function buildFreshLocalNodeFacts(): import('@adhdev/mesh-shared').MeshNodeFacts | null {
    try {
        let localNickname: string | null = null;
        try { localNickname = readStringValue(getMachineNickname()) ?? null; } catch { /* best-effort */ }
        return buildLocalNodeFacts({ providerVersions: readLocalReporterProviderVersions(), machineNickname: localNickname });
    } catch {
        return null;
    }
}

/** This daemon's own build version (see readLocalReporterProviderVersions). */
function readLocalReporterDaemonBuildVersion(): string | null {
    try {
        const version = getDaemonBuildInfo().version;
        return typeof version === 'string' && version.trim() && version !== 'unknown'
            ? version.trim()
            : null;
    } catch {
        return null;
    }
}

/**
 * Fill node.userOverrides.platform/arch from a live report, but never overwrite a
 * value that is already present (an operator override or an earlier report). Used
 * by both the remote-member probe path and the local self-stamp path so the
 * coordinator advertises each node's real OS instead of falling back to the
 * coordinator's own process.platform.
 */
function stampNodeReporterPlatform(node: any, platform: string | null, arch: string | null): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (!platform && !arch) return;
    const overrides = (node.userOverrides && typeof node.userOverrides === 'object' && !Array.isArray(node.userOverrides))
        ? node.userOverrides as Record<string, unknown>
        : {};
    let changed = false;
    if (platform && !readStringValue(overrides.platform)) { overrides.platform = platform; changed = true; }
    if (arch && !readStringValue(overrides.arch)) { overrides.arch = arch; changed = true; }
    if (changed) node.userOverrides = overrides;
}

/**
 * Persist the live self-reported platform/arch onto the local meshes.json node
 * record so capability-tag os=/arch= self-heals across coordinator restarts.
 *
 * The in-memory stamp done by recordInlineMeshDirectGitTruth lives on the
 * mesh_status assembly object and is discarded after the response; only a
 * `local_config` mesh has a backing meshes.json node to write through to. Inline
 * cache/bootstrap meshes have no local node to update, so we no-op for them.
 * Fire-and-forget (same pattern as the worktreeBootstrap writer) — a persistence
 * failure must never block the status response.
 */
export function persistNodeReporterPlatform(
    meshSource: 'inline_cache' | 'inline_bootstrap' | 'local_config',
    mesh: any,
    nodeId: string | undefined,
    reporter: {
        reporterPlatform: string | null;
        reporterArch: string | null;
        reporterMachineNickname?: string | null;
        reporterProviderVersions?: Record<string, string> | null;
        reporterDaemonBuildVersion?: string | null;
        reportedMemberState?: MeshReportedMemberState | null;
        nodeFacts?: import('@adhdev/mesh-shared').MeshNodeFacts | null;
    },
): void {
    if (meshSource !== 'local_config') return;
    const meshId = readStringValue(mesh?.id);
    if (!meshId || !nodeId) return;
    const reportedPlatform = reporter.reporterPlatform ?? undefined;
    const reportedArch = reporter.reporterArch ?? undefined;
    const reportedMachineNickname = reporter.reporterMachineNickname ?? undefined;
    const reportedProviderVersions = reporter.reporterProviderVersions ?? undefined;
    const reportedDaemonBuildVersion = reporter.reporterDaemonBuildVersion ?? undefined;
    // Persist the unified mirrored member state so a remote node's version chips
    // survive a coordinator restart (mirrors the per-field self-heal). Carries
    // per-machine runtime facts only (versions + build) — slots are coordinator-owned
    // config, not reported (REMOTE-NODE-SLOTS-COORDINATOR-LOCAL fix).
    const reportedMemberState = reporter.reportedMemberState ?? undefined;
    const nodeFacts = reporter.nodeFacts ?? undefined;
    if (
        !reportedPlatform &&
        !reportedArch &&
        !reportedMachineNickname &&
        !reportedProviderVersions &&
        !reportedDaemonBuildVersion &&
        !reportedMemberState &&
        !nodeFacts
    ) {
        return;
    }
    void import('../config/mesh-config.js')
        .then(({ updateNode }) => updateNode(meshId, nodeId, {
            reportedPlatform,
            reportedArch,
            reportedMachineNickname,
            reportedProviderVersions,
            reportedDaemonBuildVersion,
            reportedMemberState,
            nodeFacts,
        }))
        .catch(() => { /* best-effort self-heal; never block status assembly */ });
}

export function buildCachedInlineMeshGitStatus(node: any): Record<string, unknown> | undefined {
    const liveGit = buildInlineMeshTransitGitStatus(node);
    if (liveGit) return liveGit;

    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const cachedGit = readObjectRecord(cachedStatus.git);
    if (!Object.keys(cachedGit).length) return undefined;
    return normalizeInlineMeshGitStatus(cachedGit, node);
}

function shouldDiscardCachedInlineMeshStatus(node: any): boolean {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    if (!Object.keys(cachedStatus).length) return false;
    const cachedGit = readObjectRecord(cachedStatus.git);
    const workspaceError = readStringValue(cachedStatus.error, node?.error);
    if (workspaceError && /workspace must be an existing directory/i.test(workspaceError)) return true;
    const isGitRepo = readBooleanValue(cachedGit.isGitRepo);
    const branch = readStringValue(cachedGit.branch);
    const headCommit = readStringValue(cachedGit.headCommit);
    return isGitRepo === false && !branch && !headCommit;
}

function stripInlineMeshTransientNodeState(node: any): any {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const {
        cachedStatus,
        lastGit: _lastGit,
        last_git: _lastGitLegacy,
        lastProbe: _lastProbe,
        last_probe: _lastProbeLegacy,
        error: _error,
        health: _health,
        machineStatus: _machineStatus,
        lastSeenAt: _lastSeenAt,
        last_seen_at: _lastSeenAtLegacy,
        updatedAt: _updatedAt,
        updated_at: _updatedAtLegacy,
        activeSession: _activeSession,
        active_session: _activeSessionLegacy,
        activeSessionId: _activeSessionId,
        active_session_id: _activeSessionIdLegacy,
        sessionId: _sessionId,
        session_id: _sessionIdLegacy,
        providerType: _providerType,
        provider_type: _providerTypeLegacy,
        ...rest
    } = node as Record<string, unknown>;
    if (cachedStatus && !shouldDiscardCachedInlineMeshStatus(node)) {
        return { ...rest, cachedStatus };
    }
    return rest;
}

function hasInlineMeshTransientNodeState(node: any): boolean {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    return 'cachedStatus' in node
        || 'lastGit' in node
        || 'last_git' in node
        || 'lastProbe' in node
        || 'last_probe' in node
        || 'error' in node
        || 'health' in node
        || 'machineStatus' in node
        || 'lastSeenAt' in node
        || 'last_seen_at' in node
        || 'updatedAt' in node
        || 'updated_at' in node
        || 'activeSession' in node
        || 'active_session' in node
        || 'activeSessionId' in node
        || 'active_session_id' in node
        || 'sessionId' in node
        || 'session_id' in node
        || 'providerType' in node
        || 'provider_type' in node;
}

export function inlineMeshCarriesTransientNodeTruth(inlineMesh: any): boolean {
    if (!inlineMesh || typeof inlineMesh !== 'object' || Array.isArray(inlineMesh)) return false;
    if (!Array.isArray(inlineMesh.nodes) || inlineMesh.nodes.length === 0) return false;
    return inlineMesh.nodes.some((node: any) => hasInlineMeshTransientNodeState(node));
}

export function readInlineMeshNodeId(node: any): string {
    // 3-way (id / nodeId / node_id) via the shared normalizer. The old 2-way
    // `id ?? nodeId` dropped the SQLite `node_id` form, so an inline-cached node
    // that arrived in that form failed to reconcile against its cached twin.
    return normalizeMeshNodeId(node) ?? '';
}

// A local worktree node whose workspace directory has been deleted from disk.
// The worktree was removed (or the machine pruned it) but the node still lingers
// in the inline mesh cache. Such a node has no live truth to confirm and must
// never be probed or counted toward direct-peer-truth — doing so blocks the
// graph with a permanent `direct_peer_truth_unavailable`. Deliberately narrow:
// it only fires for `isLocalWorktree === true` nodes with a recorded workspace
// that does not exist. Remote nodes and nodes whose workspace is present on disk
// are never matched, so a slow remote peer is still classified unavailable.
export function isDeadLocalWorktreeNode(node: any): boolean {
    if (node?.isLocalWorktree !== true) return false;
    const workspace = readStringValue(node?.workspace);
    if (!workspace) return false;
    return !fs.existsSync(workspace);
}

// Boundary normalization: reconcile a node's identity so `id` and `nodeId` both
// carry the same canonical value (any incoming form — id / nodeId / node_id — is
// absorbed by normalizeMeshNodeId, and the SQLite `node_id` leak is dropped).
// See foldMeshNodeIdentityToCanonical for why both fields are kept equal rather
// than collapsing to one. The rewrite is shallow (other runtime fields are
// preserved); records that already agree are returned unchanged so
// identity-equality fast paths hold.
export function foldMeshNodeIdentityToCanonical(node: any): any {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const canonical = normalizeMeshNodeId(node);
    if (canonical === undefined) return node;
    // Save-boundary identity folding, applied IN PLACE. We DUAL-WRITE both `id`
    // and `nodeId` to the single canonical value (and drop the SQLite `node_id`
    // leak), rather than collapsing to one field. Two halves of the system read
    // different field names: the mesh_status serializer emits `nodeId`, while the
    // worktree clone path and get_mesh membership consumers read `node.id`.
    // Folding to ONE form would break whichever side reads the other. Keeping
    // both fields equal makes every reader correct AND makes the
    // snapshot→cache→reconcile→snapshot round-trip form-stable (no field ever
    // flips, because both always agree). Mutating in place (not returning a new
    // object) preserves the cached node-object identity that callers warming an
    // inline mesh from an already-shared snapshot rely on.
    // Intentional per-field raw compare against the already-computed canonical
    // value: this is the fold's no-op fast path, checking whether EACH form field
    // is already folded. Using meshNodeIdMatches (which normalizes across forms)
    // would defeat the point — we must inspect each raw field's current state, not
    // a form-agnostic match. Hence the identity-guard opt-out below.
    // eslint-disable-next-line no-restricted-syntax -- verified same-source canonical no-op guard (see above)
    if (node.id === canonical && node.nodeId === canonical && node.node_id === undefined) return node;
    node.id = canonical;
    node.nodeId = canonical;
    if ('node_id' in node) delete node.node_id;
    return node;
}

export function normalizeInlineMeshNodeIdentity(inlineMesh: any): any {
    if (!inlineMesh || typeof inlineMesh !== 'object' || Array.isArray(inlineMesh)) return inlineMesh;
    if (!Array.isArray(inlineMesh.nodes) || inlineMesh.nodes.length === 0) return inlineMesh;
    // Fold each node IN PLACE so the mesh object and its nodes array keep their
    // identity — sanitizeInlineMesh and the cache-sharing callers depend on
    // unchanged inputs returning the same reference.
    for (const node of inlineMesh.nodes) foldMeshNodeIdentityToCanonical(node);
    return inlineMesh;
}

export function sanitizeInlineMesh(inlineMesh: any): any {
    if (!inlineMesh || typeof inlineMesh !== 'object' || Array.isArray(inlineMesh)) return inlineMesh;
    if (!Array.isArray(inlineMesh.nodes)) return inlineMesh;
    let changed = false;
    const nodes = inlineMesh.nodes.map((node: any) => {
        if (!hasInlineMeshTransientNodeState(node)) return node;
        changed = true;
        return stripInlineMeshTransientNodeState(node);
    });
    if (!changed) return inlineMesh;
    return {
        ...inlineMesh,
        nodes,
    };
}

// NODE-MEMBERSHIP-SHRINK-ON-MERGE: reconcileInlineMeshCache used to derive
// membership shrinkage from a client-local `updatedAt` timestamp comparison
// (`preserveCachedMembership`). That timestamp is bumped by ANY MCP client on
// ITS OWN possibly-stale mesh snapshot whenever it makes an unrelated
// git-status/refine/slots-type call — it carries no information about whether
// that client has ever learned a given node exists. When an incoming snapshot
// happened to carry an `updatedAt` that was not older than the cache's, a node
// that existed ONLY in the cache (e.g. a worktree just registered by
// clone_mesh_node, not yet echoed back by every other client) was silently
// dropped from the merged result — no removeNode() call, no ledger entry, no
// log line. Root-caused via mesh RCA 2026-07-25: 37 node_cloned events over two
// days, only the 3 permanent base nodes surviving in the durable registry.
//
// Fix: membership merge is UNION by default. A node present only in the cache
// survives reconciliation unconditionally UNLESS its id appears in
// `removedNodeIds` — positive evidence of an intentional removal, populated
// only by the explicit remove_mesh_node path's tombstone set
// (DaemonCommandRouter#tombstoneRemovedInlineMeshNode). `updatedAt` is still
// used to decide which SIDE's fields win on a genuine field-level conflict for
// nodes both sides agree exist, but it is never again used to decide whether a
// node exists at all.
export function reconcileInlineMeshCache(cached: any, incoming: any, removedNodeIds?: ReadonlySet<string>): any {
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return incoming;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return cached;
    const cachedNodes = Array.isArray(cached.nodes) ? cached.nodes : [];
    const incomingNodes = Array.isArray(incoming.nodes) ? incoming.nodes : [];
    if (!cachedNodes.length || !incomingNodes.length) return { ...cached, ...incoming };

    const cachedUpdatedAt = Date.parse(readStringValue(cached.updatedAt, cached.updated_at) || '');
    const incomingUpdatedAt = Date.parse(readStringValue(incoming.updatedAt, incoming.updated_at) || '');
    // Field-precedence only (which side's fields win for a node both sides
    // agree exists) — no longer gates whether a cache-only node survives.
    const cacheFieldsWinOnConflict = Number.isFinite(cachedUpdatedAt)
        && (!Number.isFinite(incomingUpdatedAt) || cachedUpdatedAt > incomingUpdatedAt);

    const cachedById = new Map<string, any>();
    for (const node of cachedNodes) {
        const nodeId = readInlineMeshNodeId(node);
        if (nodeId) cachedById.set(nodeId, node);
    }

    const mergedIncomingIds = new Set<string>();
    const nodes = incomingNodes.map((incomingNode: any) => {
        const nodeId = readInlineMeshNodeId(incomingNode);
        const cachedNode = nodeId ? cachedById.get(nodeId) : undefined;
        if (nodeId) mergedIncomingIds.add(nodeId);
        if (!cachedNode) return incomingNode;
        if (hasInlineMeshTransientNodeState(incomingNode)) {
            return cacheFieldsWinOnConflict ? { ...incomingNode, ...cachedNode } : { ...cachedNode, ...incomingNode };
        }
        return { ...stripInlineMeshTransientNodeState(cachedNode), ...incomingNode };
    });

    // Union: every node that exists only in the cache survives reconciliation
    // unless it carries positive removal evidence (tombstoned by an explicit
    // remove_mesh_node). A freshly cloned worktree node lives only in the
    // coordinator's cache until the next snapshot catches up; dropping it here
    // would make it invisible to get_mesh / membership reads even though
    // worktree_bootstrap_complete already fired.
    const droppedNodeIds: string[] = [];
    for (const cachedNode of cachedNodes) {
        const nodeId = readInlineMeshNodeId(cachedNode);
        if (!nodeId || mergedIncomingIds.has(nodeId)) continue;
        if (removedNodeIds?.has(nodeId)) {
            droppedNodeIds.push(nodeId);
            continue;
        }
        nodes.push(cachedNode);
    }

    if (droppedNodeIds.length > 0) {
        LOG.info('Mesh', `[NodeMembershipMerge] mesh=${String(cached.id || incoming.id || 'unknown')} droppedNodeIds=${JSON.stringify(droppedNodeIds)} reason=tombstoned_removal cachedCount=${cachedNodes.length} incomingCount=${incomingNodes.length}`);
    }

    return {
        ...cached,
        ...incoming,
        nodes,
    };
}
