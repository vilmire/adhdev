/**
 * Mesh node-identity & git-freshness helpers
 *
 * Extracted from commands/router.ts (behavior-preserving move). Contains:
 *   - daemon-id / machine-id / hostname normalization + canonicalization
 *   - inline-mesh node identity reconciliation and transient-state handling
 *   - git-status normalization, branch-convergence, and freshness/staleness derivation
 *   - the direct git-probe cache and remote git-status probe machinery
 *
 * router.ts re-exports every public symbol from here so existing import paths
 * (e.g. `from '.../commands/router.js'`) keep working.
 */

import type { ProviderLoader } from '../providers/provider-loader.js';
import { detectCLI } from '../detection/cli-detector.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { normalizeGitStatus as sharedNormalizeGitStatus, pickBestTransitGitStatus as sharedPickBestTransitGitStatus, summarizeGitShape as sharedSummarizeGitShape, normalizeMeshNodeId, daemonIdsEquivalent, meshWorkspacesEquivalent, sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import { awaitWithWarmupDeadline, resolveWarmupDeadlineOpts } from '../mesh/mesh-warmup-deadline.js';
import * as fs from 'fs';
import { workingDirBasename } from '../providers/working-dir.js';
import { readMeshTimeoutEnvMs, MESH_CONNECT_TIMEOUT_MS } from '../runtime-defaults.js';

export function readProviderPriorityFromPolicy(policy: unknown): string[] {
    const record = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy as Record<string, unknown>
        : {};
    const raw = record.providerPriority;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
        .map(type => typeof type === 'string' ? type.trim() : '')
        .filter(Boolean)
        .filter(type => {
            if (seen.has(type)) return false;
            seen.add(type);
            return true;
        });
}

/**
 * Normalize a providerRoles array (RepoMeshNodePolicy.providerRoles) from raw
 * tool args. Each entry binds a providerType to an optional `maxParallel` cap.
 * Entries without a usable providerType are dropped; the last entry wins on
 * duplicate providerType. Returns [] when no valid entries — callers then omit
 * the field entirely (full backward compat). Routing is governed by required_tags;
 * any legacy `role` field on the input is ignored.
 */
export function normalizeProviderRoles(value: unknown): Array<{ providerType: string; maxParallel?: number }> {
    if (!Array.isArray(value)) return [];
    const byType = new Map<string, { providerType: string; maxParallel?: number }>();
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const rec = raw as Record<string, unknown>;
        const providerType = typeof rec.providerType === 'string' ? rec.providerType.trim() : '';
        if (!providerType) continue;
        const entry: { providerType: string; maxParallel?: number } = { providerType };
        const maxParallel = Number(rec.maxParallel);
        if (Number.isFinite(maxParallel) && maxParallel >= 0) entry.maxParallel = Math.floor(maxParallel);
        byType.set(providerType.toLowerCase(), entry);
    }
    return [...byType.values()];
}

export function readObjectRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : {};
}

