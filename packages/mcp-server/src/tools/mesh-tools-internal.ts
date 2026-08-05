/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * 50 tools (== ALL_MESH_TOOLS, kept in sync with the coordinator-prompt TOOLS table
 * by the 6-6 consistency test in daemon-core coordinator-prompt.test.ts):
 *   mesh_status, mesh_list_nodes, mesh_enqueue_task, mesh_view_queue,
 *   mesh_queue_cancel, mesh_queue_requeue, mesh_send_task, mesh_read_chat,
 *   mesh_read_debug, mesh_read_terminal, mesh_send_keys, mesh_launch_session, mesh_git_status, mesh_read_node_logs,
 *   mesh_fast_forward_node, mesh_restart_daemon, mesh_checkpoint, mesh_approve,
 *   mesh_plan_onboarding, mesh_create, mesh_add_node,
 *   mesh_list_pending_approvals,
 *   mesh_clone_node, mesh_remove_node, mesh_refine_node, mesh_refine_batch,
 *   mesh_refine_config, mesh_change_impact_config, mesh_init, mesh_reinit,
 *   mesh_write_mesh_json_config, mesh_refine_plan, mesh_cleanup_sessions,
 *   mesh_prune_stale_direct, mesh_task_history, mesh_ledger_query,
 *   mesh_record_note, mesh_forget_note, mesh_reconcile_ledger,
 *   mesh_requeue_held_events,
 *   mesh_mission_upsert, mesh_mission_list, mesh_review_inbox, mesh_magi_review,
 *   mesh_magi_collect,
 *   mesh_magi_kind_panel_set, mesh_magi_kind_panel_list
 */

// ─── Internal module ───────────────────────────
// Shared helpers, types, module-level state, and dependency re-exports for the mesh tool
// domain files (mesh-tools-{status,queue,mission,session,git,refine}.ts). Split out of
// mesh-tools.ts as a pure move — no behavior change. mesh-tools.ts is now a re-export barrel.

import { randomUUID } from 'node:crypto';
import { IpcTransport } from '../transports/ipc.js';
import type { CommandTransport } from '../transports/mode.js';
import { compactChatPayload, isCoordinatorVisibleMessage, messageContent } from './chat-compact.js';
import { annotateRapidReadChatAdvisory } from './read-chat-polling-advisory.js';
import { withStatusProbeMarker, normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared';
import type { LocalMeshEntry, LocalMeshNodeEntry, MeshActiveWorkSummary, RepoMeshPolicy, RepoMeshRelatedRepo } from '@adhdev/daemon-core';
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
    buildMeshNodeCapabilityTags,
    buildMeshNodeProbeFreshness,
    buildMeshSchedulingRuntime,
    buildP2pRelayFailurePayload,
    cancelTask,
    classifyP2pRelayFailure,
    pruneStaleDirectDispatches,
    describeTaskDependencyState,
    taskDependenciesSatisfied,
    drainPendingMeshCoordinatorEvents,
    serializeV2EnvelopeToWire,
    enqueueTask,
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
} from '@adhdev/daemon-core';
import { readString, readNumeric, LARGE_LEDGER_FIELD_KEYS, summarizeLargeLedgerField, elideLargeNestedValue } from './mesh-tool-shared.js';
import {
    readSessionRecordId,
    extractStatusMetadataSessions,
    resolveSessionProviderType,
    isMeshCoordinatorSessionRecord,
    isUnmanagedSessionRecord,
    isWorkerTaskMode,
    collectNodeSessionIds,
    unwrapCommandPayload,
    isTerminalSessionRecord,
    isIdleSessionRecord,
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
    MESH_LIST_NODES_TOOL,
    MESH_ENQUEUE_TASK_TOOL,
    MESH_VIEW_QUEUE_TOOL,
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
    compactMeshStatusNode,
    compactNodeSeverity,
    isNoteworthyCompactNode,
    minimalCompactNode,
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
    summarizeLargeLedgerField,
} from './mesh-tool-shared.js';
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
    buildP2pRelayFailurePayload,
    cancelTask,
    classifyP2pRelayFailure,
    computeMeshMissionStats,
    computeMeshTaskStats,
    daemonIdsEquivalent,
    deleteDirectDispatchesByTaskId,
    describeTaskDependencyState,
    taskDependenciesSatisfied,
    drainPendingMeshCoordinatorEvents,
    enqueueTask,
    getActiveDirectDispatches,
    getActiveMeshMissionSummaries,
    getLedgerSummary,
    summarizeMeshUsage,
    getMagiKindPanel,
    listMagiKindPanels,
    setMagiKindPanel,
    removeMagiKindPanel,
    normalizeMagiSlots,
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
    recordMeshToolCall,
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
} from '@adhdev/daemon-core';
export type {
    LocalMeshEntry,
    LocalMeshNodeEntry,
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
}

/** T6 (B3c) live v2 enforce/observability counters snapshot (mirrors the daemon-core
 *  RepoMeshStatus.meshProtocolV2Counters shape). Structural type — no daemon-core import. */
