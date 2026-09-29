/**
 * DaemonCommandRouter — the single command entry point of the daemon.
 *
 * Every command (dashboard WS/P2P, extension, API, standalone HTTP, local IPC,
 * mesh-internal) runs through {@link DaemonCommandRouter.execute}, which looks
 * the name up in the command registry and dispatches by the spec's family:
 *   - low / med / high → the router family handlers (router-bound context)
 *   - handler / git    → DaemonCommandHandler (route + session pre-checks)
 * and then logs the command, runs the post-chat hooks and emits the
 * dashboard invalidation — once, for every source.
 */

import { DaemonCdpManager } from '../cdp/manager.js';
import { DaemonCommandHandler } from './handler.js';
import { launchIde } from './med-family/ide.js';
import { rearmPersistedDeferredRestarts } from './med-family/mesh-restart.js';
import type { MedFamilyContext } from './med-family/types.js';
import type { HighFamilyContext } from './high-family/types.js';
import type { LowFamilyContext } from './low-family/types.js';
import {
    COMMAND_PREFIX_DEFAULTS,
    CommandRegistry,
    normalizeCommandSource,
    type CommandSource,
    type CommandSpec,
} from './command-registry.js';
import { InteractionContextMap } from './interaction-context.js';
import { DaemonComponentsNotReadyError } from './daemon-components-port.js';
import type { DaemonComponents } from '../boot/daemon-components.js';
import { handlerSpecs, gitSpecs } from './handler-specs.js';
import { sessionHostSpecs } from './low-family/session-host.js';
import { specProviderDevSpecs } from './low-family/spec-providerdev.js';
import { refineConfigSpecs } from './low-family/refine-config.js';
import { diagnosticsSpecs } from './low-family/diagnostics.js';
import { statusMetaSpecs } from './low-family/status-meta.js';
import { coordinatorPromptSpecs } from './low-family/coordinator-prompt.js';
import { notificationSpecs } from './low-family/notification.js';
import { daemonLifecycleSpecs } from './low-family/daemon-lifecycle.js';
import { meshLedgerSpecs } from './low-family/mesh-ledger.js';
import { turnLedgerIpcSpecs } from './low-family/turn-ledger-ipc.js';
import { meshNodeLogsSpecs } from './low-family/mesh-node-logs.js';
import { workerReportSpecs } from './low-family/worker-report.js';
import { workerMailboxSpecs } from './low-family/worker-mailbox.js';
import { workerPeerContextSpecs } from './low-family/worker-peer-context.js';
import { transcriptReplicaSpecs } from './low-family/transcript-replica.js';
import { cliAgentSpecs } from './med-family/cli-agent.js';
import { ideSpecs } from './med-family/ide.js';
import { meshCrudSpecs } from './med-family/mesh-crud.js';
import { meshHostPairingSpecs } from './med-family/mesh-host-pairing.js';
import { meshQueueSpecs } from './med-family/mesh-queue.js';
import { fastForwardSpecs } from './med-family/fast-forward.js';
import { meshRestartSpecs } from './med-family/mesh-restart.js';
import { meshOnboardingSpecs } from './med-family/mesh-onboarding.js';
import { meshWorktreeRetentionSpecs } from './med-family/mesh-worktree-retention.js';
import { meshGraphCommandSpecs } from './med-family/mesh-graph-commands.js';
import { meshGraphGateCommandSpecs } from './med-family/mesh-graph-gate-commands.js';
import { meshEventsSpecs } from './high-family/mesh-events.js';
import { meshCoordinatorLaunchSpecs } from './high-family/mesh-coordinator-launch.js';
import { meshStatusSpecs } from './high-family/mesh-status.js';
import { meshNodeStateSpecs } from './high-family/mesh-node-state.js';
import { meshStatusViewSpecs } from './high-family/mesh-status-view.js';
import { MeshNodeGitStateStore } from '../mesh/mesh-node-git-state.js';
import { MeshNodeGitRefresher } from '../mesh/mesh-node-git-refresher.js';
import { MeshNodeStatePusher } from '../mesh/mesh-node-state-pusher.js';
import { watchWorkspaceGit } from '../mesh/workspace-git-watcher.js';
import { LocalMeshNodeGitWatch } from '../mesh/local-mesh-node-git-watch.js';
import { createFileMeshNodeStatePushPersistence } from '../mesh/mesh-node-state-push-store.js';
import { handshakeMeshMemberDaemon, restoreMemberNodeStatePush, type MeshNodeStateLifecyclePort } from './mesh-node-state-lifecycle.js';
import { collectMemberWorktreeNodes, type MemberWorktreeAdoptionResult, type PersistRemoteWorktreeNodeOutcome } from '../mesh/mesh-remote-worktree-membership.js';
import { randomUUID } from 'crypto';
import { MESH_NODE_STATE_NUDGE_TIMEOUT_MS, nudgeMeshNodeStatePush, readLocalMeshNodeRuntime, subscribeMeshNodeRuntimePush } from './mesh-node-runtime-io.js';
import { getGitRepoStatus } from '../git/git-status.js';
import { DaemonCliManager } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { killIdeProcess, isIdeRunning } from '../launch.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { SessionRegistry } from '../sessions/registry.js';
import type { SessionLifecycleBus } from '../sessions/lifecycle-bus.js';
import { LOG } from '../logging/logger.js';
import { activateKnownMeshTopics } from '../seqscribe/mesh-publisher.js';
import type { PeerHandle } from 'seqscribe';
import type { TranscriptReplicaStore } from '../seqscribe/transcript-replica-store.js';
import { logCommand } from '../logging/command-log.js';
import { createInteractionId, recordDebugTrace } from '../logging/debug-trace.js';
import { buildMeshHostRequiredFailure, resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import type { RepoMeshSessionCleanupMode, RepoMeshSpawnedSessionVisibility } from '../repo-mesh-types.js';
import type { SeqscribeStatusSummary } from '../shared-types.js';

// ─── Extracted-module imports (symbols the dispatch class consumes) ───
import {
    MESH_DIRECT_PROBE_REUSE_MS,
    MeshGitProbeCache,
    persistNodeReporterPlatform,
    recordReportedNodeFacts,
    readObjectRecord,
    readStringValue,
} from '../mesh/mesh-node-identity.js';
import {
    MeshRefineBatchJobHandle,
    MeshRefineBatchTerminalJob,
    MeshRefineJobHandle,
    MeshRefineTerminalJob,
} from '../mesh/mesh-refine-gates.js';
// ─── Refinery job orchestration (bodies extracted from this file) ───
import { startMeshRefineJob } from './router-refine.js';
import { batchRefineMeshNodes, startMeshRefineBatchJob } from './router-refine-batch-jobs.js';
import { resumePendingRefineJobsOnStartup } from './router-refine-resume.js';
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
// ─── Aggregate mesh-status cache (bodies extracted from this file) ───
import {
    getCachedAggregateMeshStatus,
    rememberAggregateMeshStatus,
} from './router-aggregate-status.js';
// ─── Remote mesh-session owner resolution (bodies extracted from this file) ───
import { resolveRemoteMeshSessionOwnerDaemonId } from './router-mesh-session-owner.js';
import { readMeshDirectDispatchFlag, withMeshDirectDispatch } from './command-args.js';
import { evaluateMeshSender, meshSenderRefusalResult, MESH_SENDER_DAEMON_ID_ARG, type MeshSenderGateDeps } from './mesh-sender.js';
import { listMeshHostRecords, readMeshHostRecord, writeMeshHostRecord } from '../mesh/mesh-host-memory.js';
import { unwrapMeshRelayResult } from './mesh-relay-result.js';
import { resolveForwardedEventMeshId } from '../mesh/mesh-event-forwarding.js';
import {
    syncInlineMeshPoliciesFromDisk,
    getCachedInlineMeshNodes,
    getCachedInlineMeshNodesWithVisibility,
    getCachedInlineMesh,
    getMeshForCommand,
    updateInlineMeshNode,
    removeInlineMeshNode,
    markWorktreeBootstrapTerminalState,
    seedRemoteClonedWorktreeNode,
    persistRemoteClonedWorktreeNode,
    adoptMemberWorktreeNodes,
    tombstoneRemovedMeshNode,
} from './router-inline-mesh-roster.js';

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
    /**
     * A PTY snapshot for `sessionId` (optionally only the tail since `sinceSeq`),
     * over the same session-host request transport as the other methods
     * (wire type `get_snapshot`, already a supported SessionHostRequestType in
     * @adhdev/session-host-core — see session-host-transport.ts's inline use of
     * the raw client for the identical request shape).
     *
     * Implemented by `session-host/session-host-controller.ts`'s
     * `SessionHostController` (wrapping @adhdev/session-host-core's
     * `createSessionHostControlPlane`, wiring-unification B residue cleanup
     * deliverable 7). Stays optional here — rather than promoted to a required
     * member — so any other structural implementer of this LOCAL interface
     * (e.g. a lightweight test stub that doesn't need PTY snapshots) keeps
     * compiling without adding a no-op. The low-family spec in
     * session-host.ts checks for the method's presence and returns a clear
     * "unavailable" error if it is ever missing, matching every other
     * `!ctx.deps.sessionHostControl` guard there.
     */
    getSnapshot?(sessionId: string, sinceSeq?: number): Promise<{ seq: number; text: string; truncated: boolean; cols?: number; rows?: number } | null>;
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
    /**
     * Session lifecycle bus. The router emits one `command_executed` after
     * EVERY executed command (any source, success or not; not when the command
     * throws). Hosts flush the invalidated dashboard topics from that event —
     * the router is the only place that decides which topics a command
     * invalidates. Without a bus nothing is emitted.
     */
    bus?: SessionLifecycleBus | null;
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
    /**
     * Coordinator-held node git state store. Boot passes one persisted in
     * mesh-runtime.db so a restart still answers with the last-known state;
     * absent (tests, embedders) → an in-memory store.
     */
    meshNodeGitStateStore?: MeshNodeGitStateStore;
    /**
     * Refresh THIS daemon's own coordinator mirror (adhdev-daemon meshOwnedSessions) for a
     * self-hosted mesh session, applying the same `mesh_forward_event`-shaped payload the remote
     * relay would carry — used by the SELF-DIAL branch of set_conversation_prefs so a locally
     * coordinated session (coordinatorDaemonId == this daemon) updates its mirror directly instead
     * of dispatching a P2P command to its own id (which the mesh manager refuses as SELF_DIAL).
     * Injected by the cloud runtime (calls updateMeshOwnedSession + flushes the dashboard
     * subscription); absent in standalone (no coordinator mirror there).
     */
    updateLocalMeshOwnedSession?: (payload: Record<string, unknown>) => void;
    /**
     * Live seqscribe replication health, for the `get_status_metadata` read
     * surface. Same aggregate-only summary the status report carries
     * (seqscribe/stats.ts) — counters, booleans and bucket ordinals, never a
     * topic name, a peer id or anything derived from an entry payload.
     *
     * It is a GETTER rather than a value because the router is constructed
     * before the seqscribe node opens (daemon-lifecycle steps 9 vs 10a), and
     * because the numbers must be read at call time, not at wiring time.
     * Absent (or returning null) when replication is unavailable.
     */
    getSeqscribeStats?: () => SeqscribeStatusSummary | null;
    /**
     * §8 unit 3 ("dynamic transcript activation + daemon replica store") — the
     * `ensure_transcript_subscription`/`read_transcript_replica` daemon-local
     * commands' data source (low-family/transcript-replica.ts). A getter for
     * the same reason as `getSeqscribeStats`: the store is constructed after
     * the seqscribe node opens, which happens after the router does. Null when
     * the node failed to open.
     */
    getTranscriptReplicaStore?: () => TranscriptReplicaStore | null;
    /**
     * Resolve a live `PeerHandle` for a remote daemon's seqscribe channel, so
     * `ensure_transcript_subscription` can attach a SUB to the session owner's
     * connection. ★NOT WIRED in §8 unit 3 — no caller currently supplies this;
     * the peer connection lives in the cloud/standalone TRANSPORT layer
     * (`packages/daemon-cloud`, `oss/packages/daemon-standalone`), which
     * daemon-core does not reach into. Absent (undefined) means the command
     * answers `ipc_unavailable` rather than silently no-op-ing — see the
     * handler for the reasoning. A later unit wires this from whichever
     * daemon owns the peer map.
     */
    resolveTranscriptPeer?: (ownerDaemonId: string) => Promise<PeerHandle | null> | PeerHandle | null;
}