export function readStringValue(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function readNumberValue(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

export function readBooleanValue(...values: unknown[]): boolean | undefined {
    for (const value of values) {
        if (typeof value === 'boolean') return value;
    }
    return undefined;
}

// summarizeRepoMeshDebugGit was a hand-synced copy of the cloud git-shape
// summarizer; both now call shared summarizeGitShape (@adhdev/mesh-shared).

export function summarizeRepoMeshStatusDebug(status: any): Record<string, unknown> {
    const nodes = Array.isArray(status?.nodes) ? status.nodes : [];
    return {
        success: status?.success,
        meshId: readStringValue(status?.meshId, status?.mesh_id) ?? null,
        refreshedAt: readStringValue(status?.refreshedAt, status?.refreshed_at) ?? null,
        sourceOfTruth: status?.sourceOfTruth ?? null,
        branchConvergenceSummary: status?.branchConvergenceSummary ?? status?.branch_convergence_summary ?? null,
        nodeCount: nodes.length,
        nodes: nodes.map((node: any) => ({
            // Status emits the id under `nodeId` (3-way input absorbed). The
            // inline cache keeps `id` and `nodeId` equal, so this serialized form
            // round-trips back through the cache without flipping shape.
            nodeId: normalizeMeshNodeId(node) ?? null,
            daemonId: readStringValue(node?.daemonId, node?.daemon_id) ?? null,
            workspace: readStringValue(node?.workspace, node?.git?.workspace) ?? null,
            health: readStringValue(node?.health) ?? null,
            machineStatus: readStringValue(node?.machineStatus, node?.machine_status) ?? null,
            connection: node?.connection && typeof node.connection === 'object' ? {
                state: readStringValue(node.connection.state) ?? null,
                transport: readStringValue(node.connection.transport) ?? null,
                source: readStringValue(node.connection.source) ?? null,
                reported: readBooleanValue(node.connection.reported) ?? null,
            } : null,
            gitProbePending: node?.gitProbePending === true,
            launchReady: node?.launchReady === true,
            git: sharedSummarizeGitShape(node?.git),
            branchConvergence: node?.branchConvergence ?? node?.branch_convergence ?? null,
        })),
    };
}

export function logRepoMeshStatusDebug(event: string, fields: Record<string, unknown>): void {
    try {
        LOG.info('MeshStatusDebug', `[RepoMeshStatusDebug] ${JSON.stringify({ event, ...fields })}`);
    } catch {
        LOG.info('MeshStatusDebug', `[RepoMeshStatusDebug] ${event}`);
    }
}

// joinRepoPath + readGitSubmodules moved to @adhdev/mesh-shared (readGitSubmodules)
// — used via sharedNormalizeGitStatus / sharedPickBestTransitGitStatus below.

export function buildMeshNodeDisplayLabel(node: Record<string, unknown>, nodeId: string, providerPriority: string[]): string {
    const explicit = readStringValue(node.machineLabel, node.machine_label, node.machineNickname, node.machine_nickname, node.alias);
    if (explicit) return explicit;
    const workspace = readStringValue(node.workspace, node.repoRoot, node.repo_root);
    // Use the OS-agnostic basename: a workspace reported by a Windows node
    // (`D:\gh\adhdev-cloud`) must still collapse to its trailing segment even when
    // this coordinator's own `path.basename` is POSIX-only and would not split `\`.
    const workspaceName = workspace ? workingDirBasename(workspace) : undefined;
    const host = readStringValue(node.machineName, node.machine_name, node.hostname, node.host, node.daemonId, node.daemon_id, node.machineId, node.machine_id);
    const provider = providerPriority[0] || (Array.isArray(node.providers) ? readStringValue(...node.providers) : undefined);
    const parts = [workspaceName, host, provider].filter(Boolean);
    if (parts.length > 0) return parts.join(' · ');
    return nodeId || 'unidentified mesh node';
}

function normalizeMeshHostname(value: unknown): string | undefined {
    const hostname = readStringValue(value);
    if (!hostname) return undefined;
    return hostname.toLowerCase().replace(/\.$/, '');
}

export function readMeshNodeMachineId(node: Record<string, unknown>): string | undefined {
    return readStringValue(
        node.machineId,
        node.machine_id,
        readObjectRecord(node.machine)?.id,
        readObjectRecord(node.machine)?.machineId,
        readObjectRecord(node.lastProbe)?.machineId,
        readObjectRecord(node.last_probe)?.machine_id,
        readObjectRecord(readObjectRecord(node.lastProbe)?.machine)?.id,
        readObjectRecord(readObjectRecord(node.lastProbe)?.machine)?.machineId,
        readObjectRecord(readObjectRecord(node.last_probe)?.machine)?.id,
        readObjectRecord(readObjectRecord(node.last_probe)?.machine)?.machine_id,
    );
}

export function readMeshNodeDaemonId(node: Record<string, unknown>): string | undefined {
    return readStringValue(
        node.daemonId,
        node.daemon_id,
        readObjectRecord(node.machine)?.daemonId,
        readObjectRecord(node.machine)?.daemon_id,
        readObjectRecord(node.lastProbe)?.daemonId,
        readObjectRecord(node.last_probe)?.daemon_id,
        readObjectRecord(readObjectRecord(node.lastProbe)?.machine)?.daemonId,
        readObjectRecord(readObjectRecord(node.lastProbe)?.machine)?.daemon_id,
        readObjectRecord(readObjectRecord(node.last_probe)?.machine)?.daemonId,
        readObjectRecord(readObjectRecord(node.last_probe)?.machine)?.daemon_id,
    );
}

export function readMeshNodeHostname(node: Record<string, unknown>): string | undefined {
    return readStringValue(
        node.hostname,
        node.host,
        node.machineHostname,
        node.machine_hostname,
        readObjectRecord(node.machine)?.hostname,
        readObjectRecord(node.machine)?.host,
        readObjectRecord(node.lastProbe)?.hostname,
        readObjectRecord(node.last_probe)?.hostname,
        readObjectRecord(readObjectRecord(node.lastProbe)?.machine)?.hostname,
        readObjectRecord(readObjectRecord(node.last_probe)?.machine)?.hostname,
    );
}

function readMeshNodeDisplayMachineName(node: Record<string, unknown>): string | undefined {
    return readStringValue(
        node.machineName,
        node.machine_name,
        node.machineLabel,
        node.machine_label,
        node.machineNickname,
        node.machine_nickname,
        node.alias,
        readObjectRecord(node.machine)?.name,
        readObjectRecord(node.machine)?.displayName,
        readObjectRecord(node.machine)?.display_name,
        readObjectRecord(node.lastProbe)?.machineName,
        readObjectRecord(node.last_probe)?.machine_name,
        readObjectRecord(readObjectRecord(node.lastProbe)?.machine)?.name,
        readObjectRecord(readObjectRecord(node.last_probe)?.machine)?.name,
        readMeshNodeHostname(node),
    );
}

function compactMeshIdentityEvidence(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

export function buildMeshNodeMachineIdentity(node: Record<string, unknown>, opts: {
    localMachineId?: string;
    localDaemonId?: string;
    coordinatorHostname?: string;
    isSelfNode?: boolean;
}): Record<string, unknown> {
    const machineId = readMeshNodeMachineId(node);
    const daemonId = readMeshNodeDaemonId(node);
    const hostname = readMeshNodeHostname(node);
    const machineName = readMeshNodeDisplayMachineName(node);
    const coordinatorHostname = readStringValue(opts.coordinatorHostname);
    const machineIdMatches = Boolean(opts.localMachineId && machineId && opts.localMachineId === machineId);
    const daemonIdMatches = Boolean(opts.localDaemonId && daemonId && daemonIdsEquivalent(opts.localDaemonId, daemonId));
    const hostnameMatches = Boolean(
        normalizeMeshHostname(hostname)
        && normalizeMeshHostname(coordinatorHostname)
        && normalizeMeshHostname(hostname) === normalizeMeshHostname(coordinatorHostname),
    );
    const sameMachine = opts.isSelfNode === true || machineIdMatches || daemonIdMatches || hostnameMatches;
    const evidence: string[] = [];
    for (const [label, value] of [['machineName', machineName], ['hostname', hostname], ['machineId', machineId], ['daemonId', daemonId]] as const) {
        const compact = compactMeshIdentityEvidence(value);
        if (compact) evidence.push(`${label}:${compact}`);
    }
    const locality = sameMachine ? 'same_machine' : (evidence.length > 0 ? 'remote_known' : 'remote_or_unknown');
    const localityReason = sameMachine
        ? (machineIdMatches ? 'matched coordinator machine id'
            : daemonIdMatches ? 'matched coordinator daemon id'
                : hostnameMatches ? 'matched coordinator hostname'
                    : 'selected coordinator node')
        : evidence.length > 0
            ? `known remote/other machine identity; no local coordinator match (${evidence.join(', ')})`
            : 'no useful machine identity evidence available';
    return {
        daemonId,
        machineId,
        hostname,
        machineName,
        displayName: machineName || hostname || daemonId || machineId,
        coordinatorHostname,
        sameMachine,
        locality,
        localityReason,
        identityEvidence: evidence,
    };
}

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
    return sharedPickBestTransitGitStatus(readObjectRecord(node), { lastCheckedAt: Date.now() }) as Record<string, unknown> | undefined;
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
} {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return {
            reporterPlatform: null,
            reporterArch: null,
            reporterMachineNickname: null,
            reporterProviderVersions: null,
            reporterDaemonBuildVersion: null,
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
    const reporterProviderVersions = readProviderVersionsRecord(git.reporterProviderVersions);
    if (reporterProviderVersions) node.reportedProviderVersions = reporterProviderVersions;
    const reporterDaemonBuildVersion = readStringValue(git.reporterDaemonBuildVersion) ?? null;
    if (reporterDaemonBuildVersion) node.reportedDaemonBuildVersion = reporterDaemonBuildVersion;
    return {
        reporterPlatform,
        reporterArch,
        reporterMachineNickname,
        reporterProviderVersions,
        reporterDaemonBuildVersion,
    };
}

/**
 * Coerce an unknown git-envelope `reporterProviderVersions` field into a clean
 * `{ providerId: version }` record: only string→non-empty-string entries survive.
 * Returns null when nothing usable is present so callers can skip the stamp.
 */
function readProviderVersionsRecord(value: unknown): Record<string, string> | null {
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
    if (
        !reportedPlatform &&
        !reportedArch &&
        !reportedMachineNickname &&
        !reportedProviderVersions &&
        !reportedDaemonBuildVersion
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
        }))
        .catch(() => { /* best-effort self-heal; never block status assembly */ });
}

function buildCachedInlineMeshGitStatus(node: any): Record<string, unknown> | undefined {
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

export function reconcileInlineMeshCache(cached: any, incoming: any): any {
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return incoming;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return cached;
    const cachedNodes = Array.isArray(cached.nodes) ? cached.nodes : [];
    const incomingNodes = Array.isArray(incoming.nodes) ? incoming.nodes : [];
    if (!cachedNodes.length || !incomingNodes.length) return { ...cached, ...incoming };

    const cachedUpdatedAt = Date.parse(readStringValue(cached.updatedAt, cached.updated_at) || '');
    const incomingUpdatedAt = Date.parse(readStringValue(incoming.updatedAt, incoming.updated_at) || '');
    const preserveCachedMembership = Number.isFinite(cachedUpdatedAt)
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
        if (!cachedNode && preserveCachedMembership) return null;
        if (nodeId) mergedIncomingIds.add(nodeId);
        if (!cachedNode) return incomingNode;
        if (hasInlineMeshTransientNodeState(incomingNode)) {
            return { ...cachedNode, ...incomingNode };
        }
        return { ...stripInlineMeshTransientNodeState(cachedNode), ...incomingNode };
    }).filter(Boolean);

    // When the cached membership is authoritative (newer than the incoming
    // snapshot), nodes that exist only in the cache must survive reconciliation.
    // A freshly cloned worktree node lives only in the coordinator's cache until
    // the next snapshot catches up; iterating incomingNodes alone would silently
    // drop it, making the node invisible to get_mesh / membership reads even
    // though worktree_bootstrap_complete already fired.
    if (preserveCachedMembership) {
        for (const cachedNode of cachedNodes) {
            const nodeId = readInlineMeshNodeId(cachedNode);
            if (nodeId && !mergedIncomingIds.has(nodeId)) {
                nodes.push(cachedNode);
            }
        }
    }

    return {
        ...cached,
        ...incoming,
        nodes,
    };
}

function hasGitWorktreeChanges(git: Record<string, unknown> | null | undefined): boolean {
    return countGitWorktreeChanges(git) > 0;
}

