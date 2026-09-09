/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * See ALL_MESH_TOOLS (mesh-tool-schemas.ts) for the authoritative tool list
 * and count; kept in sync with the coordinator-prompt TOOLS table by the
 * 6-6 consistency test in daemon-core coordinator-prompt.test.ts.
 */

// ─── Internal module ───────────────────────────
// Shared helpers, types, module-level state, and dependency re-exports for the mesh tool
// domain files (mesh-tools-{status,queue,mission,session,git,refine}.ts). Split out of
// mesh-tools.ts as a pure move — no behavior change. mesh-tools.ts is now a re-export barrel.

import { randomUUID } from 'node:crypto';
import { IpcTransport } from '../transports/ipc.js';
import type { CommandTransport } from '../transports/mode.js';
import { compactChatPayload } from './chat-compact.js';
import { annotateRapidReadChatAdvisory } from './read-chat-polling-advisory.js';
import { withStatusProbeMarker } from '@adhdev/mesh-shared';
import type { LocalMeshEntry, LocalMeshNodeEntry, MeshActiveWorkSummary, MeshToolCallRateResult, RepoMeshPolicy, RepoMeshRelatedRepo } from '@adhdev/daemon-core';
import {
    daemonIdsEquivalent,
    meshNodeIdMatches,
    appendLedgerEntry,
    appendRemoteLedgerEntries,
    buildCompactStaleDirectWorkSummary,
    buildMeshActiveWork,
    collectPendingApprovals,
    buildMeshAsyncRefineJobs,
    summarizeMeshAsyncRefineJobs,
    buildMeshMagiActivity,
    summarizeMeshMagiActivity,
    getMeshMagiActivityByGroup,
    MAGI_RAW_ANSWER_CAP,
    buildMeshLedgerReconciliationEvidence,
    buildMeshLedgerReplicaEvidence,
    buildMeshNodeProbeFreshness,
    buildMeshSchedulingRuntime,
    getLastQuotaRanking,
    buildP2pRelayFailurePayload,
    cancelTask,
    classifyP2pRelayFailure,
    pruneStaleDirectDispatches,
    describeTaskDependencyState,
    parseOnDependencyFailurePolicy,
    MeshGraphPolicyError,
    // GRAPH-ORCHESTRATION Phase E — the graph surface the mesh_graph_* tools call.
    claimMeshGraphGate,
    releaseMeshGraphGate,
    abandonMeshGraphGate,
    collectGateConvergenceEvidence,
    commitMeshGraphPlan,
    requestUsesGraphV2,
    MeshGraphPlanError,
    buildMeshGraphViews,
    normalizeOrchestrationDecision,
    recordGraphEnqueueCommitted,
    recordGraphEnqueueValidationFailed,
    recordGraphEnqueueRolledBack,
    recordSingleEnqueueDecision,
    MESH_DECLARED_ELIGIBLE_SINGLE_HINT,
    // GRAPH-MEASUREMENT-DIRECT — consumed by mesh-tools-session.ts (meshSendTask).
    recordDirectDispatchDecision,
    MESH_UNSANCTIONED_DIRECT_HINT,
    MESH_VALID_DIRECT_REASONS,
    recordGraphGateClaimed,
    recordGraphGateReleased,
    recordGraphGateAbandoned,
    taskDependenciesSatisfied,
    drainPendingMeshCoordinatorEvents,
    enqueueTask,
    enqueueTaskGraph,
    MESH_TASK_GRAPH_MAX_TASKS,
    computeMeshMissionStats,
    computeMeshTaskStats,
    getActiveMeshMissionSummaries,
    getMeshMission,
    getMeshStatusMissionSummaries,
    getMeshStatusMissionsCompact,
    listMeshMissionSummaries,
    listMeshMissionsForTool,
    MESH_MISSION_STATUSES,
    upsertMeshMission,
    getActiveDirectDispatches,
    getQueue,
    getLedgerSummary,
    summarizeMeshUsage,
    getSessionRecoveryContext,
    hasTrailingToolActivityAfterFinalAssistant,
    insertDirectDispatch,
    recordDirectDispatchTask,
    isP2pRelayTransportFailure,
    markStaleDirectDispatches,
    nodeSatisfiesRequiredTags,
    normalizeMeshCapabilityTags,
    isMeshNodeHealthLaunchable,
    resolveEffectiveMeshNodeHealth,
    readLedgerEntries,
    coordinatorIdentityFromEmitFields,
    readLedgerSlice,
    readLedgerSliceFromStore,
    reconcileDirectDispatchCompletionFromTranscript,
    recordMeshToolCall,
    requeueTask,
    requeueHeldMeshCoordinatorEvents,
    resolveMeshSurfacedSessionPreview,
    resolveDelegatedWorkerAutoApprove,
    resolveDelegatedWorkerDangerousModeAllow,
    loadRepoMeshJsonConfig,
    resolveAllowSendKeysDestructive,
    validateMeshTaskModeRequest,
    buildMeshTaskModeViolationError,
} from '@adhdev/daemon-core';
import { readString } from './mesh-tool-shared.js';
import {
    readSessionRecordId,
    extractStatusMetadataSessions,
    resolveSessionProviderType,
    isMeshCoordinatorSessionRecord,
    isUnmanagedSessionRecord,
    isWorkerTaskMode,
    collectNodeSessionIds,
    unwrapCommandPayload,
} from './mesh-session-helpers.js';
import {
    ACTIVE_QUEUE_STATUSES,
    HISTORICAL_QUEUE_STATUSES,
    COMPACT_MAX_ACTIVE_QUEUE_ROWS,
    COMPACT_MAX_ACTIVE_WORK_ROWS,
    buildQueueStatusSummary,
    normalizeQueueViewMode,
    sanitizeQueueStatusFilter,
    filterQueueForView,
    prioritizeActiveQueueRows,
    buildQueueMaintenanceReport,
    buildCompactQueueMaintenanceReport,
    compactQueueRow,
    compactQueueRows,
    compactActiveWorkRecords,
    annotateQueueStaleness,
} from './mesh-queue-helpers.js';
import type { QueueViewMode } from './mesh-queue-helpers.js';
import {
    compactMeshStatusNode,
    compactNodeSeverity,
    isNoteworthyCompactNode,
    minimalCompactNode,
    summarizeNodeSessions,
} from './mesh-compact.js';

// Node identity / locality helpers were physically moved to ./mesh-node-identity.ts
// (pure move, no behavior change). Imported back for internal use here.
import {
    resolveCoordinatorNode,
    resolveCoordinatorDaemonId,
    readNodeMachineId,
    readNodeDaemonId,
    buildNodeMachineIdentity,
    resolvePreferredWorktreeNodeId,
    isLocalControlPlaneNode,
} from './mesh-node-identity.js';

// Re-exported so the public `./tools/mesh-tools.js` path still exposes it.
export { resolveCoordinatorDaemonId } from './mesh-node-identity.js';


// ─── Tool Definitions ───────────────────────────

// Tool schema definitions live in ./mesh-tool-schemas.ts. Re-exported here so the
// public `./tools/mesh-tools.js` import path (server.ts, help.ts) is unchanged.
export {
    MESH_STATUS_TOOL,
    MESH_ROUTE_PREVIEW_TOOL,
    MESH_LIST_NODES_TOOL,
    MESH_ENQUEUE_TASK_TOOL,
    MESH_VIEW_QUEUE_TOOL,
    // GRAPH-ORCHESTRATION Phase E.
    MESH_GRAPH_VIEW_TOOL,
    MESH_GRAPH_GATE_CLAIM_TOOL,
    MESH_GRAPH_GATE_RELEASE_TOOL,
    MESH_GRAPH_GATE_ABANDON_TOOL,
    MESH_QUEUE_CANCEL_TOOL,
    MESH_QUEUE_REQUEUE_TOOL,
    MESH_SEND_TASK_TOOL,
    MESH_READ_CHAT_TOOL,
    MESH_READ_DEBUG_TOOL,
    MESH_LAUNCH_SESSION_TOOL,
    MESH_GIT_STATUS_TOOL,
    MESH_READ_NODE_LOGS_TOOL,
    MESH_FAST_FORWARD_NODE_TOOL,
    MESH_RESTART_DAEMON_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_MISSION_UPSERT_TOOL,
    MESH_MISSION_LIST_TOOL,
    MESH_APPROVE_TOOL,
    MESH_ANSWER_QUESTION_TOOL,
    MESH_LIST_PENDING_APPROVALS_TOOL,
    MESH_PLAN_ONBOARDING_TOOL,
    MESH_CREATE_TOOL,
    MESH_ADD_NODE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
    MESH_CLEANUP_WORKTREE_NODES_TOOL,
    MESH_TASK_HISTORY_TOOL,
    MESH_RECORD_NOTE_TOOL,
    MESH_FORGET_NOTE_TOOL,
    MESH_RECONCILE_LEDGER_TOOL,
    MESH_REQUEUE_HELD_EVENTS_TOOL,
    MESH_PRUNE_STALE_DIRECT_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_REFINE_BATCH_TOOL,
    MESH_REFINE_CONFIG_TOOL,
    MESH_CHANGE_IMPACT_CONFIG_TOOL,
    MESH_INIT_TOOL,
    MESH_REINIT_TOOL,
    MESH_WRITE_MESH_JSON_CONFIG_TOOL,
    MESH_MAGI_KIND_PANEL_SET_TOOL,
    MESH_MAGI_KIND_PANEL_LIST_TOOL,
    MESH_REFINE_PLAN_TOOL,
    MESH_REVIEW_INBOX_TOOL,
    MESH_NOTIFY_WORKER_TOOL,
    ALL_MESH_TOOLS,
} from './mesh-tool-schemas.js';