export interface CommandRouterResult {
    success: boolean;
    [key: string]: unknown;
}

let daemonCommandRegistry: CommandRegistry | undefined;

/**
 * The daemon's command registry. Built on first use: the family modules sit
 * in an import cycle with this file, so their spec arrays are only complete
 * once module evaluation has finished.
 */
export function getDaemonCommandRegistry(): CommandRegistry {
    if (!daemonCommandRegistry) {
        daemonCommandRegistry = CommandRegistry.build([
            ...sessionHostSpecs,
            ...specProviderDevSpecs,
            ...refineConfigSpecs,
            ...diagnosticsSpecs,
            ...statusMetaSpecs,
            ...coordinatorPromptSpecs,
            ...notificationSpecs,
            ...daemonLifecycleSpecs,
            ...meshLedgerSpecs,
            ...turnLedgerIpcSpecs,
            ...meshNodeLogsSpecs,
            ...workerReportSpecs,
            ...workerMailboxSpecs,
            ...workerPeerContextSpecs,
            ...transcriptReplicaSpecs,
            ...cliAgentSpecs,
            ...ideSpecs,
            ...meshCrudSpecs,
            ...meshHostPairingSpecs,
            ...meshQueueSpecs,
            ...fastForwardSpecs,
            ...meshRestartSpecs,
            ...meshOnboardingSpecs,
            ...meshWorktreeRetentionSpecs,
            ...meshGraphCommandSpecs,
            ...meshGraphGateCommandSpecs,
            ...meshEventsSpecs,
            ...meshCoordinatorLaunchSpecs,
            ...meshStatusSpecs,
            ...meshNodeStateSpecs,
            ...meshStatusViewSpecs,
            ...handlerSpecs,
            ...gitSpecs,
        ], COMMAND_PREFIX_DEFAULTS);
    }
    return daemonCommandRegistry;
}

