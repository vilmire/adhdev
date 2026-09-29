/**
 * Mesh node identity helpers — daemon-id / machine-id / hostname normalization,
 * display labels, the machine-identity block, provider-priority resolution and the
 * repo-mesh status debug summary.
 *
 * This module is also the barrel for the node-state helpers that live beside it
 * (re-exported below, so `from './mesh-node-identity.js'` and router.ts's
 * `export *` keep resolving every symbol):
 *   - mesh-inline-mesh-cache.ts  — inline-mesh git truth, reported facts, identity folding
 *   - mesh-node-freshness.ts     — health, launch freshness, data-freshness, final status
 *   - mesh-node-git-probe.ts     — the direct git-probe cache and remote probe / hydration
 *   - mesh-node-sessions.ts      — hosted / live / historical session views
 *   - mesh-node-record-readers.ts — tolerant scalar readers (leaf)
 */

import type { ProviderLoader } from '../providers/provider-loader.js';
import { detectCLI } from '../detection/cli-detector.js';
import { summarizeGitShape as sharedSummarizeGitShape, normalizeMeshNodeId, daemonIdsEquivalent, deriveProviderPriorityFromSlots } from '@adhdev/mesh-shared';
import { LOG } from '../logging/logger.js';
import { awaitWithWarmupDeadline } from '../mesh/mesh-warmup-deadline.js';
import { workingDirBasename } from '../providers/working-dir.js';
import { readObjectRecord, readStringValue, readBooleanValue } from './mesh-node-record-readers.js';
export { readObjectRecord, readStringValue, readNumberValue, readBooleanValue } from './mesh-node-record-readers.js';
export { buildInlineMeshTransitGitStatus, shouldRefreshStalePendingAggregate, buildLivePeerGitConnection, recordInlineMeshDirectGitTruth, recordReportedNodeFacts, buildFreshLocalNodeFacts, persistNodeReporterPlatform, inlineMeshCarriesTransientNodeTruth, readInlineMeshNodeId, isDeadLocalWorktreeNode, foldMeshNodeIdentityToCanonical, normalizeInlineMeshNodeIdentity, sanitizeInlineMesh, reconcileInlineMeshCache } from './mesh-inline-mesh-cache.js';
export { countGitWorktreeChanges, isInlineMeshAutoFastForwardEligible, deriveMeshNodeHealthFromGit, resolveEffectiveMeshNodeHealth, isMeshNodeHealthLaunchable, isMeshNodeFreshEnoughToLaunch, summarizeInlineMeshBranchConvergence, MESH_NODE_LIVE_TRUTH_MARKER, buildMeshNodeDataFreshness, buildMeshNodeProbeFreshness, finalizeMeshNodeStatus, applyCachedInlineMeshNodeStatus } from './mesh-node-freshness.js';
export { readCachedInlineMeshActiveSessions, collectMeshNodeHostedSessionIds, resolveMeshNodeAttribution, readCachedInlineMeshActiveSessionDetails, summarizeMeshSessionRecord, readLiveMeshNodeWorkspace, collectLiveMeshSessionRecords, buildHistoricalMeshSessions } from './mesh-node-sessions.js';
export { MESH_DIRECT_PROBE_TIMEOUT_MS, MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS, MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS, MESH_DIRECT_PROBE_REUSE_MS, MeshGitProbeCache, probeRemoteMeshGitStatusWithRetry, hydrateInlineMeshDirectTruth } from './mesh-node-git-probe.js';