// Re-export imported dependencies so the domain tool files import everything from this module.
export {
    IpcTransport,
} from '../transports/ipc.js';
export type {
    CommandTransport,
} from '../transports/mode.js';
export {
    compactChatPayload,
    isCoordinatorVisibleMessage,
    messageContent,
} from './chat-compact.js';
export {
    annotateQuotaSnapshotFreshness,
    compactMeshStatusNode,
    compactNodeSeverity,
    isNoteworthyCompactNode,
    minimalCompactNode,
    pinnedRepresentativeNodeIds,
    summarizeNodeSessions,
} from './mesh-compact.js';
export {
    buildNodeMachineIdentity,
    isLocalControlPlaneNode,
    readNodeDaemonId,
    readNodeMachineId,
    resolveCoordinatorNode,
    resolvePreferredWorktreeNodeId,
} from './mesh-node-identity.js';
export {
    ACTIVE_QUEUE_STATUSES,
    COMPACT_MAX_ACTIVE_QUEUE_ROWS,
    COMPACT_MAX_ACTIVE_WORK_ROWS,
    HISTORICAL_QUEUE_STATUSES,
    annotateQueueStaleness,
    buildCompactQueueMaintenanceReport,
    buildQueueMaintenanceReport,
    buildQueueStatusSummary,
    compactActiveWorkRecords,
    compactQueueRow,
    compactQueueRows,
    filterQueueForView,
    normalizeQueueViewMode,
    prioritizeActiveQueueRows,
    sanitizeQueueStatusFilter,
} from './mesh-queue-helpers.js';
export type {
    QueueViewMode,
} from './mesh-queue-helpers.js';
export {
    collectNodeSessionIds,
    extractStatusMetadataSessions,
    isIdleSessionRecord,
    isMeshCoordinatorSessionRecord,
    isTerminalSessionRecord,
    isUnmanagedSessionRecord,
    isWorkerTaskMode,
    readSessionRecordId,
    resolveSessionProviderType,
    unwrapCommandPayload,
} from './mesh-session-helpers.js';
export {
    LARGE_LEDGER_FIELD_KEYS,
    elideLargeNestedValue,
    readNumeric,
    readString,
    readTaskInput,
    summarizeLargeLedgerField,
} from './mesh-tool-shared.js';
export type { MeshTaskInput } from './mesh-tool-shared.js';
export {
    annotateRapidReadChatAdvisory,
} from './read-chat-polling-advisory.js';
export {
    MESH_MISSION_STATUSES,
    appendLedgerEntry,
    appendRemoteLedgerEntries,
    buildCompactStaleDirectWorkSummary,
    buildMeshActiveWork,
    collectPendingApprovals,
    buildMeshAsyncRefineJobs,
    buildMeshMagiActivity,
    summarizeMeshMagiActivity,
    getMeshMagiActivityByGroup,
    MAGI_RAW_ANSWER_CAP,
    buildMeshLedgerReconciliationEvidence,
    buildMeshLedgerReplicaEvidence,
    buildMeshNodeCapabilityTags,
    buildMeshNodeProbeFreshness,
    buildMeshSchedulingRuntime,
    getLastQuotaRanking,
    buildP2pRelayFailurePayload,
    cancelTask,
    classifyP2pRelayFailure,
    computeMeshMissionStats,
    computeMeshTaskStats,
    daemonIdsEquivalent,
    deleteDirectDispatchesByTaskId,
    describeTaskDependencyState,
    parseOnDependencyFailurePolicy,
    MeshGraphPolicyError,
    claimMeshGraphGate,
    releaseMeshGraphGate,
    abandonMeshGraphGate,
    collectGateConvergenceEvidence,
    commitMeshGraphPlan,
    requestUsesGraphV2,
    MeshGraphPlanError,
    buildMeshGraphViews,
    normalizeOrchestrationDecision,
    recordGraphEnqueueCommitted,
    recordGraphEnqueueValidationFailed,
    recordGraphEnqueueRolledBack,
    recordSingleEnqueueDecision,
    MESH_DECLARED_ELIGIBLE_SINGLE_HINT,
    // GRAPH-MEASUREMENT-DIRECT — consumed by mesh-tools-session.ts (meshSendTask).
    recordDirectDispatchDecision,
    MESH_UNSANCTIONED_DIRECT_HINT,
    MESH_VALID_DIRECT_REASONS,
    recordGraphGateClaimed,
    recordGraphGateReleased,
    recordGraphGateAbandoned,
    taskDependenciesSatisfied,
    drainPendingMeshCoordinatorEvents,
    enqueueTask,
    enqueueTaskGraph,
    MESH_TASK_GRAPH_MAX_TASKS,
    getActiveDirectDispatches,
    getActiveMeshMissionSummaries,
    getLedgerSummary,
    summarizeMeshUsage,
    getMagiKindPanel,
    listMagiKindPanels,
    setMagiKindPanel,
    removeMagiKindPanel,
    normalizeMagiSlots,
    collectIgnoredMagiSlotFields,
    getMeshMission,
    getMeshStatusMissionSummaries,
    getMeshStatusMissionsCompact,
    getQueue,
    getSessionRecoveryContext,
    insertDirectDispatch,
    isP2pRelayTransportFailure,
    isWeakCompletionEvidence,
    listMeshMissionSummaries,
    listMeshMissionsForTool,
    markStaleDirectDispatches,
    meshNodeIdMatches,
    nodeSatisfiesRequiredTags,
    normalizeMeshCapabilityTags,
    isMeshNodeHealthLaunchable,
    resolveEffectiveMeshNodeHealth,
    normalizeMeshTaskPriority,
    resolveNotBefore,
    meshTaskPriorityRank,
    pruneStaleDirectDispatches,
    readLedgerEntries,
    readLedgerSlice,
    readLedgerSliceFromStore,
    reconcileDirectDispatchCompletionFromTranscript,
    recordDirectDispatchTask,
    requeueTask,
    requeueHeldMeshCoordinatorEvents,
    resolveDelegatedWorkerAutoApprove,
    resolveDelegatedWorkerDangerousModeAllow,
    loadRepoMeshJsonConfig,
    resolveAllowSendKeysDestructive,
    resolveMeshSurfacedSessionPreview,
    summarizeMeshAsyncRefineJobs,
    tombstoneOperatingNote,
    upsertMeshMission,
    validateMeshTaskModeRequest,
    buildMeshTaskModeViolationError,
    // CANCEL-ORPHANS-PINNED-TASK: consumed by mesh-tools-queue.ts (meshQueueCancel).
    notifyCoordinatorOfOrphanedPins,
    findTasksOrphanedBySessionStop,
    buildOrphanedPinNotice,
} from '@adhdev/daemon-core';
export type { OrphanedPinnedTask } from '@adhdev/daemon-core';
export type {
    LocalMeshEntry,
    LocalMeshNodeEntry,
    MeshTaskGraphEntrySpec,
    // GRAPH-ORCHESTRATION Phase E — batch v2 plan shapes.
    MeshGraphGatePlanSpec,
    MeshGraphTaskPlanSpec,
    MeshGraphPlanResult,
    MeshGraphView,
    MagiAgentResponse,
    MagiClaim,
    MagiClaimCluster,
    MagiClusterMember,
    MagiGitSkew,
    MagiMode,
    MagiTaskKind,
    MagiReplicaGitRef,
    MagiResponseSource,
    MagiSlot,
    MagiKindPanelMap,
    MagiSynthesis,
    MagiSynthesizedResponse,
    MeshActiveWorkSummary,
    MeshPendingApproval,
    MeshSchedulingRuntime,
    MeshNodeSchedulingRuntime,
    RepoMeshPolicy,
    RepoMeshRelatedRepo,
} from '@adhdev/daemon-core';
export {
    randomUUID,
} from 'node:crypto';

// The pure helper layer of this hub — payload/evidence extraction, git-status
// readers, node policy/capability/readiness readers, delegate-session
// relay-safety classification, launch/read_chat failure classification, and
// branch convergence — was physically moved to ./mesh-tools-internal-core.ts
// (pure move — this file is a frozen file-size baseline entry; same split as
// mesh-tools-magi.ts → mesh-tools-magi-core.ts). Every public symbol is
// re-exported here so the domain tool files, tests, and the mesh-tools.ts
// barrel keep importing from this hub; the ctx-bound orchestration below
// imports what it consumes.
import {
    buildMeshForwardPayloadFromPendingEvent,
    buildWorktreeCleanupHint,
    chooseDispatchableSession,
    classifyMeshLaunchFailure,
    classifyReadChatTransportCause,
    classifyRemoteDelegateRelaySafety,
    extractDaemonBuildInfo,
    extractGitStatus,
    extractUpgradeFailureSummary,
    findNode,
    normalizePendingMeshCoordinatorEvents,
    readProviderPriority,
    readRelatedRepos,
    summarizeRelatedRepoStatus,
    type MeshUpgradeFailureSummary,
} from './mesh-tools-internal-core.js';
export {
    COMPACT_MAX_CONVERGENCE_FOLLOWUPS,
    assignFullGitSnapshot,
    buildBranchConvergence,
    buildDirectTaskPayload,
    buildMeshForwardPayloadFromPendingEvent,
    buildNodeCapabilityExposure,
    buildQueueTriggerGuidance,
    buildWorktreeCleanupHint,
    chooseDispatchableSession,
    classifyMeshLaunchFailure,
    classifyReadChatTransportCause,
    classifyRemoteDelegateRelaySafety,
    compactRoutingDecision,
    countUncommittedChanges,
    extractCloneNodePayload,
    extractDaemonBuildInfo,
    extractGitDiff,
    extractGitStatus,
    extractLaunchPayload,
    extractReporterNodeFactsQuota,
    extractSubmodules,
    extractUpgradeFailureSummary,
    findNestedPayload,
    findNode,
    findNodeByWorkspace,
    findNodeSession,
    getNodeLaunchReadiness,
    getWorktreeBootstrapLaunchBlock,
    hasRemoteRelayMetadata,
    isDirectDispatchLedgerEntry,
    isGitStatusDirty,
    isMeshOwnedDelegateSession,
    isRelaySafeRemoteDelegateSession,
    missingProviderPriorityMessage,
    normalizePendingMeshCoordinatorEvents,
    readFinalAssistantTranscriptEvidence,
    readMessageTimestampIso,
    readNodeSupportedProviders,
    readProviderPriority,
    readRelatedRepos,
    readSpawnedSessionVisibility,
    slimLedgerPayload,
    summarizeBranchConvergence,
    summarizeRelatedRepoStatus,
    summarizeTaskMessage,
} from './mesh-tools-internal-core.js';
export type {
    MeshLaunchFailureClassification,
    MeshUpgradeFailureSummary,
} from './mesh-tools-internal-core.js';

export interface MeshContext {
    mesh: LocalMeshEntry;
    transport: CommandTransport;
    /** Daemon ID for this local machine (local mode) */
    localDaemonId?: string;
    /** Machine Registry ID for this local machine */
    localMachineId?: string;
    /** Hostname of the daemon/MCP coordinator machine. */
    coordinatorHostname?: string;
    /**
     * Runtime session id of THIS coordinator's CLI session, injected by the daemon at
     * coordinator launch via ADHDEV_COORDINATOR_SESSION_ID. Stamped onto dispatched
     * workers (meshContext.coordinatorSessionId) so a worker's completion event routes
     * back to the exact originating coordinator session — even when several coordinator
     * sessions share one daemon. Absent for non-coordinator / legacy launches → routing
     * falls back to the daemon-level anchor.
     */
    coordinatorSessionId?: string;
    /**
     * T6 (B3c): the mesh-protocol-v2 enforce/backstop counters snapshot ridden on the
     * most recent local get_pending_mesh_events drain response (set by
     * drainCoordinatorPendingEvents). Lets a pure stdio MCP coordinator surface the
     * enforce state + quarantine / last-resort-backstop tallies in mesh_status without
     * a second daemon round-trip. Absent on version-skewed daemons that don't ride it.
     */
    lastMeshProtocolV2Counters?: MeshProtocolV2CountersSnapshot;
    /**
     * Pending-event retention sweep counters ridden on the most recent local
     * get_pending_mesh_events drain response (set by drainCoordinatorPendingEvents),
     * same rationale as lastMeshProtocolV2Counters above. `undrainedExpired` non-zero
     * means the sweep deleted events that were never delivered — mirrored to the
     * ledger as event_held (reason: pending_retention_expired), recoverable via
     * mesh_requeue_held_events. Absent on version-skewed daemons that don't ride it.
     */
    lastPendingRetentionCounters?: MeshPendingRetentionCountersSnapshot;
}