export interface MeshProtocolV2CountersSnapshot {
    enforce: boolean;
    drain: Record<string, number>;
    backstop: Record<string, number>;
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

export function summarizeTaskMessage(message: string): { taskTitle: string; taskSummary: string } {
    const taskSummary = message.replace(/\s+/g, ' ').trim();
    const taskTitle = taskSummary.length > 96 ? `${taskSummary.slice(0, 93)}...` : taskSummary;
    return { taskTitle: taskTitle || '(untitled task)', taskSummary };
}

export function buildDirectTaskPayload(
    message: string,
    via: 'p2p_direct' | 'local_direct' | 'mesh_send_task',
    opts: {
        taskId: string;
        taskMode?: string;
        providerType?: string;
        targetSessionId?: string;
        /** When true, the target session was idle at time of dispatch. This flag helps
         *  mesh-active-work stale detection identify unacknowledged direct dispatches. */
        dispatchedToIdleSession?: boolean;
        /** NOTIF-DROP-SYNTH-NO-MESSAGE: the originating coordinator SESSION that dispatched this
         *  task. Persisted in the task_dispatched ledger so a later transcript-reconcile synth of
         *  the completion can STRICT-route the [System] notification back to the exact coordinator
         *  session (not just the daemon). Mirrors the `coordinatorSessionId` already stamped into
         *  the worker's meshContext. */
        coordinatorSessionId?: string;
        /** COORD-EVENT-MISROUTE (anchor preservation): the originating coordinator DAEMON that
         *  dispatched this task. Persisted in the task_dispatched ledger so a later transcript-
         *  reconcile synth recovers the DISPATCHING coordinator's daemon anchor from the ledger
         *  instead of stamping the WORKER's own self-daemon (mesh-completion-synthesis selfIds) —
         *  the anchor corruption that downgraded a cross-machine completion to a broadcast
         *  deliverable to any coordinator. Mirrors the `coordinatorDaemonId` already stamped into
         *  the worker's meshContext. Absent on legacy rows → daemon-level fallback (unchanged). */
        coordinatorDaemonId?: string;
        /** LEDGER-TASK-TRACEABILITY (A/D): the node this direct dispatch targeted, plus the
         *  resolved model/thinking axes (when known), surfaced in the routingDecision sub-object
         *  so the dashboard renders direct dispatches with the same "who/via/why" shape as
         *  queue-claim dispatches. Optional — pre-existing callers omit them. */
        selectedNodeId?: string;
        resolvedModel?: string;
        resolvedThinkingLevel?: string;
    },
): Record<string, unknown> {
    const descriptor = summarizeTaskMessage(message);
    return {
        source: 'direct',
        via,
        taskId: opts.taskId,
        message,
        taskTitle: descriptor.taskTitle,
        taskSummary: descriptor.taskSummary,
        ...(opts.taskMode ? { taskMode: opts.taskMode } : {}),
        ...(opts.providerType ? { providerType: opts.providerType } : {}),
        ...(opts.targetSessionId ? { targetSessionId: opts.targetSessionId } : {}),
        ...(opts.dispatchedToIdleSession !== undefined ? { dispatchedToIdleSession: opts.dispatchedToIdleSession } : {}),
        ...(opts.coordinatorSessionId ? { coordinatorSessionId: opts.coordinatorSessionId } : {}),
        ...(opts.coordinatorDaemonId ? { coordinatorDaemonId: opts.coordinatorDaemonId } : {}),
        // Uniform routing rationale (mirrors the queue-claim task_dispatched shape) so both
        // paths render identically in mesh_task_history / the dashboard. The legacy top-level
        // `source`/`via`/`providerType` fields above are preserved verbatim for existing
        // consumers (mesh-active-work / mesh-events-stale key on payload.source === 'direct').
        routingDecision: {
            source: 'direct',
            via,
            ...(opts.selectedNodeId ? { selectedNodeId: opts.selectedNodeId } : {}),
            ...(opts.providerType ? { resolvedProviderType: opts.providerType } : {}),
            ...(opts.resolvedModel ? { resolvedModel: opts.resolvedModel } : {}),
            ...(opts.resolvedThinkingLevel ? { resolvedThinkingLevel: opts.resolvedThinkingLevel } : {}),
        },
    };
}

export function findNode(mesh: LocalMeshEntry, nodeId: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (!node) throw new Error(`Node '${nodeId}' is not a member of mesh '${mesh.name}'`);
    return node;
}

export const DUPLICATE_DISPATCH_WINDOW_MS = 60_000;

// (queue constants/types moved to ./mesh-queue-helpers.ts)

/**
 * Refresh the MCP process's mesh snapshot from the daemon inline mesh cache.
 * This is required for status/list tools when a previous MCP process already
 * created or removed worktree nodes through clone_mesh_node/remove_mesh_node.
 */
export async function refreshMeshFromDaemon(ctx: MeshContext): Promise<void> {
    try {
        const result = await ctx.transport.command('get_mesh', { meshId: ctx.mesh.id }) as any;
        if (!result?.success || !Array.isArray(result.mesh?.nodes)) return;
        const refreshedNodes = result.mesh.nodes
            .filter((n: any) => n?.id)
            .map((n: any) => n as LocalMeshNodeEntry);
        (ctx.mesh.nodes as LocalMeshNodeEntry[]).splice(0, ctx.mesh.nodes.length, ...refreshedNodes);
        ctx.mesh.updatedAt = result.mesh.updatedAt ?? ctx.mesh.updatedAt;
    } catch { /* refresh is best-effort; callers still report their original status/errors */ }
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

export async function findNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry> {
    const hit = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (hit && !hit.isLocalWorktree) return hit;

    await refreshMeshFromDaemon(ctx);

    const refreshed = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (!refreshed) throw new Error(`Node '${nodeId}' is not a member of mesh '${ctx.mesh.name}'`);
    return refreshed;
}

export async function findOptionalNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry | null> {
    const hit = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId));
    if (hit && !hit.isLocalWorktree) return hit;

    await refreshMeshFromDaemon(ctx);

    return ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, nodeId)) ?? null;
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

export function isDirectDispatchLedgerEntry(entry: any): boolean {
    if (entry?.kind !== 'task_dispatched') return false;
    const payload = entry.payload || {};
    const via = readString(payload.via);
    return payload.source === 'direct' || via === 'p2p_direct' || via === 'local_direct' || via === 'mesh_send_task';
}

export function readMessageTimestampIso(message: any): string | undefined {
    for (const value of [message?.timestamp, message?.createdAt, message?.created_at, message?.updatedAt, message?.time]) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            const ms = value > 10_000_000_000 ? value : value * 1000;
            return new Date(ms).toISOString();
        }
        if (typeof value === 'string' && value.trim()) {
            const ms = new Date(value.trim()).getTime();
            if (Number.isFinite(ms)) return new Date(ms).toISOString();
        }
    }
    return undefined;
}

// EARLYNOTIFY-GATEBYPASS (a)/(b): mirror daemon-core's selectFinalAssistantTurnEndMessage
// turn-finality rule so the MCP mesh_status transcript reconcile applies the SAME "which bubble is
// the turn's final answer" judgement as the daemon path it delegates to. A genuine turn end is a
// NON-EMPTY LATEST coordinator-visible assistant/agent bubble: scanning from the end, the first
// coordinator-visible message must itself be a non-empty assistant reply. An empty (streaming /
// mid-turn) latest assistant bubble, or a trailing user message, means the turn is not proven done
// — we do NOT walk back past it to promote an earlier narration to "final" (the Defect-B walk-back)
// and we do NOT fall back to a bare payload.summary in that case. This structural check plus the
// daemon-side grace gate (reconcileDirectDispatchCompletionFromTranscript) keep a coordinator poll
// from synthesizing a completion mid-turn.
export function readFinalAssistantTranscriptEvidence(payload: any): { finalSummary?: string; transcriptMessageAt?: string } {
    const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    let turnEnd: any | undefined;
    for (let i = rawMessages.length - 1; i >= 0; i--) {
        const message = rawMessages[i];
        if (!isCoordinatorVisibleMessage(message)) continue; // skip tool/thought/status activity
        const role = String(message?.role ?? '').toLowerCase();
        // First coordinator-visible message from the end = who had the last word.
        turnEnd = (role === 'assistant' || role === 'agent') && messageContent(message).trim()
            ? message
            : undefined;
        break;
    }
    if (!turnEnd) return { finalSummary: undefined, transcriptMessageAt: undefined };
    return {
        finalSummary: messageContent(turnEnd).trim(),
        transcriptMessageAt: readMessageTimestampIso(turnEnd),
    };
}

export function findNodeSession(nodes: any[], nodeId?: string | null, sessionId?: string | null): { node?: any; session?: any } {
    if (!nodeId || !sessionId) return {};
    const node = nodes.find((candidate: any) => meshNodeIdMatches(candidate, nodeId));
    if (!node) return {};
    const sessions = Array.isArray(node.sessions) ? node.sessions : [];
    const session = sessions.find((candidate: any) => readSessionRecordId(candidate) === sessionId);
    return { node, session };
}

export function buildDirectDispatchReconciliationCandidates(directDispatches: any[], ledgerEntries: any[]): any[] {
    const candidates: any[] = [];
    const seenTaskIds = new Set<string>();
    for (const dispatch of directDispatches || []) {
        const taskId = readString(dispatch?.taskId);
        if (!taskId || seenTaskIds.has(taskId)) continue;
        seenTaskIds.add(taskId);
        candidates.push(dispatch);
    }
    for (const entry of ledgerEntries || []) {
        if (!isDirectDispatchLedgerEntry(entry)) continue;
        const taskId = readString(entry.payload?.taskId);
        if (!taskId || seenTaskIds.has(taskId)) continue;
        seenTaskIds.add(taskId);
        candidates.push({
            taskId,
            nodeId: entry.nodeId,
            sessionId: entry.sessionId,
            providerType: entry.providerType || readString(entry.payload?.providerType),
            message: readString(entry.payload?.message),
            dispatchedAt: entry.timestamp,
            via: readString(entry.payload?.via),
        });
    }
    return candidates;
}

