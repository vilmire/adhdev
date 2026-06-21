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
import { DaemonCliManager } from './cli-manager.js';
import { supportsExplicitSessionResume } from './cli-manager.js';
import type { HostedCliRuntimeDescriptor } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { launchWithCdp, killIdeProcess, isIdeRunning } from '../launch.js';
import { loadConfig, saveConfig, updateConfig } from '../config/config.js';
import { loadState, saveState } from '../config/state-store.js';
import { resolveIdeLaunchWorkspace } from '../config/workspaces.js';
import { appendRecentActivity, getRecentActivity, markSessionSeen, dismissSessionNotification, markSessionNotificationUnread } from '../config/recent-activity.js';
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
} from '@adhdev/mesh-shared';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { logCommand } from '../logging/command-log.js';
import type { CommandLogEntry } from '../logging/command-log.js';
import * as yaml from 'js-yaml';
import { getRecentLogs, LOG_PATH } from '../logging/logger.js';
import { readDaemonLogTail, MAX_TAIL_BYTES } from '../logging/log-tail-reader.js';
import { redactLogLines } from '../logging/log-redactor.js';
import { createInteractionId, getRecentDebugTrace, recordDebugTrace } from '../logging/debug-trace.js';
import { getSessionHostSurfaceKind, partitionSessionHostRecords } from '../session-host/runtime-surface.js';
import { createHermesManualMeshCoordinatorSetup, resolveMeshCoordinatorSetup } from './mesh-coordinator.js';
import { buildSessionEntries } from '../status/builders.js';
import { registerMeshCoordinator, getCoordinatorForSession } from '../mesh/coordinator-registry.js';
import { handleMeshForwardEvent, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents, queuePendingMeshCoordinatorEvent, type PendingMeshCoordinatorEvent } from '../mesh/mesh-events.js';
import { getRecentUnroutableDeliveries } from '../mesh/mesh-routing.js';
import { buildMeshWorkerRelayStamp } from '../mesh/mesh-events-utils.js';
import { buildMeshHostRequiredFailure, normalizeMeshDaemonRole, resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { fastForwardMeshNode } from '../mesh/mesh-fast-forward.js';
import { analyzeMeshRefineNodeChangeArea, orderMeshRefineBatchNodes } from '../mesh/mesh-refine-batch.js';
import { buildPreviewFreshness } from '../mesh/preview-freshness.js';
import { buildMeshAsyncRefineJobs } from '../mesh/mesh-refine-status.js';
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
import { buildMachineInfo, buildStatusSnapshot } from '../status/snapshot.js';
import { getDaemonBuildInfo } from '../build-info.js';
import { getSessionCompletionMarker } from '../status/snapshot.js';
import { execNpmCommandSync, resolveCurrentGlobalInstallSurface, spawnDetachedDaemonUpgradeHelper } from './upgrade-helper.js';
import { getMeshQueueRevision } from '../mesh/mesh-work-queue.js';
import type { RepoMeshSessionCleanupMode } from '../repo-mesh-types.js';
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';
import { homedir, hostname as osHostname } from 'os';
import { basename as pathBasename, join as pathJoin, resolve as pathResolve } from 'path';
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import { normalizeInteractivePromptResponse } from '../providers/types/interactive-prompt.js';
import { workingDirBasename } from '../providers/working-dir.js';
import { resolveWin32Executable } from '../cli-adapters/resolve-executable.js';

type ReleaseChannel = 'stable' | 'preview';
const CHANNEL_NPM_TAG: Record<ReleaseChannel, 'latest' | 'next'> = { stable: 'latest', preview: 'next' };
const CHANNEL_SERVER_URL: Record<ReleaseChannel, string> = {
    stable: 'https://api.adhf.dev',
    preview: 'https://api-preview.adhf.dev',
};

function normalizeReleaseChannel(value: unknown): ReleaseChannel | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'stable' || normalized === 'latest') return 'stable';
    if (normalized === 'preview' || normalized === 'next') return 'preview';
    return null;
}

function resolveUpgradeChannel(args: any): ReleaseChannel {
    return normalizeReleaseChannel(args?.channel)
        || normalizeReleaseChannel(args?.updatePolicy?.channel)
        || normalizeReleaseChannel(args?.npmTag)
        || normalizeReleaseChannel(loadConfig().updateChannel)
        || 'stable';
}