/**
 * MESH-TOOL-CALL-CALLER-INSTRUMENTATION (1단계): wraps recordMeshToolCall with the
 * only caller-identity signal this stdio MCP process has — whether it was launched
 * with ADHDEV_COORDINATOR_SESSION_ID (carried on ctx.coordinatorSessionId). Absent
 * does NOT mean "this is a worker": a legacy or non-coordinator launch also has no
 * env var, so absence is recorded as 'unknown', never asserted as a worker identity.
 *
 * ★This is a diagnostic signal, not an auth boundary. Env vars are process-settable
 * by the process itself, so callerRole must never be used to block or allow a tool
 * call — only to observe, post hoc, which calls came from a coordinator-launched
 * process. See CLAUDE.md M-WORKER-SCOPED-MCP-SURFACE for the investigation this
 * instrumentation feeds (whether worker MCP surfaces should be scoped down).
 */
export function recordMeshCoordinatorToolCall(ctx: MeshContext, tool: string): MeshToolCallRateResult {
    const sessionId = ctx.coordinatorSessionId ?? null;
    return recordMeshToolCall({
        meshId: ctx.mesh.id,
        tool,
        sessionId,
        callerRole: sessionId ? 'coordinator' : 'unknown',
    });
}

/** T6 (B3c) live v2 enforce/observability counters snapshot (mirrors the daemon-core
 *  RepoMeshStatus.meshProtocolV2Counters shape). Structural type — no daemon-core import. */
export interface MeshProtocolV2CountersSnapshot {
    enforce: boolean;
    drain: Record<string, number>;
    backstop: Record<string, number>;
}

/** Pending-event retention sweep counters snapshot (mirrors the daemon-core
 *  RepoMeshStatus.pendingRetentionCounters shape). Structural type — no daemon-core import. */
export interface MeshPendingRetentionCountersSnapshot {
    drainedExpired: number;
    undrainedExpired: number;
    undrainedExpiredMirrorFailed: number;
    sweepsNoop: number;
}

export type MeshSessionProviderMetadata = {
    providerType: string;
    providerSessionId?: string;
};

export const SESSION_PROVIDER_METADATA_TTL_MS = 30 * 60_000;

export type TimestampedSessionMetadata = MeshSessionProviderMetadata & { expiresAt: number };

export const meshSessionProviderMetadata = new Map<string, TimestampedSessionMetadata>();

export function getSessionMetadata(key: string): MeshSessionProviderMetadata | undefined {
    const entry = meshSessionProviderMetadata.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        meshSessionProviderMetadata.delete(key);
        return undefined;
    }
    return entry;
}

export const ACTIVE_WORK_POLLING_BACKOFF_MS = 60_000;

export interface MeshPollingGuidance {
    activeGeneratingWork: true;
    generatingCount: number;
    doNotPollBefore: string;
    eventSurface: 'pendingCoordinatorEvents';
    nextRecommendedAction: string;
    message: string;
}

export function buildActiveWorkPollingGuidance(summary: MeshActiveWorkSummary, now = Date.now()): MeshPollingGuidance | undefined {
    if (!summary || summary.generatingCount <= 0) return undefined;
    return {
        activeGeneratingWork: true,
        generatingCount: summary.generatingCount,
        doNotPollBefore: new Date(now + ACTIVE_WORK_POLLING_BACKOFF_MS).toISOString(),
        eventSurface: 'pendingCoordinatorEvents',
        nextRecommendedAction: 'Wait for pendingCoordinatorEvents/completion events or an explicit user status request. If no terminal evidence appears and the user asks for status, make one bounded status check, then wait again.',
        message: 'Do not repeatedly poll mesh_status/mesh_view_queue/mesh_read_chat while delegated work is generating; terminal ledger or completion evidence will be surfaced through pendingCoordinatorEvents when available.',
    };
}


// ─── Helpers ────────────────────────────────────


export const DUPLICATE_DISPATCH_WINDOW_MS = 60_000;

// (queue constants/types moved to ./mesh-queue-helpers.ts)

/**
 * Refresh the MCP process's mesh snapshot from the daemon inline mesh cache.
 * This is required for status/list tools when a previous MCP process already
 * created or removed worktree nodes through clone_mesh_node/remove_mesh_node.
 *
 * REMOTE-WORKTREE-MEMBERSHIP-RESOLVE: the merge is OWNERSHIP-SCOPED rather than
 * a blind replace. `get_mesh` here goes to the LOCAL daemon, which authoritatively
 * knows only the daemons it actually speaks for. A worktree cloned on a REMOTE
 * daemon lives in that remote daemon's cache, so a wholesale splice erased it from
 * the coordinator's own snapshot — after which every membership-resolving op
 * ("is not a member of mesh") hard-failed while mesh_list_nodes still showed it,
 * and the worktree stayed on disk as an orphan.
 *
 * The rule: daemon truth WINS for every node it reports, and absence is a genuine
 * REMOVAL only for nodes the local daemon is actually authoritative about — its
 * OWN (local-worktree / local-daemon-owned) nodes. A node owned by a different
 * daemon is preserved when the payload omits it, because the local daemon merely
 * relays what it has been told about peers and its silence is not evidence of
 * deletion. This keeps stale-worktree revalidation intact (a removed LOCAL
 * worktree still disappears, so callers correctly fall back to removed-node
 * recovery) while no longer discarding remote-owned membership.
 *
 * Cross-daemon removals stay correct through the paths that actually observe
 * them: the explicit remove path splices the node out directly, and the
 * owner-daemon fallback below re-checks with the owner on a real cache miss.
 */
/**
 * Ownership guard for the settled-removal verdict in refreshMeshFromDaemon:
 * true when the node carries explicit daemon/machine identity that is
 * definitively NOT this coordinator's local daemon. Compared under canonical
 * machine-core form (daemonIdsEquivalent), not raw `===`, for the same reason
 * as isDirectLocalNode — stored id forms differ (bare / daemon_ / standalone_
 * prefixes). A node with NO explicit identity returns false: with nothing to
 * disprove local ownership, the local daemon's omission remains the best
 * removal evidence available, so the settled verdict still fires and genuinely
 * removed local worktrees keep dropping out.
 */
function hasDefinitivelyRemoteIdentity(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    const nodeDaemonId = readNodeDaemonId(node as any);
    const nodeMachineId = readNodeMachineId(node as any);
    return Boolean(
        (nodeDaemonId && ctx.localDaemonId && !daemonIdsEquivalent(nodeDaemonId, ctx.localDaemonId))
        || (nodeMachineId && ctx.localMachineId && !daemonIdsEquivalent(nodeMachineId, ctx.localMachineId)),
    );
}

export async function refreshMeshFromDaemon(ctx: MeshContext): Promise<{ settledNodeIds: Set<string> }> {
    // Node ids the local daemon is authoritative about and did NOT report — their
    // removal is settled, so callers must not escalate to the owning daemon.
    const settledNodeIds = new Set<string>();
    try {
        const result = await ctx.transport.command('get_mesh', { meshId: ctx.mesh.id }) as any;
        if (!result?.success || !Array.isArray(result.mesh?.nodes)) return { settledNodeIds };
        const refreshedNodes = result.mesh.nodes
            .filter((n: any) => n?.id)
            .map((n: any) => n as LocalMeshNodeEntry);

        const merged: LocalMeshNodeEntry[] = [...refreshedNodes];
        for (const existing of ctx.mesh.nodes as LocalMeshNodeEntry[]) {
            const existingId = (existing as any)?.id;
            if (!existingId) continue;
            if (merged.some(n => meshNodeIdMatches(n as any, existingId))) continue;

            // The local daemon is authoritative for a node when this payload proves it
            // knows that node's context:
            //  (a) it is a node the local control plane owns outright, or
            //  (b) it is a worktree whose clonedFrom SOURCE node the payload still
            //      reports — the daemon demonstrably tracks this worktree's lineage,
            //      so omitting the worktree means it was genuinely removed.
            // Either way the node must drop out: that is the stale-worktree
            // revalidation callers depend on to fall back to removed-node recovery.
            //
            // Ownership guard (both clauses): a base node is effectively always
            // reported, and isLocalWorktree is stamped relative to the OWNING
            // daemon — so without this check EVERY omitted worktree with a live
            // local source became a settled removal, including ones owned by
            // another daemon that the local daemon never tracked. A node carrying
            // explicit NON-LOCAL daemon/machine identity is remote-owned: the
            // local daemon's silence about it is not evidence of removal, so it
            // is preserved (the owner-daemon fallback in findNodeWithRefresh
            // remains the path that confirms it). Genuine local removals are
            // unaffected: a locally-owned worktree carries LOCAL identity, so the
            // guard is false and the settled verdict still fires.
            if (hasDefinitivelyRemoteIdentity(ctx, existing)) {
                merged.push(existing);
                continue;
            }
            if (isLocalControlPlaneNode(ctx, existing)) { settledNodeIds.add(existingId); continue; }
            const clonedFromNodeId = readString((existing as any)?.clonedFromNodeId)
                || readString((existing as any)?.cloned_from_node_id);
            if (clonedFromNodeId && refreshedNodes.some((n: LocalMeshNodeEntry) => meshNodeIdMatches(n as any, clonedFromNodeId))) {
                settledNodeIds.add(existingId);
                continue;
            }

            // Remote-owned node the local daemon said nothing about — preserve it.
            merged.push(existing);
        }

        (ctx.mesh.nodes as LocalMeshNodeEntry[]).splice(0, ctx.mesh.nodes.length, ...merged);
        ctx.mesh.updatedAt = result.mesh.updatedAt ?? ctx.mesh.updatedAt;
    } catch { /* refresh is best-effort; callers still report their original status/errors */ }
    return { settledNodeIds };
}

export async function syncCoordinatorDaemonMeshCache(ctx: MeshContext): Promise<void> {
    if (!(ctx.transport instanceof IpcTransport)) return;
    try {
        await (ctx.transport as IpcTransport).command('get_mesh', {
            meshId: ctx.mesh.id,
            inlineMesh: ctx.mesh,
        });
    } catch {
        /* cache sync is best-effort; the MCP process still keeps its local ctx.mesh copy */
    }
}

/**
 * REMOTE-WORKTREE-MEMBERSHIP-RESOLVE: last-resort membership resolution for a
 * node the local daemon does not know about.
 *
 * There is no surface that enumerates the daemons participating in a mesh
 * without a node object (node ids are opaque UUIDs and LocalMeshEntry carries
 * no participant list), so this cannot fan out blindly. Instead it asks the
 * OWNING daemons we can actually name — the distinct daemonIds already present
 * in the snapshot, plus the pinned mesh host — reusing the existing
 * `mesh_relay_command` path (transport.meshCommand, the same one commandForNode
 * uses). This only runs on a genuine cache miss, and the winning payload is
 * merged back into ctx.mesh so repeat lookups hit cache instead of re-querying.
 *
 * Returns the resolved node, or a marker distinguishing "no owner reachable"
 * from "definitively not a member".
 */