function countGitWorktreeChanges(git: Record<string, unknown> | null | undefined): number {
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

function isInlineMeshAutoFastForwardEligible(git: Record<string, unknown> | null | undefined): boolean {
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

function readMeshNodeLabel(status: Record<string, unknown>, node: any): string {
    return readStringValue(status.nodeId, normalizeMeshNodeId(node)) ?? 'unknown';
}

function buildInlineMeshBranchConvergence(args: {
    mesh: any;
    node: any;
    status: Record<string, unknown>;
}): Record<string, unknown> {
    const git = readObjectRecord(args.status.git);
    const nodeLabel = readMeshNodeLabel(args.status, args.node);
    const defaultBranch = readStringValue(args.mesh?.defaultBranch) ?? 'main';
    const branch = readStringValue(git.branch, args.node?.worktreeBranch) ?? null;
    const upstream = readStringValue(git.upstream) ?? null;
    const upstreamStatus = readStringValue(git.upstreamStatus, git.upstream_status)
        ?? (upstream ? 'unchecked' : 'no_upstream');
    const ahead = readNumberValue(git.ahead) ?? 0;
    const behind = readNumberValue(git.behind) ?? 0;
    const uncommittedChanges = countGitWorktreeChanges(git);
    const hasConflicts = readBooleanValue(git.hasConflicts)
        ?? (Array.isArray(git.conflictFiles) && git.conflictFiles.length > 0);
    const base = {
        defaultBranch,
        branch,
        upstream,
        upstreamStatus,
        ahead,
        behind,
        isWorktree: args.node?.isLocalWorktree === true || args.status.isLocalWorktree === true,
        isDefaultBranch: branch === defaultBranch,
    };

    if (readBooleanValue(git.isGitRepo) !== true) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'git_status_unavailable',
            nextStep: `Resolve git status for node '${nodeLabel}' before marking the task complete.`,
        };
    }

    if (!branch) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'branch_unknown',
            nextStep: `Inspect node '${nodeLabel}' git branch before deciding whether it is merged to ${defaultBranch}.`,
        };
    }

    if (hasConflicts || uncommittedChanges > 0) {
        return {
            ...base,
            status: 'not_mergeable',
            needsConvergence: true,
            reason: hasConflicts ? 'conflicts_present' : 'dirty_workspace',
            nextStep: `Commit, checkpoint, or resolve node '${nodeLabel}' before any main convergence step.`,
        };
    }

    if (branch === defaultBranch) {
        if (upstream && upstreamStatus !== 'fresh') {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_upstream_unverified',
                nextStep: `Refresh ${defaultBranch}'s upstream refs or resolve the fetch failure before declaring convergence complete for node '${nodeLabel}'.`,
            };
        }
        if (ahead > 0 || behind > 0) {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_not_even_with_upstream',
                nextStep: `Bring ${defaultBranch} even with its upstream before declaring convergence complete.`,
            };
        }
        return {
            ...base,
            status: 'merged_to_main',
            needsConvergence: false,
            reason: 'clean_default_branch',
            nextStep: null,
        };
    }

    if (args.node?.isLocalWorktree === true || args.status.isLocalWorktree === true) {
        return {
            ...base,
            status: 'cleanup_candidate',
            needsConvergence: true,
            reason: 'clean_non_default_worktree_branch',
            nextStep: `Run mesh_refine_node(node_id: "${nodeLabel}") or explicitly classify this worktree as blocked_review/not_mergeable before ending the task.`,
        };
    }

    if (upstream && upstreamStatus !== 'fresh') {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'feature_branch_upstream_unverified',
            nextStep: `Refresh branch '${branch}' upstream refs or resolve the fetch failure before deciding whether it is ready to merge into ${defaultBranch}.`,
        };
    }

    if (!upstream || ahead > 0 || behind > 0) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: !upstream ? 'feature_branch_missing_upstream' : 'feature_branch_not_even_with_upstream',
            nextStep: `Push or reconcile branch '${branch}', then merge it into ${defaultBranch} or mark it not_mergeable with a reason.`,
        };
    }

    return {
        ...base,
        status: 'pushed_feature_branch_needs_merge',
        needsConvergence: true,
        reason: 'clean_non_default_branch',
        nextStep: `Review and merge branch '${branch}' into ${defaultBranch}; do not report the task as fully complete while it remains off main.`,
    };
}

export function applyInlineMeshBranchConvergence(mesh: any, node: any, status: Record<string, unknown>): void {
    const git = readObjectRecord(status.git);
    if (Object.keys(git).length === 0 && !status.gitProbePending) return;
    const uncommittedChanges = countGitWorktreeChanges(git);
    status.isDirty = uncommittedChanges > 0;
    status.uncommittedChanges = uncommittedChanges;
    status.branchConvergence = buildInlineMeshBranchConvergence({ mesh, node, status });
    status.autoFastForwardEligible = isInlineMeshAutoFastForwardEligible(git);
    if (status.autoFastForwardEligible) {
        status.suggestedAction = 'auto_fast_forward';
    } else {
        delete status.suggestedAction;
    }
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

export function readCachedInlineMeshActiveSessions(node: any): string[] {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const activeSession = readObjectRecord(cachedStatus.activeSession);
    const fallbackSession = Object.keys(activeSession).length
        ? activeSession
        : readObjectRecord(node?.activeSession ?? node?.active_session);
    const sessionId = readStringValue(fallbackSession.id, fallbackSession.sessionId, fallbackSession.session_id, node?.activeSessionId, node?.active_session_id, node?.sessionId, node?.session_id);
    return sessionId ? [sessionId] : [];
}

/**
 * Wider session-ownership scan used ONLY by resolveRemoteMeshSessionOwnerDaemonId: collect
 * EVERY session id a mesh node currently hosts. readCachedInlineMeshActiveSessions above only
 * surfaces the node's single primary session (cachedStatus.activeSession) — other consumers
 * depend on that one-session semantics, so it is left untouched. A worker hosting more than one
 * session exposes its non-primary sessions only through the plural live-session arrays the
 * coordinator carries: status.activeSessions / activeSessionDetails (built from live records on
 * the aggregate snapshot, see get_mesh_status), or a worker's merged session report. A
 * controlbar/modal command (invoke_provider_script / resolve_action / set_mode / …) targeting a
 * non-primary remote session resolves its owner daemon only when those plural shapes are scanned
 * too. Mirrors sessionStatusFromNodes' shape tolerance (mesh-active-work.ts): plural arrays of
 * string ids OR objects keyed by id/sessionId/session_id/runtimeSessionId/instanceId, on both
 * camelCase and snake_case, at the node root and under cachedStatus / lastProbe.
 */
export function collectMeshNodeHostedSessionIds(node: any): Set<string> {
    const ids = new Set<string>();
    for (const id of readCachedInlineMeshActiveSessions(node)) ids.add(id);
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    for (const value of [
        node?.activeSessions,
        node?.active_sessions,
        node?.activeSessionDetails,
        node?.active_session_details,
        node?.sessions,
        node?.sessionDetails,
        node?.session_details,
        readObjectRecord(node?.lastProbe).sessions,
        readObjectRecord(node?.last_probe).sessions,
        cachedStatus.activeSessions,
        cachedStatus.active_sessions,
        cachedStatus.activeSessionDetails,
        cachedStatus.active_session_details,
        cachedStatus.sessions,
    ]) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
            if (typeof item === 'string') {
                const id = readStringValue(item);
                if (id) ids.add(id);
                continue;
            }
            const record = readObjectRecord(item);
            const id = readStringValue(record.id, record.sessionId, record.session_id, record.runtimeSessionId, record.instanceId);
            if (id) ids.add(id);
        }
    }
    return ids;
}

/**
 * Resolve the owning-node attribution for a mesh node record so a coordinator can
 * stamp the TRUE owner onto a synthetic session entry instead of letting the
 * dashboard fall back to the coordinator's own daemonId. Returns whichever of the
 * owning node's `daemonId` / display machine name could be read from the node's
 * (possibly multi-serialization-path) shape; both may be undefined for a node that
 * never carried machine identity.
 */
export function resolveMeshNodeAttribution(node: unknown): { daemonId?: string; machineName?: string } {
    const record = readObjectRecord(node);
    return {
        daemonId: readMeshNodeDaemonId(record),
        machineName: readMeshNodeDisplayMachineName(record),
    };
}