export async function reconcileDirectDispatchesFromTranscriptEvidence(
    ctx: MeshContext,
    liveNodes: any[],
    directDispatches: any[],
    ledgerEntries: any[],
): Promise<{ attempted: number; reconciled: number; skipped: number }> {
    let attempted = 0;
    let reconciled = 0;
    let skipped = 0;
    const candidates = buildDirectDispatchReconciliationCandidates(directDispatches, ledgerEntries);
    for (const dispatch of candidates) {
        const taskId = readString(dispatch?.taskId);
        const nodeId = readString(dispatch?.nodeId);
        const sessionId = readString(dispatch?.sessionId);
        if (!taskId || !nodeId || !sessionId) {
            skipped += 1;
            continue;
        }
        const { session } = findNodeSession(liveNodes, nodeId, sessionId);
        // EARLYNOTIFY-GATEBYPASS (e): a single snapshot-idle sample is NOT sufficient to synthesize
        // a completion — a mid-turn poll routinely reads idle for an instant. This idle check only
        // makes the session ELIGIBLE for a transcript read; the actual turn-finality gate is
        // enforced downstream: readFinalAssistantTranscriptEvidence requires a genuine non-empty
        // latest-assistant turn end, and reconcileDirectDispatchCompletionFromTranscript (the
        // guarded daemon path this delegates to) applies the dispatch grace window + stale-summary
        // guard before it will write a terminal. So a coordinator poll cannot force a mid-turn synth.
        if (!session || !isIdleSessionRecord(session)) {
            skipped += 1;
            continue;
        }
        const node = await findOptionalNodeWithRefresh(ctx, nodeId).catch(() => null);
        if (!node) {
            skipped += 1;
            continue;
        }
        const providerType = readString(dispatch?.providerType) || resolveSessionProviderType(session);
        const providerSessionId = readString(session?.providerSessionId)
            || readString(session?.activeChat?.providerSessionId)
            || readString(session?.settings?.providerSessionId)
            || resolveMeshSessionProviderMetadata(ctx, nodeId, sessionId)?.providerSessionId;
        attempted += 1;
        try {
            const readResult = await commandForNode(ctx, node, 'read_chat', {
                sessionId,
                targetSessionId: sessionId,
                workspace: node.workspace,
                ...(providerType ? { agentType: providerType, providerType } : {}),
                ...(providerSessionId ? { providerSessionId } : {}),
                tailLimit: 10,
            });
            const payload = unwrapCommandPayload(readResult);
            if (payload?.success === false) continue;
            // MID-TURN-CAUSAL-ADMISSION (rc.16): the latest final-LOOKING assistant bubble
            // followed by trailing tool/terminal activity is interim narration, not a turn
            // end — a single coordinator poll must never promote it to a completion. This is
            // the same veto the reconcile loop's PHASE 4 and the watchdog poll enforce; the
            // MCP process has no live adapter to probe (remote semantics), so the bounded
            // transcript evidence below remains the operative net (fail-open preserved).
            if (hasTrailingToolActivityAfterFinalAssistant(Array.isArray(payload?.messages) ? payload.messages : [])) continue;
            const evidence = readFinalAssistantTranscriptEvidence(payload);
            if (!evidence.finalSummary) continue;
            const result = reconcileDirectDispatchCompletionFromTranscript({
                meshId: ctx.mesh.id,
                nodeId,
                sessionId,
                providerType,
                providerSessionId: readString(payload?.providerSessionId) || providerSessionId,
                taskId,
                finalSummary: evidence.finalSummary,
                transcriptMessageAt: evidence.transcriptMessageAt,
                targetCoordinatorDaemonId: ctx.localDaemonId,
                source: 'mcp_mesh_status_transcript_reconciliation',
            });
            if (result.reconciled) reconciled += 1;
        } catch {
            skipped += 1;
        }
    }
    return { attempted, reconciled, skipped };
}

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

export function buildQueueTriggerGuidance(queueTrigger: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!queueTrigger || queueTrigger.claimed === true) return undefined;
    if (queueTrigger.success === false) {
        return {
            queueClaimed: false,
            queueDispatchState: 'trigger_failed',
            nextAction: 'Do not assume the queued task is running. Check mesh_view_queue and daemon connectivity before redispatching.',
        };
    }
    if (queueTrigger.autoLaunchPending === true) {
        // The coordinator already spun up (or is spinning up) a worker session for this
        // task — it is booting and will claim within a few seconds. Telling the caller to
        // launch ANOTHER session here would double-edit the worktree. Do NOT advise a new
        // launch; just wait for the in-flight session to claim.
        return {
            queueClaimed: false,
            queueDispatchState: 'pending_waiting_for_autolaunch',
            nextAction: 'A worker session was just auto-launched for this task and is booting; it will claim the task shortly. Wait for it to claim — do NOT launch another session. Use mesh_view_queue to confirm the assignment lands.',
        };
    }
    if (queueTrigger.noIdleMeshSessionAvailable === true) {
        return {
            queueClaimed: false,
            queueDispatchState: 'pending_no_idle_mesh_session',
            nextAction: 'The task is queued but not running. Launch a managed worker with mesh_launch_session, or wait for a delegated session to become ready and trigger the queue again.',
        };
    }
    return {
        queueClaimed: false,
        queueDispatchState: 'pending_or_waiting_for_ready',
        nextAction: 'The task is queued but this trigger did not claim it. Use mesh_view_queue for the current active-work source of truth before retrying.',
    };
}


// (moved to ./mesh-session-helpers.ts — session/payload record helpers)

export function isMeshOwnedDelegateSession(session: any, meshId: string, nodeId: string): boolean {
    const settings = session?.settings;
    const sessionMeshId = typeof settings?.meshNodeFor === 'string' ? settings.meshNodeFor.trim() : '';
    const sessionNodeId = typeof settings?.meshNodeId === 'string' ? settings.meshNodeId.trim() : '';
    // meshNodeFor is the primary ownership signal. Relay safety is checked separately
    // for remote dispatch because older local delegates may not carry coordinator
    // daemon metadata.
    if (sessionMeshId) {
        if (sessionMeshId !== meshId) return false;
        return !sessionNodeId || sessionNodeId === nodeId;
    }
    // Post-detach: detachMeshAssignment intentionally clears meshNodeFor / meshNodeId /
    // meshActiveTaskId after a relay-safe completion, but preserves the coordinator
    // markers (launchedByCoordinator / meshCoordinatorDaemonId). Without recognizing
    // those, a follow-up dispatch to the SAME session would be misclassified as an
    // unrelated alias and rejected — even though the router self-heals meshNodeFor /
    // meshNodeId at dispatch time (buildMeshWorkerRelayStamp). Treat the preserved
    // coordinator markers as ownership evidence so the dispatch-time restamp can run.
    const coordinatorOwned = settings?.launchedByCoordinator === true || Boolean(readString(settings?.meshCoordinatorDaemonId));
    if (!coordinatorOwned) return false;
    // WTCLAIM (A): a detached coordinator session is reusable, but ONLY for the node
    // it last served. detachMeshAssignment preserves meshLastNodeId (the sticky bind
    // marker). On a daemon hosting BOTH a base node and a cloned worktree node (same
    // daemonId), without this gate a detached BASE session would be auto-picked for a
    // worktree-targeted sessionless dispatch — running worktree work on the base node.
    // When the sticky marker is present it must equal the requested node; legitimate
    // same-node reuse still passes. When absent (never bound, or a pre-fix session),
    // fall back to the prior permissive behavior — fix (B)'s worker-side nodeId/
    // workspace scoping is the defense-in-depth backstop for that residual case.
    const lastNodeId = readString(settings?.meshLastNodeId);
    if (lastNodeId) return lastNodeId === nodeId;
    return true;
}