export function readProviderPriorityFromPolicy(policy: unknown): string[] {
    const record = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy as Record<string, unknown>
        : {};
    // Slots are the source of truth whenever present. providerPriority remains a
    // legacy fallback for slotless nodes, but must never override a newer slot
    // order when the persisted compatibility field has drifted.
    const derived = deriveProviderPriorityFromSlots(record.slots);
    if (derived.length) return derived;
    const raw = record.providerPriority;
    if (Array.isArray(raw)) {
        const seen = new Set<string>();
        const explicit = raw
            .map(type => typeof type === 'string' ? type.trim() : '')
            .filter(Boolean)
            .filter(type => {
                if (seen.has(type)) return false;
                seen.add(type);
                return true;
            });
        if (explicit.length) return explicit;
    }
    return [];
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

/**
 * MACHINE-axis label for a mesh node (owner axiom 2026-08-24: machine ⊃
 * nodes). Every checkout hosted by one machine — base + all worktrees — must
 * resolve to the SAME label, so the chain reads ONLY machine evidence:
 * explicit label/nickname/alias → machine object names → hostname (via
 * readMeshNodeDisplayMachineName) → a compacted daemon/machine id. The
 * pre-2026-08-24 chain led with the WORKSPACE BASENAME and appended the top
 * provider, which titled every worktree like a separate machine
 * ("fix-permission-mode-duplicate-args · claude-cli") and forced a
 * host_machine relabel post-pass in mesh-status.ts; checkout identity now
 * travels separately (worktreeBranch / buildMeshNodeCheckoutLabel).
 */
export function buildMeshNodeMachineLabel(node: Record<string, unknown>, nodeId: string): string {
    const machineName = readMeshNodeDisplayMachineName(node);
    if (machineName) {
        // Cosmetic only when the resolved value IS the raw hostname — an
        // explicit nickname is never rewritten.
        return machineName === readMeshNodeHostname(node)
            ? machineName.replace(/\.local$/i, '')
            : machineName;
    }
    const id = readStringValue(node.daemonId, node.daemon_id, node.machineId, node.machine_id);
    if (id) return id.length > 16 ? `${id.slice(0, 12)}…` : id;
    return nodeId || 'unidentified mesh node';
}

/**
 * NODE/CHECKOUT-axis label: which checkout on the machine this node is. The
 * counterpart of buildMeshNodeMachineLabel — worktrees are titled by their
 * branch (`⎇ branch`, the convention every web surface renders), the base
 * checkout by its workspace basename.
 */
export function buildMeshNodeCheckoutLabel(node: Record<string, unknown>, nodeId: string): string {
    const branch = readStringValue(node.worktreeBranch, node.worktree_branch);
    if (branch) return `⎇ ${branch}`;
    const workspace = readStringValue(node.workspace, node.repoRoot, node.repo_root);
    // OS-agnostic basename: a workspace reported by a Windows node
    // (`D:\gh\adhdev-cloud`) must still collapse to its trailing segment even
    // when this coordinator's own `path.basename` is POSIX-only.
    const basename = workspace ? workingDirBasename(workspace) : undefined;
    return basename || (nodeId ? nodeId.slice(0, 8) : 'node');
}

/**
 * @deprecated 2026-08-24 — the old name built a mixed workspace·host·provider
 * string (the two-axes-in-one-field defect). Renamed to
 * buildMeshNodeMachineLabel when the axes were separated; kept as an alias for
 * out-of-tree callers. The provider-priority argument is ignored — provider is
 * not machine identity.
 */
export function buildMeshNodeDisplayLabel(node: Record<string, unknown>, nodeId: string, _providerPriority?: string[]): string {
    return buildMeshNodeMachineLabel(node, nodeId);
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

export function readMeshNodeDisplayMachineName(node: Record<string, unknown>): string | undefined {
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
    const machineIdMatches = Boolean(opts.localMachineId && machineId && daemonIdsEquivalent(opts.localMachineId, machineId));
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

export { applyInlineMeshBranchConvergence } from './mesh-branch-convergence.js';

// The warmup-aware deadline now lives in the dependency-free mesh leaf so BOTH the
// dashboard git_status probe (here) and the general task-dispatch path
// (mesh/mesh-events-coordinator.ts) can share it without an import cycle. Re-exported
// for the existing `from '../commands/router.js'` callers/tests.
export { awaitWithWarmupDeadline };

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