async function resolveNodeFromOwningDaemons(
    ctx: MeshContext,
    nodeId: string,
): Promise<{ node: LocalMeshNodeEntry | null; ownerUnreachable: boolean }> {
    const transport = ctx.transport as any;
    if (typeof transport?.meshCommand !== 'function') return { node: null, ownerUnreachable: false };

    const localDaemonId = (ctx as any).localDaemonId;
    const candidates: string[] = [];
    const pushCandidate = (id: unknown) => {
        if (typeof id !== 'string' || !id.trim()) return;
        // Compare under canonical machine-core form (daemonIdsEquivalent), NOT a raw
        // `===`: ctx.localDaemonId is the daemon's status instanceId (standalone form
        // `standalone_mach_X`) while a node's daemonId carries the config form
        // `daemon_mach_X`. A raw match misses that equivalence and re-asks the local
        // daemon over meshCommand — the same form mismatch the local refresh already
        // covered.
        if (localDaemonId && daemonIdsEquivalent(id, localDaemonId)) return; // already asked via the local refresh
        if (!candidates.includes(id)) candidates.push(id);
    };
    for (const node of ctx.mesh.nodes as any[]) pushCandidate(node?.daemonId);
    pushCandidate((ctx.mesh as any)?.meshHost?.hostDaemonId);

    if (candidates.length === 0) return { node: null, ownerUnreachable: false };

    let ownerUnreachable = false;
    for (const daemonId of candidates) {
        let result: any;
        try {
            result = await transport.meshCommand(daemonId, 'get_mesh', { meshId: ctx.mesh.id });
        } catch {
            // The owner may simply be offline — that is NOT evidence of non-membership.
            ownerUnreachable = true;
            continue;
        }
        const nodes = result?.mesh?.nodes ?? result?.result?.mesh?.nodes;
        if (!result?.success || !Array.isArray(nodes)) {
            if (result && result.success === false) ownerUnreachable = true;
            continue;
        }
        const found = nodes.find((n: any) => n?.id && meshNodeIdMatches(n as any, nodeId));
        if (!found) continue;

        // Cache the resolution so subsequent lookups short-circuit locally.
        const existingIndex = ctx.mesh.nodes.findIndex(n => meshNodeIdMatches(n as any, nodeId));
        if (existingIndex >= 0) (ctx.mesh.nodes as any[])[existingIndex] = found;
        else (ctx.mesh.nodes as any[]).push(found);
        return { node: found as LocalMeshNodeEntry, ownerUnreachable: false };
    }
    return { node: null, ownerUnreachable };
}

export async function findNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry> {
    const hit = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (hit && !hit.isLocalWorktree) return hit;

    const { settledNodeIds } = await refreshMeshFromDaemon(ctx);

    const refreshed = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (refreshed) return refreshed;

    // The local daemon was authoritative and dropped it — a settled removal, so do
    // not escalate to the owning daemon (that would turn a known removal into a
    // spurious "owner unreachable" and add a pointless remote round-trip).
    if (settledNodeIds.has(nodeId)) {
        throw new Error(`Node '${nodeId}' is not a member of mesh '${ctx.mesh.name}'`);
    }

    const owned = await resolveNodeFromOwningDaemons(ctx, nodeId);
    if (owned.node) return owned.node;
    if (owned.ownerUnreachable) {
        // "Owner unreachable" is a transport condition, not a membership verdict —
        // callers must not treat it as proof the node is gone (and must not clean
        // up on the strength of it).
        const err = new Error(
            `Node '${nodeId}' could not be resolved: the daemon that owns it is unreachable. `
            + `This is NOT proof of non-membership — retry once the owning daemon is online.`,
        ) as Error & { code?: string };
        err.code = 'mesh_node_owner_unreachable';
        throw err;
    }
    throw new Error(`Node '${nodeId}' is not a member of mesh '${ctx.mesh.name}'`);
}

export async function findOptionalNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry | null> {
    const hit = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (hit && !hit.isLocalWorktree) return hit;

    const { settledNodeIds } = await refreshMeshFromDaemon(ctx);

    const refreshed = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (refreshed) return refreshed;

    // Settled removal (see findNodeWithRefresh) — report absence without escalating.
    if (settledNodeIds.has(nodeId)) return null;

    const owned = await resolveNodeFromOwningDaemons(ctx, nodeId);
    return owned.node;
}

export function hasRecentDuplicateDispatch(ctx: MeshContext, args: { node_id: string; session_id?: string; message: string }): { duplicate: boolean; entry?: any; source?: 'ledger' | 'queue' } {
    const now = Date.now();
    const normalizedMessage = args.message.trim();

    for (const task of getQueue(ctx.mesh.id)) {
        const timestamp = new Date(task.updatedAt || task.createdAt).getTime();
        if (!Number.isFinite(timestamp) || now - timestamp > DUPLICATE_DISPATCH_WINDOW_MS) continue;
        if (task.targetNodeId && task.targetNodeId !== args.node_id) continue;
        if (task.assignedNodeId && task.assignedNodeId !== args.node_id) continue;
        if (args.session_id && task.targetSessionId !== args.session_id && task.assignedSessionId !== args.session_id) continue;
        if (task.message?.trim() === normalizedMessage) {
            return { duplicate: true, entry: task, source: 'queue' };
        }
    }

    const entries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const timestamp = new Date(entry.timestamp).getTime();
        if (Number.isFinite(timestamp) && now - timestamp > DUPLICATE_DISPATCH_WINDOW_MS) break;
        if (entry.kind !== 'task_dispatched') continue;
        if (entry.nodeId !== args.node_id) continue;
        if (args.session_id && entry.sessionId !== args.session_id) continue;
        if (typeof entry.payload?.message !== 'string') continue;
        if (entry.payload.message.trim() === normalizedMessage) {
            return { duplicate: true, entry, source: 'ledger' };
        }
    }
    return { duplicate: false };
}

/**
 * MISSION-STATUS-TASK-WARNING: a task can be attached to a mission
 * (mission_id) via mesh_enqueue_task / mesh_send_task at any time, but
 * mission status is NEVER auto-transitioned by the system — only an explicit
 * mesh_mission_upsert moves it. A coordinator that paused/completed/abandoned
 * a mission and then attaches a new task to it (often by habit, reusing an
 * id from context) silently leaves the mission looking inactive while work is
 * in flight against it — the mission list then misrepresents what's actually
 * happening. This is warn-only, mirroring the G4 duplicateSuspect convention:
 * the task still enqueues/dispatches; the response just carries a hint so the
 * coordinator notices and can mesh_mission_upsert the status back to active
 * if that was not intentional. Returns undefined for an active mission, an
 * absent mission_id, or an unknown mission id (nothing to warn about — an
 * unknown id is a different problem, not this one).
 */
export function buildMissionInactiveWarning(
    ctx: MeshContext,
    missionId: string | undefined,
): { missionInactive: { missionId: string; status: string; title: string }; missionInactiveHint: string } | undefined {
    if (!missionId) return undefined;
    const mission = getMeshMission(ctx.mesh.id, missionId);
    if (!mission || mission.status === 'active') return undefined;
    const hintByStatus: Record<string, string> = {
        paused: `Mission '${missionId}' (${mission.title}) is paused — a new task was just attached to it anyway. Mission status is never auto-transitioned; if this mission should be active again, call mesh_mission_upsert(mission_id: '${missionId}', status: 'active').`,
        completed: `Mission '${missionId}' (${mission.title}) is already marked completed — a new task was just attached to it anyway. If this is intentional follow-up work (e.g. a regression fix or post-deploy verification), consider whether it belongs on a new mission, or reopen this one via mesh_mission_upsert(mission_id: '${missionId}', status: 'active') if it isn't actually done.`,
        abandoned: `Mission '${missionId}' (${mission.title}) is marked abandoned — a new task was just attached to it anyway. If this mission is being revived, call mesh_mission_upsert(mission_id: '${missionId}', status: 'active').`,
    };
    const hint = hintByStatus[mission.status]
        ?? `Mission '${missionId}' (${mission.title}) is not active (status: '${mission.status}') — a new task was just attached to it anyway. Mission status is never auto-transitioned; call mesh_mission_upsert(mission_id: '${missionId}', status: 'active') if that was not intentional.`;
    return {
        missionInactive: { missionId, status: mission.status, title: mission.title },
        missionInactiveHint: hint,
    };
}

export function buildMissingNodeReadChatRecovery(ctx: MeshContext, args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean }): Record<string, unknown> {
    const entries = readLedgerEntries(ctx.mesh.id, { tail: 300 });
    const relatedEntries = entries.filter(entry => entry.nodeId === args.node_id || entry.sessionId === args.session_id);
    const completedEntries = relatedEntries.filter(entry => entry.kind === 'task_completed');
    const lastDispatch = [...relatedEntries].reverse().find(entry => entry.kind === 'task_dispatched');
    const lastTerminal = [...relatedEntries].reverse().find(entry => entry.kind === 'task_completed' || entry.kind === 'task_failed' || entry.kind === 'task_stalled');
    const lastRemoved = [...relatedEntries].reverse().find(entry => entry.kind === 'node_removed');
    const lastLaunch = [...relatedEntries].reverse().find(entry => entry.kind === 'session_launched');
    const providerSessionId = args.provider_session_id
        || readString(lastTerminal?.payload?.providerSessionId)
        || readString(lastLaunch?.payload?.providerSessionId)
        || readString(lastDispatch?.payload?.providerSessionId);
    const finalSummary = readString(lastTerminal?.payload?.finalSummary)
        || readString(lastTerminal?.payload?.compactSummary)
        || readString(lastTerminal?.payload?.summary);
    const ledger = {
        taskCompletedFound: completedEntries.length > 0,
        nodeRemovedFound: !!lastRemoved,
        providerType: lastTerminal?.providerType || lastLaunch?.providerType || lastDispatch?.providerType,
        providerSessionId,
        nodeRemovedAt: lastRemoved?.timestamp,
        sessionCleanupMode: readString(lastRemoved?.payload?.sessionCleanupMode),
        readDebugLocator: readString(lastTerminal?.payload?.readDebugLocator) || readString(lastTerminal?.payload?.debugBundlePath),
    };

    if (finalSummary) {
        if (args.compact === true) {
            return {
                ...compactChatPayload({
                    success: true,
                    status: 'idle',
                    providerSessionId,
                    summary: finalSummary,
                    messages: [{ role: 'assistant', content: finalSummary, isHistorical: true }],
                }, {
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    limit: args.tail ?? 10,
                }),
                recoveredFromLedger: true,
                ledger,
            };
        }
        return {
            success: true,
            compact: false,
            recoveredFromLedger: true,
            nodeId: args.node_id,
            sessionId: args.session_id,
            summary: finalSummary,
            ledger,
            messages: [{ role: 'assistant', content: finalSummary, isHistorical: true }],
        };
    }

    return {
        success: false,
        recoverable: true,
        code: 'mesh_removed_node_transcript_unavailable',
        error: `Node '${args.node_id}' is not a current member of mesh '${ctx.mesh.name}'.`,
        nodeId: args.node_id,
        sessionId: args.session_id,
        providerSessionId,
        reason: 'node_not_in_current_mesh_snapshot',
        ledger,
        completedSessionSeenInLedger: ledger.taskCompletedFound,
        lastDispatch: lastDispatch ? {
            timestamp: lastDispatch.timestamp,
            sessionId: lastDispatch.sessionId,
            providerType: lastDispatch.providerType,
            taskId: typeof lastDispatch.payload?.taskId === 'string' ? lastDispatch.payload.taskId : undefined,
            messagePreview: typeof lastDispatch.payload?.message === 'string' ? lastDispatch.payload.message.slice(0, 500) : undefined,
        } : null,
        lastTerminalEvent: lastTerminal ? {
            kind: lastTerminal.kind,
            timestamp: lastTerminal.timestamp,
            sessionId: lastTerminal.sessionId,
            providerType: lastTerminal.providerType,
            taskId: typeof lastTerminal.payload?.taskId === 'string' ? lastTerminal.payload.taskId : undefined,
            payload: lastTerminal.payload,
        } : null,
        nextSteps: [
            providerSessionId
                ? `Retry mesh_read_chat with provider_session_id='${providerSessionId}' on a current live node for the same daemon if one exists.`
                : 'If the node UI shows a provider transcript id, retry mesh_read_chat/mesh_read_debug with provider_session_id.',
            'Use mesh_read_debug with the provider_session_id or daemon-side debug bundle locator if available.',
            'Check mesh_task_history for task_completed and node_removed entries before redispatching; do not resend solely because transcript recovery failed.',
            'If this node was removed with stop_and_delete, the runtime transcript may be gone; rely on the ledger summary/locator or ask the operator for the saved UI output.',
        ],
        recoveryHints: [
            'The worktree/node may have been removed or the mesh snapshot may be stale after task completion.',
            'If you have a provider_session_id, retry mesh_read_chat with that value while targeting a live node for the same daemon if available.',
            'Use mesh_read_debug with provider_session_id, or inspect the daemon/session-host history locator if the transcript has already been archived.',
            'Avoid redispatching the same task solely because read_chat could not recover the transcript; check task_history and git status first.',
        ],
    };
}