export function hasRemoteRelayMetadata(session: any): boolean {
    return Boolean(
        readString(session?.settings?.meshCoordinatorDaemonId)
        || readString(session?.meta?.meshCoordinatorDaemonId)
        || readString(session?.metadata?.meshCoordinatorDaemonId)
        || readString(session?.meshCoordinatorDaemonId),
    );
}

export function isRelaySafeRemoteDelegateSession(session: any, meshId: string, nodeId: string): boolean {
    return isMeshOwnedDelegateSession(session, meshId, nodeId) && hasRemoteRelayMetadata(session);
}


/**
 * Pre-dispatch relay-safety classification for an explicit remote delegate
 * session. The local direct-dispatch path (commandForNode → agent_command) has
 * no such gate: it always dispatches with meshContext.coordinatorDaemonId, and
 * the remote router self-heals the session's meshCoordinatorDaemonId at dispatch
 * time (router.ts buildMeshWorkerRelayStamp). The remote path used to hard-block
 * any session lacking meshCoordinatorDaemonId, which prevented that dispatch-time
 * stamp from ever running — leaving launch-stamp-less but otherwise mesh-owned
 * sessions permanently relay-unsafe.
 *
 * Mirror the local path: a session that is mesh-owned for THIS mesh self-heals
 * as long as we can hand the remote router a coordinator anchor to stamp.
 *
 *   - 'safe'         — already carries meshCoordinatorDaemonId; dispatch as-is.
 *   - 'self_heal'    — mesh-owned for this mesh, missing the anchor, but a
 *                      coordinatorDaemonId is resolvable → dispatch and let the
 *                      remote router stamp the anchor (parity with local path).
 *   - 'missing_anchor' — mesh-owned for this mesh, missing the anchor, AND no
 *                      coordinatorDaemonId resolvable → cannot delegate the stamp,
 *                      so completion events would still be undeliverable → block.
 *   - 'unsafe_alias' — not mesh-owned for this mesh (different mesh / unrelated
 *                      session). Dispatching risks aliasing an unrelated transcript
 *                      and orphaning completion events → block.
 */
export function classifyRemoteDelegateRelaySafety(
    session: any,
    meshId: string,
    nodeId: string,
    coordinatorDaemonId: string,
): 'safe' | 'self_heal' | 'missing_anchor' | 'unsafe_alias' {
    if (!isMeshOwnedDelegateSession(session, meshId, nodeId)) return 'unsafe_alias';
    if (hasRemoteRelayMetadata(session)) return 'safe';
    return coordinatorDaemonId ? 'self_heal' : 'missing_anchor';
}

export function chooseDispatchableSession(sessions: any[], providerType: string, meshId: string, nodeId: string, coordinatorDaemonId: string): any | undefined {
    const live = sessions.filter(session => !isTerminalSessionRecord(session));
    const matchingProvider = (session: any) => !providerType || session?.providerType === providerType || session?.cliType === providerType;
    // Accept mesh-owned sessions whose relay anchor is either already present or
    // self-healable at dispatch time (coordinatorDaemonId resolvable). Mirrors the
    // explicit-session relay-safety classification so auto-pick and explicit
    // dispatch converge on the same set of safe delegates.
    const meshSessions = live.filter((session: any) => {
        const safety = classifyRemoteDelegateRelaySafety(session, meshId, nodeId, coordinatorDaemonId);
        return safety === 'safe' || safety === 'self_heal';
    });
    // Only auto-pick an IDLE matching session. The previous
    // `|| meshSessions.find(matchingProvider)` fallback accepted a generating/busy
    // session, injecting a new task into a session mid-generation — the exact case
    // the explicit-session path guards against via resolveDeliveryDecision (queue or
    // reject when !idle). When no idle session exists, return undefined so the caller
    // dispatches sessionless and lets the worker pick/create a session (or the task
    // queues), instead of clobbering an in-flight one.
    return meshSessions.find(session => isIdleSessionRecord(session) && matchingProvider(session))
        || undefined;
}

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

export function findNestedPayload(value: any, predicate: (payload: any) => boolean): any {
    const seen = new Set<any>();
    const stack: Array<{ payload: any; depth: number }> = [{ payload: value, depth: 0 }];

    while (stack.length) {
        const { payload, depth } = stack.pop()!;
        if (predicate(payload)) return payload;
        if (!payload || typeof payload !== 'object' || seen.has(payload) || depth >= 8) continue;
        seen.add(payload);

        // Cloud/daemon relay layers have used both `result` and `payload` for
        // command_result bodies. Follow only those envelope keys so clone node
        // discovery stays tied to returned command payloads, not arbitrary data.
        for (const key of ['payload', 'result']) {
            if (key in payload) stack.push({ payload: payload[key], depth: depth + 1 });
        }
    }

    return value;
}

export function extractCloneNodePayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.node?.id));
}

export function extractGitStatus(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.status ?? value?.status ?? payload;
}

export function extractGitDiff(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.diffSummary ?? payload?.diff ?? value?.diffSummary ?? value?.diff ?? payload;
}

export function extractSubmodules(value: any, ignorePaths: string[]): any[] | undefined {
    const payload = unwrapCommandPayload(value);
    const subs = payload?.status?.submodules
        ?? payload?.submodules
        ?? value?.status?.submodules
        ?? value?.submodules;
    if (!Array.isArray(subs)) return undefined;
    if (ignorePaths.length === 0) return subs;
    const ignoreSet = new Set(ignorePaths);
    return subs.filter((s: any) => s?.path && !ignoreSet.has(s.path));
}

/**
 * Pull the reported provider-quota map out of a git_status response.
 *
 * Quota rides `reporterNodeFacts` — the versioned node-facts bundle the
 * reporting daemon ships wholesale. Only this ONE field is read out here; the
 * bundle itself must keep travelling opaquely through relays (deploy-lag
 * visibility design §a), so this is a read, never a rebuild. Returns undefined
 * for a reporter that predates the field, which the caller renders as "this
 * node never told us" — distinct from a reported entry whose status is a
 * failure.
 */
export function extractReporterNodeFactsQuota(value: any): Record<string, any> | undefined {
    const payload = unwrapCommandPayload(value);
    const facts = payload?.reporterNodeFacts ?? value?.reporterNodeFacts;
    const quota = facts?.quota;
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return undefined;
    return Object.keys(quota).length > 0 ? quota : undefined;
}

