/**
 * DaemonCommandRouter — Unified command routing for daemon-level commands
 *
 * Unified command routing for daemon-level commands.
 *
 * Routing flow:
 *   1. Daemon-level commands (launch_ide, stop_ide, restart_ide, etc.) → handled here
 *   2. CLI/ACP commands → delegated to cliManager
 *   3. Everything else → delegated to commandHandler.handle()
 */

import { DaemonCdpManager } from '../cdp/manager.js';
import { registerExtensionProviders } from '../cdp/setup.js';
import { DaemonCommandHandler } from './handler.js';
import { lowFamilyRegistry } from './low-family/index.js';
import { medFamilyRegistry } from './med-family/index.js';
import { launchIde } from './med-family/ide.js';
import type { MedFamilyContext } from './med-family/index.js';
import { highFamilyRegistry } from './high-family/index.js';
import type { HighFamilyContext } from './high-family/index.js';
import { DaemonCliManager } from './cli-manager.js';
import { supportsExplicitSessionResume } from './cli-manager.js';
import type { HostedCliRuntimeDescriptor } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { launchWithCdp, killIdeProcess, isIdeRunning } from '../launch.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { resolveIdeLaunchWorkspace } from '../config/workspaces.js';
import { appendRecentActivity, getRecentActivity } from '../config/recent-activity.js';
import { getSavedProviderSessions } from '../config/saved-sessions.js';
import { listProviderHistorySessions } from '../config/chat-history.js';
import { detectIDEs } from '../detection/ide-detector.js';
import { detectCLI, detectCLIs } from '../detection/cli-detector.js';
import { getGitRepoStatus } from '../git/git-status.js';
import {
    CHANGE_IMPACT_CONFIG_LOCATIONS,
    CHANGE_IMPACT_CONFIG_SCHEMA,
    loadChangeImpactConfig,
    suggestChangeImpactConfig,
    validateChangeImpactConfig,
} from '../git/change-impact-config.js';
import {
    normalizeGitStatus as sharedNormalizeGitStatus,
    pickBestTransitGitStatus as sharedPickBestTransitGitStatus,
    summarizeGitShape as sharedSummarizeGitShape,
    normalizeMeshNodeId,
    meshNodeIdMatches,
    daemonIdsEquivalent,
} from '@adhdev/mesh-shared';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { logCommand } from '../logging/command-log.js';
import type { CommandLogEntry } from '../logging/command-log.js';
import * as yaml from 'js-yaml';
import { createInteractionId, recordDebugTrace } from '../logging/debug-trace.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../mesh/mesh-events.js';
import { buildMeshWorkerRelayStamp } from '../mesh/mesh-events-utils.js';
import { buildMeshHostRequiredFailure, resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { fastForwardMeshNode } from '../mesh/mesh-fast-forward.js';
import { analyzeMeshRefineNodeChangeArea, orderMeshRefineBatchNodes } from '../mesh/mesh-refine-batch.js';
import {
    MESH_REFINE_CONFIG_LOCATIONS,
    MESH_REFINE_CONFIG_SCHEMA,
    loadMeshRefineConfig,
    resolveMeshRefineValidationPlan,
    suggestMeshRefineConfig,
    validateMeshRefineConfig,
    type MeshRefineValidationCommandPlan,
} from '../mesh/refine-config.js';
import {
    MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS,
    MESH_WORKTREE_BOOTSTRAP_CONFIG_SCHEMA,
    evaluateWorktreeBootstrapState,
    loadMeshWorktreeBootstrapConfig,
    runMeshWorktreeBootstrap,
    type WorktreeBootstrapState,
} from '../mesh/worktree-bootstrap-config.js';
import { runMeshInit } from '../mesh/mesh-init.js';
import { getMeshQueueRevision } from '../mesh/mesh-work-queue.js';
import type { RepoMeshSessionCleanupMode } from '../repo-mesh-types.js';
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';
import { homedir, hostname as osHostname } from 'os';
import { basename as pathBasename, join as pathJoin, resolve as pathResolve } from 'path';
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import { workingDirBasename } from '../providers/working-dir.js';
import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';

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

function readMeshNodeDaemonId(node: Record<string, unknown>): string | undefined {
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

function shouldRefreshStalePendingAggregate(snapshot: any, options?: { requireDirectPeerTruth?: boolean }): boolean {
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
): { reporterPlatform: string | null; reporterArch: string | null } {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return { reporterPlatform: null, reporterArch: null };
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
    return { reporterPlatform, reporterArch };
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
    reporter: { reporterPlatform: string | null; reporterArch: string | null },
): void {
    if (meshSource !== 'local_config') return;
    const meshId = readStringValue(mesh?.id);
    if (!meshId || !nodeId) return;
    const reportedPlatform = reporter.reporterPlatform ?? undefined;
    const reportedArch = reporter.reporterArch ?? undefined;
    if (!reportedPlatform && !reportedArch) return;
    void import('../config/mesh-config.js')
        .then(({ updateNode }) => updateNode(meshId, nodeId, { reportedPlatform, reportedArch }))
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

function inlineMeshCarriesTransientNodeTruth(inlineMesh: any): boolean {
    if (!inlineMesh || typeof inlineMesh !== 'object' || Array.isArray(inlineMesh)) return false;
    if (!Array.isArray(inlineMesh.nodes) || inlineMesh.nodes.length === 0) return false;
    return inlineMesh.nodes.some((node: any) => hasInlineMeshTransientNodeState(node));
}

function readInlineMeshNodeId(node: any): string {
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
function isDeadLocalWorktreeNode(node: any): boolean {
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
function foldMeshNodeIdentityToCanonical(node: any): any {
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
    if (node.id === canonical && node.nodeId === canonical && node.node_id === undefined) return node;
    node.id = canonical;
    node.nodeId = canonical;
    if ('node_id' in node) delete node.node_id;
    return node;
}

function normalizeInlineMeshNodeIdentity(inlineMesh: any): any {
    if (!inlineMesh || typeof inlineMesh !== 'object' || Array.isArray(inlineMesh)) return inlineMesh;
    if (!Array.isArray(inlineMesh.nodes) || inlineMesh.nodes.length === 0) return inlineMesh;
    // Fold each node IN PLACE so the mesh object and its nodes array keep their
    // identity — sanitizeInlineMesh and the cache-sharing callers depend on
    // unchanged inputs returning the same reference.
    for (const node of inlineMesh.nodes) foldMeshNodeIdentityToCanonical(node);
    return inlineMesh;
}

function sanitizeInlineMesh(inlineMesh: any): any {
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

function reconcileInlineMeshCache(cached: any, incoming: any): any {
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

function readCachedInlineMeshActiveSessions(node: any): string[] {
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
function collectMeshNodeHostedSessionIds(node: any): Set<string> {
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

export function finalizeMeshNodeStatus(args: {
    status: Record<string, unknown>;
    node: any;
    daemonId?: string;
    isSelfNode: boolean;
}): void {
    const { status, node, daemonId, isSelfNode } = args;
    if (!readStringValue(status.machineStatus)) {
        const cachedStatus = readObjectRecord(node?.cachedStatus);
        const machineStatus = readStringValue(cachedStatus.machineStatus, cachedStatus.machine_status, node?.machineStatus);
        if (machineStatus) status.machineStatus = machineStatus;
    }
    synthesizeMeshNodeFreshnessFromConnection(status);
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

// Reads a positive integer timeout (ms) from an env var, clamped to [1s, 120s];
// falls back to the default when unset or out of range. Lets slow cross-machine
// peers (e.g. a TURN-relayed Windows daemon whose git_status RTT is 10-18s) be
// tuned without a rebuild.
function readMeshTimeoutEnvMs(name: string, defaultMs: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return defaultMs;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000) return parsed;
    return defaultMs;
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
export const MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS', 45_000);
// How long a successful per-peer git_status probe stays fresh enough to be
// reused instead of issuing another blocking `refreshUpstream:true` fan-out.
// A slow (TURN-relayed) peer's probe can take 9-23s, and the dashboard's
// auto-retry loop re-fires every few seconds; without this gate every retry
// would start a brand new probe storm to the same peer. Within this window the
// last successful result is reused so a refresh quiesces instead of looping.
// Min-clamped to 1s by readMeshTimeoutEnvMs; raise via env for very slow peers.
const MESH_DIRECT_PROBE_REUSE_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_REUSE_MS', 12_000);

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

/**
 * Await `work` under a warmup-aware deadline so a cold-open DataChannel handshake
 * is NOT charged against the command response budget — the root cause of the
 * "first mesh probe to a cold peer false-times-out, the warm retry succeeds"
 * signature. Two budgets, switched by the live peer connection state:
 *
 *  - While `isConnected()` returns false the peer's channel is still opening; the
 *    cold-open `connectTimeoutMs` budget applies. This phase is deliberately
 *    generous because a TURN-relayed cross-machine handshake legitimately needs
 *    many seconds — but a genuine connect *failure* is surfaced by `work`
 *    rejecting on its own (the mesh manager fails the peer the instant its
 *    PeerConnection state goes terminal), so a real failure is never masked for
 *    the whole window.
 *  - The first time `isConnected()` returns true the channel is warm; from that
 *    instant the tight `responseTimeoutMs` governs how long the handler may take.
 *    Warm-channel callers therefore see behavior identical to the old single
 *    `Promise.race(work, responseTimeoutMs)`.
 *
 * Rejects with `Error('timeout')` when either budget is exhausted, mirroring the
 * previous single-race contract. Pure except for timers + the injected
 * `isConnected` probe, so it is unit-testable under fake timers without any real
 * WebRTC. When no connection getter is wired `isConnected` should be `() => true`
 * (the caller's choice) so the response deadline governs from t0 — the legacy
 * single-budget behavior, never a combined connect+response window.
 */
export function awaitWithWarmupDeadline<T>(
    work: Promise<T>,
    opts: {
        isConnected: () => boolean;
        connectTimeoutMs: number;
        responseTimeoutMs: number;
        pollIntervalMs?: number;
    },
): Promise<T> {
    const pollMs = Math.max(1, Math.min(opts.pollIntervalMs ?? 200, opts.connectTimeoutMs));
    return new Promise<T>((resolve, reject) => {
        let done = false;
        let poll: ReturnType<typeof setInterval> | undefined;
        let responseTimer: ReturnType<typeof setTimeout> | undefined;
        const startedAt = Date.now();
        const cleanup = () => {
            if (poll) { clearInterval(poll); poll = undefined; }
            if (responseTimer) { clearTimeout(responseTimer); responseTimer = undefined; }
        };
        const settle = (fn: () => void) => {
            if (done) return;
            done = true;
            cleanup();
            fn();
        };
        // Arm the response deadline exactly once, the moment the channel is warm.
        const armResponse = () => {
            if (responseTimer || done) return;
            responseTimer = setTimeout(
                () => settle(() => reject(new Error('timeout'))),
                opts.responseTimeoutMs,
            );
            if (typeof responseTimer.unref === 'function') responseTimer.unref();
        };
        const onPoll = () => {
            if (done) return;
            if (opts.isConnected()) {
                if (poll) { clearInterval(poll); poll = undefined; }
                armResponse();
                return;
            }
            if (Date.now() - startedAt >= opts.connectTimeoutMs) {
                settle(() => reject(new Error('timeout')));
            }
        };
        if (opts.isConnected()) {
            // Already warm (e.g. a retry over an open channel) — skip the warmup
            // phase entirely and let the response deadline govern from t0.
            armResponse();
        } else {
            poll = setInterval(onPoll, pollMs);
            if (typeof poll.unref === 'function') poll.unref();
        }
        work.then(
            (val) => settle(() => resolve(val)),
            (err) => settle(() => reject(err)),
        );
    });
}

async function probeRemoteMeshGitStatus(args: {
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    daemonId: string;
    workspace: string;
    // Response deadline — applies only once the peer's DataChannel is open (warm).
    responseTimeoutMs: number;
    // Cold-open warmup budget — applies only while the channel is still opening.
    connectTimeoutMs: number;
    // Live peer connection snapshot getter; lets the deadline tell "still warming
    // up" apart from "warm but slow". Absent → behave as if always warm (the
    // response deadline governs from t0, i.e. the legacy single-budget behavior).
    getConnection?: (daemonId: string) => Record<string, unknown> | null;
}): Promise<Record<string, unknown> | null> {
    if (!args.dispatchMeshCommand) return null;
    // Fire the dispatch first — this is what drives the mesh manager to ensure /
    // open the peer connection. The warmup-aware deadline then charges the
    // cold-open handshake to the connect budget and only the warm round trip to
    // the response budget, so the first probe to a cold peer is no longer
    // false-timed-out before its channel has even opened.
    const dispatch = args.dispatchMeshCommand(args.daemonId, 'git_status', { workspace: args.workspace, refreshUpstream: true });
    const getConnection = args.getConnection;
    const isConnected = getConnection
        ? () => readMeshConnectionState(getConnection(args.daemonId)) === 'connected'
        : () => true;
    const remoteResult = await awaitWithWarmupDeadline(dispatch, {
        isConnected,
        connectTimeoutMs: args.connectTimeoutMs,
        responseTimeoutMs: args.responseTimeoutMs,
    }) as any;
    const remoteGit = remoteResult?.status ?? remoteResult?.git ?? remoteResult;
    if (!remoteGit || typeof remoteGit !== 'object' || typeof remoteGit.isGitRepo !== 'boolean') return null;
    // The member daemon stamps its own platform/arch onto the git_status result
    // envelope (see git-commands.ts). Reflect them onto the returned git object
    // under non-colliding reporter* keys so recordInlineMeshDirectGitTruth can
    // persist them to node.userOverrides without touching the git status shape.
    const reporterPlatform = readStringValue(remoteResult?.reporterPlatform);
    const reporterArch = readStringValue(remoteResult?.reporterArch);
    const git = remoteGit as Record<string, unknown>;
    if (reporterPlatform) git.reporterPlatform = reporterPlatform;
    if (reporterArch) git.reporterArch = reporterArch;
    return git;
}

/** Number of bounded retries after the initial direct-peer git probe attempt. */
const MESH_DIRECT_PROBE_MAX_RETRIES = 2;

function readMeshConnectionState(connection: Record<string, unknown> | null | undefined): string | undefined {
    return readStringValue((connection as any)?.state);
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

    for (const [nodeIndex, node] of nodes.entries()) {
        const nodeId = normalizeMeshNodeId(node) || `node_${nodeIndex}`;
        const workspace = readStringValue(node?.workspace);
        const daemonId = readStringValue(node?.daemonId);
        const isSelfNode = Boolean(
            nodeId && selectedCoordinatorNodeId && nodeId === selectedCoordinatorNodeId,
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
            deadNodeIds.push(nodeId);
            continue;
        }

        if (!workspace) {
            if (!isSelfNode && daemonId) unavailableNodeIds.push(nodeId);
            continue;
        }

        if (fs.existsSync(workspace)) {
            try {
                const localGit = await getGitRepoStatus(workspace, { timeoutMs: 10_000, refreshUpstream: true });
                if (localGit?.isGitRepo) {
                    const reporter = recordInlineMeshDirectGitTruth(node, localGit as unknown as Record<string, unknown>, 'selected_coordinator_local_git');
                    persistNodeReporterPlatform(args.meshSource, args.mesh, nodeId, reporter);
                    localConfirmedCount += 1;
                    continue;
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
            standingEvidenceCount += 1;
            continue;
        }

        if (!args.probeRemotePeers) {
            // Default (non-refresh) load: a peer with no held truth yet is left
            // pending (the per-node loop marks it gitProbePending and the graph
            // shows setup inventory for it). It is NOT unavailable — the graph
            // must still render. An explicit refresh will fan out and freshen it.
            continue;
        }

        if (!daemonId || !args.dispatchMeshCommand) {
            if (!isSelfNode) unavailableNodeIds.push(nodeId);
            continue;
        }

        peerAttemptedCount += 1;
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
            peerConfirmedCount += 1;
            continue;
        }

        // Invariant: a connected peer that still holds standing git truth is
        // never classified unavailable (standingGit short-circuited above, so by
        // here there is no held truth). Only push to unavailable when the peer is
        // not currently connected, or it is connected but every bounded probe
        // failed — that is the genuine "connected, no truth, retries exhausted"
        // case that drives the explicit-refresh hard-fail.
        unavailableNodeIds.push(nodeId);
    }

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
    if (!recordNodeId || recordNodeId !== nodeId) return false;
    if (nodeIsMissingLocalWorktree) return false;
    const recordWorkspace = readStringValue(record?.workspace);
    if (nodeWorkspace && recordWorkspace && recordWorkspace !== nodeWorkspace) return false;
    const recordMeshId = readStringValue(record?.meta?.meshNodeFor);
    return !recordMeshId || recordMeshId === meshId;
}

function liveSessionRecordMatchesMeshWorkspace(record: any, meshId: string, workspace: string): boolean {
    const recordWorkspace = readStringValue(record?.workspace);
    if (!recordWorkspace || !workspace || recordWorkspace !== workspace) return false;

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
        if (recordNodeId && recordNodeId !== args.nodeId) return false;
        if (liveSessionRecordMatchesMeshNode(record, args.meshId, args.nodeId, nodeWorkspace || '', nodeIsMissingLocalWorktree)) return true;
        if (nodeIsMissingLocalWorktree) return false;
        return !!nodeWorkspace && liveSessionRecordMatchesMeshWorkspace(record, args.meshId, nodeWorkspace);
    });

    if (args.allowCoordinatorSession) {
        for (const record of args.liveSessionRecords) {
            if (readStringValue(record?.meta?.meshCoordinatorFor) !== args.meshId) continue;
            const sessionId = readStringValue(record?.sessionId);
            if (sessionId && matches.some((entry) => readStringValue(entry?.sessionId) === sessionId)) continue;
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
export type MeshCoordinatorConfigFormat = 'claude_mcp_json' | 'hermes_config_yaml';
type MeshRefineValidationStatus = 'passed' | 'failed' | 'skipped';
type MeshRefineValidationCommand = MeshRefineValidationCommandPlan;

type MeshRefineValidationSummary = {
    status: MeshRefineValidationStatus;
    required: true;
    commandsRun: Array<Record<string, unknown>>;
    bootstrapCommandsRun: Array<Record<string, unknown>>;
    rejectedCommands: Array<Record<string, unknown>>;
    skippedReason?: string;
    failureKind?: string;
    failureCode?: string;
    /** Human-readable cause when failureKind === 'spawn_resolution_failed' (win32 .cmd shim, etc). */
    spawnResolutionError?: string;
    timeoutMs: number;
    outputLimitBytes: number;
    configSource?: string;
    configSourceType?: string;
    suggestions?: unknown[];
    suggestedConfig?: unknown;
    /**
     * M2-3: the bootstrap stage recorded separately from validation so review
     * surfaces can distinguish environment failures from validation failures.
     *   cached — worktree_bootstrap was 'ready' (staleInputs unchanged), skipped
     *   ran    — worktree_bootstrap was stale/never-ran and re-ran successfully
     *   failed — bootstrap run failed (refine stops before validation)
     *   skipped — refine config validation.bootstrap === 'skip'
     *   legacy — deprecated validation.bootstrapCommands path was used
     *   not_configured — no bootstrap definition anywhere
     */
    bootstrap?: {
        stage: 'cached' | 'ran' | 'failed' | 'skipped' | 'legacy' | 'not_configured';
        status?: string;
        skipped?: boolean;
        configSource?: string;
        staleReason?: string;
        error?: string;
        commandsRun?: Array<Record<string, unknown>>;
    };
    /** M2-2: deprecation notices from the refine config (e.g. bootstrapCommands). */
    deprecationWarnings?: string[];
};

type MeshRefineStageStatus = 'passed' | 'failed' | 'skipped';

type MeshRefinePatchEquivalenceSummary = {
    status: MeshRefineStageStatus;
    equivalent: boolean;
    baseHead: string;
    branchHead: string;
    mergeBase?: string;
    mergedTree?: string;
    expectedPatchId?: string;
    actualPatchId?: string;
    durationMs: number;
    error?: string;
    stdout?: string;
    stderr?: string;
    actionableHint?: MeshRefineSubmoduleConflictHint;
    /**
     * Set when a `merge-tree` submodule conflict was reclassified as a trivial
     * gitlink fast-forward and the gate passed via a synthesized merge tree.
     */
    gitlinkTrivialFastForward?: {
        resolved: boolean;
        gitlinks: Array<{ path: string; baseCommit?: string; branchCommit?: string; fastForward: boolean }>;
        reason?: string;
    };
};

type MeshRefineEffectiveDiffSummary = {
    status: MeshRefineStageStatus;
    /** True when there is at least one root-tree change between base and branch (incl. gitlink bumps). */
    hasEffectiveDiff: boolean;
    baseHead: string;
    branchHead: string;
    /** Root-level paths that differ between base and branch (capped). */
    changedPaths?: string[];
    /** Submodule paths with uncommitted/divergent commits but NO committed gitlink bump in the root tree. */
    submoduleHints?: Array<{ path: string; reason: string }>;
    durationMs: number;
    error?: string;
    stdout?: string;
    stderr?: string;
};

type MeshRefineSubmoduleConflictHint = {
    kind: 'submodule_conflict';
    message: string;
    conflicts: Array<{
        path: string;
        baseCommit?: string;
        branchCommit?: string;
    }>;
    nextSteps: string[];
};

type MeshRefineSubmoduleAlignmentSummary = {
    status: 'passed' | 'failed' | 'skipped';
    changedGitlinkPaths: string[];
    outOfSyncPaths: string[];
    updatedPaths: string[];
    verifiedPaths: string[];
    durationMs: number;
    reason?: string;
    command?: string;
    error?: string;
    stdout?: string;
    stderr?: string;
};

type MeshRefineSubmoduleReachabilityEntry = {
    path: string;
    commit: string;
    reachable: boolean;
    publishRequired?: boolean;
    autoPublishAllowed?: boolean;
    autoPublishAttempted?: boolean;
    autoPublishSucceeded?: boolean;
    autoPublishVerified?: boolean;
    autoPublishRefspec?: string;
    autoPublishSkippedReason?: string;
    importedFromWorktree?: boolean;
    checkedLocal?: boolean;
    localReachable?: boolean;
    remote?: string;
    remoteUrl?: string;
    remoteReachable?: boolean;
    remoteMainBranch?: string;
    remoteMainReachable?: boolean;
    fetchedFromOrigin?: boolean;
    error?: string;
    publishStdout?: string;
    publishStderr?: string;
};

type MeshRefineSubmoduleReachabilitySummary = {
    status: MeshRefineStageStatus;
    checked: number;
    unreachable: MeshRefineSubmoduleReachabilityEntry[];
    entries: MeshRefineSubmoduleReachabilityEntry[];
    durationMs: number;
    autoPublishAllowed?: boolean;
    autoPublishPolicySource?: string;
    error?: string;
};

type MeshRefineAsyncJobStatus = 'accepted' | 'completed' | 'failed';

export type MeshRefineJobHandle = {
    success: true;
    async: true;
    status: MeshRefineAsyncJobStatus;
    jobId: string;
    interactionId: string;
    meshId: string;
    nodeId: string;
    targetNodeId: string;
    targetDaemonId?: string;
    workspace?: string;
    startedAt: string;
    completedAt?: string;
    duplicate?: boolean;
    retryOfJobId?: string;
    /**
     * The coordinator daemon ID that initiated this refine job.
     * When set, events for this job are scoped to that coordinator's
     * pending-events queue instead of the shared broadcast queue.
     */
    targetCoordinatorDaemonId?: string;
    eventDelivery: {
        pendingEvents: true;
        ledger: true;
    };
    evidence: {
        pendingEventsCommand: 'get_pending_mesh_events';
        ledgerCommand: 'get_mesh_ledger_slice';
        taskHistoryKind: 'task_dispatched' | 'task_completed' | 'task_failed';
    };
};

type MeshRefineTerminalJob = MeshRefineJobHandle & { result?: Record<string, unknown> };

type MeshRefineBatchJobStatus = 'accepted' | 'completed' | 'failed';

/**
 * Async handle returned by the batch Refinery the instant a convergence run is
 * accepted. Mirrors {@link MeshRefineJobHandle} (async:true / status:'accepted' +
 * terminal pending-event + ledger delivery) but scopes a whole batch of sibling
 * nodes rather than a single node. The synthetic `batchLabel` is used as the
 * `nodeLabel` for the shared refine event/message renderer.
 */
type MeshRefineBatchJobHandle = {
    success: true;
    async: true;
    batch: true;
    status: MeshRefineBatchJobStatus;
    jobId: string;
    interactionId: string;
    meshId: string;
    batchLabel: string;
    nodeIds: string[];
    nodeCount: number;
    order: string[];
    startedAt: string;
    completedAt?: string;
    duplicate?: boolean;
    targetCoordinatorDaemonId?: string;
    eventDelivery: {
        pendingEvents: true;
        ledger: true;
    };
    evidence: {
        pendingEventsCommand: 'get_pending_mesh_events';
        ledgerCommand: 'get_mesh_ledger_slice';
        taskHistoryKind: 'task_dispatched' | 'task_completed' | 'task_failed';
    };
};

type MeshRefineBatchTerminalJob = MeshRefineBatchJobHandle & { result?: Record<string, unknown> };

const REFINE_VALIDATION_CATEGORIES = ['typecheck', 'test', 'lint', 'build'] as const;
const REFINE_VALIDATION_TIMEOUT_MS = 120_000;
const REFINE_VALIDATION_OUTPUT_LIMIT_BYTES = 128 * 1024;
const REFINE_VALIDATION_SUMMARY_CHARS = 2_000;
const REFINE_VALIDATION_MAX_COMMANDS = 4;
const REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

function truncateValidationOutput(value: unknown): string {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    if (text.length <= REFINE_VALIDATION_SUMMARY_CHARS) return text;
    return `${text.slice(0, REFINE_VALIDATION_SUMMARY_CHARS)}\n[truncated ${text.length - REFINE_VALIDATION_SUMMARY_CHARS} chars]`;
}

/**
 * A spawn-resolution failure is when the executable itself could not be found by
 * the OS spawn boundary — `spawn <cmd> ENOENT` — as opposed to the command
 * running and exiting non-zero. On win32 this is the .cmd-shim case: libuv's
 * spawn search appends only .com/.exe, so a bare `npm`/`npx`/`tsc` (which are
 * .cmd shims) ENOENTs even though it is installed. It carries no stderr, so it
 * must be detected by error.code/syscall, not by string-matching output.
 */
export function isSpawnResolutionError(error: any): boolean {
    if (!error) return false;
    if (error.code === 'ENOENT' && typeof error.syscall === 'string' && error.syscall.startsWith('spawn')) return true;
    // Fall back to code alone: execFile sets syscall on the spawn boundary error,
    // but guard for environments/mocks that only surface the code.
    return error.code === 'ENOENT' && (error.syscall === undefined || String(error.syscall).startsWith('spawn'));
}

export function describeSpawnError(error: any, command: string, spawnResolutionFailed: boolean): string {
    if (spawnResolutionFailed) {
        const hint = process.platform === 'win32'
            ? ' On Windows, npm-family commands (npm/npx/tsc/vitest) are .cmd shims that the bare-command spawn search does not resolve; configure an absolute path or ensure the command is on PATH.'
            : '';
        return `Could not resolve executable "${command}" (spawn ENOENT).${hint}`;
    }
    return String(error?.message || error);
}

function recordMeshRefineStage(
    stages: Array<Record<string, unknown>>,
    stage: string,
    status: MeshRefineStageStatus,
    startedAt: number,
    details?: Record<string, unknown>,
): void {
    stages.push({
        stage,
        status,
        durationMs: Date.now() - startedAt,
        ...(details || {}),
    });
}

function buildSubmodulePublishRequiredNextStep(entries: MeshRefineSubmoduleReachabilityEntry[]): string {
    const refs = entries
        .map(entry => `${entry.path}@${entry.commit}`)
        .join(', ');
    return `Ask the user for explicit approval to push/publish the unreachable submodule commit(s) (${refs}) to the configured submodule remote main branch, then rerun mesh_refine_node. Do not merge the root branch until every submodule gitlink commit is reachable from submodule origin/main.`;
}

/**
 * Async git exec helper used across the synchronous-refine stage pipeline. Bound
 * once in the orchestrator and threaded through RefineContext so every stage runs
 * git the same way (execFile + promisify, utf8). Returns the child's stdout/stderr.
 */
type RefineExecFileAsync = (file: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => Promise<{ stdout: string; stderr: string }>;

/**
 * Accumulated state shared by the synchronous-refine stages. The orchestrator
 * (executeMeshRefineNodeSynchronously) seeds this in the resolve_refs stage and
 * each later stage reads / extends it. `branchHead` and `patchEquivalence` are the
 * only fields a stage mutates after creation (auto-rebase updates both), so they
 * are carried on the mutable context rather than re-threaded through return types.
 */
interface RefineContext {
    meshId: string;
    nodeId: string;
    args: any;
    refineStages: Array<Record<string, unknown>>;
    execFileAsync: RefineExecFileAsync;
    mesh: any;
    node: any;
    sourceNode: any;
    repoRoot: string;
    branch: string;
    baseBranch: string;
    baseHead: string;
    branchHead: string;
    validationSummary: Awaited<ReturnType<typeof runMeshRefineValidationGate>>;
    patchEquivalence: Awaited<ReturnType<typeof runMeshRefinePatchEquivalenceGate>>;
    submoduleReachability: Awaited<ReturnType<typeof runMeshRefineSubmoduleReachabilityGate>>;
}

/**
 * Stage outcome for the synchronous-refine pipeline. A stage either produces a
 * terminal CommandRouterResult (an early-exit gate failure, or a successful
 * already-merged short-circuit), in which case the orchestrator returns it
 * immediately, or it returns `continue` with the (possibly extended) context for
 * the next stage. This makes the orchestrator a flat sequence of stage calls
 * while preserving the original body's exact early-return control flow.
 */
type RefineStageOutcome =
    | { kind: 'terminal'; result: CommandRouterResult }
    | { kind: 'continue'; ctx: RefineContext };

function resolveRefineryAutoPublishSubmoduleMainCommits(mesh: any, workspace: string): { enabled: boolean; source?: string } {
    if (mesh?.policy?.allowAutoPublishSubmoduleMainCommits === true) {
        process.stderr.write(
            `[adhdev-mesh] WARNING: allowAutoPublishSubmoduleMainCommits is ENABLED via mesh.policy. `
            + `Refinery may push unreachable submodule commits to submodule origin/main without additional user approval.\n`,
        );
        return { enabled: true, source: 'mesh.policy.allowAutoPublishSubmoduleMainCommits' };
    }
    const loaded = loadMeshRefineConfig(mesh, workspace);
    if (loaded.config?.allowAutoPublishSubmoduleMainCommits === true) {
        process.stderr.write(
            `[adhdev-mesh] WARNING: allowAutoPublishSubmoduleMainCommits is ENABLED via ${loaded.path || loaded.source}. `
            + `Refinery may push unreachable submodule commits to submodule origin/main without additional user approval.\n`,
        );
        return { enabled: true, source: loaded.path || loaded.source };
    }
    return { enabled: false };
}

async function computeGitPatchId(
    cwd: string,
    fromRef: string,
    toRef: string,
    excludePaths: string[] = [],
): Promise<string> {
    const { execFileSync } = await import('node:child_process');
    // When excludePaths is non-empty we drop those paths from the diff via
    // `:(exclude)` pathspecs. This is used to omit gitlink paths that have
    // already been proven a safe fast-forward: their patch hunks legitimately
    // differ between the expected (mergeBase→branch) and actual (base→merged)
    // diffs because base may have advanced the same gitlink, so comparing them
    // would spuriously fail patch-equivalence even though the merge is sound.
    const diffArgs = ['diff', '--patch', '--full-index', fromRef, toRef];
    if (excludePaths.length > 0) {
        diffArgs.push('--', '.', ...excludePaths.map(path => `:(exclude)${path}`));
    }
    const diff = execFileSync('git', diffArgs, {
        cwd,
        encoding: 'utf8',
        maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
    });
    if (!diff.trim()) return '';
    const patchId = execFileSync('git', ['patch-id', '--stable'], {
        cwd,
        input: diff,
        encoding: 'utf8',
        maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
    }).trim();
    return patchId.split(/\s+/)[0] || '';
}

export async function runMeshRefinePatchEquivalenceGate(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
): Promise<MeshRefinePatchEquivalenceSummary> {
    const startedAt = Date.now();
    try {
        const { execFileSync } = await import('node:child_process');
        const git = (args: string[]) => execFileSync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const mergeBase = git(['merge-base', baseHead, branchHead]).trim();

        // `git merge-tree --write-tree` refuses to merge gitlinks that differ
        // across base/branch even when the advance is a strict fast-forward,
        // failing with "Recursive merging with submodules currently only
        // supports trivial cases". When that happens we check whether the
        // conflict is *entirely* trivial-ff gitlinks and, if so, synthesize the
        // merged tree ourselves (base tree + branch-side gitlinks).
        let mergedTree = '';
        let mergeTreeStdout = '';
        let gitlinkTrivialFastForward: MeshRefinePatchEquivalenceSummary['gitlinkTrivialFastForward'];
        try {
            mergeTreeStdout = git(['merge-tree', '--write-tree', baseHead, branchHead]);
            mergedTree = mergeTreeStdout.trim().split(/\s+/)[0] || '';
        } catch (mergeTreeErr: any) {
            const output = `${mergeTreeErr?.message || ''}\n${mergeTreeErr?.stdout || ''}\n${mergeTreeErr?.stderr || ''}`;
            const isSubmoduleConflict = /(submodule|160000)/i.test(output)
                || /Recursive merging with submodules/i.test(output);
            if (!isSubmoduleConflict) throw mergeTreeErr;
            const evaluation = evaluateGitlinkTrivialFastForward(repoRoot, baseHead, branchHead);
            if (!evaluation.trivial) {
                return {
                    status: 'failed',
                    equivalent: false,
                    baseHead,
                    branchHead,
                    mergeBase: mergeBase || undefined,
                    durationMs: Date.now() - startedAt,
                    error: mergeTreeErr?.message || String(mergeTreeErr),
                    stdout: truncateValidationOutput(mergeTreeErr?.stdout),
                    stderr: truncateValidationOutput(mergeTreeErr?.stderr),
                    gitlinkTrivialFastForward: { resolved: false, gitlinks: evaluation.gitlinks, reason: evaluation.reason },
                    actionableHint: buildPatchEquivalenceSubmoduleConflictHint(repoRoot, baseHead, branchHead, output),
                };
            }
            // All conflicting gitlinks fast-forward and nothing else conflicts:
            // synthesize the merge result as base's tree with branch-side gitlinks.
            mergedTree = synthesizeTrivialFastForwardMergeTree(repoRoot, baseHead, branchHead, evaluation.gitlinks) || '';
            gitlinkTrivialFastForward = { resolved: true, gitlinks: evaluation.gitlinks };
        }

        if (!mergeBase || !mergedTree) {
            return {
                status: 'failed',
                equivalent: false,
                baseHead,
                branchHead,
                mergeBase: mergeBase || undefined,
                mergedTree: mergedTree || undefined,
                durationMs: Date.now() - startedAt,
                error: 'patch equivalence preflight could not resolve merge-base or synthetic merge tree',
                stdout: truncateValidationOutput(mergeTreeStdout),
                gitlinkTrivialFastForward,
            };
        }
        // Exclude *proven fast-forward* gitlink paths from BOTH patch-ids. When
        // base has advanced a submodule pointer (a sibling merged into main ahead
        // of us) the gitlink hunk's old-value differs between the expected diff
        // (mergeBase→branch, showing the full base→branch advance) and the actual
        // diff (base→merged, showing only the shorter advanced-base→branch
        // advance). That mismatch would spuriously fail equivalence even though
        // advancing the pointer to the branch side is a provably safe
        // fast-forward — this is the root cause of the diverged-base
        // patch_equivalence_failed misjudgment.
        //
        // We exclude ONLY gitlinks whose base-side commit is an ancestor of the
        // branch-side commit (a strict ff, both objects available locally). A
        // non-ff or ambiguous gitlink (a genuine submodule divergence, or objects
        // not fetched locally) is deliberately left in the diff so its differing
        // hunk still drives the comparison — this preserves the original behavior
        // and prevents a false pass on a real divergence.
        const ffGitlinkExcludePaths = collectFastForwardGitlinkPaths(repoRoot, baseHead, branchHead);
        const expectedPatchId = await computeGitPatchId(repoRoot, mergeBase, branchHead, ffGitlinkExcludePaths);
        const actualPatchId = await computeGitPatchId(repoRoot, baseHead, mergedTree, ffGitlinkExcludePaths);
        const equivalent = expectedPatchId === actualPatchId;
        return {
            status: equivalent ? 'passed' : 'failed',
            equivalent,
            baseHead,
            branchHead,
            mergeBase,
            mergedTree,
            expectedPatchId,
            actualPatchId,
            durationMs: Date.now() - startedAt,
            gitlinkTrivialFastForward,
        };
    } catch (e: any) {
        return {
            status: 'failed',
            equivalent: false,
            baseHead,
            branchHead,
            durationMs: Date.now() - startedAt,
            error: e?.message || String(e),
            stdout: truncateValidationOutput(e?.stdout),
            stderr: truncateValidationOutput(e?.stderr),
            actionableHint: buildPatchEquivalenceSubmoduleConflictHint(
                repoRoot,
                baseHead,
                branchHead,
                `${e?.message || ''}\n${e?.stdout || ''}\n${e?.stderr || ''}`,
            ),
        };
    }
}

export type MeshWorktreePatchContainmentSummary = {
    /** True only when merging worktreeHead into ref introduces no new patch. */
    contained: boolean;
    ref: string;
    worktreeHead: string;
    mergeBase?: string;
    mergedTree?: string;
    /** patch-id of (ref -> synthesized merge tree); empty string when nothing new is added. */
    residualPatchId?: string;
    durationMs: number;
    /** Set when the check could not run (treated conservatively as NOT contained). */
    error?: string;
};

/**
 * Patch-equivalence containment check for the worktree force-cleanup convergence
 * guard. Answers a narrower question than {@link runMeshRefinePatchEquivalenceGate}:
 * "are the worktree branch's changes ALREADY present in `ref` (e.g. origin/main),
 * even though the worktree HEAD's commit SHA is not an ancestor of ref?"
 *
 * This is the cherry-pick / squash / rebase case: the same content landed on the
 * default ref under a different commit SHA, so `merge-base --is-ancestor` (the
 * primary cleanup guard) reports the worktree as un-converged and refuses to
 * remove it. Refinery already accepts patch-equivalent landings via merge-tree +
 * patch-id; this brings the same notion of "convergence" to the cleanup guard.
 *
 * Mechanism: synthesize the merge of `worktreeHead` into `ref` (reusing the same
 * trivial-gitlink-fast-forward handling as the refine gate) and compute the
 * patch-id of (ref -> mergedTree). If that residual diff is EMPTY, merging the
 * worktree adds nothing new on top of ref — its changes are already present there
 * and the worktree is safe to remove. A non-empty residual means the worktree
 * still carries content not in ref, so it is NOT contained and must stay blocked.
 *
 * Conservative by construction: any merge-tree / patch-id failure, a genuine
 * (non-trivial) submodule conflict, or any thrown error yields `contained: false`
 * so an exception can never widen the cleanup allow-list.
 */
export async function checkWorktreeChangesPatchEquivalentInRef(
    repoRoot: string,
    ref: string,
    worktreeHead: string,
): Promise<MeshWorktreePatchContainmentSummary> {
    const startedAt = Date.now();
    try {
        const { execFileSync } = await import('node:child_process');
        const git = (gitArgs: string[]) => execFileSync('git', gitArgs, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const mergeBase = git(['merge-base', ref, worktreeHead]).trim();

        // Reuse the refine gate's trivial-gitlink-fast-forward handling: a clean
        // submodule pointer fast-forward must not block the cleanup, but a real
        // (non-ff) submodule divergence must keep it blocked.
        let mergedTree = '';
        try {
            mergedTree = git(['merge-tree', '--write-tree', ref, worktreeHead]).trim().split(/\s+/)[0] || '';
        } catch (mergeTreeErr: any) {
            const output = `${mergeTreeErr?.message || ''}\n${mergeTreeErr?.stdout || ''}\n${mergeTreeErr?.stderr || ''}`;
            const isSubmoduleConflict = /(submodule|160000)/i.test(output)
                || /Recursive merging with submodules/i.test(output);
            if (!isSubmoduleConflict) throw mergeTreeErr;
            const evaluation = evaluateGitlinkTrivialFastForward(repoRoot, ref, worktreeHead);
            if (!evaluation.trivial) {
                // A genuine submodule divergence (or unfetched objects): we cannot
                // prove containment, so block conservatively.
                return {
                    contained: false,
                    ref,
                    worktreeHead,
                    mergeBase: mergeBase || undefined,
                    durationMs: Date.now() - startedAt,
                    error: `merge-tree submodule conflict is not a trivial fast-forward: ${evaluation.reason || 'unknown'}`,
                };
            }
            mergedTree = synthesizeTrivialFastForwardMergeTree(repoRoot, ref, worktreeHead, evaluation.gitlinks) || '';
        }

        if (!mergedTree) {
            return {
                contained: false,
                ref,
                worktreeHead,
                mergeBase: mergeBase || undefined,
                durationMs: Date.now() - startedAt,
                error: 'could not resolve synthetic merge tree for containment check',
            };
        }

        // Exclude proven fast-forward gitlinks from the residual diff for the same
        // reason the refine gate does: advancing a submodule pointer to a strict
        // descendant is a safe fast-forward and must not count as "new content".
        const ffGitlinkExcludePaths = collectFastForwardGitlinkPaths(repoRoot, ref, worktreeHead);
        const residualPatchId = await computeGitPatchId(repoRoot, ref, mergedTree, ffGitlinkExcludePaths);
        const contained = residualPatchId === '';
        return {
            contained,
            ref,
            worktreeHead,
            mergeBase: mergeBase || undefined,
            mergedTree,
            residualPatchId,
            durationMs: Date.now() - startedAt,
        };
    } catch (e: any) {
        return {
            contained: false,
            ref,
            worktreeHead,
            durationMs: Date.now() - startedAt,
            error: e?.message || String(e),
        };
    }
}

/**
 * No-op guard: detect a "silent no-op" merge before the Refinery merge runs.
 *
 * A silent no-op occurs when the refine target branch's ROOT tree is byte-identical
 * to the merge base (origin/main). This is the trap where a submodule (e.g. oss) has
 * real commits but the root branch never committed the gitlink (oss-pointer) bump, so
 * the root diff Refinery would merge is empty. Merging that produces a merge commit with
 * no content change — reported as "success" while the actual work never reaches main.
 *
 * A committed gitlink bump (the legitimate oss-pointer bump) DOES show up in the root
 * tree diff (as a 160000-mode entry), so this guard does NOT block legitimate refines —
 * it only fires when the root tree diff vs base is COMPLETELY empty.
 *
 * Runs after the patch-equivalence gate; the "already merged via other path" case
 * (branch has real changes already present in base) is handled upstream and never
 * reaches here, so an empty root diff at this point is genuinely a no-op.
 */
export async function runMeshRefineEffectiveDiffGate(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
): Promise<MeshRefineEffectiveDiffSummary> {
    const startedAt = Date.now();
    try {
        const { execFileSync } = await import('node:child_process');
        const git = (args: string[], opts?: { cwd?: string }) => execFileSync('git', args, {
            cwd: opts?.cwd || repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        // Root tree diff between base and branch. --raw surfaces gitlink (160000) entries,
        // so a committed submodule-pointer bump counts as an effective change. An empty
        // result means the branch's root tree is identical to base → nothing would merge.
        const rawDiff = git(['diff', '--raw', baseHead, branchHead]).trim();
        if (rawDiff) {
            const changedPaths = rawDiff
                .split('\n')
                .map(line => line.split('\t').slice(1).join('\t').trim())
                .filter(Boolean)
                .slice(0, 50);
            return {
                status: 'passed',
                hasEffectiveDiff: true,
                baseHead,
                branchHead,
                changedPaths,
                durationMs: Date.now() - startedAt,
            };
        }

        // No root diff → silent no-op. Try to surface which submodule(s) have commits that
        // were never captured by a committed gitlink bump, to make the message actionable.
        const submoduleHints: Array<{ path: string; reason: string }> = [];
        try {
            // `git submodule status` flags submodules whose checked-out commit differs from
            // the recorded gitlink with a leading '+'. That difference is exactly the
            // uncommitted-pointer-bump situation this guard exists to catch.
            const status = git(['submodule', 'status']);
            for (const line of status.split('\n')) {
                const trimmed = line.trimEnd();
                if (!trimmed) continue;
                if (trimmed.startsWith('+')) {
                    const parts = trimmed.slice(1).trim().split(/\s+/);
                    const path = parts[1] || parts[0] || '(unknown)';
                    submoduleHints.push({
                        path,
                        reason: 'submodule checked-out commit differs from the committed gitlink (pointer bump not committed on the root branch)',
                    });
                }
            }
        } catch { /* submodule status is best-effort */ }

        return {
            status: 'failed',
            hasEffectiveDiff: false,
            baseHead,
            branchHead,
            ...(submoduleHints.length ? { submoduleHints } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (e: any) {
        // On error, do NOT block the merge — fail open so a probe failure can't wedge refine.
        return {
            status: 'skipped',
            hasEffectiveDiff: true,
            baseHead,
            branchHead,
            durationMs: Date.now() - startedAt,
            error: e?.message || String(e),
            stdout: truncateValidationOutput(e?.stdout),
            stderr: truncateValidationOutput(e?.stderr),
        };
    }
}

function buildPatchEquivalenceSubmoduleConflictHint(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
    output: string,
): MeshRefineSubmoduleConflictHint | undefined {
    if (!/(submodule|160000)/i.test(output) || !/(conflict|failed to merge)/i.test(output)) return undefined;
    const conflicts = readChangedGitlinkPaths(repoRoot, baseHead, branchHead)
        .map(path => ({
            path,
            baseCommit: readTreeObject(repoRoot, baseHead, path),
            branchCommit: readTreeObject(repoRoot, branchHead, path),
        }));
    if (conflicts.length === 0) return undefined;
    return {
        kind: 'submodule_conflict',
        message: 'Refinery could not synthesize a safe merge tree because the branch and base point the same submodule path at different commits.',
        conflicts,
        nextSteps: [
            'Inspect the listed submodule path in both base and branch: baseCommit is the commit currently recorded by the base workspace, branchCommit is the commit recorded by the worktree branch.',
            'Resolve the submodule first by checking out or creating the intended submodule commit, then commit the chosen gitlink in the root branch.',
            'Ensure the chosen submodule commit is reachable from the configured submodule remote main branch, then rerun mesh_refine_node.',
        ],
    };
}

function readChangedGitlinkPaths(repoRoot: string, fromRef: string, toRef: string): string[] {
    try {
        const output = execFileSync('git', ['diff', '--raw', '--no-abbrev', fromRef, toRef], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const paths = new Set<string>();
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            const metaAndPath = line.split('\t');
            const meta = metaAndPath[0] || '';
            const path = metaAndPath[metaAndPath.length - 1]?.trim();
            if (!path) continue;
            const parts = meta.split(/\s+/);
            if (parts[0]?.includes('160000') || parts[1]?.includes('160000')) {
                paths.add(path);
            }
        }
        return [...paths].sort();
    } catch {
        return [];
    }
}

function readTreeObject(repoRoot: string, ref: string, path: string): string | undefined {
    try {
        const output = execFileSync('git', ['ls-tree', ref, '--', path], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        }).trim();
        const match = output.match(/\bcommit\s+([0-9a-f]{40})\b/i);
        return match?.[1];
    } catch {
        return undefined;
    }
}

/**
 * Resolve the absolute path to the repo's real git directory. In a linked
 * worktree, `.git` is a file pointing elsewhere, so we cannot assume a `.git`
 * subdirectory exists — a temporary index file must live in the actual git dir.
 */
function resolveGitDir(repoRoot: string): string {
    const out = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    }).trim();
    return out;
}

/**
 * Result of evaluating whether a `git merge-tree --write-tree` submodule
 * conflict is in fact a trivial gitlink fast-forward that should pass the
 * patch-equivalence gate.
 *
 * `git merge-tree` (and `git merge` with the default recursive strategy)
 * refuses to 3-way merge gitlinks unless the case is "trivial" — and it
 * treats *any* gitlink that differs across merge-base/base/branch as
 * non-trivial, even when the branch-side commit is a strict descendant of the
 * base-side commit (i.e. a real fast-forward). Refinery only ever wants to
 * accept the branch's recorded gitlink, so a fast-forwardable bump is safe to
 * resolve to the branch side without any conflict.
 */
type GitlinkTrivialFastForwardEvaluation = {
    /** True only when the merge-tree conflict is *fully* explained by trivial-ff gitlinks. */
    trivial: boolean;
    /** Why the evaluation declined to treat the conflict as trivial (set when trivial=false). */
    reason?: string;
    /** Per-path detail for the changed gitlinks that were inspected. */
    gitlinks: Array<{
        path: string;
        baseCommit?: string;
        branchCommit?: string;
        fastForward: boolean;
    }>;
};

/**
 * Check, inside a submodule repo, whether `baseCommit` is an ancestor of
 * `branchCommit` (i.e. advancing the gitlink from base→branch is a pure
 * fast-forward). Returns false on any error or when either commit is missing
 * locally — safety first, ambiguity stays "not a fast-forward".
 */
function isSubmoduleFastForward(submoduleRepoPath: string, baseCommit: string, branchCommit: string): boolean {
    if (!baseCommit || !branchCommit) return false;
    if (baseCommit === branchCommit) return true;
    try {
        if (!fs.existsSync(submoduleRepoPath)) return false;
        // Both commits must exist locally for the ancestry check to be meaningful.
        execFileSync('git', ['cat-file', '-e', `${baseCommit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
        execFileSync('git', ['cat-file', '-e', `${branchCommit}^{commit}`], { cwd: submoduleRepoPath, stdio: 'ignore' });
        // exit 0 ⇒ baseCommit is an ancestor of branchCommit ⇒ branch fast-forwards base.
        execFileSync('git', ['merge-base', '--is-ancestor', baseCommit, branchCommit], { cwd: submoduleRepoPath, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Read the set of paths that differ between two refs, tagging whether each is a
 * gitlink (submodule, mode 160000) on either side. Returns one entry per
 * changed path. Empty on error.
 */
function readChangedPathKinds(repoRoot: string, fromRef: string, toRef: string): Array<{ path: string; isGitlink: boolean }> {
    try {
        const output = execFileSync('git', ['diff', '--raw', '--no-abbrev', fromRef, toRef], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
        });
        const result: Array<{ path: string; isGitlink: boolean }> = [];
        const seen = new Set<string>();
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            const metaAndPath = line.split('\t');
            const meta = metaAndPath[0] || '';
            const path = metaAndPath[metaAndPath.length - 1]?.trim();
            if (!path || seen.has(path)) continue;
            seen.add(path);
            const parts = meta.split(/\s+/);
            const isGitlink = !!(parts[0]?.includes('160000') || parts[1]?.includes('160000'));
            result.push({ path, isGitlink });
        }
        return result;
    } catch {
        return [];
    }
}

/**
 * Return the changed gitlink paths between base and branch whose advance is a
 * strict fast-forward (the base-side commit is an ancestor of the branch-side
 * commit inside that submodule's repo). These are the paths whose patch-id hunk
 * may legitimately differ when base has advanced the same submodule, so they
 * are safe to exclude from the patch-equivalence comparison. A non-ff (genuinely
 * diverged) gitlink is deliberately excluded from this set so it still fails the
 * gate.
 */
export function collectFastForwardGitlinkPaths(repoRoot: string, baseHead: string, branchHead: string): string[] {
    return readChangedGitlinkPaths(repoRoot, baseHead, branchHead).filter(path => {
        const baseCommit = readTreeObject(repoRoot, baseHead, path);
        const branchCommit = readTreeObject(repoRoot, branchHead, path);
        if (!baseCommit || !branchCommit) return false;
        return isSubmoduleFastForward(pathResolve(repoRoot, path), baseCommit, branchCommit);
    });
}

/**
 * Decide whether a merge-tree submodule conflict between base and branch is a
 * trivial gitlink fast-forward (and nothing else).
 *
 * The conflict is treated as trivial ONLY when:
 *   1. at least one changed gitlink exists,
 *   2. every changed gitlink fast-forwards (base-commit is an ancestor of the
 *      branch-commit inside that submodule's repo), and
 *   3. the *only* paths that changed on both sides of the merge (i.e. the paths
 *      that could possibly produce a 3-way conflict — the intersection of
 *      mergeBase→base and mergeBase→branch changes) are gitlinks. Any
 *      overlapping non-gitlink path means a genuine content conflict could be
 *      hiding behind the submodule failure, so we keep the block.
 *
 * If any of these fail, the conflict is left as a genuine block. This never
 * passes a regular-file conflict or a diverged (non-ff) gitlink.
 */
export function evaluateGitlinkTrivialFastForward(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
): GitlinkTrivialFastForwardEvaluation {
    const changedGitlinks = readChangedGitlinkPaths(repoRoot, baseHead, branchHead).map(path => {
        const baseCommit = readTreeObject(repoRoot, baseHead, path);
        const branchCommit = readTreeObject(repoRoot, branchHead, path);
        const submoduleRepoPath = pathResolve(repoRoot, path);
        const fastForward = !!baseCommit && !!branchCommit
            && isSubmoduleFastForward(submoduleRepoPath, baseCommit, branchCommit);
        return { path, baseCommit, branchCommit, fastForward };
    });

    if (changedGitlinks.length === 0) {
        return { trivial: false, reason: 'no_changed_gitlinks', gitlinks: changedGitlinks };
    }

    const nonFastForward = changedGitlinks.filter(entry => !entry.fastForward);
    if (nonFastForward.length > 0) {
        return {
            trivial: false,
            reason: `diverged_gitlinks:${nonFastForward.map(entry => entry.path).join(',')}`,
            gitlinks: changedGitlinks,
        };
    }

    // Prove there is no *other* conflict (regular files, or a gitlink that
    // diverged on both sides). A 3-way merge can only conflict on a path that
    // changed on BOTH sides relative to the merge-base. Compute that overlap and
    // require every overlapping path to be a gitlink — non-gitlink overlap means
    // a genuine content conflict that must stay blocked.
    let mergeBase = '';
    try {
        mergeBase = execFileSync('git', ['merge-base', baseHead, branchHead], {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        }).trim();
    } catch {
        return { trivial: false, reason: 'merge_base_unresolved', gitlinks: changedGitlinks };
    }
    if (!mergeBase) {
        return { trivial: false, reason: 'merge_base_unresolved', gitlinks: changedGitlinks };
    }

    const baseSideChanges = readChangedPathKinds(repoRoot, mergeBase, baseHead);
    const branchSideChanges = readChangedPathKinds(repoRoot, mergeBase, branchHead);
    const baseChangedPaths = new Map(baseSideChanges.map(entry => [entry.path, entry]));
    // Overlapping paths = candidates for a real 3-way conflict.
    const overlapping = branchSideChanges.filter(entry => baseChangedPaths.has(entry.path));
    const nonGitlinkOverlap = overlapping.filter(entry => {
        const baseEntry = baseChangedPaths.get(entry.path);
        return !(entry.isGitlink && baseEntry?.isGitlink);
    });
    if (nonGitlinkOverlap.length > 0) {
        return {
            trivial: false,
            reason: `non_gitlink_overlap:${nonGitlinkOverlap.map(entry => entry.path).join(',')}`,
            gitlinks: changedGitlinks,
        };
    }

    return { trivial: true, gitlinks: changedGitlinks };
}

/**
 * Build a tree identical to `commitish`'s tree except every gitlink in `paths`
 * is rewritten to `placeholderCommit`. Used to neutralize submodule pointers so
 * `git merge-tree` stops bailing on the "Recursive merging with submodules"
 * limitation and can 3-way merge the surrounding regular-file content. Returns
 * the tree SHA, or undefined on failure.
 */
function buildTreeWithGitlinksEqualized(
    repoRoot: string,
    commitish: string,
    paths: string[],
    placeholderCommit: string,
): string | undefined {
    try {
        const tree = execFileSync('git', ['rev-parse', `${commitish}^{tree}`], {
            cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
        }).trim();
        if (!tree) return undefined;
        const updates = paths.map(path => `160000 commit ${placeholderCommit}\t${path}`).join('\n');
        if (!updates) return tree;
        const tmpIndex = pathJoin(resolveGitDir(repoRoot), `adhdev-refine-eq-${commitish.slice(0, 12)}.index`);
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        try {
            execFileSync('git', ['read-tree', tree], { cwd: repoRoot, env, stdio: 'ignore' });
            execFileSync('git', ['update-index', '--index-info'], {
                cwd: repoRoot, env, input: `${updates}\n`, encoding: 'utf8',
                stdio: ['pipe', 'ignore', 'ignore'],
            });
            const newTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, env, encoding: 'utf8' }).trim();
            return newTree || undefined;
        } finally {
            try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ }
        }
    } catch {
        return undefined;
    }
}

/**
 * Synthesize the merge result for a trivial gitlink fast-forward.
 *
 * `git merge-tree` bails whenever a gitlink differs across base/branch even
 * when the advance is a strict fast-forward, so we synthesize the result it
 * *would* have produced. Crucially, when the merge-base of base and branch is
 * NOT `baseHead` (i.e. base has diverged — a sibling was merged into main
 * ahead of us), `baseHead`'s tree does not contain our branch's own
 * non-gitlink changes. Simply overlaying gitlinks onto `baseHead`'s tree would
 * therefore drop those changes and break patch-equivalence.
 *
 * To handle the diverged case correctly we run a REAL 3-way merge of the
 * regular-file content (with the conflicting gitlinks temporarily equalized to
 * a common placeholder so merge-tree won't bail), then overlay each changed
 * gitlink's branch-side commit onto the merged result. This preserves both
 * sides' non-gitlink changes.
 *
 * Returns the tree SHA, or undefined on failure / genuine non-gitlink
 * conflict. Caller must have already proven (via
 * evaluateGitlinkTrivialFastForward) that every changed gitlink fast-forwards
 * and no other path conflicts.
 */
function synthesizeTrivialFastForwardMergeTree(
    repoRoot: string,
    baseHead: string,
    branchHead: string,
    gitlinks: Array<{ path: string; branchCommit?: string }>,
): string | undefined {
    try {
        const branchGitlinks = gitlinks.filter(entry => entry.branchCommit);
        const gitlinkPaths = branchGitlinks.map(entry => entry.path);

        // Establish the regular-file content of the merge via a real 3-way merge
        // with the conflicting gitlinks neutralized. The placeholder is the
        // merge-base's value for a gitlink (or, failing that, any branch-side
        // commit) — it only needs to be identical across all three trees.
        const mergeBase = execFileSync('git', ['merge-base', baseHead, branchHead], {
            cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
        }).trim();

        let mergedContentTree: string | undefined;
        if (mergeBase && gitlinkPaths.length > 0) {
            const placeholder = readTreeObject(repoRoot, mergeBase, gitlinkPaths[0])
                || branchGitlinks[0].branchCommit!;
            const baseEqTree = buildTreeWithGitlinksEqualized(repoRoot, mergeBase, gitlinkPaths, placeholder);
            const oursEqTree = buildTreeWithGitlinksEqualized(repoRoot, baseHead, gitlinkPaths, placeholder);
            const theirsEqTree = buildTreeWithGitlinksEqualized(repoRoot, branchHead, gitlinkPaths, placeholder);
            if (baseEqTree && oursEqTree && theirsEqTree) {
                try {
                    // merge-tree --write-tree needs commits (to derive a merge-base);
                    // synthesize ours/theirs as children of a common base commit.
                    const baseEqCommit = execFileSync('git', ['commit-tree', baseEqTree, '-m', 'refine-ff-base'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const oursEqCommit = execFileSync('git', ['commit-tree', oursEqTree, '-p', baseEqCommit, '-m', 'refine-ff-ours'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const theirsEqCommit = execFileSync('git', ['commit-tree', theirsEqTree, '-p', baseEqCommit, '-m', 'refine-ff-theirs'], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
                    }).trim();
                    const mergeOut = execFileSync('git', ['merge-tree', '--write-tree', oursEqCommit, theirsEqCommit], {
                        cwd: repoRoot, encoding: 'utf8', maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
                    }).trim();
                    mergedContentTree = mergeOut.split(/\s+/)[0] || undefined;
                } catch {
                    // A real conflict in the equalized merge means a genuine
                    // non-gitlink content conflict the evaluator did not foresee
                    // (or unavailable objects). Fall through to the simple synth.
                    mergedContentTree = undefined;
                }
            }
        }

        // Fallback: when there is no diverged base (merge-base === baseHead) the
        // regular-file content of the merge is exactly baseHead's tree, so just
        // overlay the gitlinks. Also used when the real merge could not run.
        const contentTree = mergedContentTree
            || execFileSync('git', ['rev-parse', `${baseHead}^{tree}`], {
                cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024,
            }).trim();
        if (!contentTree) return undefined;

        const updates = branchGitlinks
            .map(entry => `160000 commit ${entry.branchCommit}\t${entry.path}`)
            .join('\n');
        if (!updates) return contentTree;
        const tmpIndex = pathJoin(resolveGitDir(repoRoot), `adhdev-refine-ff-${baseHead.slice(0, 12)}-${branchHead.slice(0, 12)}.index`);
        const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
        try {
            execFileSync('git', ['read-tree', contentTree], { cwd: repoRoot, env, stdio: 'ignore' });
            execFileSync('git', ['update-index', '--index-info'], {
                cwd: repoRoot,
                env,
                input: `${updates}\n`,
                encoding: 'utf8',
                stdio: ['pipe', 'ignore', 'ignore'],
            });
            const newTree = execFileSync('git', ['write-tree'], { cwd: repoRoot, env, encoding: 'utf8' }).trim();
            return newTree || undefined;
        } finally {
            try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ }
        }
    } catch {
        return undefined;
    }
}

async function alignRefinerySubmodulesAfterMerge(
    repoRoot: string,
    previousBaseHead: string,
    currentHead: string,
    options: { submoduleIgnorePaths?: string[] } = {},
): Promise<MeshRefineSubmoduleAlignmentSummary> {
    const startedAt = Date.now();
    const changedGitlinkPaths = readChangedGitlinkPaths(repoRoot, previousBaseHead, currentHead)
        .filter(path => !(options.submoduleIgnorePaths || []).includes(path));
    const preStatus = await getGitRepoStatus(repoRoot, {
        includeSubmodules: true,
        submoduleIgnorePaths: options.submoduleIgnorePaths,
        timeoutMs: 15_000,
    });
    const outOfSyncPaths = (preStatus.submodules || [])
        .filter(submodule => submodule.dirty || submodule.outOfSync || !!submodule.error)
        .map(submodule => submodule.path);
    const updatePaths = [...new Set([...changedGitlinkPaths, ...outOfSyncPaths])].sort();

    if (updatePaths.length === 0) {
        return {
            status: 'skipped',
            changedGitlinkPaths,
            outOfSyncPaths,
            updatedPaths: [],
            verifiedPaths: [],
            durationMs: Date.now() - startedAt,
            reason: 'no_changed_or_out_of_sync_submodules',
        };
    }

    const commandArgs = ['submodule', 'update', '--init', '--recursive', '--', ...updatePaths];
    try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const result = await execFileAsync('git', commandArgs, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
            timeout: 60_000,
        });
        const postStatus = await getGitRepoStatus(repoRoot, {
            includeSubmodules: true,
            submoduleIgnorePaths: options.submoduleIgnorePaths,
            timeoutMs: 15_000,
        });
        const remaining = (postStatus.submodules || [])
            .filter(submodule => updatePaths.includes(submodule.path) && (submodule.dirty || submodule.outOfSync || !!submodule.error));
        return {
            status: remaining.length === 0 ? 'passed' : 'failed',
            changedGitlinkPaths,
            outOfSyncPaths,
            updatedPaths: updatePaths,
            verifiedPaths: updatePaths.filter(path => !remaining.some(submodule => submodule.path === path)),
            durationMs: Date.now() - startedAt,
            command: `git ${commandArgs.join(' ')}`,
            stdout: truncateValidationOutput(result.stdout),
            stderr: truncateValidationOutput(result.stderr),
            ...(remaining.length > 0 ? { error: `Submodule checkout remained out of sync after update: ${remaining.map(entry => entry.path).join(', ')}` } : {}),
        };
    } catch (e: any) {
        return {
            status: 'failed',
            changedGitlinkPaths,
            outOfSyncPaths,
            updatedPaths: updatePaths,
            verifiedPaths: [],
            durationMs: Date.now() - startedAt,
            command: `git ${commandArgs.join(' ')}`,
            error: e?.message || String(e),
            stdout: truncateValidationOutput(e?.stdout),
            stderr: truncateValidationOutput(e?.stderr),
        };
    }
}

async function runMeshRefineSubmoduleReachabilityGate(
    repoRoot: string,
    mergedTree: string,
    options: { allowAutoPublishSubmoduleMainCommits?: boolean; autoPublishPolicySource?: string; worktreeRoot?: string } = {},
): Promise<MeshRefineSubmoduleReachabilitySummary> {
    const startedAt = Date.now();
    const entries: MeshRefineSubmoduleReachabilityEntry[] = [];
    try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const runGit = async (cwd: string, args: string[]): Promise<string> => {
            const { stdout } = await execFileAsync('git', args, {
                cwd,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
                windowsHide: true,
            });
            return String(stdout || '');
        };
        const verifyRemoteMainContainsCommit = async (submodulePath: string, commit: string, branch = 'main'): Promise<void> => {
            await runGit(submodulePath, ['-c', 'protocol.file.allow=always', 'fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
            await runGit(submodulePath, ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`]);
        };
        const publishCommitToRemoteMain = async (submodulePath: string, commit: string, branch = 'main'): Promise<{ stdout: string; stderr: string; refspec: string }> => {
            const refspec = `${commit}:refs/heads/${branch}`;
            const { stdout, stderr } = await execFileAsync('git', ['push', 'origin', refspec], {
                cwd: submodulePath,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: REFINE_PATCH_EQUIVALENCE_OUTPUT_LIMIT_BYTES,
                windowsHide: true,
            });
            return { stdout: String(stdout || ''), stderr: String(stderr || ''), refspec };
        };
        const importCommitFromWorktreeSubmodule = async (submodulePath: string, worktreeSubmodulePath: string, commit: string): Promise<boolean> => {
            if (!fs.existsSync(worktreeSubmodulePath)) return false;
            try {
                await runGit(worktreeSubmodulePath, ['cat-file', '-e', `${commit}^{commit}`]);
            } catch {
                return false;
            }
            await runGit(submodulePath, ['-c', 'protocol.file.allow=always', 'fetch', worktreeSubmodulePath, commit]);
            await runGit(submodulePath, ['cat-file', '-e', `${commit}^{commit}`]);
            return true;
        };

        const treeOutput = await runGit(repoRoot, ['ls-tree', '-r', '-z', mergedTree]);
        const gitlinks = treeOutput
            .split('\0')
            .filter(Boolean)
            .map(record => {
                const match = /^160000\s+commit\s+([0-9a-f]{40})\t(.+)$/.exec(record);
                return match ? { commit: match[1], path: match[2] } : null;
            })
            .filter((entry): entry is { commit: string; path: string } => !!entry);

        for (const gitlink of gitlinks) {
            const submodulePath = pathResolve(repoRoot, gitlink.path);
            const entry: MeshRefineSubmoduleReachabilityEntry = {
                path: gitlink.path,
                commit: gitlink.commit,
                reachable: false,
            };
            try {
                if (!fs.existsSync(submodulePath)) {
                    entry.error = `Submodule checkout missing at ${gitlink.path}`;
                    entry.publishRequired = true;
                    if (options.allowAutoPublishSubmoduleMainCommits === true) {
                        entry.autoPublishAllowed = true;
                        entry.autoPublishAttempted = false;
                        entry.autoPublishSkippedReason = `submodule checkout missing at ${gitlink.path}; cannot perform non-force push to origin/main`;
                    }
                    entries.push(entry);
                    continue;
                }

                entry.checkedLocal = true;
                try {
                    await runGit(submodulePath, ['cat-file', '-e', `${gitlink.commit}^{commit}`]);
                    entry.localReachable = true;
                } catch {
                    entry.localReachable = false;
                    if (options.allowAutoPublishSubmoduleMainCommits === true && options.worktreeRoot) {
                        try {
                            const imported = await importCommitFromWorktreeSubmodule(
                                submodulePath,
                                pathResolve(options.worktreeRoot, gitlink.path),
                                gitlink.commit,
                            );
                            if (imported) {
                                entry.localReachable = true;
                                entry.importedFromWorktree = true;
                            }
                        } catch (importError: any) {
                            entry.autoPublishSkippedReason = `candidate commit was not present in the source checkout and could not be imported from worktree submodule: ${truncateValidationOutput(importError?.stderr || importError?.message || String(importError))}`;
                        }
                    }
                    // Probe the submodule remote before allowing cleanup/completion.
                }

                try {
                    entry.remote = 'origin';
                    let remoteUrl = '';
                    try {
                        remoteUrl = (await runGit(submodulePath, ['remote', 'get-url', 'origin'])).trim();
                        if (!remoteUrl) throw new Error('origin remote has no URL');
                        entry.remoteUrl = remoteUrl;
                    } catch {
                        entry.error = 'Submodule remote reachability check failed: no configured origin remote';
                        entry.publishRequired = true;
                        if (options.allowAutoPublishSubmoduleMainCommits === true) {
                            entry.autoPublishAllowed = true;
                            entry.autoPublishAttempted = false;
                            entry.autoPublishSkippedReason = 'submodule origin remote is not configured; cannot perform non-force push to origin/main';
                        }
                        entries.push(entry);
                        continue;
                    }
                    entry.remoteMainBranch = 'main';
                    try {
                        await verifyRemoteMainContainsCommit(submodulePath, gitlink.commit, 'main');
                        entry.fetchedFromOrigin = true;
                        entry.remoteReachable = true;
                        entry.remoteMainReachable = true;
                        entry.reachable = true;
                    } catch (e: any) {
                        entry.remoteReachable = false;
                        entry.remoteMainReachable = false;
                        entry.publishRequired = true;
                        const details = truncateValidationOutput(e?.stderr || e?.message || String(e));
                        entry.error = `Submodule remote main reachability check failed for origin/main: ${details}`;
                        if (options.allowAutoPublishSubmoduleMainCommits === true && entry.localReachable === true) {
                            entry.autoPublishAllowed = true;
                            entry.autoPublishAttempted = true;
                            try {
                                const publish = await publishCommitToRemoteMain(submodulePath, gitlink.commit, 'main');
                                entry.autoPublishRefspec = publish.refspec;
                                entry.publishStdout = truncateValidationOutput(publish.stdout);
                                entry.publishStderr = truncateValidationOutput(publish.stderr);
                                entry.autoPublishSucceeded = true;
                                await verifyRemoteMainContainsCommit(submodulePath, gitlink.commit, 'main');
                                entry.fetchedFromOrigin = true;
                                entry.remoteReachable = true;
                                entry.remoteMainReachable = true;
                                entry.autoPublishVerified = true;
                                entry.publishRequired = false;
                                entry.reachable = true;
                                entry.error = undefined;
                            } catch (publishError: any) {
                                entry.autoPublishSucceeded = false;
                                entry.autoPublishVerified = false;
                                const publishDetails = truncateValidationOutput(publishError?.stderr || publishError?.message || String(publishError));
                                entry.error = `Submodule auto-publish to origin/main failed or could not be verified: ${publishDetails}`;
                            }
                        } else if (options.allowAutoPublishSubmoduleMainCommits === true) {
                            entry.autoPublishAllowed = true;
                            entry.autoPublishAttempted = false;
                            entry.autoPublishSkippedReason = entry.autoPublishSkippedReason
                                || 'candidate commit is not reachable in the source checkout or worktree submodule, so Refinery cannot push it to origin/main';
                        }
                    }
                } catch (e: any) {
                    entry.remoteReachable = false;
                    entry.remoteMainReachable = false;
                    entry.publishRequired = true;
                    const details = truncateValidationOutput(e?.stderr || e?.message || String(e));
                    entry.error = `Submodule remote main reachability check failed for origin/main: ${details}`;
                }
            } catch (e: any) {
                entry.error = truncateValidationOutput(e?.message || String(e));
                entry.publishRequired = true;
            }
            entries.push(entry);
        }

        const unreachable = entries.filter(entry => !entry.reachable);
        return {
            status: unreachable.length ? 'failed' : 'passed',
            checked: entries.length,
            unreachable: unreachable.map(entry => ({ ...entry, publishRequired: entry.publishRequired !== false })),
            entries: entries.map(entry => entry.reachable ? entry : { ...entry, publishRequired: entry.publishRequired !== false }),
            durationMs: Date.now() - startedAt,
            autoPublishAllowed: options.allowAutoPublishSubmoduleMainCommits === true,
            autoPublishPolicySource: options.autoPublishPolicySource,
        };
    } catch (e: any) {
        const unreachable = entries.filter(entry => !entry.reachable).map(entry => ({ ...entry, publishRequired: true }));
        return {
            status: 'failed',
            checked: entries.length,
            unreachable,
            entries: entries.map(entry => entry.reachable ? entry : { ...entry, publishRequired: true }),
            durationMs: Date.now() - startedAt,
            autoPublishAllowed: options.allowAutoPublishSubmoduleMainCommits === true,
            autoPublishPolicySource: options.autoPublishPolicySource,
            error: truncateValidationOutput(e?.message || String(e)),
        };
    }
}

export function buildMeshRefineValidationPlan(mesh: any, workspace: string): Record<string, unknown> {
    const plan = resolveMeshRefineValidationPlan(mesh, workspace);
    const mapCommand = (command: MeshRefineValidationCommandPlan) => ({
        displayCommand: command.displayCommand,
        category: command.category,
        source: command.source,
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
    });
    return {
        source: plan.source,
        sourceType: plan.sourceType,
        bootstrapCommands: plan.bootstrapCommands.map(mapCommand),
        commands: plan.commands.map(mapCommand),
        unavailableReason: plan.unavailableReason,
        rejectedCommands: plan.rejectedCommands,
        suggestions: plan.suggestions,
        suggestedConfig: plan.suggestedConfig,
        note: plan.sourceType === 'unavailable'
            ? 'No validation command will be executed until a repo mesh/refine config is provided. Heuristics are suggestions only.'
            : 'Validation commands are resolved from repo mesh/refine config; heuristics are suggestions only.',
    };
}

async function runMeshRefineValidationGate(
    mesh: any,
    workspace: string,
    opts?: {
        /** M2-2: persisted node bootstrap state for staleness evaluation. */
        persistedBootstrapState?: WorktreeBootstrapState | null;
        /** M2-2: called after an inherit-mode bootstrap run so the caller can persist the new state. */
        onBootstrapStateChange?: (state: WorktreeBootstrapState) => void;
    },
): Promise<MeshRefineValidationSummary> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const selection = resolveMeshRefineValidationPlan(mesh, workspace);
    const summary: MeshRefineValidationSummary = {
        status: 'skipped',
        required: true,
        commandsRun: [],
        bootstrapCommandsRun: [],
        rejectedCommands: selection.rejectedCommands,
        skippedReason: undefined,
        timeoutMs: REFINE_VALIDATION_TIMEOUT_MS,
        outputLimitBytes: REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
        configSource: selection.source,
        configSourceType: selection.sourceType,
        suggestions: selection.suggestions,
        suggestedConfig: selection.suggestedConfig,
        ...(selection.deprecationWarnings.length > 0 ? { deprecationWarnings: selection.deprecationWarnings } : {}),
    };

    if (!selection.commands.length) {
        summary.skippedReason = selection.unavailableReason || 'validation_unavailable: repo mesh/refine config did not provide executable validation.commands';
        return summary;
    }

    // ── M2-2: Bootstrap stage — refine consumes the worktree_bootstrap config
    //    instead of defining its own. Legacy validation.bootstrapCommands run
    //    only when no worktree_bootstrap config exists (deprecation path).
    let runLegacyBootstrapCommands = selection.bootstrapCommands.length > 0;
    if (selection.bootstrapMode === 'skip') {
        summary.bootstrap = { stage: 'skipped', skipped: true };
        runLegacyBootstrapCommands = false;
    } else {
        const wbLoad = loadMeshWorktreeBootstrapConfig(mesh, workspace);
        const wbUsable = !!wbLoad.config && wbLoad.sourceType !== 'invalid'
            && wbLoad.config.enabled !== false && wbLoad.config.runOnClone !== false;
        if (wbUsable) {
            runLegacyBootstrapCommands = false; // worktree_bootstrap wins over deprecated bootstrapCommands
            const evaluated = evaluateWorktreeBootstrapState(mesh, workspace, opts?.persistedBootstrapState);
            if (evaluated.status === 'ready') {
                summary.bootstrap = { stage: 'cached', status: 'ready', skipped: true, configSource: evaluated.configSource };
            } else {
                const ran = await runMeshWorktreeBootstrap(mesh, workspace);
                try { opts?.onBootstrapStateChange?.(ran); } catch { /* persistence is best-effort */ }
                if (ran.status === 'ready') {
                    summary.bootstrap = {
                        stage: 'ran',
                        status: 'ready',
                        configSource: ran.configSource,
                        ...(evaluated.staleReason ? { staleReason: evaluated.staleReason } : {}),
                        commandsRun: ran.commandsRun,
                    };
                } else {
                    summary.bootstrap = {
                        stage: 'failed',
                        status: ran.status,
                        configSource: ran.configSource,
                        error: ran.error,
                        commandsRun: ran.commandsRun,
                    };
                    summary.status = 'failed';
                    summary.failureKind = 'dependency_bootstrap_failed';
                    summary.failureCode = 'dependency_bootstrap_failed';
                    return summary;
                }
            }
        } else if (!runLegacyBootstrapCommands) {
            summary.bootstrap = { stage: 'not_configured' };
        }
    }

    const commandRecord = (candidate: MeshRefineValidationCommand, cwd: string, startedAt: number, result: any, passed: boolean, extras: Record<string, unknown> = {}) => ({
        command: candidate.command,
        args: candidate.args,
        displayCommand: candidate.displayCommand,
        category: candidate.category,
        source: candidate.source,
        cwd,
        passed,
        durationMs: Date.now() - startedAt,
        stdout: truncateValidationOutput(result?.stdout),
        stderr: truncateValidationOutput(result?.stderr || result?.message),
        ...extras,
    });
    const isPackageManagerValidation = (candidate: MeshRefineValidationCommand): boolean => {
        const command = pathBasename(candidate.command).replace(/\.(?:cmd|exe)$/i, '');
        return ['npm', 'pnpm', 'yarn', 'bun'].includes(command)
            && candidate.args.some(arg => arg === 'run' || arg === 'test' || arg === 'exec');
    };
    const dependenciesLikelyMissing = (cwd: string): boolean => {
        if (!fs.existsSync(pathJoin(cwd, 'package.json'))) return false;
        if (fs.existsSync(pathJoin(cwd, 'node_modules'))) return false;
        return ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']
            .some(lock => fs.existsSync(pathJoin(cwd, lock)));
    };

    if (runLegacyBootstrapCommands) {
        summary.bootstrap = { stage: 'legacy' };
        for (const candidate of selection.bootstrapCommands) {
            const startedAt = Date.now();
            const cwd = candidate.cwd ? pathResolve(workspace, candidate.cwd) : workspace;
            const timeout = candidate.timeoutMs || REFINE_VALIDATION_TIMEOUT_MS;
            // On win32, libuv's spawn search only appends .com/.exe (not .cmd/.bat),
            // so a bare `npm`/`npx`/`tsc` (which are .cmd shims) throws spawn ENOENT.
            // Resolve to an absolute path via the same helper the PTY path uses
            // (no-op on non-win32 and when the command is already absolute).
            const resolvedCommand = resolveWin32Executable(candidate.command);
            try {
                const result = await execFileAsync(resolvedCommand, candidate.args, {
                    cwd,
                    encoding: 'utf8',
                    timeout,
                    maxBuffer: candidate.outputLimitBytes || REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
                    env: { ...process.env, CI: process.env.CI || '1', ...(candidate.env || {}) },
                });
                summary.bootstrapCommandsRun.push(commandRecord(candidate, cwd, startedAt, result, true, { exitCode: 0 }));
            } catch (error: any) {
                const spawnResolutionFailed = isSpawnResolutionError(error);
                summary.bootstrapCommandsRun.push(commandRecord(candidate, cwd, startedAt, error, false, {
                    exitCode: typeof error?.code === 'number' ? error.code : null,
                    signal: typeof error?.signal === 'string' ? error.signal : null,
                    timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                    ...(spawnResolutionFailed
                        ? { failureKind: 'spawn_resolution_failed', resolvedCommand }
                        : { failureKind: 'dependency_bootstrap_failed' }),
                }));
                summary.bootstrap = { stage: 'failed', error: describeSpawnError(error, candidate.command, spawnResolutionFailed) };
                summary.status = 'failed';
                summary.failureKind = spawnResolutionFailed ? 'spawn_resolution_failed' : 'dependency_bootstrap_failed';
                summary.failureCode = spawnResolutionFailed ? 'spawn_resolution_failed' : 'dependency_bootstrap_failed';
                return summary;
            }
        }
    }

    for (const candidate of selection.commands) {
        const startedAt = Date.now();
        const cwd = candidate.cwd ? pathResolve(workspace, candidate.cwd) : workspace;
        const timeout = candidate.timeoutMs || REFINE_VALIDATION_TIMEOUT_MS;
        const bootstrapProvidedDependencies = summary.bootstrap?.stage === 'cached' || summary.bootstrap?.stage === 'ran' || summary.bootstrap?.stage === 'legacy';
        if (!bootstrapProvidedDependencies && isPackageManagerValidation(candidate) && dependenciesLikelyMissing(cwd)) {
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, {
                stderr: 'Dependencies appear to be missing: package.json and a lockfile are present, but node_modules is absent. Configure validation.bootstrapCommands in repo mesh/refine config if Refinery should install/bootstrap before validation.',
            }, false, {
                exitCode: null,
                skipped: true,
                failureKind: 'missing_dependencies',
            }));
            summary.status = 'failed';
            summary.failureKind = 'missing_dependencies';
            summary.failureCode = 'missing_dependencies';
            return summary;
        }
        // See the bootstrap loop above: resolve the win32 .cmd shim to an
        // absolute path before handing it to the spawn boundary.
        const resolvedCommand = resolveWin32Executable(candidate.command);
        try {
            const result = await execFileAsync(resolvedCommand, candidate.args, {
                cwd,
                encoding: 'utf8',
                timeout,
                maxBuffer: candidate.outputLimitBytes || REFINE_VALIDATION_OUTPUT_LIMIT_BYTES,
                env: { ...process.env, CI: process.env.CI || '1', ...(candidate.env || {}) },
            });
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, result, true, { exitCode: 0 }));
        } catch (error: any) {
            // ENOENT check first: a spawn-resolution failure ("spawn npm ENOENT")
            // carries no stderr and would otherwise fall through to an
            // unclassified generic failure. Classify it distinctly so the
            // coordinator surfaces the real cause (win32 .cmd resolution).
            const spawnResolutionFailed = isSpawnResolutionError(error);
            const stderr = truncateValidationOutput(error?.stderr || error?.message);
            const missingDependencyFailure = !spawnResolutionFailed
                && /Cannot find module|MODULE_NOT_FOUND|node_modules|command not found|not found/i.test(stderr);
            summary.commandsRun.push(commandRecord(candidate, cwd, startedAt, error, false, {
                exitCode: typeof error?.code === 'number' ? error.code : null,
                signal: typeof error?.signal === 'string' ? error.signal : null,
                timedOut: error?.killed === true || /timed out/i.test(String(error?.message || '')),
                ...(spawnResolutionFailed
                    ? { failureKind: 'spawn_resolution_failed', resolvedCommand }
                    : missingDependencyFailure ? { failureKind: 'missing_dependencies' } : {}),
            }));
            summary.status = 'failed';
            if (spawnResolutionFailed) {
                summary.failureKind = 'spawn_resolution_failed';
                summary.failureCode = 'spawn_resolution_failed';
                summary.spawnResolutionError = describeSpawnError(error, candidate.command, true);
            } else if (missingDependencyFailure) {
                summary.failureKind = 'missing_dependencies';
                summary.failureCode = 'missing_dependencies';
            }
            return summary;
        }
    }

    summary.status = 'passed';
    return summary;
}

function loadYamlModule(): { load: (input: string) => any; dump: (input: any, options?: Record<string, any>) => string } {
    return yaml as { load: (input: string) => any; dump: (input: any, options?: Record<string, any>) => string };
}

export function getMcpServersKey(format: MeshCoordinatorConfigFormat): 'mcpServers' | 'mcp_servers' {
    return format === 'hermes_config_yaml' ? 'mcp_servers' : 'mcpServers';
}

export function parseMeshCoordinatorMcpConfig(text: string, format: MeshCoordinatorConfigFormat): Record<string, any> {
    if (!text.trim()) return {};
    if (format === 'claude_mcp_json') return JSON.parse(text);
    const parsed = loadYamlModule().load(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function serializeMeshCoordinatorMcpConfig(config: Record<string, any>, format: MeshCoordinatorConfigFormat): string {
    if (format === 'claude_mcp_json') return JSON.stringify(config, null, 2);
    return loadYamlModule().dump(config, { noRefs: true, lineWidth: 120 });
}

function resolveHermesUserHome(): string {
    const explicitHome = process.env.HERMES_HOME?.trim();
    return explicitHome || pathJoin(homedir(), '.hermes');
}

export function loadHermesCoordinatorBaseConfig(targetConfigPath: string): { config: Record<string, any>; sourceHome: string; sourceConfigPath: string } {
    const sourceHome = resolveHermesUserHome();
    const sourceConfigPath = pathJoin(sourceHome, 'config.yaml');
    if (!fs.existsSync(sourceConfigPath)) return { config: {}, sourceHome, sourceConfigPath };
    if (pathResolve(sourceConfigPath) === pathResolve(targetConfigPath)) return { config: {}, sourceHome, sourceConfigPath };

    const parsed = parseMeshCoordinatorMcpConfig(fs.readFileSync(sourceConfigPath, 'utf-8'), 'hermes_config_yaml');
    const { mcp_servers: _mcpServers, ...baseConfig } = parsed;
    return { config: baseConfig, sourceHome, sourceConfigPath };
}

export function stripHermesCoordinatorTempModelProviderOverrides(config: Record<string, any>): Record<string, any> {
    const {
        model: _model,
        provider: _provider,
        default_model: _defaultModel,
        defaultProvider: _defaultProvider,
        default_provider: _defaultProviderSnake,
        modelProvider: _modelProvider,
        model_provider: _modelProviderSnake,
        ...sanitized
    } = config;
    const delegation = sanitized.delegation;
    if (delegation && typeof delegation === 'object' && !Array.isArray(delegation)) {
        const {
            model: _delegationModel,
            provider: _delegationProvider,
            modelProvider: _delegationModelProvider,
            model_provider: _delegationModelProviderSnake,
            ...delegationRest
        } = delegation;
        if (Object.keys(delegationRest).length > 0) {
            sanitized.delegation = delegationRest;
        } else {
            delete sanitized.delegation;
        }
    }
    return sanitized;
}

export function copyHermesCoordinatorCredentialFiles(sourceHome: string, targetHome: string) {
    if (pathResolve(sourceHome) === pathResolve(targetHome)) return;
    for (const fileName of ['.env', 'auth.json']) {
        const sourcePath = pathJoin(sourceHome, fileName);
        const targetPath = pathJoin(targetHome, fileName);
        if (!fs.existsSync(sourcePath)) continue;
        try {
            fs.copyFileSync(sourcePath, targetPath);
        } catch (error: any) {
            LOG.warn('MeshCoordinator', `Could not copy Hermes ${fileName} into isolated coordinator home: ${error?.message || error}`);
        }
    }
}

// ─── Types ───

export interface SessionHostControlPlane {
    getDiagnostics(payload?: { includeSessions?: boolean; limit?: number }): Promise<any>;
    listSessions(): Promise<any[]>;
    stopSession(sessionId: string): Promise<any>;
    deleteSession(sessionId: string, opts?: { force?: boolean }): Promise<any>;
    resumeSession(sessionId: string): Promise<any>;
    restartSession(sessionId: string): Promise<any>;
    sendSignal(sessionId: string, signal: string): Promise<any>;
    forceDetachClient(sessionId: string, clientId: string): Promise<any>;
    pruneDuplicateSessions(payload?: { providerType?: string; workspace?: string; dryRun?: boolean }): Promise<any>;
    acquireWrite(payload: { sessionId: string; clientId: string; ownerType: 'agent' | 'user'; force?: boolean }): Promise<any>;
    releaseWrite(payload: { sessionId: string; clientId: string }): Promise<any>;
}

export interface CommandRouterDeps {
    commandHandler: DaemonCommandHandler;
    cliManager: DaemonCliManager;
    cdpManagers: Map<string, DaemonCdpManager>;
    providerLoader: ProviderLoader;
    instanceManager: ProviderInstanceManager;
    /** Reference to detected IDEs array (mutable — router updates it) */
    detectedIdes: { value: any[] };
    sessionRegistry: SessionRegistry;
    /** Callback after CDP manager created (transport-specific extras) */
    onCdpManagerCreated?: (ideType: string, manager: DaemonCdpManager) => void;
    /** Callback after IDE connected (e.g., startAgentStreamPolling) */
    onIdeConnected?: () => void;
    /** Callback after status change (stop_ide, restart) */
    onStatusChange?: () => void;
    /** Callback when a mesh state is invalidated */
    onMeshStateChange?: (meshId: string) => void;
    /** Callback after chat-related commands */
    onPostChatCommand?: () => void;
    /** Get a connected CDP manager (for agent stream reset check) */
    getCdpLogFn?: (ideType: string) => (msg: string) => void;
    /** Package name for upgrade detection ('adhdev' or '@adhdev/daemon-standalone') */
    packageName?: string;
    /** Canonical daemon status identity used by snapshot commands */
    statusInstanceId?: string;
    statusVersion?: string;
    /** Session host control plane */
    sessionHostControl?: SessionHostControlPlane | null;
    /** Selected-coordinator mesh peer telemetry surface for target daemons, when supported by the runtime. */
    getMeshPeerConnectionStatus?: (daemonId: string) => Record<string, unknown> | null;
    /** Dispatch a command to a remote mesh node via P2P/relay. Injected by cloud runtime; absent in standalone. */
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface CommandRouterResult {
    success: boolean;
    [key: string]: unknown;
}

// Commands that trigger post-chat status updates
const CHAT_COMMANDS = [
    'send_chat', 'new_chat', 'switch_chat', 'set_mode',
    'change_model',
];

// [Z] Session-scoped commands that must be forwarded to the owning REMOTE worker daemon
// when their target session is not hosted on this coordinator. These are the interactive
// controlbar / modal mutations the dashboard issues against a specific session:
//   - invoke_provider_script: controlbar Model/Mode selectors run a provider script
//   - resolve_action:         approve/reject a modal prompt
//   - set_mode / change_model / set_thought_level: direct control mutations
// send_chat is intentionally NOT here — it already reaches the worker by its own route and
// double-forwarding would be redundant. read_chat is also excluded: it can serve historical
// transcript data locally and has its own inactive-session fallback in the CommandHandler.
const MESH_FORWARDABLE_SESSION_COMMANDS = new Set([
    'invoke_provider_script',
    'resolve_action',
    'set_mode',
    'change_model',
    'set_thought_level',
    // agent_command (send_chat / clear_history / stop) is session-scoped too: a command
    // explicitly naming a targetSessionId MUST reach that session wherever it lives, never a
    // different local session. Without forwarding, a misrouted/relayed send_chat for a REMOTE
    // worker session that reaches the wrong daemon used to fuzzy-inject the task body into that
    // daemon's own CLI session (TASKECHO coordinator self-echo). Forwarding to the owning daemon
    // delivers it to the real worker instead. (findAdapter is also fail-closed as the backstop.)
    'agent_command',
]);

function normalizeCommandSource(source: string): CommandLogEntry['source'] {
    switch (source) {
        case 'ws':
        case 'p2p':
        case 'ext':
        case 'api':
        case 'standalone':
            return source;
        default:
            return 'unknown';
    }
}

function normalizeCommandArgsWithInteractionId(args: any): Record<string, unknown> {
    const base = args && typeof args === 'object' ? { ...args } : {};
    if (typeof base._interactionId !== 'string' || !String(base._interactionId).trim()) {
        base._interactionId = createInteractionId();
    }
    return base;
}

/**
 * Confine a spec path to ~/.adhdev/providers, defeating both prefix-bypass
 * (e.g. ".../providers-evil") and symlink escape. Resolves the real path of
 * the *parent* directory (the file may not exist yet for writes), requires the
 * basename to be a literal `*.json`, and re-joins under the verified parent so
 * the returned path can't point outside the tree. Used by get/write_spec_source.
 */
export function normalizeStandaloneHostCommandUrl(hostAddress: string): string {
    const raw = hostAddress.trim();
    if (!raw) throw new Error('hostAddress required');
    const url = new URL(raw.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'));
    url.pathname = '/api/v1/command';
    url.search = '';
    url.hash = '';
    return url.toString();
}

export function buildMemberJoinNode(mesh: any, args: any, fallbackDaemonId?: string): Record<string, unknown> | null {
    const requestedNodeId = typeof args?.memberNodeId === 'string' ? args.memberNodeId.trim() : '';
    const explicit = args?.memberNode && typeof args.memberNode === 'object' && !Array.isArray(args.memberNode)
        ? args.memberNode as Record<string, any>
        : null;
    const configured = Array.isArray(mesh?.nodes)
        ? (requestedNodeId
            ? mesh.nodes.find((node: any) => meshNodeIdMatches(node, requestedNodeId))
            : mesh.nodes[0])
        : null;
    const source = explicit || configured;
    const workspace = typeof source?.workspace === 'string' && source.workspace.trim()
        ? source.workspace.trim()
        : typeof args?.workspace === 'string' && args.workspace.trim()
            ? args.workspace.trim()
            : process.cwd();
    if (!workspace) return null;
    const nodeId = typeof source?.id === 'string' && source.id.trim()
        ? source.id.trim()
        : typeof source?.nodeId === 'string' && source.nodeId.trim()
            ? source.nodeId.trim()
            : undefined;
    const baseOverrides = source?.userOverrides && typeof source.userOverrides === 'object' && !Array.isArray(source.userOverrides)
        ? source.userOverrides as Record<string, unknown>
        : {};
    // This payload is built ON THE MEMBER DAEMON, so process.platform/process.arch
    // are the member's OWN machine. Stamp them into userOverrides so the host
    // stores the member's real platform/arch on the node record — the coordinator's
    // buildMeshNodeCapabilityTags then advertises os=<member-os> instead of the
    // coordinator's own platform. Only fill values the operator hasn't already set.
    const userOverrides: Record<string, unknown> = {
        ...baseOverrides,
        ...(typeof baseOverrides.platform === 'string' && baseOverrides.platform.trim() ? {} : { platform: process.platform }),
        ...(typeof baseOverrides.arch === 'string' && baseOverrides.arch.trim() ? {} : { arch: process.arch }),
    };
    return {
        ...(nodeId ? { id: nodeId } : {}),
        workspace,
        ...(typeof source?.repoRoot === 'string' && source.repoRoot.trim() ? { repoRoot: source.repoRoot.trim() } : {}),
        ...(typeof source?.daemonId === 'string' && source.daemonId.trim() ? { daemonId: source.daemonId.trim() } : fallbackDaemonId ? { daemonId: fallbackDaemonId } : {}),
        ...(typeof source?.machineId === 'string' && source.machineId.trim() ? { machineId: source.machineId.trim() } : {}),
        userOverrides,
        policy: source?.policy && typeof source.policy === 'object' && !Array.isArray(source.policy) ? source.policy : {},
        role: 'member',
    };
}

export class DaemonCommandRouter {
    private deps: CommandRouterDeps;
    /** In-memory cache for cloud-originating meshes passed via inlineMesh.
     *  Allows the MCP server to query mesh data via get_mesh even when
     *  the mesh doesn't exist in the local meshes.json file. */
    private inlineMeshCache = new Map<string, any>();
    /** Tombstones for inline mesh nodes removed via remove_mesh_node, keyed by
     *  meshId → set of removed nodeIds. The dashboard keeps echoing the removed
     *  node in the inlineMesh it attaches to every command; without a tombstone,
     *  reconcileInlineMeshCache MERGEs it straight back (resurrection). A
     *  tombstoned node is skipped during reconcile only while its workspace is
     *  absent from disk — a genuine re-registration (same nodeId, workspace back
     *  on disk) clears the tombstone and merges normally, preserving clone
     *  worktree visibility and legitimate node re-creation. */
    private removedInlineMeshNodeIds = new Map<string, Set<string>>();
    /** Coordinator-owned whole-mesh aggregate status snapshots. Browser callers read this by default. */
    private aggregateMeshStatusCache = new Map<string, { builtAt: number; snapshot: any; queueRevision: string }>();
    /** Shared per-peer git_status probe dedup + recently-probed reuse gate.
     *  Spans separate mesh_status/get_mesh calls so the dashboard auto-retry
     *  loop cannot storm a slow peer with back-to-back refreshUpstream probes. */
    private meshGitProbeCache = new MeshGitProbeCache(MESH_DIRECT_PROBE_REUSE_MS);
    /** In-memory async Refinery jobs keyed by meshId:nodeId to reject/return duplicate in-flight requests. */
    private runningRefineJobs = new Map<string, MeshRefineJobHandle>();
    /** Terminal async Refinery jobs preserve a clear answer after the worktree node has been removed. */
    private terminalRefineJobs = new Map<string, MeshRefineTerminalJob>();
    /** In-memory async batch Refinery jobs keyed by meshId (one batch convergence per mesh at a time). */
    private runningRefineBatchJobs = new Map<string, MeshRefineBatchJobHandle>();
    /** Terminal async batch Refinery jobs preserve the last batch outcome for late readers. */
    private terminalRefineBatchJobs = new Map<string, MeshRefineBatchTerminalJob>();

    constructor(deps: CommandRouterDeps) {
        this.deps = deps;
    }

    private cloneJsonValue<T>(value: T): T {
        if (typeof structuredClone === 'function') return structuredClone(value);
        return JSON.parse(JSON.stringify(value)) as T;
    }

    private hydrateCachedAggregateMeshStatusFromInline(snapshot: any, mesh: any, options?: { requireDirectPeerTruth?: boolean }): any {
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

    private getCachedAggregateMeshStatus(meshId: string, mesh?: any, options?: { requireDirectPeerTruth?: boolean }): any | null {
        const cached = this.aggregateMeshStatusCache.get(meshId);
        if (!cached?.snapshot || cached.snapshot.success !== true || !Array.isArray(cached.snapshot.nodes)) return null;
        if (cached.queueRevision !== getMeshQueueRevision(meshId)) return null;
        let snapshot = this.cloneJsonValue(cached.snapshot);
        snapshot = this.hydrateCachedAggregateMeshStatusFromInline(snapshot, mesh, options);
        if (shouldRefreshStalePendingAggregate(snapshot, options)) return null;
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

    private rememberAggregateMeshStatus(meshId: string, snapshot: any, refreshReason: string): any {
        if (!snapshot || typeof snapshot !== 'object' || snapshot.success !== true || !Array.isArray(snapshot.nodes)) return snapshot;
        const builtAt = Date.now();
        const next = this.cloneJsonValue(snapshot);
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
        this.aggregateMeshStatusCache.set(meshId, { builtAt, snapshot: this.cloneJsonValue(next), queueRevision: getMeshQueueRevision(meshId) });
        return next;
    }

    public getCachedInlineMeshNodes(): any[] {
        const nodes: any[] = [];
        for (const mesh of this.inlineMeshCache.values()) {
            if (Array.isArray(mesh?.nodes)) {
                nodes.push(...mesh.nodes);
            }
        }
        return nodes;
    }

    /**
     * Resolve the REMOTE worker daemonId that owns a given session, when the session
     * belongs to a mesh node hosted on a DIFFERENT daemon than this coordinator.
     *
     * The coordinator does not host remote-worker session instances in its own
     * instanceManager/sessionRegistry — only their cached mesh-node metadata. A
     * dashboard-issued session-scoped command (invoke_provider_script / resolve_action /
     * set_mode / …) lands on the coordinator with a targetSessionId the coordinator can't
     * find locally, and without forwarding it dies as "Live session not found". send_chat
     * happens to survive (its target resolves to the worker by another route), but the
     * controlbar commands do not — so the controlbar buttons appear to do nothing.
     *
     * Mirror the existing node-level remote-forward pattern (fast_forward_mesh_node etc.):
     * scan the candidate mesh nodes for the one hosting the targetSessionId, and return its
     * daemonId when that daemonId is a remote daemon (i.e. not this coordinator's own
     * statusInstanceId). Returns undefined for a locally-hosted session (no forward — execute
     * locally as before) or when ownership can't be resolved.
     *
     * The candidate set spans BOTH the cached inline-mesh nodes and the live aggregate
     * mesh-status snapshots. The inline cache reliably carries only each node's single primary
     * session (cachedStatus.activeSession), so a worker hosting more than one session exposes its
     * non-primary sessions only on the aggregate snapshot nodes (status.activeSessions /
     * activeSessionDetails, built from live session records). collectMeshNodeHostedSessionIds does
     * the wider plural-shape scan so a controlbar/modal command targeting a non-primary remote
     * session still resolves its owner — the singular readCachedInlineMeshActiveSessions semantics
     * other consumers depend on stay untouched.
     */
    public resolveRemoteMeshSessionOwnerDaemonId(sessionId: string): string | undefined {
        const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!trimmed) return undefined;
        const selfDaemonId = this.deps.statusInstanceId;
        for (const node of this.collectMeshSessionOwnerCandidateNodes()) {
            if (!collectMeshNodeHostedSessionIds(node).has(trimmed)) continue;
            const nodeDaemonId = readMeshNodeDaemonId(readObjectRecord(node));
            // A matching node with no readable daemonId can't be attributed — keep scanning
            // the remaining candidates (e.g. the same session on an aggregate node that does
            // carry the daemonId) rather than bailing on the whole resolution.
            if (!nodeDaemonId) continue;
            // Only forward to a genuinely remote daemon. When the owning node is this
            // coordinator itself (locally hosted worker), fall through to local handling.
            // id-form robust: the node daemonId and selfDaemonId may be stored in different
            // forms of the same machine — a strict `===` would miss the self-match and forward
            // a local session to a remote form of THIS daemon (loopback).
            if (selfDaemonId && daemonIdsEquivalent(nodeDaemonId, selfDaemonId)) return undefined;
            return nodeDaemonId;
        }
        return undefined;
    }

    /**
     * Candidate nodes for remote-session owner resolution: the cached inline-mesh nodes (which
     * carry each node's primary session) plus the nodes from every cached aggregate mesh-status
     * snapshot (which carry each node's full live session list). getCachedInlineMeshNodes()
     * returns a fresh array, so appending the aggregate nodes never mutates cached state.
     */
    private collectMeshSessionOwnerCandidateNodes(): any[] {
        const nodes: any[] = this.getCachedInlineMeshNodes();
        for (const cached of this.aggregateMeshStatusCache.values()) {
            const snapshotNodes = cached?.snapshot?.nodes;
            if (Array.isArray(snapshotNodes)) nodes.push(...snapshotNodes);
        }
        return nodes;
    }

    public getCachedInlineMesh(meshId: string, inlineMesh?: unknown): any | undefined {
        if (inlineMesh && typeof inlineMesh === 'object') {
            return this.warmInlineMeshCache(meshId, inlineMesh);
        }
        return this.inlineMeshCache.get(meshId);
    }

    private warmInlineMeshCache(meshId: string, inlineMesh?: unknown): any | undefined {
        if (!inlineMesh || typeof inlineMesh !== 'object') return undefined;
        // Save-boundary node-id normalization: reconcile each node's identity so
        // `id` and `nodeId` agree before it enters the cache, so reconcile keys
        // and the round-trip through the status serializer stay form-stable.
        const sanitizedInlineMesh = this.applyInlineMeshNodeTombstones(
            meshId,
            sanitizeInlineMesh(normalizeInlineMeshNodeIdentity(inlineMesh as any)),
        );
        const cached = this.inlineMeshCache.get(meshId);
        if (cached) {
            const merged = reconcileInlineMeshCache(cached, sanitizedInlineMesh);
            this.inlineMeshCache.set(meshId, merged);
            return merged;
        }
        this.inlineMeshCache.set(meshId, sanitizedInlineMesh as any);
        return sanitizedInlineMesh as any;
    }

    private async getMeshForCommand(
        meshId: string,
        inlineMesh?: unknown,
        options?: { preferInline?: boolean },
    ): Promise<{ mesh: any; inline: boolean; source: 'inline_cache' | 'inline_bootstrap' | 'local_config' } | null> {
        // Default to inline-cache-preferred: a caller that omits the flag still sees
        // inline-cache-only (worktree clone) nodes in the resolved mesh view, closing
        // the CLAIMSTALL gap where a missed `preferInline: true` silently dropped them.
        // An explicit `preferInline: false` is still honored for any local-config-only
        // read that deliberately bypasses the inline cache.
        const preferInline = options?.preferInline !== false;
        if (preferInline) {
            const cached = this.getCachedInlineMesh(meshId);
            if (cached) {
                if (inlineMeshCarriesTransientNodeTruth(inlineMesh)) {
                    const merged = reconcileInlineMeshCache(
                        cached,
                        this.applyInlineMeshNodeTombstones(meshId, inlineMesh as any),
                    );
                    this.inlineMeshCache.set(meshId, sanitizeInlineMesh(normalizeInlineMeshNodeIdentity(merged)));
                    return { mesh: merged, inline: true, source: 'inline_cache' };
                }
                return { mesh: cached, inline: true, source: 'inline_cache' };
            }
            if (inlineMeshCarriesTransientNodeTruth(inlineMesh)) {
                this.warmInlineMeshCache(meshId, inlineMesh);
                return { mesh: inlineMesh, inline: true, source: 'inline_bootstrap' };
            }
        }
        try {
            const { getMesh } = await import('../config/mesh-config.js');
            const mesh = getMesh(meshId);
            if (mesh) return { mesh, inline: false, source: 'local_config' };
        } catch { /* fall through to inline cache */ }
        const cached = this.getCachedInlineMesh(meshId);
        if (cached) return { mesh: cached, inline: true, source: 'inline_cache' };
        const warmedInline = this.warmInlineMeshCache(meshId, inlineMesh);
        return warmedInline ? { mesh: warmedInline, inline: true, source: 'inline_bootstrap' } : null;
    }

    private invalidateAggregateMeshStatus(meshId: string): void {
        this.aggregateMeshStatusCache.delete(meshId);
        this.deps.onMeshStateChange?.(meshId);
    }

    /**
     * Build the MedFamilyContext handed to RF-ROUTER MED family handlers. Binds the
     * router-private collaborators those handlers need (mesh resolution, owner
     * gating, inline-cache mutation, worktree / session cleanup, refine job
     * starters, IDE stop/launch) plus the inline-mesh and git-probe caches. The
     * `launchIde` field closes over the freshly-built context so restart_session /
     * restart_ide invoke the IDE launch directly instead of recursing through
     * executeDaemonCommand('launch_ide').
     */
    private buildMedFamilyContext(): MedFamilyContext {
        const ctx: MedFamilyContext = {
            deps: this.deps,
            getMeshForCommand: this.getMeshForCommand.bind(this),
            getCachedInlineMesh: this.getCachedInlineMesh.bind(this),
            requireMeshHostMutationOwner: this.requireMeshHostMutationOwner.bind(this),
            invalidateAggregateMeshStatus: this.invalidateAggregateMeshStatus.bind(this),
            updateInlineMeshNode: this.updateInlineMeshNode.bind(this),
            removeInlineMeshNode: this.removeInlineMeshNode.bind(this),
            normalizeMeshSessionCleanupMode: this.normalizeMeshSessionCleanupMode.bind(this),
            cleanupMeshSessions: this.cleanupMeshSessions.bind(this),
            cleanupLocalWorktreeNode: this.cleanupLocalWorktreeNode.bind(this),
            startMeshRefineJob: this.startMeshRefineJob.bind(this),
            batchRefineMeshNodes: this.batchRefineMeshNodes.bind(this),
            startMeshRefineBatchJob: this.startMeshRefineBatchJob.bind(this),
            stopIde: this.stopIde.bind(this),
            launchIde: (args: any) => launchIde(ctx, args),
            inlineMeshCache: this.inlineMeshCache,
            meshGitProbeCache: this.meshGitProbeCache,
        };
        return ctx;
    }

    /**
     * Build the HighFamilyContext handed to RF-ROUTER HIGH family handlers. Binds
     * the router-private collaborators those handlers need (mesh resolution, the
     * aggregate-status memory cache + its bound read/write helpers, the
     * running-refine-job table, inline-mesh + git-probe caches, and the router's
     * own `execute` for the get_mesh_review_inbox mesh_status re-entry). HIGH
     * handlers reach more router-owned state than MED, but the binding shape is
     * the same: bound methods + direct field references, none reachable from
     * `deps`.
     */
    private buildHighFamilyContext(): HighFamilyContext {
        return {
            deps: this.deps,
            getMeshForCommand: this.getMeshForCommand.bind(this),
            getCachedAggregateMeshStatus: this.getCachedAggregateMeshStatus.bind(this),
            rememberAggregateMeshStatus: this.rememberAggregateMeshStatus.bind(this),
            execute: this.execute.bind(this),
            aggregateMeshStatusCache: this.aggregateMeshStatusCache,
            runningRefineJobs: this.runningRefineJobs,
            inlineMeshCache: this.inlineMeshCache,
            meshGitProbeCache: this.meshGitProbeCache,
        };
    }


    private async requireMeshHostMutationOwner(meshId: string, inlineMesh: unknown, operation: string): Promise<CommandRouterResult | null> {
        const meshRecord = await this.getMeshForCommand(meshId, inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        if (!mesh) return { success: false, error: 'Mesh not found' };
        const meshHost = resolveMeshHostStatus(mesh);
        if (!meshHost.canOwnCoordinator || !meshHost.canOwnQueue) {
            return { ...buildMeshHostRequiredFailure(mesh, operation), success: false, meshId };
        }
        return null;
    }

    private updateInlineMeshNode(meshId: string, mesh: any, node: any): void {
        const incomingId = normalizeMeshNodeId(node);
        if (!mesh || !Array.isArray(mesh.nodes) || !incomingId) return;
        const idx = mesh.nodes.findIndex((entry: any) => meshNodeIdMatches(entry, incomingId));
        if (idx >= 0) mesh.nodes[idx] = node;
        else mesh.nodes.push(node);
        mesh.updatedAt = new Date().toISOString();
        // Canonicalize node identity in place (id and nodeId kept equal): clone
        // nodes are created with `id` and re-inserted here (bypassing
        // warmInlineMeshCache), so this is a second save boundary. In-place
        // folding preserves the caller's `mesh` / nodes-array references, which
        // persistWorktreeSetupState reuses across subsequent calls.
        for (const entry of mesh.nodes) foldMeshNodeIdentityToCanonical(entry);
        this.inlineMeshCache.set(meshId, mesh);
        this.invalidateAggregateMeshStatus(meshId);
    }

    private removeInlineMeshNode(meshId: string, mesh: any, nodeId: string): boolean {
        if (!mesh || !Array.isArray(mesh.nodes)) return false;
        const idx = mesh.nodes.findIndex((entry: any) => meshNodeIdMatches(entry, nodeId));
        if (idx === -1) return false;
        const canonicalNodeId = readInlineMeshNodeId(mesh.nodes[idx]) || nodeId;
        mesh.nodes.splice(idx, 1);
        mesh.updatedAt = new Date().toISOString();
        this.inlineMeshCache.set(meshId, mesh);
        // Tombstone the removed node so the dashboard's stale inlineMesh echo does
        // not MERGE it back on the next command (see removedInlineMeshNodeIds).
        this.tombstoneRemovedInlineMeshNode(meshId, canonicalNodeId);
        if (canonicalNodeId !== nodeId) this.tombstoneRemovedInlineMeshNode(meshId, nodeId);
        this.invalidateAggregateMeshStatus(meshId);
        return true;
    }

    private tombstoneRemovedInlineMeshNode(meshId: string, nodeId: string): void {
        if (!nodeId) return;
        let set = this.removedInlineMeshNodeIds.get(meshId);
        if (!set) {
            set = new Set<string>();
            this.removedInlineMeshNodeIds.set(meshId, set);
        }
        set.add(nodeId);
    }

    /** Filter an incoming inline mesh against this mesh's tombstones before it is
     *  reconciled into the cache. A tombstoned node is dropped only while its
     *  workspace is still absent from disk; if the workspace is back (genuine
     *  re-registration), the tombstone is cleared and the node merges normally. */
    private applyInlineMeshNodeTombstones(meshId: string, incoming: any): any {
        const tombstones = this.removedInlineMeshNodeIds.get(meshId);
        if (!tombstones?.size || !incoming || typeof incoming !== 'object' || !Array.isArray(incoming.nodes)) {
            return incoming;
        }
        let dropped = false;
        const nodes = incoming.nodes.filter((node: any) => {
            const nodeId = readInlineMeshNodeId(node);
            if (!nodeId || !tombstones.has(nodeId)) return true;
            const workspace = readStringValue(node?.workspace);
            // Genuine re-registration: same nodeId, workspace back on disk →
            // clear the tombstone and let the node merge normally.
            if (workspace && fs.existsSync(workspace)) {
                tombstones.delete(nodeId);
                return true;
            }
            dropped = true;
            return false;
        });
        if (tombstones.size === 0) this.removedInlineMeshNodeIds.delete(meshId);
        if (!dropped) return incoming;
        return { ...incoming, nodes };
    }

    private normalizeMeshSessionCleanupMode(value: unknown): RepoMeshSessionCleanupMode {
        return value === 'stop'
            || value === 'delete_stopped'
            || value === 'stop_and_delete'
            || value === 'preserve'
            ? value
            : 'preserve';
    }

    private sessionMatchesMeshNode(record: any, node: any, nodeId: string, sessionIds?: Set<string>): boolean {
        const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
        if (!sessionId) return false;
        if (sessionIds?.size) return sessionIds.has(sessionId);
        const workspace = typeof node?.workspace === 'string' ? node.workspace : '';
        if (workspace && record?.workspace === workspace) return true;
        if (record?.meta?.meshNodeId === nodeId) return true;
        return false;
    }

    /**
     * Best-effort recursive removal of a managed worktree directory.
     *
     * The git-registry de-registration is the safety-critical step of worktree
     * teardown; a leftover directory must never gate dropping the node from the
     * mesh. On Windows, `fs.rmSync` can throw EINVAL/EPERM/EBUSY on submodule
     * gitlink (`.git`) files, long paths, junctions, or while a just-stopped
     * delegate session is still releasing a handle/cwd on the directory. This
     * helper absorbs those errors (never throws), with bounded retries + backoff
     * to give handles time to release, and reports whether residue remains.
     */
    private async bestEffortRemoveWorktreeDir(dir: string): Promise<{ removed: boolean; residue: boolean; error?: string }> {
        if (!dir || !fs.existsSync(dir)) return { removed: true, residue: false };
        const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
        // EINVAL is the Windows symptom for submodule gitlink residue; the rest are
        // transient lock/permission classes. None should escape as a throw here.
        const ABSORB = new Set(['EINVAL', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES', 'EMFILE', 'ENFILE']);
        let lastErr: any;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                // maxRetries/retryDelay give fs.rmSync its own internal backoff for
                // EBUSY/EPERM/ENOTEMPTY; the outer loop extends tolerance to EINVAL.
                fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                if (!fs.existsSync(dir)) return { removed: true, residue: false };
                lastErr = new Error('directory still present after rmSync');
            } catch (e: any) {
                lastErr = e;
                const code = typeof e?.code === 'string' ? e.code : '';
                if (code && !ABSORB.has(code)) {
                    // Unexpected error class — stay best-effort (no throw) but stop retrying.
                    break;
                }
            }
            await sleep(150 * (attempt + 1));
        }
        return fs.existsSync(dir)
            ? { removed: false, residue: true, error: String(lastErr?.message || lastErr || 'unknown rm error') }
            : { removed: true, residue: false };
    }

    private async cleanupLocalWorktreeNode(args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown>; recovered?: boolean; residue?: boolean; residueWarning?: string; residueError?: string } | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> }> {
        const workspace = typeof args.node?.workspace === 'string' ? args.node.workspace.trim() : '';
        if (!workspace) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_workspace',
                error: `Worktree node '${args.nodeId}' is missing workspace metadata`,
                recoveryHint: 'Inspect the mesh node record before removing it, or remove stale metadata manually only after confirming no managed worktree remains.',
            };
        }

        const worktreeExists = fs.existsSync(workspace);
        const sourceNode = args.node?.clonedFromNodeId
            ? args.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, args.node.clonedFromNodeId))
            : args.mesh?.nodes?.find((n: any) => !n.isLocalWorktree);
        const repoRoot = typeof sourceNode?.repoRoot === 'string' && sourceNode.repoRoot.trim()
            ? sourceNode.repoRoot.trim()
            : typeof sourceNode?.workspace === 'string' && sourceNode.workspace.trim()
                ? sourceNode.workspace.trim()
                : '';

        if (!worktreeExists) {
            return { success: true, skipped: true, removedPath: workspace, repoRoot: repoRoot || undefined, reason: 'worktree_path_missing' };
        }
        if (!repoRoot || !fs.existsSync(repoRoot)) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_source_repo',
                error: `Refusing to remove worktree '${workspace}' because the source repo root is unavailable`,
                recoveryHint: 'Run mesh_remove_node from the machine that owns the source repo, or verify the source node metadata before retrying.',
            };
        }
        if (typeof args.node?.worktreeBranch !== 'string' || !args.node.worktreeBranch.trim()) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_missing_branch',
                error: `Refusing to remove worktree '${workspace}' because worktreeBranch metadata is missing`,
                recoveryHint: 'Confirm this is an ADHDev-managed worktree before removing it manually; managed worktree nodes include worktreeBranch metadata.',
            };
        }

        const { resolveWorktreePath, listWorktrees, removeWorktree } = await import('../git/git-worktree.js');
        const normalizePath = (value: string) => {
            const resolved = pathResolve(value);
            try { return fs.realpathSync(resolved); } catch { return resolved; }
        };
        const expectedPath = normalizePath(resolveWorktreePath(repoRoot, String(args.mesh?.name || args.mesh?.id || 'mesh'), args.node.worktreeBranch));
        const actualPath = normalizePath(workspace);
        if (actualPath !== expectedPath) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_unexpected_path',
                error: `Refusing to remove worktree '${workspace}' because it is not at the expected managed path '${expectedPath}'`,
                recoveryHint: 'Use git worktree list/status to inspect the path. Retry only after confirming the mesh node metadata points to an ADHDev-managed worktree.',
            };
        }

        const entries = await listWorktrees(repoRoot);
        const managedEntry = entries.find(entry => normalizePath(entry.path) === actualPath);
        if (!managedEntry) {
            // Idempotent residue recovery (NOT a refusal). By this point the path is
            // already proven ADHDev-managed: worktreeBranch metadata is present and
            // actualPath === expectedPath. Git nonetheless no longer lists it as a
            // worktree. This is the post-force-fallback re-entry state — an earlier
            // removal de-registered the worktree from git but left the directory
            // behind (commonly Windows EINVAL on submodule gitlink files). Refusing
            // here would strand the node in mesh membership forever, so prune any
            // stale registration, best-effort remove the leftover directory, and
            // report success so the caller drops the node from the mesh registry.
            try {
                const { execFile } = await import('node:child_process');
                const { promisify } = await import('node:util');
                const execFileAsync = promisify(execFile);
                await execFileAsync('git', ['worktree', 'prune'], {
                    cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
                });
            } catch { /* prune is best-effort */ }
            const rm = await this.bestEffortRemoveWorktreeDir(workspace);
            return {
                success: true,
                removedPath: workspace,
                repoRoot,
                reason: 'worktree_unregistered_residue_recovered',
                recovered: true,
                ...(rm.residue ? {
                    residue: true,
                    residueWarning: `Worktree was already de-registered from git but the directory could not be fully removed (leftover residue at '${workspace}'): ${rm.error || 'unknown error'}. The node will be dropped from the mesh; remove the directory manually if needed.`,
                    residueError: rm.error,
                } : {}),
            };
        }
        if (managedEntry.branch && managedEntry.branch !== args.node.worktreeBranch) {
            return {
                success: false,
                code: 'mesh_worktree_cleanup_branch_mismatch',
                error: `Refusing to remove '${workspace}' because git reports branch '${managedEntry.branch}', expected '${args.node.worktreeBranch}'`,
                recoveryHint: 'Inspect the worktree branch and mesh metadata before retrying cleanup.',
            };
        }

        const forceFallbackConvergence = args.force
            ? { allow: true, status: 'force_override', source: 'caller_force_flag' }
            : await this.getWorktreeForceCleanupConvergence({ repoRoot, workspace, node: args.node });

        try {
            const result = await removeWorktree(repoRoot, workspace, {
                requireClean: !args.force,
                allowSubmoduleForceFallback: forceFallbackConvergence.allow,
            });
            return {
                success: true,
                removedPath: result.removedPath,
                repoRoot,
                ...(result.fallback ? {
                    fallback: result.fallback,
                    forced: result.forced,
                    reason: result.reason,
                    convergence: forceFallbackConvergence,
                } : {}),
            };
        } catch (e: any) {
            const message = String(e?.message || e || 'worktree cleanup failed');
            const dirty = message.includes('dirty worktree') || message.includes('local changes');
            const isSubmoduleGuard = /working trees containing submodules cannot be moved or removed/i.test(message);
            const submoduleForceBlocked = isSubmoduleGuard && !forceFallbackConvergence.allow;

            // Fallback 1: submodule guard on --force path — deinit submodules first, then retry remove
            if (isSubmoduleGuard && forceFallbackConvergence.allow) {
                const { execFile } = await import('node:child_process');
                const { promisify } = await import('node:util');
                const execFileAsync = promisify(execFile);
                const GIT_TIMEOUT_CLEANUP = 30_000;
                const GIT_MAX_BUFFER_CLEANUP = 4 * 1024 * 1024;
                try {
                    await execFileAsync('git', ['-C', workspace, 'submodule', 'deinit', '--all', '-f'], {
                        encoding: 'utf8', timeout: GIT_TIMEOUT_CLEANUP, maxBuffer: GIT_MAX_BUFFER_CLEANUP, windowsHide: true,
                    });
                    await execFileAsync('git', ['worktree', 'remove', '--force', workspace], {
                        cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_CLEANUP, maxBuffer: GIT_MAX_BUFFER_CLEANUP, windowsHide: true,
                    });
                    return {
                        success: true,
                        removedPath: workspace,
                        repoRoot,
                        fallback: 'git_worktree_remove_submodule_deinit' as const,
                        forced: true,
                        reason: 'working_trees_containing_submodules' as const,
                        convergence: forceFallbackConvergence,
                    };
                } catch (deinitError: any) {
                    // Fallback 2: deinit+remove still failed — best-effort directory
                    // removal + prune. The path is already proven managed/converged
                    // here, and a leftover directory must NOT gate dropping the node
                    // from the mesh, so absorb Windows EINVAL/EPERM and report success
                    // with a residue warning instead of failing the whole removal.
                    const rm = await this.bestEffortRemoveWorktreeDir(workspace);
                    try {
                        await execFileAsync('git', ['worktree', 'prune'], {
                            cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_CLEANUP, maxBuffer: GIT_MAX_BUFFER_CLEANUP, windowsHide: true,
                        });
                    } catch { /* prune is best-effort */ }
                    return {
                        success: true,
                        removedPath: workspace,
                        repoRoot,
                        fallback: 'fs_rm_worktree_prune' as const,
                        forced: true,
                        reason: 'working_trees_containing_submodules' as const,
                        convergence: forceFallbackConvergence,
                        ...(rm.residue ? {
                            residue: true,
                            residueWarning: `Worktree was de-registered from git but the directory could not be fully removed (leftover residue at '${workspace}'): ${rm.error || 'unknown error'}; deinit+remove first failed with: ${deinitError?.message || deinitError}. The node will be dropped from the mesh; remove the directory manually if needed.`,
                            residueError: rm.error,
                        } : {}),
                    };
                }
            }

            return {
                success: false,
                code: dirty
                    ? 'mesh_worktree_cleanup_dirty'
                    : submoduleForceBlocked
                        ? 'mesh_worktree_cleanup_force_fallback_blocked'
                        : 'mesh_worktree_cleanup_failed',
                error: submoduleForceBlocked
                    ? `${message}; refusing --force fallback because convergence could not be verified: ${forceFallbackConvergence.error || 'unknown convergence state'}`
                    : message,
                recoveryHint: dirty
                    ? 'Commit, stash, or intentionally discard the worktree changes before retrying mesh_remove_node. The mesh registry entry is preserved until cleanup is safe.'
                    : submoduleForceBlocked
                        ? 'Verify the worktree branch is merged/contained in the source default branch (for example origin/main) or mark the node with a safe branchConvergence final state, or pass force:true if content is confirmed already in main.'
                        : 'Inspect git worktree status/list from the source repo and retry after resolving the reported cleanup failure.',
                ...(submoduleForceBlocked ? { convergence: forceFallbackConvergence } : {}),
            };
        }
    }

    private async getWorktreeForceCleanupConvergence(args: {
        repoRoot: string;
        workspace: string;
        node: any;
    }): Promise<{ allow: boolean; status?: string; source?: string; ref?: string; error?: string }> {
        const metadataStatus = typeof args.node?.branchConvergence?.status === 'string'
            ? args.node.branchConvergence.status
            : '';
        if (metadataStatus === 'merged_to_main' || metadataStatus === 'cleanup_candidate' || metadataStatus === 'merged_pushed') {
            return { allow: true, status: metadataStatus, source: 'node_branch_convergence' };
        }

        // Also allow when the node's last recorded refine job reached final convergence merged_pushed
        const refinedConvergence = typeof args.node?.refineState?.finalBranchConvergenceState?.status === 'string'
            ? args.node.refineState.finalBranchConvergenceState.status
            : typeof args.node?.lastRefineResult?.finalBranchConvergenceState?.status === 'string'
                ? args.node.lastRefineResult.finalBranchConvergenceState.status
                : '';
        if (refinedConvergence === 'merged_pushed' || refinedConvergence === 'merged_to_main') {
            return { allow: true, status: refinedConvergence, source: 'node_refine_state' };
        }

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const runGit = async (gitArgs: string[], cwd: string): Promise<string> => {
            const { stdout } = await execFileAsync('git', gitArgs, {
                cwd,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            });
            return String(stdout || '').trim();
        };

        let head = '';
        try {
            head = await runGit(['rev-parse', 'HEAD'], args.workspace);
        } catch (e: any) {
            return { allow: false, error: `could not resolve worktree HEAD: ${e?.message || e}` };
        }
        if (!head) return { allow: false, error: 'worktree HEAD is empty' };

        const candidateRefs: string[] = [];
        try {
            const defaultBranch = await runGit(['branch', '--show-current'], args.repoRoot);
            if (defaultBranch) {
                candidateRefs.push(defaultBranch, `origin/${defaultBranch}`);
            }
        } catch { /* fall through to common refs */ }
        candidateRefs.push('origin/main', 'origin/master', 'main', 'master');

        const seen = new Set<string>();
        const checkedRefs: string[] = [];
        const resolvedRefCommits: Array<{ ref: string; commit: string }> = [];
        for (const ref of candidateRefs) {
            if (!ref || seen.has(ref)) continue;
            seen.add(ref);
            let commit = '';
            try {
                commit = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], args.repoRoot);
            } catch {
                continue;
            }
            checkedRefs.push(ref);
            resolvedRefCommits.push({ ref, commit });
            try {
                await runGit(['merge-base', '--is-ancestor', head, commit], args.repoRoot);
                return { allow: true, status: 'merged_to_default_ref', source: 'git_merge_base', ref };
            } catch {
                // Not contained in this candidate ref; keep checking other safe refs.
            }
        }

        // SHA-reachability fallback: the worktree HEAD is not an ancestor of any
        // candidate ref, but its CONTENT may already be present via cherry-pick /
        // squash / rebase (a different commit SHA carrying the same patch). The
        // Refinery accepts such patch-equivalent landings; mirror that here so the
        // cleanup guard does not falsely block a converged worktree. This is the
        // heavier merge-tree/patch-id path, so it only runs after every ancestor
        // check has already failed. Any failure stays conservative (NOT contained).
        for (const { ref, commit } of resolvedRefCommits) {
            let containment: MeshWorktreePatchContainmentSummary;
            try {
                containment = await checkWorktreeChangesPatchEquivalentInRef(args.repoRoot, commit, head);
            } catch {
                // Defensive: the helper is already exception-safe, but never let a
                // thrown error escape into an allow.
                continue;
            }
            if (containment.contained) {
                return { allow: true, status: 'patch_equivalent_to_default_ref', source: 'git_patch_equivalence', ref };
            }
        }

        return {
            allow: false,
            status: metadataStatus || undefined,
            error: checkedRefs.length
                ? `worktree HEAD is not contained in checked refs: ${checkedRefs.join(', ')}`
                : 'no default/main refs were available for convergence verification',
        };
    }

    private isCompletedHostedSession(record: any): boolean {
        return record?.lifecycle === 'stopped' || record?.lifecycle === 'failed' || record?.lifecycle === 'interrupted';
    }

    private async recordIntentionalMeshSessionStop(args: {
        meshId: string;
        nodeId: string;
        node: any;
        sessionId: string;
        mode: RepoMeshSessionCleanupMode;
        source: 'mesh_cleanup_sessions' | 'mesh_remove_node';
        action: 'stop_session' | 'delete_session_force';
    }): Promise<void> {
        try {
            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
            appendLedgerEntry(args.meshId, {
                kind: 'session_stopped',
                nodeId: args.nodeId,
                sessionId: args.sessionId,
                payload: {
                    intentional: true,
                    reason: 'operator_cleanup',
                    intentionalStopReason: 'operator_cleanup',
                    source: args.source,
                    cleanupMode: args.mode,
                    action: args.action,
                    workspace: typeof args.node?.workspace === 'string' ? args.node.workspace : undefined,
                },
            });
        } catch (e: any) {
            LOG.warn('MeshCleanup', `Failed to record intentional cleanup stop for ${args.sessionId}: ${e?.message || e}`);
        }
    }

    private async cleanupMeshSessions(args: {
        meshId: string;
        nodeId: string;
        node: any;
        mode: RepoMeshSessionCleanupMode;
        sessionIds?: string[];
        dryRun?: boolean;
        source?: 'mesh_cleanup_sessions' | 'mesh_remove_node';
    }): Promise<{ success: boolean; [key: string]: unknown }> {
        if (args.mode === 'preserve') {
            return { success: true, mode: 'preserve', matchedCount: 0, stoppedSessionIds: [], deletedSessionIds: [], skippedSessionIds: [] };
        }
        if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };

        const requestedSessionIds = Array.isArray(args.sessionIds)
            ? new Set(args.sessionIds.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean))
            : undefined;
        const sessions = await this.deps.sessionHostControl.listSessions();
        const matched = sessions.filter(record => this.sessionMatchesMeshNode(record, args.node, args.nodeId, requestedSessionIds));
        const hasExplicitSessionIds = !!requestedSessionIds?.size;
        const stoppedSessionIds: string[] = [];
        const deletedSessionIds: string[] = [];
        const skippedSessionIds: string[] = [];
        const skippedLiveSessionIds: string[] = [];
        const skippedCoordinatorSessionIds: string[] = [];
        const skippedLiveSessionReasons: Array<{ sessionId: string; reason: string }> = [];
        const actedLiveDelegateSessionIds: string[] = [];
        const deleteUnsupportedSessionIds: string[] = [];
        const recordsRemainSessionIds: string[] = [];
        const errors: Array<{ sessionId: string; error: string }> = [];
        const cleanupSource = args.source || 'mesh_cleanup_sessions';
        const markedIntentionalStopSessionIds = new Set<string>();
        const markIntentionalStop = async (sessionId: string, action: 'stop_session' | 'delete_session_force') => {
            if (args.dryRun || markedIntentionalStopSessionIds.has(sessionId)) return;
            markedIntentionalStopSessionIds.add(sessionId);
            await this.recordIntentionalMeshSessionStop({
                meshId: args.meshId,
                nodeId: args.nodeId,
                node: args.node,
                sessionId,
                mode: args.mode,
                source: cleanupSource,
                action,
            });
        };
        const matchedBySurfaceKind = {
            live_runtime: 0,
            recovery_snapshot: 0,
            inactive_record: 0,
        };

        for (const record of matched) {
            const surfaceKind = getSessionHostSurfaceKind(record);
            matchedBySurfaceKind[surfaceKind] += 1;
        }

        for (const record of matched) {
            const sessionId = String(record.sessionId);
            const completed = this.isCompletedHostedSession(record);
            const surfaceKind = getSessionHostSurfaceKind(record);
            const liveRuntime = surfaceKind === 'live_runtime';
            const coordinatorSession = readStringValue(record?.meta?.meshCoordinatorFor) === args.meshId;
            // A delegate session was launched by the coordinator specifically FOR this node
            // (meta.meshNodeId === this node). It is 1:1 bound to the node, even when the node
            // shares its daemon runtime with the main/other nodes. Removing the node should be
            // able to stop its own delegate session — the shared-daemon concern only applies to
            // sessions we matched by workspace alone (which could belong to the coordinator or to
            // a sibling node that is still active).
            const recordNodeId = readStringValue(record?.meta?.meshNodeId);
            const recordMeshNodeFor = readStringValue(record?.meta?.meshNodeFor);
            const delegateBoundToThisNode = !!recordNodeId
                && recordNodeId === args.nodeId
                && (!recordMeshNodeFor || recordMeshNodeFor === args.meshId);
            if (!hasExplicitSessionIds && coordinatorSession) {
                skippedSessionIds.push(sessionId);
                skippedCoordinatorSessionIds.push(sessionId);
                continue;
            }
            // Only the conservative shared-daemon guard for live sessions that are NOT a delegate
            // explicitly bound to this node. Delegate-bound live sessions fall through and are
            // stopped/deleted by the mode handlers below (which already record an intentional stop).
            if (!hasExplicitSessionIds && liveRuntime && !delegateBoundToThisNode) {
                skippedSessionIds.push(sessionId);
                skippedLiveSessionIds.push(sessionId);
                const matchedByWorkspaceOnly = !recordNodeId;
                const reason = recordNodeId && recordNodeId !== args.nodeId
                    ? `live_delegate_bound_to_other_node:${recordNodeId}`
                    : matchedByWorkspaceOnly
                        ? 'live_session_matched_by_workspace_only_no_node_binding'
                        : 'live_session_not_bound_to_this_node';
                skippedLiveSessionReasons.push({ sessionId, reason });
                continue;
            }
            if (!hasExplicitSessionIds && liveRuntime && delegateBoundToThisNode && args.mode === 'delete_stopped') {
                // delete_stopped never stops live runtimes by contract — even bound delegates.
                // Surface a clear reason instead of an unexplained skip so callers know to use
                // stop / stop_and_delete to release a still-running bound delegate.
                skippedSessionIds.push(sessionId);
                skippedLiveSessionIds.push(sessionId);
                skippedLiveSessionReasons.push({ sessionId, reason: 'live_delegate_preserved_by_delete_stopped_mode_use_stop_or_stop_and_delete' });
                continue;
            }
            if (!hasExplicitSessionIds && liveRuntime && delegateBoundToThisNode) {
                actedLiveDelegateSessionIds.push(sessionId);
            }
            try {
                if (args.mode === 'stop') {
                    if (!completed) {
                        if (!args.dryRun) {
                            await markIntentionalStop(sessionId, 'stop_session');
                            await this.deps.sessionHostControl.stopSession(sessionId);
                        }
                        stoppedSessionIds.push(sessionId);
                    } else {
                        skippedSessionIds.push(sessionId);
                    }
                    continue;
                }

                if (args.mode === 'delete_stopped') {
                    if (completed) {
                        if (!args.dryRun) await this.deps.sessionHostControl.deleteSession(sessionId, { force: false });
                        deletedSessionIds.push(sessionId);
                    } else {
                        skippedSessionIds.push(sessionId);
                    }
                    continue;
                }

                if (args.mode === 'stop_and_delete') {
                    if (!completed) await markIntentionalStop(sessionId, 'delete_session_force');
                    if (!args.dryRun) await this.deps.sessionHostControl.deleteSession(sessionId, { force: true });
                    deletedSessionIds.push(sessionId);
                    continue;
                }
            } catch (e: any) {
                const message = e?.message || String(e);
                if (message.includes('Unsupported session host request: delete_session')
                    && (args.mode === 'delete_stopped' || args.mode === 'stop_and_delete')) {
                    deleteUnsupportedSessionIds.push(sessionId);
                    recordsRemainSessionIds.push(sessionId);
                    if (args.mode === 'stop_and_delete' && !completed) {
                        try {
                            await markIntentionalStop(sessionId, 'stop_session');
                            await this.deps.sessionHostControl.stopSession(sessionId);
                            stoppedSessionIds.push(sessionId);
                        } catch (stopError: any) {
                            errors.push({ sessionId, error: stopError?.message || String(stopError) });
                            continue;
                        }
                    }
                    skippedSessionIds.push(sessionId);
                    continue;
                }
                errors.push({ sessionId, error: message });
            }
        }

        const deleteUnsupported = deleteUnsupportedSessionIds.length > 0;
        return {
            success: errors.length === 0,
            mode: args.mode,
            dryRun: args.dryRun === true,
            matchedCount: matched.length,
            matchedBySurfaceKind,
            stoppedSessionIds,
            deletedSessionIds,
            skippedSessionIds,
            skippedLiveSessionIds,
            skippedCoordinatorSessionIds,
            ...(actedLiveDelegateSessionIds.length ? { actedLiveDelegateSessionIds } : {}),
            ...(skippedLiveSessionReasons.length ? { skippedLiveSessionReasons } : {}),
            ...(deleteUnsupported ? {
                deleteUnsupported: true,
                effectiveCleanup: args.mode === 'stop_and_delete'
                    ? 'stopped_only_records_remain'
                    : 'delete_unsupported_records_remain',
                deleteUnsupportedSessionIds,
                recordsRemainSessionIds,
            } : {}),
            ...(errors.length ? { errors } : {}),
        };
    }
    /**
     * Unified command routing.
     * Returns result for all commands:
     *   1. Daemon-level commands (launch_ide, stop_ide, etc.)
     *   2. CLI commands (launch_cli, stop_cli, agent_command)
     *   3. DaemonCommandHandler delegation (CDP/agent-stream/file commands)
     *
     * @param cmd Command name
     * @param args Command arguments
     * @param source Log source ('ws' | 'p2p' | 'standalone' | etc.)
     */
    async execute(cmd: string, args: any, source: string = 'unknown'): Promise<CommandRouterResult> {
        const cmdStart = Date.now();
        const logSource = normalizeCommandSource(source);
        const normalizedArgs = normalizeCommandArgsWithInteractionId(args);
        const interactionId = typeof normalizedArgs._interactionId === 'string' ? normalizedArgs._interactionId : undefined;

        recordDebugTrace({
            interactionId,
            category: 'command',
            stage: 'received',
            level: 'info',
            payload: { cmd, source: logSource },
        });

        try {
            // 1. Try daemon-level command
            const daemonResult = await this.executeDaemonCommand(cmd, normalizedArgs);
            if (daemonResult) {
                logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: daemonResult.success, durationMs: Date.now() - cmdStart });
                recordDebugTrace({
                    interactionId,
                    category: 'command',
                    stage: 'completed',
                    level: daemonResult.success ? 'info' : 'warn',
                    payload: { cmd, source: logSource, success: daemonResult.success, durationMs: Date.now() - cmdStart },
                });
                return daemonResult;
            }

            // 2. Delegate to DaemonCommandHandler
            const handlerResult = await this.deps.commandHandler.handle(cmd, normalizedArgs);
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: handlerResult.success, durationMs: Date.now() - cmdStart });
            recordDebugTrace({
                interactionId,
                category: 'command',
                stage: 'completed',
                level: handlerResult.success ? 'info' : 'warn',
                payload: { cmd, source: logSource, success: handlerResult.success, durationMs: Date.now() - cmdStart },
            });

            // 3. Post-chat command callback
            if (CHAT_COMMANDS.includes(cmd) && this.deps.onPostChatCommand) {
                this.deps.onPostChatCommand();
            }

            return handlerResult;
        } catch (e: any) {
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, interactionId, args: normalizedArgs, success: false, error: e.message, durationMs: Date.now() - cmdStart });
            recordDebugTrace({
                interactionId,
                category: 'command',
                stage: 'failed',
                level: 'error',
                payload: { cmd, source: logSource, error: e?.message || String(e), durationMs: Date.now() - cmdStart },
            });
            throw e;
        }
    }


    private buildRefineJobKey(meshId: string, nodeId: string): string {
        return `${meshId}:${nodeId}`;
    }

    private buildRefineJobHandle(args: {
        meshId: string;
        nodeId: string;
        node?: any;
        status?: MeshRefineAsyncJobStatus;
        startedAt?: string;
        completedAt?: string;
        jobId?: string;
        interactionId?: string;
        retryOfJobId?: string;
        coordinatorDaemonId?: string;
    }): MeshRefineJobHandle {
        return {
            success: true,
            async: true,
            status: args.status || 'accepted',
            jobId: args.jobId || `refine_${createInteractionId()}`,
            interactionId: args.interactionId || createInteractionId(),
            meshId: args.meshId,
            nodeId: args.nodeId,
            targetNodeId: args.nodeId,
            targetDaemonId: readStringValue(args.node?.daemonId),
            workspace: readStringValue(args.node?.workspace),
            startedAt: args.startedAt || new Date().toISOString(),
            ...(args.completedAt ? { completedAt: args.completedAt } : {}),
            ...(args.retryOfJobId ? { retryOfJobId: args.retryOfJobId } : {}),
            ...(args.coordinatorDaemonId ? { targetCoordinatorDaemonId: args.coordinatorDaemonId } : {}),
            eventDelivery: { pendingEvents: true, ledger: true },
            evidence: {
                pendingEventsCommand: 'get_pending_mesh_events',
                ledgerCommand: 'get_mesh_ledger_slice',
                taskHistoryKind: args.status === 'completed' ? 'task_completed' : args.status === 'failed' ? 'task_failed' : 'task_dispatched',
            },
        };
    }

    private queueRefineJobEvent(event: 'refine:accepted' | 'refine:completed' | 'refine:failed', handle: MeshRefineJobHandle, result?: Record<string, unknown>): void {
        const metadataEvent = {
            source: 'refine_mesh_node_async_job',
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            meshId: handle.meshId,
            nodeId: handle.targetNodeId,
            targetDaemonId: handle.targetDaemonId,
            workspace: handle.workspace,
            status: handle.status,
            startedAt: handle.startedAt,
            completedAt: handle.completedAt,
            retryOfJobId: handle.retryOfJobId,
            ...(result ? { result } : {}),
        };
        const eventPayload = {
            event,
            meshId: handle.meshId,
            nodeLabel: handle.targetNodeId,
            nodeId: handle.targetNodeId,
            workspace: handle.workspace,
            metadataEvent,
            queuedAt: Date.now(),
            ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
        };
        if (typeof this.deps.instanceManager?.getByCategory === 'function') {
            const forwarded = handleMeshForwardEvent(
                { instanceManager: this.deps.instanceManager } as any,
                {
                    event,
                    meshId: handle.meshId,
                    nodeId: handle.targetNodeId,
                    workspace: handle.workspace,
                    jobId: handle.jobId,
                    interactionId: handle.interactionId,
                    status: handle.status,
                    targetDaemonId: handle.targetDaemonId,
                    startedAt: handle.startedAt,
                    completedAt: handle.completedAt,
                    retryOfJobId: handle.retryOfJobId,
                    ...(result ? { result } : {}),
                },
            );
            if (forwarded?.success === true) return;
            LOG.warn('Mesh', `[Refinery] Failed to forward async refine event ${event}: ${forwarded?.error || 'unknown error'}`);
        }
        queuePendingMeshCoordinatorEvent(eventPayload);
    }

    private async appendRefineJobLedger(kind: 'task_dispatched' | 'task_completed' | 'task_failed', handle: MeshRefineJobHandle, result?: Record<string, unknown>): Promise<void> {
        try {
            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
            appendLedgerEntry(handle.meshId, {
                kind,
                nodeId: handle.targetNodeId,
                payload: {
                    source: 'refine_mesh_node_async_job',
                    refineJob: {
                        jobId: handle.jobId,
                        interactionId: handle.interactionId,
                        status: handle.status,
                        meshId: handle.meshId,
                        nodeId: handle.targetNodeId,
                        targetDaemonId: handle.targetDaemonId,
                        targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId,
                        workspace: handle.workspace,
                        startedAt: handle.startedAt,
                        completedAt: handle.completedAt,
                        retryOfJobId: handle.retryOfJobId,
                    },
                    async: true,
                    retryOfJobId: handle.retryOfJobId,
                    ...(result ? {
                        success: result.success === true,
                        result,
                        finalBranchConvergenceState: result.finalBranchConvergenceState,
                        ...(result.blockerContext ? { blockerContext: result.blockerContext } : {}),
                    } : {}),
                },
            });
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] Failed to append async refine ledger entry: ${e?.message || e}`);
        }
    }

    /**
     * On daemon restart, scan all mesh ledgers for refine jobs that were dispatched
     * but never completed/failed (i.e. the daemon died mid-job).  Re-queue each one
     * so the job runs to completion automatically without coordinator intervention.
     */
    async resumePendingRefineJobsOnStartup(): Promise<void> {
        try {
            const { listMeshes } = await import('../config/mesh-config.js');
            const { readLedgerEntries } = await import('../mesh/mesh-ledger.js');
            const meshIds: string[] = listMeshes().map(m => m.id).filter(Boolean) as string[];
            for (const meshId of meshIds) {
                const entries = readLedgerEntries(meshId, { kind: ['task_dispatched', 'task_completed', 'task_failed'] });
                // Build set of nodeIds that already have a terminal entry.
                const terminal = new Set<string>();
                for (const e of entries) {
                    if ((e.kind === 'task_completed' || e.kind === 'task_failed') && e.nodeId) {
                        const jobId = (e.payload as any)?.refineJob?.jobId;
                        if (jobId) terminal.add(`${e.nodeId}:${jobId}`);
                    }
                }
                // Re-dispatch dispatched jobs with no matching terminal entry.
                for (const e of entries) {
                    if (e.kind !== 'task_dispatched' || !e.nodeId) continue;
                    const source = (e.payload as any)?.source;
                    if (source !== 'refine_mesh_node_async_job') continue;
                    const jobId = (e.payload as any)?.refineJob?.jobId;
                    if (!jobId || terminal.has(`${e.nodeId}:${jobId}`)) continue;
                    const key = this.buildRefineJobKey(meshId, e.nodeId);
                    if (this.runningRefineJobs.has(key)) continue;
                    const coordinatorDaemonId = (e.payload as any)?.refineJob?.targetCoordinatorDaemonId;
                    LOG.info('Mesh', `[Refinery] Auto-resuming interrupted refine job for node ${e.nodeId} (jobId=${jobId})`);
                    void this.startMeshRefineJob(meshId, e.nodeId, {
                        coordinatorDaemonId,
                    });
                }
            }
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] resumePendingRefineJobsOnStartup failed: ${e?.message || e}`);
        }
    }

    /**
     * Synchronous refinery for a single worktree node — the gate pipeline that
     * validates, preflights (patch-equivalence / submodule-reachability /
     * no-op), merges, aligns submodules, cleans up the worktree node and
     * (optionally) pushes. The body is a flat sequence of stage methods; each
     * stage either returns a terminal CommandRouterResult (gate failure or a
     * successful already-merged short-circuit) or `continue` with the extended
     * context. Behavior — stage order, every early-exit, and every result shape —
     * is identical to the previous single inlined body.
     */
    private async executeMeshRefineNodeSynchronously(meshId: string, nodeId: string, args: any): Promise<CommandRouterResult> {
        const refineStages: Array<Record<string, unknown>> = [];
        try {
            const resolved = await this.refineResolveRefsStage(meshId, nodeId, args, refineStages);
            if (resolved.kind === 'terminal') return resolved.result;
            const ctx = resolved.ctx;

            const validation = await this.refineValidationStage(ctx);
            if (validation.kind === 'terminal') return validation.result;

            const patchEquivalence = await this.refinePatchEquivalenceStage(ctx);
            if (patchEquivalence.kind === 'terminal') return patchEquivalence.result;

            const submoduleReachability = await this.refineSubmoduleReachabilityStage(ctx);
            if (submoduleReachability.kind === 'terminal') return submoduleReachability.result;

            const effectiveDiff = await this.refineEffectiveDiffStage(ctx);
            if (effectiveDiff.kind === 'terminal') return effectiveDiff.result;

            const merge = await this.refineMergeAndFinalizeStage(ctx);
            return (merge as { kind: 'terminal'; result: CommandRouterResult }).result;
        } catch (e: any) {
            return { success: false, error: e.message, refineStages };
        }
    }

    /**
     * resolve_refs stage: resolve the mesh / worktree node / source node /
     * repoRoot, then the worktree branch, base branch, fetched base head and
     * branch head. Seeds the RefineContext consumed by every later stage.
     */
    private async refineResolveRefsStage(
        meshId: string,
        nodeId: string,
        args: any,
        refineStages: Array<Record<string, unknown>>,
    ): Promise<RefineStageOutcome> {
            // preferInline: same as startMeshRefineJob — inline-cache-only clone nodes must resolve.
            const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!node) return { kind: 'terminal', result: { success: false, error: `Node '${nodeId}' not found in mesh`, refineStages } };

            if (!node.isLocalWorktree || !node.workspace) {
                return { kind: 'terminal', result: { success: false, error: `Refinery requires a local worktree node`, refineStages } };
            }

            const sourceNode = node.clonedFromNodeId
                ? mesh?.nodes.find((n: any) => meshNodeIdMatches(n, node.clonedFromNodeId))
                : mesh?.nodes.find((n: any) => !n.isLocalWorktree);
            const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
            if (!repoRoot) return { kind: 'terminal', result: { success: false, error: 'Source node repoRoot not found', refineStages } };

            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile) as unknown as RefineExecFileAsync;

            const resolveStarted = Date.now();
            const { stdout: branchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8' });
            const branch = branchStdout.trim();
            if (!branch) return { kind: 'terminal', result: { success: false, error: 'Could not determine branch of the worktree node', refineStages } };

            const { stdout: baseBranchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' });
            const baseBranch = baseBranchStdout.trim();

            // Fetch origin so baseHead reflects the latest pushed state, not a stale local HEAD.
            // This prevents patch_equivalence failures when sequential Refines push to origin/main
            // but the local main checkout hasn't been fast-forwarded yet.
            let fetchWarning: string | undefined;
            try {
                await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
            } catch (e: any) {
                fetchWarning = `git fetch origin ${baseBranch} failed (proceeding with local HEAD): ${e?.message}`;
            }

            // Prefer origin/<baseBranch> as the authoritative base; fall back to local HEAD if fetch failed.
            let baseHeadRaw: string;
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' });
                baseHeadRaw = stdout.trim();
            } catch {
                const { stdout: localHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
                baseHeadRaw = localHead.trim();
            }

            const { stdout: branchHeadStdout } = await execFileAsync('git', ['rev-parse', branch], { cwd: node.workspace, encoding: 'utf8' });
            const baseHead = baseHeadRaw;
            const branchHead = branchHeadStdout.trim();
            recordMeshRefineStage(refineStages, 'resolve_refs', 'passed', resolveStarted, { branch, baseBranch, baseHead, branchHead, ...(fetchWarning ? { fetchWarning } : {}) });

            return {
                kind: 'continue',
                ctx: {
                    meshId,
                    nodeId,
                    args,
                    refineStages,
                    execFileAsync,
                    mesh,
                    node,
                    sourceNode,
                    repoRoot,
                    branch,
                    baseBranch,
                    baseHead,
                    branchHead,
                    validationSummary: undefined as any,
                    patchEquivalence: undefined as any,
                    submoduleReachability: undefined as any,
                },
            };
    }

    /**
     * validation stage: run the refinery validation gate (typecheck / test /
     * lint / build per node config) and block on failure or when no allowlisted
     * command was available. On pass, stores the summary on the context.
     */
    private async refineValidationStage(ctx: RefineContext): Promise<RefineStageOutcome> {
            const { mesh, node, branch, baseBranch, refineStages } = ctx;
            const validationStarted = Date.now();
            const validationSummary = await runMeshRefineValidationGate(mesh, node.workspace, {
                // M2-2: consume the node's persisted bootstrap state; persist re-runs.
                persistedBootstrapState: (node as any).worktreeBootstrap as WorktreeBootstrapState | undefined,
                onBootstrapStateChange: (state) => {
                    (node as any).worktreeBootstrap = state;
                    void import('../config/mesh-config.js')
                        .then(({ updateNode }) => updateNode(mesh.id, node.id, { worktreeBootstrap: state } as any))
                        .catch(() => { /* persistence is best-effort */ });
                },
            });
            ctx.validationSummary = validationSummary;
            recordMeshRefineStage(
                refineStages,
                'validation',
                validationSummary.status === 'passed' ? 'passed' : validationSummary.status === 'failed' ? 'failed' : 'skipped',
                validationStarted,
                { validationStatus: validationSummary.status, commandsRun: validationSummary.commandsRun.length },
            );
            if (validationSummary.status === 'failed') {
                const firstFailedCmd = Array.isArray(validationSummary.commandsRun)
                    ? (validationSummary.commandsRun as Array<Record<string, unknown>>).find(c => c.success === false)
                    : undefined;
                const buildValidationFailedError = (): string => {
                    const base = validationSummary.failureCode === 'missing_dependencies'
                        ? 'Refinery validation dependencies are missing; merge/refine was not attempted. Configure validation.bootstrapCommands if Refinery should bootstrap dependencies before validation.'
                        : validationSummary.failureCode === 'dependency_bootstrap_failed'
                            ? 'Refinery dependency/bootstrap command failed; merge/refine was not attempted.'
                            : validationSummary.failureCode === 'spawn_resolution_failed'
                                ? (validationSummary.spawnResolutionError
                                    || 'Refinery validation command could not be spawned (executable not found); merge/refine was not attempted.')
                                : 'Refinery validation gate failed; merge/refine was not attempted.';
                    if (!firstFailedCmd) return base;
                    const cmdName = typeof firstFailedCmd.displayCommand === 'string' ? firstFailedCmd.displayCommand
                        : typeof firstFailedCmd.command === 'string'
                            ? [firstFailedCmd.command, ...(Array.isArray(firstFailedCmd.args) ? firstFailedCmd.args : [])].join(' ').trim()
                            : typeof firstFailedCmd.cmd === 'string' ? firstFailedCmd.cmd : '';
                    const rawOutput = [firstFailedCmd.stdout, firstFailedCmd.stderr, firstFailedCmd.output]
                        .filter(s => typeof s === 'string' && s.length > 0)
                        .join('\n');
                    const tail = rawOutput.length > 800 ? rawOutput.slice(-800) : rawOutput;
                    return [
                        base,
                        cmdName ? `First failing command: ${cmdName}` : '',
                        tail ? `Output (tail):\n${tail}` : '',
                    ].filter(Boolean).join('\n');
                };
                return { kind: 'terminal', result: {
                    success: false,
                    code: validationSummary.failureCode || 'validation_failed',
                    convergenceStatus: 'blocked_review',
                    error: buildValidationFailedError(),
                    branch,
                    into: baseBranch,
                    validationSummary,
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'failed',
                status: 'blocked_review',
                    },
                } };
            }
            if (validationSummary.status === 'skipped') {
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'validation_unavailable',
                    convergenceStatus: 'blocked_review',
                    error: 'Refinery validation gate is required but no allowlisted validation command was available; merge/refine was not attempted.',
                    branch,
                    into: baseBranch,
                    validationSummary,
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'unavailable',
                status: 'blocked_review',
                    },
                } };
            }

            return { kind: 'continue', ctx };
    }

    /**
     * patch_equivalence stage: preflight that the worktree branch's cumulative
     * patch is equivalent to base+branch. On a "behind base" branch, auto-rebase
     * once and re-check; on an empty merge-tree with real branch changes, treat as
     * already-merged-via-another-path and short-circuit to cleanup. Mutates the
     * context's branchHead (after rebase) and patchEquivalence (rebased gate).
     */
    private async refinePatchEquivalenceStage(ctx: RefineContext): Promise<RefineStageOutcome> {
            const { meshId, nodeId, args, repoRoot, baseHead, node, branch, baseBranch, validationSummary, refineStages, execFileAsync } = ctx;
            let branchHead = ctx.branchHead;
            const patchEquivalenceStarted = Date.now();
            let patchEquivalence = await runMeshRefinePatchEquivalenceGate(repoRoot, baseHead, branchHead);
            recordMeshRefineStage(refineStages, 'patch_equivalence', patchEquivalence.status, patchEquivalenceStarted, {
                equivalent: patchEquivalence.equivalent,
                expectedPatchId: patchEquivalence.expectedPatchId,
                actualPatchId: patchEquivalence.actualPatchId,
                error: patchEquivalence.error,
                actionableHint: patchEquivalence.actionableHint,
            });
            if (!patchEquivalence.equivalent) {
                // Auto-rebase: if branch is simply behind base, attempt rebase automatically before failing.
                let didAutoRebase = false;
                let isBehindBase = false;
                try {
                    execFileSync('git', ['merge-base', '--is-ancestor', branchHead, baseHead], {
                        cwd: node.workspace,
                        stdio: 'ignore',
                    });
                    isBehindBase = true;
                } catch { /* non-zero exit means branchHead is not an ancestor of baseHead */ }

                if (isBehindBase) {
                    const autoRebaseStarted = Date.now();
                    try {
                        execFileSync('git', ['rebase', baseHead], {
                            cwd: node.workspace,
                            stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        const { stdout: rebasedHeadStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: node.workspace, encoding: 'utf8' });
                        branchHead = rebasedHeadStdout.trim();
                        const rebasedPatchEquivalence = await runMeshRefinePatchEquivalenceGate(repoRoot, baseHead, branchHead);
                        recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', rebasedPatchEquivalence.status, autoRebaseStarted, {
                            equivalent: rebasedPatchEquivalence.equivalent,
                            expectedPatchId: rebasedPatchEquivalence.expectedPatchId,
                            actualPatchId: rebasedPatchEquivalence.actualPatchId,
                            error: rebasedPatchEquivalence.error,
                            rebasedBranchHead: branchHead,
                        });
                        if (rebasedPatchEquivalence.equivalent) {
                            patchEquivalence = rebasedPatchEquivalence;
                            didAutoRebase = true;
                        } else {
                            return { kind: 'terminal', result: {
                                success: false,
                                code: 'needs_rebase',
                                convergenceStatus: 'blocked_review',
                                error: 'Branch was rebased onto base but patch equivalence still failed; manual intervention required.',
                                branch,
                                into: baseBranch,
                                validationSummary,
                                patchEquivalence: rebasedPatchEquivalence,
                                refineStages,
                                finalBranchConvergenceState: {
                                    branch,
                                    baseBranch,
                                    merged: false,
                                    removed: false,
                                    validation: 'passed',
                                    patchEquivalence: 'failed',
                                    status: 'blocked_review',
                                },
                            } };
                        }
                    } catch (rebaseErr: any) {
                        try { execFileSync('git', ['rebase', '--abort'], { cwd: node.workspace, stdio: 'ignore' }); } catch { /* ignore */ }
                        recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', 'failed', autoRebaseStarted, {
                            error: rebaseErr?.message || String(rebaseErr),
                        });
                        return { kind: 'terminal', result: {
                            success: false,
                            code: 'needs_rebase_with_conflicts',
                            convergenceStatus: 'blocked_review',
                            error: 'Branch is behind base and auto-rebase failed due to conflicts; resolve conflicts manually and retry.',
                            branch,
                            into: baseBranch,
                            validationSummary,
                            patchEquivalence,
                            refineStages,
                            finalBranchConvergenceState: {
                                branch,
                                baseBranch,
                                merged: false,
                                removed: false,
                                validation: 'passed',
                                patchEquivalence: 'failed',
                                status: 'blocked_review',
                            },
                        } };
                    }
                }

                // If the actual patch-id is empty, the merge-tree produces no diff vs base —
                // meaning the branch content is already present in base (landed via a different
                // path, e.g. cherry-pick or direct commit).  Treat this as "already merged":
                // skip the merge step but still run cleanup so the worktree node is removed.
                // "already merged via another path": the branch has real changes
                // (expectedPatchId non-empty) but the merge-tree produces no diff
                // against base (actualPatchId empty) — meaning every change in the
                // branch is already present in base via a cherry-pick or direct commit.
                // If both patch-ids are empty, the branch itself has no changes; that
                // is a degenerate worktree case, not an "already merged" scenario.
                const alreadyMergedViaOtherPath = !patchEquivalence.actualPatchId && !!patchEquivalence.expectedPatchId;
                if (!didAutoRebase && !alreadyMergedViaOtherPath) {
                    return { kind: 'terminal', result: {
                        success: false,
                        code: 'patch_equivalence_failed',
                        convergenceStatus: 'blocked_review',
                        error: 'Refinery patch-equivalence preflight failed; merge/refine was not attempted.',
                        branch,
                        into: baseBranch,
                        validationSummary,
                        patchEquivalence,
                        refineStages,
                        finalBranchConvergenceState: {
                            branch,
                            baseBranch,
                            merged: false,
                            removed: false,
                            validation: 'passed',
                            patchEquivalence: 'failed',
                            status: 'blocked_review',
                        },
                    } };
                }

                if (!didAutoRebase && alreadyMergedViaOtherPath) {
                    // Content already in base — skip merge, go straight to cleanup.
                    recordMeshRefineStage(refineStages, 'merge', 'skipped', Date.now(), {
                        reason: 'already_merged_via_other_path',
                        note: 'actualPatchId is empty; branch content is already present in base via a different commit path',
                    });
                    const cleanupStarted = Date.now();
                    const removeResult = await this.execute('remove_mesh_node', {
                        meshId,
                        nodeId,
                        sessionCleanupMode: 'preserve',
                        inlineMesh: args?.inlineMesh,
                    });
                    recordMeshRefineStage(refineStages, 'cleanup', removeResult?.success === false ? 'failed' : 'passed', cleanupStarted, {
                        removed: removeResult?.removed,
                        code: removeResult?.code,
                        error: removeResult?.error,
                    });
                    try {
                        const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'node_removed',
                            nodeId,
                            payload: { alreadyMergedViaOtherPath: true, branch, into: baseBranch, validationSummary, patchEquivalence },
                        });
                    } catch { /* ledger append is best-effort */ }
                    return { kind: 'terminal', result: {
                        success: removeResult?.success !== false,
                        code: 'already_merged',
                        merged: false,
                        alreadyMergedViaOtherPath: true,
                        branch,
                        into: baseBranch,
                        removeResult,
                        validationSummary,
                        patchEquivalence,
                        refineStages,
                        finalBranchConvergenceState: {
                            branch: baseBranch,
                            mergedBranch: branch,
                            baseBranch,
                            merged: false,
                            alreadyMergedViaOtherPath: true,
                            removed: removeResult?.success !== false,
                            validation: 'passed',
                            patchEquivalence: 'already_merged',
                            status: removeResult?.success === false ? 'merged_cleanup_failed' : 'merged_to_main',
                        },
                    } };
                }
            }

            ctx.branchHead = branchHead;
            ctx.patchEquivalence = patchEquivalence;
            return { kind: 'continue', ctx };
    }

    /**
     * submodule_reachability stage: verify every submodule gitlink commit that
     * would land via the merge is reachable from its configured remote main
     * branch (optionally auto-publishing when policy allows). Blocks the merge
     * when any commit is unreachable. Stores the result on the context.
     */
    private async refineSubmoduleReachabilityStage(ctx: RefineContext): Promise<RefineStageOutcome> {
            const { mesh, node, repoRoot, branch, baseBranch, branchHead, validationSummary, patchEquivalence, refineStages } = ctx;
            const submoduleReachabilityStarted = Date.now();
            const autoPublishSubmoduleMainCommits = resolveRefineryAutoPublishSubmoduleMainCommits(mesh, node.workspace);
            const submoduleReachability = await runMeshRefineSubmoduleReachabilityGate(repoRoot, patchEquivalence.mergedTree || branchHead, {
                allowAutoPublishSubmoduleMainCommits: autoPublishSubmoduleMainCommits.enabled,
                autoPublishPolicySource: autoPublishSubmoduleMainCommits.source,
                worktreeRoot: node.workspace,
            });
            recordMeshRefineStage(refineStages, 'submodule_reachability', submoduleReachability.status, submoduleReachabilityStarted, {
                checked: submoduleReachability.checked,
                autoPublishAllowed: submoduleReachability.autoPublishAllowed,
                autoPublishPolicySource: submoduleReachability.autoPublishPolicySource,
                autoPublished: submoduleReachability.entries
                    .filter(entry => entry.autoPublishAttempted)
                    .map(entry => ({
                        path: entry.path,
                        commit: entry.commit,
                        remote: entry.remote,
                        remoteUrl: entry.remoteUrl,
                        remoteMainBranch: entry.remoteMainBranch,
                        refspec: entry.autoPublishRefspec,
                        succeeded: entry.autoPublishSucceeded,
                        verified: entry.autoPublishVerified,
                        remoteMainReachable: entry.remoteMainReachable,
                        error: entry.error,
                    })),
                autoPublishSkipped: submoduleReachability.entries
                    .filter(entry => entry.autoPublishAllowed === true && entry.autoPublishAttempted !== true)
                    .map(entry => ({
                        path: entry.path,
                        commit: entry.commit,
                        remote: entry.remote,
                        remoteUrl: entry.remoteUrl,
                        remoteMainBranch: entry.remoteMainBranch,
                        reason: entry.autoPublishSkippedReason || entry.error || 'auto-publish was allowed but no publish attempt was possible',
                    })),
                unreachable: submoduleReachability.unreachable.map(entry => ({
                    path: entry.path,
                    commit: entry.commit,
                    publishRequired: entry.publishRequired === true,
                    autoPublishAllowed: entry.autoPublishAllowed,
                    autoPublishAttempted: entry.autoPublishAttempted,
                    autoPublishSucceeded: entry.autoPublishSucceeded,
                        autoPublishVerified: entry.autoPublishVerified,
                        autoPublishRefspec: entry.autoPublishRefspec,
                        autoPublishSkippedReason: entry.autoPublishSkippedReason,
                        remote: entry.remote,
                    remoteUrl: entry.remoteUrl,
                    remoteReachable: entry.remoteReachable,
                    remoteMainBranch: entry.remoteMainBranch,
                    remoteMainReachable: entry.remoteMainReachable,
                    error: entry.error,
                })),
                error: submoduleReachability.error,
            });
            if (submoduleReachability.status === 'failed') {
                const nextStep = buildSubmodulePublishRequiredNextStep(submoduleReachability.unreachable);
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'submodule_reachability_failed',
                    convergenceStatus: 'blocked_review',
                    publishRequired: true,
                    blockedReason: 'submodule_publish_required',
                    error: 'Refinery submodule reachability preflight failed because one or more submodule gitlink commits are not reachable from their configured remote main branch; merge/refine cleanup was not attempted.',
                    nextStep,
                    nextSteps: [
                        'Ask the user for explicit approval before pushing or publishing any submodule commit.',
                        'Push/publish each unreachable submodule commit to the configured submodule remote main branch shown in the evidence.',
                        'Rerun mesh_refine_node after remote reachability is confirmed.',
                        'Do not merge the root branch until every submodule gitlink commit is reachable from submodule origin/main.',
                    ],
                    unreachableSubmoduleCommits: submoduleReachability.unreachable.map(entry => ({
                        path: entry.path,
                        commit: entry.commit,
                        remote: entry.remote,
                        remoteUrl: entry.remoteUrl,
                        remoteReachable: entry.remoteReachable,
                        remoteMainBranch: entry.remoteMainBranch,
                        remoteMainReachable: entry.remoteMainReachable,
                        autoPublishAllowed: entry.autoPublishAllowed,
                        autoPublishAttempted: entry.autoPublishAttempted,
                        autoPublishSucceeded: entry.autoPublishSucceeded,
                        autoPublishVerified: entry.autoPublishVerified,
                        autoPublishRefspec: entry.autoPublishRefspec,
                        autoPublishSkippedReason: entry.autoPublishSkippedReason,
                        error: entry.error,
                    })),
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'passed',
                patchEquivalence: 'passed',
                submoduleReachability: 'failed',
                status: 'blocked_review',
                reason: 'submodule_publish_required',
                nextStep,
                    },
                } };
            }

            ctx.submoduleReachability = submoduleReachability;
            return { kind: 'continue', ctx };
    }

    /**
     * effective_diff stage (no-op guard): block a silent no-op merge where the
     * branch produces no effective root-tree diff against base — typically a
     * submodule that has commits but whose root-level gitlink (pointer) bump was
     * never committed, so the merge would land nothing real on main.
     */
    private async refineEffectiveDiffStage(ctx: RefineContext): Promise<RefineStageOutcome> {
            const { repoRoot, baseHead, branchHead, branch, baseBranch, validationSummary, patchEquivalence, refineStages } = ctx;
            // No-op guard: block a silent no-op merge where the root tree is identical to base.
            // This catches the trap where a submodule has commits but the root branch never
            // committed the gitlink (oss-pointer) bump — merging would report success while the
            // real change never lands on main. A committed gitlink bump shows up in the root
            // diff, so legitimate oss-pointer refines pass through untouched.
            const effectiveDiffStarted = Date.now();
            const effectiveDiff = await runMeshRefineEffectiveDiffGate(repoRoot, baseHead, branchHead);
            recordMeshRefineStage(refineStages, 'effective_diff', effectiveDiff.status, effectiveDiffStarted, {
                hasEffectiveDiff: effectiveDiff.hasEffectiveDiff,
                changedPaths: effectiveDiff.changedPaths,
                submoduleHints: effectiveDiff.submoduleHints,
                ...(effectiveDiff.error ? { error: effectiveDiff.error } : {}),
            });
            if (effectiveDiff.status === 'failed' && !effectiveDiff.hasEffectiveDiff) {
                const hintLines = (effectiveDiff.submoduleHints || []).map(h => `  - ${h.path}: ${h.reason}`);
                const message = [
                    `Refinery no-op guard: branch '${branch}' has no effective root-tree diff against '${baseBranch}' (${baseHead.slice(0, 12)}); nothing would merge.`,
                    'This usually means a submodule (e.g. oss) has commits but the root branch never committed the gitlink (pointer) bump, so the merge would be a silent no-op while the real change never reaches main.',
                    hintLines.length ? `Submodules with uncommitted pointer bumps:\n${hintLines.join('\n')}` : '',
                    `Fix: commit the submodule pointer bump on '${branch}' (git add <submodule-path> && git commit), then re-run refine.`,
                ].filter(Boolean).join('\n');
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'no_effective_diff',
                    convergenceStatus: 'blocked_review',
                    error: message,
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    effectiveDiff,
                    refineStages,
                    finalBranchConvergenceState: {
                        branch,
                        baseBranch,
                        merged: false,
                        removed: false,
                        validation: 'passed',
                        patchEquivalence: 'passed',
                        effectiveDiff: 'no_effective_diff',
                        status: 'blocked_review',
                        reason: 'no_effective_diff',
                        ...(effectiveDiff.submoduleHints?.length ? { submoduleHints: effectiveDiff.submoduleHints } : {}),
                    },
                } };
            }

            return { kind: 'continue', ctx };
    }

    /**
     * merge + finalize stage: perform the --no-ff merge, align submodule
     * checkouts after merge, clean up (remove) the worktree node per policy,
     * append the refinery ledger entry, and (unless approval is required) push the
     * base branch. Always terminal — produces the final CommandRouterResult.
     */
    private async refineMergeAndFinalizeStage(ctx: RefineContext): Promise<RefineStageOutcome> {
            const { meshId, nodeId, args, repoRoot, baseHead, node, branch, baseBranch, sourceNode, validationSummary, patchEquivalence, submoduleReachability, mesh, refineStages, execFileAsync } = ctx;
            let mergeResult: Record<string, unknown> | undefined;
            const mergeStarted = Date.now();
            try {
                const result = await execFileAsync('git', ['merge', '--no-ff', branch, '-m', `Auto-merge branch '${branch}' via Refinery`], { cwd: repoRoot, encoding: 'utf8' });
                mergeResult = {
                    stdout: truncateValidationOutput(result.stdout),
                    stderr: truncateValidationOutput(result.stderr),
                    durationMs: Date.now() - mergeStarted,
                };
                recordMeshRefineStage(refineStages, 'merge', 'passed', mergeStarted, mergeResult);
            } catch (e: any) {
                recordMeshRefineStage(refineStages, 'merge', 'failed', mergeStarted, {
                    error: e?.message || String(e),
                    stdout: truncateValidationOutput(e?.stdout),
                    stderr: truncateValidationOutput(e?.stderr),
                });
                return { kind: 'terminal', result: {
                    success: false,
                    error: `Merge failed (conflicts?): ${e.message}`,
                    validationSummary,
                    patchEquivalence,
                    refineStages,
                    finalBranchConvergenceState: {
                branch,
                baseBranch,
                merged: false,
                removed: false,
                validation: 'passed',
                patchEquivalence: 'passed',
                status: 'not_mergeable',
                    },
                } };
            }

            const submoduleAlignmentStarted = Date.now();
            const submoduleAlignment = await alignRefinerySubmodulesAfterMerge(repoRoot, baseHead, 'HEAD', {
                submoduleIgnorePaths: Array.isArray(sourceNode?.policy?.submoduleIgnorePaths)
                    ? sourceNode.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
                    : undefined,
            });
            if (submoduleAlignment.status !== 'skipped') {
                recordMeshRefineStage(refineStages, 'submodule_alignment', submoduleAlignment.status, submoduleAlignmentStarted, {
                    changedGitlinkPaths: submoduleAlignment.changedGitlinkPaths,
                    outOfSyncPaths: submoduleAlignment.outOfSyncPaths,
                    updatedPaths: submoduleAlignment.updatedPaths,
                    verifiedPaths: submoduleAlignment.verifiedPaths,
                    command: submoduleAlignment.command,
                    error: submoduleAlignment.error,
                });
            }
            if (submoduleAlignment.status === 'failed') {
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'post_merge_submodule_alignment_failed',
                    error: 'Refinery merge completed but post-merge submodule checkout alignment failed; run the reported git submodule update command and re-check base workspace status.',
                    merged: true,
                    branch,
                    into: baseBranch,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    submoduleAlignment,
                    mergeResult,
                    refineStages,
                    finalBranchConvergenceState: {
                branch: baseBranch,
                mergedBranch: branch,
                baseBranch,
                merged: true,
                removed: false,
                validation: 'passed',
                patchEquivalence: 'passed',
                submoduleReachability: 'passed',
                submoduleAlignment: 'failed',
                status: 'post_merge_alignment_failed',
                nextStep: submoduleAlignment.command || 'Run git submodule update --init --recursive for the reported path(s), then re-check base workspace status.',
                    },
                } };
            }

            const cleanupStarted = Date.now();
            // Honor the mesh policy for delegated-session cleanup on the auto-removed
            // worktree node (previously hardcoded to 'preserve', which orphaned the
            // delegate session as an idle record on the coordinator daemon). Fall back
            // to 'preserve' when no policy is set.
            const refineSessionCleanupMode = this.normalizeMeshSessionCleanupMode(
                mesh?.policy?.sessionCleanupOnNodeRemove,
            );
            // The delegate session launched for a clone worktree is frequently matched
            // by workspace ONLY (no meta.meshNodeId binding), which remove_mesh_node's
            // shared-daemon guard skips. Since refine knows exactly which workspace it
            // just merged, collect that workspace's live session ids explicitly and pass
            // them through — explicit sessionIds bypass the workspace-only-match guard so
            // the policy-driven stop/delete actually runs.
            let refineSessionIds: string[] | undefined;
            if (refineSessionCleanupMode !== 'preserve' && this.deps.sessionHostControl) {
                try {
                    const liveSessions = await this.deps.sessionHostControl.listSessions();
                    const workspace = typeof node.workspace === 'string' ? node.workspace : '';
                    refineSessionIds = liveSessions
                        .filter((record: any) => {
                            const sid = typeof record?.sessionId === 'string' ? record.sessionId : '';
                            if (!sid) return false;
                            // Never sweep the coordinator's own session for this mesh.
                            if (readStringValue(record?.meta?.meshCoordinatorFor) === meshId) return false;
                            const boundToNode = readStringValue(record?.meta?.meshNodeId) === nodeId;
                            const matchedByWorkspace = !!workspace && record?.workspace === workspace;
                            return boundToNode || matchedByWorkspace;
                        })
                        .map((record: any) => String(record.sessionId));
                } catch {
                    // listSessions failure is non-fatal — fall back to the policy-mode
                    // cleanup without explicit ids (still better than hardcoded preserve).
                    refineSessionIds = undefined;
                }
            }
            const removeResult = await this.execute('remove_mesh_node', {
                meshId,
                nodeId,
                sessionCleanupMode: refineSessionCleanupMode,
                ...(refineSessionIds && refineSessionIds.length > 0 ? { sessionIds: refineSessionIds } : {}),
                inlineMesh: args?.inlineMesh,
            });
            recordMeshRefineStage(refineStages, 'cleanup', removeResult?.success === false ? 'failed' : 'passed', cleanupStarted, {
                removed: removeResult?.removed,
                code: removeResult?.code,
                error: removeResult?.error,
            });

            let ledgerError: string | undefined;
            const ledgerStarted = Date.now();
            try {
                const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                appendLedgerEntry(meshId, {
                    kind: 'node_removed',
                    nodeId,
                    payload: { refined: true, mergedBranch: branch, into: baseBranch, validationSummary, patchEquivalence, submoduleReachability, submoduleAlignment },
                });
                recordMeshRefineStage(refineStages, 'ledger', 'passed', ledgerStarted);
            } catch (e: any) {
                ledgerError = e?.message || String(e);
                recordMeshRefineStage(refineStages, 'ledger', 'failed', ledgerStarted, { error: ledgerError });
            }

            const finalBranchConvergenceState = {
                branch: baseBranch,
                mergedBranch: branch,
                baseBranch,
                merged: true,
                removed: removeResult?.success !== false,
                validation: 'passed',
                patchEquivalence: 'passed',
                submoduleAlignment: submoduleAlignment.status,
                status: removeResult?.success === false ? 'merged_cleanup_failed' : 'merged',
            };

            if (removeResult?.success === false) {
                return { kind: 'terminal', result: {
                    success: false,
                    code: 'cleanup_failed',
                    error: 'Refinery merge completed but worktree cleanup failed; manual cleanup/retry is required.',
                    merged: true,
                    branch,
                    into: baseBranch,
                    removeResult,
                    validationSummary,
                    patchEquivalence,
                    submoduleReachability,
                    submoduleAlignment,
                    mergeResult,
                    refineStages,
                    ...(ledgerError ? { ledgerError } : {}),
                    finalBranchConvergenceState,
                } };
            }

            // Push logic: after a successful merge, either auto-push or surface push info
            // so coordinators don't need manual discovery after each refine.
            const requireApprovalForPush: boolean = (mesh as any)?.policy?.requireApprovalForPush ?? DEFAULT_MESH_POLICY.requireApprovalForPush;
            let pushResult: Record<string, unknown> | undefined;
            if (!requireApprovalForPush) {
                const pushStarted = Date.now();
                try {
                    await execFileAsync('git', ['push', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
                    pushResult = { pushed: true, remote: 'origin', branch: baseBranch, durationMs: Date.now() - pushStarted };
                    recordMeshRefineStage(refineStages, 'push', 'passed', pushStarted, pushResult);
                    finalBranchConvergenceState.status = 'merged_pushed';
                } catch (e: any) {
                    pushResult = {
                        pushed: false,
                        remote: 'origin',
                        branch: baseBranch,
                        error: e?.message || String(e),
                        stderr: e?.stderr,
                        durationMs: Date.now() - pushStarted,
                    };
                    recordMeshRefineStage(refineStages, 'push', 'failed', pushStarted, pushResult);
                }
            }

            return { kind: 'terminal', result: {
                success: true,
                merged: true,
                branch,
                into: baseBranch,
                removeResult,
                validationSummary,
                patchEquivalence,
                submoduleReachability,
                submoduleAlignment,
                mergeResult,
                refineStages,
                ...(ledgerError ? { ledgerError } : {}),
                finalBranchConvergenceState,
                // Push outcome or readiness info for coordinator.
                ...(pushResult
                    ? { pushResult }
                    : {
                        pushReady: true,
                        pushCommand: `git push origin ${baseBranch}`,
                        pushNote: 'requireApprovalForPush is enabled — run the push command or obtain user approval before pushing.',
                    }),
            } };
    }

    /**
     * Batch refinery: converge multiple sibling worktree nodes onto the base branch
     * in one sequential pipeline, absorbing the rebase + patch-equivalence churn that
     * arises when several siblings touch the same submodule.
     *
     * Reuses executeMeshRefineNodeSynchronously per node — every node goes through the
     * exact same validation / patch-equivalence / submodule-reachability / merge / cleanup
     * gates, including its built-in auto-rebase onto fresh origin/<base>. Because each
     * node fetches origin/<base> at the start of its own refine, a node merged earlier in
     * the batch advances the base, and the next node's refine auto-rebases onto it before
     * re-running patch-equivalence. No force-push, no reset — conflicting nodes are
     * isolated as blocked_review while the rest of the batch proceeds.
     */
    private async batchRefineMeshNodes(meshId: string, requestedNodeIds: string[] | undefined, args: any): Promise<CommandRouterResult> {
        // preferInline: same membership authority as refine_mesh_node — inline-cache-only
        // clone nodes (created in this MCP session) must resolve.
        const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        if (!mesh) return { success: false, error: `Mesh '${meshId}' not found` };

        const allNodes: any[] = Array.isArray(mesh.nodes) ? mesh.nodes : [];
        const isConvergeable = (n: any) => n?.isLocalWorktree && typeof n.workspace === 'string' && n.workspace;

        let targetNodes: any[];
        if (Array.isArray(requestedNodeIds) && requestedNodeIds.length > 0) {
            targetNodes = [];
            const missing: string[] = [];
            const nonWorktree: string[] = [];
            for (const nodeId of requestedNodeIds) {
                const node = allNodes.find(n => meshNodeIdMatches(n, nodeId));
                if (!node) { missing.push(nodeId); continue; }
                if (!isConvergeable(node)) { nonWorktree.push(nodeId); continue; }
                targetNodes.push(node);
            }
            if (missing.length || nonWorktree.length) {
                return {
                    success: false,
                    error: 'One or more requested nodes are not convergeable local worktree nodes.',
                    ...(missing.length ? { missingNodeIds: missing } : {}),
                    ...(nonWorktree.length ? { nonWorktreeNodeIds: nonWorktree } : {}),
                };
            }
        } else {
            // Auto-collect: every local worktree node is a convergence candidate.
            targetNodes = allNodes.filter(isConvergeable);
        }

        if (targetNodes.length === 0) {
            return { success: true, batch: true, dryRun: args?.dryRun !== false, nodeCount: 0, order: [], results: [], note: 'No convergeable local worktree nodes found.' };
        }

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        // Resolve the base repo root and a base ref to analyze change areas against.
        const resolveRepoRootFor = (node: any): string | undefined => {
            const sourceNode = node.clonedFromNodeId
                ? allNodes.find(n => meshNodeIdMatches(n, node.clonedFromNodeId))
                : allNodes.find(n => !n.isLocalWorktree);
            return sourceNode?.repoRoot || sourceNode?.workspace;
        };

        // Analyze change areas for ordering. The repoRoot is shared across siblings of
        // the same source; resolve a base ref (origin/<base> preferred) once per repoRoot.
        const repoRootBaseRef = new Map<string, string>();
        const submodulePathsByRepoRoot = new Map<string, Set<string>>();
        const resolveBaseRef = async (repoRoot: string): Promise<string> => {
            const cached = repoRootBaseRef.get(repoRoot);
            if (cached) return cached;
            let baseBranch = 'main';
            try {
                const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' });
                if (stdout.trim()) baseBranch = stdout.trim();
            } catch { /* fall back to main */ }
            let baseRef = 'HEAD';
            try {
                await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot, encoding: 'utf8' });
            } catch { /* offline / no remote — fall through to local refs */ }
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${baseBranch}`], { cwd: repoRoot, encoding: 'utf8' });
                baseRef = stdout.trim();
            } catch {
                try {
                    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
                    baseRef = stdout.trim();
                } catch { /* leave HEAD */ }
            }
            repoRootBaseRef.set(repoRoot, baseRef);
            return baseRef;
        };

        const changeAreas: Array<Awaited<ReturnType<typeof analyzeMeshRefineNodeChangeArea>>> = [];
        for (const node of targetNodes) {
            const repoRoot = resolveRepoRootFor(node);
            let branch = typeof node.worktreeBranch === 'string' ? node.worktreeBranch : '';
            try {
                const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8' });
                if (stdout.trim()) branch = stdout.trim();
            } catch { /* use stored worktreeBranch */ }

            if (!repoRoot || !branch) {
                changeAreas.push({
                    nodeId: node.id, workspace: node.workspace, branch: branch || '(unknown)',
                    changedTopLevelPaths: [], changedFiles: [], touchedSubmodulePaths: [],
                    touchesSubmodule: false, aheadCount: 0,
                    error: !repoRoot ? 'source repoRoot not found' : 'branch not resolved',
                });
                continue;
            }
            if (!submodulePathsByRepoRoot.has(repoRoot)) {
                // Resolve declared submodule paths once per repo root.
                let subPaths = new Set<string>();
                try {
                    const { stdout } = await execFileAsync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], { cwd: repoRoot, encoding: 'utf8' });
                    for (const line of stdout.split('\n')) {
                        const trimmed = line.trim();
                        const spaceIdx = trimmed.indexOf(' ');
                        if (spaceIdx === -1) continue;
                        const value = trimmed.slice(spaceIdx + 1).trim();
                        if (value) subPaths.add(value);
                    }
                } catch { subPaths = new Set(); }
                submodulePathsByRepoRoot.set(repoRoot, subPaths);
            }
            const baseRef = await resolveBaseRef(repoRoot);
            let branchRef = branch;
            try {
                const { stdout } = await execFileAsync('git', ['rev-parse', branch], { cwd: node.workspace, encoding: 'utf8' });
                branchRef = stdout.trim() || branch;
            } catch { /* use branch name */ }
            changeAreas.push(await analyzeMeshRefineNodeChangeArea({
                nodeId: node.id,
                workspace: node.workspace,
                branch,
                baseRef,
                branchRef,
                diffCwd: node.workspace,
                submodulePaths: submodulePathsByRepoRoot.get(repoRoot)!,
            }));
        }

        const ordering = orderMeshRefineBatchNodes(changeAreas);
        const orderedNodes = ordering.order
            .map(nodeId => targetNodes.find(n => meshNodeIdMatches(n, nodeId)))
            .filter((n): n is any => !!n);

        const dryRun = args?.dryRun !== false && args?.execute !== true;
        if (dryRun) {
            return {
                success: true,
                batch: true,
                dryRun: true,
                nodeCount: orderedNodes.length,
                order: ordering.order,
                orderingRationale: ordering.rationale,
                changeAreas: ordering.changeAreas,
                plan: orderedNodes.map(node => ({
                    nodeId: node.id,
                    workspace: node.workspace,
                    validationPlan: buildMeshRefineValidationPlan(mesh, node.workspace),
                    mergeWillRun: false,
                })),
                note: 'Dry-run: no validation, rebase, or merge was executed. Re-run with execute=true to converge nodes in this order.',
            };
        }

        // Execute: refine each node in order via the shared convergence core.
        return this.runMeshRefineBatchConvergence(meshId, orderedNodes, ordering, args);
    }

    /**
     * Convergence core shared by the synchronous batch entry and the async batch job.
     * Refines each node in order: the per-node refine pipeline fetches origin/<base>
     * fresh, so each merged sibling advances the base before the next node's auto-rebase
     * + patch-equivalence re-check. A blocked/failed node is isolated; the batch
     * continues with the remaining nodes. Does NOT touch the per-node merge logic — it
     * only sequences calls to executeMeshRefineNodeSynchronously and aggregates outcomes.
     */
    private async runMeshRefineBatchConvergence(
        meshId: string,
        orderedNodes: any[],
        ordering: { order: string[]; rationale?: unknown },
        args: any,
    ): Promise<CommandRouterResult> {
        type BatchNodeOutcome = {
            nodeId: string;
            workspace: string;
            convergence: 'merged_to_main' | 'blocked_review' | 'skipped_patch_equivalent' | 'not_mergeable';
            code?: string;
            reason?: string;
            stage?: string;
            error?: string;
            finalBranchConvergenceState?: Record<string, unknown>;
        };
        const results: BatchNodeOutcome[] = [];
        for (const node of orderedNodes) {
            let result: Record<string, unknown>;
            try {
                result = await this.executeMeshRefineNodeSynchronously(meshId, node.id, args) as Record<string, unknown>;
            } catch (e: any) {
                result = { success: false, error: e?.message || String(e) };
            }
            const code = typeof result.code === 'string' ? result.code : '';
            // already_merged (branch content already on base via another path) is a
            // non-error skip regardless of success flag — the worktree converges with
            // no new merge. A real `git merge` conflict surfaces as merge_failed →
            // not_mergeable. Everything else that failed is isolated as blocked_review.
            let convergence: BatchNodeOutcome['convergence'];
            if (code === 'already_merged' && result.alreadyMergedViaOtherPath) {
                convergence = 'skipped_patch_equivalent';
            } else if (result.success === true) {
                convergence = 'merged_to_main';
            } else if (code === 'merge_failed') {
                convergence = 'not_mergeable';
            } else {
                convergence = 'blocked_review';
            }
            const fbcs = (result.finalBranchConvergenceState && typeof result.finalBranchConvergenceState === 'object')
                ? result.finalBranchConvergenceState as Record<string, unknown>
                : undefined;
            const stage = Array.isArray(result.refineStages)
                ? (result.refineStages as Array<Record<string, unknown>>).filter(s => s.status === 'failed').map(s => s.stage).filter(Boolean).pop() as string | undefined
                : undefined;
            results.push({
                nodeId: node.id,
                workspace: node.workspace,
                convergence,
                ...(code ? { code } : {}),
                ...(typeof result.blockedReason === 'string' ? { reason: result.blockedReason } : {}),
                ...(stage ? { stage } : {}),
                ...(typeof result.error === 'string' ? { error: result.error } : {}),
                ...(fbcs ? { finalBranchConvergenceState: fbcs } : {}),
            });
        }

        const summary = {
            merged: results.filter(r => r.convergence === 'merged_to_main').length,
            skipped: results.filter(r => r.convergence === 'skipped_patch_equivalent').length,
            blocked: results.filter(r => r.convergence === 'blocked_review').length,
            notMergeable: results.filter(r => r.convergence === 'not_mergeable').length,
        };
        const allConverged = summary.blocked === 0 && summary.notMergeable === 0;
        return {
            success: true,
            batch: true,
            dryRun: false,
            nodeCount: orderedNodes.length,
            order: ordering.order,
            orderingRationale: ordering.rationale,
            summary,
            allConverged,
            results,
            ...(allConverged ? {} : {
                nextStep: 'Resolve blocked_review / not_mergeable nodes manually (see per-node code/stage/error), then re-run mesh_refine_batch for the remaining nodes.',
            }),
        };
    }

    private buildRefineBatchJobKey(meshId: string): string {
        return `${meshId}::batch`;
    }

    private buildRefineBatchJobHandle(args: {
        meshId: string;
        nodeIds: string[];
        order: string[];
        status?: MeshRefineBatchJobStatus;
        startedAt?: string;
        completedAt?: string;
        jobId?: string;
        interactionId?: string;
        coordinatorDaemonId?: string;
    }): MeshRefineBatchJobHandle {
        return {
            success: true,
            async: true,
            batch: true,
            status: args.status || 'accepted',
            jobId: args.jobId || `refine_batch_${createInteractionId()}`,
            interactionId: args.interactionId || createInteractionId(),
            meshId: args.meshId,
            batchLabel: `batch:${args.nodeIds.length} node${args.nodeIds.length === 1 ? '' : 's'}`,
            nodeIds: args.nodeIds,
            nodeCount: args.nodeIds.length,
            order: args.order,
            startedAt: args.startedAt || new Date().toISOString(),
            ...(args.completedAt ? { completedAt: args.completedAt } : {}),
            ...(args.coordinatorDaemonId ? { targetCoordinatorDaemonId: args.coordinatorDaemonId } : {}),
            eventDelivery: { pendingEvents: true, ledger: true },
            evidence: {
                pendingEventsCommand: 'get_pending_mesh_events',
                ledgerCommand: 'get_mesh_ledger_slice',
                taskHistoryKind: args.status === 'completed' ? 'task_completed' : args.status === 'failed' ? 'task_failed' : 'task_dispatched',
            },
        };
    }

    /**
     * Emit a batch Refinery terminal/accepted event through the SAME pending-event +
     * forward mechanism single-node refine uses (queueRefineJobEvent), so the
     * coordinator's existing refine:accepted/completed/failed handling and message
     * renderer apply unchanged. The aggregate per-node results ride along in `result`.
     */
    private queueRefineBatchJobEvent(
        event: 'refine:accepted' | 'refine:completed' | 'refine:failed',
        handle: MeshRefineBatchJobHandle,
        result?: Record<string, unknown>,
    ): void {
        const metadataEvent = {
            source: 'refine_mesh_node_async_job',
            batch: true,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            meshId: handle.meshId,
            nodeId: handle.batchLabel,
            nodeIds: handle.nodeIds,
            workspace: undefined,
            status: handle.status,
            startedAt: handle.startedAt,
            completedAt: handle.completedAt,
            order: handle.order,
            ...(result ? { result } : {}),
        };
        const eventPayload = {
            event,
            meshId: handle.meshId,
            nodeLabel: handle.batchLabel,
            nodeId: handle.batchLabel,
            metadataEvent,
            queuedAt: Date.now(),
            ...(handle.targetCoordinatorDaemonId ? { targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId } : {}),
        };
        if (typeof this.deps.instanceManager?.getByCategory === 'function') {
            const forwarded = handleMeshForwardEvent(
                { instanceManager: this.deps.instanceManager } as any,
                {
                    event,
                    meshId: handle.meshId,
                    nodeId: handle.batchLabel,
                    jobId: handle.jobId,
                    interactionId: handle.interactionId,
                    status: handle.status,
                    startedAt: handle.startedAt,
                    completedAt: handle.completedAt,
                    ...(result ? { result } : {}),
                },
            );
            if (forwarded?.success === true) return;
            LOG.warn('Mesh', `[Refinery] Failed to forward async refine batch event ${event}: ${forwarded?.error || 'unknown error'}`);
        }
        queuePendingMeshCoordinatorEvent(eventPayload);
    }

    private async appendRefineBatchJobLedger(
        kind: 'task_dispatched' | 'task_completed' | 'task_failed',
        handle: MeshRefineBatchJobHandle,
        result?: Record<string, unknown>,
    ): Promise<void> {
        try {
            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
            appendLedgerEntry(handle.meshId, {
                kind,
                nodeId: handle.batchLabel,
                payload: {
                    source: 'refine_mesh_node_async_job',
                    refineJob: {
                        batch: true,
                        jobId: handle.jobId,
                        interactionId: handle.interactionId,
                        status: handle.status,
                        meshId: handle.meshId,
                        nodeIds: handle.nodeIds,
                        order: handle.order,
                        targetCoordinatorDaemonId: handle.targetCoordinatorDaemonId,
                        startedAt: handle.startedAt,
                        completedAt: handle.completedAt,
                    },
                    async: true,
                    batch: true,
                    ...(result ? {
                        success: result.success === true,
                        result,
                    } : {}),
                },
            });
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] Failed to append async refine batch ledger entry: ${e?.message || e}`);
        }
    }

    private async finishMeshRefineBatchJob(
        handle: MeshRefineBatchJobHandle,
        orderedNodes: any[],
        ordering: { order: string[]; rationale?: unknown },
        args: any,
    ): Promise<void> {
        const key = this.buildRefineBatchJobKey(handle.meshId);
        let result: Record<string, unknown>;
        try {
            result = await this.runMeshRefineBatchConvergence(handle.meshId, orderedNodes, ordering, args) as Record<string, unknown>;
        } catch (e: any) {
            result = { success: false, error: e?.message || String(e), batch: true };
        }
        const completedAt = new Date().toISOString();

        // The batch as a whole "completed" only when every node converged (no blocked /
        // not_mergeable). A partial batch is reported as a terminal failure so the
        // coordinator inspects the per-node blockers rather than assuming a clean merge.
        const summary = (result.summary && typeof result.summary === 'object') ? result.summary as Record<string, number> : undefined;
        const allConverged = result.allConverged === true;
        const isTerminalSuccess = result.success === true && allConverged;

        const nextStep = typeof result.nextStep === 'string' && result.nextStep
            ? result.nextStep
            : isTerminalSuccess
                ? 'All batched nodes converged onto base. Continue from the updated mesh state.'
                : 'Resolve blocked_review / not_mergeable nodes (see per-node code/stage/error in result.results), then re-run mesh_refine_batch for the remaining nodes.';
        const normalizedResult = {
            ...result,
            batch: true,
            nextStep,
            ...(summary ? {
                convergenceStatus: allConverged ? 'all_converged' : 'partial',
            } : {}),
        };

        const terminalHandle = this.buildRefineBatchJobHandle({
            meshId: handle.meshId,
            nodeIds: handle.nodeIds,
            order: handle.order,
            status: isTerminalSuccess ? 'completed' : 'failed',
            startedAt: handle.startedAt,
            completedAt,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
        });
        const terminal: MeshRefineBatchTerminalJob = { ...terminalHandle, result: normalizedResult };
        this.terminalRefineBatchJobs.set(key, terminal);
        this.runningRefineBatchJobs.delete(key);
        this.invalidateAggregateMeshStatus(handle.meshId);
        await this.appendRefineBatchJobLedger(isTerminalSuccess ? 'task_completed' : 'task_failed', terminalHandle, normalizedResult);
        this.queueRefineBatchJobEvent(isTerminalSuccess ? 'refine:completed' : 'refine:failed', terminalHandle, normalizedResult);
    }

    /**
     * Async entry for the batch Refinery execute path. Mirrors startMeshRefineJob:
     * resolves the plan synchronously (so target/ordering errors and the dry-run shape
     * stay synchronous), then for execute=true registers an in-flight batch job, returns
     * {async:true, status:'accepted', batch:true, ...plan} immediately, and runs the
     * convergence loop in the background — emitting the same terminal refine event.
     * Idempotent: a batch already in flight for this mesh returns the running handle
     * with duplicate:true rather than spawning a second background job.
     */
    private async startMeshRefineBatchJob(meshId: string, requestedNodeIds: string[] | undefined, args: any): Promise<CommandRouterResult> {
        // Resolve the plan up-front. For dry-run this returns the synchronous plan; for
        // execute it returns the same plan shape but we hand convergence to the bg job.
        const plan = await this.batchRefineMeshNodes(meshId, requestedNodeIds, { ...args, dryRun: true, execute: false });
        const planRecord = plan as Record<string, unknown>;
        if (planRecord.success !== true) return plan;

        // If the caller actually asked for a dry-run, return the plan as-is (sync).
        if (args?.dryRun === true && args?.execute !== true) return plan;

        const order = Array.isArray(planRecord.order) ? (planRecord.order as unknown[]).filter((v): v is string => typeof v === 'string') : [];
        const nodeIds = order.slice();
        if (nodeIds.length === 0) {
            // No convergeable nodes — nothing to dispatch; return the empty plan synchronously.
            return { ...planRecord, success: true, batch: true, dryRun: false, async: false };
        }

        const key = this.buildRefineBatchJobKey(meshId);
        const running = this.runningRefineBatchJobs.get(key);
        if (running) return { ...running, duplicate: true };

        // Re-resolve the ordered node objects against current membership so the bg job
        // refines real nodes (the plan only carries ids). preferInline matches refine_mesh_node.
        const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const allNodes: any[] = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
        const orderedNodes = nodeIds
            .map(id => allNodes.find(n => meshNodeIdMatches(n, id)))
            .filter((n): n is any => !!n);
        if (orderedNodes.length === 0) {
            return { success: false, error: 'Batch nodes no longer resolvable in mesh', batch: true };
        }
        const ordering = {
            order,
            rationale: planRecord.orderingRationale,
        };

        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : (this.deps.statusInstanceId || undefined);
        const handle = this.buildRefineBatchJobHandle({ meshId, nodeIds, order, coordinatorDaemonId });
        this.runningRefineBatchJobs.set(key, handle);
        await this.appendRefineBatchJobLedger('task_dispatched', handle);
        this.queueRefineBatchJobEvent('refine:accepted', handle);

        setImmediate(() => {
            void this.finishMeshRefineBatchJob(handle, orderedNodes, ordering, args);
        });

        // Return the accepted handle plus the plan so the coordinator sees the target set.
        return {
            ...handle,
            order,
            orderingRationale: planRecord.orderingRationale,
            plan: planRecord.plan,
            note: 'Batch convergence accepted and running in the background. Completion/failure (with per-node results) will be delivered as a terminal refine event; do not poll repeatedly.',
        };
    }

    private async finishMeshRefineJob(handle: MeshRefineJobHandle, args: any): Promise<void> {
        const key = this.buildRefineJobKey(handle.meshId, handle.targetNodeId);
        let result: Record<string, unknown>;
        try {
            result = await this.executeMeshRefineNodeSynchronously(handle.meshId, handle.targetNodeId, args) as Record<string, unknown>;
        } catch (e: any) {
            result = { success: false, error: e?.message || String(e) };
        }
        const completedAt = new Date().toISOString();

        // B1: Discriminated terminal status — do not rely solely on result.success.
        // Map known failure codes to structured terminal kinds.
        type RefineTerminalKind = 'completed' | 'blocked_review' | 'validation_failed' | 'submodule_reachability_failed' | 'merge_failed' | 'cleanup_failed';
        const refineCode = typeof result.code === 'string' ? result.code : '';
        const refineTerminalKind: RefineTerminalKind = result.success === true
            ? 'completed'
            : refineCode === 'blocked_review'
                ? 'blocked_review'
                : refineCode === 'validation_failed' || refineCode === 'validation_dependencies_missing'
                    ? 'validation_failed'
                    : refineCode === 'submodule_reachability_failed'
                        ? 'submodule_reachability_failed'
                        : refineCode === 'merge_failed' || refineCode === 'patch_equivalence_failed' || refineCode === 'needs_rebase' || refineCode === 'needs_rebase_with_conflicts'
                            ? 'merge_failed'
                            : refineCode === 'cleanup_failed'
                                ? 'cleanup_failed'
                                : 'merge_failed'; // fallback for unclassified failures
        const isTerminalSuccess = refineTerminalKind === 'completed';

        // Build structured blocker context for task_failed ledger entries so coordinators
        // can inspect the failure cause without parsing free-form error strings.
        const blockerContext: Record<string, unknown> | undefined = isTerminalSuccess ? undefined : (() => {
            const code = typeof result.code === 'string' ? result.code : refineTerminalKind;
            const stage = refineTerminalKind === 'validation_failed' ? 'validation'
                : refineTerminalKind === 'submodule_reachability_failed' ? 'submodule_reachability'
                : refineCode === 'patch_equivalence_failed' ? 'patch_equivalence'
                : refineCode === 'needs_rebase' || refineCode === 'needs_rebase_with_conflicts' ? 'patch_equivalence'
                : refineTerminalKind === 'merge_failed' ? 'merge'
                : refineTerminalKind === 'cleanup_failed' ? 'cleanup'
                : 'unknown';
            const ctx: Record<string, unknown> = {
                stage,
                reason: code,
                terminalKind: refineTerminalKind,
            };
            if (typeof result.error === 'string') ctx.error = result.error;
            if (typeof result.blockedReason === 'string') ctx.blockedReason = result.blockedReason;
            // Patch equivalence details
            if (stage === 'patch_equivalence' && result.patchEquivalence) {
                const pe = result.patchEquivalence as Record<string, unknown>;
                ctx.details = {
                    expectedPatchId: pe.expectedPatchId,
                    actualPatchId: pe.actualPatchId,
                    status: pe.status,
                    actionableHint: pe.actionableHint,
                    error: pe.error,
                };
            }
            // Submodule reachability details
            if (stage === 'submodule_reachability' && Array.isArray(result.unreachableSubmoduleCommits)) {
                ctx.details = {
                    unreachableCount: (result.unreachableSubmoduleCommits as unknown[]).length,
                    paths: (result.unreachableSubmoduleCommits as Array<Record<string, unknown>>).map(e => e.path),
                    autoPublishAllowed: (result.unreachableSubmoduleCommits as Array<Record<string, unknown>>)[0]?.autoPublishAllowed,
                };
            }
            // Validation details
            if (stage === 'validation' && result.validationSummary) {
                const vs = result.validationSummary as Record<string, unknown>;
                ctx.details = {
                    failureCode: vs.failureCode,
                    commandsRun: Array.isArray(vs.commandsRun) ? vs.commandsRun.length : undefined,
                };
            }
            return ctx;
        })();

        const normalizedResult = {
            ...result,
            terminalKind: refineTerminalKind,
            ...(blockerContext ? { blockerContext } : {}),
            ...(result.nextStep === undefined && !isTerminalSuccess ? {
                nextStep: refineTerminalKind === 'blocked_review'
                    ? 'Request user review/approval before attempting to merge again.'
                    : refineTerminalKind === 'validation_failed'
                        ? 'Fix failing tests or configure validation.bootstrapCommands and retry mesh_refine_node.'
                        : refineTerminalKind === 'submodule_reachability_failed'
                            ? 'Push unreachable submodule commits to origin/main, then retry mesh_refine_node.'
                            : refineTerminalKind === 'merge_failed'
                                ? 'Resolve merge conflicts or patch equivalence issues, then retry mesh_refine_node.'
                                : refineTerminalKind === 'cleanup_failed'
                                    ? 'Manually remove the worktree and retry or use mesh_remove_node.'
                                    : 'Inspect refineStages for the failing stage and retry.',
            } : {}),
        };

        const terminalHandle = this.buildRefineJobHandle({
            meshId: handle.meshId,
            nodeId: handle.targetNodeId,
            status: isTerminalSuccess ? 'completed' : 'failed',
            startedAt: handle.startedAt,
            completedAt,
            jobId: handle.jobId,
            interactionId: handle.interactionId,
            retryOfJobId: handle.retryOfJobId,
            node: { daemonId: handle.targetDaemonId, workspace: handle.workspace },
            coordinatorDaemonId: handle.targetCoordinatorDaemonId,
        });
        const terminal: MeshRefineTerminalJob = { ...terminalHandle, result: normalizedResult };
        this.terminalRefineJobs.set(key, terminal);
        this.runningRefineJobs.delete(key);
        this.invalidateAggregateMeshStatus(handle.meshId);
        await this.appendRefineJobLedger(isTerminalSuccess ? 'task_completed' : 'task_failed', terminalHandle, normalizedResult);
        this.queueRefineJobEvent(isTerminalSuccess ? 'refine:completed' : 'refine:failed', terminalHandle, normalizedResult);
    }

    private async startMeshRefineJob(meshId: string, nodeId: string, args: any): Promise<CommandRouterResult> {
        const key = this.buildRefineJobKey(meshId, nodeId);
        const running = this.runningRefineJobs.get(key);
        if (running) return { ...running, duplicate: true };
        const terminal = this.terminalRefineJobs.get(key);

        // preferInline so inline-cache-only clone worktree nodes resolve — same
        // membership authority as clone_mesh_node / get_mesh. Without it refine reads
        // config-first and misses nodes that only live in the inline cache.
        const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
        const mesh = meshRecord?.mesh;
        const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
        if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };
        if (!node.isLocalWorktree || !node.workspace) return { success: false, error: `Refinery requires a local worktree node` };

        // Capture the caller's coordinator daemon ID so completed/failed events are
        // scoped to that coordinator's pending-events queue and survive daemon restarts.
        const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
            ? args.coordinatorDaemonId.trim()
            : (this.deps.statusInstanceId || undefined);
        const handle = this.buildRefineJobHandle({ meshId, nodeId, node, retryOfJobId: terminal?.jobId, coordinatorDaemonId });
        this.runningRefineJobs.set(key, handle);
        await this.appendRefineJobLedger('task_dispatched', handle);
        this.queueRefineJobEvent('refine:accepted', handle);

        setImmediate(() => {
            void this.finishMeshRefineJob(handle, args);
        });

        return handle;
    }

    // ─── Daemon-level command core ───────────────────

    /**
     * Daemon-level command execution (IDE start/stop/restart, CLI, detect, logs).
     * Returns null if not handled at this level → caller delegates to CommandHandler.
     */
    private async executeDaemonCommand(cmd: string, args: any): Promise<CommandRouterResult | null> {
        // [Z] Remote mesh worker session-scoped command forward.
        //
        // Session-scoped commands issued from the dashboard (the controlbar Model/Mode
        // selectors → invoke_provider_script, and modal approval → resolve_action, plus the
        // direct set_mode/change_model/set_thought_level mutations) target a session by
        // targetSessionId. agent_command (send_chat / clear_history / stop) is included for the
        // same reason: a command naming a session must reach THAT session, never a different
        // local one. When that session is a mesh worker hosted on a REMOTE daemon, this
        // coordinator never holds its live instance, so the CommandHandler delegation would
        // fail with "Live session not found" — or, for agent_command, findAdapter would have
        // fuzzy-injected the message into the coordinator's own CLI session (TASKECHO). Forward
        // to the owning worker daemon — the same daemon that already executes send_chat for that
        // session — so the command acts on the real worker. _meshDirectDispatch prevents
        // re-forwarding once the call lands on the owning daemon (it then handles the session
        // locally). A locally-hosted worker (or any session this coordinator owns) resolves to
        // undefined below and falls through to normal local handling — no regression.
        if (MESH_FORWARDABLE_SESSION_COMMANDS.has(cmd) && this.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
            const targetSessionId = readStringValue(args?.targetSessionId, args?.sessionId, args?.instanceId);
            if (targetSessionId) {
                const localInstance = this.deps.instanceManager?.getInstance(targetSessionId);
                const localRegistry = this.deps.sessionRegistry?.get?.(targetSessionId);
                if (!localInstance && !localRegistry) {
                    const ownerDaemonId = this.resolveRemoteMeshSessionOwnerDaemonId(targetSessionId);
                    if (ownerDaemonId) {
                        LOG.info('Mesh', `[Mesh] Forwarding session-scoped '${cmd}' for remote worker session ${targetSessionId.split('_')[0]} → daemon ${ownerDaemonId.slice(0, 12)}`);
                        const forwarded = await this.deps.dispatchMeshCommand(ownerDaemonId, cmd, {
                            ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                            _meshDirectDispatch: true,
                        });
                        return (forwarded ?? { success: false, error: 'no response from remote worker daemon' }) as CommandRouterResult;
                    }
                }
            }
        }

        // RF-ROUTER LOW family: low-coupling commands (session-host control, spec
        // provider-dev, refine/change-impact config) are handled by the registry
        // before the switch. A hit returns the same CommandRouterResult the inlined
        // case used to; a miss falls through to the switch unchanged.
        const lowFamilyHandler = lowFamilyRegistry.get(cmd);
        if (lowFamilyHandler) {
            return await lowFamilyHandler({
                deps: this.deps,
                getMeshForCommand: this.getMeshForCommand.bind(this),
            }, args);
        }

        // RF-ROUTER MED family: medium-coupling commands (CLI/ACP agent, IDE
        // lifecycle, mesh CRUD, mesh queue, mesh host pairing, fast-forward /
        // refine convergence) are handled by the registry after the LOW family and
        // before the switch. Unlike LOW handlers, MED handlers need router-private
        // collaborators, so the context carries bound methods + the inline-mesh /
        // git-probe caches + the launchIde helper (which breaks the original
        // launch_ide ↔ restart_* self-recursion). A hit returns the same
        // CommandRouterResult the inlined case used to; a miss falls through.
        const medFamilyHandler = medFamilyRegistry.get(cmd);
        if (medFamilyHandler) {
            return await medFamilyHandler(this.buildMedFamilyContext(), args);
        }

        // RF-ROUTER HIGH family: high-coupling commands (mesh coordinator-event
        // relay + interactive prompt, mesh coordinator launch, mesh aggregate
        // status + review inbox) are handled by the registry after the LOW and
        // MED families and before the (now empty) switch. HIGH handlers reach the
        // most router-owned state — the aggregate-status memory cache and the
        // running-refine-job table — so the context carries those plus bound
        // read/write helpers and the router's own `execute` (the
        // get_mesh_review_inbox mesh_status re-entry). A hit returns the same
        // CommandRouterResult the inlined case used to; a miss falls through to
        // CommandHandler delegation.
        const highFamilyHandler = highFamilyRegistry.get(cmd);
        if (highFamilyHandler) {
            return await highFamilyHandler(this.buildHighFamilyContext(), args);
        }

        return null; // Not handled at this level → delegate to CommandHandler
    }

    /**
     * IDE stop: CDP disconnect + InstanceManager cleanup + optionally kill OS process
     */
    private async stopIde(ideType: string, killProcess: boolean = false): Promise<void> {
        // 1. Release CDP manager(s) — handle multi-instance (e.g. "cursor" and "cursor_workspace")
        const cdpKeysToRemove: string[] = [];
        for (const key of this.deps.cdpManagers.keys()) {
            if (key === ideType || key.startsWith(`${ideType}_`)) {
                cdpKeysToRemove.push(key);
            }
        }
        for (const key of cdpKeysToRemove) {
            const cdp = this.deps.cdpManagers.get(key);
            if (cdp) {
                try { cdp.disconnect(); } catch { /* noop */ }
                this.deps.cdpManagers.delete(key);
                this.deps.sessionRegistry.unregisterByManagerKey(key);
                LOG.info('StopIDE', `CDP disconnected: ${key}`);
            }
        }

        // 2. Remove IDE instance(s) from InstanceManager
        const keysToRemove: string[] = [];
        for (const key of this.deps.instanceManager.listInstanceIds()) {
            if (key === `ide:${ideType}` || (typeof key === 'string' && key.startsWith(`ide:${ideType}_`))) {
                keysToRemove.push(key);
            }
        }
        for (const instanceKey of keysToRemove) {
            if (this.deps.instanceManager.getInstance(instanceKey)) {
                this.deps.instanceManager.removeInstance(instanceKey);
                LOG.info('StopIDE', `Instance removed: ${instanceKey}`);
            }
        }
        // Fallback: single instance key
        if (keysToRemove.length === 0) {
            const instanceKey = `ide:${ideType}`;
            if (this.deps.instanceManager.getInstance(instanceKey)) {
                this.deps.instanceManager.removeInstance(instanceKey);
                LOG.info('StopIDE', `Instance removed: ${instanceKey}`);
            }
        }

        // 3. Kill OS process if requested
        if (killProcess) {
            const running = await isIdeRunning(ideType);
            if (running) {
                LOG.info('StopIDE', `Killing IDE process: ${ideType}`);
                const killed = await killIdeProcess(ideType);
                if (killed) {
                    LOG.info('StopIDE', `✅ Process killed: ${ideType}`);
                } else {
                    LOG.warn('StopIDE', `⚠ Could not kill process: ${ideType} (may need manual intervention)`);
                }
            } else {
                LOG.info('StopIDE', `Process not running: ${ideType}`);
            }
        }

        // 4. Notify consumer for status update
        this.deps.onStatusChange?.();
        LOG.info('StopIDE', `IDE stopped: ${ideType} (processKill=${killProcess})`);
    }
}