// (queue helpers moved to ./mesh-queue-helpers.ts)

// (moved to ./mesh-session-helpers.ts — session/payload record helpers)


// §8 unit 8: direct-dispatch transcript reconciliation moved to its own module
// (`check:file-sizes` decomposition — this file is a frozen baseline). Re-exported
// here so `mesh-tools-status` / `-session` / `-queue` keep importing from this barrel.
export {
    buildDirectDispatchReconciliationCandidates,
    reconcileDirectDispatchesFromTranscriptEvidence,
} from './mesh-direct-dispatch-reconcile.js';

export async function triggerMeshQueueAndReport(
    ctx: MeshContext,
): Promise<Record<string, unknown> | undefined> {
    try {
        // trigger_mesh_queue is a coordinator-only operation: triggerMeshQueue
        // reads the mesh object, the coordinator's local CLI instances, and the
        // queue ledger (stored on THIS machine), then dispatches assignments to
        // remote idle sessions over P2P itself. Relaying trigger_mesh_queue to a
        // remote worker daemon would hit requireMeshHostMutationOwner →
        // getMeshForCommand → null ('Mesh not found'), because only the
        // coordinator daemon hosts the mesh. Always run it on the coordinator's
        // local IPC, regardless of which node prompted the trigger.
        const raw = await ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id });
        const payload = unwrapCommandPayload(raw);
        const trigger = payload?.trigger && typeof payload.trigger === 'object' ? payload.trigger : payload;
        return trigger && typeof trigger === 'object' ? trigger : { success: true };
    } catch (e: any) {
        return {
            success: false,
            error: e?.message || String(e),
        };
    }
}



// (moved to ./mesh-session-helpers.ts — session/payload record helpers)


export function buildRelayUnsafeRemoteSessionFailure(ctx: MeshContext, node: LocalMeshNodeEntry, sessionId: string, providerType?: string): ({ success: false; error: string } & Record<string, unknown>) {
    return {
        success: false,
        recoverable: true,
        code: 'mesh_delegate_session_missing_relay_metadata',
        reason: 'mesh_delegate_session_missing_relay_metadata',
        transport: 'mesh_transport',
        retryRecommended: true,
        meshId: ctx.mesh.id,
        nodeId: node.id,
        daemonId: node.daemonId,
        workspace: node.workspace,
        sessionId,
        unsafeTranscriptAlias: true,
        ...(providerType ? { resolvedProviderType: providerType } : {}),
        error: `Remote session '${sessionId}' is not relay-safe for mesh '${ctx.mesh.id}': missing meshNodeFor/meshCoordinatorDaemonId metadata, so completion events would not reach the coordinator ledger. This session may be the coordinator itself or an unrelated session (unsafe_transcript_alias risk).`,
        nextAction: `Launch a fresh relay-safe session with mesh_launch_session(node_id: '${node.id}'${providerType ? `, type: '${providerType}'` : ''}) or dispatch without session_id so Repo Mesh can choose a valid delegate session.`,
        noFallbackReason: 'Blindly reusing a remote session without mesh relay metadata would silently drop task_completed / generating_completed events.',
    };
}

export function buildMissingCoordinatorDaemonIdFailure(ctx: MeshContext, node: LocalMeshNodeEntry, providerType?: string): ({ success: false; error: string } & Record<string, unknown>) {
    return {
        success: false,
        recoverable: true,
        code: 'mesh_coordinator_daemon_unknown',
        reason: 'mesh_coordinator_daemon_unknown',
        transport: 'mesh_transport',
        retryRecommended: true,
        meshId: ctx.mesh.id,
        nodeId: node.id,
        daemonId: node.daemonId,
        workspace: node.workspace,
        ...(providerType ? { resolvedProviderType: providerType } : {}),
        error: `Cannot launch a remote mesh delegate for node '${node.id}': coordinator daemon identity is unavailable, so the worker would be unable to relay completion events back to the coordinator.`,
        nextAction: 'Retry after the coordinator daemon identity is available (for example from an attached daemon-backed MCP session) so meshCoordinatorDaemonId can be stamped on the worker session.',
        noFallbackReason: 'Launching without meshCoordinatorDaemonId would create a worker session that can finish work but cannot emit task_completed / generating_completed back to the coordinator.',
    };
}



// (compact git-snapshot helpers moved to ./mesh-compact.ts)

// (compactMeshStatusNode moved to ./mesh-compact.ts)

// Compact mode bounds the node array so the payload stays under the MCP token cap
// regardless of how many worktree nodes a mesh has. EVERY node stays present and
// individually addressable (coordinators look nodes up by id), but "quiet" nodes —
// healthy/clean, no sessions, nothing to converge — are reduced to a minimal stub
// (id/workspace/health/branch/launchReady + branchConvergence decision scalars)
// while "noteworthy" nodes (anything actionable) keep the full compact detail. On
// top of that the detailed set is held to a serialized byte budget (highest
// severity first); when the budget is exceeded the lowest-priority detailed nodes
// degrade to the same minimal stub so even a mesh of all-noteworthy nodes can't
// blow the cap. No node is ever dropped — only its detail level is reduced.
//
// Raised 9000 -> 32000; see the sizing rationale on
// COMPACT_NODES_TOTAL_BYTE_BUDGET below (measured 23-node zero-fold target).
// One representative node per daemon is pinned ahead of this budget entirely
// (pinnedRepresentativeNodeIds), so a machine node is never folded for bytes.
export const COMPACT_DETAILED_NODES_BYTE_BUDGET = 32000;

// Total byte budget for the whole compact node array (detail + minimal stubs).
// Nodes that don't fit even as a stub are folded into a counts+id-list summary so
// the array stays bounded on pathologically large meshes; every node id is still
// listed in foldedNodes.nodeIds, so nothing becomes undiscoverable.
//
// This must leave headroom for the compact payload's FIXED top-level overhead
// (branchConvergenceSummary, staleDaemonBuild* aggregates, activeWork*/ledger/
// scheduling summaries, sourceOfTruth/hints) so the whole compact string stays
// within the payload target even for an all-noteworthy mesh (the contract asserted
// by mesh-compact-payload-budget.test.ts).
//
// Raised 11500 -> 40000 (with the detail budget 9000 -> 32000) to hit the operating
// target of 20 worktrees + 3 machines = 23 nodes with ZERO folding. The old values
// were sized against a 25KB self-imposed cap that dated from a live mesh_status of
// ~76KB; there is no hard byte limit in the MCP SDK or the IPC transport, so that
// number was cost self-regulation, not a protocol constraint. Folding a node is far
// more expensive than the bytes it saves — a folded node loses its daemonId, so a
// whole machine could disappear from a deploy roster.
//
// Chosen by measurement, not estimate. On a synthetic worst-case 23-node mesh (3
// machines + 20 DIRTY worktrees, each with a stale daemon build and an out-of-sync
// submodule), the zero-fold threshold is detail=30000/total=37000 at ~43.7KB;
// 32000/40000 clears it with margin at 44,784B and still degrades gracefully (a
// 30-node mesh folds 5 rather than blowing up). Realistic meshes — where most
// worktrees are clean and therefore stubbed, not detailed — sit far below this.
export const COMPACT_NODES_TOTAL_BYTE_BUDGET = 40000;


// Byte budget for the whole compact `missions` array (live active/paused missions).
// Completed/abandoned history is already folded to a counts+id summary upstream;
// this bounds the LIVE-mission detail so the section can't grow unbounded with the
// number of active/paused missions. Newest-active first; overflow is folded into
// `foldedMissions` (id list) so every live mission id stays addressable.
export const COMPACT_MISSIONS_BYTE_BUDGET = 6000;


// (compact node-fold helpers moved to ./mesh-compact.ts)


export function buildRecoverableLaunchFailure(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    providerType: string | undefined,
    error: unknown,
): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error || 'launch failed');
    const classified = classifyMeshLaunchFailure(error);
    const cleanup = buildWorktreeCleanupHint(node);
    return {
        success: false,
        recoverable: classified.recoverable,
        code: classified.code,
        reason: classified.reason,
        transport: classified.transport,
        retryRecommended: classified.retryRecommended,
        nextAction: classified.nextAction,
        ...(classified.noFallbackReason ? { noFallbackReason: classified.noFallbackReason } : {}),
        error: message,
        meshId: ctx.mesh.id,
        nodeId: node.id,
        daemonId: node.daemonId,
        workspace: node.workspace,
        isLocalWorktree: node.isLocalWorktree === true,
        worktreeBranch: node.worktreeBranch,
        clonedFromNodeId: node.clonedFromNodeId,
        ...(providerType ? { resolvedProviderType: providerType } : {}),
        retryHint: `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ''}) after daemon mesh transport/P2P is healthy.`,
        ...(cleanup ? { cleanup } : {}),
        nextStepHints: [
            `Retry mesh_launch_session(node_id: "${node.id}"${providerType ? `, type: "${providerType}"` : ''}) after checking daemon/P2P health.`,
            ...(cleanup ? [`Cleanup orphan worktree node with mesh_remove_node(node_id: "${node.id}") if retry is not desired.`] : []),
            'Run mesh_status to see the degraded reason and recovery hints before redispatching work.',
        ],
    };
}

export function recordRecoverableLaunchFailure(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    providerType: string | undefined,
    error: unknown,
): Record<string, unknown> {
    const failure = buildRecoverableLaunchFailure(ctx, node, providerType, error);
    try {
        appendLedgerEntry(ctx.mesh.id, {
            kind: 'recovery_attempted',
            nodeId: node.id,
            providerType,
            payload: {
                event: 'session_launch_failed',
                ...failure,
            },
        });
    } catch { /* ledger append is best-effort */ }
    return failure;
}