export function assignFullGitSnapshot(entry: Record<string, unknown>, status: any): void {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return;
    entry.git = status;
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
export const COMPACT_DETAILED_NODES_BYTE_BUDGET = 9000;

// Total byte budget for the whole compact node array (detail + minimal stubs).
// Nodes that don't fit even as a stub are folded into a counts+id-list summary so
// the array stays bounded on pathologically large meshes; every node id is still
// listed in foldedNodes.nodeIds, so nothing becomes undiscoverable.
//
// This must leave headroom for the compact payload's FIXED top-level overhead
// (branchConvergenceSummary, staleDaemonBuild* aggregates, activeWork*/ledger/
// scheduling summaries, sourceOfTruth/hints — ~12KB with a large stale mesh) so the
// whole compact string stays under the MCP token cap even for an all-noteworthy mesh
// (the contract asserted by mesh-compact-payload-budget.test.ts). That top-level
// overhead grew as compact aggregates were added, so 13000 here let a 12-node stale
// mesh tip the whole payload to ~25.2KB — over the 25KB budget. 11500 restores the
// margin (nodes + overhead ≈ 24KB) while still keeping the highest-severity nodes in
// detail and every node id discoverable (array stub or foldedNodes.nodeIds).
export const COMPACT_NODES_TOTAL_BYTE_BUDGET = 11500;


// Byte budget for the whole compact `missions` array (live active/paused missions).
// Completed/abandoned history is already folded to a counts+id summary upstream;
// this bounds the LIVE-mission detail so the section can't grow unbounded with the
// number of active/paused missions. Newest-active first; overflow is folded into
// `foldedMissions` (id list) so every live mission id stays addressable.
export const COMPACT_MISSIONS_BYTE_BUDGET = 6000;


// (compact node-fold helpers moved to ./mesh-compact.ts)

export function extractLaunchPayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.sessionId || payload?.id || payload?.runtimeSessionId));
}

export type MeshLaunchFailureClassification = {
    code: string;
    reason: string;
    transport: string;
    recoverable: boolean;
    retryRecommended: boolean;
    nextAction: string;
    noFallbackReason?: string;
};

export function classifyMeshLaunchFailure(error: unknown): MeshLaunchFailureClassification {
    const message = error instanceof Error ? error.message : String(error || 'launch failed');
    const lower = message.toLowerCase();
    const p2pClassification = classifyP2pRelayFailure(error, { command: 'launch_cli' });
    if (p2pClassification.recoverable) {
        return p2pClassification;
    }
    if (lower.includes('cannot connect to daemon ipc') || lower.includes('daemon ipc command')) {
        return {
            code: 'local_ipc_unavailable',
            reason: 'local_daemon_ipc_unavailable',
            transport: 'local_ipc',
            recoverable: true,
            retryRecommended: true,
            nextAction: 'Check the local daemon IPC connection, then retry mesh_launch_session once after the daemon is reachable.',
        };
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
        return {
            code: 'mesh_transport_timeout',
            reason: 'mesh_transport_timeout',
            transport: 'mesh_transport',
            recoverable: true,
            retryRecommended: true,
            nextAction: 'Check mesh transport health, then do one bounded retry before requeueing or relaunching the task.',
        };
    }
    return {
        code: 'mesh_launch_failed',
        reason: 'provider_launch_failed',
        transport: 'mesh_transport',
        recoverable: false,
        retryRecommended: false,
        nextAction: 'Inspect the provider launch error and fix the underlying provider/configuration issue before retrying.',
    };
}

export function buildWorktreeCleanupHint(node: LocalMeshNodeEntry): Record<string, unknown> | undefined {
    if (!node.isLocalWorktree) return undefined;
    return {
        tool: 'mesh_remove_node',
        args: { node_id: node.id, session_cleanup_mode: 'preserve' },
        hint: `If the worktree is no longer needed, remove the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`,
    };
}

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
    args: { session_id?: string; message: string; providerType?: string; verifiedSession?: any; meshContext?: { meshId: string; nodeId?: string; taskId?: string; coordinatorDaemonId?: string } },
): Promise<RemoteAgentDispatchResult> {
    const transport = ctx.transport as IpcTransport;
    const daemonId = node.daemonId!;

    // The coordinator anchor the remote router will stamp onto the worker session
    // at dispatch time (router.ts buildMeshWorkerRelayStamp). When present, a
    // mesh-owned session that was never launch-stamped can still self-heal to
    // relay-safe — exactly like the local direct-dispatch path.
    const dispatchCoordinatorDaemonId = readString(args.meshContext?.coordinatorDaemonId) || '';

    let sessionId = args.session_id?.trim() || '';
    // Resolve provider type: caller arg > node policy providerPriority > empty (fuzzy fallback)
    const providerPriorityList: string[] = Array.isArray((node.policy as any)?.providerPriority)
        ? (node.policy as any).providerPriority
        : [];
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

export function countUncommittedChanges(status: any): number {
    if (typeof status?.uncommittedChanges === 'number') return status.uncommittedChanges;
    const keys = ['staged', 'modified', 'untracked', 'deleted', 'renamed'];
    const counted = keys.reduce((sum, key) => sum + (Number.isFinite(Number(status?.[key])) ? Number(status[key]) : 0), 0);
    const conflicts = Array.isArray(status?.conflictFiles) ? status.conflictFiles.length : (status?.hasConflicts ? 1 : 0);
    return counted + conflicts;
}

export function isGitStatusDirty(status: any): boolean {
    if (typeof status?.isDirty === 'boolean') return status.isDirty;
    if (typeof status?.dirty === 'boolean') return status.dirty;
    if (Array.isArray(status?.submodules) && status.submodules.some((submodule: any) => submodule?.dirty || submodule?.outOfSync || submodule?.error)) return true;
    return countUncommittedChanges(status) > 0;
}


// Large structured fields that bloat refine/batch ledger entries (each can carry a
// full per-node validation plan + suggested config). In compact mode these are
// summarized rather than dropped — full detail stays available via verbose=true /
// mesh_reconcile_ledger.
// (large-value compaction utils moved to ./mesh-tool-shared.ts)

// LEDGER-TASK-TRACEABILITY (E1): compact a task_dispatched routingDecision for the
// slim ledger view — keep every scalar field (source, selectedNodeId, daemonId,
// resolvedProviderType/Model/ThinkingLevel/Difficulty, fitnessScore, reason, transport,
// requiredTagsResult) verbatim, and bound skippedCandidates to a handful with a dropped
// count so a large fleet's candidate list can't bloat the compact payload.
const ROUTING_SKIPPED_COMPACT_MAX = 5;
export function compactRoutingDecision(routing: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(routing)) {
        if (k === 'skippedCandidates' && Array.isArray(v)) {
            const kept = v.slice(0, ROUTING_SKIPPED_COMPACT_MAX);
            out[k] = kept;
            if (v.length > kept.length) out.skippedCandidatesDropped = v.length - kept.length;
        } else {
            out[k] = v;
        }
    }
    return out;
}

