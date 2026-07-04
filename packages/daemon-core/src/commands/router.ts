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
import { DaemonCommandHandler } from './handler.js';
import { lowFamilyRegistry } from './low-family/index.js';
import { medFamilyRegistry } from './med-family/index.js';
import { launchIde } from './med-family/ide.js';
import type { MedFamilyContext } from './med-family/index.js';
import { highFamilyRegistry } from './high-family/index.js';
import type { HighFamilyContext } from './high-family/index.js';
import { DaemonCliManager } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { killIdeProcess, isIdeRunning } from '../launch.js';
import { normalizeMeshNodeId, meshNodeIdMatches, daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { logCommand } from '../logging/command-log.js';
import type { CommandLogEntry } from '../logging/command-log.js';
import { createInteractionId, recordDebugTrace } from '../logging/debug-trace.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../mesh/mesh-events.js';
import { buildMeshHostRequiredFailure, resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { analyzeMeshRefineNodeChangeArea, orderMeshRefineBatchNodes } from '../mesh/mesh-refine-batch.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { getMeshQueueRevision } from '../mesh/mesh-work-queue.js';
import type { RepoMeshSessionCleanupMode } from '../repo-mesh-types.js';
import { DEFAULT_MESH_POLICY, magiAutoLaunchedSessionCleanupDecision } from '../repo-mesh-types.js';
import { resolve as pathResolve } from 'path';
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';

// ─── Extracted-module imports (symbols the dispatch class consumes) ───
import {
    applyInlineMeshBranchConvergence,
    buildInlineMeshTransitGitStatus,
    buildLivePeerGitConnection,
    collectMeshNodeHostedSessionIds,
    deriveMeshNodeHealthFromGit,
    foldMeshNodeIdentityToCanonical,
    inlineMeshCarriesTransientNodeTruth,
    isDeadLocalWorktreeNode,
    MESH_DIRECT_PROBE_REUSE_MS,
    MeshGitProbeCache,
    normalizeInlineMeshNodeIdentity,
    readBooleanValue,
    readCachedInlineMeshActiveSessions,
    readInlineMeshNodeId,
    readMeshNodeDaemonId,
    readObjectRecord,
    readStringValue,
    reconcileInlineMeshCache,
    sanitizeInlineMesh,
    shouldRefreshStalePendingAggregate,
    summarizeInlineMeshBranchConvergence,
} from '../mesh/mesh-node-identity.js';
import {
    alignRefinerySubmodulesAfterMerge,
    buildMeshRefineValidationPlan,
    buildSubmodulePublishRequiredNextStep,
    checkWorktreeChangesPatchEquivalentInRef,
    MeshRefineAsyncJobStatus,
    MeshRefineBatchJobHandle,
    MeshRefineBatchJobStatus,
    MeshRefineBatchTerminalJob,
    MeshRefineJobHandle,
    MeshRefineTerminalJob,
    MeshWorktreePatchContainmentSummary,
    recordMeshRefineStage,
    RefineContext,
    RefineExecFileAsync,
    RefineStageOutcome,
    resolveRefineryAutoPublishSubmoduleMainCommits,
    runMeshRefineEffectiveDiffGate,
    runMeshRefinePatchEquivalenceGate,
    runMeshRefineSubmoduleReachabilityGate,
    runMeshRefineValidationGate,
    truncateValidationOutput,
} from '../mesh/mesh-refine-gates.js';
// ─── Refinery job orchestration (bodies extracted from this file) ───
import {
    batchRefineMeshNodes,
    resumePendingRefineJobsOnStartup,
    startMeshRefineBatchJob,
    startMeshRefineJob,
} from './router-refine.js';
// ─── Worktree / mesh-session cleanup (bodies extracted from this file) ───
import {
    bestEffortRemoveWorktreeDir,
    cleanupLocalWorktreeNode,
    cleanupMeshSessions,
    getWorktreeForceCleanupConvergence,
    isCompletedHostedSession,
    precheckLocalWorktreeRemovable,
    recordIntentionalMeshSessionStop,
    sessionMatchesMeshNode,
} from './router-worktree-cleanup.js';

// ─── Barrel re-exports: node-identity / git-freshness, refine gates, coordinator config ───
// These modules were split out of router.ts. Re-export their public surface so the
// many existing `from '.../commands/router.js'` named imports keep resolving here.
export * from '../mesh/mesh-node-identity.js';
export * from '../mesh/mesh-refine-gates.js';
export * from '../mesh/mesh-coordinator-config.js';

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
    /** Public (not private) so the extracted ./router-refine.ts orchestration can reach it via `self`. */
    deps: CommandRouterDeps;
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
    /** Meshes with a background SWR freshen (async mesh_status refresh) already in
     *  flight — so a burst of interactive detail-opens serves the cached snapshot
     *  and coalesces onto ONE background refresh instead of storming the peers. */
    private swrRefreshInFlight = new Set<string>();
    /** In-memory async Refinery jobs keyed by meshId:nodeId to reject/return duplicate in-flight requests.
     *  Public (not private) so the extracted ./router-refine.ts orchestration can reach it via `self`. */
    runningRefineJobs = new Map<string, MeshRefineJobHandle>();
    /** Terminal async Refinery jobs preserve a clear answer after the worktree node has been removed. */
    terminalRefineJobs = new Map<string, MeshRefineTerminalJob>();
    /** In-memory async batch Refinery jobs keyed by meshId (one batch convergence per mesh at a time). */
    runningRefineBatchJobs = new Map<string, MeshRefineBatchJobHandle>();
    /** Terminal async batch Refinery jobs preserve the last batch outcome for late readers. */
    terminalRefineBatchJobs = new Map<string, MeshRefineBatchTerminalJob>();

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

    private getCachedAggregateMeshStatus(
        meshId: string,
        mesh?: any,
        options?: { requireDirectPeerTruth?: boolean; allowStalePending?: boolean },
    ): any | null {
        const cached = this.aggregateMeshStatusCache.get(meshId);
        if (!cached?.snapshot || cached.snapshot.success !== true || !Array.isArray(cached.snapshot.nodes)) return null;
        // Genuine invalidation still forces truth: a queue mutation bumps the
        // revision, so a stale-revision snapshot is never served (even under the
        // SWR allowStalePending path below).
        if (cached.queueRevision !== getMeshQueueRevision(meshId)) return null;
        let snapshot = this.cloneJsonValue(cached.snapshot);
        snapshot = this.hydrateCachedAggregateMeshStatusFromInline(snapshot, mesh, options);
        // SWR: allowStalePending lets the interactive detail-open serve a snapshot
        // that still has pending peer-git nodes (would otherwise miss here) so the
        // graph paints instantly; the caller fires a background freshen. The
        // queueRevision guard above is NOT relaxed — only the pending-git freshness
        // gate is, so a genuine queue/identity mutation still forces a live rebuild.
        if (!options?.allowStalePending && shouldRefreshStalePendingAggregate(snapshot, options)) return null;
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
     *
     * CANCEL-STOP-RELAY: the session-id cache scan above only matches when the coordinator's
     * cached status snapshot already lists the worker's session id in a recognized active-sessions
     * shape. A worktree-clone worker session whose id form/timing differs from the cached snapshot
     * (or is simply not yet reflected) misses the scan, so a stop that carries the authoritative
     * owning nodeId (mesh_queue_cancel knows assignedNodeId) used to silently fail to forward.
     * `ownerNodeIdHint` adds a deterministic fallback: when the session-id scan misses, resolve the
     * owner daemonId by matching the node by id (meshNodeIdMatches — same form-tolerant compare the
     * rest of the router uses, no new raw compare). The same self-loopback guard applies to both
     * paths, so a coordinator-hosted node is still never force-forwarded to a remote form of itself.
     */
    public resolveRemoteMeshSessionOwnerDaemonId(sessionId: string, ownerNodeIdHint?: string): string | undefined {
        const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
        const nodeHint = typeof ownerNodeIdHint === 'string' ? ownerNodeIdHint.trim() : '';
        if (!trimmed && !nodeHint) return undefined;
        const selfDaemonId = this.deps.statusInstanceId;
        const candidates = this.collectMeshSessionOwnerCandidateNodes();
        if (trimmed) {
            for (const node of candidates) {
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
        }
        // Deterministic fallback: the session-id scan missed (cache lag / id-form mismatch on a
        // worktree-clone worker), but the caller knows the authoritative owning nodeId. Resolve the
        // owner daemonId straight off that node — never the fuzzy session cache.
        if (nodeHint) {
            for (const node of candidates) {
                if (!meshNodeIdMatches(node, nodeHint)) continue;
                const nodeDaemonId = readMeshNodeDaemonId(readObjectRecord(node));
                if (!nodeDaemonId) continue;
                if (selfDaemonId && daemonIdsEquivalent(nodeDaemonId, selfDaemonId)) return undefined;
                return nodeDaemonId;
            }
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

    async getMeshForCommand(
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

    invalidateAggregateMeshStatus(meshId: string): void {
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
            precheckLocalWorktreeRemovable: this.precheckLocalWorktreeRemovable.bind(this),
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
            swrRefreshInFlight: this.swrRefreshInFlight,
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

    /**
     * WORKTREE-BOOTSTRAP-COORD-STATE: mark a worktree node's bootstrap as reaching a
     * terminal state (complete / failed) in THIS daemon's mesh view.
     *
     * Root cause this fixes: clone_mesh_node forwards the clone+bootstrap to the
     * source node's daemon (the worktree's machine). persistWorktreeSetupState
     * therefore flips worktreeBootstrap.status to 'complete' on the WORKER daemon's
     * mesh object — never on the coordinator's. The coordinator only ever holds the
     * 'running' state it stamped from the forwarded clone reply. The claim path's
     * bootstrap gate (mesh-event-forwarding agent:ready / mesh-queue-assignment)
     * reads the coordinator's mesh via getMeshWithCache, sees status==='running'
     * forever, and DEFERS every claim — so the worktree_bootstrap_complete re-fire
     * (triggerMeshQueue) loops against a gate that never opens: claim never lands,
     * the idle session is re-registered each tick, and auto-launch keeps spawning
     * fresh sessions (runaway worktree-session multiplication).
     *
     * Called from the worktree_bootstrap_complete/_failed event handler BEFORE the
     * queue re-fire so the gate sees the terminal state and the deferred claim can
     * finally land. Updates the inline cache (clone worktree nodes are inline-only)
     * and, when the node also exists in local config, persists there too; both paths
     * invalidate the aggregate status cache. Best-effort and idempotent.
     */
    public markWorktreeBootstrapTerminalState(meshId: string, nodeId: string, status: 'complete' | 'failed', opts?: { workspace?: string }): void {
        if (!meshId || !nodeId) return;
        const terminalBootstrap = (prev?: Record<string, unknown>): Record<string, unknown> => ({
            ...(prev && typeof prev === 'object' ? prev : {}),
            status,
            completedAt: (prev as any)?.completedAt ?? new Date().toISOString(),
        });
        const stamp = (mesh: any): boolean => {
            if (!mesh || !Array.isArray(mesh.nodes)) return false;
            const node = mesh.nodes.find((entry: any) => meshNodeIdMatches(entry, nodeId));
            if (!node) return false;
            const prev = (node.worktreeBootstrap && typeof node.worktreeBootstrap === 'object')
                ? node.worktreeBootstrap as Record<string, unknown>
                : {};
            if (prev.status === status) return false;
            node.worktreeBootstrap = terminalBootstrap(prev);
            return true;
        };
        let changed = false;
        // Inline cache (the authoritative view for inline-only clone worktree nodes).
        try {
            const cached = this.getCachedInlineMesh(meshId);
            if (cached && stamp(cached)) {
                cached.updatedAt = new Date().toISOString();
                this.inlineMeshCache.set(meshId, cached);
                changed = true;
            } else if (!cached || !(Array.isArray(cached.nodes) && cached.nodes.some((entry: any) => meshNodeIdMatches(entry, nodeId)))) {
                // Fix (3) HYDRATE-ON-MISS: the terminal bootstrap event arrived for a node this
                // coordinator's inline view does NOT hold — the clone reply that would have seeded
                // the worktree node never reached this daemon (or the inline mesh for this id is
                // empty). With no node entry the claim gate has nothing to open, so the deferred
                // claim (mesh-event-forwarding agent:ready / mesh-queue-assignment) strands forever
                // and the coordinator relaunch/stop-loops. Instead of returning early, upsert a
                // minimal worktree node carrying the terminal bootstrap status from the event
                // payload so the gate — which reads this same inline view — sees a non-'running'
                // state and the registered idle session can finally claim. Identity is canonicalized
                // by updateInlineMeshNode (id/nodeId folded via the shared 3-form normalizer), so the
                // remote-clone node-id form resolves the same way every claim-path consumer matches.
                const shell = (cached && typeof cached === 'object')
                    ? cached
                    : { id: meshId, nodes: [] as any[], updatedAt: new Date().toISOString() };
                if (!Array.isArray(shell.nodes)) shell.nodes = [];
                const hydratedNode: any = {
                    id: nodeId,
                    nodeId,
                    isLocalWorktree: true,
                    ...(opts?.workspace ? { workspace: opts.workspace } : {}),
                    worktreeBootstrap: terminalBootstrap(),
                };
                this.updateInlineMeshNode(meshId, shell, hydratedNode);
                changed = true;
            }
        } catch { /* best-effort */ }
        if (changed) this.invalidateAggregateMeshStatus(meshId);
        // Local config (a worktree node registered via addNode also lives here).
        // Done in a detached dynamic-import chain so the method stays sync; both the
        // stamp and the persist are best-effort, and the inline-cache stamp above is
        // what the coordinator's claim gate reads.
        void import('../config/mesh-config.js')
            .then(({ getMesh, updateNode }) => {
                const local = getMesh(meshId);
                if (local && stamp(local)) {
                    const node = local.nodes.find((entry: any) => meshNodeIdMatches(entry, nodeId));
                    if (node) updateNode(meshId, node.id, { worktreeBootstrap: node.worktreeBootstrap } as any);
                    this.invalidateAggregateMeshStatus(meshId);
                }
            })
            .catch(() => { /* persistence is best-effort */ });
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

    normalizeMeshSessionCleanupMode(value: unknown): RepoMeshSessionCleanupMode {
        return value === 'stop'
            || value === 'delete_stopped'
            || value === 'stop_and_delete'
            || value === 'preserve'
            ? value
            : 'preserve';
    }

    // ─── Worktree / mesh-session cleanup ────────────────────────────────
    // Implementation lives in ./router-worktree-cleanup.ts (behavior-preserving
    // code move). Kept here as thin delegators: cleanupMeshSessions /
    // cleanupLocalWorktreeNode / precheckLocalWorktreeRemovable are bound into
    // MedFamilyContext; bestEffortRemoveWorktreeDir is overridden on the instance
    // by a unit test, so callers reach these via `self.` for correct dispatch.

    sessionMatchesMeshNode(record: any, node: any, nodeId: string, sessionIds?: Set<string>): boolean {
        return sessionMatchesMeshNode(this, record, node, nodeId, sessionIds);
    }

    async bestEffortRemoveWorktreeDir(dir: string): Promise<{ removed: boolean; residue: boolean; error?: string }> {
        return bestEffortRemoveWorktreeDir(this, dir);
    }

    async precheckLocalWorktreeRemovable(args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ ok: true } | { ok: false; code: string; error: string; recoveryHint: string }> {
        return precheckLocalWorktreeRemovable(this, args);
    }

    async cleanupLocalWorktreeNode(args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown>; recovered?: boolean; residue?: boolean; residueWarning?: string; residueError?: string; branchRefDeleted?: boolean; branchRefReason?: string; branchRefForced?: boolean; branchRefWarning?: string } | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> }> {
        return cleanupLocalWorktreeNode(this, args);
    }

    async getWorktreeForceCleanupConvergence(args: {
        repoRoot: string;
        workspace: string;
        node: any;
    }): Promise<{ allow: boolean; status?: string; source?: string; ref?: string; error?: string }> {
        return getWorktreeForceCleanupConvergence(this, args);
    }

    isCompletedHostedSession(record: any): boolean {
        return isCompletedHostedSession(this, record);
    }

    async recordIntentionalMeshSessionStop(args: {
        meshId: string;
        nodeId: string;
        node: any;
        sessionId: string;
        mode: RepoMeshSessionCleanupMode;
        source: 'mesh_cleanup_sessions' | 'mesh_remove_node' | 'magi_session_cleanup';
        action: 'stop_session' | 'delete_session_force';
    }): Promise<void> {
        return recordIntentionalMeshSessionStop(this, args);
    }

    async cleanupMeshSessions(args: {
        meshId: string;
        nodeId: string;
        node: any;
        mode: RepoMeshSessionCleanupMode;
        sessionIds?: string[];
        dryRun?: boolean;
        source?: 'mesh_cleanup_sessions' | 'mesh_remove_node' | 'magi_session_cleanup';
        requireAutoLaunchedForTaskIds?: Record<string, string>;
        reclaimOrphans?: boolean;
        liveMeshNodeIds?: string[];
    }): Promise<{ success: boolean; [key: string]: unknown }> {
        return cleanupMeshSessions(this, args);
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


    // ─── Refinery job orchestration ─────────────────────────────────────
    // Implementation lives in ./router-refine.ts (behavior-preserving code move).
    // Only the externally-referenced entry points remain here as thin delegators.

    async resumePendingRefineJobsOnStartup(): Promise<void> {
        return resumePendingRefineJobsOnStartup(this);
    }

    private async batchRefineMeshNodes(meshId: string, requestedNodeIds: string[] | undefined, args: any): Promise<CommandRouterResult> {
        return batchRefineMeshNodes(this, meshId, requestedNodeIds, args);
    }

    private async startMeshRefineBatchJob(meshId: string, requestedNodeIds: string[] | undefined, args: any): Promise<CommandRouterResult> {
        return startMeshRefineBatchJob(this, meshId, requestedNodeIds, args);
    }

    private async startMeshRefineJob(meshId: string, nodeId: string, args: any): Promise<CommandRouterResult> {
        return startMeshRefineJob(this, meshId, nodeId, args);
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
                    // CANCEL-STOP-RELAY: pass the authoritative owning nodeId (when the caller
                    // shipped one in meshContext, e.g. mesh_queue_cancel's assignedNodeId) as the
                    // deterministic owner-resolution fallback. The session-id cache scan stays the
                    // primary path; the hint only kicks in when that scan misses (worktree-clone
                    // worker session not yet in / form-mismatched against the cached snapshot).
                    const meshContext = readObjectRecord(args?.meshContext);
                    const ownerNodeIdHint = readStringValue(meshContext.nodeId);
                    const ownerDaemonId = this.resolveRemoteMeshSessionOwnerDaemonId(targetSessionId, ownerNodeIdHint);
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