export function getLatestActiveLaunchFailure(meshId: string, nodeId: string): Record<string, unknown> | null {
    const entries = readLedgerEntries(meshId, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.nodeId !== nodeId) continue;
        if (entry.kind === 'session_launched' || entry.kind === 'node_removed') return null;
        if (entry.kind === 'recovery_attempted' && entry.payload?.event === 'session_launch_failed') {
            return { timestamp: entry.timestamp, ...entry.payload };
        }
    }
    return null;
}

export type RemoteAgentDispatchResult =
    | { success: true; dispatched: true; sessionId: string; providerType?: string }
    | ({ success: false; error: string } & Record<string, unknown>);

export function buildCoordinatorP2pRelayFailure(
    error: unknown,
    context: { command: string; targetDaemonId?: string; nodeId?: string; sessionId?: string },
): { success: false; error: string } & Record<string, unknown> {
    const payload = buildP2pRelayFailurePayload(error, {
        command: context.command,
        targetDaemonId: context.targetDaemonId,
    });
    return {
        ...payload,
        ...(context.nodeId ? { nodeId: context.nodeId } : {}),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        retryHint: payload.retryRecommended ? payload.nextAction : 'Do not retry as a P2P transport recovery; inspect the command/provider error first.',
    };
}


/**
 * For IpcTransport + remote node: resolve an active session on the node and
 * dispatch an agent_command directly via P2P relay (mesh_relay_command).
 *
 * This bypasses the local queue (which remote daemons cannot read) and sends
 * the message directly to the session running on the remote daemon.
 *
 * Returns { success, sessionId } or throws.
 */
export async function ipcDispatchToRemoteAgent(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    args: {
        session_id?: string;
        message: string;
        /** MESH-IMAGE-DISPATCH: optional multipart envelope forwarded to the remote agent. */
        input?: { parts: Array<Record<string, unknown>> };
        providerType?: string;
        verifiedSession?: any;
        meshContext?: { meshId: string; nodeId?: string; taskId?: string; coordinatorDaemonId?: string };
    },
): Promise<RemoteAgentDispatchResult> {
    const transport = ctx.transport as IpcTransport;
    const daemonId = node.daemonId!;

    // The coordinator anchor the remote router will stamp onto the worker session
    // at dispatch time (router.ts buildMeshWorkerRelayStamp). When present, a
    // mesh-owned session that was never launch-stamped can still self-heal to
    // relay-safe — exactly like the local direct-dispatch path.
    const dispatchCoordinatorDaemonId = readString(args.meshContext?.coordinatorDaemonId) || '';

    let sessionId = args.session_id?.trim() || '';
    // Resolve provider type: caller arg > node policy providerPriority (slots-derived
    // when unset — readProviderPriority applies the fallback) > empty (fuzzy fallback)
    const providerPriorityList: string[] = readProviderPriority(node.policy);
    let resolvedProviderType = args.providerType?.trim() || providerPriorityList[0] || '';

    // Ask the remote daemon for live session truth when we need to auto-pick a
    // delegate session, or when an explicit session_id must be verified as a
    // relay-safe mesh-owned worker before we dispatch into it.
    if (sessionId && args.verifiedSession) {
        const explicitSession = args.verifiedSession;
        const relaySafety = classifyRemoteDelegateRelaySafety(explicitSession, ctx.mesh.id, node.id, dispatchCoordinatorDaemonId);
        if (relaySafety === 'unsafe_alias') {
            return buildRelayUnsafeRemoteSessionFailure(
                ctx,
                node,
                sessionId,
                resolvedProviderType || resolveSessionProviderType(explicitSession) || undefined,
            );
        }
        if (relaySafety === 'missing_anchor') {
            return buildMissingCoordinatorDaemonIdFailure(
                ctx,
                node,
                resolvedProviderType || resolveSessionProviderType(explicitSession) || undefined,
            );
        }
        // 'safe' or 'self_heal' → dispatch; the remote router stamps the relay
        // anchor from meshContext.coordinatorDaemonId when self-healing.
        if (!resolvedProviderType) {
            resolvedProviderType = resolveSessionProviderType(explicitSession);
        }
    } else if (!sessionId || args.session_id) {
        try {
            const relayResult = await transport.meshCommand(daemonId, 'get_status_metadata', {});
            const sessions = extractStatusMetadataSessions(relayResult);

            if (sessionId) {
                const explicitSession = sessions.find(session => readSessionRecordId(session) === sessionId);
                if (!explicitSession) {
                    return {
                        success: false,
                        recoverable: true,
                        code: 'mesh_target_session_not_found',
                        reason: 'mesh_target_session_not_found',
                        transport: 'mesh_transport',
                        retryRecommended: true,
                        meshId: ctx.mesh.id,
                        nodeId: node.id,
                        daemonId,
                        workspace: node.workspace,
                        sessionId,
                        ...(resolvedProviderType ? { resolvedProviderType } : {}),
                        error: `Remote session '${sessionId}' is not present in the live status for node '${node.id}'.`,
                        nextAction: `Launch a fresh session with mesh_launch_session(node_id: '${node.id}'${resolvedProviderType ? `, type: '${resolvedProviderType}'` : ''}) or retry without session_id so Repo Mesh can target a live delegate session.`,
                    };
                }
                const relaySafety = classifyRemoteDelegateRelaySafety(explicitSession, ctx.mesh.id, node.id, dispatchCoordinatorDaemonId);
                if (relaySafety === 'unsafe_alias') {
                    return buildRelayUnsafeRemoteSessionFailure(
                        ctx,
                        node,
                        sessionId,
                        resolvedProviderType || resolveSessionProviderType(explicitSession) || undefined,
                    );
                }
                if (relaySafety === 'missing_anchor') {
                    return buildMissingCoordinatorDaemonIdFailure(
                        ctx,
                        node,
                        resolvedProviderType || resolveSessionProviderType(explicitSession) || undefined,
                    );
                }
                // 'safe' or 'self_heal' → dispatch; the remote router stamps the
                // relay anchor from meshContext.coordinatorDaemonId when self-healing.
                if (!resolvedProviderType) {
                    resolvedProviderType = resolveSessionProviderType(explicitSession);
                }
            } else {
                // Prefer live idle sessions launched for this mesh node. Never route
                // a new task into restored/stopped session records; that produces the
                // coordinator-visible "pending only, chat never received it" failure.
                const targetSession = chooseDispatchableSession(sessions, resolvedProviderType, ctx.mesh.id, node.id, dispatchCoordinatorDaemonId);

                if (targetSession?.id || targetSession?.sessionId) {
                    sessionId = targetSession.id || targetSession.sessionId;
                    if (!resolvedProviderType) {
                        resolvedProviderType = resolveSessionProviderType(targetSession);
                    }
                }
            }
        } catch (e: any) {
            if (sessionId) {
                return {
                    ...buildCoordinatorP2pRelayFailure(e, {
                        command: 'get_status_metadata',
                        targetDaemonId: daemonId,
                        nodeId: node.id,
                        sessionId,
                    }),
                    success: false,
                    error: `Cannot verify remote session '${sessionId}' before dispatch: ${e?.message || String(e)}`,
                };
            }
            // fall through — will attempt dispatch with just providerType (fuzzy)
        }
    }

    // agent_command requires agentType — fail if we cannot determine provider type
    if (!resolvedProviderType) {
        return { success: false, error: `Cannot dispatch to remote node '${node.id}': providerType unknown. Set providerPriority on the node policy or call mesh_launch_session first.` };
    }

    try {
        const dispatchResult = await transport.meshCommand(daemonId, 'agent_command', {
            ...(sessionId ? { targetSessionId: sessionId } : {}),
            agentType: resolvedProviderType,
            cliType: resolvedProviderType,
            action: 'send_chat',
            message: args.message,
            // MESH-IMAGE-DISPATCH: forward the attachment over P2P. Oversized payloads are
            // split by the mesh transport's frame chunking (daemon-mesh-manager
            // writeEnvelope) and reassembled on the worker before the command is handled.
            ...(args.input ? { input: args.input } : {}),
            // DISPATCH-SOURCE-TRACE: call-site tag echoed in the worker daemon log.
            dispatchSource: 'mesh-tools-internal:ipcDispatchToRemoteAgent',
            // WTCLAIM (B): carry the node workspace so a sessionless dispatch can be
            // scoped to THIS node's session on the worker (findAdapter dir match /
            // findMeshNodeAdapter). Without it, a worker hosting both a base node and a
            // cloned worktree node (same daemonId) would fall through to a provider-only
            // fuzzy match and could land worktree work on the base session.
            ...(node.workspace ? { dir: node.workspace } : {}),
            ...(args.meshContext ? { meshContext: args.meshContext } : {}),
        });
        const dispatchPayload = unwrapCommandPayload(dispatchResult);
        if (dispatchPayload?.success === false || dispatchResult?.success === false) {
            const source = dispatchPayload?.success === false ? dispatchPayload : dispatchResult;
            const errorMessage = dispatchPayload?.error || dispatchResult?.error || 'agent_command rejected the task';
            return {
                ...buildCoordinatorP2pRelayFailure(source?.error || errorMessage, {
                    command: 'agent_command',
                    targetDaemonId: daemonId,
                    nodeId: node.id,
                    sessionId,
                }),
                ...(source && typeof source === 'object' ? source : {}),
                success: false,
                error: `P2P dispatch failed: ${errorMessage}`,
            };
        }
        // Do NOT fall back to resolvedProviderType for sessionId: a sessionless
        // dispatch (no targetSessionId above) lets the worker pick/create the real
        // session, so the provider type ('claude-cli', …) is NOT a session id.
        // Returning it here used to poison assigned_session_id downstream, breaking
        // findAssignedBySession (provider type vs real session id) and orphaning the
        // task_completed match. Leave it empty so completion matching falls back to
        // taskId via the meshContext.taskId carried in the dispatch.
        return { success: true, dispatched: true, sessionId: sessionId || '', providerType: resolvedProviderType };
    } catch (e: any) {
        const errorMessage = e?.message || String(e);
        return {
            ...buildCoordinatorP2pRelayFailure(e, {
                command: 'agent_command',
                targetDaemonId: daemonId,
                nodeId: node.id,
                sessionId,
            }),
            error: `P2P dispatch failed: ${errorMessage}`,
        };
    }
}

export function meshSessionCacheKey(nodeId: string, runtimeSessionId: string): string {
    return `${nodeId}:${runtimeSessionId}`;
}

export function rememberMeshSessionProviderMetadata(
    nodeId: string | undefined,
    runtimeSessionId: string | undefined,
    metadata: MeshSessionProviderMetadata,
): void {
    const keyNodeId = readString(nodeId);
    const keySessionId = readString(runtimeSessionId);
    if (!keyNodeId || !keySessionId) return;
    const providerType = readString(metadata.providerType);
    const providerSessionId = readString(metadata.providerSessionId);
    if (!providerType && !providerSessionId) return;
    const existing = getSessionMetadata(meshSessionCacheKey(keyNodeId, keySessionId)) || { providerType: '' };
    meshSessionProviderMetadata.set(meshSessionCacheKey(keyNodeId, keySessionId), {
        providerType: providerType || existing.providerType,
        providerSessionId: providerSessionId || existing.providerSessionId,
        expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
    });
}