export function readCachedInlineMeshActiveSessionDetails(node: any): Array<Record<string, unknown>> {
    const cachedStatus = readObjectRecord(node?.cachedStatus);
    const activeSession = readObjectRecord(cachedStatus.activeSession);
    const fallbackSession = Object.keys(activeSession).length
        ? activeSession
        : readObjectRecord(node?.activeSession ?? node?.active_session);
    const sessionId = readStringValue(
        fallbackSession.id,
        fallbackSession.sessionId,
        fallbackSession.session_id,
        node?.activeSessionId,
        node?.active_session_id,
        node?.sessionId,
        node?.session_id,
    );
    if (!sessionId) return [];
    return [{
        sessionId,
        providerType: readStringValue(
            fallbackSession.providerType,
            fallbackSession.provider_type,
            fallbackSession.cliType,
            fallbackSession.cli_type,
            fallbackSession.provider,
            node?.providerType,
            node?.provider_type,
        ),
        state: readStringValue(fallbackSession.status, fallbackSession.state, fallbackSession.lifecycle),
        chatStatus: readStringValue(fallbackSession.chatStatus, fallbackSession.chat_status),
        lifecycle: readStringValue(fallbackSession.lifecycle),
        title: readStringValue(fallbackSession.title, fallbackSession.displayName, fallbackSession.display_name) ?? null,
        workspace: readStringValue(fallbackSession.workspace, node?.workspace) ?? null,
        role: readStringValue(fallbackSession.role) ?? null,
        isSelfCoordinator: fallbackSession.isSelfCoordinator === true || fallbackSession.is_self_coordinator === true,
        createdAt: readStringValue(fallbackSession.createdAt, fallbackSession.created_at) ?? null,
        startedAt: readStringValue(fallbackSession.startedAt, fallbackSession.started_at) ?? null,
        lastActivityAt: readStringValue(fallbackSession.lastActivityAt, fallbackSession.last_activity_at) ?? null,
        recoveryState: readStringValue(fallbackSession.recoveryState, fallbackSession.recovery_state) ?? null,
        // [T2] Carry the worker-computed last-message preview through the cached inline-mesh
        // active-session entry. The worker's get_status_metadata slim now ships these
        // (mesh-tools.ts), and this is the surface the coordinator's inbox-preview path reads
        // (buildDaemonMetadataUpdateForSubscription → stampLocalAssistantPreviewOnCachedEntry).
        // Without carrying them here, the coordinator could only derive the preview from a live
        // in-process instance it doesn't host for a remote worker, so the inbox stuck on the
        // dispatched user task. Only present when the worker reported them.
        ...(readStringValue(fallbackSession.lastMessagePreview, fallbackSession.last_message_preview)
            ? { lastMessagePreview: readStringValue(fallbackSession.lastMessagePreview, fallbackSession.last_message_preview) } : {}),
        ...(readStringValue(fallbackSession.lastMessageRole, fallbackSession.last_message_role)
            ? { lastMessageRole: readStringValue(fallbackSession.lastMessageRole, fallbackSession.last_message_role) } : {}),
        ...(readNumberValue(fallbackSession.lastMessageAt, fallbackSession.last_message_at) !== undefined
            ? { lastMessageAt: readNumberValue(fallbackSession.lastMessageAt, fallbackSession.last_message_at) } : {}),
        isCached: true,
    }];
}

function readLiveMeshSessionState(record: any): string | undefined {
    return readStringValue(
        record?.meta?.sessionStatus,
        record?.meta?.status,
        record?.meta?.providerStatus,
        record?.status,
        record?.state,
        record?.lifecycle,
    );
}

function toIsoTimestamp(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    const stringValue = readStringValue(value);
    return stringValue || null;
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
    const git = readObjectRecord(status.git);
    const hasGit = readBooleanValue(git.isGitRepo) === true
        || !!readStringValue(git.branch, git.headCommit, git.head, git.upstream);
    const connectionFreshAt = toIsoTimestamp(connection.lastCommandAt ?? connection.lastConnectedAt ?? connection.lastStateChangeAt);
    // Provenance-aware probe time. A FRESH probe this call writes a genuine
    // git.lastCheckedAt, so trust it for live nodes. Held/standing truth, however,
    // is re-normalized through pickBestTransitGitStatus which stamps lastCheckedAt
    // with Date.now() on assembly (git-normalize.ts) — so status.git.lastCheckedAt
    // would falsely read fresh. For cached nodes prefer the authentic peer-reported
    // check time persisted on node.lastGit.checkedAt / cachedStatus, so a genuinely
    // old cache is correctly reported stale.
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
    } else if (directTruthUnavailable) {
        dataSource = 'unreachable';
        reachable = false;
    } else if (hasGit) {
        dataSource = 'cached';
        reachable = connectionReachable;
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
            status.launchReady = false;
            status.launchBlockedReason = 'worktree_bootstrap_running';
            status.launchBlockedMessage = 'Required worktree bootstrap is still running; wait for it to finish before launching an agent into this node.';
            return;
        }
    }
    const connectionState = readStringValue(readObjectRecord(status.connection).state);
    status.launchReady = !!daemonId && (
        readStringValue(status.machineStatus) === 'online'
        || connectionState === 'connected'
        || isSelfNode
    );
}


// Direct-peer git_status probe timeout for the dashboard's requireDirectPeerTruth
// bootstrap. The previous hard-coded 8s/12s were shorter than the real P2P
// round-trip to slow (often TURN-relayed) peers, so such a node was permanently
// marked unavailable and blocked the whole mesh graph. Default raised to 25s
// (still under the P2P REQUEST_TIMEOUT of 30s) and made env-overridable.
export const MESH_DIRECT_PROBE_TIMEOUT_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_TIMEOUT_MS', 25_000);
export const MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS', 25_000);
// Cold-open warmup budget for the FIRST direct-peer probe to a peer whose mesh
// DataChannel is not open yet. A fresh cross-machine, TURN-relayed handshake
// (ICE gather + TURN allocation + DTLS across two residential networks) routinely
// needs many seconds. Charging that warmup against the response deadline
// (MESH_DIRECT_PROBE_TIMEOUT_MS) made the very first git_status to a cold peer
// false-timeout, after which the warm retry — reusing the now-open channel —
// succeeded: the classic cold-open signature. This budget bounds ONLY the
// "channel not open yet" phase; once the channel opens the response deadline
// governs the round trip. A genuine connect failure still rejects immediately —
// the mesh manager fails the peer the instant its PeerConnection state goes
// terminal, and isMeshConnectionDefinitivelyDown pre-gates an already-dead peer —
// so this never masks a real failure for the whole window; it only grants a
// still-handshaking peer the time it legitimately needs. Matches the daemon-cloud
// DaemonMeshManager CONNECT_TIMEOUT_MS (45s). Env-overridable for very slow links.
// Re-exported from the unified MESH_CONNECT_TIMEOUT_MS (runtime-defaults) so this
// probe path and the coordinator's remote task-dispatch path share ONE
// env-overridable connect budget instead of silently diverging when the env is set.
export const MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS = MESH_CONNECT_TIMEOUT_MS;
// How long a successful per-peer git_status probe stays fresh enough to be
// reused instead of issuing another blocking `refreshUpstream:true` fan-out.
// A slow (TURN-relayed) peer's probe can take 9-23s, and the dashboard's
// auto-retry loop re-fires every few seconds; without this gate every retry
// would start a brand new probe storm to the same peer. Within this window the
// last successful result is reused so a refresh quiesces instead of looping.
// Min-clamped to 1s by readMeshTimeoutEnvMs; raise via env for very slow peers.
export const MESH_DIRECT_PROBE_REUSE_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_REUSE_MS', 12_000);