/** `sessionId` is accepted as an alias for `targetSessionId` on specs that opt in. */
function applySessionIdAlias(args: Record<string, unknown>): void {
    if (typeof args.targetSessionId !== 'string' && typeof args.sessionId === 'string' && args.sessionId.trim()) {
        args.targetSessionId = args.sessionId.trim();
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
 * Read only the established mesh-scope envelope fields carried by daemon
 * commands. This is intentionally not a recursive payload scan: authored task
 * content must never become a topic name. Every accepted value is already a
 * status/P2P mesh identifier class (`meshId`, `meshContext.meshId`, an inline
 * mesh record id, or a launched session's `settings.meshNodeFor`).
 */
function meshIdsRevealedByCommandArgs(args: unknown): string[] {
    const root = readObjectRecord(args);
    const meshContext = readObjectRecord(root.meshContext);
    const inlineMesh = readObjectRecord(root.inlineMesh);
    const settings = readObjectRecord(root.settings);
    const ids = [
        readStringValue(root.meshId),
        readStringValue(root.meshNodeFor),
        readStringValue(meshContext.meshId),
        readStringValue(inlineMesh.id),
        readStringValue(settings.meshNodeFor),
    ].filter((value): value is string => value !== undefined);
    return [...new Set(ids)];
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
    inlineMeshCache = new Map<string, any>();
    /** Tombstones for inline mesh nodes removed via remove_mesh_node, keyed by
     *  meshId → set of removed nodeIds. The dashboard keeps echoing the removed
     *  node in the inlineMesh it attaches to every command; without a tombstone,
     *  reconcileInlineMeshCache MERGEs it straight back (resurrection). A
     *  tombstoned node is skipped during reconcile only while its workspace is
     *  absent from disk — a genuine re-registration (same nodeId, workspace back
     *  on disk) clears the tombstone and merges normally, preserving clone
     *  worktree visibility and legitimate node re-creation. */
    removedInlineMeshNodeIds = new Map<string, Set<string>>();
    /** Coordinator-owned whole-mesh aggregate status snapshots. Browser callers read this by default.
     *  Public (not private) so the extracted ./router-aggregate-status.ts orchestration can reach it via `self`. */
    aggregateMeshStatusCache = new Map<string, { builtAt: number; snapshot: any; queueRevision: string }>();
    /**
     * meshes.json policy resync state (see syncInlineMeshPoliciesFromDisk).
     * checkedAtMs throttles the stat; mtimeMs/size are the last-seen file
     * identity. -1 = no baseline recorded yet: the first check RECORDS the
     * baseline without applying, so a stale local file mirror can never
     * regress a fresher inline (cloud-coordinator) policy — only edits made
     * while this daemon is alive and watching are pulled into memory.
     */
    meshPolicyDiskSync = { checkedAtMs: 0, mtimeMs: -1, size: -1 };
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
    /**
     * DS2: in-process refinement leases keyed by `${repoRoot}::${baseBranch}`. Serialize
     * the base-mutating window (candidate-SHA pin → merge → push) of concurrent single-node
     * refines that target the SAME base branch in the same repo, so two refines cannot both
     * validate against one baseHead and then race their merges (the base-movement race). The
     * batch path is already sequential, so this only matters for overlapping single-node
     * async jobs. Value = the meshId:nodeId job key holding the lease (for diagnostics).
     */
    refineBaseLeases = new Map<string, string>();

    /** Recent interaction ids per target session (bounded). */
    readonly interactionContext = new InteractionContextMap();

    /**
     * The daemon's finished `DaemonComponents`, late-bound by boot S7
     * (`boot/stages/mesh-runtime.ts`). The router is built in S5, before the
     * components (and their turn ledger) exist — see ./daemon-components-port.ts.
     */
    private attachedComponents: DaemonComponents | null = null;

    /** Coordinator-held last-known git state per mesh node (see mesh/mesh-node-git-state.ts). */
    readonly meshNodeGitState: MeshNodeGitStateStore;
    /** Coordinator background freshness probes — never awaited by mesh_status. */
    readonly meshNodeGitRefresher: MeshNodeGitRefresher;
    /** Member side: pushes this daemon's node git state to the coordinators that probed it. */
    readonly meshNodeStatePusher: MeshNodeStatePusher;
    /** Coordinator side: a terminal commit in a checkout this daemon reads itself flushes that mesh's view. */
    readonly localMeshNodeGitWatch: LocalMeshNodeGitWatch;
    /**
     * Per-process id of this daemon. Returned on every member push ack (a member
     * that sees it change knows the coordinator restarted and re-reports the
     * worktree nodes it owns once — member worktree reconciliation), and carried
     * as `daemonBootId` in this daemon's own runtime summary (a coordinator that
     * sees it change knows this member restarted).
     */
    readonly meshCoordinatorBootId: string = randomUUID();
    private meshNodeStatePushRestore: Promise<number> | null = null;

    constructor(deps: CommandRouterDeps) {
        this.deps = deps;
        this.meshNodeGitState = deps.meshNodeGitStateStore ?? new MeshNodeGitStateStore();
        this.meshNodeGitRefresher = new MeshNodeGitRefresher({
            store: this.meshNodeGitState,
            onSettled: (meshId) => this.invalidateAggregateMeshStatus(meshId),
            // The ONLY coordinator→member node-state message: "push now" (subscribing when needed).
            nudge: (target) => nudgeMeshNodeStatePush(this.deps.dispatchMeshCommand, target, MESH_NODE_STATE_NUDGE_TIMEOUT_MS),
        });
        this.meshNodeStatePusher = new MeshNodeStatePusher({
            dispatch: deps.dispatchMeshCommand,
            readGit: (workspace, opts) => getGitRepoStatus(workspace, { refreshUpstream: opts.refreshUpstream }) as unknown as Promise<Record<string, unknown> | null>,
            readRuntime: async () => readLocalMeshNodeRuntime(this.deps, this.meshCoordinatorBootId),
            // The subscription set survives a restart, so the new process pushes at once.
            persistence: createFileMeshNodeStatePushPersistence(),
            // A commit / checkout / `git add` from a terminal is pushed within ~1 s
            // (git-dir change detector; no git spawned on the tick when nothing moved).
            watchGit: (workspace, onChange, onError) => watchWorkspaceGit(workspace, onChange, { onError }),
            // Worktree nodes this daemon owns on the mesh (inline view ∪ config), reported
            // once per coordinator boot so the coordinator can adopt any it lost.
            readWorktreeNodes: async (meshId) => {
                const nodes: unknown[] = [];
                const cached = this.inlineMeshCache.get(meshId);
                if (Array.isArray(cached?.nodes)) nodes.push(...cached.nodes);
                try {
                    const { getMesh } = await import('../config/mesh-config.js');
                    const local = getMesh(meshId);
                    if (local) nodes.push(...local.nodes);
                } catch { /* no config twin */ }
                return collectMemberWorktreeNodes(nodes, this.deps.statusInstanceId);
            },
        });
        // Session lifecycle facts wake the (debounced) runtime push to subscribed coordinators.
        subscribeMeshNodeRuntimePush(deps.bus, this.meshNodeStatePusher);
        this.localMeshNodeGitWatch = new LocalMeshNodeGitWatch({
            watch: (workspace, onChange, onError) => watchWorkspaceGit(workspace, onChange, { onError }),
            onChange: (meshId) => this.invalidateAggregateMeshStatus(meshId),
        });
    }

    /** Config self-heal (platform / nickname / versions / facts) from a member-pushed facts bundle. */
    private async selfHealNodeFromFacts(meshId: string, nodeId: string, nodeFacts: unknown): Promise<void> {
        try {
            const record = await this.getMeshForCommand(meshId, undefined, { preferInline: true });
            const node = record?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            if (!record || !node) return;
            const reporter = recordReportedNodeFacts(node, nodeFacts);
            if (reporter) persistNodeReporterPlatform(record.source, record.mesh, nodeId, reporter);
        } catch { /* best-effort */ }
    }

    /** S7 attaches the completed components once. They must be the ones this router belongs to. */
    attachComponents(components: DaemonComponents): void {
        if (components.router !== this) {
            throw new Error('attachComponents: components.router is not this router');
        }
        this.attachedComponents = components;
    }

    /**
     * The attached components, or null inside the boot window — ONLY for callers
     * that have a complete non-components fallback (the refine jobs' notice queue).
     * Everything else uses `requireComponents` / `ctx.components()`.
     */
    attachedComponentsOrNull(): DaemonComponents | null {
        return this.attachedComponents;
    }

    /** The real `DaemonComponents`; throws `DaemonComponentsNotReadyError` inside the boot window. */
    requireComponents(what = 'command'): DaemonComponents {
        if (!this.attachedComponents) throw new DaemonComponentsNotReadyError(what);
        return this.attachedComponents;
    }

    // ─── Aggregate mesh-status cache ────────────────────────────────────
    // Implementation lives in ./router-aggregate-status.ts (behavior-preserving
    // code move). Kept here as thin delegators: getCachedAggregateMeshStatus /
    // rememberAggregateMeshStatus are bound into HighFamilyContext, so callers
    // reach these via `self.` for correct instance dispatch.

    private getCachedAggregateMeshStatus(
        meshId: string,
        mesh?: any,
        options?: { requireDirectPeerTruth?: boolean; allowStalePending?: boolean; nodesOnly?: boolean },
    ): any | null {
        return getCachedAggregateMeshStatus(this, meshId, mesh, options);
    }

    private rememberAggregateMeshStatus(meshId: string, snapshot: any, refreshReason: string): any {
        return rememberAggregateMeshStatus(this, meshId, snapshot, refreshReason);
    }
    private syncInlineMeshPoliciesFromDisk(): void { syncInlineMeshPoliciesFromDisk(this); }

    public getCachedInlineMeshNodes(): any[] { return getCachedInlineMeshNodes(this); }
    public getCachedInlineMeshNodesWithVisibility(): Array<{ node: any; spawnedSessionVisibility: RepoMeshSpawnedSessionVisibility }> { return getCachedInlineMeshNodesWithVisibility(this); }

    // ─── Remote mesh-session owner resolution ───────────────────────────
    // Implementation lives in ./router-mesh-session-owner.ts (behavior-preserving
    // code move). resolveRemoteMeshSessionOwnerDaemonId stays public (the [Z]
    // session-scoped forward in forwardToOwningDaemon and a unit test call it), so
    // it's kept here as a thin delegator.

    public resolveRemoteMeshSessionOwnerDaemonId(sessionId: string, ownerNodeIdHint?: string): string | undefined {
        return resolveRemoteMeshSessionOwnerDaemonId(this, sessionId, ownerNodeIdHint);
    }
    public getCachedInlineMesh(meshId: string, inlineMesh?: unknown): any | undefined { return getCachedInlineMesh(this, meshId, inlineMesh); }
    getMeshForCommand(meshId: string, inlineMesh?: unknown, options?: { preferInline?: boolean }): Promise<{ mesh: any; inline: boolean; source: 'inline_cache' | 'inline_bootstrap' | 'local_config' } | null> { return getMeshForCommand(this, meshId, inlineMesh, options); }

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
     * the router ('launch_ide').
     */
    private buildMedFamilyContext(): MedFamilyContext {
        const ctx: MedFamilyContext = {
            deps: this.deps,
            components: () => this.requireComponents('med-family command'),
            getMeshForCommand: this.getMeshForCommand.bind(this),
            getCachedInlineMesh: this.getCachedInlineMesh.bind(this),
            markWorktreeBootstrapTerminalState: this.markWorktreeBootstrapTerminalState.bind(this),
            requireMeshHostMutationOwner: this.requireMeshHostMutationOwner.bind(this),
            invalidateAggregateMeshStatus: this.invalidateAggregateMeshStatus.bind(this),
            updateInlineMeshNode: this.updateInlineMeshNode.bind(this),
            seedRemoteClonedWorktreeNode: this.seedRemoteClonedWorktreeNode.bind(this),
            persistRemoteClonedWorktreeNode: this.persistRemoteClonedWorktreeNode.bind(this),
            noteMeshMemberRestarting: this.noteMeshMemberRestarting.bind(this),
            removeInlineMeshNode: this.removeInlineMeshNode.bind(this),
            tombstoneRemovedMeshNode: this.tombstoneRemovedMeshNode.bind(this),
            normalizeMeshSessionCleanupMode: this.normalizeMeshSessionCleanupMode.bind(this),
            cleanupMeshSessions: this.cleanupMeshSessions.bind(this),
            cleanupLocalWorktreeNode: this.cleanupLocalWorktreeNode.bind(this),
            precheckLocalWorktreeRemovable: this.precheckLocalWorktreeRemovable.bind(this),
            getWorktreeForceCleanupConvergence: this.getWorktreeForceCleanupConvergence.bind(this),
            startMeshRefineJob: this.startMeshRefineJob.bind(this),
            batchRefineMeshNodes: this.batchRefineMeshNodes.bind(this),
            startMeshRefineBatchJob: this.startMeshRefineBatchJob.bind(this),
            stopIde: this.stopIde.bind(this),
            launchIde: (args: any) => launchIde(ctx, args),
            inlineMeshCache: this.inlineMeshCache,
            meshGitProbeCache: this.meshGitProbeCache,
            meshNodeGitState: this.meshNodeGitState,
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
            components: () => this.requireComponents('high-family command'),
            getMeshForCommand: this.getMeshForCommand.bind(this),
            getCachedAggregateMeshStatus: this.getCachedAggregateMeshStatus.bind(this),
            rememberAggregateMeshStatus: this.rememberAggregateMeshStatus.bind(this),
            execute: this.execute.bind(this),
            markWorktreeBootstrapTerminalState: this.markWorktreeBootstrapTerminalState.bind(this),
            getCachedInlineMesh: this.getCachedInlineMesh.bind(this),
            aggregateMeshStatusCache: this.aggregateMeshStatusCache,
            swrRefreshInFlight: this.swrRefreshInFlight,
            runningRefineJobs: this.runningRefineJobs,
            inlineMeshCache: this.inlineMeshCache,
            meshGitProbeCache: this.meshGitProbeCache,
            meshNodeGitState: this.meshNodeGitState,
            meshNodeGitRefresher: this.meshNodeGitRefresher,
            meshNodeStatePusher: this.meshNodeStatePusher,
            localMeshNodeGitWatch: this.localMeshNodeGitWatch,
            meshCoordinatorBootId: this.meshCoordinatorBootId,
            adoptMemberWorktreeNodes: this.adoptMemberWorktreeNodes.bind(this),
            selfHealNodeFromFacts: (meshId, nodeId, nodeFacts) => { void this.selfHealNodeFromFacts(meshId, nodeId, nodeFacts); },
            invalidateAggregateMeshStatus: this.invalidateAggregateMeshStatus.bind(this),
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
    updateInlineMeshNode(meshId: string, mesh: any, node: any): void { updateInlineMeshNode(this, meshId, mesh, node); }
    removeInlineMeshNode(meshId: string, mesh: any, nodeId: string): boolean { return removeInlineMeshNode(this, meshId, mesh, nodeId); }
    public markWorktreeBootstrapTerminalState(meshId: string, nodeId: string, status: 'complete' | 'failed', opts?: { workspace?: string; daemonId?: string; machineId?: string }): void { markWorktreeBootstrapTerminalState(this, meshId, nodeId, status, opts); }
    public seedRemoteClonedWorktreeNode(meshId: string, node: any): boolean { return seedRemoteClonedWorktreeNode(this, meshId, node); }
    public persistRemoteClonedWorktreeNode(meshId: string, node: any): Promise<PersistRemoteWorktreeNodeOutcome | 'tombstoned'> { return persistRemoteClonedWorktreeNode(this, meshId, node); }
    public adoptMemberWorktreeNodes(meshId: string, input: { reported: unknown; senderDaemonId: string; ownerDaemonId: string }): Promise<MemberWorktreeAdoptionResult> { return adoptMemberWorktreeNodes(this, meshId, input); }
    public tombstoneRemovedMeshNode(meshId: string, nodeId: string): void { tombstoneRemovedMeshNode(this, meshId, nodeId); }

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
     * Execute one command.
     *
     * Pipeline: interaction id → mesh-topic reveal → spec lookup (unknown →
     * `Unknown command`) → `sources` check → `sessionId` alias → forward to the
     * owning remote daemon (`forwardToOwner`) → run → command log → post-chat
     * hooks → {@link CommandRouterDeps.onCommandExecuted}.
     *
     * @param cmd Command name
     * @param args Command arguments
     * @param source Where the command entered (`ws` | `p2p` | `ext` | `api` |
     *   `standalone` | `ipc` | `mesh` | `internal`); any other string is logged
     *   as `unknown`. Defaults to `internal` (an in-process re-entry).
     * @param opts.peerId Transport peer identifier for src:'p2p' commands (the
     *   DataChannel connection id) — recorded in the command audit log so a P2P
     *   command is attributable to a specific connected peer, not just "p2p".
     *   Identifier only; never a username/email.
     * @param opts.inProcess This daemon's own mesh machinery calling itself with
     *   source `mesh` (local queue dispatch, local auto-launch, coordinator
     *   launch). Skips the mesh sender gate — there is no remote sender. Only an
     *   in-process caller of the router can set it: the host runtime's
     *   transport entry (`DaemonHostRuntime.execute`) does not carry it.
     */
    async execute(cmd: string, args: any, source: string = 'internal', opts?: { peerId?: string; inProcess?: boolean }): Promise<CommandRouterResult> {
        const cmdStart = Date.now();
        const logSource = normalizeCommandSource(source);
        const peerId = typeof opts?.peerId === 'string' && opts.peerId.length > 0 ? opts.peerId : undefined;
        const spec = getDaemonCommandRegistry().get(cmd);
        const normalizedArgs = normalizeCommandArgsWithInteractionId(args);
        // Only the mesh transport may present a sender identity: drop the
        // router-internal sender arg from every other source (and from an
        // in-process mesh call, which has no remote sender).
        const meshRelayed = logSource === 'mesh' && opts?.inProcess !== true;
        if (!meshRelayed && MESH_SENDER_DAEMON_ID_ARG in normalizedArgs) delete normalizedArgs[MESH_SENDER_DAEMON_ID_ARG];
        if (spec?.session?.aliasSessionId) applySessionIdAlias(normalizedArgs);
        const interactionId = this.interactionContext.record(normalizedArgs);

        // REMOTE-MESH-TOPIC-DISCOVERY: meshes.json is machine-local and is
        // normally populated only on the coordinator. A remote daemon therefore
        // learns its mesh scope from the P2P command/task envelopes above. Arm
        // both per-mesh topics as soon as that existing identifier arrives; the
        // seqscribe activation hook re-advertises grants on live peer sessions.
        const revealedMeshIds = meshIdsRevealedByCommandArgs(normalizedArgs);
        if (revealedMeshIds.length > 0) {
            const activated = activateKnownMeshTopics(revealedMeshIds);
            if (activated > 0) {
                LOG.info(
                    'Seqscribe',
                    `activated ${activated} mesh topic scope(s) from runtime command ${cmd}`,
                );
            }
        }

        recordDebugTrace({
            interactionId,
            category: 'command',
            stage: 'received',
            level: 'info',
            payload: { cmd, source: logSource },
        });

        try {
            let result: CommandRouterResult;
            let ranLocally = false;
            const meshRefusal = spec && meshRelayed && (!spec.sources || spec.sources.includes(logSource as CommandSource))
                ? await this.gateMeshSender(cmd, spec, normalizedArgs)
                : null;
            if (!spec) {
                result = await this.deps.commandHandler.rejectUnknown(cmd, normalizedArgs);
            } else if (spec.sources && !spec.sources.includes(logSource as CommandSource)) {
                result = {
                    success: false,
                    error: `Command '${cmd}' is not accepted from source '${logSource}'`,
                    code: 'COMMAND_SOURCE_REJECTED',
                };
            } else if (meshRefusal) {
                result = meshRefusal;
            } else {
                const forwarded = spec.forwardToOwner ? await this.forwardToOwningDaemon(cmd, normalizedArgs) : null;
                if (forwarded) {
                    result = forwarded;
                } else {
                    result = await this.runSpec(spec, normalizedArgs);
                    ranLocally = true;
                }
            }
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, peerId, interactionId, args: normalizedArgs, success: result.success, durationMs: Date.now() - cmdStart });
            recordDebugTrace({
                interactionId,
                category: 'command',
                stage: 'completed',
                level: result.success ? 'info' : 'warn',
                payload: { cmd, source: logSource, success: result.success, durationMs: Date.now() - cmdStart },
            });

            // Post-chat hooks — only when the command ran here (a forwarded
            // command runs them on the owning daemon).
            const postChat = ranLocally && spec?.postChat === true;
            if (postChat) {
                // The §8 unit 3 transcript "post-chat" dirty trigger is a bus
                // subscriber on the `command_executed{postChat}` emitted below
                // (seqscribe/transcript-bus-subscriber.ts, wiring-unification B4).
                this.deps.onPostChatCommand?.();
            }

            const targetSessionId = typeof normalizedArgs.targetSessionId === 'string' && normalizedArgs.targetSessionId.trim()
                ? normalizedArgs.targetSessionId.trim()
                : undefined;
            this.deps.bus?.emit({
                kind: 'command_executed',
                at: Date.now(),
                command: cmd,
                source: logSource,
                ...(targetSessionId ? { sessionId: targetSessionId } : {}),
                success: result.success === true,
                // Spec invalidations, or the prefix rules for an unknown name.
                invalidates: getDaemonCommandRegistry().invalidationsFor(cmd),
                // A successful fastFlush command: the host pushes status now and
                // skips its own daemon.metadata topic flush.
                fastFlush: spec?.fastFlush === true && result.success === true,
                postChat,
                interactionId: interactionId ?? '',
            });
            return result;
        } catch (e: any) {
            logCommand({ ts: new Date().toISOString(), cmd, source: logSource, peerId, interactionId, args: normalizedArgs, success: false, error: e.message, durationMs: Date.now() - cmdStart });
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

    /**
     * The mesh sender gate (commands/mesh-sender.ts): a command relayed from
     * another daemon runs only when its transport-stamped sender satisfies the
     * spec's `meshSender` class. Returns the refusal result (+ one WARN line),
     * or null to proceed.
     */
    private async gateMeshSender(cmd: string, spec: CommandSpec, args: Record<string, unknown>): Promise<CommandRouterResult | null> {
        const verdict = await evaluateMeshSender(spec.meshSender, args, this.meshSenderGateDeps());
        return verdict.ok ? null : meshSenderRefusalResult(cmd, verdict);
    }

    private meshSenderGateDeps(): MeshSenderGateDeps {
        const instanceManager = this.deps.instanceManager;
        const settingsOf = (sessionId: string): Record<string, unknown> | null => {
            try {
                const instance: any = instanceManager?.getInstance?.(sessionId);
                if (!instance) return null;
                const settings = instance.getState?.()?.settings;
                return settings && typeof settings === 'object' ? settings as Record<string, unknown> : {};
            } catch {
                return null;
            }
        };
        return {
            selfDaemonId: typeof this.deps.statusInstanceId === 'string' ? this.deps.statusInstanceId : undefined,
            // The LOCAL view only — never warmed from the command's own inlineMesh.
            getLocalMesh: async (meshId) => (await this.getMeshForCommand(meshId, undefined, { preferInline: true }))?.mesh ?? null,
            listLocalMeshes: async () => {
                this.syncInlineMeshPoliciesFromDisk();
                const byId = new Map<string, any>();
                for (const [meshId, mesh] of this.inlineMeshCache) byId.set(meshId, mesh);
                try {
                    const { listMeshesReadOnly } = await import('../config/mesh-config.js');
                    for (const mesh of listMeshesReadOnly()) if (mesh?.id && !byId.has(mesh.id)) byId.set(mesh.id, mesh);
                } catch { /* no local config */ }
                return [...byId.values()];
            },
            getSessionSettings: settingsOf,
            listSessionSettings: () => {
                let ids: string[] = [];
                try { ids = instanceManager?.listInstanceIds?.() ?? []; } catch { ids = []; }
                const out: Array<{ sessionId: string; settings: Record<string, unknown> }> = [];
                for (const sessionId of ids) {
                    const settings = settingsOf(sessionId);
                    if (settings) out.push({ sessionId, settings });
                }
                return out;
            },
            resolveForwardEventMeshId: (payload) => resolveForwardedEventMeshId(payload),
            // Per-mesh host record (pairing / learned) — the roster-less worker
            // daemon's restart-surviving evidence of who hosts a mesh.
            getMeshHostRecord: (meshId) => readMeshHostRecord(meshId),
            listMeshHostRecords: () => listMeshHostRecords(),
            recordMeshHost: (meshId, hostDaemonId, source) => writeMeshHostRecord(meshId, hostDaemonId, source),
        };
    }

    /** Run a spec in the context its family needs. */
    private async runSpec(spec: CommandSpec, args: Record<string, unknown>): Promise<CommandRouterResult> {
        switch (spec.family) {
            case 'low': {
                const ctx: LowFamilyContext = {
                    deps: this.deps,
                    components: () => this.requireComponents('low-family command'),
                    getMeshForCommand: this.getMeshForCommand.bind(this),
                };
                return (spec as CommandSpec<'low'>).run(ctx, args);
            }
            case 'med':
                return (spec as CommandSpec<'med'>).run(this.buildMedFamilyContext(), args);
            case 'high':
                return (spec as CommandSpec<'high'>).run(this.buildHighFamilyContext(), args);
            case 'handler':
            case 'git':
                return this.deps.commandHandler.handleSpec(spec, args);
        }
    }

    // ─── Refinery job orchestration ─────────────────────────────────────
    // Implementation lives in ./router-refine.ts (behavior-preserving code move).
    // Only the externally-referenced entry points remain here as thin delegators.

    async resumePendingRefineJobsOnStartup(): Promise<void> {
        return resumePendingRefineJobsOnStartup(this);
    }

    private meshNodeStateLifecyclePort(): MeshNodeStateLifecyclePort {
        return {
            selfDaemonId: typeof this.deps.statusInstanceId === 'string' ? this.deps.statusInstanceId : undefined,
            store: this.meshNodeGitState,
            refresher: this.meshNodeGitRefresher,
            pusher: this.meshNodeStatePusher,
            listKnownMeshes: async () => {
                const byId = new Map<string, any>();
                for (const [meshId, mesh] of this.inlineMeshCache) byId.set(meshId, mesh);
                try {
                    const { listMeshesReadOnly } = await import('../config/mesh-config.js');
                    for (const mesh of listMeshesReadOnly()) if (mesh?.id && !byId.has(mesh.id)) byId.set(mesh.id, mesh);
                } catch { /* no local config */ }
                return [...byId.values()];
            },
            listMeshHostRecords: () => listMeshHostRecords(),
        };
    }

    /**
     * Boot (member side): restore this daemon's node-state push subscriptions
     * (persisted set + memberships derived from mesh host records). Idempotent.
     * The pushes themselves go out on noteMeshTransportReady / a peer open, or
     * on the pusher's next check tick when the host wires neither.
     */
    resumeMeshNodeStatePushOnStartup(): Promise<number> {
        if (!this.meshNodeStatePushRestore) {
            this.meshNodeStatePushRestore = restoreMemberNodeStatePush(this.meshNodeStateLifecyclePort()).catch(() => 0);
        }
        return this.meshNodeStatePushRestore;
    }

    /** Host wiring: the mesh transport is up — push restored subscriptions now. */
    noteMeshTransportReady(): void {
        void this.resumeMeshNodeStatePushOnStartup().then(() => { this.meshNodeStatePusher.pushNow(); });
    }

    /**
     * Host wiring: the mesh link to peer daemon `daemonId` opened (first connect
     * or reconnect). Member side: push to it if it coordinates any of our nodes.
     * Coordinator side: handshake the nodes it serves — a restarted member lost
     * its push subscription, so do not wait for its held state to go stale.
     */
    noteMeshPeerOpened(daemonId: string): void {
        if (typeof daemonId !== 'string' || !daemonId.trim()) return;
        void this.resumeMeshNodeStatePushOnStartup().then(() => { this.meshNodeStatePusher.pushNow(daemonId); });
        void handshakeMeshMemberDaemon(this.meshNodeStateLifecyclePort(), daemonId, 'reconnect').catch(() => 0);
    }

    /**
     * This coordinator is restarting / upgrading member daemon `daemonId`
     * (restart_daemon_node forwarded to it): its held build is pending until the
     * new process reports.
     */
    noteMeshMemberRestarting(daemonId: string): Promise<number> {
        return handshakeMeshMemberDaemon(this.meshNodeStateLifecyclePort(), daemonId, 'restart').catch(() => 0);
    }

    /**
     * Boot path for restart_daemon_node whenIdle schedules: re-arm every
     * persisted, unexpired record this daemon owns (and audit/drop the expired
     * ones) so a scheduled restart survives the daemon restart itself.
     */
    resumeDeferredRestartsOnStartup(): void {
        rearmPersistedDeferredRestarts(this.deps);
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

    // ─── Remote mesh worker session-scoped command forward ───────────────────

    /**
     * [Z] Forward a `forwardToOwner` command to the daemon owning its target session.
     *
     * Session-scoped commands issued from the dashboard (the controlbar Model/Mode
     * selectors → invoke_provider_script, and modal approval → resolve_action, plus the
     * direct set_mode/change_model/set_thought_level mutations) target a session by
     * targetSessionId. agent_command (send_chat / clear_history / stop) is included for the
     * same reason: a command naming a session must reach THAT session, never a different
     * local one. When that session is a mesh worker hosted on a REMOTE daemon, this
     * coordinator never holds its live instance, so the CommandHandler delegation would
     * fail with "Live session not found" — or, for agent_command, findAdapter would have
     * fuzzy-injected the message into the coordinator's own CLI session (TASKECHO). Forward
     * to the owning worker daemon — the same daemon that already executes send_chat for that
     * session — so the command acts on the real worker. _meshDirectDispatch prevents
     * re-forwarding once the call lands on the owning daemon (it then handles the session
     * locally), and pins a local mesh dispatch to local execution. A locally-hosted worker
     * (or any session this coordinator owns) resolves to undefined below and runs locally.
     *
     * Returns null when the command should run locally.
     */
    private async forwardToOwningDaemon(cmd: string, args: Record<string, unknown>): Promise<CommandRouterResult | null> {
        if (!this.deps.dispatchMeshCommand || readMeshDirectDispatchFlag(args)) return null;
        const targetSessionId = readStringValue(args?.targetSessionId, args?.sessionId, args?.instanceId);
        if (!targetSessionId) return null;
        const localInstance = this.deps.instanceManager?.getInstance(targetSessionId);
        const localRegistry = this.deps.sessionRegistry?.get?.(targetSessionId);
        if (localInstance || localRegistry) return null;
        // CANCEL-STOP-RELAY: pass the authoritative owning nodeId (when the caller
        // shipped one in meshContext, e.g. mesh_queue_cancel's assignedNodeId) as the
        // deterministic owner-resolution fallback. The session-id cache scan stays the
        // primary path; the hint only kicks in when that scan misses (worktree-clone
        // worker session not yet in / form-mismatched against the cached snapshot).
        const meshContext = readObjectRecord(args?.meshContext);
        const ownerNodeIdHint = readStringValue(meshContext.nodeId);
        const ownerDaemonId = this.resolveRemoteMeshSessionOwnerDaemonId(targetSessionId, ownerNodeIdHint);
        if (!ownerDaemonId) return null;
        LOG.info('Mesh', `[Mesh] Forwarding session-scoped '${cmd}' for remote worker session ${targetSessionId.split('_')[0]} → daemon ${ownerDaemonId.slice(0, 12)}`);
        const forwarded = await this.deps.dispatchMeshCommand(ownerDaemonId, cmd, withMeshDirectDispatch(args));
        return unwrapMeshRelayResult(forwarded, { command: cmd, peerDaemonId: ownerDaemonId });
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
                this.deps.sessionRegistry.terminateByManagerKey(key, 'ide_stopped');
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