export function rememberMeshSessionProviderMetadataFromEvent(event: any): void {
    const metadataEvent = event?.metadataEvent && typeof event.metadataEvent === 'object'
        ? event.metadataEvent as Record<string, unknown>
        : event && typeof event === 'object'
            ? event as Record<string, unknown>
            : {};
    const nodeId = readString(event?.nodeId) || readString(metadataEvent.nodeId) || readString(metadataEvent.meshNodeId);
    const sessionId = readString(metadataEvent.targetSessionId)
        || readString(metadataEvent.sessionId)
        || readString(metadataEvent.instanceId)
        || readString(event?.sessionId);
    rememberMeshSessionProviderMetadata(nodeId, sessionId, {
        providerType: readString(metadataEvent.providerType) || readString(event?.providerType) || '',
        providerSessionId: readString(metadataEvent.providerSessionId) || readString(event?.providerSessionId),
    });
}

export function resolveMeshSessionProviderMetadataFromLedger(
    ctx: MeshContext,
    nodeId: string,
    runtimeSessionId: string,
): MeshSessionProviderMetadata | undefined {
    const entries = readLedgerEntries(ctx.mesh.id, { tail: 50 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
            ? entry.payload as Record<string, unknown>
            : {};
        const entryNodeId = readString(entry.nodeId) || readString(payload.nodeId) || readString(payload.meshNodeId);
        if (entryNodeId && entryNodeId !== nodeId) continue;
        const entrySessionId = readString(entry.sessionId)
            || readString(payload.targetSessionId)
            || readString(payload.sessionId)
            || readString(payload.instanceId);
        if (entrySessionId !== runtimeSessionId) continue;
        const providerType = readString(entry.providerType) || readString(payload.providerType);
        const completionDiagnostic = payload.completionDiagnostic && typeof payload.completionDiagnostic === 'object' && !Array.isArray(payload.completionDiagnostic)
            ? payload.completionDiagnostic as Record<string, unknown>
            : {};
        const metadataEvent = payload.metadataEvent && typeof payload.metadataEvent === 'object' && !Array.isArray(payload.metadataEvent)
            ? payload.metadataEvent as Record<string, unknown>
            : {};
        const providerSessionId = readString(payload.providerSessionId)
            || readString(completionDiagnostic.providerSessionId)
            || readString(metadataEvent.providerSessionId);
        if (providerType || providerSessionId) {
            return { providerType: providerType || '', providerSessionId };
        }
    }
    return undefined;
}

export function resolveMeshSessionProviderMetadata(
    ctx: MeshContext,
    nodeId: string,
    runtimeSessionId: string,
): MeshSessionProviderMetadata | undefined {
    const cached = getSessionMetadata(meshSessionCacheKey(nodeId, runtimeSessionId));
    if (cached?.providerType || cached?.providerSessionId) return cached;
    const fromLedger = resolveMeshSessionProviderMetadataFromLedger(ctx, nodeId, runtimeSessionId);
    if (fromLedger) rememberMeshSessionProviderMetadata(nodeId, runtimeSessionId, fromLedger);
    return fromLedger;
}





export async function collectRelatedRepoStatuses(ctx: MeshContext, node: LocalMeshNodeEntry): Promise<Array<Record<string, unknown>>> {
    const relatedRepos = readRelatedRepos(node);
    if (!relatedRepos.length) return [];

    const results: Array<Record<string, unknown>> = [];
    for (const repo of relatedRepos) {
        try {
            // OFFLINE-NODE-STATUS-REFRESH: related-repo status is part of the mesh_status
            // per-node assembly — mark it status-origin for the SHORT connect-wait budget.
            const statusResult = await commandForNode(ctx, node, 'git_status', { workspace: repo.workspace, refreshUpstream: true }, { statusProbe: true });
            const status = extractGitStatus(statusResult);
            results.push(summarizeRelatedRepoStatus(repo, status));
        } catch (e: any) {
            results.push({
                label: repo.label,
                workspace: repo.workspace,
                error: e?.message || 'related repo status failed',
            });
        }
    }
    return results;
}



export async function collectLiveStatusSessions(ctx: MeshContext, node: LocalMeshNodeEntry): Promise<any[]> {
    try {
        const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
        return extractStatusMetadataSessions(statusResult);
    } catch {
        return [];
    }
}

// Same probe as collectLiveStatusSessions, but distinguishes "probe succeeded and
// found zero sessions" from "probe failed/timed out" — collectLiveStatusSessions
// collapses both to `[]`, which is fine for its callers (fall back to the persisted
// snapshot either way) but is NOT safe as staleness evidence: a failed probe must
// never be treated as proof a session is gone.
async function collectLiveStatusSessionsVerified(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
): Promise<{ sessions: any[]; verified: boolean }> {
    try {
        const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
        return { sessions: extractStatusMetadataSessions(statusResult), verified: true };
    } catch {
        return { sessions: [], verified: false };
    }
}


/**
 * One get_status_metadata probe → the live session list, the daemon's build
 * stamp (including its explicitly reported release track), and any
 * failed-upgrade notice. Used by mesh_status so a single
 * daemon-wide probe yields the sessions, the `daemonBuild` field
 * (commit/version of the running daemon) AND `upgradeFailure`.
 */
export async function collectLiveStatusProbe(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
): Promise<{
    sessions: any[];
    daemonId?: string;
    daemonBuild?: { commit: string; commitShort: string; version: string; builtAt?: string; track: 'stable' | 'preview' | 'unknown' };
    upgradeFailure?: MeshUpgradeFailureSummary;
}> {
    try {
        // OFFLINE-NODE-STATUS-REFRESH: part of the mesh_status per-node assembly — mark it
        // status-origin so the relay to an offline peer uses the SHORT connect-wait budget.
        const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {}, { statusProbe: true });
        const payload = unwrapCommandPayload(statusResult);
        return {
            sessions: extractStatusMetadataSessions(statusResult),
            ...(readString(payload?.status?.instanceId) ? { daemonId: readString(payload.status.instanceId) } : {}),
            daemonBuild: extractDaemonBuildInfo(statusResult),
            upgradeFailure: extractUpgradeFailureSummary(statusResult),
        };
    } catch {
        return { sessions: [] };
    }
}


export async function collectMeshViewQueueNodesWithLiveSessions(ctx: MeshContext): Promise<any[]> {
    const nodes = await Promise.all(ctx.mesh.nodes.map(async (node) => {
        const liveSessions = await collectLiveStatusSessions(ctx, node);
        return liveSessions.length > 0
            ? { ...node, sessions: liveSessions }
            : node;
    }));
    return nodes;
}

// Variant of collectMeshViewQueueNodesWithLiveSessions that additionally stamps each
// node with `__liveProbeVerified` so a caller (annotateQueueStaleness's optional
// liveVerifiedNodes param) can tell a confirmed-empty probe apart from a failed one.
// Purely additive: node.sessions merge behavior is identical to the unverified
// variant, so existing shape/consumers of the node object are unaffected.
export async function collectMeshViewQueueNodesWithLiveSessionsVerified(ctx: MeshContext): Promise<any[]> {
    const nodes = await Promise.all(ctx.mesh.nodes.map(async (node) => {
        const { sessions: liveSessions, verified } = await collectLiveStatusSessionsVerified(ctx, node);
        if (verified) {
            // A verified probe (even a confirmed-empty one) is authoritative — replace
            // the node's session field rather than leaving a stale persisted array
            // behind for a caller that keys off __liveProbeVerified to trust it.
            return { ...node, sessions: liveSessions, __liveProbeVerified: true };
        }
        return { ...node, __liveProbeVerified: false };
    }));
    return nodes;
}


export async function commandForNode(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    command: string,
    args: Record<string, unknown> = {},
    opts?: { statusProbe?: boolean },
): Promise<any> {
    const isLocalNode = isLocalControlPlaneNode(ctx, node);

    if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
        // OFFLINE-NODE-STATUS-REFRESH: a status-origin probe (explicit_refresh /
        // mesh_status) stamps the marker into the relayed args so the daemon-cloud
        // relay handler grants the SHORT connect-wait budget — an offline peer is
        // rejected in ~seconds instead of blocking the relay for the full 90s connect
        // deadline. A local-transport call needs no marker (no relay / no connect wait).
        const relayedArgs = opts?.statusProbe ? withStatusProbeMarker(args) : args;
        return ctx.transport.meshCommand(node.daemonId, command, relayedArgs);
    }
    return ctx.transport.command(command, args);
}

/**
 * §8 unit 8: the exact condition under which a semantic replica read may be
 * attempted for `node` — a REMOTE node reachable over the coordinator's local
 * IPC. Returns the coordinator transport (the one that owns the replica store),
 * or null when the replica hop must be skipped entirely.
 *
 * Extracted rather than repeated at each of the three call sites because it
 * must stay identical to `commandForNode`'s own remote branch above: the
 * replica exists to spare a P2P round trip, so it is only ever correct exactly
 * where `commandForNode` would have made one. A LOCAL node's read is an
 * in-process call against the provider source, which design §4's roster keeps
 * as-is for every consumer.
 */
export function resolveSemanticReplicaTransport(
    ctx: MeshContext,
    node: LocalMeshNodeEntry | null | undefined,
): IpcTransport | null {
    if (!node || !node.daemonId) return null;
    if (!(ctx.transport instanceof IpcTransport)) return null;
    if (isLocalControlPlaneNode(ctx, node)) return null;
    return ctx.transport;
}


