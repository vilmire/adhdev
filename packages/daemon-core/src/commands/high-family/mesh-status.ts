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
    normalizeNodeCapabilitySlots,
} from '@adhdev/mesh-shared';
import {
    getPendingMeshCoordinatorEvents,
    getMeshV2DrainCounters,
    getMeshV2BackstopCounters,
    isMeshProtocolV2EnforceEnabled,
    getPendingRetentionCounters,
} from '../../mesh/mesh-events.js';
import type { MeshProtocolV2Counters, MeshPendingRetentionCounters } from '../../repo-mesh-types.js';
import { getTurnPresentationMetrics } from '../../mesh/mesh-turn-presentation.js';
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
    buildMeshNodeCheckoutLabel,
    buildMeshNodeMachineLabel,
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
                // Latency telemetry: stamp handler entry so every return path can
                // report durationMs. Makes the detail-open cost measurable in the
                // repo-mesh-status debug log (cache hit ≈ single-digit ms; a full
                // live rebuild is the ~seconds path this change is reducing).
                const startedAtMs = Date.now();
                try {
                    const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
                    const mesh = meshRecord?.mesh;
                    if (!mesh) return { success: false, error: 'Mesh not found' };
                    // Pass the evaluating daemon's id so a host mesh whose
                    // hostDaemonId was never persisted (HOST-MISSEED-FIRSTSETUP) gets
                    // pinned to THIS daemon — the dashboard then renders M4 as host
                    // instead of falling back to 'no host yet'.
                    const meshHost = resolveMeshHostStatus(mesh, { localDaemonId: ctx.deps.statusInstanceId });

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
                                durationMs: Date.now() - startedAtMs,
                                summary: summarizeRepoMeshStatusDebug(cachedStatus),
                            });
                            return cachedStatus;
                        }
                        // SWR stale-serve: the strict serve above missed only because
                        // some node still has a pending peer-git probe (the
                        // shouldRefreshStalePendingAggregate gate). Rather than block
                        // this interactive detail-open on a full synchronous live
                        // rebuild, serve the held (slightly stale) snapshot instantly
                        // and kick ONE coalesced background freshen whose result
                        // repopulates the cache for the next poll/subscription push.
                        // allowStalePending relaxes ONLY the pending-git freshness gate;
                        // getCachedAggregateMeshStatus still enforces the queueRevision
                        // guard, so a genuine queue/identity mutation is never stale-served.
                        const staleStatus = ctx.getCachedAggregateMeshStatus(meshId, mesh, {
                            requireDirectPeerTruth: args?.requireDirectPeerTruth === true,
                            allowStalePending: true,
                        });
                        if (staleStatus) {
                            if (!ctx.swrRefreshInFlight.has(meshId)) {
                                ctx.swrRefreshInFlight.add(meshId);
                                // Fire-and-forget: a full refresh (peer fan-out) that
                                // rewrites the aggregate cache. Errors are swallowed —
                                // the stale snapshot was already returned to the caller.
                                void Promise.resolve()
                                    .then(() => ctx.execute('mesh_status', {
                                        meshId,
                                        inlineMesh: args?.inlineMesh,
                                        coordinatorDaemonId: args?.coordinatorDaemonId,
                                        requireDirectPeerTruth: args?.requireDirectPeerTruth === true,
                                        refresh: true,
                                    }, 'mesh_status_swr_freshen'))
                                    .catch(() => {})
                                    .finally(() => { ctx.swrRefreshInFlight.delete(meshId); });
                            }
                            logRepoMeshStatusDebug('return_stale_swr', {
                                meshId,
                                command: 'mesh_status',
                                refreshRequested,
                                durationMs: Date.now() - startedAtMs,
                                summary: summarizeRepoMeshStatusDebug(staleStatus),
                            });
                            return staleStatus;
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

                    const { readLedgerEntries, readLedgerEntriesByKind, getLedgerSummary } = await import('../../mesh/mesh-ledger.js');
                    const ledgerEntries = readLedgerEntries(meshId, { tail: 20 });
                    // LEDGER-KIND-TAIL-BLINDSPOT: kind-filtered, no bare tail — feeds
                    // buildMeshAsyncRefineJobs below, an existence/status check for in-flight
                    // Refinery jobs. A bare tail window can be crowded out by unrelated mesh
                    // traffic while a refine job (minutes-long) is still running.
                    const asyncRefineLedgerEntries = readLedgerEntriesByKind(meshId, ['task_dispatched', 'task_completed', 'task_failed']);
                    const ledgerSummary = getLedgerSummary(meshId);
                    const sessionHostRecords = ctx.deps.sessionHostControl?.listSessions
                        ? await ctx.deps.sessionHostControl.listSessions().catch(() => [])
                        : [];
                    const liveMeshSessions = partitionSessionHostRecords(Array.isArray(sessionHostRecords) ? sessionHostRecords : []).liveRuntimes;

                    const localMachineId = loadConfig().machineId || '';
                    // Local daemon's operator-set nickname — stamped onto the self/base
                    // node at render time so the friendly label resolves even before the
                    // persisted node record (addNode) has been rewritten with it.
                    const localMachineNickname = (() => {
                        const nick = loadConfig().machineNickname;
                        return typeof nick === 'string' && nick.trim() ? nick.trim() : '';
                    })();
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
                    // Per-node render is parallelized (Promise.allSettled below):
                    // each node's git probe (local getGitRepoStatus or the remote
                    // P2P fan-out) is independent, so serializing them stacked one
                    // slow node's latency onto every other node. Each node has its
                    // own bounded timeout; a rejected/timed-out node degrades to a
                    // partial/last-known status for THAT node only and never rejects
                    // the whole aggregate. Order is preserved by mapping over the
                    // original entries() index and re-assembling in order.
                    const renderMeshNode = async (nodeIndex: number, node: any): Promise<Record<string, unknown>> => {
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
                        // A locally-hosted node's friendly label comes from THIS daemon's
                        // local config.machineNickname. Stamp it onto the node record (if
                        // not already carried) so buildMeshNodeMachineLabel below resolves
                        // to the nickname and labelSource reads 'explicit_metadata' even
                        // before addNode's persisted record has been rewritten. Worktree
                        // nodes are included (machine ⊃ nodes, 2026-08-24): they live on
                        // this same machine and must carry the same machine label — this
                        // stamp replaced the old host_machine relabel post-pass.
                        if ((isSelfNode || node.isLocalWorktree === true) && localMachineNickname
                            && !readStringValue(node.machineNickname, node.machine_nickname)) {
                            node.machineNickname = localMachineNickname;
                        }
                        // Same reasoning for the hostname: locally-hosted records are
                        // persisted with no machine evidence at all (no hostname,
                        // often no daemonId), so without this stamp a nickname-less
                        // machine's label would degrade to a node id. Also lets the
                        // machine-identity probe match on hostname.
                        if ((isSelfNode || node.isLocalWorktree === true) && coordinatorHostname
                            && !readStringValue(node.hostname, node.host)) {
                            node.hostname = coordinatorHostname;
                        }
                        const machineIdentity = buildMeshNodeMachineIdentity(node as Record<string, unknown>, {
                            localMachineId,
                            localDaemonId: ctx.deps.statusInstanceId,
                            coordinatorHostname,
                            isSelfNode,
                        });
                        const status: Record<string, unknown> = {
                            nodeId,
                            // machineLabel is MACHINE-axis only (owner axiom 2026-08-24):
                            // identical across every checkout this machine hosts. The
                            // checkout identity travels in nodeLabel/worktreeBranch.
                            machineLabel: buildMeshNodeMachineLabel(node as Record<string, unknown>, nodeId),
                            nodeLabel: buildMeshNodeCheckoutLabel(node as Record<string, unknown>, nodeId),
                            labelSource: readStringValue(node.machineLabel, node.machine_label, node.machineNickname, node.machine_nickname, node.alias)
                                ? 'explicit_metadata'
                                : 'machine_identity',
                            workspace: node.workspace,
                            repoRoot: node.repoRoot,
                            isLocalWorktree: node.isLocalWorktree,
                            worktreeBranch: node.worktreeBranch,
                            role: normalizeMeshDaemonRole(node.role) || (meshHost.hostNodeId && nodeId === meshHost.hostNodeId ? 'host' : undefined),
                            daemonId,
                            // A node hosted by THIS machine (the self/base node or a local
                            // worktree) must carry the local machine identity even when the
                            // config record never stored one (standalone nodes are added
                            // without daemonId/machineId). Without it, the dashboard's
                            // per-machine grouping falls back to nodeId and one machine's
                            // plan quota renders once per worktree as if each worktree had
                            // its own quota.
                            machineId: nodeMachineId || node.machineId
                                || ((isSelfNode || node.isLocalWorktree === true)
                                    ? (localMachineId || ctx.deps.statusInstanceId || undefined)
                                    : undefined),
                            machine: machineIdentity,
                            machineStatus: node.machineStatus,
                            health: 'unknown',
                            providers: node.providers || [],
                            // T7: surface self-healed provider versions + build version (from the
                            // git_status envelope, persisted on the node) so the coordinator/UI can
                            // spot a provider-version skew across nodes. Additive; omitted when a
                            // node has never reported them.
                            ...(node.reportedProviderVersions && typeof node.reportedProviderVersions === 'object'
                                ? { providerVersions: node.reportedProviderVersions }
                                : {}),
                            ...(typeof node.reportedDaemonBuildVersion === 'string' && node.reportedDaemonBuildVersion
                                ? { daemonBuildVersion: node.reportedDaemonBuildVersion }
                                : {}),
                            // Opaque pass-through of the versioned facts bundle —
                            // never rebuild it field-by-field (deploy-lag design §a).
                            ...(node.nodeFacts && typeof node.nodeFacts === 'object'
                                ? { nodeFacts: node.nodeFacts }
                                : {}),
                            providerPriority,
                            // ORCHESTRATION_NODE_SLOTS.md: surface the node's capability
                            // slots so the dashboard slot editor can read them. Only
                            // emitted when explicitly configured (derived-from-legacy
                            // slots stay implicit — the editor shows the legacy fields).
                            ...(Array.isArray((node.policy as any)?.slots) && (node.policy as any).slots.length
                                ? { slots: normalizeNodeCapabilitySlots((node.policy as any).slots) }
                                : {}),
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
                                        return status;
                                    }
                                    if (meshRecord?.source === 'inline_cache' && !isSelfNode) {
                                        applyInlineMeshBranchConvergence(mesh, node, status);
                                        finalizeMeshNodeStatus({ status, node, daemonId, isSelfNode, directTruthUnavailable: directTruthUnavailableNodeIds.has(nodeId) });
                                        return status;
                                    }
                                }
                            } else {
                                try {
                                    // Route through the shared per-request cache so this
                                    // local probe reuses the bootstrap hydrate's probe for
                                    // the same workspace (and vice versa) instead of
                                    // re-shelling ~14 git processes across the 1.5s TTL.
                                    const runLocalProbe = () => getGitRepoStatus(workspace, { timeoutMs: 10_000, refreshUpstream: true }) as unknown as Promise<Record<string, unknown> | null>;
                                    const gitStatus = (await meshGitProbeCache.probeLocal(workspace, runLocalProbe)) as any;
                                    if (!gitStatus) throw new Error('local_git_probe_unavailable');
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
                        // T7: providerVersions/daemonBuildVersion are stamped onto the initial
                        // status snapshot above from node.reported* — but recordInlineMeshDirectGitTruth
                        // (which self-heals those node fields from the local version cache for the
                        // coordinator's own self/worktree nodes) runs AFTER that snapshot. Re-sync from
                        // the now-stamped node here so the self node surfaces its chips in the same call
                        // rather than lagging a poll cycle. Additive; skipped when the node never reported.
                        if (node.reportedProviderVersions && typeof node.reportedProviderVersions === 'object') {
                            status.providerVersions = node.reportedProviderVersions;
                        }
                        if (typeof node.reportedDaemonBuildVersion === 'string' && node.reportedDaemonBuildVersion) {
                            status.daemonBuildVersion = node.reportedDaemonBuildVersion;
                        }
                        return status;
                    };
                    const meshNodeEntries = [...(mesh.nodes || []).entries()];
                    const settledNodeStatuses = await Promise.allSettled(
                        meshNodeEntries.map(([nodeIndex, node]) => renderMeshNode(nodeIndex, node)),
                    );
                    const nodeStatuses = settledNodeStatuses.map((settled, i) => {
                        if (settled.status === 'fulfilled') return settled.value;
                        // A per-node render should never reject (every git path is
                        // caught internally), but if one does, degrade to a minimal
                        // last-known/unknown entry for THAT node so a single failure
                        // can't drop the whole aggregate. Best-effort recovery of the
                        // node's cached inline truth, else an unknown-health stub.
                        const [nodeIndex, node] = meshNodeEntries[i];
                        const nodeId = normalizeMeshNodeId(node) ?? '';
                        const daemonId = readStringValue(node.daemonId);
                        const fallback: Record<string, unknown> = {
                            nodeId,
                            machineLabel: buildMeshNodeMachineLabel(node as Record<string, unknown>, nodeId),
                            nodeLabel: buildMeshNodeCheckoutLabel(node as Record<string, unknown>, nodeId),
                            labelSource: readStringValue(node.machineLabel, node.machine_label, node.machineNickname, node.machine_nickname, node.alias)
                                ? 'explicit_metadata'
                                : 'machine_identity',
                            workspace: node.workspace,
                            repoRoot: node.repoRoot,
                            isLocalWorktree: node.isLocalWorktree,
                            worktreeBranch: node.worktreeBranch,
                            daemonId,
                            machineId: readMeshNodeMachineId(node as Record<string, unknown>) || node.machineId,
                            health: 'unknown',
                            providers: node.providers || [],
                            activeSessions: [],
                            activeSessionDetails: [],
                            launchReady: false,
                            error: settled.reason instanceof Error ? settled.reason.message : 'node render failed',
                        };
                        applyCachedInlineMeshNodeStatus(fallback, node);
                        applyInlineMeshBranchConvergence(mesh, node, fallback);
                        finalizeMeshNodeStatus({ status: fallback, node, daemonId, isSelfNode: false, directTruthUnavailable: directTruthUnavailableNodeIds.has(nodeId) });
                        return fallback;
                    });
                    // (The 08-24 host_machine relabel post-pass lived here for one
                    // cycle. It is gone because it is no longer needed: machineLabel
                    // is now generated machine-axis-only by buildMeshNodeMachineLabel,
                    // with the local nickname/hostname stamped onto self AND local
                    // worktree records above — every checkout on a machine resolves
                    // to the same label at the source, order-independent.)

                    const cachedProjectionNodeIds = nodeStatuses
                        .filter((status: any) => status?.dataFreshness?.projection === 'cached'
                            && status?.dataFreshness?.directPeerTruthSatisfied === false)
                        .map((status: any) => readStringValue(status?.nodeId))
                        .filter(Boolean);

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
                    // T6 (B3c): live enforce/observability counters from this daemon. A
                    // process-lifetime snapshot (never cached — like unroutableDeliveries)
                    // so an operator/coordinator can read enforce state, quarantine tallies,
                    // and last-resort backstop fires straight from the aggregate status.
                    const meshProtocolV2Counters: MeshProtocolV2Counters = {
                        enforce: isMeshProtocolV2EnforceEnabled(),
                        drain: { ...getMeshV2DrainCounters() },
                        backstop: { ...getMeshV2BackstopCounters() },
                    };
                    // Pending-event retention sweep counters — surfaced the same way as
                    // meshProtocolV2Counters (process-lifetime, never cached) so an operator
                    // can see undrainedExpired (genuine silent-drop risk, mirrored to
                    // event_held) without having to run mesh_requeue_held_events first.
                    const pendingRetentionCounters: MeshPendingRetentionCounters = { ...getPendingRetentionCounters() };
                    // Stage 6: unified turn-presentation observability — authority source
                    // usage, shadow divergences (reason|surface|provider) and age gauges.
                    // Process-lifetime snapshot (never cached — like meshProtocolV2Counters).
                    const turnPresentationCounters = getTurnPresentationMetrics();
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

                    // FIX C-backend: fold persisted MAGI cross-verification activity into the
                    // dashboard mesh_status payload so the web MAGI surface (extractMagiActivity)
                    // can read synthesis output — needs_verification counts, the independence
                    // banner, git skew, and a bounded needs_verification preview — without
                    // re-running collection. Mirrors the MCP mesh_status tool
                    // (mesh-tools-status.ts buildMeshMagiActivity / summarizeMeshMagiActivity).
                    // Read magi_dispatched/magi_synthesis entries over a wider tail than the 20
                    // rendered above (MAGI events are sparse — a 20-entry tail routinely misses
                    // the dispatch/synthesis pair). Compact (the default) folds synthesized groups
                    // to a bounded recent set + a count summary; verbose carries the full list.
                    const { buildMeshMagiActivity, summarizeMeshMagiActivity } = await import('../../mesh/mesh-magi-status.js');
                    const magiLedgerEntries = readLedgerEntries(meshId, { kind: ['magi_dispatched', 'magi_synthesis'], tail: 200 });
                    const magiActivity = buildMeshMagiActivity({ meshId, ledgerEntries: magiLedgerEntries });
                    let magiActivityFold: ReturnType<typeof summarizeMeshMagiActivity> | undefined;
                    if (magiActivity.length > 0 && !verboseMissions) {
                        magiActivityFold = summarizeMeshMagiActivity(magiActivity);
                    }
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
                                    cachedProjectionNodeIds,
                                },
                            } : {}),
                            historicalEvidenceOnly: ['recoveryHints', 'ledger.summary', 'queue.summary', 'historicalSessions'],
                        },
                        branchConvergenceSummary: summarizeInlineMeshBranchConvergence(nodeStatuses),
                        ...(previewFreshness ? { previewFreshness, deployFreshness: previewFreshness } : {}),
                        nodes: nodeStatuses,
                        // Mesh-level scheduling rollup (strategy only). Mirrors the MCP
                        // `mesh_status` tool's `scheduling` block field-for-field — the global-cap
                        // numbers (maxParallelTasks/maxReadonlyParallelTasks/activeWriteAssigned/
                        // activeReadonlyAssigned/globalWriteCapReached/globalReadonlyCapReached)
                        // are deliberately not surfaced: real concurrency is governed per-node/
                        // per-slot (nodes[].scheduling.providerRoles/capReasons above), and the
                        // global number does not represent actual capacity. Exposure-only —
                        // buildMeshSchedulingRuntime still computes these internally for
                        // maybeAutoLaunchOneQueueSession's own gating.
                        scheduling: {
                            strategy: schedulingRuntime.strategy,
                        },
                        queue: { tasks: queue, summary: queueSummary },
                        ledger: { entries: ledgerEntries, summary: ledgerSummary },
                        ...(missions.length > 0 ? { missions } : {}),
                        // Compact (default): bounded folded groups + a status-count summary.
                        // Verbose: the full reconstructed activity list. Mirrors the MCP tool.
                        ...(magiActivity.length > 0
                            ? (magiActivityFold
                                ? {
                                    ...(magiActivityFold.groups.length > 0 ? { magiActivity: magiActivityFold.groups } : {}),
                                    magiActivitySummary: {
                                        total: magiActivityFold.total,
                                        byStatus: magiActivityFold.byStatus,
                                        ...(magiActivityFold.staleSynthesized > 0 ? { staleSynthesized: magiActivityFold.staleSynthesized } : {}),
                                    },
                                }
                                : { magiActivity })
                            : {}),
                        ...(asyncRefineJobs.length > 0 ? { asyncRefineJobs } : {}),
                        ...(historicalSessions ? { historicalSessions } : {}),
                        ...(pendingCoordinatorEvents.length > 0 ? { pendingCoordinatorEvents } : {}),
                        ...(unroutableDeliveries.length > 0 ? { unroutableDeliveries } : {}),
                        meshProtocolV2Counters,
                        pendingRetentionCounters,
                        turnPresentationCounters,
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
                    const { pendingCoordinatorEvents: _pendingCoordinatorEvents, unroutableDeliveries: _unroutableDeliveries, meshProtocolV2Counters: _meshProtocolV2Counters, pendingRetentionCounters: _pendingRetentionCounters, turnPresentationCounters: _turnPresentationCounters, ...cacheableStatusResult } = statusResult as any;
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
                        meshProtocolV2Counters,
                        pendingRetentionCounters,
                        turnPresentationCounters,
                    };
                    logRepoMeshStatusDebug('return_live', {
                        meshId,
                        command: 'mesh_status',
                        refreshRequested,
                        refreshReason,
                        meshSource: meshRecord.source,
                        directTruth,
                        durationMs: Date.now() - startedAtMs,
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