/**
 * De-duplicates and rate-limits per-peer git_status probes so a single mesh
 * refresh — or a burst of refreshes from the dashboard auto-retry loop — cannot
 * launch a storm of concurrent/back-to-back `refreshUpstream:true` commands to
 * the same slow peer.
 *
 * Two gates, both keyed by `daemonId::workspace`:
 *  - In-flight dedup: a second probe for a key with a probe already running
 *    shares (awaits) the in-flight promise instead of issuing a second command.
 *  - Recently-probed reuse: a successful probe younger than `reuseMs` is reused
 *    verbatim instead of issuing a fresh probe. Failures are NOT cached (so a
 *    transient timeout doesn't pin a peer to "no truth" for the whole window).
 *
 * Lives on the router instance so the gate spans separate mesh_status calls,
 * which is exactly where the refresh storm happens.
 */
export class MeshGitProbeCache {
    private inflight = new Map<string, Promise<Record<string, unknown> | null>>();
    private recent = new Map<string, { at: number; value: Record<string, unknown> }>();

    constructor(private readonly reuseMs: number, private readonly now: () => number = Date.now) {}

    private key(daemonId: string, workspace: string): string {
        return `${daemonId}::${workspace}`;
    }

    /**
     * Local (same-machine) git_status dedup. The bootstrap direct-truth hydrate
     * and the per-node render loop both call getGitRepoStatus(refreshUpstream:true)
     * for the same local workspace within one mesh_status call. Each such probe
     * fans out ~13-15 git subprocesses, and because the two passes are separated by
     * the render/hydrate work of every OTHER node they routinely straddle the
     * getGitRepoStatus 1.5s TTL, so the second pass re-shells the whole ~14-process
     * collection. Routing both through this cache (namespaced under a reserved
     * daemon id so it never collides with a remote-peer key) collapses them to one
     * collection per workspace per request, and reuses it across the reuse window
     * so the dashboard auto-retry loop can't restart a fresh local probe seconds
     * apart either.
     */
    private static readonly LOCAL_PROBE_DAEMON_ID = '__local_git__';

    async probeLocal(
        workspace: string,
        probe: () => Promise<Record<string, unknown> | null>,
    ): Promise<Record<string, unknown> | null> {
        return this.probe(MeshGitProbeCache.LOCAL_PROBE_DAEMON_ID, workspace, probe);
    }

    /**
     * Run `probe` for this peer, but reuse a fresh recent result or an in-flight
     * probe for the same key when one is available. `probe` is only invoked when
     * neither gate is satisfied.
     */
    async probe(
        daemonId: string,
        workspace: string,
        probe: () => Promise<Record<string, unknown> | null>,
    ): Promise<Record<string, unknown> | null> {
        const key = this.key(daemonId, workspace);
        const cached = this.recent.get(key);
        if (cached && this.now() - cached.at < this.reuseMs) {
            return cached.value;
        }
        const existing = this.inflight.get(key);
        if (existing) return existing;
        const pending = (async () => {
            const result = await probe();
            if (result) this.recent.set(key, { at: this.now(), value: result });
            return result;
        })();
        this.inflight.set(key, pending);
        try {
            return await pending;
        } finally {
            // Only clear the slot if it is still ours — a later overlapping call
            // would have reused this very promise, so it is safe to delete here.
            if (this.inflight.get(key) === pending) this.inflight.delete(key);
        }
    }
}

// The warmup-aware deadline now lives in the dependency-free mesh leaf so BOTH the
// dashboard git_status probe (here) and the general task-dispatch path
// (mesh/mesh-events-coordinator.ts) can share it without an import cycle. Re-exported
// for the existing `from '../commands/router.js'` callers/tests.
export { awaitWithWarmupDeadline };

async function probeRemoteMeshGitStatus(args: {
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    daemonId: string;
    workspace: string;
    // Response deadline — applies only once the peer's DataChannel is open (warm).
    responseTimeoutMs: number;
    // Cold-open warmup budget — applies only while the channel is still opening.
    connectTimeoutMs: number;
    // Live peer connection snapshot getter; lets the deadline tell "still warming
    // up" apart from "warm but slow". Absent → degrade conservatively (fail-loud,
    // combined connect+response window) rather than silently assuming "always warm"
    // — see resolveWarmupDeadlineOpts.
    getConnection?: (daemonId: string) => Record<string, unknown> | null;
}): Promise<Record<string, unknown> | null> {
    if (!args.dispatchMeshCommand) return null;
    // Fire the dispatch first — this is what drives the mesh manager to ensure /
    // open the peer connection. The warmup-aware deadline then charges the
    // cold-open handshake to the connect budget and only the warm round trip to
    // the response budget, so the first probe to a cold peer is no longer
    // false-timed-out before its channel has even opened.
    const dispatch = args.dispatchMeshCommand(args.daemonId, 'git_status', { workspace: args.workspace, refreshUpstream: true });
    // A missing connection getter no longer silently becomes `() => true`
    // ("always warm") — that charged a still-opening channel against the response
    // budget and re-introduced the cold-open false-timeout. resolveWarmupDeadlineOpts
    // warns once per peer and grants the combined budget instead.
    const remoteResult = await awaitWithWarmupDeadline(dispatch, resolveWarmupDeadlineOpts({
        getConnection: args.getConnection,
        daemonId: args.daemonId,
        connectTimeoutMs: args.connectTimeoutMs,
        responseTimeoutMs: args.responseTimeoutMs,
        onMissingGetter: warnMeshWarmupGetterMissingOnce,
    })) as any;
    const remoteGit = remoteResult?.status ?? remoteResult?.git ?? remoteResult;
    if (!remoteGit || typeof remoteGit !== 'object' || typeof remoteGit.isGitRepo !== 'boolean') return null;
    // The member daemon stamps its own platform/arch onto the git_status result
    // envelope (see git-commands.ts). Reflect them onto the returned git object
    // under non-colliding reporter* keys so recordInlineMeshDirectGitTruth can
    // persist them to node.userOverrides without touching the git status shape.
    const reporterPlatform = readStringValue(remoteResult?.reporterPlatform);
    const reporterArch = readStringValue(remoteResult?.reporterArch);
    const reporterMachineNickname = readStringValue(remoteResult?.reporterMachineNickname);
    const git = remoteGit as Record<string, unknown>;
    if (reporterPlatform) git.reporterPlatform = reporterPlatform;
    if (reporterArch) git.reporterArch = reporterArch;
    if (reporterMachineNickname) git.reporterMachineNickname = reporterMachineNickname;
    // T7: propagate the member's self-reported provider versions + build version on
    // the same reporter* channel so a remote node's providerVersions self-heal too.
    const reporterProviderVersions = readProviderVersionsRecord(remoteResult?.reporterProviderVersions);
    if (reporterProviderVersions) git.reporterProviderVersions = reporterProviderVersions;
    const reporterDaemonBuildVersion = readStringValue(remoteResult?.reporterDaemonBuildVersion);
    if (reporterDaemonBuildVersion) git.reporterDaemonBuildVersion = reporterDaemonBuildVersion;
    return git;
}

/** Number of bounded retries after the initial direct-peer git probe attempt. */
const MESH_DIRECT_PROBE_MAX_RETRIES = 2;

function readMeshConnectionState(connection: Record<string, unknown> | null | undefined): string | undefined {
    return readStringValue((connection as any)?.state);
}

// Fail-loud (but throttled) trace for the degraded-warmup case: a direct-peer mesh
// dispatch ran with NO live connection getter wired. This is a misconfiguration in a
// P2P-capable daemon (the getter should be present), and the old `() => true`
// fallback hid it while silently re-introducing the cold-open false-timeout. Warn
// once per peer so the degrade is visible without flooding the log on every probe.
const meshWarmupGetterMissingWarned = new Set<string>();
function warnMeshWarmupGetterMissingOnce(daemonId: string): void {
    if (meshWarmupGetterMissingWarned.has(daemonId)) return;
    meshWarmupGetterMissingWarned.add(daemonId);
    LOG.warn('Mesh', `Mesh peer connection getter unavailable for ${String(daemonId).slice(0, 12)}; warmup deadline degraded to the combined connect+response window (cannot observe DataChannel open). This avoids a cold-open false-timeout but loses warm/cold precision — wire getMeshPeerConnectionStatus on this daemon.`);
}

