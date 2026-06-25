/**
 * RF-ROUTER HIGH family — mesh aggregate status + review inbox.
 *
 * mesh_status: the coordinator's aggregate mesh render — resolves membership,
 * gates the memory cache against pending coordinator events / explicit refresh,
 * optionally fans out a direct peer-truth probe, then renders per-node health
 * (live session records, local/remote/inline git truth, branch convergence) and
 * folds in queue/ledger/missions/async-refine/historical-session/active-refine
 * state. get_mesh_review_inbox: derives review-inbox items from node statuses +
 * ledger and annotates each with a worktree git-diff summary. Extracted verbatim
 * from executeDaemonCommand — only `this.*` router members became `ctx.*` and the
 * relative dynamic-import paths were re-based one directory deeper.
 */
import * as fs from 'fs';
import { hostname as osHostname } from 'os';
import { loadConfig } from '../../config/config.js';
import { getGitRepoStatus } from '../../git/git-status.js';
import {
    normalizeMeshNodeId,
    daemonIdsEquivalent,
} from '@adhdev/mesh-shared';
import { getPendingMeshCoordinatorEvents } from '../../mesh/mesh-events.js';
import { getRecentUnroutableDeliveries } from '../../mesh/mesh-routing.js';
import { normalizeMeshDaemonRole, resolveMeshHostStatus } from '../../mesh/mesh-host-ownership.js';
import { buildPreviewFreshness } from '../../mesh/preview-freshness.js';
import { buildMeshAsyncRefineJobs } from '../../mesh/mesh-refine-status.js';
import { partitionSessionHostRecords } from '../../session-host/runtime-surface.js';
import {
    readStringValue,
    readObjectRecord,
    readBooleanValue,
    readMeshNodeMachineId,
    readMeshNodeHostname,
    readProviderPriorityFromPolicy,
    buildMeshNodeMachineIdentity,
    buildMeshNodeDisplayLabel,
    collectLiveMeshSessionRecords,
    readLiveMeshNodeWorkspace,
    summarizeMeshSessionRecord,
    buildInlineMeshTransitGitStatus,
    deriveMeshNodeHealthFromGit,
    buildLivePeerGitConnection,
    probeRemoteMeshGitStatusWithRetry,
    recordInlineMeshDirectGitTruth,
    persistNodeReporterPlatform,
    applyCachedInlineMeshNodeStatus,
    applyInlineMeshBranchConvergence,
    finalizeMeshNodeStatus,
    summarizeInlineMeshBranchConvergence,
    buildHistoricalMeshSessions,
    hydrateInlineMeshDirectTruth,
    MESH_NODE_LIVE_TRUTH_MARKER,
    logRepoMeshStatusDebug,
    summarizeRepoMeshStatusDebug,
    MESH_DIRECT_PROBE_TIMEOUT_MS,
    MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS,
} from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';