export function slimLedgerPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const slim: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
        if (k === 'message' || k === 'taskSummary') {
            slim[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
        } else if (k === 'routingDecision' && v && typeof v === 'object' && !Array.isArray(v)) {
            // LEDGER-TASK-TRACEABILITY (E1): the routing rationale (source, device/daemon,
            // resolved provider/model/thinking, why) is the whole point of task_dispatched —
            // preserve it even in compact mode. It is small by construction; only bound the
            // skippedCandidates list so a large fleet can't blow the compact budget. The
            // message/finalSummary truncation policy above is untouched.
            slim[k] = compactRoutingDecision(v as Record<string, unknown>);
        } else if (k === 'evidence' || k === 'workerResult' || k === 'gitStatus' || k === 'validationResults') {
            // Skip large nested evidence objects — accessible via mesh_reconcile_ledger if needed.
        } else if (k === 'finalSummary') {
            slim[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v;
        } else if (LARGE_LEDGER_FIELD_KEYS.has(k)) {
            // plan / validationPlan / suggestedConfig / nested payload — these are the
            // refine_batch task_dispatched offenders that blow past the token limit.
            slim[k] = summarizeLargeLedgerField(k, v);
        } else {
            // Primary, key-agnostic defense: elide any oversized nested evidence blob
            // (validationSummary, result, patchEquivalence, submoduleReachability, and
            // any future large key) by serialized byte size. Small scalars/short fields
            // are returned as-is.
            slim[k] = elideLargeNestedValue(k, v);
        }
    }
    return slim;
}

export function readRelatedRepos(node: LocalMeshNodeEntry): RepoMeshRelatedRepo[] {
    const raw = Array.isArray((node as any).relatedRepos)
        ? (node as any).relatedRepos
        : Array.isArray((node.policy as any)?.relatedRepos)
            ? (node.policy as any).relatedRepos
            : [];

    return raw
        .map((entry: any) => ({
            label: typeof entry?.label === 'string' ? entry.label.trim() : '',
            workspace: typeof entry?.workspace === 'string' ? entry.workspace.trim() : '',
        }))
        .filter((entry: RepoMeshRelatedRepo) => Boolean(entry.label && entry.workspace));
}

export function summarizeRelatedRepoStatus(repo: RepoMeshRelatedRepo, status: any): Record<string, unknown> {
    const dirty = isGitStatusDirty(status);
    return {
        label: repo.label,
        workspace: repo.workspace,
        isGitRepo: status?.isGitRepo === true,
        branch: status?.branch ?? null,
        upstream: status?.upstream ?? null,
        upstreamStatus: typeof status?.upstreamStatus === 'string' ? status.upstreamStatus : (status?.upstream ? 'unchecked' : 'no_upstream'),
        upstreamFetchedAt: Number.isFinite(Number(status?.upstreamFetchedAt)) ? Number(status.upstreamFetchedAt) : null,
        upstreamFetchError: typeof status?.upstreamFetchError === 'string' ? status.upstreamFetchError : null,
        ahead: Number.isFinite(Number(status?.ahead)) ? Number(status.ahead) : 0,
        behind: Number.isFinite(Number(status?.behind)) ? Number(status.behind) : 0,
        dirty,
        uncommittedChanges: countUncommittedChanges(status),
        head: status?.headCommit ?? null,
        lastCommitSummary: status?.headMessage ?? null,
        ...(status?.reason ? { reason: status.reason } : {}),
        ...(status?.error ? { error: status.error } : {}),
    };
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

export function findNodeByWorkspace(mesh: LocalMeshEntry, workspace: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.workspace === workspace);
    if (!node) throw new Error(`Workspace '${workspace}' is not a member of mesh '${mesh.name}'`);
    return node;
}

export function readProviderPriority(policy: unknown): string[] {
    const raw = (policy as any)?.providerPriority;
    return Array.isArray(raw)
        ? raw.map((type: unknown) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
        : [];
}

/**
 * Ordered, de-duplicated provider types a node can launch — every provider it could
 * be asked to run. Reads `policy.slots` (the SSOT — ORCHESTRATION_NODE_SLOTS.md),
 * unioned with the legacy `policy.providerPriority`. Used to ENUMERATE per-provider
 * capability-tag sets for observability (buildNodeCapabilityExposure). Note: the
 * mesh_launch_session fail-closed GATE deliberately checks slots ALONE (not this
 * union) — providerPriority is a preference hint, not a capability whitelist.
 */
export function readNodeSupportedProviders(policy: unknown): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (type: unknown) => {
        const trimmed = typeof type === 'string' ? type.trim() : '';
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push(trimmed);
    };
    for (const slot of normalizeNodeCapabilitySlots((policy as any)?.slots)) push(slot.provider);
    for (const type of readProviderPriority(policy)) push(type);
    return out;
}


/**
 * Surface the capability tags a node can match against required_tags routing,
 * plus its operator-defined capability labels. Computed via the same
 * buildMeshNodeCapabilityTags the queue/dispatch matcher uses, so what the
 * coordinator sees is exactly what routing will match.
 *
 *   - capabilityTags: the representative tag set (os=/arch=/converge= plus the
 *     first declared provider's provider= tag and any worktree= tag). This is
 *     what nodeSatisfiesRequiredTags compares against when no provider is pinned.
 *   - capabilityTagsByProvider: per-provider tag sets, one per entry in the
 *     node's providerPriority — the provider= tag differs by provider, so a tag
 *     like provider=codex-cli only matches when that provider is launchable here.
 *   - capabilities: the operator-defined capability labels persisted on the node
 *     (already folded into capabilityTags; surfaced raw so operators can see
 *     which tags they configured vs. which are auto-advertised).
 *
 * Note: os=/arch= reflect the TARGET node's own machine — for remote member
 * nodes these come from the platform/arch the member daemon stamped into its
 * node record at join time (node.userOverrides.platform/arch), falling back to
 * the local process platform/arch only for the coordinator's own / local
 * worktree nodes. This matches the matcher's behavior, so the exposed set is a
 * faithful preview of routing, not an independent re-derivation.
 */
export function buildNodeCapabilityExposure(node: LocalMeshNodeEntry): {
    capabilityTags: string[];
    capabilityTagsByProvider?: Record<string, string[]>;
    capabilities?: string[];
} {
    // Enumerate EVERY provider the node can launch (policy.slots is the single source
    // of truth, else legacy providerPriority) — not just providerPriority — so the
    // per-provider tag sets cover a provider that lives in slots but is not the first
    // priority entry (e.g. cursor-cli). The representative capabilityTags already
    // advertises a provider= tag for each of these (buildMeshNodeCapabilityTags).
    const providers = readNodeSupportedProviders(node.policy);
    const capabilityTags = buildMeshNodeCapabilityTags(node);
    const exposure: {
        capabilityTags: string[];
        capabilityTagsByProvider?: Record<string, string[]>;
        capabilities?: string[];
    } = { capabilityTags };
    if (providers.length) {
        const byProvider: Record<string, string[]> = {};
        for (const provider of providers) {
            byProvider[provider] = buildMeshNodeCapabilityTags(node, provider);
        }
        exposure.capabilityTagsByProvider = byProvider;
    }
    const capabilities = Array.isArray(node.capabilities)
        ? node.capabilities.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim())
        : [];
    if (capabilities.length) exposure.capabilities = capabilities;
    return exposure;
}

export function readSpawnedSessionVisibility(policy: unknown): 'visible' | 'hidden' {
    return (policy as any)?.spawnedSessionVisibility === 'hidden' ? 'hidden' : 'visible';
}

export function missingProviderPriorityMessage(nodeId: string): string {
    return `Node '${nodeId}' has no providerPriority policy; pass type explicitly or configure node.policy.providerPriority`;
}