function readProviderPriorityFromPolicy(policy: unknown): string[] {
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
function normalizeProviderRoles(value: unknown): Array<{ providerType: string; maxParallel?: number }> {
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

function readObjectRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : {};
}

function readStringValue(...values: unknown[]): string | undefined {
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

function readBooleanValue(...values: unknown[]): boolean | undefined {
    for (const value of values) {
        if (typeof value === 'boolean') return value;
    }
    return undefined;
}

// summarizeRepoMeshDebugGit was a hand-synced copy of the cloud git-shape
// summarizer; both now call shared summarizeGitShape (@adhdev/mesh-shared).

function summarizeRepoMeshStatusDebug(status: any): Record<string, unknown> {
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

function logRepoMeshStatusDebug(event: string, fields: Record<string, unknown>): void {
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

function readMeshNodeMachineId(node: Record<string, unknown>): string | undefined {
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

function readMeshNodeHostname(node: Record<string, unknown>): string | undefined {
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

function buildMeshNodeMachineIdentity(node: Record<string, unknown>, opts: {
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
    const daemonIdMatches = Boolean(opts.localDaemonId && daemonId && opts.localDaemonId === daemonId);
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

function buildInlineMeshTransitGitStatus(node: any): Record<string, unknown> | undefined {
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

function buildLivePeerGitConnection(connection: Record<string, unknown>, timestamp = new Date().toISOString()): Record<string, unknown> {
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

function recordInlineMeshDirectGitTruth(
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
function persistNodeReporterPlatform(
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

function deriveMeshNodeHealthFromGit(git: Record<string, unknown> | null | undefined): 'online' | 'dirty' | 'degraded' {
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

function applyInlineMeshBranchConvergence(mesh: any, node: any, status: Record<string, unknown>): void {
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

function summarizeInlineMeshBranchConvergence(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
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

function finalizeMeshNodeStatus(args: {
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
const MESH_DIRECT_PROBE_TIMEOUT_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_TIMEOUT_MS', 25_000);
const MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS = readMeshTimeoutEnvMs('MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS', 25_000);
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
class MeshGitProbeCache {
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

async function probeRemoteMeshGitStatus(args: {
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    daemonId: string;
    workspace: string;
    timeoutMs: number;
}): Promise<Record<string, unknown> | null> {
    if (!args.dispatchMeshCommand) return null;
    const remoteResult = await Promise.race([
        args.dispatchMeshCommand(args.daemonId, 'git_status', { workspace: args.workspace, refreshUpstream: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), args.timeoutMs)),
    ]) as any;
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
async function probeRemoteMeshGitStatusWithRetry(args: {
    dispatchMeshCommand?: (daemonId: string, cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    daemonId: string;
    workspace: string;
    timeoutMs: number;
    /** Per-attempt timeout for retries (attempts > 0); defaults to timeoutMs. */
    retryTimeoutMs?: number;
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
                timeoutMs: attempt === 0 ? args.timeoutMs : (args.retryTimeoutMs ?? args.timeoutMs),
            });
            if (remoteGit) return remoteGit;
        } catch {
            // Timed out or P2P error — fall through to the next bounded attempt.
        }
    }
    return null;
}

async function hydrateInlineMeshDirectTruth(args: {
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
            daemonId && (daemonId === args.localMachineId || daemonId === args.statusInstanceId),
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
            daemonId && (daemonId === args.localMachineId || daemonId === args.statusInstanceId),
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

function summarizeMeshSessionRecord(record: any): Record<string, unknown> {
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

function readLiveMeshNodeWorkspace(args: {
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

function collectLiveMeshSessionRecords(args: {
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

function buildHistoricalMeshSessions(args: {
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

function applyCachedInlineMeshNodeStatus(
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

async function resolveProviderTypeFromPriority(args: {
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
type MeshCoordinatorConfigFormat = 'claude_mcp_json' | 'hermes_config_yaml';
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

type MeshRefineJobHandle = {
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

function buildMeshRefineValidationPlan(mesh: any, workspace: string): Record<string, unknown> {
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

function getMcpServersKey(format: MeshCoordinatorConfigFormat): 'mcpServers' | 'mcp_servers' {
    return format === 'hermes_config_yaml' ? 'mcp_servers' : 'mcpServers';
}

function parseMeshCoordinatorMcpConfig(text: string, format: MeshCoordinatorConfigFormat): Record<string, any> {
    if (!text.trim()) return {};
    if (format === 'claude_mcp_json') return JSON.parse(text);
    const parsed = loadYamlModule().load(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function serializeMeshCoordinatorMcpConfig(config: Record<string, any>, format: MeshCoordinatorConfigFormat): string {
    if (format === 'claude_mcp_json') return JSON.stringify(config, null, 2);
    return loadYamlModule().dump(config, { noRefs: true, lineWidth: 120 });
}

function resolveHermesUserHome(): string {
    const explicitHome = process.env.HERMES_HOME?.trim();
    return explicitHome || pathJoin(homedir(), '.hermes');
}

function loadHermesCoordinatorBaseConfig(targetConfigPath: string): { config: Record<string, any>; sourceHome: string; sourceConfigPath: string } {
    const sourceHome = resolveHermesUserHome();
    const sourceConfigPath = pathJoin(sourceHome, 'config.yaml');
    if (!fs.existsSync(sourceConfigPath)) return { config: {}, sourceHome, sourceConfigPath };
    if (pathResolve(sourceConfigPath) === pathResolve(targetConfigPath)) return { config: {}, sourceHome, sourceConfigPath };

    const parsed = parseMeshCoordinatorMcpConfig(fs.readFileSync(sourceConfigPath, 'utf-8'), 'hermes_config_yaml');
    const { mcp_servers: _mcpServers, ...baseConfig } = parsed;
    return { config: baseConfig, sourceHome, sourceConfigPath };
}

function stripHermesCoordinatorTempModelProviderOverrides(config: Record<string, any>): Record<string, any> {
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

function copyHermesCoordinatorCredentialFiles(sourceHome: string, targetHome: string) {
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
]);
const READ_DEBUG_ENABLED = process.argv.includes('--dev') || process.env.ADHDEV_READ_DEBUG === '1';

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
function resolveSpecPathInProviders(
    specPath: string,
    fsm: typeof import('node:fs'),
    pathm: typeof import('node:path'),
    osm: typeof import('node:os'),
): { ok: true; path: string } | { ok: false; error: string } {
    let rootReal: string;
    try {
        rootReal = fsm.realpathSync(pathm.join(osm.homedir(), '.adhdev', 'providers'));
    } catch (e) {
        return { ok: false, error: `providers root unavailable: ${(e as Error).message}` };
    }
    const resolved = pathm.resolve(specPath);
    const base = pathm.basename(resolved);
    if (!/^[\w.-]+\.json$/.test(base)) {
        return { ok: false, error: 'refused: spec file must be a *.json basename' };
    }
    let parentReal: string;
    try {
        parentReal = fsm.realpathSync(pathm.dirname(resolved));
    } catch (e) {
        return { ok: false, error: `spec directory not found: ${(e as Error).message}` };
    }
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + pathm.sep)) {
        return { ok: false, error: 'refused: spec path must be under the providers root' };
    }
    const safe = pathm.join(parentReal, base);
    // Reject if the final file itself is a symlink pointing elsewhere.
    try {
        const st = fsm.lstatSync(safe);
        if (st.isSymbolicLink()) return { ok: false, error: 'refused: spec path is a symlink' };
    } catch { /* file may not exist yet (write case) — fine */ }
    return { ok: true, path: safe };
}

function toHostedCliRuntimeDescriptor(record: any): HostedCliRuntimeDescriptor | null {
    if (!record || typeof record !== 'object') return null;
    const runtimeId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const cliType = typeof record.providerType === 'string' ? record.providerType : '';
    const workspace = typeof record.workspace === 'string' ? record.workspace : '';
    if (!runtimeId || !cliType || !workspace) return null;
    return {
        runtimeId,
        runtimeKey: typeof record.runtimeKey === 'string' ? record.runtimeKey : undefined,
        displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
        workspaceLabel: typeof record.workspaceLabel === 'string' ? record.workspaceLabel : undefined,
        lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle as HostedCliRuntimeDescriptor['lifecycle'] : undefined,
        recoveryState: typeof record.meta?.runtimeRecoveryState === 'string'
            ? String(record.meta.runtimeRecoveryState)
            : null,
        cliType,
        workspace,
        cliArgs: Array.isArray(record.meta?.cliArgs) ? record.meta.cliArgs as string[] : [],
        providerSessionId: typeof record.meta?.providerSessionId === 'string'
            ? String(record.meta.providerSessionId)
            : undefined,
    };
}

function getWriteConflictOwnerClientId(error: unknown): string | undefined {
    const message = typeof error === 'string'
        ? error
        : error instanceof Error
            ? error.message
            : '';
    const match = /^Write owned by\s+(.+)$/.exec(message.trim());
    return match?.[1]?.trim() || undefined;
}

function summarizeSessionHostRecord(result: unknown): Record<string, unknown> {
    if (!result || typeof result !== 'object') return {};
    const record = result as Record<string, any>;
    return {
        runtimeKey: typeof record.runtimeKey === 'string' ? record.runtimeKey : undefined,
        lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle : undefined,
        surfaceKind: getSessionHostSurfaceKind(record as any),
        attachedClientCount: Array.isArray(record.attachedClients) ? record.attachedClients.length : undefined,
        hasWriteOwner: !!record.writeOwner,
        writeOwnerClientId: typeof record.writeOwner?.clientId === 'string' ? record.writeOwner.clientId : undefined,
    };
}

function summarizeSessionHostRecords(result: unknown): Record<string, unknown> {
    const records = Array.isArray(result) ? result : [];
    const groups = partitionSessionHostRecords(records as any[]);
    return {
        sessionCount: records.length,
        liveRuntimeCount: groups.liveRuntimes.length,
        recoverySnapshotCount: groups.recoverySnapshots.length,
        inactiveRecordCount: groups.inactiveRecords.length,
    };
}

function summarizeSessionHostDiagnostics(result: unknown): Record<string, unknown> {
    const diagnostics = result && typeof result === 'object' ? result as Record<string, any> : {};
    const sessions = Array.isArray(diagnostics.sessions) ? diagnostics.sessions : [];
    return {
        runtimeCount: typeof diagnostics.runtimeCount === 'number' ? diagnostics.runtimeCount : undefined,
        ...summarizeSessionHostRecords(sessions),
    };
}

function summarizeSessionHostPruneResult(result: unknown): Record<string, unknown> {
    const value = result && typeof result === 'object' ? result as Record<string, any> : {};
    return {
        duplicateGroupCount: typeof value.duplicateGroupCount === 'number' ? value.duplicateGroupCount : undefined,
        prunedCount: Array.isArray(value.prunedSessionIds) ? value.prunedSessionIds.length : undefined,
        keptCount: Array.isArray(value.keptSessionIds) ? value.keptSessionIds.length : undefined,
    };
}

function normalizeStandaloneHostCommandUrl(hostAddress: string): string {
    const raw = hostAddress.trim();
    if (!raw) throw new Error('hostAddress required');
    const url = new URL(raw.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'));
    url.pathname = '/api/v1/command';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function buildMemberJoinNode(mesh: any, args: any, fallbackDaemonId?: string): Record<string, unknown> | null {
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
            if (selfDaemonId && nodeDaemonId === selfDaemonId) return undefined;
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
        const preferInline = options?.preferInline === true;
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

    private async cleanupLocalWorktreeNode(args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown> } | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> }> {
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
            return {
                success: false,
                code: 'mesh_worktree_cleanup_not_registered',
                error: `Refusing to remove '${workspace}' because it is not registered in git worktree list for '${repoRoot}'`,
                recoveryHint: 'Inspect git worktree list --porcelain from the source repo. If the path was already removed, prune git worktrees before retrying.',
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
                    // Fallback 2: deinit+remove still failed — rmSync + prune
                    try {
                        fs.rmSync(workspace, { recursive: true, force: true });
                        await execFileAsync('git', ['worktree', 'prune'], {
                            cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_CLEANUP, maxBuffer: GIT_MAX_BUFFER_CLEANUP, windowsHide: true,
                        });
                        return {
                            success: true,
                            removedPath: workspace,
                            repoRoot,
                            fallback: 'fs_rm_worktree_prune' as const,
                            forced: true,
                            reason: 'working_trees_containing_submodules' as const,
                            convergence: forceFallbackConvergence,
                        };
                    } catch (rmError: any) {
                        return {
                            success: false,
                            code: 'mesh_worktree_cleanup_failed',
                            error: `All removal fallbacks exhausted. deinit+remove: ${deinitError?.message || deinitError}; rmSync+prune: ${rmError?.message || rmError}`,
                            recoveryHint: 'Manually remove the worktree directory and run git worktree prune from the source repo.',
                        };
                    }
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

    private async traceSessionHostAction<T>(
        action: string,
        args: any,
        run: () => Promise<T>,
        summarizeResult?: (result: T) => Record<string, unknown>,
    ): Promise<T> {
        const interactionId = typeof args?._interactionId === 'string' ? args._interactionId : undefined;
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
        const requestedPayload: Record<string, unknown> = { action };
        if (sessionId) requestedPayload.sessionId = sessionId;
        if (typeof args?.clientId === 'string') requestedPayload.clientId = args.clientId;
        if (typeof args?.signal === 'string') requestedPayload.signal = args.signal;
        if (typeof args?.providerType === 'string') requestedPayload.providerType = args.providerType;
        if (typeof args?.workspace === 'string') requestedPayload.workspace = args.workspace;
        if (typeof args?.dryRun === 'boolean') requestedPayload.dryRun = args.dryRun;

        recordDebugTrace({
            interactionId,
            category: 'session_host',
            stage: 'action_requested',
            level: 'info',
            sessionId,
            payload: requestedPayload,
        });

        try {
            const result = await run();
            recordDebugTrace({
                interactionId,
                category: 'session_host',
                stage: 'action_result',
                level: 'info',
                sessionId,
                payload: {
                    ...requestedPayload,
                    success: true,
                    ...(summarizeResult ? summarizeResult(result) : {}),
                },
            });
            return result;
        } catch (error: any) {
            recordDebugTrace({
                interactionId,
                category: 'session_host',
                stage: 'action_failed',
                level: 'error',
                sessionId,
                payload: {
                    ...requestedPayload,
                    error: error?.message || String(error),
                    failureKind: getWriteConflictOwnerClientId(error) ? 'write_conflict' : 'request_failed',
                    conflictOwnerClientId: getWriteConflictOwnerClientId(error),
                },
            });
            throw error;
        }
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

    private async executeMeshRefineNodeSynchronously(meshId: string, nodeId: string, args: any): Promise<CommandRouterResult> {
        const refineStages: Array<Record<string, unknown>> = [];
        try {
            // preferInline: same as startMeshRefineJob — inline-cache-only clone nodes must resolve.
            const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const mesh = meshRecord?.mesh;
            const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh`, refineStages };

            if (!node.isLocalWorktree || !node.workspace) {
                return { success: false, error: `Refinery requires a local worktree node`, refineStages };
            }

            const sourceNode = node.clonedFromNodeId
                ? mesh?.nodes.find((n: any) => meshNodeIdMatches(n, node.clonedFromNodeId))
                : mesh?.nodes.find((n: any) => !n.isLocalWorktree);
            const repoRoot = sourceNode?.repoRoot || sourceNode?.workspace;
            if (!repoRoot) return { success: false, error: 'Source node repoRoot not found', refineStages };

            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);

            const resolveStarted = Date.now();
            const { stdout: branchStdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: node.workspace, encoding: 'utf8' });
            const branch = branchStdout.trim();
            if (!branch) return { success: false, error: 'Could not determine branch of the worktree node', refineStages };

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
            let branchHead = branchHeadStdout.trim();
            recordMeshRefineStage(refineStages, 'resolve_refs', 'passed', resolveStarted, { branch, baseBranch, baseHead, branchHead, ...(fetchWarning ? { fetchWarning } : {}) });

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
                return {
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
                };
            }
            if (validationSummary.status === 'skipped') {
                return {
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
                };
            }

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
                            return {
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
                            };
                        }
                    } catch (rebaseErr: any) {
                        try { execFileSync('git', ['rebase', '--abort'], { cwd: node.workspace, stdio: 'ignore' }); } catch { /* ignore */ }
                        recordMeshRefineStage(refineStages, 'patch_equivalence_after_auto_rebase', 'failed', autoRebaseStarted, {
                            error: rebaseErr?.message || String(rebaseErr),
                        });
                        return {
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
                        };
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
                    return {
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
                    };
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
                    return {
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
                    };
                }
            }

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
                return {
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
                };
            }

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
                return {
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
                };
            }

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
                return {
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
                };
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
                return {
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
                };
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
                return {
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
                };
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

            return {
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
            };
        } catch (e: any) {
            return { success: false, error: e.message, refineStages };
        }
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
        // targetSessionId. When that session is a mesh worker hosted on a REMOTE daemon, this
        // coordinator never holds its live instance, so the CommandHandler delegation would
        // fail with "Live session not found". Forward to the owning worker daemon — the same
        // daemon that already executes send_chat for that session — so the controlbar acts on
        // the real worker. _meshDirectDispatch prevents re-forwarding once the call lands on
        // the owning daemon (it then handles the session locally). A locally-hosted worker (or
        // any session this coordinator owns) resolves to undefined below and falls through to
        // normal local handling — no regression.
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

        switch (cmd) {
            // ─── CLI / ACP commands ───
            case 'mesh_forward_event': {
                return handleMeshForwardEvent({ instanceManager: this.deps.instanceManager } as any, args as Record<string, unknown>);
            }

            case 'get_pending_mesh_events': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                // (B3) Respect coordinatorDaemonId when the caller declares it
                // so unicast events route to the right coordinator instead of
                // being silently consumed by the first drainer.
                const coordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
                    ? args.coordinatorDaemonId.trim()
                    : undefined;
                const events = drainPendingMeshCoordinatorEvents(meshId || undefined, coordinatorDaemonId);
                return { success: true, events };
            }

            case 'interactive_prompt_response': {
                const sessionId = typeof args?.targetSessionId === 'string' && args.targetSessionId.trim()
                    ? args.targetSessionId.trim()
                    : typeof args?.sessionId === 'string' && args.sessionId.trim()
                        ? args.sessionId.trim()
                        : '';
                if (!sessionId) return { success: false, error: 'targetSessionId required' };
                const response = normalizeInteractivePromptResponse(args?.response ?? args);
                const instance = this.deps.instanceManager.getInstance(sessionId);
                if (!instance) return { success: false, error: `No running instance for session ${sessionId}` };
                this.deps.instanceManager.sendEvent(sessionId, 'interactive_prompt_response', response);
                return { success: true };
            }

            case 'launch_cli': {
                // The coordinator routing anchor (meshCoordinatorDaemonId) is stamped
                // upstream by mesh_launch_session, which resolves
                // coordinatorNode.daemonId || ctx.localDaemonId || ctx.localMachineId and
                // fail-closes for a remote node when none resolve. We deliberately do NOT
                // self-stamp this daemon's own id when the field is missing: for a
                // P2P-relayed remote worker launch, stamping the worker's own id would make
                // the self-forward gate (mesh-events-coordinator: sameDaemonId) treat the
                // worker as its own coordinator, suppressing the spontaneous completion-event
                // forward and leaving the event in the pending inbox until a read_chat
                // reconcile drains it. If the anchor is genuinely absent here, leave it
                // absent rather than poison the routing.
                const launchResult = await this.deps.cliManager.handleCliCommand(cmd, args);
                // Bug C fix (part 1): when launching a mesh node worker session, surface
                // bootstrapPending:true if the node's worktree bootstrap is still running.
                // This is informational — the launch is NOT blocked here (blocking is done
                // upstream by getWorktreeBootstrapLaunchBlock in the MCP layer).
                const meshNodeId = readStringValue((args?.settings as any)?.meshNodeId);
                const meshId = readStringValue((args?.settings as any)?.meshNodeFor);
                if (meshNodeId && meshId && launchResult?.success !== false) {
                    try {
                        const { getMesh } = await import('../config/mesh-config.js');
                        const meshObj = getMesh(meshId) ?? this.getCachedInlineMesh(meshId);
                        const nodeObj = Array.isArray(meshObj?.nodes)
                            ? meshObj.nodes.find((n: any) => meshNodeIdMatches(n, meshNodeId))
                            : undefined;
                        const bootstrapStatus = readStringValue(nodeObj?.worktreeBootstrap?.status);
                        if (bootstrapStatus === 'running') {
                            return { success: true, ...launchResult, bootstrapPending: true };
                        }
                    } catch { /* best-effort — do not fail launch for bootstrap probe errors */ }
                }
                return launchResult;
            }
            case 'stop_cli':
            case 'set_cli_view_mode':
            case 'record_provider_pty': {
                return this.deps.cliManager.handleCliCommand(cmd, args);
            }
            case 'agent_command': {
                // Relay-safety stamp: a dispatch carrying meshContext.coordinatorDaemonId
                // (mesh_send_task / queue assignment over P2P) is the worker daemon's chance
                // to persist the coordinator routing anchor onto the target session BEFORE the
                // turn runs. Without meshCoordinatorDaemonId on the session, the core forwarder
                // (injectMeshSystemMessage) cannot resolve a remote coordinator target, so the
                // completion event sits in the pending queue until a read_chat reconcile drains
                // it. Stamping here makes a reused/relaunched remote session relay-safe at
                // dispatch time even when it was not launched via mesh_launch_session.
                {
                    const dispatchSessionId = readStringValue(args?.targetSessionId, (args as any)?.sessionId, (args as any)?.instanceId);
                    const dispatchMeshContext = args?.meshContext as Record<string, unknown> | undefined;
                    if (dispatchSessionId && dispatchMeshContext) {
                        try {
                            const inst = this.deps.instanceManager.getInstance(dispatchSessionId);
                            if (inst && typeof inst.updateSettings === 'function') {
                                const stamp = buildMeshWorkerRelayStamp(
                                    inst.getState?.()?.settings as Record<string, unknown> | undefined,
                                    {
                                        meshId: dispatchMeshContext.meshId,
                                        nodeId: dispatchMeshContext.nodeId,
                                        coordinatorDaemonId: dispatchMeshContext.coordinatorDaemonId,
                                    },
                                );
                                if (stamp) inst.updateSettings(stamp);
                            }
                        } catch { /* best-effort — dispatch still proceeds without the stamp */ }
                    }
                }
                const agentResult = await this.deps.cliManager.handleCliCommand(cmd, args);
                // Bug C fix (part 2): when dispatching a task to a mesh node session, override
                // the dispatch acknowledgement risk reason to 'bootstrap_still_running' when
                // the target node's worktree bootstrap is still running. Informational only —
                // dispatch is NOT blocked.
                const meshCtx = args?.meshContext as Record<string, unknown> | undefined;
                const dispatchNodeId = readStringValue(meshCtx?.nodeId);
                const dispatchMeshId = readStringValue(meshCtx?.meshId);
                if (dispatchNodeId && dispatchMeshId && agentResult?.success !== false) {
                    try {
                        const { getMesh } = await import('../config/mesh-config.js');
                        const meshObj = getMesh(dispatchMeshId) ?? this.getCachedInlineMesh(dispatchMeshId);
                        const nodeObj = Array.isArray(meshObj?.nodes)
                            ? meshObj.nodes.find((n: any) => meshNodeIdMatches(n, dispatchNodeId))
                            : undefined;
                        const bootstrapStatus = readStringValue(nodeObj?.worktreeBootstrap?.status);
                        if (bootstrapStatus === 'running') {
                            return {
                                success: true,
                                ...agentResult,
                                dispatchAcknowledgementRisk: true,
                                dispatchAcknowledgementRiskReason: 'bootstrap_still_running',
                                nextAction: 'Wait for worktree_bootstrap_complete event before dispatching work to this node.',
                            };
                        }
                    } catch { /* best-effort */ }
                }
                return agentResult;
            }

            // ─── Logs ───
            case 'get_logs': {
                const count = parseInt(args?.count) || parseInt(args?.lines) || 100;
                const minLevel = args?.minLevel || 'info';
                const sinceTs = args?.since || 0;

                try {
                    // Priority 1: ring buffer (fast and structured)
                    let logs = getRecentLogs(count, minLevel);
                    if (sinceTs > 0) {
                        logs = logs.filter((l: any) => l.ts > sinceTs);
                    }
                    if (logs.length > 0) {
                        return { success: true, logs, totalBuffered: logs.length };
                    }
                    // Incremental polling must not fall back to unfiltered file text: the file
                    // format is not timestamp-filterable, and returning its tail makes the UI
                    // replace structured logs with old raw fallback lines when nothing new exists.
                    if (sinceTs > 0) {
                        return { success: true, logs: [], totalBuffered: 0 };
                    }
                    // Priority 2: file fallback
                    if (fs.existsSync(LOG_PATH)) {
                        const content = fs.readFileSync(LOG_PATH, 'utf-8');
                        const allLines = content.split('\n');
                        const recent = allLines.slice(-count).join('\n');
                        return { success: true, logs: recent, totalLines: allLines.length };
                    }
                    return { success: true, logs: [], totalBuffered: 0 };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_debug_trace': {
                const count = parseInt(args?.count) || parseInt(args?.limit) || 100;
                const sinceTs = Number(args?.since) || 0;
                const interactionId = typeof args?.interactionId === 'string' ? args.interactionId : undefined;
                const category = typeof args?.category === 'string' ? args.category : undefined;
                const trace = getRecentDebugTrace({ interactionId, category, limit: count })
                    .filter((entry) => !sinceTs || entry.ts > sinceTs);
                return { success: true, trace, count: trace.length };
            }

            case 'session_host_get_diagnostics': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const diagnostics = await this.traceSessionHostAction('session_host_get_diagnostics', args, () => this.deps.sessionHostControl!.getDiagnostics({
                    includeSessions: args?.includeSessions !== false,
                    limit: Number(args?.limit) || undefined,
                }), (result) => ({
                    includeSessions: args?.includeSessions !== false,
                    limit: Number(args?.limit) || undefined,
                    ...summarizeSessionHostDiagnostics(result),
                }));
                return { success: true, diagnostics };
            }

            case 'session_host_list_sessions': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessions = await this.traceSessionHostAction('session_host_list_sessions', args, () => this.deps.sessionHostControl!.listSessions(), (records) => summarizeSessionHostRecords(records));
                return { success: true, sessions };
            }

            case 'session_host_stop_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_stop_session', args, () => this.deps.sessionHostControl!.stopSession(sessionId), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_resume_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_resume_session', args, async () => {
                    const nextRecord = await this.deps.sessionHostControl!.resumeSession(sessionId);
                    const hosted = toHostedCliRuntimeDescriptor(nextRecord);
                    if (hosted) {
                        await this.deps.cliManager.restoreHostedSessions([hosted]);
                    }
                    return nextRecord;
                }, (result) => ({
                    ...summarizeSessionHostRecord(result),
                    restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
                }));
                return { success: true, record };
            }

            case 'session_host_restart_session': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                const record = await this.traceSessionHostAction('session_host_restart_session', args, async () => {
                    const nextRecord = await this.deps.sessionHostControl!.restartSession(sessionId);
                    const hosted = toHostedCliRuntimeDescriptor(nextRecord);
                    if (hosted) {
                        await this.deps.cliManager.restoreHostedSessions([hosted]);
                    }
                    return nextRecord;
                }, (result) => ({
                    ...summarizeSessionHostRecord(result),
                    restoredHostedSession: !!toHostedCliRuntimeDescriptor(result),
                }));
                return { success: true, record };
            }

            case 'session_host_send_signal': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const signal = typeof args?.signal === 'string' ? args.signal : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!signal) return { success: false, error: 'signal required' };
                const record = await this.traceSessionHostAction('session_host_send_signal', args, () => this.deps.sessionHostControl!.sendSignal(sessionId, signal), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_force_detach_client': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_force_detach_client', args, () => this.deps.sessionHostControl!.forceDetachClient(sessionId, clientId), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'session_host_prune_duplicate_sessions': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const result = await this.traceSessionHostAction('session_host_prune_duplicate_sessions', args, () => this.deps.sessionHostControl!.pruneDuplicateSessions({
                    providerType: typeof args?.providerType === 'string' ? args.providerType : undefined,
                    workspace: typeof args?.workspace === 'string' ? args.workspace : undefined,
                    dryRun: args?.dryRun === true,
                }), (value) => summarizeSessionHostPruneResult(value));
                return { success: true, result };
            }

            case 'session_host_acquire_write': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                const ownerType = args?.ownerType === 'agent' ? 'agent' : 'user';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_acquire_write', args, () => this.deps.sessionHostControl!.acquireWrite({
                    sessionId,
                    clientId,
                    ownerType,
                    force: args?.force !== false,
                }), (result) => ({
                    ...summarizeSessionHostRecord(result),
                    ownerType,
                }));
                return { success: true, record };
            }

            case 'session_host_release_write': {
                if (!this.deps.sessionHostControl) return { success: false, error: 'Session host control unavailable' };
                const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
                const clientId = typeof args?.clientId === 'string' ? args.clientId : '';
                if (!sessionId) return { success: false, error: 'sessionId required' };
                if (!clientId) return { success: false, error: 'clientId required' };
                const record = await this.traceSessionHostAction('session_host_release_write', args, () => this.deps.sessionHostControl!.releaseWrite({
                    sessionId,
                    clientId,
                }), (result) => summarizeSessionHostRecord(result));
                return { success: true, record };
            }

            case 'list_saved_sessions': {
                const providerType = typeof args?.providerType === 'string'
                    ? args.providerType.trim()
                    : typeof args?.agentType === 'string'
                        ? args.agentType.trim()
                        : '';
                const kind = args?.kind === 'acp' ? 'acp' : 'cli';
                if (!providerType) {
                    return { success: false, error: 'providerType required' };
                }

                const wantsAll = args?.all === true;
                const offset = wantsAll ? 0 : Math.max(0, Number(args?.offset) || 0);
                const limit = wantsAll ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(100, Number(args?.limit) || 30));
                const requestedWorkspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
                const requestedProviderSessionId = typeof args?.providerSessionId === 'string'
                    ? args.providerSessionId.trim()
                    : typeof args?.activeProviderSessionId === 'string'
                        ? args.activeProviderSessionId.trim()
                        : '';
                const providerMeta = this.deps.providerLoader.resolve?.(providerType) || this.deps.providerLoader.getMeta(providerType);
                const { sessions: historySessions, hasMore, source } = listProviderHistorySessions(providerType, {
                    canonicalHistory: providerMeta?.nativeHistory,
                    offset,
                    limit,
                    historyBehavior: providerMeta?.historyBehavior,
                    scripts: providerMeta?.scripts as any,
                });
                const state = loadState();
                const savedSessions = getSavedProviderSessions(state, { providerType, kind });
                const recentSessions = getRecentActivity(state, 200)
                    .filter(entry => entry.providerType === providerType && entry.kind === kind && entry.providerSessionId);
                const savedSessionById = new Map(savedSessions.map(entry => [entry.providerSessionId, entry]));
                const recentSessionById = new Map(recentSessions.map(entry => [entry.providerSessionId!, entry]));
                const canResumeById = supportsExplicitSessionResume(providerMeta?.resume);

                return {
                    success: true,
                    sessions: historySessions.map(session => {
                        const saved = savedSessionById.get(session.historySessionId);
                        const recent = recentSessionById.get(session.historySessionId);
                        const workspace = saved?.workspace
                            || recent?.workspace
                            || session.workspace
                            || (requestedWorkspace && requestedProviderSessionId === session.historySessionId ? requestedWorkspace : undefined);
                        return {
                            id: session.historySessionId,
                            providerSessionId: session.historySessionId,
                            providerType,
                            providerName: saved?.providerName || recent?.providerName || providerType,
                            kind: saved?.kind || recent?.kind || kind,
                            title: saved?.title || recent?.title || session.sessionTitle || session.preview || providerType,
                            workspace,
                            summaryMetadata: saved?.summaryMetadata || recent?.summaryMetadata,
                            preview: session.preview,
                            messageCount: session.messageCount,
                            firstMessageAt: session.firstMessageAt,
                            lastMessageAt: session.lastMessageAt,
                            canResume: !!workspace && canResumeById,
                            historySource: session.source,
                            sourcePath: session.sourcePath,
                            sourceMtimeMs: session.sourceMtimeMs,
                        };
                    }),
                    hasMore,
                    source,
                };
            }

            // ─── restart_session: IDE / CLI / ACP unified ───
            case 'restart_session': {
                const targetType = args?.cliType || args?.agentType || args?.ideType;
                if (!targetType) throw new Error('cliType or ideType required');

                // Check if IDE (in cdpManagers or provider category is ide)
                const isIde = this.deps.cdpManagers.has(targetType) ||
                    this.deps.providerLoader.getMeta(targetType)?.category === 'ide';

                if (isIde) {
                    // IDE restart: stop (with process kill) → launch
                    await this.stopIde(targetType, true);
                    const launchResult = await this.executeDaemonCommand('launch_ide', { ideType: targetType, enableCdp: true, workspace: args?.workspace });
                    return { success: true, restarted: true, ideType: targetType, launch: launchResult };
                }

                // CLI/ACP restart: delegate to CliManager
                return this.deps.cliManager.handleCliCommand(cmd, args);
            }

            // ─── IDE stop ───
            case 'stop_ide': {
                const ideType = args?.ideType;
                if (!ideType) throw new Error('ideType required');
                const killProcess = args?.killProcess !== false; // default true
                await this.stopIde(ideType, killProcess);
                try {
                    const results = await detectIDEs(this.deps.providerLoader);
                    this.deps.detectedIdes.value = results;
                    this.deps.providerLoader.setIdeDetectionResults(results, true);
                } catch { /* ignore detection refresh errors */ }
                return { success: true, ideType, stopped: true, processKilled: killProcess };
            }

            // ─── IDE restart ───
            case 'restart_ide': {
                const ideType = args?.ideType;
                if (!ideType) throw new Error('ideType required');
                await this.stopIde(ideType, true); // always kill process on restart
                const launchResult = await this.executeDaemonCommand('launch_ide', { ideType, enableCdp: true, workspace: args?.workspace });
                return { success: true, ideType, restarted: true, launch: launchResult };
            }

            // ─── IDE launch + CDP connect ───
            case 'launch_ide': {
                const ideKey = args?.ideId || args?.ideType;
                const resolvedWorkspace = resolveIdeLaunchWorkspace(
                    {
                        workspace: args?.workspace,
                        workspaceId: args?.workspaceId,
                        useDefaultWorkspace: args?.useDefaultWorkspace,
                    },
                    loadConfig(),
                );
                const launchArgs = {
                    ideId: ideKey,
                    workspace: resolvedWorkspace,
                    newWindow: args?.newWindow,
                };
                LOG.info('LaunchIDE', `target=${ideKey || 'auto'}`);
                const result = await launchWithCdp(launchArgs);

                if (result.success && result.port && result.ideId && !this.deps.cdpManagers.has(result.ideId)) {
                    const logFn = this.deps.getCdpLogFn
                        ? this.deps.getCdpLogFn(result.ideId)
                        : LOG.forComponent(`CDP:${result.ideId}`).asLogFn();
                    const provider = this.deps.providerLoader.getMeta(result.ideId);
                    const manager = new DaemonCdpManager(result.port, logFn, undefined, provider?.targetFilter);
                    const connected = await manager.connect();
                    if (connected) {
                        // Register active extension providers for this IDE in CDP manager
                        registerExtensionProviders(this.deps.providerLoader, manager, result.ideId);
                        this.deps.cdpManagers.set(result.ideId, manager);
                        LOG.info('CDP', `Connected: ${result.ideId} (port ${result.port})`);
                        LOG.info('CDP', `${this.deps.cdpManagers.size} IDE(s) connected`);

                        // Notify consumer (e.g. setupIdeInstance)
                        this.deps.onCdpManagerCreated?.(result.ideId, manager);
                    }
                }
                this.deps.onIdeConnected?.();
                try {
                    const results = await detectIDEs(this.deps.providerLoader);
                    this.deps.detectedIdes.value = results;
                    this.deps.providerLoader.setIdeDetectionResults(results, true);
                } catch { /* ignore detection refresh errors */ }
                if (result.success && resolvedWorkspace) {
                    try {
                        const next = appendRecentActivity(loadState(), {
                            kind: 'ide',
                            providerType: result.ideId || ideKey,
                            providerName: result.ideId || ideKey,
                            workspace: resolvedWorkspace,
                            title: result.ideId || ideKey,
                        });
                        saveState(next);
                    } catch { /* ignore activity persist errors */ }
                } else if (result.success && (result.ideId || ideKey)) {
                    try {
                        saveState(appendRecentActivity(loadState(), {
                            kind: 'ide',
                            providerType: result.ideId || ideKey,
                            providerName: result.ideId || ideKey,
                            title: result.ideId || ideKey,
                        }));
                    } catch { /* ignore activity persist errors */ }
                }
                return { ...result };
            }

            // ─── Detect providers ───
            case 'detect_provider': {
                const providerType = typeof args?.providerType === 'string' ? args.providerType.trim() : '';
                if (!providerType) return { success: false, error: 'providerType is required' };
                const normalizedType = this.deps.providerLoader.resolveAlias(providerType);
                const provider = this.deps.providerLoader.getByAlias(providerType);
                if (!provider) return { success: false, error: `Provider not found: ${providerType}` };
                if (provider.category !== 'cli' && provider.category !== 'acp') {
                    return { success: false, error: `Provider detection is only supported for CLI/ACP providers: ${providerType}` };
                }
                if (!this.deps.providerLoader.isMachineProviderEnabled(normalizedType)) {
                    return { success: false, error: `Provider is disabled on this machine: ${providerType}` };
                }
                const detected = await detectCLI(normalizedType, this.deps.providerLoader, { includeVersion: false });
                this.deps.providerLoader.setCliDetectionResults([{
                    id: normalizedType,
                    installed: !!detected,
                    path: detected?.path,
                }], false);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    providerType: normalizedType,
                    detected: !!detected,
                    path: detected?.path || null,
                };
            }

            // ─── Detect IDEs ───
            case 'detect_ides': {
                const results = await detectIDEs(this.deps.providerLoader);
                this.deps.detectedIdes.value = results;
                this.deps.providerLoader.setIdeDetectionResults(results, true);
                return { success: true, detectedInfo: results };
            }

            // ─── Set User Name ───
            case 'set_user_name': {
                const name = args?.userName;
                if (!name || typeof name !== 'string') throw new Error('userName required');
                updateConfig({ userName: name });
                return { success: true, userName: name };
            }

            case 'get_status_metadata': {
                const snapshot = buildStatusSnapshot({
                    allStates: this.deps.instanceManager.collectAllStates(),
                    cdpManagers: this.deps.cdpManagers,
                    providerLoader: this.deps.providerLoader,
                    detectedIdes: this.deps.detectedIdes.value,
                    instanceId: this.deps.statusInstanceId || loadConfig().machineId || 'daemon',
                    version: this.deps.statusVersion || 'unknown',
                    profile: 'metadata',
                });
                // Surface the daemon's build stamp so coordinators (mesh_status)
                // can detect a running daemon that predates a just-merged fix and
                // is awaiting deploy/restart. Sibling of `status` to avoid
                // perturbing the dashboard status snapshot shape.
                return { success: true, status: snapshot, daemonBuild: getDaemonBuildInfo() };
            }

            case 'get_machine_runtime_stats': {
                return {
                    success: true,
                    machine: buildMachineInfo('full'),
                    timestamp: Date.now(),
                };
            }

            // Session-info popup data. Aggregates whatever the daemon knows
            // about a single live session into one envelope so the dashboard
            // doesn't need to stitch together status + coordinator registry +
            // session registry on the client. Includes the actual system
            // prompt that was injected at launch when the session is a mesh
            // coordinator — that's the "what prompt did the agent see?"
            // question the info-icon dialog is meant to answer.
            case 'get_session_info': {
                const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
                    : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
                if (!sessionId) return { success: false, error: 'targetSessionId required' };
                // Fetch both lookups up front. We used to bail with "Session not
                // found" when sessionRegistry forgot the SID (auto-cleanup,
                // daemon restart with the session not yet restored, etc), which
                // hid the coordinator-side metadata even though the
                // coordinator-registry still has it. Now we return whichever
                // side we have. The dashboard renders "no coordinator-specific
                // prompt" only when *neither* side knows the session.
                const target = this.deps.sessionRegistry.get(sessionId);
                const coord = getCoordinatorForSession(sessionId);
                if (!target && !coord) return { success: false, error: 'Session not found', sessionId };
                const adapter = target
                    ? this.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter
                    : undefined;
                const runtimeMeta = (adapter && typeof (adapter as any).getRuntimeMetadata === 'function')
                    ? (adapter as any).getRuntimeMetadata()
                    : undefined;
                // Launch metadata (args / cwd / extra-env keys / providerSessionId) is
                // derived from the live adapter's spawn plan; only available while the
                // adapter is alive (resumed-from-history sessions report nothing here).
                const launchInfo = (adapter && typeof (adapter as any).getLaunchInfo === 'function')
                    ? (adapter as any).getLaunchInfo()
                    : undefined;
                const providerType = target?.providerType || coord?.cliType || '';
                const providerMetaForSession = providerType
                    ? this.deps.providerLoader.resolve?.(providerType) || this.deps.providerLoader.getMeta(providerType)
                    : undefined;
                return {
                    success: true,
                    session: {
                        sessionId,
                        providerType,
                        providerName: providerMetaForSession?.name,
                        transport: target?.transport,
                        workspace: (target as any)?.workspace || coord?.workspace,
                        spawnedAtMs: (target as any)?.spawnedAtMs || coord?.startedAt,
                        // providerSessionId now comes from the live adapter's launch info
                        // (the registry target never carried it — it was always undefined).
                        providerSessionId: launchInfo?.providerSessionId || (target as any)?.providerSessionId,
                        runtimeMetadata: runtimeMeta,
                        launch: launchInfo,
                    },
                    coordinator: coord ? {
                        meshId: coord.meshId,
                        startedAt: coord.startedAt,
                        cliType: coord.cliType,
                        systemPrompt: coord.systemPrompt,
                        extraSystemPrompt: coord.extraSystemPrompt,
                        injection: coord.injection,
                        mcpConfigPath: coord.mcpConfigPath,
                    } : null,
                };
            }

            case 'get_spec_debug': {
                const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
                    : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
                if (!sessionId) return { success: false, error: 'targetSessionId required' };
                const target = this.deps.sessionRegistry.get(sessionId);
                if (!target) return { success: false, error: 'Session not found', sessionId };
                const adapterObj = this.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter;
                const snapshot = adapterObj
                    ? (typeof (adapterObj as any).getDebugSnapshot === 'function'
                        ? (adapterObj as any).getDebugSnapshot()
                        : typeof (adapterObj as any).getDebugState === 'function'
                            ? (adapterObj as any).getDebugState()
                            : null)
                    : null;
                return {
                    success: true,
                    sessionId,
                    providerType: target.providerType,
                    isSpecProvider: snapshot !== null,
                    snapshot,
                };
            }

            // ── Spec source read/write for the debug panel's live editor.
            //    Lets the dashboard load a session's spec.json, edit it, and
            //    save it back — the driver's fs.watch picks up the change and
            //    hot-reloads the FSM with no restart. Writes are confined to
            //    files under ~/.adhdev/providers to avoid arbitrary fs access.
            case 'get_spec_source': {
                const fsm = await import('node:fs');
                const pathm = await import('node:path');
                const osm = await import('node:os');
                const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
                    : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
                let specPath = typeof args?.specPath === 'string' ? args.specPath : '';
                if (!specPath && sessionId) {
                    const target = this.deps.sessionRegistry.get(sessionId);
                    const adapterObj = target ? this.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter : null;
                    const snap = adapterObj && typeof (adapterObj as any).getDebugSnapshot === 'function' ? (adapterObj as any).getDebugSnapshot() : null;
                    specPath = snap?.specPath ?? '';
                }
                if (!specPath) return { success: false, error: 'specPath or resolvable targetSessionId required' };
                // Confine reads to the providers tree, resolving symlinks so a
                // crafted path can't escape via a symlinked spec file.
                const safe = resolveSpecPathInProviders(specPath, fsm, pathm, osm);
                if (!safe.ok) return { success: false, error: safe.error, specPath };
                try {
                    const content = fsm.readFileSync(safe.path, 'utf8');
                    return { success: true, specPath: safe.path, content };
                } catch (e) {
                    return { success: false, error: `read failed: ${(e as Error).message}`, specPath };
                }
            }

            case 'write_spec_source': {
                const fsm = await import('node:fs');
                const pathm = await import('node:path');
                const osm = await import('node:os');
                const specPath = typeof args?.specPath === 'string' ? args.specPath : '';
                const content = typeof args?.content === 'string' ? args.content : '';
                if (!specPath) return { success: false, error: 'specPath required' };
                if (!content) return { success: false, error: 'content required' };
                // Confine writes to the providers tree (symlink-safe — see helper).
                const safe = resolveSpecPathInProviders(specPath, fsm, pathm, osm);
                if (!safe.ok) return { success: false, error: safe.error };
                // Validate JSON + (if v4) FSM structure before writing so a bad
                // edit can't break the live session — return precise errors.
                let parsed: unknown;
                try { parsed = JSON.parse(content); }
                catch (e) { return { success: false, error: `invalid JSON: ${(e as Error).message}` }; }
                if ((parsed as any)?.$schema === 'adhdev:cli/spec@4') {
                    const { validateFsmSpec } = await import('../providers/spec/fsm-loader.js');
                    const errs = validateFsmSpec(parsed);
                    if (errs.length) return { success: false, error: 'spec invalid', validationErrors: errs };
                }
                try {
                    fsm.writeFileSync(safe.path, content, 'utf8');
                    return { success: true, specPath: safe.path };
                } catch (e) {
                    return { success: false, error: `write failed: ${(e as Error).message}` };
                }
            }

            // ── Validate an in-progress spec (string or object) without writing.
            //    The form builder calls this on every change so Save can stay
            //    disabled while there are structural / reference / regex errors.
            case 'validate_spec': {
                let parsed: unknown = args?.spec;
                if (typeof args?.content === 'string') {
                    try { parsed = JSON.parse(args.content); }
                    catch (e) { return { success: true, valid: false, errors: [`invalid JSON: ${(e as Error).message}`] }; }
                }
                if (!parsed || typeof parsed !== 'object') {
                    return { success: true, valid: false, errors: ['spec must be an object or content string'] };
                }
                const schema = (parsed as any).$schema;
                if (schema === 'adhdev:cli/spec@4') {
                    const { validateFsmSpec } = await import('../providers/spec/fsm-loader.js');
                    const errors = validateFsmSpec(parsed);
                    return { success: true, valid: errors.length === 0, errors };
                }
                // v1/v3 left to the legacy loader path; the builder is v4-only.
                return { success: true, valid: false, errors: [`unsupported $schema "${schema}" — form builder is v4-only`] };
            }

            // ── Evaluate a single condition against a live session's current
            //    screen — powers the editor's "does this match right now?"
            //    preview. Returns the recursive match tree.
            case 'eval_condition_preview': {
                const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
                    : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
                if (!sessionId) return { success: false, error: 'targetSessionId required' };
                if (!args?.condition || typeof args.condition !== 'object') return { success: false, error: 'condition required' };
                const target = this.deps.sessionRegistry.get(sessionId);
                if (!target) return { success: false, error: 'Session not found', sessionId };
                const adapterObj = this.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter as any;
                const snap = adapterObj && typeof adapterObj.getDebugSnapshot === 'function' ? adapterObj.getDebugSnapshot() : null;
                if (!snap?.screen) return { success: false, error: 'no live screen for session' };
                // Reconstruct the sections map the spec would resolve. We pass
                // the spec's sections so section-scoped regexes resolve the same
                // way they do at runtime; fall back to the on-disk spec.
                let sectionsDef: Record<string, unknown> | undefined;
                try {
                    const fsm2 = await import('node:fs');
                    if (snap.specPath) {
                        const raw = JSON.parse(fsm2.readFileSync(snap.specPath, 'utf8'));
                        sectionsDef = raw?.sections;
                    }
                } catch { /* fall back to whole-screen matching */ }
                const { evaluateConditionPreview } = await import('../providers/spec/fsm-evaluator.js');
                try {
                    const result = evaluateConditionPreview(
                        args.condition,
                        sectionsDef as any,
                        snap.screen,
                        snap.cursorPosition ?? undefined,
                    );
                    return { success: true, result, sections: snap.sections ?? null };
                } catch (e) {
                    return { success: false, error: `eval failed: ${(e as Error).message}` };
                }
            }

            // ── Resolve a sections map against a live session's screen — the
            //    section editor's "test" button. Returns, for each section id,
            //    the line range + the text it captures, so the author can SEE
            //    whether a from_top/until/anchor definition carves the screen
            //    the way they intend. Accepts an in-progress sections map so it
            //    previews unsaved edits.
            case 'resolve_section_preview': {
                const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
                    : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
                if (!sessionId) return { success: false, error: 'targetSessionId required' };
                if (!args?.sections || typeof args.sections !== 'object') return { success: false, error: 'sections map required' };
                const target = this.deps.sessionRegistry.get(sessionId);
                if (!target) return { success: false, error: 'Session not found', sessionId };
                const adapterObj = this.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter as any;
                const snap = adapterObj && typeof adapterObj.getDebugSnapshot === 'function' ? adapterObj.getDebugSnapshot() : null;
                if (!snap?.screen) return { success: false, error: 'no live screen for session' };
                const { resolveSections } = await import('../providers/spec/evaluator.js');
                try {
                    const lines = String(snap.screen).split('\n').map((l: string) => l.endsWith('\r') ? l.slice(0, -1) : l);
                    const resolved = resolveSections(args.sections as any, lines);
                    return {
                        success: true,
                        screenLineCount: lines.length,
                        sections: resolved.map(s => ({ id: s.id, fromLine: s.fromLine, toLine: s.toLine, text: s.text })),
                    };
                } catch (e) {
                    return { success: false, error: `resolve failed: ${(e as Error).message}` };
                }
            }

            // ── User-level coordinator-prompt files (~/.adhdev/coordinator-prompts/).
            //    These live on this daemon's filesystem and never sync to the
            //    cloud / other daemons — they're per-machine config. The
            //    Settings page in the dashboard reads/writes via these two
            //    commands instead of going through fs from the browser.
            case 'list_coordinator_prompts': {
                const fs = await import('node:fs');
                const path = await import('node:path');
                const os = await import('node:os');
                const dir = path.join(os.homedir(), '.adhdev', 'coordinator-prompts');
                const entries: Record<string, { override: string; append: string }> = {};
                try {
                    if (fs.existsSync(dir)) {
                        for (const name of fs.readdirSync(dir)) {
                            // Bucket files into <key>.{md|append.md}; ignore others
                            // so a stray README or .DS_Store doesn't show up.
                            const matchOverride = name.match(/^([a-zA-Z0-9_.-]+)\.md$/);
                            const matchAppend = name.match(/^([a-zA-Z0-9_.-]+)\.append\.md$/);
                            // append-pattern wins when both match (file is `.append.md`).
                            const m = matchAppend || matchOverride;
                            if (!m) continue;
                            const isAppend = !!matchAppend;
                            const key = m[1];
                            const full = path.join(dir, name);
                            let content = '';
                            try { content = fs.readFileSync(full, 'utf8'); } catch { /* skip */ }
                            if (!entries[key]) entries[key] = { override: '', append: '' };
                            if (isAppend) entries[key].append = content;
                            else entries[key].override = content;
                        }
                    }
                } catch (error: any) {
                    return { success: false, error: error?.message || String(error) };
                }
                return { success: true, dir, entries };
            }

            case 'write_coordinator_prompt': {
                const fs = await import('node:fs');
                const path = await import('node:path');
                const os = await import('node:os');
                const key = typeof args?.key === 'string' ? args.key.trim() : '';
                const kind = args?.kind === 'append' ? 'append' : 'override';
                const content = typeof args?.content === 'string' ? args.content : '';
                // Whitelist key chars so a malicious caller can't write
                // ../../etc/passwd. Same charset readUserPromptFile accepts.
                if (!key || !/^[a-zA-Z0-9_.-]+$/.test(key)) {
                    return { success: false, error: 'key must match [a-zA-Z0-9_.-]+' };
                }
                const dir = path.join(os.homedir(), '.adhdev', 'coordinator-prompts');
                const filename = kind === 'append' ? `${key}.append.md` : `${key}.md`;
                const full = path.join(dir, filename);
                try {
                    fs.mkdirSync(dir, { recursive: true });
                    if (content.trim()) {
                        fs.writeFileSync(full, content, { encoding: 'utf8', mode: 0o600 });
                    } else if (fs.existsSync(full)) {
                        // Empty content = "reset to default" — delete the file
                        // so the daemon's readUserPromptFile path falls through.
                        fs.unlinkSync(full);
                    }
                    return { success: true, path: full, kind, key };
                } catch (error: any) {
                    return { success: false, error: error?.message || String(error) };
                }
            }

            case 'mark_session_seen': {
                const sessionId = args?.sessionId;
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                const currentState = loadState();
                const prevSeenAt = currentState.sessionReads?.[sessionId] || 0;
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const requestedCompletionMarker = typeof args?.completionMarker === 'string'
                    ? args.completionMarker.trim()
                    : '';
                const completionMarker = requestedCompletionMarker || (targetSession ? getSessionCompletionMarker(targetSession) : '');
                const requestedProviderSessionId = typeof args?.providerSessionId === 'string'
                    ? args.providerSessionId.trim()
                    : '';
                const providerSessionId = requestedProviderSessionId || targetSession?.providerSessionId;
                const next = markSessionSeen(
                    currentState,
                    sessionId,
                    typeof args?.seenAt === 'number' ? args.seenAt : Date.now(),
                    completionMarker,
                    providerSessionId,
                );
                if (READ_DEBUG_ENABLED) {
                    LOG.info('RecentRead', `mark_session_seen sessionId=${sessionId} seenAt=${String(args?.seenAt || '')} prevSeenAt=${String(prevSeenAt)} nextSeenAt=${String(next.sessionReads?.[sessionId] || 0)} marker=${completionMarker || '-'}`);
                }
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    seenAt: next.sessionReads?.[sessionId] || Date.now(),
                    completionMarker,
                };
            }

            case 'delete_notification': {
                const sessionId = args?.sessionId;
                const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                if (!notificationId) {
                    return { success: false, error: 'notificationId is required' };
                }
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const next = dismissSessionNotification(
                    loadState(),
                    sessionId,
                    notificationId,
                    targetSession?.providerSessionId,
                );
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    notificationId,
                };
            }

            case 'mark_notification_unread': {
                const sessionId = args?.sessionId;
                const notificationId = typeof args?.notificationId === 'string' ? args.notificationId.trim() : '';
                if (!sessionId || typeof sessionId !== 'string') {
                    return { success: false, error: 'sessionId is required' };
                }
                if (!notificationId) {
                    return { success: false, error: 'notificationId is required' };
                }
                const sessionEntries = buildSessionEntries(
                    this.deps.instanceManager.collectAllStates(),
                    this.deps.cdpManagers,
                );
                const targetSession = sessionEntries.find((entry) => entry.id === sessionId);
                const next = markSessionNotificationUnread(
                    loadState(),
                    sessionId,
                    notificationId,
                    targetSession?.providerSessionId,
                );
                saveState(next);
                this.deps.onStatusChange?.();
                return {
                    success: true,
                    sessionId,
                    notificationId,
                };
            }

            // ─── Daemon Self-Upgrade ───
            case 'daemon_upgrade': {
                LOG.info('Upgrade', 'Remote upgrade requested from dashboard');
                try {
                    // Detect package name for upgrade
                    const isStandalone = this.deps.packageName === '@adhdev/daemon-standalone'
                        || process.argv[1]?.includes('daemon-standalone');
                    const pkgName = isStandalone ? '@adhdev/daemon-standalone' : 'adhdev';
                    const npmSurface = resolveCurrentGlobalInstallSurface({ packageName: pkgName });
                    const channel = resolveUpgradeChannel(args);
                    const npmTag = CHANNEL_NPM_TAG[channel];

                    // Check channel-pinned dist-tag and resolve it to a concrete install version.
                    const latest = String(execNpmCommandSync(['view', `${pkgName}@${npmTag}`, 'version'], { encoding: 'utf-8', timeout: 10000 }, npmSurface)).trim();
                    LOG.info('Upgrade', `Latest ${pkgName}@${npmTag}: v${latest}`);
                    updateConfig({ updateChannel: channel, serverUrl: CHANNEL_SERVER_URL[channel] } as any);
                    let currentInstalled: string | null = null;
                    try {
                        const currentJson = String(execNpmCommandSync(['ls', '-g', pkgName, '--depth=0', '--json'], {
                            encoding: 'utf-8',
                            timeout: 10000,
                            stdio: ['pipe', 'pipe', 'pipe'],
                        }, npmSurface)).trim();
                        const parsed = JSON.parse(currentJson);
                        currentInstalled = parsed?.dependencies?.[pkgName]?.version || null;
                    } catch {
                        // ignore ls failures; upgrade can still proceed
                    }

                    const runningVersion = typeof this.deps.statusVersion === 'string'
                        ? this.deps.statusVersion.trim().replace(/^v/, '')
                        : null;
                    if (currentInstalled === latest && runningVersion === latest) {
                        LOG.info('Upgrade', `Already on ${channel} channel version v${latest}; skipping install`);
                        return { success: true, upgraded: false, alreadyLatest: true, version: latest, channel, npmTag };
                    }
                    if (currentInstalled === latest && runningVersion && runningVersion !== latest) {
                        LOG.info('Upgrade', `Installed package is v${latest}, but running daemon is v${runningVersion}; scheduling restart`);
                    }

                    spawnDetachedDaemonUpgradeHelper({
                        packageName: pkgName,
                        targetVersion: latest,
                        parentPid: process.pid,
                        restartArgv: process.argv.slice(1),
                        cwd: process.cwd(),
                        sessionHostAppName: process.env.ADHDEV_SESSION_HOST_NAME || 'adhdev',
                    });
                    LOG.info('Upgrade', `Scheduled detached ${channel} upgrade to v${latest}`);

                    // Exit after the command response has been sent so the helper can replace the package cleanly.
                    setTimeout(() => {
                        LOG.info('Upgrade', 'Exiting daemon so detached upgrader can continue...');
                        process.exit(0);
                    }, 3000);

                    return { success: true, upgraded: true, version: latest, restarting: true, channel, npmTag };
                } catch (e: any) {
                    LOG.error('Upgrade', `Failed: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }

            // ─── Machine Settings ───
            case 'set_machine_nickname': {
                const nickname = args?.nickname;
                updateConfig({ machineNickname: nickname || null });
                return { success: true };
            }

            // ─── Mesh CRUD (local meshes.json) ───
            case 'list_meshes': {
                try {
                    const { listMeshes } = await import('../config/mesh-config.js');
                    return { success: true, meshes: listMeshes() };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                if (!meshRecord?.mesh) return { success: false, error: 'Mesh not found' };

                const requireDirectPeerTruth = args?.requireDirectPeerTruth === true;
                // Only an explicit refresh fans out a blocking peer probe.
                // Default loads are satisfied from held standing-state git truth.
                const probeRemotePeers = args?.refresh === true || args?.forceRefresh === true;
                const directTruth = await hydrateInlineMeshDirectTruth({
                    mesh: meshRecord.mesh,
                    meshSource: meshRecord.source,
                    dispatchMeshCommand: this.deps.dispatchMeshCommand,
                    getMeshPeerConnectionStatus: this.deps.getMeshPeerConnectionStatus,
                    statusInstanceId: this.deps.statusInstanceId,
                    localMachineId: loadConfig().machineId || '',
                    probeRemotePeers,
                    probeCache: this.meshGitProbeCache,
                });
                const directTruthSatisfied = meshRecord.source !== 'inline_bootstrap' || directTruth.directEvidenceCount > 0;
                const sourceOfTruth = {
                    membership: meshRecord.source === 'inline_cache'
                        ? 'coordinator_inline_mesh_cache'
                        : meshRecord.source === 'local_config'
                            ? 'local_mesh_config'
                            : 'inline_bootstrap_snapshot',
                    coordinatorOwnsLiveTruth: directTruthSatisfied,
                    directPeerTruth: {
                        required: requireDirectPeerTruth,
                        satisfied: directTruthSatisfied,
                        directEvidenceCount: directTruth.directEvidenceCount,
                        localConfirmedCount: directTruth.localConfirmedCount,
                        peerAttemptedCount: directTruth.peerAttemptedCount,
                        peerConfirmedCount: directTruth.peerConfirmedCount,
                        unavailableNodeIds: directTruth.unavailableNodeIds,
                    },
                };
                if (requireDirectPeerTruth && !directTruthSatisfied) {
                    return {
                        success: false,
                        code: 'mesh_direct_peer_truth_unavailable',
                        error: 'Selected coordinator could not confirm direct mesh truth yet. Bootstrap inventory stays unavailable until direct get_mesh probes succeed.',
                        sourceOfTruth,
                    };
                }
                return { success: true, mesh: meshRecord.mesh, sourceOfTruth };
            }

            case 'create_mesh': {
                const name = typeof args?.name === 'string' ? args.name.trim() : '';
                const repoIdentity = typeof args?.repoIdentity === 'string' ? args.repoIdentity.trim() : '';
                const repoRemoteUrl = typeof args?.repoRemoteUrl === 'string' ? args.repoRemoteUrl.trim() : undefined;
                const defaultBranch = typeof args?.defaultBranch === 'string' ? args.defaultBranch.trim() : undefined;
                if (!name) return { success: false, error: 'name required' };
                try {
                    const { createMesh } = await import('../config/mesh-config.js');
                    const meshHost = args?.meshHost && typeof args.meshHost === 'object' && !Array.isArray(args.meshHost)
                        ? args.meshHost
                        : undefined;
                    const mesh = createMesh({ name, repoIdentity, repoRemoteUrl, defaultBranch, policy: args?.policy, meshHost });
                    return { success: true, mesh };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'update_mesh': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { updateMesh } = await import('../config/mesh-config.js');
                    const patch: Record<string, unknown> = {};
                    if (typeof args?.name === 'string') patch.name = args.name;
                    if (typeof args?.defaultBranch === 'string') patch.defaultBranch = args.defaultBranch;
                    if (args?.policy && typeof args.policy === 'object' && !Array.isArray(args.policy)) patch.policy = args.policy;
                    if (args?.coordinator && typeof args.coordinator === 'object' && !Array.isArray(args.coordinator)) patch.coordinator = args.coordinator;
                    if (args?.meshHost && typeof args.meshHost === 'object' && !Array.isArray(args.meshHost)) patch.meshHost = args.meshHost;
                    if (!Object.keys(patch).length) return { success: false, error: 'No updates provided' };
                    const mesh = updateMesh(meshId, patch as any);
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    this.inlineMeshCache.set(meshId, mesh);
                    this.invalidateAggregateMeshStatus(meshId);
                    return { success: true, mesh };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_host_pairing': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                const mesh = meshRecord?.mesh;
                if (!mesh) return { success: false, error: 'Mesh not found' };
                const meshHost = resolveMeshHostStatus(mesh);
                const pairingStatus = meshHost.pairing?.status || 'not_configured';
                return {
                    success: true,
                    code: pairingStatus === 'not_configured' ? 'mesh_host_pairing_not_configured' : 'mesh_host_pairing_pending',
                    meshId,
                    hostAddress: meshHost.hostAddress,
                    meshHost,
                    manualPairing: {
                        status: pairingStatus,
                        joinImplemented: true,
                        protocol: 'standalone_command_direct_v1',
                        description: 'Standalone manual pairing can save address/token metadata, apply a host join over direct standalone command HTTP or injected mesh command dispatch, and check persisted status. P2P signaling remains outside this slice.',
                    },
                };
            }

            case 'configure_mesh_host_pairing': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const hostAddress = typeof args?.hostAddress === 'string' ? args.hostAddress.trim() : '';
                const token = typeof args?.token === 'string' ? args.token.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!hostAddress || !token) return { success: false, error: 'hostAddress and token required' };
                try {
                    const { configureMeshHostPairing } = await import('../config/mesh-config.js');
                    const configured = configureMeshHostPairing(meshId, { hostAddress, token });
                    if (!configured) return { success: false, error: 'Mesh not found' };
                    this.inlineMeshCache.set(meshId, configured.mesh);
                    const meshHost = resolveMeshHostStatus(configured.mesh);
                    return {
                        success: true,
                        code: 'mesh_host_pairing_pending',
                        meshId,
                        hostAddress: configured.hostAddress,
                        meshHost,
                        manualPairing: {
                            status: meshHost.pairing?.status || 'pairing',
                            joinImplemented: true,
                            protocol: 'standalone_command_direct_v1',
                            description: 'Manual Mesh Host pairing config was saved locally. Use join_mesh_host_pairing to apply it to the host. Raw token was not persisted.',
                        },
                    };
                } catch (e: any) {
                    return { success: false, code: 'mesh_host_pairing_invalid', meshId, hostAddress, error: e.message };
                }
            }

            case 'create_mesh_host_pairing_token': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { createMeshHostPairingToken } = await import('../config/mesh-config.js');
                    const created = createMeshHostPairingToken(meshId, {
                        token: typeof args?.token === 'string' ? args.token : undefined,
                        expiresAt: typeof args?.expiresAt === 'string' ? args.expiresAt : undefined,
                    });
                    if (!created) return { success: false, error: 'Mesh not found' };
                    this.inlineMeshCache.set(meshId, created.mesh);
                    this.invalidateAggregateMeshStatus(meshId);
                    return {
                        success: true,
                        code: 'mesh_host_pairing_token_created',
                        meshId,
                        token: created.token,
                        tokenId: created.tokenId,
                        expiresAt: created.expiresAt,
                        meshHost: resolveMeshHostStatus(created.mesh),
                        warning: 'Raw token is returned once and is not persisted; share it with member daemons over a trusted channel.',
                    };
                } catch (e: any) {
                    return { success: false, code: 'mesh_host_pairing_token_invalid', meshId, error: e.message };
                }
            }

            case 'apply_mesh_host_join': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const token = typeof args?.token === 'string' ? args.token.trim() : '';
                const memberNode = args?.memberNode && typeof args.memberNode === 'object' && !Array.isArray(args.memberNode)
                    ? args.memberNode
                    : null;
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!token || !memberNode) return { success: false, error: 'token and memberNode required' };
                try {
                    const { applyMeshHostJoinRequest } = await import('../config/mesh-config.js');
                    const applied = applyMeshHostJoinRequest(meshId, {
                        token,
                        memberNode: memberNode as any,
                        memberMeshId: typeof args?.memberMeshId === 'string' ? args.memberMeshId : undefined,
                    });
                    if (!applied) return { success: false, error: 'Mesh not found' };
                    if (!applied.accepted) {
                        return {
                            success: false,
                            code: 'mesh_host_join_rejected',
                            meshId,
                            tokenId: applied.tokenId,
                            meshHost: applied.meshHost ? resolveMeshHostStatus({ meshHost: applied.meshHost }) : undefined,
                            error: applied.reason,
                        };
                    }
                    this.inlineMeshCache.set(meshId, applied.mesh);
                    this.invalidateAggregateMeshStatus(meshId);
                    try {
                        const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'node_joined',
                            nodeId: applied.node.id,
                            payload: { role: 'member', tokenId: applied.tokenId, workspace: applied.node.workspace },
                        });
                    } catch { /* ledger append is best-effort */ }
                    return {
                        success: true,
                        code: 'mesh_host_join_accepted',
                        meshId,
                        node: applied.node,
                        tokenId: applied.tokenId,
                        meshHost: resolveMeshHostStatus(applied.mesh),
                    };
                } catch (e: any) {
                    return { success: false, code: 'mesh_host_join_failed', meshId, error: e.message };
                }
            }

            case 'join_mesh_host_pairing': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const token = typeof args?.token === 'string' ? args.token.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!token) return { success: false, error: 'token required because raw pairing tokens are not persisted' };
                const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                const mesh = meshRecord?.mesh;
                if (!mesh) return { success: false, error: 'Mesh not found' };
                const meshHost = resolveMeshHostStatus(mesh);
                if (meshHost.role !== 'member') {
                    return { success: false, code: 'mesh_host_join_not_member', meshId, meshHost, error: 'join_mesh_host_pairing must run from a member daemon configured with a Mesh Host address/token.' };
                }
                try {
                    const { tokenIdForManualPairing, markMeshHostPairingJoined } = await import('../config/mesh-config.js');
                    const tokenId = tokenIdForManualPairing(token);
                    if (meshHost.pairing?.tokenId && meshHost.pairing.tokenId !== tokenId) {
                        return { success: false, code: 'mesh_host_join_rejected', meshId, tokenId, meshHost, error: 'invalid pairing token' };
                    }
                    const memberNode = buildMemberJoinNode(mesh, args, this.deps.statusInstanceId);
                    if (!memberNode) return { success: false, error: 'member node metadata unavailable' };
                    const hostMeshId = typeof args?.hostMeshId === 'string' && args.hostMeshId.trim() ? args.hostMeshId.trim() : meshId;
                    const hostDaemonId = typeof args?.hostDaemonId === 'string' && args.hostDaemonId.trim()
                        ? args.hostDaemonId.trim()
                        : meshHost.hostDaemonId;
                    let hostResult: any;
                    let transport: string;
                    if (hostDaemonId && this.deps.dispatchMeshCommand) {
                        transport = 'mesh_command_dispatch';
                        hostResult = await this.deps.dispatchMeshCommand(hostDaemonId, 'apply_mesh_host_join', {
                            meshId: hostMeshId,
                            token,
                            memberMeshId: meshId,
                            memberNode,
                        });
                    } else if (meshHost.hostAddress) {
                        transport = 'standalone_http_command';
                        const commandUrl = normalizeStandaloneHostCommandUrl(meshHost.hostAddress);
                        const response = await fetch(commandUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'apply_mesh_host_join', payload: { meshId: hostMeshId, token, memberMeshId: meshId, memberNode } }),
                        });
                        hostResult = await response.json().catch(() => ({ success: false, error: `Host returned HTTP ${response.status}` }));
                        if (!response.ok && hostResult?.success !== false) hostResult = { success: false, error: `Host returned HTTP ${response.status}` };
                    } else {
                        return {
                            success: false,
                            code: 'mesh_host_join_transport_unavailable',
                            meshId,
                            meshHost,
                            error: 'No hostDaemonId dispatch path or hostAddress HTTP command path is available. P2P signaling join is not implemented in this slice.',
                        };
                    }
                    if (!hostResult?.success) {
                        return { success: false, code: hostResult?.code || 'mesh_host_join_rejected', meshId, meshHost, transport, error: hostResult?.error || 'Mesh Host rejected join request', hostResult };
                    }
                    const joined = meshRecord.inline
                        ? null
                        : markMeshHostPairingJoined(meshId, {
                            tokenId: hostResult.tokenId || tokenId,
                            hostDaemonId: hostResult.meshHost?.hostDaemonId || hostDaemonId,
                            hostNodeId: hostResult.meshHost?.hostNodeId,
                            joinedAt: hostResult.meshHost?.pairing?.joinedAt,
                        });
                    if (joined) {
                        this.inlineMeshCache.set(meshId, joined.mesh);
                        this.invalidateAggregateMeshStatus(meshId);
                    }
                    return {
                        success: true,
                        code: 'mesh_host_join_applied',
                        meshId,
                        hostMeshId,
                        transport,
                        node: hostResult.node,
                        tokenId: hostResult.tokenId || tokenId,
                        meshHost: joined ? resolveMeshHostStatus(joined.mesh) : { ...meshHost, pairing: { ...(meshHost.pairing || {}), status: 'paired', tokenId: hostResult.tokenId || tokenId } },
                        hostResult,
                        manualPairing: {
                            status: 'paired',
                            joinImplemented: true,
                            protocol: 'standalone_command_direct_v1',
                            description: 'Mesh Host accepted the join and local member pairing status was marked paired. P2P runtime signaling remains outside this slice.',
                        },
                    };
                } catch (e: any) {
                    return { success: false, code: 'mesh_host_join_failed', meshId, meshHost, error: e.message };
                }
            }

            case 'delete_mesh': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { deleteMesh } = await import('../config/mesh-config.js');
                    const deleted = deleteMesh(meshId);
                    return { success: true, deleted };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_ledger': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { readLedgerEntries, getLedgerSummary } = await import('../mesh/mesh-ledger.js');
                    const tail = typeof args?.tail === 'number' ? args.tail : 20;
                    const since = typeof args?.since === 'string' ? args.since : undefined;
                    const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
                    const entries = readLedgerEntries(meshId, { tail, since, kind });
                    const summary = getLedgerSummary(meshId);
                    return { success: true, entries, summary };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_ledger_slice': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { readLedgerSlice } = await import('../mesh/mesh-ledger.js');
                    const kind = Array.isArray(args?.kind) ? args.kind.filter((k: any) => typeof k === 'string') : undefined;
                    const slice = readLedgerSlice(meshId, {
                        afterId: typeof args?.afterId === 'string' ? args.afterId : undefined,
                        since: typeof args?.since === 'string' ? args.since : undefined,
                        kind,
                        limit: typeof args?.limit === 'number' ? args.limit : undefined,
                    });
                    return { success: true, slice };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'import_mesh_ledger_slice': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { appendRemoteLedgerEntries, getLedgerSummary } = await import('../mesh/mesh-ledger.js');
                    const entries = Array.isArray(args?.entries)
                        ? args.entries as any[]
                        : Array.isArray(args?.slice?.entries)
                            ? args.slice.entries as any[]
                            : [];
                    const result = appendRemoteLedgerEntries(meshId, entries as any);
                    return { success: true, result, summary: getLedgerSummary(meshId) };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_queue': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { getMeshQueueStats, getQueue, describeTaskDependencyState } = await import('../mesh/mesh-work-queue.js');
                    const status = Array.isArray(args?.status)
                        ? args.status.map((s: any) => typeof s === 'string' ? s.trim() : '').filter(Boolean)
                        : undefined;
                    const rawQueue = getQueue(meshId, { status: status as any });
                    // M1: annotate dependency state at view time (waitingOn / dependenciesSatisfied).
                    const statusById = new Map(getQueue(meshId).map(task => [task.id, task.status]));
                    const queue = rawQueue.map(task =>
                        Array.isArray(task.dependsOn) && task.dependsOn.length > 0
                            ? { ...task, ...describeTaskDependencyState(task, statusById) }
                            : task);
                    const summary = getMeshQueueStats(meshId);
                    return {
                        success: true,
                        queue,
                        summary,
                        sourceOfTruth: {
                            kind: 'mesh_work_queue_file',
                            activeStatuses: ['pending', 'assigned'],
                            historicalStatuses: ['completed', 'failed', 'cancelled'],
                            notes: 'pending/assigned are active work; completed/failed/cancelled are historical records.',
                        },
                    };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'cancel_mesh_queue_task': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
                if (!meshId || !taskId) return { success: false, error: 'meshId and taskId required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'queue cancellation');
                if (ownerFailure) return ownerFailure;
                try {
                    const { cancelTask } = await import('../mesh/mesh-work-queue.js');
                    const reason = typeof args?.reason === 'string' ? args.reason : undefined;
                    const task = cancelTask(meshId, taskId, { reason });
                    if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
                    return { success: true, task };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'requeue_mesh_queue_task': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const taskId = typeof args?.taskId === 'string' ? args.taskId.trim() : '';
                if (!meshId || !taskId) return { success: false, error: 'meshId and taskId required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'queue requeue');
                if (ownerFailure) return ownerFailure;
                try {
                    const { requeueTask } = await import('../mesh/mesh-work-queue.js');
                    const task = requeueTask(meshId, taskId, {
                        reason: typeof args?.reason === 'string' ? args.reason : undefined,
                        targetNodeId: typeof args?.targetNodeId === 'string' ? args.targetNodeId.trim() : undefined,
                        targetSessionId: typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : undefined,
                        clearTargetNode: args?.clearTargetNode === true,
                        clearTargetSession: args?.clearTargetSession !== false,
                    });
                    if (!task) return { success: false, error: `Queue task '${taskId}' not found` };
                    return { success: true, task };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'add_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const workspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!workspace) return { success: false, error: 'workspace required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'node addition');
                if (ownerFailure) return ownerFailure;
                try {
                    const { addNode } = await import('../config/mesh-config.js');
                    const providerPriority = Array.isArray(args?.providerPriority)
                        ? args.providerPriority.map((type: any) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
                        : [];
                    const readOnly = args?.readOnly === true;
                    const providerRoles = normalizeProviderRoles(args?.providerRoles);
                    const policy = {
                        ...(readOnly ? { readOnly: true } : {}),
                        ...(providerPriority.length ? { providerPriority } : {}),
                        ...(providerRoles.length ? { providerRoles } : {}),
                    };
                    const role = normalizeMeshDaemonRole(args?.role);
                    const daemonId = typeof args?.daemonId === 'string' && args.daemonId.trim() ? args.daemonId.trim() : undefined;
                    const machineId = typeof args?.machineId === 'string' && args.machineId.trim() ? args.machineId.trim() : undefined;
                    const repoRoot = typeof args?.repoRoot === 'string' && args.repoRoot.trim() ? args.repoRoot.trim() : undefined;
                    const node = addNode(meshId, {
                        workspace,
                        ...(repoRoot ? { repoRoot } : {}),
                        ...(daemonId ? { daemonId } : {}),
                        ...(machineId ? { machineId } : {}),
                        ...(policy ? { policy } : {}),
                        ...(role ? { role } : {}),
                    });
                    if (!node) return { success: false, error: 'Mesh not found' };
                    // mesh_status hands back a coordinator-memory aggregate
                    // snapshot keyed on (meshId, queueRevision). Adding a
                    // node touches neither, so without an explicit cache
                    // bust the dashboard graph keeps rendering the pre-add
                    // node list (empty for a fresh mesh) even after the
                    // user clicks Refresh.
                    this.invalidateAggregateMeshStatus(meshId);
                    return { success: true, node };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'update_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'node update');
                if (ownerFailure) return ownerFailure;
                try {
                    const { updateNode } = await import('../config/mesh-config.js');
                    const policy = args?.policy && typeof args.policy === 'object' && !Array.isArray(args.policy)
                        ? { ...(args.policy as Record<string, unknown>) }
                        : {};
                    if (Array.isArray(args?.providerPriority)) {
                        const providerPriority = args.providerPriority
                            .map((type: any) => typeof type === 'string' ? type.trim() : '')
                            .filter(Boolean);
                        delete (policy as any).provider_priority;
                        if (providerPriority.length) {
                            (policy as any).providerPriority = providerPriority;
                        } else {
                            delete (policy as any).providerPriority;
                        }
                    }
                    // providerRoles: per-(node, provider) role label + maxParallel cap.
                    // Passing an explicit (possibly empty) array clears/replaces the
                    // declarations; omitting the arg leaves any value already on policy
                    // untouched (a full policy object passed by the caller still carries it).
                    if (Array.isArray(args?.providerRoles)) {
                        const providerRoles = normalizeProviderRoles(args.providerRoles);
                        if (providerRoles.length) {
                            (policy as any).providerRoles = providerRoles;
                        } else {
                            delete (policy as any).providerRoles;
                        }
                    }
                    const patch: Record<string, unknown> = { policy: policy as any };
                    if (typeof args?.systemPrompt === 'string') {
                        const trimmed = (args.systemPrompt as string).trim();
                        patch.systemPrompt = trimmed || undefined;
                    } else if (args?.systemPrompt === null) {
                        patch.systemPrompt = undefined;
                    }
                    const node = updateNode(meshId, nodeId, patch as any);
                    if (!node) return { success: false, error: 'Mesh node not found' };
                    // Provider priority / systemPrompt changes don't touch
                    // the queue revision, so without a manual bust the
                    // cached aggregate keeps surfacing pre-update values
                    // (priority chip, coordinator prompt preview, etc.).
                    this.invalidateAggregateMeshStatus(meshId);
                    return { success: true, node };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'cleanup_mesh_sessions': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'node removal');
                if (ownerFailure) return ownerFailure;
                try {
                    // preferInline so inline-cache-only clone nodes resolve (matches owner check above).
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                    if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };
                    const mode = this.normalizeMeshSessionCleanupMode(args?.mode ?? mesh?.policy?.sessionCleanupOnNodeRemove);
                    const sessionIds = Array.isArray(args?.sessionIds)
                        ? args.sessionIds.map((id: any) => typeof id === 'string' ? id.trim() : '').filter(Boolean)
                        : undefined;
                    const result = await this.cleanupMeshSessions({
                        meshId,
                        nodeId,
                        node,
                        mode,
                        sessionIds,
                        dryRun: args?.dryRun === true,
                        source: 'mesh_cleanup_sessions',
                    });
                    return result;
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_refine_config_schema': {
                return {
                    success: true,
                    schema: MESH_REFINE_CONFIG_SCHEMA,
                    locations: MESH_REFINE_CONFIG_LOCATIONS,
                    worktreeBootstrap: {
                        schema: MESH_WORKTREE_BOOTSTRAP_CONFIG_SCHEMA,
                        locations: MESH_WORKTREE_BOOTSTRAP_CONFIG_LOCATIONS,
                        sourceOfTruth: 'repo worktree bootstrap config',
                        runBehavior: 'When present and enabled, clone_mesh_node runs commands after submodule initialization and records status on the worktree node.',
                    },
                    sourceOfTruth: 'repo mesh/refine config',
                    heuristicRole: 'suggestions_only_not_execution_path',
                };
            }

            case 'validate_mesh_refine_config': {
                const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
                const mesh = args?.inlineMesh || {};
                const loaded = args?.config !== undefined
                    ? { config: args.config, source: 'inline', sourceType: 'mesh_policy' as const }
                    : loadMeshRefineConfig(mesh, workspace);
                const validation = loaded.config
                    ? validateMeshRefineConfig(loaded.config, loaded.source)
                    : { valid: false, errors: [((loaded as { error?: string }).error) || 'repo mesh/refine config unavailable'], commands: [], rejectedCommands: [] };
                return { success: validation.valid, ...loaded, ...validation };
            }

            case 'suggest_mesh_refine_config': {
                const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
                const mesh = args?.inlineMesh || {};
                return {
                    success: true,
                    ...suggestMeshRefineConfig(mesh, workspace),
                    note: 'Suggestions are heuristic scaffold only; Refinery will not execute them until saved into repo mesh/refine config.',
                };
            }

            case 'get_mesh_change_impact_config_schema': {
                return {
                    success: true,
                    schema: CHANGE_IMPACT_CONFIG_SCHEMA,
                    locations: CHANGE_IMPACT_CONFIG_LOCATIONS,
                    sourceOfTruth: 'repo change-impact config',
                    heuristicRole: 'suggestions_only_not_execution_path',
                    note: 'Declarative config only — JSON/YAML are parsed but never executed. Defines which package/file changes require a daemon rebuild/restart vs. a web-only redeploy vs. nothing.',
                };
            }

            case 'validate_mesh_change_impact_config': {
                const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
                if (args?.config !== undefined) {
                    const validation = validateChangeImpactConfig(args.config, 'inline');
                    return { success: validation.valid, source: 'inline', sourceType: 'mesh_policy', ...validation };
                }
                const loaded = loadChangeImpactConfig(workspace);
                if (loaded.sourceType === 'repo_file') {
                    const validation = validateChangeImpactConfig(loaded.config, loaded.source);
                    return { success: validation.valid, ...loaded, ...validation };
                }
                return {
                    success: false,
                    ...loaded,
                    valid: false,
                    errors: [loaded.error || 'repo change-impact config unavailable'],
                };
            }

            case 'suggest_mesh_change_impact_config': {
                const workspace = typeof args?.workspace === 'string' ? args.workspace : process.cwd();
                return {
                    success: true,
                    ...suggestChangeImpactConfig(workspace),
                    note: 'Suggestions are heuristic scaffold only; the draft must be reviewed and saved into repo change-impact config before it takes effect. Nothing is executed.',
                };
            }

            case 'mesh_init': {
                const workspace = typeof args?.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : process.cwd();
                const mesh = args?.inlineMesh || {};
                try {
                    const detected = await detectCLIs(this.deps.providerLoader, { includeVersion: true });
                    return { ...runMeshInit(mesh, workspace, detected, {
                        write: args?.write === true,
                        overwrite: args?.overwrite === true,
                    }) };
                } catch (e: any) {
                    return { success: false, error: e?.message || String(e) };
                }
            }

            case 'plan_mesh_refine_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                // preferInline: plan is the dry-run sibling of refine — clone nodes must resolve.
                const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                const mesh = meshRecord?.mesh;
                const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                if (!node?.workspace) return { success: false, error: `Node '${nodeId}' workspace not found` };
                return {
                    success: true,
                    dryRun: true,
                    nodeId,
                    workspace: node.workspace,
                    validationPlan: buildMeshRefineValidationPlan(mesh, node.workspace),
                    mergeWillRun: false,
                    cleanupWillRun: false,
                };
            }

            case 'fast_forward_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                let workspace = typeof args?.workspace === 'string' ? args.workspace.trim() : '';
                let submoduleIgnorePaths = Array.isArray(args?.submoduleIgnorePaths)
                    ? args.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string')
                    : undefined;
                let nodeDaemonId: string | undefined;
                let allowAutoPublishSubmoduleMainCommits = false;
                if (meshId && nodeId) {
                    // preferInline so fast-forward can resolve inline-cache-only clone worktree nodes.
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                    if (!workspace) {
                        workspace = typeof node?.workspace === 'string' ? node.workspace.trim() : '';
                    }
                    if (!submoduleIgnorePaths && Array.isArray(node?.policy?.submoduleIgnorePaths)) {
                        submoduleIgnorePaths = node.policy.submoduleIgnorePaths.filter((value: unknown): value is string => typeof value === 'string');
                    }
                    allowAutoPublishSubmoduleMainCommits = mesh?.policy?.allowAutoPublishSubmoduleMainCommits === true;
                    nodeDaemonId = typeof node?.daemonId === 'string' ? node.daemonId.trim() : undefined;
                }
                // If the target node belongs to a remote daemon, forward the command there.
                // _meshDirectDispatch prevents re-forwarding (and P2P self-dial) when the stored
                // daemonId uses a legacy format that doesn't match the receiving daemon's identity.
                const selfDaemonId = this.deps.statusInstanceId;
                const isRemote = nodeDaemonId && selfDaemonId && nodeDaemonId !== selfDaemonId;
                if (isRemote && this.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
                    const forwarded = await this.deps.dispatchMeshCommand(nodeDaemonId!, 'fast_forward_mesh_node', {
                        ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                        workspace,
                        _meshDirectDispatch: true,
                    });
                    return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
                }
                const result = await (fastForwardMeshNode({
                    meshId: meshId || undefined,
                    nodeId: nodeId || undefined,
                    workspace,
                    branch: typeof args?.branch === 'string' ? args.branch : undefined,
                    execute: args?.execute === true,
                    dryRun: args?.dryRun === true,
                    updateSubmodules: args?.updateSubmodules === true,
                    submoduleIgnorePaths,
                    mode: args?.mode === 'push' ? 'push' : 'merge',
                    pushSubmodules: args?.pushSubmodules === true,
                    allowAutoPublishSubmoduleMainCommits,
                }) as Promise<unknown>);
                return result as CommandRouterResult;
            }

            case 'get_mesh_node_logs': {
                // Coordinator-driven remote log fetch: read a (possibly remote)
                // daemon's recent log tail over P2P instead of opening a session
                // and grepping the file by hand. Mirrors fast_forward_mesh_node's
                // forward pattern — resolve the node, forward to its owning daemon
                // when remote, otherwise read locally. The reply tail is HARD
                // byte-bounded and secret-redacted before it leaves the machine.
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                let nodeDaemonId: string | undefined;
                if (meshId && nodeId) {
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const node = meshRecord?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                    nodeDaemonId = typeof node?.daemonId === 'string' ? node.daemonId.trim() : undefined;
                }
                // _meshDirectDispatch prevents re-forwarding (and P2P self-dial)
                // once the call lands on the owning daemon — that daemon then reads
                // its own logs even if the stored daemonId uses a legacy form.
                const selfDaemonId = this.deps.statusInstanceId;
                const isRemote = nodeDaemonId && selfDaemonId && nodeDaemonId !== selfDaemonId;
                if (isRemote && this.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
                    const forwarded = await this.deps.dispatchMeshCommand(nodeDaemonId!, 'get_mesh_node_logs', {
                        ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                        _meshDirectDispatch: true,
                    });
                    return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
                }

                // Local read on the owning daemon.
                const rawTailBytes = Number(args?.tailBytes);
                const tail = readDaemonLogTail({
                    date: typeof args?.date === 'string' ? args.date : undefined,
                    tailBytes: Number.isFinite(rawTailBytes) ? Math.min(rawTailBytes, MAX_TAIL_BYTES) : undefined,
                    grep: typeof args?.grep === 'string' ? args.grep : undefined,
                    sinceMs: Number.isFinite(Number(args?.sinceMs)) ? Number(args?.sinceMs) : undefined,
                });
                if (!tail.success) {
                    return {
                        success: false,
                        error: tail.error || 'failed to read daemon log tail',
                        nodeId,
                        logPath: tail.logPath,
                        platform: tail.platform,
                    } as CommandRouterResult;
                }
                // SECURITY: redact secrets from every line before returning over P2P.
                const redactedLines = redactLogLines(tail.lines);
                return {
                    success: true,
                    nodeId,
                    daemonId: selfDaemonId,
                    logPath: tail.logPath,
                    platform: tail.platform,
                    lines: redactedLines,
                    lineCount: redactedLines.length,
                    truncated: tail.truncated,
                    filtered: tail.filtered,
                    bytesReturned: tail.bytesReturned,
                    ...(tail.grep ? { grep: tail.grep } : {}),
                } as CommandRouterResult;
            }

            case 'refine_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };

                // Remote forward: a worktree node lives on its OWN daemon's machine, so the
                // refine (cd into node.workspace, merge → push → cleanup) must run on THAT
                // daemon — not the coordinator, whose filesystem has no such path. The sibling
                // fast_forward_mesh_node / clone_mesh_node handlers already forward to the
                // node's daemon; refine_mesh_node was the gap (the coordinator would cd into a
                // non-existent local path and fail), so remote-machine worktrees could not be
                // converged at all. Forward both dry-run (plan reads the worktree git state)
                // and execute (async merge job) so the same machine that owns the worktree
                // resolves it.
                //
                // coordinatorDaemonId: refine is ASYNC — the completed/failed event is queued
                // on the executing daemon's pending-events queue scoped to a coordinator id and
                // recovered by the coordinator's reconcile loop (pullRemoteNodeQueues →
                // get_pending_mesh_events). Without stamping our own status id, the remote
                // daemon would fall back to ITS OWN statusInstanceId as the coordinator
                // (startMeshRefineJob), scoping the terminal event to the wrong inbox where the
                // real coordinator never pulls it. Stamp the canonical status id (which is in
                // the coordinator's self-identity set used to scope the remote drain) so the
                // event routes back here. Preserve any caller-supplied coordinatorDaemonId.
                //
                // _meshDirectDispatch prevents re-forwarding (and P2P self-dial) once the call
                // has landed on the owning daemon — that daemon then executes locally even if
                // the stored daemonId uses a legacy form that doesn't match its own identity.
                {
                    const meshRecordForForward = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const forwardNode = meshRecordForForward?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                    const nodeDaemonId = typeof forwardNode?.daemonId === 'string' ? forwardNode.daemonId.trim() : undefined;
                    const selfDaemonId = this.deps.statusInstanceId;
                    const isRemote = nodeDaemonId && selfDaemonId && nodeDaemonId !== selfDaemonId;
                    if (isRemote && this.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
                        const callerCoordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
                            ? args.coordinatorDaemonId.trim()
                            : undefined;
                        const forwarded = await this.deps.dispatchMeshCommand(nodeDaemonId!, 'refine_mesh_node', {
                            ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                            coordinatorDaemonId: callerCoordinatorDaemonId || selfDaemonId,
                            _meshDirectDispatch: true,
                        });
                        return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
                    }
                }

                // Dry-run (plan-only) is the default and stays synchronous: it does no
                // validation/merge/push and returns the plan instantly. Only execute=true
                // (and not dry_run) goes through the async refine job that actually
                // validates → merges → pushes → cleans up. Mirrors the
                // batch_refine_mesh_nodes / fast_forward_mesh_node dry_run/execute contract.
                const isDryRun = args?.dryRun !== false && args?.execute !== true;
                if (isDryRun) {
                    // preferInline: plan is the dry-run sibling of refine — clone nodes must resolve.
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                    if (!node?.workspace) return { success: false, error: `Node '${nodeId}' workspace not found` };
                    return {
                        success: true,
                        dryRun: true,
                        nodeId,
                        workspace: node.workspace,
                        validationPlan: buildMeshRefineValidationPlan(mesh, node.workspace),
                        mergeWillRun: false,
                        cleanupWillRun: false,
                        hint: 'Dry-run only — no merge/push/cleanup performed. Re-invoke with execute:true to converge this node.',
                    };
                }
                return this.startMeshRefineJob(meshId, nodeId, args);
            }

            case 'batch_refine_mesh_nodes': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                const requestedNodeIds = Array.isArray(args?.nodeIds)
                    ? (args.nodeIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
                    : undefined;
                // Dry-run (plan-only) stays synchronous: it does no validation/merge and
                // returns instantly. Execute goes through the async batch job — immediate
                // {async:true, status:'accepted'} + background convergence + terminal event,
                // matching the single-node refine_mesh_node contract so long validation
                // suites can't time out the IPC and strand the coordinator.
                const isDryRun = args?.dryRun !== false && args?.execute !== true;
                if (isDryRun) return this.batchRefineMeshNodes(meshId, requestedNodeIds, args);
                return this.startMeshRefineBatchJob(meshId, requestedNodeIds, args);
            }

            case 'remove_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId || !nodeId) return { success: false, error: 'meshId and nodeId required' };
                try {
                    // preferInline so removal can resolve inline-cache-only clone worktree nodes.
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    const node = mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));

                    // Guard: refuse to remove the coordinator's OWN local base node
                    // (same machine, NOT a worktree). Removing it breaks live mesh
                    // membership — the coordinator can no longer be reached and has
                    // to be restarted. Worktree clones are always safe to remove;
                    // only the non-worktree node bound to this daemon is protected.
                    // An explicit force:true overrides for intentional mesh teardown.
                    if (node && !args?._meshDirectDispatch && node.isLocalWorktree !== true && args?.force !== true) {
                        const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : '';
                        const nodeMachineId = readMeshNodeMachineId(node as Record<string, unknown>) || '';
                        const selfDaemonId = this.deps.statusInstanceId || '';
                        const selfMachineId = (() => { try { return loadConfig().machineId || ''; } catch { return ''; } })();
                        const isCoordinatorBaseNode =
                            (!!selfDaemonId && (nodeDaemonId === selfDaemonId || nodeMachineId === selfDaemonId))
                            || (!!selfMachineId && (nodeDaemonId === selfMachineId || nodeMachineId === selfMachineId));
                        if (isCoordinatorBaseNode) {
                            return {
                                success: false,
                                removed: false,
                                code: 'mesh_remove_coordinator_base_node_protected',
                                error: `Refusing to remove the coordinator's own base node '${typeof node.workspace === 'string' ? node.workspace : nodeId}'. `
                                    + `It is the local non-worktree node bound to this coordinator daemon; removing it breaks live mesh membership and forces a restart.`,
                                recoveryHint: 'Remove worktree clone nodes instead, or pass force:true only if you are intentionally tearing down this mesh and accept that the coordinator must be re-registered/restarted.',
                            };
                        }
                    }

                    const sessionCleanupMode = this.normalizeMeshSessionCleanupMode(
                        args?.sessionCleanupMode ?? args?.session_cleanup_mode ?? mesh?.policy?.sessionCleanupOnNodeRemove,
                    );
                    // Explicit sessionIds (e.g. supplied by refine auto-cleanup) bypass the
                    // workspace-only-match guard so a delegate session that lacks a
                    // meta.meshNodeId binding can still be stopped/deleted.
                    const explicitSessionIds = Array.isArray(args?.sessionIds)
                        ? (args.sessionIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
                        : undefined;
                    let sessionCleanup: Record<string, unknown> | undefined;
                    if (node && sessionCleanupMode !== 'preserve') {
                        sessionCleanup = await this.cleanupMeshSessions({
                            meshId,
                            nodeId,
                            node,
                            mode: sessionCleanupMode,
                            ...(explicitSessionIds && explicitSessionIds.length > 0 ? { sessionIds: explicitSessionIds } : {}),
                            source: 'mesh_remove_node',
                        });
                        if (sessionCleanup.success === false) return { success: false, removed: false, sessionCleanup };
                    }

                    let worktreeCleanup: Record<string, unknown> | undefined;
                    if (node?.isLocalWorktree) {
                        const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : undefined;
                        const isRemoteWorktree = nodeDaemonId && nodeDaemonId !== this.deps.statusInstanceId && this.deps.dispatchMeshCommand
                            && !args?._meshDirectDispatch;
                        if (isRemoteWorktree) {
                            // Worktree lives on a different machine — ask that daemon to clean it up.
                            // _meshDirectDispatch prevents re-forwarding when stored daemonId uses legacy format.
                            const forwarded = await this.deps.dispatchMeshCommand!(nodeDaemonId!, 'remove_mesh_node', {
                                ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                                _meshDirectDispatch: true,
                            });
                            return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
                        }
                        const cleanupResult = await this.cleanupLocalWorktreeNode({ mesh, node, nodeId, force: args?.force === true });
                        if (cleanupResult.success === false) {
                            return {
                                success: false,
                                removed: false,
                                code: cleanupResult.code,
                                error: cleanupResult.error,
                                recoveryHint: cleanupResult.recoveryHint,
                                ...(sessionCleanup ? { sessionCleanup } : {}),
                                worktreeCleanup: cleanupResult,
                            };
                        }
                        worktreeCleanup = cleanupResult;
                    }

                    let removed = false;
                    if (meshRecord?.inline) {
                        removed = this.removeInlineMeshNode(meshId, mesh, nodeId);
                        // Inline meshes share the same aggregate snapshot cache as
                        // local-config meshes; without this bust the removed node
                        // keeps showing up in the dashboard graph until the cache
                        // ages out on its own.
                        if (removed) this.invalidateAggregateMeshStatus(meshId);
                        // Node was already absent from the inline mesh (e.g. removed by a
                        // prior refine cleanup). Treat as removed so caller gets removed:true.
                        if (!removed && !node) removed = true;
                    } else {
                        const { removeNode } = await import('../config/mesh-config.js');
                        removed = removeNode(meshId, nodeId);
                        // Node already absent from config (e.g. removed by a prior refine
                        // cleanup after a successful Refinery merge). Treat as removed so
                        // the response is accurate.
                        if (!removed && !node) removed = true;
                        if (removed) this.invalidateAggregateMeshStatus(meshId);
                    }

                    // Record in task ledger
                    if (removed) {
                        try {
                            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                            appendLedgerEntry(meshId, {
                                kind: 'node_removed',
                                nodeId,
                                payload: {
                                    worktree: !!node?.isLocalWorktree,
                                    sessionCleanupMode,
                                    workspace: typeof node?.workspace === 'string' ? node.workspace : undefined,
                                    daemonId: typeof node?.daemonId === 'string' ? node.daemonId : undefined,
                                    worktreeBranch: typeof node?.worktreeBranch === 'string' ? node.worktreeBranch : undefined,
                                    worktreeCleanupFallback: typeof worktreeCleanup?.fallback === 'string' ? worktreeCleanup.fallback : undefined,
                                    forced: worktreeCleanup?.forced === true ? true : undefined,
                                    forceFallbackReason: typeof worktreeCleanup?.reason === 'string' ? worktreeCleanup.reason : undefined,
                                },
                            });
                        } catch { /* ledger append is best-effort */ }
                    }

                    return { success: true, removed, ...(sessionCleanup ? { sessionCleanup } : {}), ...(worktreeCleanup ? { worktreeCleanup } : {}) };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'clone_mesh_node': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const sourceNodeId = typeof args?.sourceNodeId === 'string' ? args.sourceNodeId.trim() : '';
                const branch = typeof args?.branch === 'string' ? args.branch.trim() : '';
                const baseBranch = typeof args?.baseBranch === 'string' ? args.baseBranch.trim() : undefined;
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!sourceNodeId) return { success: false, error: 'sourceNodeId required' };
                if (!branch) return { success: false, error: 'branch required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'worktree clone');
                if (ownerFailure) return ownerFailure;

                try {
                    // Resolve with preferInline so the clone writes the new node into the
                    // same representation that get_mesh reads back. The MCP coordinator
                    // passes inlineMesh on every mesh command, so when it owns an inline
                    // mesh the membership read path (get_mesh, preferInline: true) returns
                    // the inline cache. Without preferInline here, clone could resolve to a
                    // local-config mesh and write the node only to config — leaving the
                    // inline cache (and therefore get_mesh / refreshMeshFromDaemon) without
                    // the node, so the new worktree node is never visible in live mesh
                    // membership even though worktree_bootstrap_complete fires.
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };

                    const sourceNode = mesh.nodes?.find((n: any) => meshNodeIdMatches(n, sourceNodeId));
                    if (!sourceNode) return { success: false, error: `Source node '${sourceNodeId}' not found in mesh` };

                    // Forward to the source node's daemon if it's on a different machine.
                    // _meshDirectDispatch prevents infinite re-forwarding when the stored daemonId
                    // uses a legacy format that doesn't match the receiving daemon's statusInstanceId.
                    const sourceDaemonId = typeof sourceNode.daemonId === 'string' ? sourceNode.daemonId.trim() : undefined;
                    if (sourceDaemonId && sourceDaemonId !== this.deps.statusInstanceId && this.deps.dispatchMeshCommand
                        && !args?._meshDirectDispatch) {
                        const forwarded = await this.deps.dispatchMeshCommand(sourceDaemonId, 'clone_mesh_node', {
                            ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                            _meshDirectDispatch: true,
                        });
                        return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
                    }

                    const repoRoot = sourceNode.repoRoot || sourceNode.workspace;
                    const { createWorktree } = await import('../git/git-worktree.js');
                    const result = await createWorktree({
                        repoRoot,
                        branch,
                        baseBranch,
                        meshName: mesh.name,
                    });

                    let node: any;
                    if (meshRecord.inline) {
                        const { randomUUID } = await import('crypto');
                        node = {
                            id: `node_${randomUUID().replace(/-/g, '')}`,
                            workspace: result.worktreePath,
                            repoRoot: result.worktreePath,
                            daemonId: sourceNode.daemonId,
                            machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                            userOverrides: { ...(sourceNode.userOverrides || {}) },
                            policy: { ...(sourceNode.policy || {}) },
                            isLocalWorktree: true,
                            worktreeBranch: result.branch,
                            clonedFromNodeId: sourceNodeId,
                        };
                        this.updateInlineMeshNode(meshId, mesh, node);
                    } else {
                        const { addNode } = await import('../config/mesh-config.js');
                        node = addNode(meshId, {
                            workspace: result.worktreePath,
                            repoRoot: result.worktreePath,
                            daemonId: sourceNode.daemonId,
                            machineId: sourceNode.machineId ?? (sourceNode as any).machine_id,
                            userOverrides: { ...(sourceNode.userOverrides || {}) },
                            isLocalWorktree: true,
                            worktreeBranch: result.branch,
                            clonedFromNodeId: sourceNodeId,
                            policy: { ...(sourceNode.policy || {}) },
                        });
                        if (!node) return { success: false, error: 'Failed to register worktree node' };
                        // Also reconcile the freshly-registered node into any warmed inline
                        // cache for this mesh. get_mesh (preferInline: true) reads the inline
                        // cache first when one exists; if we only wrote to local config the
                        // node would be invisible to membership reads. updateInlineMeshNode is
                        // a no-op when no inline cache is present.
                        const inlineForReconcile = this.getCachedInlineMesh(meshId);
                        if (inlineForReconcile) this.updateInlineMeshNode(meshId, inlineForReconcile, node);
                        this.invalidateAggregateMeshStatus(meshId);
                    }

                    const persistWorktreeSetupState = async (bootstrapState: WorktreeBootstrapState): Promise<void> => {
                        node.worktreeBootstrap = bootstrapState;
                        if (meshRecord.inline) {
                            this.updateInlineMeshNode(meshId, mesh, node);
                            return;
                        }
                        try {
                            const { updateNode } = await import('../config/mesh-config.js');
                            updateNode(meshId, node.id, { worktreeBootstrap: bootstrapState });
                            this.invalidateAggregateMeshStatus(meshId);
                        } catch { /* bootstrap status persistence is best-effort */ }
                    };

                    const appendCloneLedger = async (initSubmodules: boolean, bootstrapState: WorktreeBootstrapState): Promise<void> => {
                        try {
                            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                            appendLedgerEntry(meshId, {
                                kind: 'node_cloned',
                                nodeId: node.id,
                                payload: {
                                    sourceNodeId,
                                    branch: result.branch,
                                    worktreePath: result.worktreePath,
                                    submodulesInitialized: initSubmodules,
                                    worktreeBootstrap: {
                                        status: bootstrapState.status,
                                        required: bootstrapState.required,
                                        configSource: bootstrapState.configSource,
                                        configSourceType: bootstrapState.configSourceType,
                                        lastCommand: bootstrapState.lastCommand,
                                        exitCode: bootstrapState.exitCode,
                                    },
                                },
                            });
                        } catch { /* ledger append is best-effort */ }
                    };

                    const initSubmodules = (sourceNode.policy as any)?.initSubmodulesOnClone !== false;
                    const loadedBootstrap = loadMeshWorktreeBootstrapConfig(mesh, result.worktreePath);
                    const runningBootstrapState: WorktreeBootstrapState = {
                        status: 'running',
                        required: loadedBootstrap.config?.required !== false,
                        configSource: loadedBootstrap.path || loadedBootstrap.source,
                        configSourceType: loadedBootstrap.sourceType,
                        startedAt: new Date().toISOString(),
                    };
                    await persistWorktreeSetupState(runningBootstrapState);

                    const finishWorktreeSetup = async (): Promise<{ submodulesInitialized: boolean; bootstrapState: WorktreeBootstrapState }> => {
                        let submodulesInitialized = false;
                        if (initSubmodules) {
                            try {
                                const { runGit } = await import('../git/git-executor.js');
                                await runGit(
                                    { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true },
                                    ['submodule', 'update', '--init', '--recursive'],
                                    { timeoutMs: 120000 },
                                );
                                submodulesInitialized = true;

                                // Sync oss submodule to source node HEAD (best-effort)
                                const sourceWorkspace = sourceNode.repoRoot || sourceNode.workspace;
                                if (sourceWorkspace) {
                                    try {
                                        const { runGit: rg } = await import('../git/git-executor.js');
                                        const sourceCtx = { workspace: sourceWorkspace, repoRoot: sourceWorkspace, isGitRepo: true };
                                        const worktreeCtx = { workspace: result.worktreePath, repoRoot: result.worktreePath, isGitRepo: true };

                                        // Read source node's oss submodule SHA
                                        const sourceStatusOut = await rg(sourceCtx, ['submodule', 'status', 'oss'], { timeoutMs: 10000 });
                                        const sourceStatusLine = (typeof sourceStatusOut === 'string' ? sourceStatusOut : (sourceStatusOut as any)?.stdout ?? '').trim();
                                        const sourceShaMatch = sourceStatusLine.match(/^[+\- ]?([0-9a-f]{40})/);
                                        const sourceSha = sourceShaMatch?.[1];

                                        if (sourceSha) {
                                            // Read worktree's current oss HEAD
                                            const ossCtx = { workspace: `${result.worktreePath}/oss`, repoRoot: `${result.worktreePath}/oss`, isGitRepo: true };
                                            const worktreeOssHeadOut = await rg(ossCtx, ['rev-parse', 'HEAD'], { timeoutMs: 10000 });
                                            const worktreeOssSha = (typeof worktreeOssHeadOut === 'string' ? worktreeOssHeadOut : (worktreeOssHeadOut as any)?.stdout ?? '').trim();

                                            if (worktreeOssSha !== sourceSha) {
                                                // Fetch target SHA from source node's oss directory
                                                await rg(ossCtx, ['fetch', `${sourceWorkspace}/oss`, 'HEAD'], { timeoutMs: 60000 });
                                                await rg(ossCtx, ['checkout', sourceSha], { timeoutMs: 10000 });
                                                await rg(worktreeCtx, ['add', 'oss'], { timeoutMs: 10000 });
                                                await rg(worktreeCtx, ['commit', '-m', 'chore: sync oss to source node HEAD on clone'], { timeoutMs: 10000 });
                                                console.log(`[mesh] Synced oss submodule to source HEAD ${sourceSha.slice(0, 8)} in worktree`);
                                            }
                                        }
                                    } catch (ossErr: any) {
                                        console.warn('[mesh] oss submodule sync to source HEAD failed (best-effort):', ossErr.message);
                                    }
                                }
                            } catch (subErr: any) {
                                // Submodule init is best-effort; don't fail the clone
                                console.warn('[mesh] Submodule init failed for worktree:', subErr.message);
                            }
                        }
                        const bootstrapState: WorktreeBootstrapState = await runMeshWorktreeBootstrap(mesh, result.worktreePath);
                        await persistWorktreeSetupState(bootstrapState);
                        await appendCloneLedger(submodulesInitialized, bootstrapState);
                        return { submodulesInitialized, bootstrapState };
                    };

                    const requestedSetupWaitMs = Number(args?.setupWaitMs ?? args?.bootstrapWaitMs ?? 8000);
                    const setupWaitMs = Number.isFinite(requestedSetupWaitMs)
                        ? Math.min(Math.max(requestedSetupWaitMs, 0), 14000)
                        : 8000;
                    const setupPromise = finishWorktreeSetup();
                    const setupResult = await Promise.race([
                        setupPromise.then((value) => ({ completed: true as const, value })),
                        new Promise<{ completed: false }>((resolve) => setTimeout(() => resolve({ completed: false }), setupWaitMs)),
                    ]);

                    const emitBootstrapEvent = (eventStatus: 'bootstrap_complete' | 'bootstrap_failed', bootstrapState: WorktreeBootstrapState, startedAtMs: number, extraPayload?: Record<string, unknown>): void => {
                        try {
                            const durationMs = Date.now() - startedAtMs;
                            const event = `worktree_${eventStatus}` as const;
                            const metadataEvent = {
                                source: 'clone_mesh_node_bootstrap',
                                nodeId: node.id,
                                status: eventStatus,
                                worktreePath: result.worktreePath,
                                durationMs,
                                bootstrapStatus: bootstrapState.status,
                                ...(bootstrapState.error ? { error: bootstrapState.error } : {}),
                                ...(bootstrapState.exitCode !== undefined ? { exitCode: bootstrapState.exitCode } : {}),
                                ...(extraPayload || {}),
                            };
                            if (typeof this.deps.instanceManager?.getByCategory === 'function') {
                                const forwarded = handleMeshForwardEvent(
                                    { instanceManager: this.deps.instanceManager } as any,
                                    { event, meshId, nodeId: node.id, workspace: result.worktreePath, metadataEvent },
                                );
                                if (forwarded?.success === true) return;
                            }
                            queuePendingMeshCoordinatorEvent({
                                event,
                                meshId,
                                nodeLabel: node.id,
                                nodeId: node.id,
                                workspace: result.worktreePath,
                                metadataEvent,
                                queuedAt: Date.now(),
                            });
                        } catch { /* event emission is best-effort */ }
                    };

                    const bootstrapStartedMs = Date.now();

                    if (!setupResult.completed) {
                        setupPromise
                            .then(({ bootstrapState }) => {
                                emitBootstrapEvent('bootstrap_complete', bootstrapState, bootstrapStartedMs);
                            })
                            .catch((error: any) => {
                                const failedState: WorktreeBootstrapState = {
                                    ...runningBootstrapState,
                                    status: 'failed',
                                    completedAt: new Date().toISOString(),
                                    error: error?.message || String(error),
                                };
                                void persistWorktreeSetupState(failedState);
                                void appendCloneLedger(false, failedState);
                                emitBootstrapEvent('bootstrap_failed', failedState, bootstrapStartedMs, { error: error?.message || String(error) });
                            });
                        return {
                            success: true,
                            async: true,
                            status: 'accepted',
                            node,
                            worktreePath: result.worktreePath,
                            branch: result.branch,
                            worktreeBootstrap: runningBootstrapState,
                            worktreeSetup: {
                                status: 'running',
                                setupWaitMs,
                                message: 'Worktree node is registered; submodule/bootstrap setup is continuing in the background.',
                            },
                        };
                    }

                    const { submodulesInitialized, bootstrapState } = setupResult.value;
                    emitBootstrapEvent('bootstrap_complete', bootstrapState, bootstrapStartedMs);
                    return {
                        success: true,
                        node,
                        worktreePath: result.worktreePath,
                        branch: result.branch,
                        submodulesInitialized,
                        worktreeBootstrap: bootstrapState,
                    };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }
            case 'retry_mesh_node_bootstrap': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                if (!nodeId) return { success: false, error: 'nodeId required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'bootstrap retry');
                if (ownerFailure) return ownerFailure;

                try {
                    // preferInline so bootstrap-retry can resolve inline-cache-only clone worktree nodes.
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };

                    const node = mesh.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
                    if (!node) return { success: false, error: `Node '${nodeId}' not found in mesh` };
                    if (!node.isLocalWorktree) return { success: false, error: 'Node is not a local worktree node' };

                    // Bootstrap runs scripts in the worktree path — forward to the node's daemon if remote.
                    // _meshDirectDispatch prevents re-forwarding when stored daemonId uses legacy format.
                    const nodeDaemonId = typeof node.daemonId === 'string' ? node.daemonId.trim() : undefined;
                    if (nodeDaemonId && nodeDaemonId !== this.deps.statusInstanceId && this.deps.dispatchMeshCommand
                        && !args?._meshDirectDispatch) {
                        const forwarded = await this.deps.dispatchMeshCommand(nodeDaemonId, 'retry_mesh_node_bootstrap', {
                            ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                            _meshDirectDispatch: true,
                        });
                        return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
                    }

                    const currentBootstrap = node.worktreeBootstrap as WorktreeBootstrapState | undefined;
                    if (currentBootstrap?.status === 'running') {
                        return { success: false, error: 'Bootstrap is already running for this node' };
                    }

                    const worktreePath: string = node.workspace || node.repoRoot;
                    if (!worktreePath) return { success: false, error: 'Node has no workspace path' };

                    const loadedBootstrap = loadMeshWorktreeBootstrapConfig(mesh, worktreePath);
                    const runningState: WorktreeBootstrapState = {
                        status: 'running',
                        required: loadedBootstrap.config?.required !== false,
                        configSource: loadedBootstrap.path || loadedBootstrap.source,
                        configSourceType: loadedBootstrap.sourceType,
                        startedAt: new Date().toISOString(),
                    };

                    const persistState = async (bootstrapState: WorktreeBootstrapState): Promise<void> => {
                        node.worktreeBootstrap = bootstrapState;
                        if (meshRecord.inline) {
                            this.updateInlineMeshNode(meshId, mesh, node);
                            return;
                        }
                        try {
                            const { updateNode } = await import('../config/mesh-config.js');
                            updateNode(meshId, node.id, { worktreeBootstrap: bootstrapState });
                            this.invalidateAggregateMeshStatus(meshId);
                        } catch { /* best-effort */ }
                    };

                    await persistState(runningState);
                    const bootstrapState = await runMeshWorktreeBootstrap(mesh, worktreePath);
                    await persistState(bootstrapState);

                    return { success: true, bootstrapState };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'trigger_mesh_queue': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                const ownerFailure = await this.requireMeshHostMutationOwner(meshId, args?.inlineMesh, 'queue trigger');
                if (ownerFailure) return ownerFailure;
                try {
                    const { triggerMeshQueue, tryAssignQueueTask } = await import('../mesh/mesh-events.js');

                    // Bug A fix: when preferredNodeId is provided, attempt to claim a pending
                    // task for the preferred node's idle session first, before the general
                    // round-robin trigger picks a different node.
                    const preferredNodeId = typeof args?.preferredNodeId === 'string' ? args.preferredNodeId.trim() : '';
                    if (preferredNodeId) {
                        const cliInstances = this.deps.instanceManager.getByCategory('cli');
                        // Sort: preferred node's sessions first, others after
                        const sorted = [...cliInstances].sort((a, b) => {
                            const aSettings = a.getState().settings as Record<string, unknown> || {};
                            const bSettings = b.getState().settings as Record<string, unknown> || {};
                            const aNode = readStringValue(aSettings.meshNodeId, aSettings.nodeId);
                            const bNode = readStringValue(bSettings.meshNodeId, bSettings.nodeId);
                            return (aNode === preferredNodeId ? -1 : 0) - (bNode === preferredNodeId ? -1 : 0);
                        });
                        for (const inst of sorted) {
                            const state = inst.getState();
                            const settings = state.settings as Record<string, unknown> || {};
                            const nodeId = readStringValue(settings.meshNodeId, settings.nodeId);
                            if (!nodeId || nodeId !== preferredNodeId) continue;
                            const meshNodeFor = readStringValue(settings.meshNodeFor);
                            if (meshNodeFor !== meshId) continue;
                            const status = (readStringValue(state.status) || '').toLowerCase();
                            if (status !== 'idle') continue;
                            const sessionId = typeof state.instanceId === 'string' ? state.instanceId : '';
                            const providerType = readStringValue(state.type, settings.providerType) || '';
                            if (sessionId && providerType) {
                                tryAssignQueueTask(this.deps as any, meshId, nodeId, sessionId, providerType);
                                break;
                            }
                        }
                    }

                    const trigger = await triggerMeshQueue(this.deps as any, meshId);
                    return { success: true, trigger };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            // ─── Mesh Coordinator Launch ───
            case 'launch_mesh_coordinator': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                let cliType = typeof args?.cliType === 'string' ? args.cliType.trim() : '';
                // Optional per-launch system-prompt addition. Dashboard or API
                // callers (e.g. when spawning a mesh-node-specific coordinator)
                // can pass extra context that gets appended to the rendered
                // default prompt under the "## Additional Context" section.
                // Going through buildCoordinatorSystemPrompt's userInstruction
                // means user-level override files (~/.adhdev/coordinator-prompts)
                // and this per-launch addition compose cleanly: an override
                // wins outright, but if there's no override, the default
                // prompt + the optional append.md file + this extra context
                // all stack in declared order.
                const extraSystemPrompt = typeof args?.extraSystemPrompt === 'string'
                    ? args.extraSystemPrompt.trim()
                    : '';
                if (!meshId) return { success: false, error: 'meshId required' };

                try {
                    const { buildCoordinatorSystemPrompt } = await import('../mesh/coordinator-prompt.js');
                    const { buildMissionPromptSection } = await import('../mesh/mesh-missions.js');
                    // M3-3: inject the active mission summary into the coordinator prompt.
                    // Best-effort — a store failure must not block coordinator launch.
                    const buildMissionSectionBestEffort = (id: string): string => {
                        try { return buildMissionPromptSection(id); } catch { return ''; }
                    };

                    // Support inline mesh data from cloud (bypasses local meshes.json lookup)
                    let mesh: any;
                    if (args?.inlineMesh && typeof args.inlineMesh === 'object') {
                        mesh = args.inlineMesh;
                        // Cache cloud mesh so the MCP server can retrieve it via get_mesh
                        this.inlineMeshCache.set(meshId, mesh);
                    } else {
                        const { getMesh } = await import('../config/mesh-config.js');
                        mesh = getMesh(meshId);
                    }
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    const meshHost = resolveMeshHostStatus(mesh);
                    if (!meshHost.canOwnCoordinator) {
                        return {
                            success: false,
                            ...buildMeshHostRequiredFailure(mesh, 'coordinator launch'),
                            meshId,
                            cliType,
                        };
                    }
                    if (!Array.isArray(mesh.nodes) || mesh.nodes.length === 0) return { success: false, error: 'No nodes in mesh' };

                    const requestedCoordinatorNodeId = typeof args?.coordinatorNodeId === 'string'
                        ? args.coordinatorNodeId.trim()
                        : '';
                    const preferredCoordinatorNodeId = requestedCoordinatorNodeId
                        || (typeof mesh.coordinator?.preferredNodeId === 'string' ? mesh.coordinator.preferredNodeId.trim() : '');
                    const coordinatorNode = preferredCoordinatorNodeId
                        ? mesh.nodes.find((node: any) => node?.id === preferredCoordinatorNodeId || node?.nodeId === preferredCoordinatorNodeId)
                        : mesh.nodes[0];
                    if (!coordinatorNode) {
                        return {
                            success: false,
                            code: 'mesh_coordinator_node_not_found',
                            error: `Coordinator node ${preferredCoordinatorNodeId} was not found in mesh`,
                            meshId,
                            cliType,
                        };
                    }
                    const sessionHostRecords = this.deps.sessionHostControl?.listSessions
                        ? await this.deps.sessionHostControl.listSessions().catch(() => [])
                        : [];
                    const liveMeshSessions = partitionSessionHostRecords(Array.isArray(sessionHostRecords) ? sessionHostRecords : []).liveRuntimes;
                    const workspace = readLiveMeshNodeWorkspace({
                        meshId,
                        nodeId: String(normalizeMeshNodeId(coordinatorNode) || preferredCoordinatorNodeId || ''),
                        liveSessionRecords: liveMeshSessions,
                        allowCoordinatorSession: true,
                    }) || (typeof coordinatorNode.workspace === 'string' ? coordinatorNode.workspace.trim() : '');
                    if (!workspace) return { success: false, error: 'Coordinator node workspace required', meshId, cliType };
                    if (!cliType) {
                        const resolved = await resolveProviderTypeFromPriority({
                            nodeId: String(normalizeMeshNodeId(coordinatorNode) || preferredCoordinatorNodeId || 'coordinator'),
                            providerPriority: readProviderPriorityFromPolicy(coordinatorNode.policy),
                            providerLoader: this.deps.providerLoader,
                            onStatusChange: this.deps.onStatusChange,
                        });
                        if (!resolved.providerType) {
                            return {
                                success: false,
                                code: 'mesh_coordinator_provider_priority_unusable',
                                error: resolved.error || 'No usable provider found from node providerPriority',
                                meshId,
                                cliType,
                                workspace,
                            };
                        }
                        cliType = resolved.providerType;
                    }
                    const providerMeta = this.deps.providerLoader.resolve?.(cliType) || this.deps.providerLoader.getMeta(cliType);
                    const coordinatorSetup = resolveMeshCoordinatorSetup({
                        provider: providerMeta,
                        cliType,
                        meshId,
                        workspace,
                    });

                    if (coordinatorSetup.kind === 'unsupported') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_unsupported',
                            error: coordinatorSetup.reason,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    if (coordinatorSetup.kind === 'manual') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_manual_mcp_setup_required',
                            error: coordinatorSetup.instructions,
                            meshId,
                            cliType,
                            workspace,
                            meshCoordinatorSetup: coordinatorSetup,
                        };
                    }

                    // ─── CLI-command MCP registration (Codex, Gemini CLI) ───────────
                    if (coordinatorSetup.kind === 'cli_command') {
                        // Build coordinator prompt first — fail closed on errors.
                        let cliCmdSystemPrompt = '';
                        try {
                            cliCmdSystemPrompt = buildCoordinatorSystemPrompt({ mesh, coordinatorCliType: cliType, userInstruction: extraSystemPrompt || undefined, missionSection: buildMissionSectionBestEffort(mesh.id) });
                        } catch (error: any) {
                            const message = error?.message || String(error);
                            LOG.error('MeshCoordinator', `Failed to build coordinator prompt: ${message}`);
                            return {
                                success: false,
                                code: 'mesh_coordinator_prompt_failed',
                                error: `Failed to build Repo Mesh coordinator prompt: ${message}`,
                                meshId, cliType, workspace,
                            };
                        }

                        // Run the provider's MCP registration command under a
                        // PTY. Some providers (agy, future bubbletea CLIs)
                        // refuse to run without /dev/tty, so pipe-only
                        // execFileSync silently no-ops the registration and
                        // the coordinator ends up without any mcp tools. With
                        // a real PTY the registration goes through and the
                        // exit code tells us whether it actually persisted.
                        let mcpRegistrationOk = false;
                        let mcpRegistrationFailure: {
                            command: string;
                            output: string;
                            exitCode: number | null;
                            signal: number | null;
                            timedOut: boolean;
                        } | null = null;
                        try {
                            const { buildMeshCoordinatorRegistrationPlan, execUnderPty } = await import('./mesh-coordinator.js');
                            const registrationPlan = buildMeshCoordinatorRegistrationPlan(
                                cliType,
                                coordinatorSetup.serverName,
                                coordinatorSetup.command,
                            );
                            for (const step of registrationPlan) {
                                const renderedCommand = [step.command, ...step.args].join(' ');
                                LOG.info('MeshCoordinator', `Running MCP ${step.label} (pty): ${renderedCommand}`);
                                const ptyResult = await execUnderPty(step.command, step.args, { cwd: workspace, timeoutMs: 20_000 });
                                if (ptyResult.exitCode === 0 && !ptyResult.timedOut) {
                                    if (step.required) mcpRegistrationOk = true;
                                    continue;
                                }
                                LOG.warn('MeshCoordinator', `MCP ${step.label} failed exit=${ptyResult.exitCode} signal=${ptyResult.signal} timedOut=${ptyResult.timedOut} — output:\n${ptyResult.output.slice(-2000)}`);
                                if (step.required) {
                                    mcpRegistrationFailure = {
                                        command: renderedCommand,
                                        output: ptyResult.output.slice(-2000),
                                        exitCode: ptyResult.exitCode,
                                        signal: ptyResult.signal,
                                        timedOut: ptyResult.timedOut,
                                    };
                                    break;
                                }
                            }
                        } catch (error: any) {
                            LOG.warn('MeshCoordinator', `MCP registration command failed: ${error?.message || error}`);
                            mcpRegistrationFailure = {
                                command: coordinatorSetup.command,
                                output: error?.message || String(error),
                                exitCode: null,
                                signal: null,
                                timedOut: false,
                            };
                        }

                        if (!mcpRegistrationOk) {
                            return {
                                success: false,
                                code: 'mesh_coordinator_mcp_registration_failed',
                                error: `Could not register ${coordinatorSetup.serverName}; coordinator session was not launched`,
                                meshId,
                                cliType,
                                workspace,
                                registration: mcpRegistrationFailure,
                            };
                        }

                        // Codex gives repo-local .mcp.json precedence over its
                        // global `codex mcp add` registration. Refresh an
                        // existing ADHDev entry so a stale workspace command
                        // cannot shadow the registration we just verified.
                        if (cliType === 'codex-cli') {
                            const repoMcpConfigPath = pathJoin(workspace, '.mcp.json');
                            if (fs.existsSync(repoMcpConfigPath)) {
                                try {
                                    const repoMcpConfig = parseMeshCoordinatorMcpConfig(
                                        fs.readFileSync(repoMcpConfigPath, 'utf-8'),
                                        'claude_mcp_json',
                                    );
                                    const existingServers = repoMcpConfig.mcpServers;
                                    if (
                                        existingServers
                                        && typeof existingServers === 'object'
                                        && !Array.isArray(existingServers)
                                        && existingServers[coordinatorSetup.serverName]
                                    ) {
                                        fs.writeFileSync(repoMcpConfigPath, serializeMeshCoordinatorMcpConfig({
                                            ...repoMcpConfig,
                                            mcpServers: {
                                                ...existingServers,
                                                [coordinatorSetup.serverName]: coordinatorSetup.mcpServer,
                                            },
                                        }, 'claude_mcp_json'), 'utf-8');
                                        LOG.info('MeshCoordinator', `Refreshed repo-local ${repoMcpConfigPath} entry for ${coordinatorSetup.serverName}`);
                                    }
                                } catch (error: any) {
                                    return {
                                        success: false,
                                        code: 'mesh_coordinator_config_write_failed',
                                        error: `Could not refresh repo-local MCP config: ${error?.message || error}`,
                                        meshId,
                                        cliType,
                                        workspace,
                                    };
                                }
                            }
                        }

                        // Inject system prompt declaratively from provider.v1.json.
                        const cliCmdArgs: string[] = [];
                        const cliCmdEnv: Record<string, string> = {};
                        let cliCmdContextFilePath: string | undefined;
                        if (cliCmdSystemPrompt) {
                            const { applyMeshCoordinatorSystemPromptInjection } = await import('./mesh-coordinator.js');
                            const effect = applyMeshCoordinatorSystemPromptInjection(
                                cliCmdSystemPrompt,
                                providerMeta?.meshCoordinator?.systemPromptInjection,
                                { cliArgs: cliCmdArgs, launchEnv: cliCmdEnv, workspace, cliType },
                            );
                            cliCmdContextFilePath = effect.contextFilePath;
                        }

                        const cliCmdLaunch: any = await this.deps.cliManager.handleCliCommand('launch_cli', {
                            cliType,
                            dir: workspace,
                            cliArgs: cliCmdArgs.length > 0 ? cliCmdArgs : undefined,
                            env: Object.keys(cliCmdEnv).length > 0 ? cliCmdEnv : undefined,
                            settings: { meshCoordinatorFor: meshId },
                        });

                        // R48 inject-then-remove. Spawn was just kicked off above; agy and
                        // gemini-cli read AGENTS.md / GEMINI.md exactly once at startup and
                        // cache it for the rest of the session, so we can safely strip
                        // the wrapper from disk shortly after launch. That keeps any
                        // worker session launched into the same workspace later from
                        // picking up our wrapper block.
                        if (cliCmdLaunch?.success && cliCmdContextFilePath) {
                            const stripPath = cliCmdContextFilePath;
                            setTimeout(() => {
                                void import('./mesh-coordinator.js').then(({ stripCoordinatorWrapperFile }) => {
                                    stripCoordinatorWrapperFile(stripPath);
                                    LOG.info('MeshCoordinator', `Stripped wrapper from ${stripPath} after launch settle (cli_command)`);
                                }).catch(() => { /* best-effort */ });
                            }, 5000);
                        }

                        if (!cliCmdLaunch?.success) {
                            return { success: false, error: cliCmdLaunch?.error || 'Failed to launch CLI session' };
                        }

                        LOG.info('MeshCoordinator', `Launched ${cliType} coordinator (cli_command) for mesh ${meshId}`);
                        const cliCmdSessionId = cliCmdLaunch.sessionId || cliCmdLaunch.id;
                        if (cliCmdSessionId) {
                            const cliCmdInjectionDecl = providerMeta?.meshCoordinator?.systemPromptInjection;
                            registerMeshCoordinator({
                                meshId,
                                sessionId: cliCmdSessionId,
                                workspace,
                                startedAt: Date.now(),
                                cliType,
                                systemPrompt: cliCmdSystemPrompt || undefined,
                                extraSystemPrompt: extraSystemPrompt || undefined,
                                injection: cliCmdInjectionDecl ? {
                                    mode: cliCmdInjectionDecl.mode,
                                    target: 'flag' in cliCmdInjectionDecl ? cliCmdInjectionDecl.flag
                                        : 'name' in cliCmdInjectionDecl ? cliCmdInjectionDecl.name
                                        : 'path' in cliCmdInjectionDecl ? cliCmdInjectionDecl.path
                                        : undefined,
                                } : undefined,
                            });
                        }
                        try {
                            const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                            appendLedgerEntry(meshId, {
                                kind: 'coordinator_started',
                                sessionId: cliCmdSessionId,
                                providerType: cliType,
                                payload: { workspace },
                            });
                        } catch { /* best-effort */ }

                        return {
                            success: true,
                            meshId,
                            cliType,
                            workspace,
                            sessionId: cliCmdSessionId,
                            mcpRegistered: mcpRegistrationOk,
                        };
                    }

                    const configFormat = coordinatorSetup.configFormat as MeshCoordinatorConfigFormat;
                    if (configFormat !== 'claude_mcp_json' && configFormat !== 'hermes_config_yaml') {
                        return {
                            success: false,
                            code: 'mesh_coordinator_unsupported',
                            error: `Unsupported auto-import MCP config format: ${String(coordinatorSetup.configFormat)}`,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    // Build the coordinator prompt before mutating workspace config or launching.
                    // Prompt generation failures are configuration/data-shape errors; fail closed so
                    // broken mesh state is visible instead of silently launching with weaker rules.
                    let systemPrompt = '';
                    try {
                        systemPrompt = buildCoordinatorSystemPrompt({ mesh, coordinatorCliType: cliType, userInstruction: extraSystemPrompt || undefined, missionSection: buildMissionSectionBestEffort(mesh.id) });
                    } catch (error: any) {
                        const message = error?.message || String(error);
                        LOG.error('MeshCoordinator', `Failed to build coordinator prompt: ${message}`);
                        return {
                            success: false,
                            code: 'mesh_coordinator_prompt_failed',
                            error: `Failed to build Repo Mesh coordinator prompt: ${message}`,
                            meshId,
                            cliType,
                            workspace,
                        };
                    }

                    // 1. Write provider-declared MCP config for CLIs that auto-import it.
                    const { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } = await import('fs');
                    const { dirname } = await import('path');
                    const mcpConfigPath = coordinatorSetup.configPath;
                    const hermesManualFallback = cliType === 'hermes-cli' && configFormat === 'hermes_config_yaml'
                        ? createHermesManualMeshCoordinatorSetup(meshId, workspace)
                        : null;
                    let hermesBaseConfig: { config: Record<string, any>; sourceHome: string; sourceConfigPath: string } | null = null;
                    if (hermesManualFallback) {
                        try {
                            hermesBaseConfig = loadHermesCoordinatorBaseConfig(mcpConfigPath);
                        } catch (error: any) {
                            const message = `Failed to parse Hermes base config for automatic coordinator setup: ${error?.message || error}`;
                            LOG.error('MeshCoordinator', message);
                            return { success: false, code: 'mesh_coordinator_config_parse_failed', error: message, meshId, cliType, workspace };
                        }
                    }
                    const returnManualFallback = (message: string) => ({
                        success: false,
                        code: 'mesh_coordinator_manual_mcp_setup_required',
                        error: message,
                        meshId,
                        cliType,
                        workspace,
                        meshCoordinatorSetup: hermesManualFallback,
                    });

                    // Merge ADHDev mesh server into existing config.
                    // Pass full mesh data as env var so the MCP server can bootstrap
                    // without depending on meshes.json or a running daemon.
                    const mcpServerEntry: Record<string, any> = {
                        command: coordinatorSetup.mcpServer.command,
                        args: coordinatorSetup.mcpServer.args,
                    };
                    if (args?.inlineMesh) {
                        const modeArgIndex = coordinatorSetup.mcpServer.args.findIndex((value: string) => value === '--mode');
                        const mcpTransport = modeArgIndex >= 0 ? coordinatorSetup.mcpServer.args[modeArgIndex + 1] : 'ipc';
                        mcpServerEntry.env = {
                            ADHDEV_INLINE_MESH: JSON.stringify(mesh),
                            ADHDEV_MCP_TRANSPORT: mcpTransport === 'local' ? 'local' : 'ipc',
                        };
                    }

                    try {
                        mkdirSync(dirname(mcpConfigPath), { recursive: true });
                    } catch (error: any) {
                        const message = `Could not prepare MCP config path for automatic setup: ${error?.message || error}`;
                        LOG.error('MeshCoordinator', message);
                        if (hermesManualFallback) return returnManualFallback(message);
                        return { success: false, code: 'mesh_coordinator_config_write_failed', error: message, meshId, cliType, workspace };
                    }

                    // Backup existing MCP config if present.
                    const hadExistingMcpConfig = existsSync(mcpConfigPath);
                    let existingMcpConfig: Record<string, any> = hermesBaseConfig?.config || {};
                    if (hermesBaseConfig) {
                        copyHermesCoordinatorCredentialFiles(hermesBaseConfig.sourceHome, dirname(mcpConfigPath));
                    }
                    if (hadExistingMcpConfig) {
                        try {
                            const parsedExistingMcpConfig = parseMeshCoordinatorMcpConfig(readFileSync(mcpConfigPath, 'utf-8'), configFormat);
                            const existingCoordinatorConfig = hermesManualFallback
                                ? stripHermesCoordinatorTempModelProviderOverrides(parsedExistingMcpConfig)
                                : parsedExistingMcpConfig;
                            existingMcpConfig = { ...existingMcpConfig, ...existingCoordinatorConfig };
                            copyFileSync(mcpConfigPath, mcpConfigPath + '.backup');
                        } catch (error: any) {
                            LOG.error('MeshCoordinator', `Failed to parse existing MCP config ${mcpConfigPath}: ${error?.message || error}`);
                            return {
                                success: false,
                                code: 'mesh_coordinator_config_parse_failed',
                                error: `Failed to parse existing MCP config at ${mcpConfigPath}`,
                            };
                        }
                    }

                    const mcpServersKey = getMcpServersKey(configFormat);
                    const existingServers = existingMcpConfig[mcpServersKey];
                    const mcpConfig = {
                        ...existingMcpConfig,
                        [mcpServersKey]: {
                            ...(existingServers && typeof existingServers === 'object' && !Array.isArray(existingServers) ? existingServers : {}),
                            [coordinatorSetup.serverName]: mcpServerEntry,
                        },
                    };
                    try {
                        writeFileSync(mcpConfigPath, serializeMeshCoordinatorMcpConfig(mcpConfig, configFormat), 'utf-8');
                    } catch (error: any) {
                        const message = `Could not write MCP config for automatic setup: ${error?.message || error}`;
                        LOG.error('MeshCoordinator', message);
                        if (hermesManualFallback) return returnManualFallback(message);
                        return { success: false, code: 'mesh_coordinator_config_write_failed', error: message, meshId, cliType, workspace };
                    }
                    LOG.info('MeshCoordinator', `Wrote ${mcpConfigPath} with ${coordinatorSetup.serverName} server`);

                    const cliArgs: string[] = [];
                    const launchEnv: Record<string, string> = {};
                    if (configFormat === 'hermes_config_yaml') {
                        launchEnv.HERMES_HOME = dirname(mcpConfigPath);
                        launchEnv.HERMES_IGNORE_USER_CONFIG = '';
                    }
                    let autoImportContextFilePath: string | undefined;
                    if (systemPrompt) {
                        const { applyMeshCoordinatorSystemPromptInjection } = await import('./mesh-coordinator.js');
                        const effect = applyMeshCoordinatorSystemPromptInjection(
                            systemPrompt,
                            providerMeta?.meshCoordinator?.systemPromptInjection,
                            { cliArgs, launchEnv, workspace, cliType },
                        );
                        autoImportContextFilePath = effect.contextFilePath;
                    }
                    if (cliType === 'claude-cli') {
                        cliArgs.push('--mcp-config', coordinatorSetup.configPath);
                    }

                    // 3. Launch CLI session via existing cliManager.
                    // Provider-specific prompt injection remains fail-closed: Claude gets
                    // explicit CLI args, while Hermes reads HERMES_EPHEMERAL_SYSTEM_PROMPT.
                    const launchResult: any = await this.deps.cliManager.handleCliCommand('launch_cli', {
                        cliType,
                        dir: workspace,
                        cliArgs: cliArgs.length > 0 ? cliArgs : undefined,
                        env: Object.keys(launchEnv).length > 0 ? launchEnv : undefined,
                        settings: {
                            meshCoordinatorFor: meshId
                        }
                    });

                    // R48 inject-then-remove. See the cli_command branch for context;
                    // same idea: strip the wrapper from disk ~5s after launch so the
                    // user's AGENTS.md / GEMINI.md is untouched the moment any
                    // worker session opens up in the same workspace.
                    if (launchResult?.success && autoImportContextFilePath) {
                        const stripPath = autoImportContextFilePath;
                        setTimeout(() => {
                            void import('./mesh-coordinator.js').then(({ stripCoordinatorWrapperFile }) => {
                                stripCoordinatorWrapperFile(stripPath);
                                LOG.info('MeshCoordinator', `Stripped wrapper from ${stripPath} after launch settle (auto_import)`);
                            }).catch(() => { /* best-effort */ });
                        }, 5000);
                    }

                    if (!launchResult?.success) {
                        return { success: false, error: launchResult?.error || 'Failed to launch CLI session' };
                    }

                    LOG.info('MeshCoordinator', `Launched ${cliType} coordinator for mesh ${meshId} in ${workspace}`);
                    const launchSessionId = launchResult.sessionId || launchResult.id;
                    if (launchSessionId) {
                        const autoImportInjectionDecl = providerMeta?.meshCoordinator?.systemPromptInjection;
                        registerMeshCoordinator({
                            meshId,
                            sessionId: launchSessionId,
                            workspace,
                            startedAt: Date.now(),
                            cliType,
                            systemPrompt: systemPrompt || undefined,
                            extraSystemPrompt: extraSystemPrompt || undefined,
                            mcpConfigPath,
                            injection: autoImportInjectionDecl ? {
                                mode: autoImportInjectionDecl.mode,
                                target: 'flag' in autoImportInjectionDecl ? autoImportInjectionDecl.flag
                                    : 'name' in autoImportInjectionDecl ? autoImportInjectionDecl.name
                                    : 'path' in autoImportInjectionDecl ? autoImportInjectionDecl.path
                                    : undefined,
                            } : undefined,
                        });
                    }

                    // Record coordinator launch in task ledger
                    try {
                        const { appendLedgerEntry } = await import('../mesh/mesh-ledger.js');
                        appendLedgerEntry(meshId, {
                            kind: 'coordinator_started',
                            sessionId: launchSessionId,
                            providerType: cliType,
                            payload: { workspace },
                        });
                    } catch { /* ledger append is best-effort */ }

                    return {
                        success: true,
                        meshId,
                        cliType,
                        workspace,
                        sessionId: launchSessionId,
                        mcpConfigWritten: true,
                    };
                } catch (e: any) {
                    LOG.error('MeshCoordinator', `Failed: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }

            case 'mesh_status': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    const meshHost = resolveMeshHostStatus(mesh);

                    const refreshRequested = args?.refresh === true || args?.forceRefresh === true;
                    // Compact (default) elides each mission's full goal text from the
                    // payload — coordinators polling node health don't need every
                    // mission's multi-hundred-char goal repeated. verbose=true (or the
                    // explicit compact=false) restores full goals. Verbose bypasses the
                    // shared (compact) aggregate cache so a verbose call never poisons
                    // the compact cache and vice versa.
                    const verboseMissions = args?.verbose === true || args?.compact === false;
                    // See (B3) below: scope the peek to this daemon when the
                    // caller doesn't tell us, otherwise scoped events look
                    // missing and we falsely return a stale cache.
                    const peekScope = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
                        ? args.coordinatorDaemonId.trim()
                        : (this.deps.statusInstanceId || undefined);
                    const pendingCoordinatorEventCount = getPendingMeshCoordinatorEvents(meshId, peekScope).length;
                    const hadAggregateCache = this.aggregateMeshStatusCache.has(meshId);
                    if (!refreshRequested && !verboseMissions && pendingCoordinatorEventCount === 0) {
                        const cachedStatus = this.getCachedAggregateMeshStatus(meshId, mesh, { requireDirectPeerTruth: args?.requireDirectPeerTruth === true });
                        if (cachedStatus) {
                            logRepoMeshStatusDebug('return_cached', {
                                meshId,
                                command: 'mesh_status',
                                refreshRequested,
                                summary: summarizeRepoMeshStatusDebug(cachedStatus),
                            });
                            return cachedStatus;
                        }
                    }
                    const refreshReason = refreshRequested
                        ? 'explicit_refresh'
                        : pendingCoordinatorEventCount > 0
                            ? 'pending_coordinator_events'
                        : hadAggregateCache
                            ? 'stale_pending_cache_refresh'
                            : 'cold_cache_miss';

                    const { getMeshQueueStats, getQueue } = await import('../mesh/mesh-work-queue.js');
                    const queue = getQueue(meshId);
                    const queueSummary = getMeshQueueStats(meshId);

                    const { readLedgerEntries, getLedgerSummary } = await import('../mesh/mesh-ledger.js');
                    const ledgerEntries = readLedgerEntries(meshId, { tail: 20 });
                    const asyncRefineLedgerEntries = readLedgerEntries(meshId, { tail: 100 });
                    const ledgerSummary = getLedgerSummary(meshId);
                    const sessionHostRecords = this.deps.sessionHostControl?.listSessions
                        ? await this.deps.sessionHostControl.listSessions().catch(() => [])
                        : [];
                    const liveMeshSessions = partitionSessionHostRecords(Array.isArray(sessionHostRecords) ? sessionHostRecords : []).liveRuntimes;

                    const localMachineId = loadConfig().machineId || '';
                    const requireDirectPeerTruth = args?.requireDirectPeerTruth === true;
                    // Shared probe gate for this mesh_status call: the bootstrap
                    // hydrate below and the per-node render loop further down both
                    // probe the same peers — route both through this cache so they
                    // dedup within the call and reuse recent results across calls.
                    const meshGitProbeCache = this.meshGitProbeCache;
                    const directTruth = requireDirectPeerTruth
                        ? await hydrateInlineMeshDirectTruth({
                            mesh,
                            meshSource: meshRecord.source,
                            dispatchMeshCommand: this.deps.dispatchMeshCommand,
                            getMeshPeerConnectionStatus: this.deps.getMeshPeerConnectionStatus,
                            statusInstanceId: this.deps.statusInstanceId,
                            localMachineId,
                            // Standing-state model: only an explicit refresh fans
                            // out a blocking peer git probe. Default loads return
                            // held truth so one slow peer can't block the graph.
                            probeRemotePeers: refreshRequested,
                            probeCache: meshGitProbeCache,
                        })
                        : {
                            directEvidenceCount: 0,
                            localConfirmedCount: 0,
                            peerAttemptedCount: 0,
                            peerConfirmedCount: 0,
                            standingEvidenceCount: 0,
                            unavailableNodeIds: [] as string[],
                            deadNodeIds: [] as string[],
                        };
                    // Default/cached loads may not attempt a remote peer probe yet; do not surface that as
                    // a direct mesh truth failure until an explicit probe attempt actually fails.
                    const passivePeerTruthNotAttempted = requireDirectPeerTruth
                        && !refreshRequested
                        && directTruth.directEvidenceCount > 0
                        && directTruth.peerAttemptedCount === 0;
                    const effectiveDirectTruth = passivePeerTruthNotAttempted
                        ? { ...directTruth, unavailableNodeIds: [] as string[] }
                        : directTruth;
                    const unavailableDirectTruthNodeIds = new Set(effectiveDirectTruth.unavailableNodeIds);
                    const unavailableNodesAreOnlyRemovedWorktrees = unavailableDirectTruthNodeIds.size > 0
                        && Array.isArray(mesh.nodes)
                        && mesh.nodes
                            .filter((node: any) => unavailableDirectTruthNodeIds.has(normalizeMeshNodeId(node) ?? ''))
                            .every((node: any) => node?.isLocalWorktree === true);
                    // Default (non-refresh) loads never hard-fail: held
                    // standing-state truth is returned and the graph renders
                    // immediately. The hard mesh_direct_peer_truth_unavailable
                    // failure is reserved for an explicit refresh that actually
                    // attempted a peer probe and could not confirm any evidence.
                    const directTruthSatisfied = !requireDirectPeerTruth
                        || !refreshRequested
                        || (effectiveDirectTruth.directEvidenceCount > 0 && (effectiveDirectTruth.unavailableNodeIds.length === 0 || unavailableNodesAreOnlyRemovedWorktrees));
                    if (requireDirectPeerTruth && refreshRequested && !directTruthSatisfied) {
                        const failureResult = {
                            success: false,
                            code: 'mesh_direct_peer_truth_unavailable',
                            error: 'Selected coordinator could not confirm direct mesh truth yet. Bootstrap inventory stays unavailable until direct mesh_status probes succeed.',
                            sourceOfTruth: {
                                membership: meshRecord.source === 'inline_cache'
                                    ? 'coordinator_inline_mesh_cache'
                                    : meshRecord.source === 'local_config'
                                        ? 'local_mesh_config'
                                        : 'inline_bootstrap_snapshot',
                                coordinatorOwnsLiveTruth: false,
                                currentStatus: 'direct_peer_truth_unavailable',
                                directPeerTruth: {
                                    required: true,
                                    satisfied: false,
                                    directEvidenceCount: directTruth.directEvidenceCount,
                                    localConfirmedCount: directTruth.localConfirmedCount,
                                    peerAttemptedCount: directTruth.peerAttemptedCount,
                                    peerConfirmedCount: directTruth.peerConfirmedCount,
                                    unavailableNodeIds: directTruth.unavailableNodeIds,
                                },
                            },
                        };
                        logRepoMeshStatusDebug('direct_truth_unavailable', {
                            meshId,
                            command: 'mesh_status',
                            refreshRequested,
                            meshSource: meshRecord.source,
                            directTruth,
                        });
                        return failureResult;
                    }
                    const directTruthUnavailableNodeIds = new Set(effectiveDirectTruth.unavailableNodeIds);
                    const coordinatorHostname = osHostname();
                    const selectedCoordinatorNodeId = readStringValue(
                        mesh.coordinator?.preferredNodeId,
                        normalizeMeshNodeId(mesh.nodes?.[0] as any),
                    );
                    const inlineCoordinatorNodeId = meshRecord?.inline && Array.isArray(mesh.nodes)
                        ? selectedCoordinatorNodeId
                        : undefined;
                    const refreshedAt = new Date().toISOString();
                    const nodeStatuses = [];
                    for (const [nodeIndex, node] of (mesh.nodes || []).entries()) {
                        const nodeId = normalizeMeshNodeId(node) ?? '';
                        const daemonId = readStringValue(node.daemonId);
                        const nodeMachineId = readMeshNodeMachineId(node as Record<string, unknown>);
                        const nodeHostname = readMeshNodeHostname(node as Record<string, unknown>);
                        const providerPriority = readProviderPriorityFromPolicy(node.policy);
                        const configuredCoordinatorNode = Boolean(
                            nodeId && selectedCoordinatorNodeId && nodeId === selectedCoordinatorNodeId,
                        );
                        const sparseConfiguredCoordinatorNode = configuredCoordinatorNode
                            && !daemonId
                            && !nodeMachineId
                            && !nodeHostname;
                        const isSelfNode = Boolean(
                            nodeId && inlineCoordinatorNodeId && nodeId === inlineCoordinatorNodeId,
                        ) || Boolean(
                            daemonId && (daemonId === localMachineId || daemonId === this.deps.statusInstanceId),
                        ) || Boolean(meshRecord?.inline && nodeIndex === 0)
                            || sparseConfiguredCoordinatorNode;
                        const machineIdentity = buildMeshNodeMachineIdentity(node as Record<string, unknown>, {
                            localMachineId,
                            localDaemonId: this.deps.statusInstanceId,
                            coordinatorHostname,
                            isSelfNode,
                        });
                        const status: Record<string, unknown> = {
                            nodeId,
                            machineLabel: buildMeshNodeDisplayLabel(node as Record<string, unknown>, nodeId, providerPriority),
                            labelSource: readStringValue(node.machineLabel, node.machine_label, node.machineNickname, node.machine_nickname, node.alias)
                                ? 'explicit_metadata'
                                : 'workspace_host_provider_context',
                            workspace: node.workspace,
                            repoRoot: node.repoRoot,
                            isLocalWorktree: node.isLocalWorktree,
                            worktreeBranch: node.worktreeBranch,
                            role: normalizeMeshDaemonRole(node.role) || (meshHost.hostNodeId && nodeId === meshHost.hostNodeId ? 'host' : undefined),
                            daemonId,
                            machineId: nodeMachineId || node.machineId,
                            machine: machineIdentity,
                            machineStatus: node.machineStatus,
                            health: 'unknown',
                            providers: node.providers || [],
                            providerPriority,
                            activeSessions: [],
                            activeSessionDetails: [],
                            launchReady: false,
                        };
                        if (isSelfNode) {
                            status.connection = {
                                perspective: 'selected_coordinator',
                                source: 'mesh_peer_status',
                                state: 'self',
                                transport: 'local',
                                reported: true,
                                reason: 'Selected coordinator daemon',
                                lastStateChangeAt: refreshedAt,
                            };
                        } else if (daemonId) {
                            const connection = this.deps.getMeshPeerConnectionStatus?.(daemonId);
                            status.connection = connection ?? {
                                perspective: 'selected_coordinator',
                                source: 'not_reported',
                                state: 'unknown',
                                transport: 'unknown',
                                reported: false,
                                reason: 'No live mesh peer telemetry reported by the selected coordinator yet.',
                            };
                        } else {
                            status.connection = {
                                perspective: 'selected_coordinator',
                                source: 'not_reported',
                                state: 'unknown',
                                transport: 'unknown',
                                reported: false,
                                reason: 'Node has no daemon id, so mesh transport cannot be reported from the selected coordinator.',
                            };
                        }
                        const matchedLiveSessionRecords = collectLiveMeshSessionRecords({
                            meshId,
                            node,
                            nodeId,
                            liveSessionRecords: liveMeshSessions,
                            allowCoordinatorSession: nodeId === selectedCoordinatorNodeId,
                        });
                        const workspace = readLiveMeshNodeWorkspace({
                            meshId,
                            nodeId,
                            liveSessionRecords: matchedLiveSessionRecords,
                            allowCoordinatorSession: nodeId === selectedCoordinatorNodeId,
                        }) || (typeof node.workspace === 'string' ? node.workspace : '');
                        status.workspace = workspace || node.workspace;
                        if (matchedLiveSessionRecords.length > 0) {
                            const sessionIds = matchedLiveSessionRecords
                                .map((record: any) => typeof record?.sessionId === 'string' ? record.sessionId : '')
                                .filter(Boolean);
                            const providerTypes = matchedLiveSessionRecords
                                .map((record: any) => readStringValue(record?.providerType))
                                .filter(Boolean) as string[];
                            status.activeSessions = sessionIds;
                            status.activeSessionDetails = matchedLiveSessionRecords.map(summarizeMeshSessionRecord);
                            if (providerTypes.length > 0) {
                                status.providers = Array.from(new Set([...(Array.isArray(status.providers) ? status.providers as string[] : []), ...providerTypes]));
                            }
                        }
                        if (workspace) {
                            if (!fs.existsSync(workspace)) {
                                // Workspace not local — prefer direct live inline truth, then attempt a P2P git probe.
                                const inlineTransitGit = buildInlineMeshTransitGitStatus(node);
                                let remoteProbeApplied = false;
                                if (inlineTransitGit) {
                                    status.git = inlineTransitGit;
                                    status.health = inlineTransitGit.isGitRepo
                                        ? deriveMeshNodeHealthFromGit(inlineTransitGit as unknown as Record<string, unknown>)
                                        : 'degraded';
                                    const connection = readObjectRecord(status.connection);
                                    const connectionState = readStringValue(connection.state);
                                    const connectionReported = readBooleanValue(connection.reported) ?? false;
                                    if (!connectionReported || connectionState === 'unknown') {
                                        status.connection = buildLivePeerGitConnection(connection, refreshedAt);
                                    }
                                    remoteProbeApplied = true;
                                } else if (refreshRequested && !isSelfNode && daemonId && this.deps.dispatchMeshCommand && !directTruthUnavailableNodeIds.has(nodeId)) {
                                    // Only an explicit refresh fans out a blocking
                                    // per-node git probe. On the default load a peer
                                    // with no held truth falls through to
                                    // gitProbePending below — the graph still renders.
                                    // Bounded retry (shared with the bootstrap hydrate
                                    // path), gated on the peer staying connected, so a
                                    // slow TURN-relayed peer is recovered rather than
                                    // dropped after a single timeout.
                                    const runNodeProbe = () => probeRemoteMeshGitStatusWithRetry({
                                        dispatchMeshCommand: this.deps.dispatchMeshCommand,
                                        daemonId,
                                        workspace,
                                        timeoutMs: MESH_DIRECT_PROBE_TIMEOUT_MS,
                                        retryTimeoutMs: MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS,
                                        getConnection: this.deps.getMeshPeerConnectionStatus,
                                        onConnection: connection => { status.connection = connection; },
                                    });
                                    // Same shared cache as the bootstrap hydrate path: within one
                                    // mesh_status call this dedups the bootstrap probe against this
                                    // per-node probe for the same peer, and across calls it reuses a
                                    // recent result so the dashboard auto-retry loop can't restart a
                                    // fresh refreshUpstream probe seconds apart.
                                    const remoteGit = await meshGitProbeCache.probe(daemonId, workspace, runNodeProbe);
                                    if (remoteGit) {
                                        status.git = remoteGit;
                                        status.health = remoteGit.isGitRepo
                                            ? deriveMeshNodeHealthFromGit(remoteGit as unknown as Record<string, unknown>)
                                            : 'degraded';
                                        const connection = readObjectRecord(status.connection);
                                        const connectionState = readStringValue(connection.state);
                                        const connectionReported = readBooleanValue(connection.reported) ?? false;
                                        if (!connectionReported || connectionState === 'unknown') {
                                            status.connection = buildLivePeerGitConnection(connection, refreshedAt);
                                        }
                                        const reporter = recordInlineMeshDirectGitTruth(node, remoteGit, 'selected_coordinator_mesh_p2p_git');
                                        persistNodeReporterPlatform(meshRecord.source, mesh, nodeId, reporter);
                                        remoteProbeApplied = true;
                                    }
                                }
                                if (!remoteProbeApplied) {
                                    const connectionState = readStringValue((status.connection as any)?.state);
                                    const pendingPeerGitProbe = !inlineTransitGit
                                        && !isSelfNode
                                        && !!daemonId
                                        && (
                                            readStringValue(status.machineStatus) === 'online'
                                            || readStringValue(status.health) === 'online'
                                            || connectionState === 'connecting'
                                            || connectionState === 'connected'
                                            || connectionState === 'unknown'
                                        );
                                    if (pendingPeerGitProbe) {
                                        status.gitProbePending = true;
                                        status.health = 'unknown';
                                    }
                                    if (applyCachedInlineMeshNodeStatus(
                                        status,
                                        node,
                                        pendingPeerGitProbe ? { skipGit: true, skipError: true, skipHealth: true } : undefined,
                                    )) {
                                        applyInlineMeshBranchConvergence(mesh, node, status);
                                        finalizeMeshNodeStatus({ status, node, daemonId, isSelfNode });
                                        nodeStatuses.push(status);
                                        continue;
                                    }
                                    if (meshRecord?.source === 'inline_cache' && !isSelfNode) {
                                        applyInlineMeshBranchConvergence(mesh, node, status);
                                        finalizeMeshNodeStatus({ status, node, daemonId, isSelfNode });
                                        nodeStatuses.push(status);
                                        continue;
                                    }
                                }
                            } else {
                                try {
                                    const gitStatus = await getGitRepoStatus(workspace, { timeoutMs: 10_000, refreshUpstream: true });
                                    status.git = gitStatus;
                                    const reporter = recordInlineMeshDirectGitTruth(node, gitStatus as unknown as Record<string, unknown>, 'selected_coordinator_local_git');
                                    persistNodeReporterPlatform(meshRecord.source, mesh, nodeId, reporter);
                                    if (gitStatus.isGitRepo) {
                                        status.health = deriveMeshNodeHealthFromGit(gitStatus as unknown as Record<string, unknown>);
                                    } else {
                                        status.health = 'degraded';
                                        if (gitStatus.error && !status.error) status.error = gitStatus.error;
                                    }
                                } catch {
                                    if (!applyCachedInlineMeshNodeStatus(status, node)) {
                                        status.health = 'degraded';
                                    }
                                }
                            }
                        } else {
                            applyCachedInlineMeshNodeStatus(status, node);
                        }
                        applyInlineMeshBranchConvergence(mesh, node, status);
                        finalizeMeshNodeStatus({ status, node, daemonId, isSelfNode });
                        nodeStatuses.push(status);
                    }

                    // (B3) Resolve the coordinator daemon scope for the peek.
                    // mesh_status is a read-only status query — it must not consume
                    // (drain) pending events as a side effect. Coordinators that see
                    // pendingCoordinatorEvents in the response are expected to call
                    // get_pending_mesh_events to explicitly drain them after processing.
                    const callerCoordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
                        ? args.coordinatorDaemonId.trim()
                        : (this.deps.statusInstanceId || undefined);
                    const pendingCoordinatorEvents = getPendingMeshCoordinatorEvents(meshId, callerCoordinatorDaemonId);
                    // R4: surface recent fail-loud routing drops so a coordinator/operator can see
                    // that a worker completion was lost (envelope present, mesh unresolved) instead
                    // of it vanishing silently. Diagnostic-only — never cached (see omit below).
                    const unroutableDeliveries = getRecentUnroutableDeliveries();
                    const previewFreshness = (() => {
                        const localRepoRoot = nodeStatuses
                            .map((node: any) => readStringValue(node?.git?.repoRoot, node?.repoRoot, node?.workspace))
                            .find((candidate: string | undefined) => !!candidate && fs.existsSync(candidate));
                        return localRepoRoot ? buildPreviewFreshness(localRepoRoot) : undefined;
                    })();
                    const asyncRefineJobs = buildMeshAsyncRefineJobs({
                        meshId,
                        ledgerEntries: asyncRefineLedgerEntries,
                        pendingEvents: [...pendingCoordinatorEvents],
                    });
                    const historicalSessions = buildHistoricalMeshSessions({
                        meshId,
                        nodes: mesh.nodes || [],
                        liveSessionRecords: liveMeshSessions,
                    });
                    const { getMeshStatusMissionSummaries } = await import('../mesh/mesh-missions.js');
                    // withStats opts in to per-mission operational rollups (durations /
                    // retries) for the dashboard mission detail. The rollup scans a
                    // bounded ledger tail per mission, but only over the bounded set
                    // returned here (live + capped history), so the cost stays linear
                    // in visible missions rather than the whole mesh history.
                    const missions = getMeshStatusMissionSummaries(meshId, { verbose: verboseMissions, withStats: true });
                    const statusResult = {
                        success: true,
                        meshId: mesh.id,
                        meshName: mesh.name,
                        repoIdentity: mesh.repoIdentity,
                        defaultBranch: mesh.defaultBranch,
                        refreshedAt,
                        meshHost,
                        sourceOfTruth: {
                            membership: meshRecord?.source === 'inline_cache'
                                ? 'coordinator_inline_mesh_cache'
                                : meshRecord?.source === 'local_config'
                                    ? 'local_mesh_config'
                                    : 'inline_bootstrap_snapshot',
                            coordinatorOwnsLiveTruth: directTruthSatisfied,
                            meshHost: {
                                owner: 'mesh_host_daemon',
                                localRole: meshHost.role,
                                hostDaemonId: meshHost.hostDaemonId,
                                hostNodeId: meshHost.hostNodeId,
                                hostAddress: meshHost.hostAddress,
                            },
                            ...(requireDirectPeerTruth ? {
                                currentStatus: directTruthSatisfied ? 'live_git_and_session_probes' : 'direct_peer_truth_unavailable',
                                directPeerTruth: {
                                    required: true,
                                    satisfied: directTruthSatisfied,
                                    directEvidenceCount: effectiveDirectTruth.directEvidenceCount,
                                    localConfirmedCount: effectiveDirectTruth.localConfirmedCount,
                                    peerAttemptedCount: effectiveDirectTruth.peerAttemptedCount,
                                    peerConfirmedCount: effectiveDirectTruth.peerConfirmedCount,
                                    unavailableNodeIds: effectiveDirectTruth.unavailableNodeIds,
                                    partialNodeFailures: effectiveDirectTruth.unavailableNodeIds,
                                },
                            } : {}),
                            historicalEvidenceOnly: ['recoveryHints', 'ledger.summary', 'queue.summary', 'historicalSessions'],
                        },
                        branchConvergenceSummary: summarizeInlineMeshBranchConvergence(nodeStatuses),
                        ...(previewFreshness ? { previewFreshness, deployFreshness: previewFreshness } : {}),
                        nodes: nodeStatuses,
                        queue: { tasks: queue, summary: queueSummary },
                        ledger: { entries: ledgerEntries, summary: ledgerSummary },
                        ...(missions.length > 0 ? { missions } : {}),
                        ...(asyncRefineJobs.length > 0 ? { asyncRefineJobs } : {}),
                        ...(historicalSessions ? { historicalSessions } : {}),
                        ...(pendingCoordinatorEvents.length > 0 ? { pendingCoordinatorEvents } : {}),
                        ...(unroutableDeliveries.length > 0 ? { unroutableDeliveries } : {}),
                        activeRefineJobs: Array.from(this.runningRefineJobs.values())
                            .filter(job => job.meshId === meshId)
                            .map(job => ({
                                jobId: job.jobId,
                                nodeId: job.targetNodeId,
                                workspace: job.workspace,
                                startedAt: job.startedAt,
                                status: job.status,
                                targetCoordinatorDaemonId: job.targetCoordinatorDaemonId,
                            })),
                    };
                    const { pendingCoordinatorEvents: _pendingCoordinatorEvents, unroutableDeliveries: _unroutableDeliveries, ...cacheableStatusResult } = statusResult as any;
                    // Verbose carries full mission goals; never store it in the shared
                    // (compact) aggregate cache or a later compact poll would return the
                    // heavy goals from cache. Return it without caching.
                    const rememberedStatus = verboseMissions
                        ? cacheableStatusResult
                        : this.rememberAggregateMeshStatus(meshId, cacheableStatusResult, refreshReason);
                    const returnedStatus = {
                        ...rememberedStatus,
                        ...(pendingCoordinatorEvents.length > 0 ? { pendingCoordinatorEvents } : {}),
                        ...(unroutableDeliveries.length > 0 ? { unroutableDeliveries } : {}),
                    };
                    logRepoMeshStatusDebug('return_live', {
                        meshId,
                        command: 'mesh_status',
                        refreshRequested,
                        refreshReason,
                        meshSource: meshRecord.source,
                        directTruth,
                        summary: summarizeRepoMeshStatusDebug(returnedStatus),
                    });
                    return returnedStatus;
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            case 'get_mesh_review_inbox': {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { deriveMeshReviewInboxItems } = await import('../mesh/mesh-review-inbox.js');
                    const { readLedgerEntries } = await import('../mesh/mesh-ledger.js');
                    const { getGitDiffSummary } = await import('../git/git-diff.js');
                    const { existsSync } = await import('node:fs');

                    const meshRecord = await this.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };

                    // Ensure we have a fresh aggregate status so nodeStatuses carry
                    // computed fields (connection.state, branchConvergence, isLocalWorktree)
                    // that the raw mesh.nodes config objects don't have.
                    // When the caller provides an inlineMesh, prefer its nodes directly
                    // (they already carry the computed fields from the coordinator).
                    const inlineNodes = args?.inlineMesh && Array.isArray((args.inlineMesh as any)?.nodes)
                        ? (args.inlineMesh as any).nodes as Record<string, unknown>[]
                        : null;
                    let cachedStatus = !inlineNodes ? this.getCachedAggregateMeshStatus(meshId, mesh, {}) : null;
                    if (!cachedStatus && !inlineNodes) {
                        const freshStatus = await this.execute('mesh_status', {
                            meshId,
                            inlineMesh: args?.inlineMesh,
                            refresh: true,
                        }, 'get_mesh_review_inbox');
                        cachedStatus = (freshStatus?.success !== false) ? freshStatus : null;
                    }
                    const nodeStatuses: Record<string, unknown>[] = inlineNodes
                        ? inlineNodes
                        : Array.isArray(cachedStatus?.nodes)
                            ? cachedStatus.nodes as Record<string, unknown>[]
                            : Array.isArray(mesh.nodes)
                                ? mesh.nodes as Record<string, unknown>[]
                                : [];

                    const ledgerEntries = readLedgerEntries(meshId, { tail: 300 });
                    const derivation = deriveMeshReviewInboxItems({ nodes: nodeStatuses, ledgerEntries });

                    for (const item of derivation.items) {
                        const workspace = item.workspace;
                        if (!workspace || !existsSync(workspace)) continue;
                        const baseRef = item.defaultBranch
                            ? `origin/${item.defaultBranch}`
                            : 'origin/main';
                        try {
                            const diffResult = await getGitDiffSummary(workspace, { baseRef, maxFiles: 100 });
                            if (diffResult.isGitRepo) {
                                item.diffSummary = {
                                    baseRef,
                                    files: diffResult.files.map(f => ({
                                        path: f.path,
                                        status: f.status,
                                        insertions: f.insertions,
                                        deletions: f.deletions,
                                        binary: f.binary,
                                        oldPath: f.oldPath,
                                    })),
                                    totalFiles: diffResult.files.length,
                                    totalInsertions: diffResult.totalInsertions,
                                    totalDeletions: diffResult.totalDeletions,
                                    truncated: diffResult.truncated,
                                    ...(diffResult.error ? { error: diffResult.error } : {}),
                                };
                            }
                        } catch {
                            item.diffSummary = null;
                        }
                    }

                    return {
                        success: true,
                        meshId,
                        inbox: derivation.items,
                        remoteNodesExcluded: derivation.remoteNodesExcluded,
                        excludedRemoteNodeIds: derivation.excludedRemoteNodeIds,
                    };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }

            default:
                break;
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