/**
 * Connection states that mean the peer is definitively NOT reachable right now —
 * an offline machine (no peer entry at all) or a transport that has dropped
 * (failed/closed/disconnected). Probing such a peer would just burn the full
 * MESH_DIRECT_PROBE_TIMEOUT_MS window before timing out, so the cold-open of the
 * mesh graph stalls 25s behind one powered-off node. `connecting` is deliberately
 * NOT here: a peer mid-handshake may complete during the probe window, so it still
 * gets its attempt. Held standing git truth is consulted by the caller BEFORE this
 * runs, so the invariant "connected+held is never unavailable" is untouched — this
 * only short-circuits a peer that has no usable transport to probe over.
 */
function isMeshConnectionDefinitivelyDown(
    connection: Record<string, unknown> | null | undefined,
): boolean {
    if (!connection) return true;
    const state = readMeshConnectionState(connection);
    return state === 'failed' || state === 'closed' || state === 'disconnected';
}

/**
 * Probe a remote peer's git_status with a bounded retry budget, but only while
 * the peer is reported `connected`. A single slow (often TURN-relayed) peer can
 * exceed one probe window; retrying — with the connection re-checked before each
 * attempt so we abandon a peer that dropped — recovers it without blocking the
 * mesh forever. Shared by the bootstrap hydrate path and the per-node render
 * path so both treat a connected-but-slow peer identically.
 *
 * Returns the git status on success, or null if every attempt failed/timed out
 * (caller decides how to classify). `getConnection` is consulted before each
 * attempt; a non-`connected` state short-circuits the retry loop (the very first
 * attempt always runs so a missing connection getter still gets one try).
 */
export async function probeRemoteMeshGitStatusWithRetry(args: {
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    daemonId: string;
    workspace: string;
    timeoutMs: number;
    /** Per-attempt timeout for retries (attempts > 0); defaults to timeoutMs. */
    retryTimeoutMs?: number;
    /** Cold-open warmup budget per attempt; defaults to MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS. */
    connectTimeoutMs?: number;
    getConnection?: (daemonId: string) => Record<string, unknown> | null;
    onConnection?: (connection: Record<string, unknown>) => void;
}): Promise<Record<string, unknown> | null> {
    // Fast-fail an offline / dropped peer BEFORE the first attempt. Previously the
    // liveness re-check only ran *between* attempts, so a powered-off node still ate
    // the full first MESH_DIRECT_PROBE_TIMEOUT_MS (25s) window — stalling the mesh
    // graph cold-open behind one dead machine. If a connection getter is wired and
    // it reports the peer as definitively down (no peer entry / failed / closed /
    // disconnected), skip straight to "no truth" instead of awaiting a 25s timeout.
    // A `connecting` peer still gets its attempt (it may complete mid-probe). No
    // onConnection side effect here: this is a pure liveness gate, and the caller's
    // own connection read already seeds status.connection — only the between-attempt
    // path needs to surface a freshly-observed connection.
    if (args.getConnection && isMeshConnectionDefinitivelyDown(args.getConnection(args.daemonId))) {
        return null;
    }
    for (let attempt = 0; attempt <= MESH_DIRECT_PROBE_MAX_RETRIES; attempt += 1) {
        if (attempt > 0) {
            // Re-check liveness before spending another probe window; a peer that
            // dropped between attempts is not worth retrying.
            const connection = args.getConnection?.(args.daemonId);
            if (args.getConnection && readMeshConnectionState(connection) !== 'connected') break;
            if (connection) args.onConnection?.(connection);
            // Exponential backoff: 250ms, 500ms before attempts 1 and 2.
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        }
        try {
            const remoteGit = await probeRemoteMeshGitStatus({
                dispatchMeshCommand: args.dispatchMeshCommand,
                daemonId: args.daemonId,
                workspace: args.workspace,
                responseTimeoutMs: attempt === 0 ? args.timeoutMs : (args.retryTimeoutMs ?? args.timeoutMs),
                connectTimeoutMs: args.connectTimeoutMs ?? MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS,
                getConnection: args.getConnection,
            });
            if (remoteGit) return remoteGit;
        } catch {
            // Timed out or P2P error — fall through to the next bounded attempt.
        }
    }
    return null;
}

