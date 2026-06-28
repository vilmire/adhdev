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
import { DEFAULT_MESH_POLICY } from '../repo-mesh-types.js';
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

    /**
     * Non-destructive precheck mirroring every REFUSAL condition in
     * {@link cleanupLocalWorktreeNode} — missing workspace / source-repo / branch
     * metadata, unexpected (non-managed) path, branch mismatch — PLUS the
     * dirty-worktree guard that `removeWorktree(requireClean)` enforces
     * (`git status --porcelain`). It performs ZERO destructive actions: no
     * `git worktree remove`, no `git worktree prune`, no directory deletion.
     *
     * remove_mesh_node calls this BEFORE any session cleanup so that a refusal
     * (the common one being a dirty worktree) does not first stop/delete the
     * delegated session and orphan it — the original ordering bug. Success/skip
     * cases that the real cleanup handles idempotently (worktree path already
     * gone, git-de-registered residue) are NOT refusals and return `{ ok: true }`.
     *
     * `force:true` skips the dirty guard, preserving `removeWorktree`'s
     * `requireClean: !force` semantics. This is a read-only superset check; the
     * authoritative `requireClean` guard inside `removeWorktree` is intentionally
     * kept as a second line of defense against a precheck→execute race.
     */
    private async precheckLocalWorktreeRemovable(args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ ok: true } | { ok: false; code: string; error: string; recoveryHint: string }> {
        const sessionPreservedNote = ' The delegated session was left running (not stopped) — resolve the issue and retry mesh_remove_node.';
        const workspace = typeof args.node?.workspace === 'string' ? args.node.workspace.trim() : '';
        if (!workspace) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_missing_workspace',
                error: `Worktree node '${args.nodeId}' is missing workspace metadata`,
                recoveryHint: 'Inspect the mesh node record before removing it, or remove stale metadata manually only after confirming no managed worktree remains.' + sessionPreservedNote,
            };
        }

        // Worktree path already gone → not a refusal; the real cleanup returns a
        // skipped:true success and the node is dropped from the registry.
        if (!fs.existsSync(workspace)) return { ok: true };

        const sourceNode = args.node?.clonedFromNodeId
            ? args.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, args.node.clonedFromNodeId))
            : args.mesh?.nodes?.find((n: any) => !n.isLocalWorktree);
        const repoRoot = typeof sourceNode?.repoRoot === 'string' && sourceNode.repoRoot.trim()
            ? sourceNode.repoRoot.trim()
            : typeof sourceNode?.workspace === 'string' && sourceNode.workspace.trim()
                ? sourceNode.workspace.trim()
                : '';
        if (!repoRoot || !fs.existsSync(repoRoot)) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_missing_source_repo',
                error: `Refusing to remove worktree '${workspace}' because the source repo root is unavailable`,
                recoveryHint: 'Run mesh_remove_node from the machine that owns the source repo, or verify the source node metadata before retrying.' + sessionPreservedNote,
            };
        }
        if (typeof args.node?.worktreeBranch !== 'string' || !args.node.worktreeBranch.trim()) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_missing_branch',
                error: `Refusing to remove worktree '${workspace}' because worktreeBranch metadata is missing`,
                recoveryHint: 'Confirm this is an ADHDev-managed worktree before removing it manually; managed worktree nodes include worktreeBranch metadata.' + sessionPreservedNote,
            };
        }

        const { resolveWorktreePath, listWorktrees } = await import('../git/git-worktree.js');
        const normalizePath = (value: string) => {
            const resolved = pathResolve(value);
            try { return fs.realpathSync(resolved); } catch { return resolved; }
        };
        const expectedPath = normalizePath(resolveWorktreePath(repoRoot, String(args.mesh?.name || args.mesh?.id || 'mesh'), args.node.worktreeBranch));
        const actualPath = normalizePath(workspace);
        if (actualPath !== expectedPath) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_unexpected_path',
                error: `Refusing to remove worktree '${workspace}' because it is not at the expected managed path '${expectedPath}'`,
                recoveryHint: 'Use git worktree list/status to inspect the path. Retry only after confirming the mesh node metadata points to an ADHDev-managed worktree.' + sessionPreservedNote,
            };
        }

        const entries = await listWorktrees(repoRoot);
        const managedEntry = entries.find(entry => normalizePath(entry.path) === actualPath);
        // De-registered residue (git no longer lists it as a worktree) is an
        // idempotent recovery path in the real cleanup, NOT a refusal — neither the
        // branch-mismatch nor the dirty check applies, so let the removal proceed.
        if (!managedEntry) return { ok: true };

        if (managedEntry.branch && managedEntry.branch !== args.node.worktreeBranch) {
            return {
                ok: false,
                code: 'mesh_worktree_cleanup_branch_mismatch',
                error: `Refusing to remove '${workspace}' because git reports branch '${managedEntry.branch}', expected '${args.node.worktreeBranch}'`,
                recoveryHint: 'Inspect the worktree branch and mesh metadata before retrying cleanup.' + sessionPreservedNote,
            };
        }

        // Dirty-worktree guard — a read-only mirror of removeWorktree(requireClean)
        // (`git status --porcelain` run inside the worktree). `force:true` skips it,
        // preserving the requireClean:!force semantics.
        if (args.force !== true) {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            try {
                const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
                    cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
                });
                if (stdout.trim()) {
                    return {
                        ok: false,
                        code: 'mesh_worktree_cleanup_dirty',
                        error: `Refusing to remove dirty worktree: ${workspace}`,
                        recoveryHint: 'Commit, stash, or intentionally discard the worktree changes before retrying mesh_remove_node. The mesh registry entry is preserved until cleanup is safe.' + sessionPreservedNote,
                    };
                }
            } catch {
                // A status probe failure is not itself proof of dirtiness; defer to
                // the authoritative removeWorktree(requireClean) guard rather than
                // refusing here (which would block an otherwise-clean removal).
                return { ok: true };
            }
        }

        return { ok: true };
    }

    private async cleanupLocalWorktreeNode(args: {
        mesh: any;
        node: any;
        nodeId: string;
        force?: boolean;
    }): Promise<{ success: true; skipped?: boolean; removedPath?: string; repoRoot?: string; reason?: string; fallback?: string; forced?: boolean; convergence?: Record<string, unknown>; recovered?: boolean; residue?: boolean; residueWarning?: string; residueError?: string; branchRefDeleted?: boolean; branchRefReason?: string; branchRefForced?: boolean; branchRefWarning?: string } | { success: false; code: string; error: string; recoveryHint: string; convergence?: Record<string, unknown> }> {
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

        // Always evaluate real merge convergence so we can decide whether the
        // branch ref is safe to delete after removal — even on the force path,
        // where `force_override` only authorizes the *worktree* removal and must
        // NOT be taken as proof the branch is merged (that would risk work loss).
        const mergeConvergence = await this.getWorktreeForceCleanupConvergence({ repoRoot, workspace, node: args.node });
        const forceFallbackConvergence = args.force
            ? { allow: true, status: 'force_override', source: 'caller_force_flag' }
            : mergeConvergence;

        // After the worktree is removed, delete the branch ref iff the branch is
        // fully merged into the default ref (no work loss). Otherwise preserve it
        // and surface a warning. `mergeConvergence` (NOT the force override) is the
        // authority on merged-ness.
        const deleteBranchIfMerged = async () => {
            const branch = String(args.node.worktreeBranch).trim();
            const status = mergeConvergence.allow ? (mergeConvergence.status || '') : '';
            const MERGED_STATUSES = new Set([
                'merged_to_main', 'merged_pushed', 'merged_to_default_ref', 'cleanup_candidate',
            ]);
            const PATCH_EQUIV_STATUS = 'patch_equivalent_to_default_ref';
            if (!branch) {
                return { branchRefDeleted: false, branchRefReason: 'empty_branch_name' };
            }
            if (!mergeConvergence.allow || (!MERGED_STATUSES.has(status) && status !== PATCH_EQUIV_STATUS)) {
                return {
                    branchRefDeleted: false,
                    branchRefReason: `branch_not_merged_preserved: ${mergeConvergence.error || mergeConvergence.status || 'convergence_unverified'}`,
                    branchRefWarning: `Branch ref '${branch}' was preserved (not deleted) because it is not confirmed merged into the default ref — no work was lost. Merge it (or pass a verified branchConvergence final state) and re-run cleanup, or delete it manually after confirming.`,
                };
            }
            const { deleteBranchRef } = await import('../git/git-worktree.js');
            // `-d` can detect a true fast-forward/merge; patch-equivalent landings
            // (squash/cherry-pick) are invisible to `-d`, so allow the verified `-D`
            // fallback only for the patch-equivalence status.
            const res = await deleteBranchRef(repoRoot, branch, { safeDeleteOnly: status !== PATCH_EQUIV_STATUS });
            return {
                branchRefDeleted: res.deleted,
                branchRefReason: res.reason,
                ...(res.forced ? { branchRefForced: true } : {}),
                ...(res.deleted ? {} : {
                    branchRefWarning: `Branch ref '${branch}' could not be deleted (${res.reason}); it was preserved so no work is lost.`,
                }),
            };
        };

        try {
            const result = await removeWorktree(repoRoot, workspace, {
                requireClean: !args.force,
                allowSubmoduleForceFallback: forceFallbackConvergence.allow,
            });
            const branchOutcome = await deleteBranchIfMerged();
            return {
                success: true,
                removedPath: result.removedPath,
                repoRoot,
                ...branchOutcome,
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
                    const branchOutcome = await deleteBranchIfMerged();
                    return {
                        success: true,
                        removedPath: workspace,
                        repoRoot,
                        ...branchOutcome,
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
                    const branchOutcome = await deleteBranchIfMerged();
                    return {
                        success: true,
                        removedPath: workspace,
                        repoRoot,
                        ...branchOutcome,
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
            //
            // Worktree-removal exception: when a WORKTREE node is being removed
            // (source === 'mesh_remove_node' AND node.isLocalWorktree === true), its
            // node-binding is already gone, so a still-live session in that workspace
            // matches by workspace ALONE (recordNodeId is empty). The shared-daemon
            // concern does not apply — a worktree has a private workspace path that is
            // not shared with the base/other nodes — so leaving it skipped orphans the
            // chat after the node + worktree dir + branch are gone. Clean it instead.
            // This narrowly covers ONLY the pure workspace-only-no-binding case; a
            // session bound to ANOTHER node (recordNodeId set and != this node) is still
            // skipped (live_delegate_bound_to_other_node), and the coordinator session is
            // already protected unconditionally above.
            const matchedByWorkspaceOnly = !recordNodeId;
            const isWorktreeNodeRemoval = cleanupSource === 'mesh_remove_node' && args.node?.isLocalWorktree === true;
            const cleanWorkspaceOnlyForWorktree = isWorktreeNodeRemoval && matchedByWorkspaceOnly;
            if (!hasExplicitSessionIds && liveRuntime && !delegateBoundToThisNode && !cleanWorkspaceOnlyForWorktree) {
                skippedSessionIds.push(sessionId);
                skippedLiveSessionIds.push(sessionId);
                const reason = recordNodeId && recordNodeId !== args.nodeId
                    ? `live_delegate_bound_to_other_node:${recordNodeId}`
                    : matchedByWorkspaceOnly
                        ? 'live_session_matched_by_workspace_only_no_node_binding'
                        : 'live_session_not_bound_to_this_node';
                skippedLiveSessionReasons.push({ sessionId, reason });
                continue;
            }
            if (cleanWorkspaceOnlyForWorktree && !delegateBoundToThisNode) {
                // A workspace-only live session on a worktree being removed is treated
                // like a bound delegate for accounting (so callers can see it was acted on).
                actedLiveDelegateSessionIds.push(sessionId);
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
                // REFINE-CLEANUP: refine reaches cleanup only AFTER a verified merge
                // convergence, so any residual worktree dirtiness here is incidental
                // (e.g. a bootstrap lockfile rewrite) — never unmerged work. `force`
                // sets requireClean=false so a plain-dirty worktree no longer aborts
                // removal with merged_cleanup_failed. Branch-ref deletion still keys off
                // mergeConvergence (NOT the force flag), so no merged work can be lost.
                force: true,
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