export function getNodeLaunchReadiness(node: LocalMeshNodeEntry): Record<string, unknown> {
    const bootstrap = (node as any).worktreeBootstrap;
    if ((node as any).isLocalWorktree && bootstrap?.status === 'failed' && bootstrap?.required !== false) {
        return {
            providerPriority: readProviderPriority(node.policy),
            launchReady: false,
            launchBlockedReason: 'worktree_bootstrap_failed',
            launchBlockedMessage: typeof bootstrap.error === 'string' && bootstrap.error.trim()
                ? bootstrap.error.trim()
                : 'Required worktree bootstrap failed; resolve it before launching an agent into this node.',
            worktreeBootstrap: bootstrap,
        };
    }

    const providerPriority = readProviderPriority(node.policy);
    if (providerPriority.length) {
        return {
            providerPriority,
            launchReady: true,
        };
    }

    return {
        providerPriority,
        launchReady: false,
        launchBlockedReason: 'missing_provider_priority',
        launchBlockedMessage: missingProviderPriorityMessage(node.id),
    };
}

// MESH_LAUNCH_SESSION SEMANTICS (pinned, rc.15 orchestration RCA Fix B): mesh_launch_session is
// an EXPLICIT, caller-directed spawn — the caller is asking for a NEW session on this node right
// now, force or not. By default this block does NOT refuse a 'running' worktreeBootstrap status;
// it only fail-closes on a 'failed' bootstrap, or (opt-in via mesh policy
// requireBootstrapBeforeLaunch) any non-'ready' status. This is DELIBERATELY more permissive than
// the two automatic paths that share the same worktreeBootstrap signal:
//   - auto-launch candidacy (mesh-queue-assignment.isLaunchableNode → shouldDeferDispatchForBootstrap)
//     now excludes a 'running' node outright, so the background queue drain never spawns an
//     ORPHAN session competing with the bootstrap's own session-under-construction.
//   - explicit mesh_send_task dispatch to a node with 'running' bootstrap (med-family/cli-agent.ts
//     agent_command) defers UNLESS the caller pinned a specific target session that is
//     independently re-confirmed idle/ready right now (narrow, session-scoped override — never
//     applies to a brand-new spawn, since there is no existing session to confirm).
// mesh_launch_session has no such override to reason about because it never targets an existing
// session in the first place — every call is a fresh spawn, so the caller/coordinator remains
// responsible for not launching redundantly onto a node mid-bootstrap. Do not add an implicit
// 'running' refusal here without also updating MESH_LAUNCH_SESSION_TOOL's description — a change
// here is a documented contract change, not just an internal tweak.
export function getWorktreeBootstrapLaunchBlock(node: LocalMeshNodeEntry, meshPolicy?: unknown): Record<string, unknown> | undefined {
    if (!(node as any).isLocalWorktree) return undefined;
    const bootstrap = (node as any).worktreeBootstrap;

    // M2-4 (opt-in): with policy.requireBootstrapBeforeLaunch, any non-ready
    // bootstrap state blocks the launch fail-closed - not just failures.
    const requireReady = !!(meshPolicy && typeof meshPolicy === 'object'
        && (meshPolicy as Record<string, unknown>).requireBootstrapBeforeLaunch === true);
    if (requireReady && bootstrap?.status !== 'ready') {
        return {
            success: false,
            code: 'bootstrap_not_ready',
            error: `Node '${node.id}' bootstrap state is '${bootstrap?.status ?? 'unknown'}' and mesh policy requireBootstrapBeforeLaunch is enabled.`,
            nodeId: node.id,
            worktreeBootstrap: bootstrap ?? null,
            recoveryHint: 'Run the worktree bootstrap (clone runOnClone or a refine with bootstrap inherit) until the node reports ready, or disable requireBootstrapBeforeLaunch.',
        };
    }

    if (bootstrap?.status !== 'failed' || bootstrap?.required === false) return undefined;
    return {
        success: false,
        code: 'worktree_bootstrap_failed',
        error: typeof bootstrap.error === 'string' && bootstrap.error.trim()
            ? bootstrap.error.trim()
            : `Node '${node.id}' has a failed required worktree bootstrap.`,
        nodeId: node.id,
        worktreeBootstrap: bootstrap,
        recoveryHint: 'Fix the configured worktree bootstrap command or remove/recreate the worktree node before launching an agent.',
    };
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
 * One get_status_metadata probe → both the live session list and the daemon's
 * build stamp. Used by mesh_status so a single daemon-wide probe yields the
 * sessions AND the `daemonBuild` field (commit/version of the running daemon).
 */
export async function collectLiveStatusProbe(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
): Promise<{ sessions: any[]; daemonBuild?: { commit: string; commitShort: string; version: string; builtAt?: string } }> {
    try {
        // OFFLINE-NODE-STATUS-REFRESH: part of the mesh_status per-node assembly — mark it
        // status-origin so the relay to an offline peer uses the SHORT connect-wait budget.
        const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {}, { statusProbe: true });
        return {
            sessions: extractStatusMetadataSessions(statusResult),
            daemonBuild: extractDaemonBuildInfo(statusResult),
        };
    } catch {
        return { sessions: [] };
    }
}