export async function hydrateInlineMeshDirectTruth(args: {
    mesh: any;
    meshSource: 'inline_cache' | 'inline_bootstrap' | 'local_config';
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
    statusInstanceId?: string;
    localMachineId?: string;
    // Standing-state model: the default (non-refresh) bootstrap load must NOT
    // fan out a blocking git_status probe to every peer — a single slow
    // (TURN-relayed) peer would time out and mark the whole mesh unavailable,
    // blocking the graph. When false, a non-local node is satisfied from its
    // held standing git truth (lastGit / cachedStatus reflected via mesh
    // events) and is never pushed to unavailableNodeIds merely because no live
    // probe was attempted. Only an explicit refresh (probeRemotePeers=true)
    // performs the fan-out and classifies an unreachable peer as unavailable.
    probeRemotePeers: boolean;
    // Optional shared probe cache: dedups concurrent probes and reuses a
    // recently-probed peer's result instead of re-issuing a blocking
    // refreshUpstream probe within the reuse window.
    probeCache?: MeshGitProbeCache;
}): Promise<{
    directEvidenceCount: number;
    localConfirmedCount: number;
    peerAttemptedCount: number;
    peerConfirmedCount: number;
    standingEvidenceCount: number;
    unavailableNodeIds: string[];
    deadNodeIds: string[];
}> {
    const nodes = Array.isArray(args.mesh?.nodes) ? args.mesh.nodes : [];
    if (!nodes.length) {
        return {
            directEvidenceCount: 0,
            localConfirmedCount: 0,
            peerAttemptedCount: 0,
            peerConfirmedCount: 0,
            standingEvidenceCount: 0,
            unavailableNodeIds: [],
            deadNodeIds: [],
        };
    }

    const selectedCoordinatorNodeId = readStringValue(
        args.mesh?.coordinator?.preferredNodeId,
        nodes[0]?.id,
        nodes[0]?.nodeId,
    );

    let localConfirmedCount = 0;
    let peerAttemptedCount = 0;
    let peerConfirmedCount = 0;
    let standingEvidenceCount = 0;
    const unavailableNodeIds: string[] = [];
    const deadNodeIds: string[] = [];

    // Each node's classification (local git probe, standing truth, or the remote
    // P2P fan-out) is independent, so probing them serially stacked one slow
    // (often TURN-relayed) peer's latency onto every other node — the 3×25s serial
    // stall. Classify all nodes concurrently via Promise.allSettled; each node has
    // its own bounded per-peer timeout + definitively-down fast-fail inside
    // probeRemoteMeshGitStatusWithRetry, so a hung peer degrades to `unavailable`
    // for THAT node only and never blocks the aggregate. The counters and
    // unavailable/dead node lists are folded from the settled results afterward so
    // no shared mutable state is touched concurrently.
    type NodeTruthResult =
        | { kind: 'dead'; nodeId: string }
        | { kind: 'unavailable'; nodeId: string; attempted?: boolean }
        | { kind: 'local' }
        | { kind: 'standing' }
        | { kind: 'peerConfirmed' }
        | { kind: 'peerUnavailable'; nodeId: string }
        | { kind: 'skip' };

    const classifyNode = async (nodeIndex: number, node: any): Promise<NodeTruthResult> => {
        const nodeId = normalizeMeshNodeId(node) || `node_${nodeIndex}`;
        const workspace = readStringValue(node?.workspace);
        const daemonId = readStringValue(node?.daemonId);
        const isSelfNode = Boolean(
            nodeId && selectedCoordinatorNodeId && daemonIdsEquivalent(nodeId, selectedCoordinatorNodeId),
        ) || Boolean(
            daemonId && (daemonIdsEquivalent(daemonId, args.localMachineId) || daemonIdsEquivalent(daemonId, args.statusInstanceId)),
        ) || Boolean(args.meshSource !== 'local_config' && nodeIndex === 0);

        // A dead local worktree owned by this coordinator (isLocalWorktree, the
        // node's daemon is us, workspace path gone) has no live truth and cannot
        // be probed — the directory it would self-probe no longer exists. Exclude
        // it entirely from direct-peer-truth accounting: do not probe it, do not
        // attempt it, do not push it to unavailableNodeIds (which would otherwise
        // wedge the graph in a permanent direct_peer_truth_unavailable). This is
        // strictly self + isLocalWorktree + absent-path; remote peers and nodes
        // whose workspace still exists are unaffected and stay classifiable.
        const isSelfDaemonNode = Boolean(
            daemonId && (daemonIdsEquivalent(daemonId, args.localMachineId) || daemonIdsEquivalent(daemonId, args.statusInstanceId)),
        );
        if ((isSelfNode || isSelfDaemonNode) && isDeadLocalWorktreeNode(node)) {
            return { kind: 'dead', nodeId };
        }

        if (!workspace) {
            return (!isSelfNode && daemonId) ? { kind: 'unavailable', nodeId } : { kind: 'skip' };
        }

        if (fs.existsSync(workspace)) {
            try {
                // Route the local probe through the shared cache so the per-node
                // render loop's getGitRepoStatus for the same workspace reuses this
                // exact result instead of re-shelling ~14 git processes when the two
                // passes straddle the getGitRepoStatus 1.5s TTL.
                const runLocalProbe = () => getGitRepoStatus(workspace, { timeoutMs: 10_000, refreshUpstream: true }) as unknown as Promise<Record<string, unknown> | null>;
                const localGit = args.probeCache
                    ? await args.probeCache.probeLocal(workspace, runLocalProbe)
                    : await runLocalProbe();
                if (localGit?.isGitRepo) {
                    const reporter = recordInlineMeshDirectGitTruth(node, localGit as unknown as Record<string, unknown>, 'selected_coordinator_local_git');
                    persistNodeReporterPlatform(args.meshSource, args.mesh, nodeId, reporter);
                    return { kind: 'local' };
                }
            } catch {
                // Fall through to remote classification.
            }
        }

        // Standing-state first: a non-local peer's held git truth (reflected
        // from its self-emitted mesh events into node.lastGit / cachedStatus)
        // counts as direct evidence without any probe. On the default load this
        // is the ONLY thing we consult — no fan-out, so one slow peer can't
        // block the bootstrap.
        const standingGit = buildInlineMeshTransitGitStatus(node);
        if (standingGit) {
            return { kind: 'standing' };
        }

        if (!args.probeRemotePeers) {
            // Default (non-refresh) load: a peer with no held truth yet is left
            // pending (the per-node loop marks it gitProbePending and the graph
            // shows setup inventory for it). It is NOT unavailable — the graph
            // must still render. An explicit refresh will fan out and freshen it.
            return { kind: 'skip' };
        }

        if (!daemonId || !args.dispatchMeshCommand) {
            return !isSelfNode ? { kind: 'unavailable', nodeId } : { kind: 'skip' };
        }

        // Bounded retry, gated on the peer staying `connected`: a slow
        // (TURN-relayed) peer that just exceeds one probe window is recovered
        // instead of being hard-failed. The connection is re-checked before each
        // retry so a peer that actually dropped is abandoned promptly. Routed
        // through the shared probe cache so a refresh burst reuses a recent
        // result / shares an in-flight probe instead of storming the peer.
        const runProbe = () => probeRemoteMeshGitStatusWithRetry({
            dispatchMeshCommand: args.dispatchMeshCommand,
            daemonId,
            workspace,
            timeoutMs: MESH_DIRECT_PROBE_TIMEOUT_MS,
            retryTimeoutMs: MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS,
            connectTimeoutMs: MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS,
            getConnection: args.getMeshPeerConnectionStatus,
        });
        const remoteGit = args.probeCache
            ? await args.probeCache.probe(daemonId, workspace, runProbe)
            : await runProbe();
        if (remoteGit) {
            const reporter = recordInlineMeshDirectGitTruth(node, remoteGit, 'selected_coordinator_mesh_p2p_git');
            persistNodeReporterPlatform(args.meshSource, args.mesh, nodeId, reporter);
            return { kind: 'peerConfirmed' };
        }

        // Invariant: a connected peer that still holds standing git truth is
        // never classified unavailable (standingGit short-circuited above, so by
        // here there is no held truth). Only push to unavailable when the peer is
        // not currently connected, or it is connected but every bounded probe
        // failed — that is the genuine "connected, no truth, retries exhausted"
        // case that drives the explicit-refresh hard-fail.
        return { kind: 'peerUnavailable', nodeId };
    };

    const nodeEntries = [...nodes.entries()];
    const settledResults = await Promise.allSettled(
        nodeEntries.map(([nodeIndex, node]) => classifyNode(nodeIndex, node)),
    );
    settledResults.forEach((settled, i) => {
        const [nodeIndex, node] = nodeEntries[i];
        // A classifier should never reject (every probe is caught internally), but
        // if one does, degrade that node to `unavailable` when it is a remote peer —
        // never silently drop it, never fail the whole aggregate.
        const result: NodeTruthResult = settled.status === 'fulfilled'
            ? settled.value
            : (() => {
                const nodeId = normalizeMeshNodeId(node) || `node_${nodeIndex}`;
                const daemonId = readStringValue(node?.daemonId);
                const isSelfNode = Boolean(
                    nodeId && selectedCoordinatorNodeId && daemonIdsEquivalent(nodeId, selectedCoordinatorNodeId),
                ) || Boolean(
                    daemonId && (daemonIdsEquivalent(daemonId, args.localMachineId) || daemonIdsEquivalent(daemonId, args.statusInstanceId)),
                );
                return (!isSelfNode && daemonId) ? { kind: 'unavailable', nodeId } as NodeTruthResult : { kind: 'skip' } as NodeTruthResult;
            })();
        switch (result.kind) {
            case 'dead':
                deadNodeIds.push(result.nodeId);
                break;
            case 'unavailable':
                unavailableNodeIds.push(result.nodeId);
                break;
            case 'local':
                localConfirmedCount += 1;
                break;
            case 'standing':
                standingEvidenceCount += 1;
                break;
            case 'peerConfirmed':
                peerAttemptedCount += 1;
                peerConfirmedCount += 1;
                break;
            case 'peerUnavailable':
                peerAttemptedCount += 1;
                unavailableNodeIds.push(result.nodeId);
                break;
            case 'skip':
            default:
                break;
        }
    });

    return {
        directEvidenceCount: localConfirmedCount + peerConfirmedCount + standingEvidenceCount,
        localConfirmedCount,
        peerAttemptedCount,
        peerConfirmedCount,
        standingEvidenceCount,
        unavailableNodeIds,
        deadNodeIds,
    };
}

export function summarizeMeshSessionRecord(record: any): Record<string, unknown> {
    const meta = readObjectRecord(record?.meta);
    const isSelfCoordinator = Boolean(readStringValue(meta.meshCoordinatorFor));
    const chatStatus = readStringValue(record?.chatStatus, record?.activeChat?.status, meta.chatStatus, meta.sessionStatus);
    const state = readLiveMeshSessionState(record);
    const statusNote = isSelfCoordinator && (!chatStatus || chatStatus === 'idle' || state === 'idle')
        ? 'Coordinator self status is sampled from the session host and may read idle while the coordinator is generating this response.'
        : null;
    return {
        sessionId: readStringValue(record?.sessionId) || 'unknown',
        providerType: readStringValue(record?.providerType),
        state,
        chatStatus,
        lifecycle: readStringValue(record?.lifecycle),
        surfaceKind: getSessionHostSurfaceKind(record as any),
        recoveryState: readStringValue(meta.runtimeRecoveryState) ?? null,
        workspace: readStringValue(record?.workspace) ?? null,
        title: readStringValue(record?.displayName, record?.workspaceLabel) ?? null,
        role: isSelfCoordinator ? 'coordinator' : readStringValue(meta.meshRole, meta.role) ?? null,
        isSelfCoordinator,
        statusNote,
        createdAt: toIsoTimestamp(record?.createdAt ?? record?.created_at),
        startedAt: toIsoTimestamp(record?.startedAt ?? record?.started_at ?? record?.spawnedAtMs ?? record?.spawned_at_ms),
        lastActivityAt: toIsoTimestamp(record?.updatedAt ?? record?.lastActivityAt ?? record?.last_activity_at),
        isCached: false,
    };
}