export const meshStatusHandlers: Record<string, HighFamilyHandler> = {
    mesh_status: async (ctx: HighFamilyContext, args: any) => {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
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
                        : (ctx.deps.statusInstanceId || undefined);
                    const pendingCoordinatorEventCount = getPendingMeshCoordinatorEvents(meshId, peekScope).length;
                    const hadAggregateCache = ctx.aggregateMeshStatusCache.has(meshId);
                    if (!refreshRequested && !verboseMissions && pendingCoordinatorEventCount === 0) {
                        const cachedStatus = ctx.getCachedAggregateMeshStatus(meshId, mesh, { requireDirectPeerTruth: args?.requireDirectPeerTruth === true });
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

                    const { getMeshQueueStats, getQueue } = await import('../../mesh/mesh-work-queue.js');
                    const queue = getQueue(meshId);
                    const queueSummary = getMeshQueueStats(meshId);

                    // Scheduling-runtime projection — the load-balancer's live view (tie-break
                    // strategy, global parallel caps + consumption, per-node load/priority/provider
                    // caps). Built from the SAME helper + args the MCP `mesh_status` tool uses
                    // (mesh-tools-status.ts: buildMeshSchedulingRuntime(mesh, getQueue(mesh.id)))
                    // so the dashboard surface and the coordinator MCP surface render an identical
                    // runtime. Without this the dashboard Status/Runtime tab showed the
                    // "not reported by this daemon (older build)" fallback (RepoMeshStatus.scheduling
                    // was never populated by this daemon-command producer). Computed once so each
                    // node entry can attach its slice and statusResult can carry the mesh rollup.
                    const { buildMeshSchedulingRuntime } = await import('../../mesh/mesh-scheduling-runtime.js');
                    const schedulingRuntime = buildMeshSchedulingRuntime(mesh, queue);
                    const schedulingByNode = new Map(schedulingRuntime.nodes.map(n => [n.nodeId, n]));

                    const { readLedgerEntries, getLedgerSummary } = await import('../../mesh/mesh-ledger.js');
                    const ledgerEntries = readLedgerEntries(meshId, { tail: 20 });
                    const asyncRefineLedgerEntries = readLedgerEntries(meshId, { tail: 100 });
                    const ledgerSummary = getLedgerSummary(meshId);
                    const sessionHostRecords = ctx.deps.sessionHostControl?.listSessions
                        ? await ctx.deps.sessionHostControl.listSessions().catch(() => [])
                        : [];
                    const liveMeshSessions = partitionSessionHostRecords(Array.isArray(sessionHostRecords) ? sessionHostRecords : []).liveRuntimes;

                    const localMachineId = loadConfig().machineId || '';
                    const requireDirectPeerTruth = args?.requireDirectPeerTruth === true;
                    // Shared probe gate for this mesh_status call: the bootstrap
                    // hydrate below and the per-node render loop further down both
                    // probe the same peers — route both through this cache so they
                    // dedup within the call and reuse recent results across calls.
                    const meshGitProbeCache = ctx.meshGitProbeCache;
                    const directTruth = requireDirectPeerTruth
                        ? await hydrateInlineMeshDirectTruth({
                            mesh,
                            meshSource: meshRecord.source,
                            dispatchMeshCommand: ctx.deps.dispatchMeshCommand,
                            getMeshPeerConnectionStatus: ctx.deps.getMeshPeerConnectionStatus,
                            statusInstanceId: ctx.deps.statusInstanceId,
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
                            daemonId && (daemonIdsEquivalent(daemonId, localMachineId) || daemonIdsEquivalent(daemonId, ctx.deps.statusInstanceId)),
                        ) || Boolean(meshRecord?.inline && nodeIndex === 0)
                            || sparseConfiguredCoordinatorNode;
                        const machineIdentity = buildMeshNodeMachineIdentity(node as Record<string, unknown>, {
                            localMachineId,
                            localDaemonId: ctx.deps.statusInstanceId,
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
                        // Per-node scheduling slice (load / priority / provider caps / claim-block
                        // reasons) read by the dashboard's MeshNodeSchedulingBadges. Full shape —
                        // unlike the MCP compact path this is a dashboard surface, so it keeps the
                        // whole RepoMeshNodeSchedulingStatus. Redundant nodeId dropped (the entry
                        // already carries it).
                        const nodeScheduling = schedulingByNode.get(nodeId);
                        if (nodeScheduling) {
                            const { nodeId: _omitNodeId, ...nodeSchedulingRest } = nodeScheduling;
                            status.scheduling = nodeSchedulingRest;
                        }
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
                            const connection = ctx.deps.getMeshPeerConnectionStatus?.(daemonId);
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
                                } else if (refreshRequested && !isSelfNode && daemonId && ctx.deps.dispatchMeshCommand && !directTruthUnavailableNodeIds.has(nodeId)) {
                                    // Only an explicit refresh fans out a blocking
                                    // per-node git probe. On the default load a peer
                                    // with no held truth falls through to
                                    // gitProbePending below — the graph still renders.
                                    // Bounded retry (shared with the bootstrap hydrate
                                    // path), gated on the peer staying connected, so a
                                    // slow TURN-relayed peer is recovered rather than
                                    // dropped after a single timeout.
                                    const runNodeProbe = () => probeRemoteMeshGitStatusWithRetry({
                                        dispatchMeshCommand: ctx.deps.dispatchMeshCommand,
                                        daemonId,
                                        workspace,
                                        timeoutMs: MESH_DIRECT_PROBE_TIMEOUT_MS,
                                        retryTimeoutMs: MESH_DIRECT_PROBE_RETRY_TIMEOUT_MS,
                                        getConnection: ctx.deps.getMeshPeerConnectionStatus,
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
                                        status[MESH_NODE_LIVE_TRUTH_MARKER] = true;
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
                                        finalizeMeshNodeStatus({ status, node, daemonId, isSelfNode, directTruthUnavailable: directTruthUnavailableNodeIds.has(nodeId) });
                                        nodeStatuses.push(status);
                                        continue;
                                    }
                                    if (meshRecord?.source === 'inline_cache' && !isSelfNode) {
                                        applyInlineMeshBranchConvergence(mesh, node, status);
                                        finalizeMeshNodeStatus({ status, node, daemonId, isSelfNode, directTruthUnavailable: directTruthUnavailableNodeIds.has(nodeId) });
                                        nodeStatuses.push(status);
                                        continue;
                                    }
                                }
                            } else {
                                try {
                                    const gitStatus = await getGitRepoStatus(workspace, { timeoutMs: 10_000, refreshUpstream: true });
                                    status.git = gitStatus;
                                    status[MESH_NODE_LIVE_TRUTH_MARKER] = true;
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
                        finalizeMeshNodeStatus({ status, node, daemonId, isSelfNode, directTruthUnavailable: directTruthUnavailableNodeIds.has(nodeId) });
                        nodeStatuses.push(status);
                    }

                    // (B3) Resolve the coordinator daemon scope for the peek.
                    // mesh_status is a read-only status query — it must not consume
                    // (drain) pending events as a side effect. Coordinators that see
                    // pendingCoordinatorEvents in the response are expected to call
                    // get_pending_mesh_events to explicitly drain them after processing.
                    const callerCoordinatorDaemonId = typeof args?.coordinatorDaemonId === 'string' && args.coordinatorDaemonId.trim()
                        ? args.coordinatorDaemonId.trim()
                        : (ctx.deps.statusInstanceId || undefined);
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
                    const { getMeshStatusMissionSummaries } = await import('../../mesh/mesh-missions.js');
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
                        // Mesh-level scheduling rollup (strategy + global cap consumption). Mirrors
                        // the MCP `mesh_status` tool's `scheduling` block field-for-field so both
                        // surfaces read the same runtime; per-node detail lives on each
                        // nodes[].scheduling above.
                        scheduling: {
                            strategy: schedulingRuntime.strategy,
                            maxParallelTasks: schedulingRuntime.maxParallelTasks,
                            maxReadonlyParallelTasks: schedulingRuntime.maxReadonlyParallelTasks,
                            activeWriteAssigned: schedulingRuntime.activeWriteAssigned,
                            activeReadonlyAssigned: schedulingRuntime.activeReadonlyAssigned,
                            globalWriteCapReached: schedulingRuntime.globalWriteCapReached,
                            globalReadonlyCapReached: schedulingRuntime.globalReadonlyCapReached,
                        },
                        queue: { tasks: queue, summary: queueSummary },
                        ledger: { entries: ledgerEntries, summary: ledgerSummary },
                        ...(missions.length > 0 ? { missions } : {}),
                        ...(asyncRefineJobs.length > 0 ? { asyncRefineJobs } : {}),
                        ...(historicalSessions ? { historicalSessions } : {}),
                        ...(pendingCoordinatorEvents.length > 0 ? { pendingCoordinatorEvents } : {}),
                        ...(unroutableDeliveries.length > 0 ? { unroutableDeliveries } : {}),
                        activeRefineJobs: Array.from(ctx.runningRefineJobs.values())
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
                        : ctx.rememberAggregateMeshStatus(meshId, cacheableStatusResult, refreshReason);
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
    },

    get_mesh_review_inbox: async (ctx: HighFamilyContext, args: any) => {
                const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
                if (!meshId) return { success: false, error: 'meshId required' };
                try {
                    const { deriveMeshReviewInboxItems } = await import('../../mesh/mesh-review-inbox.js');
                    const { readLedgerEntries } = await import('../../mesh/mesh-ledger.js');
                    const { getGitDiffSummary } = await import('../../git/git-diff.js');
                    const { existsSync } = await import('node:fs');

                    const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
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
                    let cachedStatus = !inlineNodes ? ctx.getCachedAggregateMeshStatus(meshId, mesh, {}) : null;
                    if (!cachedStatus && !inlineNodes) {
                        const freshStatus = await ctx.execute('mesh_status', {
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
    },
};