export async function drainCoordinatorPendingEvents(
    ctx: MeshContext,
    opts?: { nodeIds?: string[] },
): Promise<any[]> {
    const requestedNodeIds = opts?.nodeIds?.length ? new Set(opts.nodeIds) : null;
    const matchesCurrentMesh = (event: any) => readString(event?.meshId) === ctx.mesh.id;

    if (ctx.transport instanceof IpcTransport) {
        const transport = ctx.transport;
        const surfacedEvents: any[] = [];
        const coordinatorDaemonId = readString(ctx.localDaemonId);
        const pendingEventArgs = {
            meshId: ctx.mesh.id,
            ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
        };
        // SELF-COORDINATOR INBOX LEVEL-DRAIN (Defect 2): this LOCAL drain is the coordinator
        // reading its OWN inbox — the drained events return in this tool call's RESULT and are
        // surfaced to the LLM directly (a lossless data-queue surface), so the daemon must NOT
        // hold it while the local CLI coordinator is busy. Scoped to the local drain only; the
        // remote-node pulls below keep the default (reconcile-owned) delivery.
        const localPendingEventArgs = { ...pendingEventArgs, selfCoordinatorInboxRead: true };

        // Drain THIS daemon's local pending queue and route each event to its delivery surface.
        //
        // NOTIF-DROP (drain-without-inject) fix: when this daemon has NO live CLI coordinator
        // for the mesh (a pure stdio MCP/LLM coordinator), the MCP tool result is the ONLY
        // surface. Re-forwarding the event via mesh_forward_event then just RE-QUEUES it
        // (injectMeshSystemMessage has no live CLI session to inject into), so the completion
        // loops in the queue at drained=0 and never reaches the LLM — the exact single-event
        // loss observed for a daemon_reconcile_transcript_completion consumed while the
        // coordinator was busy. In that case we surface the drained events to the LLM directly
        // (the event's coordinator-side state — task_completed ledger etc. — was already applied
        // when it was first queued, so skipping the redundant re-forward loses nothing).
        //
        // When a live CLI coordinator DOES exist, the reconcile loop owns PTY delivery, so keep
        // the existing forward path (and only surface as a fallback when the forward itself
        // throws). hasLiveCliCoordinator rides the get_pending_mesh_events response for exactly
        // this decision. The remote-node pull below is unchanged — its forward re-homes a remote
        // worker's event into the local queue, which the second local drain then surfaces.
        const drainLocalToSurface = async (): Promise<void> => {
            const raw = await transport.command('get_pending_mesh_events', localPendingEventArgs) as any;
            const payloadRaw = unwrapCommandPayload(raw);
            // T6 (B3c): capture the enforce/backstop counters the daemon rode on this
            // local drain so mesh_status can surface them (see MeshContext).
            const counters = payloadRaw?.meshProtocolV2Counters ?? raw?.meshProtocolV2Counters;
            if (counters && typeof counters === 'object') {
                ctx.lastMeshProtocolV2Counters = counters as MeshProtocolV2CountersSnapshot;
            }
            // Same relay for the pending-event retention sweep counters (see MeshContext).
            const retentionCounters = payloadRaw?.pendingRetentionCounters ?? raw?.pendingRetentionCounters;
            if (retentionCounters && typeof retentionCounters === 'object') {
                ctx.lastPendingRetentionCounters = retentionCounters as MeshPendingRetentionCountersSnapshot;
            }
            const hasLiveCliCoordinator = payloadRaw?.hasLiveCliCoordinator === true
                || raw?.hasLiveCliCoordinator === true;
            // SELF-COORDINATOR INBOX LEVEL-DRAIN (Defect 2): the daemon relaxed the busy-coordinator
            // hold because this is the self-coordinator's own inbox read, and it flagged the events
            // as surfaced through THIS tool result. Surface them directly to the LLM — do NOT
            // re-forward into the (busy) live PTY (the lossy drain-without-inject path). Without the
            // flag, delivery is unchanged: forward when a live CLI coordinator owns PTY delivery.
            const surfacedForSelfCoordinator = payloadRaw?.surfacedForSelfCoordinator === true
                || raw?.surfacedForSelfCoordinator === true;
            const localEvents = normalizePendingMeshCoordinatorEvents(raw).filter(matchesCurrentMesh);
            for (const event of localEvents) {
                const payload = buildMeshForwardPayloadFromPendingEvent(event);
                if (!payload.event || !payload.meshId) continue;
                if (!hasLiveCliCoordinator || surfacedForSelfCoordinator) {
                    // Pure-MCP coordinator, OR the self-coordinator's own busy inbox read: the LLM
                    // tool result is the surface. Do NOT re-forward (that re-queues with no free PTY
                    // → the drain-without-inject loop / the ~59s self-coordinator strand).
                    rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
                    surfacedEvents.push(event);
                    continue;
                }
                let injected = false;
                try {
                    await transport.command('mesh_forward_event', payload);
                    injected = true;
                } catch { /* best-effort */ }
                rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
                if (!injected) surfacedEvents.push(event);
            }
        };

        try {
            await drainLocalToSurface();
        } catch {
            // Non-fatal: pending events are best-effort.
        }

        for (const node of ctx.mesh.nodes) {
            if (!node.daemonId || isLocalControlPlaneNode(ctx, node)) continue;
            if (requestedNodeIds && !requestedNodeIds.has(node.id)) continue;

            try {
                const remoteEvents = normalizePendingMeshCoordinatorEvents(
                    await transport.meshCommand(node.daemonId, 'get_pending_mesh_events', pendingEventArgs),
                ).filter(matchesCurrentMesh);
                if (remoteEvents.length === 0) continue;

                for (const event of remoteEvents) {
                    const payload = buildMeshForwardPayloadFromPendingEvent(event);
                    if (!payload.event || !payload.meshId) continue;
                    await transport.command('mesh_forward_event', payload);
                    rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
                }
            } catch {
                // Non-fatal: remote pending-event recovery is best-effort.
            }
        }

        try {
            await drainLocalToSurface();
        } catch {
            // Non-fatal: pending events are best-effort.
        }

        return surfacedEvents;
    }

    // (B3) Pass localDaemonId so unicast events targeted at other
    // coordinators are skipped (and requeued) instead of being silently
    // consumed by this MCP. drainPendingMeshCoordinatorEvents already
    // accepts the second arg in the base; we were the missing wiring.
    //
    // COORD-EVENT-MISROUTE (defense-in-depth, session filter): thread THIS coordinator's own
    // sessionId into the drainer identity so identityDeliversTo can exclude a SIBLING coordinator
    // session's unicast completion on the same daemon (contracts.ts identityDeliversTo compares
    // sessions only when BOTH the event's intendedFor AND the drainer name one). Without a session
    // in the drainer identity the filter is inert and a daemon-level drain sweeps every local
    // coordinator's events. Regression-0: when coordinatorSessionId is empty (single-coordinator /
    // legacy) the drainer stays session-less → daemon-level delivery is unchanged; and a broadcast
    // event is delivered regardless (shouldDeliverPendingEventToCoordinator → true for broadcast),
    // so this only narrows genuine per-session unicast, never suppresses a broadcast.
    const drainerIdentity = coordinatorIdentityFromEmitFields({
        daemonId: ctx.localDaemonId,
        sessionId: ctx.coordinatorSessionId,
    });
    const events = (drainPendingMeshCoordinatorEvents(
        ctx.mesh.id,
        ctx.localDaemonId,
        drainerIdentity ? { drainerIdentity } : undefined,
    ) as any[]).filter(matchesCurrentMesh);
    events.forEach(rememberMeshSessionProviderMetadataFromEvent);
    return events;
}

export function isP2pTransportUnavailableError(error: unknown): boolean {
    return isP2pRelayTransportFailure(error);
}

export function buildRemoveNodeArgs(ctx: MeshContext, nodeId: string, sessionCleanupMode?: string, force?: boolean): Record<string, unknown> {
    return {
        meshId: ctx.mesh.id,
        nodeId,
        ...(sessionCleanupMode ? { sessionCleanupMode } : {}),
        ...(force === true ? { force: true } : {}),
        inlineMesh: ctx.mesh,
    };
}




/**
 * The coordinator already holds the worker's latest assistant text from the completion /
 * status events it surfaced into the ledger (finalSummary / workerResult.summary — the
 * same fields resolveMeshSurfacedSessionPreview reads off a live event, and the same
 * data the mobile inbox is fed). When the live P2P read_chat path is unavailable this
 * resolves that cached preview so mesh_read_chat can degrade to a stale-but-present
 * summary instead of a hard 30s timeout. Scans the most recent matching ledger entry for
 * the node+session.
 */
export function resolveCachedMeshSessionPreviewFromLedger(
    ctx: MeshContext,
    nodeId: string,
    sessionId: string,
): { preview: string; role: 'assistant'; receivedAt: number; ledgerKind: string; timestamp: string } | undefined {
    const entries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
            ? entry.payload as Record<string, unknown>
            : {};
        const entryNodeId = readString(entry.nodeId) || readString(payload.nodeId) || readString(payload.meshNodeId);
        if (entryNodeId && entryNodeId !== nodeId) continue;
        const entrySessionId = readString(entry.sessionId)
            || readString(payload.targetSessionId)
            || readString(payload.sessionId)
            || readString(payload.instanceId);
        if (entrySessionId !== sessionId) continue;
        // Prefer a nested metadataEvent when present, else read the entry payload itself
        // (task_completed / task_failed entries carry finalSummary + workerResult inline).
        const metadataEvent = payload.metadataEvent && typeof payload.metadataEvent === 'object' && !Array.isArray(payload.metadataEvent)
            ? payload.metadataEvent as Record<string, unknown>
            : payload;
        const preview = resolveMeshSurfacedSessionPreview(metadataEvent);
        if (preview) {
            return { ...preview, ledgerKind: entry.kind, timestamp: entry.timestamp };
        }
    }
    return undefined;
}


/**
 * mesh_read_chat fallback for a REMOTE P2P read that failed at the transport layer.
 *
 * Mirrors mesh_status's collectLiveStatusProbe graceful-degrade pattern: rather than
 * hard-failing on a 30s P2P timeout to a saturated/unreachable worker, surface the
 * cached coordinator-side summary (the same finalSummary/lastMessagePreview the mobile
 * dashboard renders). This is a READ/meta-plane degrade — status & preview already flow
 * over the WS/event plane — NOT a data-plane command WS fallback (which stays P2P-only
 * by policy). The full transcript still requires a live P2P read_chat; the fallback is
 * explicitly a stale point-in-time summary only.
 */
export function buildMeshReadChatCacheFallback(
    ctx: MeshContext,
    args: { node_id: string; session_id: string },
    node: LocalMeshNodeEntry,
    error: unknown,
): string {
    const classification = classifyP2pRelayFailure(error, { command: 'read_chat', targetDaemonId: node.daemonId });
    const cause = classifyReadChatTransportCause(error);
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    const causeNote = cause === 'not_connected'
        ? 'the worker daemon is not currently connected over P2P (no live channel)'
        : 'the worker daemon is connected but saturated — it acknowledged the request but did not return the transcript within the deadline';

    const cached = resolveCachedMeshSessionPreviewFromLedger(ctx, args.node_id, args.session_id);
    if (cached) {
        return JSON.stringify({
            success: true,
            source: 'coordinator_cache_fallback',
            fallback: true,
            nodeId: args.node_id,
            sessionId: args.session_id,
            transport: 'p2p',
            transportFailure: {
                code: classification.code,
                reason: classification.reason,
                cause,
                error: errorMessage,
            },
            advisory: `Live transcript unavailable (${causeNote}). Showing the cached coordinator-side summary surfaced from the worker's last completion/status event — a stale point-in-time summary, NOT the live transcript. The full transcript requires a live P2P read_chat once the peer is reachable.`,
            fullTranscriptRequiresP2p: true,
            summary: cached.preview,
            messages: [{
                role: cached.role,
                content: cached.preview,
                cached: true,
                ...(cached.receivedAt ? { receivedAt: cached.receivedAt } : {}),
            }],
            cachedPreview: {
                role: cached.role,
                ledgerKind: cached.ledgerKind,
                ledgerTimestamp: cached.timestamp,
                ...(cached.receivedAt ? { receivedAt: cached.receivedAt } : {}),
            },
        }, null, 2);
    }

    // No cached summary either — return the structured relay failure with a clear reason,
    // and make explicit that even a fallback summary is unavailable.
    const failure = buildCoordinatorP2pRelayFailure(error, {
        command: 'read_chat',
        targetDaemonId: node.daemonId,
        nodeId: args.node_id,
        sessionId: args.session_id,
    });
    return JSON.stringify({
        ...failure,
        cause,
        cachedSummaryAvailable: false,
        fullTranscriptRequiresP2p: true,
        advisory: `Live transcript unavailable (${causeNote}) and no cached coordinator-side summary exists for this session yet (no completion/status event has been surfaced). The full transcript requires a live P2P read_chat once the peer is reachable.`,
    }, null, 2);
}

export function resolveRefineConfigNode(ctx: MeshContext, nodeId?: string): LocalMeshNodeEntry {
    if (nodeId) return findNode(ctx.mesh, nodeId);
    const node = ctx.mesh.nodes.find((entry: LocalMeshNodeEntry) => !!entry.workspace);
    if (!node) throw new Error('No mesh node with a workspace is available');
    return node;
}