export function extractDaemonBuildInfo(value: any): { commit: string; commitShort: string; version: string; builtAt?: string } | undefined {
    const payload = unwrapCommandPayload(value);
    const build = payload?.daemonBuild && typeof payload.daemonBuild === 'object'
        ? payload.daemonBuild
        : (value?.daemonBuild && typeof value.daemonBuild === 'object' ? value.daemonBuild : undefined);
    if (!build) return undefined;
    const commit = readString(build.commit);
    if (!commit) return undefined;
    return {
        commit,
        commitShort: readString(build.commitShort) || commit.slice(0, 7),
        version: readString(build.version) || 'unknown',
        ...(readString(build.builtAt) ? { builtAt: readString(build.builtAt) } : {}),
    };
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

export function buildBranchConvergence(
    mesh: LocalMeshEntry,
    node: LocalMeshNodeEntry,
    status: any,
    dirty: boolean,
    uncommittedChanges: number,
): Record<string, unknown> {
    const defaultBranch = readString(mesh.defaultBranch) ?? 'main';
    const branch = readString(status?.branch) ?? readString(node.worktreeBranch) ?? null;
    const ahead = readNumeric(status?.ahead);
    const behind = readNumeric(status?.behind);
    const upstream = readString(status?.upstream) ?? null;
    const upstreamStatus = readString(status?.upstreamStatus) ?? (upstream ? 'unchecked' : 'no_upstream');
    const hasConflicts = status?.hasConflicts === true || (Array.isArray(status?.conflictFiles) && status.conflictFiles.length > 0);
    const base = {
        defaultBranch,
        branch,
        upstream,
        upstreamStatus,
        ahead,
        behind,
        isWorktree: node.isLocalWorktree === true,
        isDefaultBranch: branch === defaultBranch,
    };

    if (status?.isGitRepo !== true) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'git_status_unavailable',
            nextStep: `Resolve git status for node '${node.id}' before marking the task complete.`,
        };
    }

    if (!branch) {
        return {
            ...base,
            status: 'blocked_review',
            needsConvergence: true,
            reason: 'branch_unknown',
            nextStep: `Inspect node '${node.id}' git branch before deciding whether it is merged to ${defaultBranch}.`,
        };
    }

    if (hasConflicts || dirty || uncommittedChanges > 0) {
        return {
            ...base,
            status: 'not_mergeable',
            needsConvergence: true,
            reason: hasConflicts ? 'conflicts_present' : 'dirty_workspace',
            nextStep: `Commit, checkpoint, or resolve node '${node.id}' before any main convergence step.`,
        };
    }

    if (branch === defaultBranch) {
        if (upstream && upstreamStatus !== 'fresh') {
            return {
                ...base,
                status: 'blocked_review',
                needsConvergence: true,
                reason: 'default_branch_upstream_unverified',
                nextStep: `Refresh ${defaultBranch}'s upstream refs or resolve the fetch failure before declaring convergence complete for node '${node.id}'.`,
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

    if (node.isLocalWorktree) {
        return {
            ...base,
            status: 'cleanup_candidate',
            needsConvergence: true,
            reason: 'clean_non_default_worktree_branch',
            nextStep: `Run mesh_refine_node(node_id: "${node.id}") or explicitly classify this worktree as blocked_review/not_mergeable before ending the task.`,
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


// In compact mode the per-node followUp rows are capped so this summary can't grow
// unbounded with node count; the dropped rows are folded into a by-status count and
// the full list stays available via verbose.
export const COMPACT_MAX_CONVERGENCE_FOLLOWUPS = 12;

export function summarizeBranchConvergence(nodes: any[], compact = false): Record<string, unknown> {
    const allFollowUps = nodes
        .filter(node => node?.branchConvergence?.needsConvergence === true)
        .map(node => ({
            nodeId: node.nodeId,
            // workspace is a long absolute path redundant with nodeId — drop it in
            // compact mode to keep this summary bounded.
            ...(compact ? {} : { workspace: node.workspace }),
            branch: node.branchConvergence.branch,
            status: node.branchConvergence.status,
            reason: node.branchConvergence.reason,
            // The per-node nextStep is long prose that repeats node ids/branch names.
            // In compact mode drop it (the status+reason carry the actionable signal;
            // verbose still surfaces the full nextStep) so this summary stays bounded
            // as node count grows.
            ...(compact ? {} : { nextStep: node.branchConvergence.nextStep }),
        }));

    const byStatus: Record<string, number> = {};
    for (const f of allFollowUps) {
        const s = typeof f.status === 'string' ? f.status : 'unknown';
        byStatus[s] = (byStatus[s] ?? 0) + 1;
    }

    const followUps = compact ? allFollowUps.slice(0, COMPACT_MAX_CONVERGENCE_FOLLOWUPS) : allFollowUps;
    const omitted = allFollowUps.length - followUps.length;

    return {
        needsFollowUp: allFollowUps.length > 0,
        unresolvedCount: allFollowUps.length,
        byStatus,
        requiredFinalStates: ['merged_to_main', 'pushed_feature_branch_needs_merge', 'blocked_review', 'cleanup_candidate', 'not_mergeable'],
        followUps,
        ...(omitted > 0 ? { followUpsOmitted: omitted, followUpsHint: 'Per-node followUp rows are capped in compact mode; counts above are complete. Use verbose=true for the full list.' } : {}),
    };
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

export function normalizePendingMeshCoordinatorEvents(value: any): any[] {
    const payload = unwrapCommandPayload(value);
    const events = Array.isArray(payload?.events)
        ? payload.events
        : Array.isArray(value?.events)
            ? value.events
            : [];
    return events.filter((event: unknown) => event && typeof event === 'object');
}

export function buildMeshForwardPayloadFromPendingEvent(event: any): Record<string, unknown> {
    const metadataEvent = event?.metadataEvent && typeof event.metadataEvent === 'object'
        ? event.metadataEvent as Record<string, unknown>
        : {};
    return {
        event: readString(event?.event),
        meshId: readString(event?.meshId),
        nodeId: readString(event?.nodeId) || readString(metadataEvent.meshNodeId),
        workspace: readString(event?.workspace) || readString(metadataEvent.workspace),
        targetSessionId: readString(metadataEvent.targetSessionId) || readString(metadataEvent.sessionId) || readString(metadataEvent.instanceId),
        providerType: readString(metadataEvent.providerType),
        providerSessionId: readString(metadataEvent.providerSessionId),
        finalSummary: readString(metadataEvent.finalSummary) || readString(metadataEvent.summary),
        jobId: readString(metadataEvent.jobId),
        interactionId: readString(metadataEvent.interactionId),
        status: readString(metadataEvent.status),
        targetDaemonId: readString(metadataEvent.targetDaemonId),
        // RC32: carry the coordinator DAEMON anchor across the remote-pull relay (the
        // pending event stores it top-level, not inside metadataEvent). The receive-side
        // whitelist (daemon-core buildRelayMetadataEvent) reads it back so a sessionless
        // refine terminal event re-queues targeted at THIS coordinator instead of
        // self-fallback-stamping the relaying worker daemon.
        targetCoordinatorDaemonId: readString(event?.targetCoordinatorDaemonId),
        startedAt: readString(metadataEvent.startedAt),
        completedAt: readString(metadataEvent.completedAt),
        retryOfJobId: readString(metadataEvent.retryOfJobId),
        ...(metadataEvent.result && typeof metadataEvent.result === 'object' && !Array.isArray(metadataEvent.result) ? { result: metadataEvent.result } : {}),
        ...(metadataEvent.intentional === true ? { intentional: true } : {}),
        ...(metadataEvent.intentionalStop === true ? { intentionalStop: true } : {}),
        ...(metadataEvent.operatorCleanup === true ? { operatorCleanup: true } : {}),
        ...(readString(metadataEvent.reason) ? { reason: readString(metadataEvent.reason) } : {}),
        ...(readString(metadataEvent.stopReason) ? { stopReason: readString(metadataEvent.stopReason) } : {}),
        ...(readString(metadataEvent.cleanupReason) ? { cleanupReason: readString(metadataEvent.cleanupReason) } : {}),
        ...(readString(metadataEvent.source) ? { source: readString(metadataEvent.source) } : {}),
        // T4 (B3b): carry the v2 envelope across the P2P relay so a remote worker's
        // completion pulled by an MCP/LLM coordinator re-forwards with its ORIGINAL
        // eventId (idempotency) and unicast routing intact, matching the reconcile-loop
        // relay path (buildForwardPayloadFromPending). Spread LAST so the authoritative
        // envelope always wins. Empty for a v1 event (version-skew safe).
        ...serializeV2EnvelopeToWire(event as any),
    };
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
 * Distinguish a P2P read_chat transport failure between "the peer is reachable but
 * saturated/slow" (REQUEST_TIMEOUT — acked, result deadline elapsed) and "the peer was
 * never connected / the request never reached a working handler" (CONNECT_TIMEOUT,
 * ACK_TIMEOUT delivery failure, NO_PEER, datachannel closed, …). Both still warrant the
 * cached-summary fallback, but the advisory wording differs so the coordinator knows
 * whether a quick retry is plausible (saturated) or the daemon is simply offline.
 *
 * The transport-layer code (meshCode) is lost crossing IPC — only the error message
 * string survives — so classification is by message text.
 */
export function classifyReadChatTransportCause(error: unknown): 'not_connected' | 'saturated' {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    if (/not acknowledged|delivery failure|channel never opened|connect timed out|not connected|datachannel|disconnected|\bclosed\b|offline|no route|failed to initiate p2p|p2p mesh is not available|connect queue full/.test(message)) {
        return 'not_connected';
    }
    // Acked but the result deadline elapsed (REQUEST_TIMEOUT) — peer reachable but
    // saturated / still working and could not return the transcript in time.
    return 'saturated';
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
