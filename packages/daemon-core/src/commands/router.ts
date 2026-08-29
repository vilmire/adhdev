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
import { rearmPersistedDeferredRestarts } from './med-family/mesh-restart.js';
import type { MedFamilyContext } from './med-family/index.js';
import { highFamilyRegistry } from './high-family/index.js';
import type { HighFamilyContext } from './high-family/index.js';
import { DaemonCliManager } from './cli-manager.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import { killIdeProcess, isIdeRunning } from '../launch.js';
import { normalizeMeshNodeId, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { SessionRegistry } from '../sessions/registry.js';
import { LOG } from '../logging/logger.js';
import { activateKnownMeshTopics } from '../seqscribe/mesh-dual-write.js';
import { markTranscriptSessionDirty } from '../seqscribe/transcript-publisher.js';
import type { PeerHandle } from 'seqscribe';
import type { TranscriptReplicaStore } from '../seqscribe/transcript-replica-store.js';
import { logCommand } from '../logging/command-log.js';
import type { CommandLogEntry } from '../logging/command-log.js';
import { createInteractionId, recordDebugTrace } from '../logging/debug-trace.js';
import { getSessionHostSurfaceKind } from '../session-host/runtime-surface.js';
import { handleMeshForwardEvent, queuePendingMeshCoordinatorEvent } from '../mesh/mesh-events.js';
import { buildMeshHostRequiredFailure, resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import { analyzeMeshRefineNodeChangeArea, orderMeshRefineBatchNodes } from '../mesh/mesh-refine-batch.js';
import type { WorktreeBootstrapState } from '../mesh/worktree-bootstrap-config.js';
import { getMeshQueueRevision } from '../mesh/mesh-work-queue.js';
import type { RepoMeshSessionCleanupMode, RepoMeshSpawnedSessionVisibility } from '../repo-mesh-types.js';
import type { BeaconDiagnosticsSummary, FleetStatusPeerView, SeqscribeStatusSummary } from '../shared-types.js';
import { DEFAULT_MESH_POLICY, magiAutoLaunchedSessionCleanupDecision, mergeAndNormalizePolicy } from '../repo-mesh-types.js';
import { readMeshConfigFromDisk, statMeshConfigFile } from '../config/mesh-config.js';
import { resolve as pathResolve } from 'path';
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';

// ─── Extracted-module imports (symbols the dispatch class consumes) ───
import {
    foldMeshNodeIdentityToCanonical,
    inlineMeshCarriesTransientNodeTruth,
    MESH_DIRECT_PROBE_REUSE_MS,
    MeshGitProbeCache,
    normalizeInlineMeshNodeIdentity,
    readInlineMeshNodeId,
    readObjectRecord,
    readStringValue,
    reconcileInlineMeshCache,
    sanitizeInlineMesh,
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
// ─── Aggregate mesh-status cache (bodies extracted from this file) ───
import {
    getCachedAggregateMeshStatus,
    hydrateCachedAggregateMeshStatusFromInline,
    rememberAggregateMeshStatus,
} from './router-aggregate-status.js';
// ─── Remote mesh-session owner resolution (bodies extracted from this file) ───
import { resolveRemoteMeshSessionOwnerDaemonId } from './router-mesh-session-owner.js';

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
     * Beacon staleness/sole-copy diagnostics (design §7.1, mission b60d70b8).
     *
     * ★ Unlike `getSeqscribeStats` above, this DOES carry topic names and peer
     * writer ids — that is the feature ("which topic is how far ahead"), and it
     * is why the value is LOCAL/P2P ONLY. It reaches `get_status_metadata` and
     * the P2P rich payload; it must never be added to
     * `buildCloudSeqscribeSummary` or any other server-bound projection. The
     * Beacon content exception (CLAUDE.md) covers the BOARD path, not the
     * status path.
     *
     * A getter for the same reasons as `getSeqscribeStats`: the beacon is armed
     * on the first authenticated epoch, long after the router is built, and the
     * numbers must be read at call time. Null when no beacon is armed —
     * standalone never arms one.
     */
    getBeaconDiagnostics?: () => BeaconDiagnosticsSummary | null;
    /**
     * Latest fixed-key status entries received through per-peer seqscribe SUBs.
     * Local/P2P only; null when the node/consumer is unavailable.
     */
    getFleetStatusPeerView?: () => FleetStatusPeerView | null;
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
    // set_conversation_prefs (per-session user Hide/Mute) is session-scoped: the daemon-owned
    // userHidden/userMuted lives on the OWNING session's live instance (med-family handler
    // getInstance → updateSettings). When the target is a REMOTE worker session the coordinator
    // has no local instance, so without forwarding the handler returns 'Session not found', the
    // dashboard's useConversationPrefs silently rolls back, and the stale worker surfaceHidden is
    // re-stamped every snapshot tick (the "restore does nothing + flicker" defect, mission
    // 6938892f). Forwarding to the owning worker lets it actually clear userHidden/userMuted and
    // report a fresh surfaceHidden=false — which also resolves the re-stamp flicker at the source.
    'set_conversation_prefs',
    // agent_command (send_chat / clear_history / stop) is session-scoped too: a command
    // explicitly naming a targetSessionId MUST reach that session wherever it lives, never a
    // different local session. Without forwarding, a misrouted/relayed send_chat for a REMOTE
    // worker session that reaches the wrong daemon used to fuzzy-inject the task body into that
    // daemon's own CLI session (TASKECHO coordinator self-echo). Forwarding to the owning daemon
    // delivers it to the real worker instead. (findAdapter is also fail-closed as the backstop.)
    'agent_command',
    // read_terminal (MESH-READ-TERMINAL feature 2): mesh_read_terminal reads the CURRENT
    // rendered PTY viewport of a specific worker session. The live viewport lives ONLY on the
    // OWNING session's adapter, so when the target is a REMOTE worker the coordinator has no
    // local instance and the handler would return 'Session not found' — the exact
    // remote-worker forwarding gap of mission 6938892f. Forward it to the owning worker daemon
    // so it reads its own live screen. (It is read-only; unlike the mutations above it makes no
    // state change, but it is session-scoped identically and must reach the owning daemon.)
    'read_terminal',
    // send_keys (MESH-SEND-KEYS feature 3): mesh_send_keys injects a structured key sequence
    // into a specific worker session's PTY. The live PTY lives ONLY on the OWNING session's
    // adapter, so a remote-worker target must be forwarded to the owning daemon or the handler
    // returns 'Session not found' (same class as mission 6938892f). Unlike read_terminal this
    // MUTATES the worker PTY, so forwarding to the real owner (not a wrong local session) is
    // doubly important. The daemon re-enforces the destructive-key confirm gate after the forward.
    'send_keys',
    // interactive_prompt_response (mesh_answer_question, mission f1d25e11): the coordinator
    // answers a REMOTE worker's AskUserQuestion (waiting_choice). The answer must reach the
    // OWNING worker session's live instance — its activeInteractivePrompt (the authoritative
    // prompt the labels/indexes resolve against) and its adapter.setInteractivePromptResponse
    // live only there. Without forwarding, the coordinator's local high-family handler returns
    // 'No running instance for session …' and the question is never answered — the exact
    // remote-worker forwarding gap of mission 6938892f, now closed for questions too.
    'interactive_prompt_response',
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
    private meshPolicyDiskSync = { checkedAtMs: 0, mtimeMs: -1, size: -1 };
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

    constructor(deps: CommandRouterDeps) {
        this.deps = deps;
    }

    // ─── Aggregate mesh-status cache ────────────────────────────────────
    // Implementation lives in ./router-aggregate-status.ts (behavior-preserving
    // code move). Kept here as thin delegators: getCachedAggregateMeshStatus /
    // rememberAggregateMeshStatus are bound into HighFamilyContext, so callers
    // reach these via `self.` for correct instance dispatch.

    private hydrateCachedAggregateMeshStatusFromInline(snapshot: any, mesh: any, options?: { requireDirectPeerTruth?: boolean }): any {
        return hydrateCachedAggregateMeshStatusFromInline(this, snapshot, mesh, options);
    }

    private getCachedAggregateMeshStatus(
        meshId: string,
        mesh?: any,
        options?: { requireDirectPeerTruth?: boolean; allowStalePending?: boolean },
    ): any | null {
        return getCachedAggregateMeshStatus(this, meshId, mesh, options);
    }

    private rememberAggregateMeshStatus(meshId: string, snapshot: any, refreshReason: string): any {
        return rememberAggregateMeshStatus(this, meshId, snapshot, refreshReason);
    }

    /**
     * meshes.json → inline-cache policy resync (mtime-triggered lazy reload).
     *
     * Out-of-band edits to meshes.json (an operator hand-editing a policy flag)
     * never reached the inline mesh cache: command-path updates (update_mesh)
     * rewrite BOTH disk and cache, but a direct file edit changed nothing in
     * memory, so mesh_status / refine gating kept serving the boot-time policy
     * until a daemon restart (live evidence 2026-08-25: requireApprovalForPush
     * flipped to false on disk 92 min after daemon boot; the daemon kept
     * reporting and enforcing true).
     *
     * Fix: on inline-cache reads, stat meshes.json (throttled — routing and
     * status polling are hot paths); when the file changed, re-apply ONLY each
     * cached mesh's `policy` block from disk. Policy-only, never nodes/meshHost:
     * the inline cache is the coordinator's live node truth, and the daemon's
     * own mutators read-modify-write through disk, so they already carry the
     * edit forward — overwriting the whole cached mesh here would clobber
     * in-flight node truth for zero benefit. A changed policy also busts the
     * aggregate status snapshot, whose scheduling projection is derived from it.
     *
     * Safety rules:
     *   - unparseable file (torn mid-edit write) → keep the in-memory policy,
     *     log only. Never fall back to defaults: that would silently LOOSEN
     *     security flags (requireApprovalForPush / requireApprovalForDestructiveGit).
     *   - mesh absent from disk (deleted, or inline-only cloud mesh) → keep the
     *     cache entry untouched.
     */
    private syncInlineMeshPoliciesFromDisk(): void {
        if (this.inlineMeshCache.size === 0) return;
        const now = Date.now();
        const sync = this.meshPolicyDiskSync;
        if (now - sync.checkedAtMs < DaemonCommandRouter.MESH_POLICY_DISK_SYNC_THROTTLE_MS) return;
        sync.checkedAtMs = now;
        const stat = statMeshConfigFile();
        if (!stat) return; // File absent/unreadable: nothing to sync; retry next window.
        if (stat.mtimeMs === sync.mtimeMs && stat.size === sync.size) return;
        const hadBaseline = sync.mtimeMs >= 0;
        sync.mtimeMs = stat.mtimeMs;
        sync.size = stat.size;
        if (!hadBaseline) return; // First sight records the baseline only (see field comment).
        const disk = readMeshConfigFromDisk();
        if (!disk) {
            console.warn('[mesh-config] meshes.json changed but is unparseable (mid-edit?) — keeping in-memory mesh policies');
            return;
        }
        const diskPolicyByMeshId = new Map<string, any>();
        for (const mesh of disk.meshes) {
            if (mesh?.id && mesh.policy && typeof mesh.policy === 'object') diskPolicyByMeshId.set(mesh.id, mesh.policy);
        }
        for (const [meshId, cached] of this.inlineMeshCache) {
            const diskPolicy = diskPolicyByMeshId.get(meshId);
            if (!diskPolicy) continue;
            const nextPolicy = mergeAndNormalizePolicy(undefined, diskPolicy);
            if (JSON.stringify(cached?.policy ?? null) === JSON.stringify(nextPolicy)) continue;
            cached.policy = nextPolicy;
            this.invalidateAggregateMeshStatus(meshId);
        }
    }

    private static readonly MESH_POLICY_DISK_SYNC_THROTTLE_MS = 250;

    public getCachedInlineMeshNodes(): any[] {
        this.syncInlineMeshPoliciesFromDisk();
        const nodes: any[] = [];
        for (const mesh of this.inlineMeshCache.values()) {
            if (Array.isArray(mesh?.nodes)) {
                nodes.push(...mesh.nodes);
            }
        }
        return nodes;
    }

    /**
     * Same flattened node list as getCachedInlineMeshNodes(), but each node is
     * paired with the `spawnedSessionVisibility` from its OWNING mesh's policy.
     * The flat node list loses the mesh→node association, yet the cloud daemon's
     * synthetic mesh-session mirror needs the mesh-level visibility policy to
     * decide whether a coordinator-spawned worker session should be hidden+muted
     * on the dashboard (the cached inline-mesh session entry carries no settings
     * of its own). Falls back to DEFAULT_MESH_POLICY.spawnedSessionVisibility when
     * the mesh policy is absent, matching the worker-launch stamp.
     */
    public getCachedInlineMeshNodesWithVisibility(): Array<{ node: any; spawnedSessionVisibility: RepoMeshSpawnedSessionVisibility }> {
        this.syncInlineMeshPoliciesFromDisk();
        const out: Array<{ node: any; spawnedSessionVisibility: RepoMeshSpawnedSessionVisibility }> = [];
        for (const mesh of this.inlineMeshCache.values()) {
            const spawnedSessionVisibility: RepoMeshSpawnedSessionVisibility =
                mesh?.policy?.spawnedSessionVisibility === 'visible' ? 'visible' : 'hidden';
            if (Array.isArray(mesh?.nodes)) {
                for (const node of mesh.nodes) {
                    out.push({ node, spawnedSessionVisibility });
                }
            }
        }
        return out;
    }

    // ─── Remote mesh-session owner resolution ───────────────────────────
    // Implementation lives in ./router-mesh-session-owner.ts (behavior-preserving
    // code move). resolveRemoteMeshSessionOwnerDaemonId stays public (the [Z]
    // session-scoped forward in executeDaemonCommand and a unit test call it), so
    // it's kept here as a thin delegator.

    public resolveRemoteMeshSessionOwnerDaemonId(sessionId: string, ownerNodeIdHint?: string): string | undefined {
        return resolveRemoteMeshSessionOwnerDaemonId(this, sessionId, ownerNodeIdHint);
    }

    public getCachedInlineMesh(meshId: string, inlineMesh?: unknown): any | undefined {
        this.syncInlineMeshPoliciesFromDisk();
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
            const merged = reconcileInlineMeshCache(cached, sanitizedInlineMesh, this.removedInlineMeshNodeIds.get(meshId));
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
                        this.removedInlineMeshNodeIds.get(meshId),
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
            markWorktreeBootstrapTerminalState: this.markWorktreeBootstrapTerminalState.bind(this),
            requireMeshHostMutationOwner: this.requireMeshHostMutationOwner.bind(this),
            invalidateAggregateMeshStatus: this.invalidateAggregateMeshStatus.bind(this),
            updateInlineMeshNode: this.updateInlineMeshNode.bind(this),
            seedRemoteClonedWorktreeNode: this.seedRemoteClonedWorktreeNode.bind(this),
            removeInlineMeshNode: this.removeInlineMeshNode.bind(this),
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
            markWorktreeBootstrapTerminalState: this.markWorktreeBootstrapTerminalState.bind(this),
            getCachedInlineMesh: this.getCachedInlineMesh.bind(this),
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

    // Public alongside removeInlineMeshNode: the graph workspace saga registers
    // its prepared worktree through the same inline-cache seam the retention
    // sweep already uses for removal (mesh-graph-workspace-ports.ts).
    updateInlineMeshNode(meshId: string, mesh: any, node: any): void {
        const incomingId = normalizeMeshNodeId(node);
        if (!mesh || !Array.isArray(mesh.nodes) || !incomingId) return;
        // M-MESH-INFRA-0829 [C]: honor removal tombstones here too. Every OTHER inline-cache
        // write path (warmInlineMeshCache, getMeshForCommand's reconcile branch) already filters
        // through applyInlineMeshNodeTombstones before merging — this direct single-node writer
        // was the one gap. Its two hydrate-on-miss callers (markWorktreeBootstrapTerminalState's
        // shell upsert, seedRemoteClonedWorktreeNode's clone-reply merge) both react to late/
        // replayed/best-effort P2P events for a node id that "isn't in the cache" — which is
        // exactly true immediately after mesh_remove_node tombstones and evicts it. Without this
        // check a stray post-removal event silently resurrects the node. Same clearing rule as
        // applyInlineMeshNodeTombstones: a genuine re-registration (workspace really is back) still
        // wins.
        if (this.isInlineMeshNodeTombstoned(meshId, incomingId, node)) {
            LOG.info('Mesh', `[NodeMembershipMerge] mesh=${meshId} droppedNodeId=${incomingId} reason=tombstoned_removal source=updateInlineMeshNode`);
            return;
        }
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

    removeInlineMeshNode(meshId: string, mesh: any, nodeId: string): boolean {
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

    /**
     * REMOTE-CLONE-CACHE-SEED: register a worktree node produced by a clone that ran on
     * ANOTHER machine into THIS (coordinator) daemon's inline mesh cache.
     *
     * Root cause this fixes: clone_mesh_node forwards to the source node's daemon when the
     * source lives on a different machine. The local clone branch writes the new node into
     * the coordinator's own cache synchronously (updateInlineMeshNode / addNode), but the
     * remote-forward branch only returned the reply — it never seeded the local cache. The
     * scheduler is a PURELY PASSIVE cache reader (mesh-queue-assignment getMeshWithCache:
     * no network call), whereas the read tools actively refresh (refreshMeshFromDaemon) and
     * mesh_git_status fans out over P2P — which is exactly why the node was visible to every
     * tool yet permanently invisible to the queue (`target_node_id_unmatched` /
     * `no_node_satisfies_required_tags`). Cache reflection depended solely on the one-shot
     * `worktree_bootstrap_complete` P2P push, which has no retry and no periodic resync, so
     * a single dropped event stranded the node forever.
     *
     * ORDER-INDEPENDENT BY CONSTRUCTION. This races the bootstrap-complete event's
     * hydrate-on-miss upsert (markWorktreeBootstrapTerminalState) in BOTH directions, and
     * updateInlineMeshNode REPLACES the entry wholesale rather than merging, so neither
     * writer may blindly overwrite the other:
     *   - seed-then-event: the node now exists, so hydrate-on-miss does not fire; the event
     *     takes the `stamp()` path, which mutates ONLY worktreeBootstrap and preserves every
     *     scheduling field seeded here.
     *   - event-then-seed (the dangerous order): the event already hydrated a MINIMAL node
     *     carrying a TERMINAL bootstrap status. Overwriting it with this reply's 'running'
     *     state would re-close the claim gate permanently (shouldDeferDispatchForBootstrap
     *     defers on 'running'), reproducing the very stall this fixes. So an existing
     *     terminal worktreeBootstrap always wins over the reply's non-terminal one.
     * The merge is field-directional, never a wholesale pick of one side: the reply is
     * authoritative for the STATIC scheduling identity it alone carries (daemonId, machineId,
     * policy, userOverrides, capabilities, workspace, worktreeBranch) — the hydrated shell has
     * none of these — while the existing entry is authoritative for DYNAMIC runtime state that
     * has already advanced past the reply (terminal worktreeBootstrap).
     *
     * Seeding daemonId/machineId is not cosmetic: isLocalAutoLaunchNode treats a node with
     * NEITHER field as LOCAL, so the minimal hydrated shell would make the coordinator try to
     * auto-launch a remote worktree session on its own machine. Likewise required-tags matching
     * derives tags from policy/capabilities/platform, so a shell node satisfies no tag filter.
     */
    public seedRemoteClonedWorktreeNode(meshId: string, node: any): boolean {
        if (!meshId || !node || typeof node !== 'object') return false;
        const nodeId = normalizeMeshNodeId(node);
        if (!nodeId) return false;
        try {
            const cached = this.getCachedInlineMesh(meshId);
            const shell = (cached && typeof cached === 'object')
                ? cached
                : { id: meshId, nodes: [] as any[], updatedAt: new Date().toISOString() };
            if (!Array.isArray(shell.nodes)) shell.nodes = [];
            const existing = shell.nodes.find((entry: any) => meshNodeIdMatches(entry, nodeId));
            // Start from the reply (authoritative for static scheduling identity), then let
            // any already-advanced dynamic state on the existing entry win — see the
            // event-then-seed ordering note above.
            const merged: any = { ...(existing && typeof existing === 'object' ? existing : {}), ...node };
            const existingBootstrapStatus = readStringValue(existing?.worktreeBootstrap?.status);
            if (existingBootstrapStatus === 'complete' || existingBootstrapStatus === 'failed') {
                merged.worktreeBootstrap = existing.worktreeBootstrap;
            }
            this.updateInlineMeshNode(meshId, shell, merged);
            return true;
        } catch {
            return false; /* best-effort: a failed seed degrades to the pre-fix behavior */
        }
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

    /** Single-node counterpart of {@link applyInlineMeshNodeTombstones}, for a direct
     *  single-node writer (updateInlineMeshNode) rather than a whole-mesh merge. Same rule:
     *  a tombstoned node id is dropped unless its workspace is genuinely back on disk, in
     *  which case the tombstone clears and the write proceeds normally. */
    private isInlineMeshNodeTombstoned(meshId: string, nodeId: string, node: any): boolean {
        const tombstones = this.removedInlineMeshNodeIds.get(meshId);
        if (!tombstones?.size || !tombstones.has(nodeId)) return false;
        const workspace = readStringValue(node?.workspace);
        if (workspace && fs.existsSync(workspace)) {
            tombstones.delete(nodeId);
            if (tombstones.size === 0) this.removedInlineMeshNodeIds.delete(meshId);
            return false;
        }
        return true;
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
            if (CHAT_COMMANDS.includes(cmd)) {
                // §8 unit 3 dirty trigger (design §5.2's "post-chat hook" —
                // this callback is literally that hook, already firing for
                // every send_chat/new_chat/switch_chat/set_mode/change_model
                // regardless of transport). Safe no-op until
                // configureTranscriptProjection is armed (boot/daemon-
                // lifecycle.ts) — same pattern as markChatOutputActivity's
                // call in subscriptions/topic-registry.ts.
                const dirtySessionId = typeof normalizedArgs?.targetSessionId === 'string'
                    ? normalizedArgs.targetSessionId.trim()
                    : '';
                if (dirtySessionId) markTranscriptSessionDirty(dirtySessionId);
                this.deps.onPostChatCommand?.();
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