function liveSessionRecordMatchesMeshNode(record: any, meshId: string, nodeId: string, nodeWorkspace = '', nodeIsMissingLocalWorktree = false): boolean {
    const recordNodeId = readStringValue(record?.meta?.meshNodeId);
    // A session's stamped meshNodeId and the node's id can carry interchangeable
    // daemon-id forms (bare `mach_X` vs `daemon_mach_X`) — compare under the
    // canonical machine core, not raw `!==` (CANON-IDENTITY class).
    if (!recordNodeId || !daemonIdsEquivalent(recordNodeId, nodeId)) return false;
    if (nodeIsMissingLocalWorktree) return false;
    const recordWorkspace = readStringValue(record?.workspace);
    // Normalized compare (shared WTCLAIM rule): a base node and a co-located worktree
    // clone differ ONLY by workspace root, so a separator/case-skewed exact compare
    // could wrongly keep a sibling worktree's session attached to this node.
    if (nodeWorkspace && recordWorkspace && !meshWorkspacesEquivalent(recordWorkspace, nodeWorkspace)) return false;
    const recordMeshId = readStringValue(record?.meta?.meshNodeFor);
    return !recordMeshId || recordMeshId === meshId;
}

function liveSessionRecordMatchesMeshWorkspace(record: any, meshId: string, workspace: string): boolean {
    const recordWorkspace = readStringValue(record?.workspace);
    if (!recordWorkspace || !workspace || !meshWorkspacesEquivalent(recordWorkspace, workspace)) return false;

    const recordMeshId = readStringValue(record?.meta?.meshNodeFor);
    if (recordMeshId) return recordMeshId === meshId;

    return record?.meta?.launchedByCoordinator === true || !!readStringValue(record?.meta?.meshNodeId);
}

export function readLiveMeshNodeWorkspace(args: {
    meshId: string;
    nodeId: string;
    liveSessionRecords: any[];
    allowCoordinatorSession?: boolean;
}): string {
    const directNodeWorkspace = args.liveSessionRecords.find((record) => (
        liveSessionRecordMatchesMeshNode(record, args.meshId, args.nodeId)
        && readStringValue(record?.workspace)
    ));
    if (directNodeWorkspace) {
        return readStringValue(directNodeWorkspace.workspace) || '';
    }

    if (args.allowCoordinatorSession) {
        const coordinatorWorkspace = args.liveSessionRecords.find((record) => (
            readStringValue(record?.meta?.meshCoordinatorFor) === args.meshId
            && readStringValue(record?.workspace)
        ));
        if (coordinatorWorkspace) {
            return readStringValue(coordinatorWorkspace.workspace) || '';
        }
    }

    return '';
}

export function collectLiveMeshSessionRecords(args: {
    meshId: string;
    node: any;
    nodeId: string;
    liveSessionRecords: any[];
    allowCoordinatorSession?: boolean;
}): any[] {
    const nodeWorkspace = readStringValue(args.node?.workspace);
    const nodeIsMissingLocalWorktree = args.node?.isLocalWorktree === true
        && !!nodeWorkspace
        && !fs.existsSync(nodeWorkspace);
    const matches = args.liveSessionRecords.filter((record) => {
        const recordNodeId = readStringValue(record?.meta?.meshNodeId);
        if (recordNodeId && !daemonIdsEquivalent(recordNodeId, args.nodeId)) return false;
        if (liveSessionRecordMatchesMeshNode(record, args.meshId, args.nodeId, nodeWorkspace || '', nodeIsMissingLocalWorktree)) return true;
        if (nodeIsMissingLocalWorktree) return false;
        return !!nodeWorkspace && liveSessionRecordMatchesMeshWorkspace(record, args.meshId, nodeWorkspace);
    });

    if (args.allowCoordinatorSession) {
        for (const record of args.liveSessionRecords) {
            if (readStringValue(record?.meta?.meshCoordinatorFor) !== args.meshId) continue;
            const sessionId = readStringValue(record?.sessionId);
            if (sessionId && matches.some((entry) => sessionIdsEquivalent(readStringValue(entry?.sessionId), sessionId))) continue;
            matches.push(record);
        }
    }

    return matches;
}

export function buildHistoricalMeshSessions(args: {
    meshId: string;
    nodes: any[];
    liveSessionRecords: any[];
}): { count: number; sessions: Record<string, unknown>[]; instruction: string } | undefined {
    const liveNodeIds = new Set<string>();
    const liveWorkspaces = new Set<string>();
    const missingLocalWorktreeNodeIds = new Set<string>();
    for (const node of args.nodes || []) {
        const nodeId = normalizeMeshNodeId(node);
        const workspace = readStringValue(node?.workspace);
        if (nodeId) liveNodeIds.add(nodeId);
        if (workspace) liveWorkspaces.add(workspace);
        if (nodeId && node?.isLocalWorktree === true && workspace && !fs.existsSync(workspace)) {
            missingLocalWorktreeNodeIds.add(nodeId);
        }
    }

    const sessions: Record<string, unknown>[] = [];
    for (const record of args.liveSessionRecords || []) {
        const meta = readObjectRecord(record?.meta);
        const recordMeshId = readStringValue(meta.meshNodeFor, meta.meshCoordinatorFor);
        if (recordMeshId !== args.meshId) continue;
        const recordNodeId = readStringValue(meta.meshNodeId);
        const workspace = readStringValue(record?.workspace);
        const removedNode = !!recordNodeId && (!liveNodeIds.has(recordNodeId) || missingLocalWorktreeNodeIds.has(recordNodeId));
        const orphanedWorkspace = !!workspace && !liveWorkspaces.has(workspace) && meta.meshCoordinatorFor !== args.meshId;
        if (!removedNode && !orphanedWorkspace) continue;
        sessions.push({
            ...summarizeMeshSessionRecord(record),
            classification: removedNode ? 'removedNode' : 'orphanedSession',
            historical: true,
            meshNodeId: recordNodeId || null,
            reason: removedNode
                ? 'Session is tagged to a mesh node that is no longer in live membership.'
                : 'Session workspace is no longer attached to a live mesh node.',
        });
    }
    if (sessions.length === 0) return undefined;
    return {
        count: sessions.length,
        sessions: sessions.slice(0, 5),
        instruction: 'These sessions are separated from normal node activeSessions because their mesh node/workspace is no longer live. Use mesh_cleanup_sessions only if cleanup is intended.',
    };
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

export async function resolveProviderTypeFromPriority(args: {
    nodeId: string;
    providerPriority: string[];
    providerLoader: ProviderLoader;
    onStatusChange?: () => void;
}): Promise<{ providerType?: string; error?: string }> {
    if (!args.providerPriority.length) {
        return { error: `Node '${args.nodeId}' has no providerPriority policy; pass cliType explicitly or configure node.policy.providerPriority` };
    }

    const failed: string[] = [];
    for (const requestedType of args.providerPriority) {
        const normalizedType = args.providerLoader.resolveAlias(requestedType);
        if (!args.providerLoader.isMachineProviderEnabled(normalizedType)) {
            failed.push(`${requestedType}: disabled`);
            continue;
        }
        const detected = await detectCLI(normalizedType, args.providerLoader, { includeVersion: false });
        args.providerLoader.setCliDetectionResults([{
            id: normalizedType,
            installed: !!detected,
            path: detected?.path,
        }], false);
        args.onStatusChange?.();
        if (detected) return { providerType: normalizedType };
        failed.push(`${requestedType}: not detected`);
    }

    return { error: `No usable provider detected for node '${args.nodeId}' from providerPriority: ${failed.join('; ')}` };
}
