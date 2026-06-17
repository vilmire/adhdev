/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * 29 tools: mesh_status, mesh_mission_upsert, mesh_mission_list, mesh_list_nodes, mesh_enqueue_task, mesh_view_queue,
 *           mesh_queue_cancel, mesh_queue_requeue, mesh_send_task, mesh_read_chat,
 *           mesh_read_debug, mesh_launch_session, mesh_git_status,
 *           mesh_fast_forward_node, mesh_checkpoint, mesh_approve,
 *           mesh_clone_node, mesh_remove_node, mesh_refine_node,
 *           mesh_refine_config_schema, mesh_validate_refine_config,
 *           mesh_suggest_refine_config, mesh_refine_plan,
 *           mesh_cleanup_sessions, mesh_task_history, mesh_reconcile_ledger,
 *           mesh_review_inbox
 */

import { randomUUID } from 'node:crypto';
import { IpcTransport } from '../transports/ipc.js';
import type { CommandTransport } from '../transports/mode.js';
import { compactChatPayload, isCoordinatorVisibleMessage, messageContent } from './chat-compact.js';
import { annotateRapidReadChatAdvisory } from './read-chat-polling-advisory.js';
import type { LocalMeshEntry, LocalMeshNodeEntry, MeshActiveWorkSummary, RepoMeshPolicy, RepoMeshRelatedRepo } from '@adhdev/daemon-core';
import {
    appendLedgerEntry,
    appendRemoteLedgerEntries,
    buildCompactStaleDirectWorkSummary,
    buildMeshActiveWork,
    buildMeshAsyncRefineJobs,
    summarizeMeshAsyncRefineJobs,
    buildMeshLedgerReconciliationEvidence,
    buildMeshLedgerReplicaEvidence,
    buildMeshNodeCapabilityTags,
    buildP2pRelayFailurePayload,
    cancelTask,
    classifyP2pRelayFailure,
    classifyStaleDirectForPrune,
    deleteDirectDispatchesByTaskId,
    describeTaskDependencyState,
    drainPendingMeshCoordinatorEvents,
    enqueueTask,
    computeMeshMissionStats,
    computeMeshTaskStats,
    getActiveMeshMissionSummaries,
    getMeshStatusMissionSummaries,
    listMeshMissionSummaries,
    MESH_MISSION_STATUSES,
    upsertMeshMission,
    getActiveDirectDispatches,
    getQueue,
    getLedgerSummary,
    getSessionRecoveryContext,
    insertDirectDispatch,
    recordDirectDispatchTask,
    isP2pRelayTransportFailure,
    markStaleDirectDispatches,
    nodeSatisfiesRequiredTags,
    normalizeMeshCapabilityTags,
    readLedgerEntries,
    readLedgerSlice,
    readLedgerSliceFromStore,
    reconcileDirectDispatchCompletionFromTranscript,
    recordMeshToolCall,
    requeueTask,
    resolveDelegatedWorkerAutoApprove,
    validateMeshTaskModeRequest,
} from '@adhdev/daemon-core';

export interface MeshContext {
    mesh: LocalMeshEntry;
    transport: CommandTransport;
    /** Daemon ID for this local machine (local mode) */
    localDaemonId?: string;
    /** Machine Registry ID for this local machine */
    localMachineId?: string;
    /** Hostname of the daemon/MCP coordinator machine. */
    coordinatorHostname?: string;
}

type MeshSessionProviderMetadata = {
    providerType: string;
    providerSessionId?: string;
};

const SESSION_PROVIDER_METADATA_TTL_MS = 30 * 60_000;
type TimestampedSessionMetadata = MeshSessionProviderMetadata & { expiresAt: number };
const meshSessionProviderMetadata = new Map<string, TimestampedSessionMetadata>();

function getSessionMetadata(key: string): MeshSessionProviderMetadata | undefined {
    const entry = meshSessionProviderMetadata.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        meshSessionProviderMetadata.delete(key);
        return undefined;
    }
    return entry;
}

const ACTIVE_WORK_POLLING_BACKOFF_MS = 60_000;

interface MeshPollingGuidance {
    activeGeneratingWork: true;
    generatingCount: number;
    doNotPollBefore: string;
    eventSurface: 'pendingCoordinatorEvents';
    nextRecommendedAction: string;
    message: string;
}

function buildActiveWorkPollingGuidance(summary: MeshActiveWorkSummary, now = Date.now()): MeshPollingGuidance | undefined {
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

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function summarizeTaskMessage(message: string): { taskTitle: string; taskSummary: string } {
    const taskSummary = message.replace(/\s+/g, ' ').trim();
    const taskTitle = taskSummary.length > 96 ? `${taskSummary.slice(0, 93)}...` : taskSummary;
    return { taskTitle: taskTitle || '(untitled task)', taskSummary };
}

function buildDirectTaskPayload(
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
    };
}

function findNode(mesh: LocalMeshEntry, nodeId: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`Node '${nodeId}' is not a member of mesh '${mesh.name}'`);
    return node;
}

const DUPLICATE_DISPATCH_WINDOW_MS = 60_000;
const STALE_ASSIGNED_QUEUE_MS = 30 * 60_000;
const OLD_HISTORICAL_QUEUE_RECORD_MS = 7 * 24 * 60 * 60_000;
const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'assigned']);
const HISTORICAL_QUEUE_STATUSES = new Set(['completed', 'failed', 'cancelled']);
type QueueViewMode = 'all' | 'active' | 'historical';

/**
 * Refresh the MCP process's mesh snapshot from the daemon inline mesh cache.
 * This is required for status/list tools when a previous MCP process already
 * created or removed worktree nodes through clone_mesh_node/remove_mesh_node.
 */
async function refreshMeshFromDaemon(ctx: MeshContext): Promise<void> {
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

async function syncCoordinatorDaemonMeshCache(ctx: MeshContext): Promise<void> {
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

async function findNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry> {
    const hit = ctx.mesh.nodes.find(n => n.id === nodeId);
    if (hit && !hit.isLocalWorktree) return hit;

    await refreshMeshFromDaemon(ctx);

    const refreshed = ctx.mesh.nodes.find(n => n.id === nodeId);
    if (!refreshed) throw new Error(`Node '${nodeId}' is not a member of mesh '${ctx.mesh.name}'`);
    return refreshed;
}

async function findOptionalNodeWithRefresh(ctx: MeshContext, nodeId: string): Promise<LocalMeshNodeEntry | null> {
    const hit = ctx.mesh.nodes.find(n => n.id === nodeId);
    if (hit && !hit.isLocalWorktree) return hit;

    await refreshMeshFromDaemon(ctx);

    return ctx.mesh.nodes.find(n => n.id === nodeId) ?? null;
}

function hasRecentDuplicateDispatch(ctx: MeshContext, args: { node_id: string; session_id?: string; message: string }): { duplicate: boolean; entry?: any; source?: 'ledger' | 'queue' } {
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

function buildMissingNodeReadChatRecovery(ctx: MeshContext, args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean }): Record<string, unknown> {
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

type QueueLivenessIndex = {
    nodeIds: Set<string>;
    nodeSessionIds: Map<string, Set<string>>;
};

function readSessionRecordId(session: any): string | undefined {
    return readString(session?.id)
        || readString(session?.sessionId)
        || readString(session?.session_id)
        || readString(session?.runtimeSessionId)
        || readString(session?.runtime_session_id)
        || readString(session?.instanceId)
        || readString(session?.instance_id);
}

function extractStatusMetadataSessions(value: any): any[] {
    const payload = unwrapCommandPayload(value);
    const status = payload?.status && typeof payload.status === 'object'
        ? payload.status
        : payload;
    return Array.isArray(status?.sessions) ? status.sessions : [];
}

function resolveSessionProviderType(session: any): string {
    return readString(session?.providerType)
        || readString(session?.cliType)
        || readString(session?.agentType)
        || '';
}

function isMeshCoordinatorSessionRecord(session: any): boolean {
    return Boolean(
        readString(session?.settings?.meshCoordinatorFor)
        || readString(session?.meta?.meshCoordinatorFor)
        || readString(session?.metadata?.meshCoordinatorFor)
        || readString(session?.meshCoordinatorFor),
    );
}

/**
 * Returns true when a session has no mesh delegation metadata at all — neither
 * meshNodeFor (worker) nor meshCoordinatorFor (coordinator).  Dispatching a
 * worker task to such a session is unsafe: the session may be the coordinator's
 * own CLI session (self-send risk), an unrelated session, or a stale record
 * whose providerSessionId now aliases the coordinator's transcript.
 *
 * The check intentionally fails closed: an explicit delegate session launched
 * via mesh_launch_session always carries meshNodeFor, so any safe target passes.
 */
function isUnmanagedSessionRecord(session: any): boolean {
    const hasMeshNodeFor = Boolean(
        readString(session?.settings?.meshNodeFor)
        || readString(session?.meta?.meshNodeFor)
        || readString(session?.metadata?.meshNodeFor)
        || readString(session?.meshNodeFor),
    );
    if (hasMeshNodeFor) return false;
    if (isMeshCoordinatorSessionRecord(session)) return false;
    // launchedByCoordinator is set by the daemon when it auto-launches a worker
    // session in response to a queue task; treat it as a managed delegate.
    const launchedByCoordinator = Boolean(
        session?.settings?.launchedByCoordinator === true
        || session?.meta?.launchedByCoordinator === true
        || session?.launchedByCoordinator === true,
    );
    return !launchedByCoordinator;
}

function isWorkerTaskMode(taskMode: string | undefined): boolean {
    return taskMode !== 'live_debug_readonly';
}

function addSessionRecord(target: Set<string>, session: any): void {
    if (!session || typeof session !== 'object' || isTerminalSessionRecord(session)) return;
    const sessionId = readSessionRecordId(session);
    if (sessionId) target.add(sessionId);
}

function collectNodeSessionIds(node: any): Set<string> {
    const sessions = new Set<string>();
    const sessionArrays = [
        node?.sessions,
        node?.activeSessions,
        node?.active_sessions,
        node?.lastProbe?.sessions,
        node?.last_probe?.sessions,
        node?.lastProbe?.status?.sessions,
        node?.last_probe?.status?.sessions,
    ];
    for (const value of sessionArrays) {
        if (Array.isArray(value)) value.forEach(session => addSessionRecord(sessions, session));
    }

    const sessionRecords = [
        node?.activeSession,
        node?.active_session,
        node?.currentSession,
        node?.current_session,
        node?.runtimeSession,
        node?.runtime_session,
        node?.session,
        node?.lastProbe?.activeSession,
        node?.last_probe?.active_session,
        node?.lastProbe?.currentSession,
        node?.last_probe?.current_session,
        node?.lastProbe?.session,
        node?.last_probe?.session,
    ];
    sessionRecords.forEach(session => addSessionRecord(sessions, session));
    return sessions;
}

function buildQueueLivenessIndex(mesh?: LocalMeshEntry): QueueLivenessIndex {
    const nodeIds = new Set<string>();
    const nodeSessionIds = new Map<string, Set<string>>();
    for (const node of Array.isArray(mesh?.nodes) ? mesh.nodes : []) {
        const nodeId = readString((node as any).id) || readString((node as any).nodeId) || readString((node as any).node_id);
        if (!nodeId) continue;
        nodeIds.add(nodeId);
        const sessions = collectNodeSessionIds(node);
        if (sessions.size > 0) nodeSessionIds.set(nodeId, sessions);
    }
    return { nodeIds, nodeSessionIds };
}

function queueAssignmentStaleReason(task: any, liveness: QueueLivenessIndex): string | undefined {
    if (task?.status !== 'assigned') return undefined;
    const nodeId = readString(task.assignedNodeId) || readString(task.nodeId) || readString(task.node_id) || readString(task.targetNodeId);
    const sessionId = readString(task.assignedSessionId) || readString(task.sessionId) || readString(task.session_id) || readString(task.targetSessionId);

    if (nodeId && liveness.nodeIds.size > 0 && !liveness.nodeIds.has(nodeId)) {
        return 'assigned node is not present in the current mesh snapshot';
    }
    if (nodeId && sessionId && liveness.nodeSessionIds.has(nodeId) && !liveness.nodeSessionIds.get(nodeId)!.has(sessionId)) {
        return 'assigned session is not live on the assigned node';
    }

    const updatedAt = new Date(task.updatedAt).getTime();
    const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : null;
    if (!nodeId && ageMs !== null && ageMs >= STALE_ASSIGNED_QUEUE_MS) {
        return 'assigned task has no assigned node metadata';
    }
    return undefined;
}

function buildQueueStatusSummary(queue: any[]): Record<string, unknown> {
    const counts = { pending: 0, assigned: 0, completed: 0, failed: 0, cancelled: 0 };
    let staleAssigned = 0;
    for (const task of queue) {
        const status = typeof task?.status === 'string' ? task.status : undefined;
        if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
            counts[status as keyof typeof counts] += 1;
        }
        if (status === 'assigned' && task?.staleAssigned === true) staleAssigned += 1;
    }
    const liveAssigned = Math.max(0, counts.assigned - staleAssigned);
    return {
        totalCount: queue.length,
        activeCount: counts.pending + liveAssigned,
        historicalCount: counts.completed + counts.failed + counts.cancelled,
        counts,
        activeCounts: {
            pending: counts.pending,
            assigned: liveAssigned,
        },
        staleAssignedCount: staleAssigned,
        rawActiveCounts: {
            pending: counts.pending,
            assigned: counts.assigned,
        },
        historicalCounts: {
            completed: counts.completed,
            failed: counts.failed,
            cancelled: counts.cancelled,
        },
    };
}

function normalizeQueueViewMode(value: unknown): QueueViewMode {
    return value === 'active' || value === 'historical' || value === 'all' ? value : 'all';
}

function sanitizeQueueStatusFilter(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const statuses = value
        .map(item => typeof item === 'string' ? item.trim() : '')
        .filter(status => ACTIVE_QUEUE_STATUSES.has(status) || HISTORICAL_QUEUE_STATUSES.has(status));
    return statuses.length ? Array.from(new Set(statuses)) : undefined;
}

function filterQueueForView(queue: any[], view: QueueViewMode, statuses?: string[]): any[] {
    if (statuses?.length) {
        const allowed = new Set(statuses);
        return queue.filter(task => allowed.has(String(task?.status || '')));
    }
    if (view === 'active') return queue.filter(task => ACTIVE_QUEUE_STATUSES.has(String(task?.status || '')));
    if (view === 'historical') return queue.filter(task => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
    return queue;
}

function prioritizeActiveQueueRows(queue: any[]): any[] {
    const active: any[] = [];
    const historical: any[] = [];
    const other: any[] = [];
    for (const task of queue) {
        const status = String(task?.status || '');
        if (ACTIVE_QUEUE_STATUSES.has(status)) active.push(task);
        else if (HISTORICAL_QUEUE_STATUSES.has(status)) historical.push(task);
        else other.push(task);
    }
    return [...active, ...other, ...historical];
}

function slimQueueTask(task: any): Record<string, unknown> {
    return {
        id: task?.id,
        status: task?.status,
        assignedNodeId: task?.assignedNodeId,
        assignedSessionId: task?.assignedSessionId,
        targetNodeId: task?.targetNodeId,
        targetSessionId: task?.targetSessionId,
        updatedAt: task?.updatedAt,
        staleAssigned: task?.staleAssigned === true,
        staleReason: task?.staleReason,
    };
}

function buildQueueMaintenanceReport(queue: any[]): Record<string, unknown> {
    const now = Date.now();
    const staleAssignedTasks = queue
        .filter(task => task?.status === 'assigned' && task?.staleAssigned === true)
        .map(slimQueueTask);
    const historicalTasks = queue.filter(task => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
    const oldHistoricalTasks = historicalTasks
        .filter(task => {
            const updatedAt = new Date(task?.updatedAt).getTime();
            return Number.isFinite(updatedAt) && now - updatedAt >= OLD_HISTORICAL_QUEUE_RECORD_MS;
        })
        .map(task => ({
            ...slimQueueTask(task),
            cleanupClass: 'old_historical_record',
            reason: 'terminal queue record is older than the read-only maintenance threshold',
        }));
    const cleanupCandidates = [
        ...staleAssignedTasks.map(task => ({
            ...task,
            cleanupClass: 'stale_assigned',
            reason: typeof task.staleReason === 'string' ? task.staleReason : 'active assigned task does not match current live mesh node/session state',
            suggestedOperation: 'operator_review_then_requeue_or_cancel',
        })),
        ...oldHistoricalTasks.map(task => ({
            ...task,
            suggestedOperation: 'operator_review_then_archive_or_keep',
        })),
    ];
    return {
        readOnly: true,
        mutationPerformed: false,
        sourceOfTruth: 'mesh_work_queue_file',
        staleAssignedDefinition: 'Only active assigned queue rows are stale candidates, and only when the assigned node/session is absent from the current live mesh snapshot.',
        historicalDefinition: 'completed/failed/cancelled rows are historical ledger records and never active assignments.',
        staleAssignedTasks,
        staleAssignedCount: staleAssignedTasks.length,
        historicalRecordCount: historicalTasks.length,
        oldHistoricalRecordCount: oldHistoricalTasks.length,
        cleanupCandidates,
        cleanupCandidateCount: cleanupCandidates.length,
    };
}

// Compact maintenance report: drop the per-row arrays (staleAssignedTasks,
// cleanupCandidates) that scale with old historical record count and instead
// surface the counts. staleAssignedTasks rows are still active work, so keep a
// small sample for coordinator visibility; cleanupCandidates are dominated by
// old historical rows and are dropped entirely in favor of the count + a hint.
function buildCompactQueueMaintenanceReport(maintenance: Record<string, unknown>): Record<string, unknown> {
    const staleAssignedTasks = Array.isArray((maintenance as any).staleAssignedTasks)
        ? (maintenance as any).staleAssignedTasks
        : [];
    const cleanupCandidateCount = (maintenance as any).cleanupCandidateCount ?? 0;
    return {
        readOnly: true,
        mutationPerformed: false,
        sourceOfTruth: 'mesh_work_queue_file',
        payloadMode: 'compact',
        staleAssignedDefinition: (maintenance as any).staleAssignedDefinition,
        historicalDefinition: (maintenance as any).historicalDefinition,
        // staleAssignedTasks are active assigned rows (not historical) — retain a
        // bounded sample so coordinators can still see drift without the full array.
        staleAssignedTasks: staleAssignedTasks.slice(0, 5),
        staleAssignedSampleLimit: 5,
        staleAssignedCount: (maintenance as any).staleAssignedCount ?? staleAssignedTasks.length,
        historicalRecordCount: (maintenance as any).historicalRecordCount ?? 0,
        oldHistoricalRecordCount: (maintenance as any).oldHistoricalRecordCount ?? 0,
        cleanupCandidateCount,
        cleanupCandidatesOmitted: true,
        cleanupCandidatesHint: 'Per-row cleanup candidates are omitted in compact mode; call mesh_view_queue with verbose=true for the full maintenance/cleanupDryRun rows.',
    };
}

// Compact-mode bounds for mesh_view_queue active rows. Active (pending/assigned)
// rows are kept — they drive dispatch decisions — but a busy mesh can have dozens
// of them, each carrying the full task `message` (often multi-KB). Truncate the
// message and cap the row count so the active queue can't blow the token cap.
const COMPACT_MAX_ACTIVE_QUEUE_ROWS = 15;
const COMPACT_QUEUE_MESSAGE_CAP = 140;
const COMPACT_MAX_ACTIVE_WORK_ROWS = 12;
// In compact mode an activeWork row keeps a single short title only; the original
// delegation prompt is NOT echoed (leak #2). 80 chars is enough to recognize the task.
const COMPACT_ACTIVE_WORK_TITLE_CAP = 80;

function truncateForCompact(value: unknown, cap: number): unknown {
    if (typeof value !== 'string') return value;
    return value.length > cap ? value.slice(0, cap) + '…' : value;
}

// Slim an active queue row for compact mode: truncate the long free-text message
// and elide any oversized nested field. Status/ids/deps/tags (the dispatch-relevant
// scalars) are preserved.
function compactQueueRow(task: any): any {
    if (!task || typeof task !== 'object') return task;
    const slim: any = {};
    for (const [k, v] of Object.entries(task)) {
        if (k === 'message') slim[k] = truncateForCompact(v, COMPACT_QUEUE_MESSAGE_CAP);
        else slim[k] = elideLargeNestedValue(k, v);
    }
    return slim;
}

function compactQueueRows(rows: any[]): { rows: any[]; omitted: number } {
    const capped = rows.slice(0, COMPACT_MAX_ACTIVE_QUEUE_ROWS).map(compactQueueRow);
    return { rows: capped, omitted: Math.max(0, rows.length - capped.length) };
}

// Slim an activeWork record for compact mode. Leak #2: the original delegation
// prompt was echoed THREE times per row — `taskTitle` (truncated) + `taskSummary`
// (mid-length) + `message` (full). In compact we keep only a single short
// `taskTitle`; `taskSummary` and `message` are dropped entirely (the full text is
// available via mesh_task_history or with verbose=true). All dispatch-relevant
// scalars (taskId/status/nodeId/sessionId/timestamps/terminal+stale flags) are
// preserved so the row stays actionable.
function compactActiveWorkRecord(record: any): any {
    if (!record || typeof record !== 'object') return record;
    const slim: any = {};
    for (const [k, v] of Object.entries(record)) {
        if (k === 'message' || k === 'taskSummary') continue; // redundant full-text echoes
        else if (k === 'taskTitle') slim[k] = truncateForCompact(v, COMPACT_ACTIVE_WORK_TITLE_CAP);
        else slim[k] = elideLargeNestedValue(k, v);
    }
    return slim;
}

function compactActiveWorkRecords(records: any[]): { records: any[]; omitted: number } {
    if (!Array.isArray(records)) return { records, omitted: 0 };
    const capped = records.slice(0, COMPACT_MAX_ACTIVE_WORK_ROWS).map(compactActiveWorkRecord);
    return { records: capped, omitted: Math.max(0, records.length - capped.length) };
}

function annotateQueueStaleness(queue: any[], mesh?: LocalMeshEntry): any[] {
    const liveness = buildQueueLivenessIndex(mesh);
    const now = Date.now();
    return queue.map(task => {
        const taskStatus = typeof task?.status === 'string' ? task.status : undefined;
        const annotated = {
            ...task,
            taskStatus,
            isActive: taskStatus ? ACTIVE_QUEUE_STATUSES.has(taskStatus) : false,
            isHistorical: taskStatus ? HISTORICAL_QUEUE_STATUSES.has(taskStatus) : false,
            dispatchedAt: task?.createdAt,
            ...(taskStatus === 'assigned' ? { activeTaskId: task.id } : {}),
            ...(taskStatus === 'completed' || taskStatus === 'failed' ? {
                completedAt: task.updatedAt,
            } : {}),
        };
        if (taskStatus !== 'assigned') return annotated;
        const updatedAt = new Date(task.updatedAt).getTime();
        const ageMs = Number.isFinite(updatedAt) ? now - updatedAt : null;
        const staleReason = queueAssignmentStaleReason(task, liveness);
        if (!staleReason) return annotated;
        return {
            ...annotated,
            stale: true,
            staleAssigned: true,
            staleReason,
            ...(ageMs !== null ? { assignedAgeMs: ageMs } : {}),
        };
    });
}

function unwrapCommandPayload(value: any): any {
    let current = value;
    const seen = new Set<any>();
    for (let depth = 0; depth < 8; depth += 1) {
        if (!current || typeof current !== 'object' || seen.has(current)) break;
        seen.add(current);

        const nested = current.result ?? current.payload;
        if (!nested || typeof nested !== 'object') break;
        current = nested;
    }
    return current;
}

function isDirectDispatchLedgerEntry(entry: any): boolean {
    if (entry?.kind !== 'task_dispatched') return false;
    const payload = entry.payload || {};
    const via = readString(payload.via);
    return payload.source === 'direct' || via === 'p2p_direct' || via === 'local_direct' || via === 'mesh_send_task';
}

function readMessageTimestampIso(message: any): string | undefined {
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

function readFinalAssistantTranscriptEvidence(payload: any): { finalSummary?: string; transcriptMessageAt?: string } {
    const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    const finalAssistant = [...rawMessages]
        .reverse()
        .filter(isCoordinatorVisibleMessage)
        .find((message: any) => {
            const role = String(message?.role ?? '').toLowerCase();
            return (role === 'assistant' || role === 'agent') && messageContent(message).trim();
        });
    const finalSummary = messageContent(finalAssistant).trim()
        || (typeof payload?.summary === 'string' && payload.summary.trim() ? payload.summary.trim() : undefined);
    return {
        finalSummary,
        transcriptMessageAt: finalAssistant ? readMessageTimestampIso(finalAssistant) : undefined,
    };
}

function findNodeSession(nodes: any[], nodeId?: string | null, sessionId?: string | null): { node?: any; session?: any } {
    if (!nodeId || !sessionId) return {};
    const node = nodes.find((candidate: any) => readString(candidate?.id) === nodeId || readString(candidate?.nodeId) === nodeId);
    if (!node) return {};
    const sessions = Array.isArray(node.sessions) ? node.sessions : [];
    const session = sessions.find((candidate: any) => readSessionRecordId(candidate) === sessionId);
    return { node, session };
}

function buildDirectDispatchReconciliationCandidates(directDispatches: any[], ledgerEntries: any[]): any[] {
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

async function reconcileDirectDispatchesFromTranscriptEvidence(
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

function buildQueueTriggerGuidance(queueTrigger: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!queueTrigger || queueTrigger.claimed === true) return undefined;
    if (queueTrigger.success === false) {
        return {
            queueClaimed: false,
            queueDispatchState: 'trigger_failed',
            nextAction: 'Do not assume the queued task is running. Check mesh_view_queue and daemon connectivity before redispatching.',
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

function isTerminalSessionRecord(session: any): boolean {
    const status = typeof session?.status === 'string' ? session.status.toLowerCase() : '';
    const lifecycle = typeof session?.lifecycle === 'string' ? session.lifecycle.toLowerCase() : '';
    const state = typeof session?.state === 'string' ? session.state.toLowerCase() : '';
    return [status, lifecycle, state].some(value => ['stopped', 'failed', 'terminated', 'exited', 'closed'].includes(value));
}

function isIdleSessionRecord(session: any): boolean {
    if (isTerminalSessionRecord(session)) return false;
    const status = typeof session?.status === 'string' ? session.status.toLowerCase() : '';
    const chatStatus = typeof session?.activeChat?.status === 'string' ? session.activeChat.status.toLowerCase() : '';
    return status === 'idle' || chatStatus === 'waiting_input';
}

function isMeshOwnedDelegateSession(session: any, meshId: string, nodeId: string): boolean {
    const settings = session?.settings;
    const sessionMeshId = typeof settings?.meshNodeFor === 'string' ? settings.meshNodeFor.trim() : '';
    const sessionNodeId = typeof settings?.meshNodeId === 'string' ? settings.meshNodeId.trim() : '';
    // meshNodeFor is the primary ownership signal. Relay safety is checked separately
    // for remote dispatch because older local delegates may not carry coordinator
    // daemon metadata.
    if (sessionMeshId !== meshId) return false;
    return !sessionNodeId || sessionNodeId === nodeId;
}

function hasRemoteRelayMetadata(session: any): boolean {
    return Boolean(
        readString(session?.settings?.meshCoordinatorDaemonId)
        || readString(session?.meta?.meshCoordinatorDaemonId)
        || readString(session?.metadata?.meshCoordinatorDaemonId)
        || readString(session?.meshCoordinatorDaemonId),
    );
}

function isRelaySafeRemoteDelegateSession(session: any, meshId: string, nodeId: string): boolean {
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
function classifyRemoteDelegateRelaySafety(
    session: any,
    meshId: string,
    nodeId: string,
    coordinatorDaemonId: string,
): 'safe' | 'self_heal' | 'missing_anchor' | 'unsafe_alias' {
    if (!isMeshOwnedDelegateSession(session, meshId, nodeId)) return 'unsafe_alias';
    if (hasRemoteRelayMetadata(session)) return 'safe';
    return coordinatorDaemonId ? 'self_heal' : 'missing_anchor';
}

function chooseDispatchableSession(sessions: any[], providerType: string, meshId: string, nodeId: string, coordinatorDaemonId: string): any | undefined {
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
    return meshSessions.find(session => isIdleSessionRecord(session) && matchingProvider(session))
        || meshSessions.find(matchingProvider)
        || undefined;
}

function buildRelayUnsafeRemoteSessionFailure(ctx: MeshContext, node: LocalMeshNodeEntry, sessionId: string, providerType?: string): ({ success: false; error: string } & Record<string, unknown>) {
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

function buildMissingCoordinatorDaemonIdFailure(ctx: MeshContext, node: LocalMeshNodeEntry, providerType?: string): ({ success: false; error: string } & Record<string, unknown>) {
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

function findNestedPayload(value: any, predicate: (payload: any) => boolean): any {
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

function extractCloneNodePayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.node?.id));
}

function extractGitStatus(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.status ?? value?.status ?? payload;
}

function extractGitDiff(value: any): any {
    const payload = unwrapCommandPayload(value);
    return payload?.diffSummary ?? payload?.diff ?? value?.diffSummary ?? value?.diff ?? payload;
}

function extractSubmodules(value: any, ignorePaths: string[]): any[] | undefined {
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

function assignFullGitSnapshot(entry: Record<string, unknown>, status: any): void {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return;
    entry.git = status;
}

// Compact-mode git snapshot for LLM callers: keep the coordinator-relevant scalar
// signals (branch/upstream/ahead/behind/dirty/headCommit) and the submodules array
// (its out-of-sync state drives convergence decisions) while dropping the large
// duplicated blobs (full changed-file lists, diffs, raw porcelain) that the full
// dashboard payload carries. The full status object remains available via verbose.
function buildCompactGitSnapshot(status: any): Record<string, unknown> | undefined {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined;
    const slim: Record<string, unknown> = {};
    const carry = [
        'isGitRepo',
        'branch',
        'headCommit',
        'upstream',
        'upstreamStatus',
        'ahead',
        'behind',
        'dirty',
        'detached',
        'submodules',
    ];
    for (const key of carry) {
        if (status[key] !== undefined) slim[key] = status[key];
    }
    return slim;
}

// Compact-mode submodules fold: the full submodules array (path/commit/status/
// branch per submodule) is repeated on every node that shares a superproject, so
// it grows O(nodes × submodules). In compact mode we keep the actionable signal
// (count + the out-of-sync paths, which drive convergence decisions) and drop the
// per-submodule commit/status blobs. The full array stays in verbose. Out-of-sync
// paths are also surfaced separately on the node as `outOfSyncSubmodules`.
function summarizeCompactSubmodules(submodules: any): Record<string, unknown> | undefined {
    if (!Array.isArray(submodules) || submodules.length === 0) return undefined;
    const outOfSync = submodules.filter((s: any) => s?.outOfSync).map((s: any) => s?.path).filter(Boolean);
    return {
        count: submodules.length,
        ...(outOfSync.length > 0 ? { outOfSyncPaths: outOfSync } : {}),
    };
}

// Compact-mode per-node fold for mesh_status. The dashboard/verbose payload
// (`results`) is untouched; this only slims the LLM-facing node copy. It folds
// the repetitive heavy fields that scale O(nodes):
//   - git: slim scalar snapshot + summarized submodules (no full file lists/blobs)
//   - machine: drop the verbose identityEvidence[] array and the long
//     localityReason string (which interpolates every evidence token) — keep the
//     resolved scalars (displayName/daemonId/machineId/hostname/sameMachine/locality)
//   - staleDaemonBuild: the full ~300-char warning + duplicated build fields are
//     already aggregated ONCE at the top level under staleDaemonBuilds[] +
//     staleDaemonBuildWarning. On the node, collapse to a short boolean-ish flag so
//     the per-node copy isn't N× the same warning text.
//   - branchConvergence: keep the decision fields (status/needsConvergence/reason/
//     branch/ahead/behind); drop the long per-node nextStep prose (it is echoed in
//     nextStepHints and branchConvergenceSummary).
// Any remaining oversized nested blob is elided by the generic byte guard.
function compactMeshStatusNode(entry: any): any {
    if (!entry || typeof entry !== 'object') return entry;
    const next: any = { ...entry };

    if (next.git !== undefined) {
        const slimGit = buildCompactGitSnapshot(next.git);
        if (slimGit) {
            if (slimGit.submodules !== undefined) {
                const subSummary = summarizeCompactSubmodules(slimGit.submodules);
                if (subSummary) slimGit.submodules = subSummary;
                else delete slimGit.submodules;
            }
            next.git = slimGit;
        }
    }

    if (next.machine && typeof next.machine === 'object') {
        const m = next.machine as Record<string, unknown>;
        next.machine = {
            daemonId: m.daemonId,
            machineId: m.machineId,
            hostname: m.hostname,
            displayName: m.displayName,
            sameMachine: m.sameMachine,
            locality: m.locality,
        };
    }

    // submoduleWarning is a fixed ~120-char prose string repeated on every node
    // with an out-of-sync submodule. The actionable signal (which submodules) is
    // already on `outOfSyncSubmodules`; collapse the prose to a boolean flag in
    // compact mode.
    if (typeof next.submoduleWarning === 'string') {
        next.submodulesOutOfSync = true;
        delete next.submoduleWarning;
    }

    if (next.staleDaemonBuild && typeof next.staleDaemonBuild === 'object') {
        const b = next.staleDaemonBuild as Record<string, unknown>;
        // Replace the full per-node object (warning prose + build fields, all of
        // which are aggregated top-level) with a terse flag. The daemonId lets the
        // coordinator cross-reference the top-level staleDaemonBuilds[] entry.
        next.staleDaemonBuild = {
            scope: b.scope,
            isDaemonAffecting: b.isDaemonAffecting !== false,
            seeStaleDaemonBuilds: true,
        };
    }

    // branchConvergence is kept intact for detailed compact nodes (it carries the
    // actionable per-node nextStep). It is small per-node and bounded by the
    // detail byte-budget; the larger repetition lives in branchConvergenceSummary,
    // which is capped separately. Quiet nodes drop nextStep via minimalCompactNode.

    // Generic backstop: elide any other oversized nested blob on the node.
    for (const k of Object.keys(next)) {
        if (k === 'git' || k === 'machine' || k === 'branchConvergence' || k === 'staleDaemonBuild' || k === 'sessions') continue;
        next[k] = elideLargeNestedValue(k, next[k]);
    }

    return next;
}

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
const COMPACT_DETAILED_NODES_BYTE_BUDGET = 9000;
// Total byte budget for the whole compact node array (detail + minimal stubs).
// Nodes that don't fit even as a stub are folded into a counts+id-list summary so
// the array stays bounded on pathologically large meshes; every node id is still
// listed in foldedNodes.nodeIds, so nothing becomes undiscoverable.
const COMPACT_NODES_TOTAL_BYTE_BUDGET = 13000;

// Rough severity ranking so that when the byte budget forces a downgrade, the most
// urgent nodes (errors/degraded/blocked launches) are the ones kept in detail.
function compactNodeSeverity(entry: any): number {
    if (!entry || typeof entry !== 'object') return 0;
    if (entry.error || (entry.health && entry.health !== 'online' && entry.health !== 'dirty')) return 5;
    if (entry.launchReady === false) return 4;
    if (entry.isDirty === true || entry.health === 'dirty') return 3;
    if (entry.branchConvergence?.needsConvergence === true) return 2;
    if (entry.staleDaemonBuild || entry.submodulesOutOfSync || entry.recoveryHints) return 1;
    return 0;
}

function isNoteworthyCompactNode(entry: any): boolean {
    if (!entry || typeof entry !== 'object') return true;
    if (entry.health && entry.health !== 'online') return true;
    if (entry.isDirty === true) return true;
    if (entry.error) return true;
    if (entry.launchReady === false) return true;
    if (entry.staleDaemonBuild) return true;
    if (entry.submoduleWarning || entry.submodulesOutOfSync) return true;
    if (entry.recoveryHints) return true;
    if (Array.isArray(entry.nextStepHints) && entry.nextStepHints.length > 0) return true;
    if (entry.branchConvergence?.needsConvergence === true) return true;
    const sessionCount = Array.isArray(entry.sessions)
        ? entry.sessions.length
        : (entry.sessionSummary?.total ?? 0);
    if (sessionCount > 0) return true;
    return false;
}

// Minimal per-node stub for quiet nodes / byte-budget overflow. Keeps the fields a
// coordinator needs to find and reason about a node (id/workspace/health/branch/
// launchReady) plus the branchConvergence decision scalars, marked `folded` so
// callers know the full compact detail is available via verbose.
function minimalCompactNode(entry: any): any {
    if (!entry || typeof entry !== 'object') return entry;
    const bc = entry.branchConvergence && typeof entry.branchConvergence === 'object'
        ? {
            status: entry.branchConvergence.status,
            needsConvergence: entry.branchConvergence.needsConvergence,
            reason: entry.branchConvergence.reason,
            branch: entry.branchConvergence.branch,
        }
        : undefined;
    return {
        nodeId: entry.nodeId,
        workspace: entry.workspace,
        daemonId: entry.daemonId,
        health: entry.health,
        branch: entry.branch,
        launchReady: entry.launchReady,
        ...(entry.providerPriority !== undefined ? { providerPriority: entry.providerPriority } : {}),
        ...(entry.launchBlockedReason !== undefined ? { launchBlockedReason: entry.launchBlockedReason } : {}),
        ...(bc ? { branchConvergence: bc } : {}),
        ...(entry.sessionSummary ? { sessionSummary: entry.sessionSummary } : {}),
        folded: true,
    };
}

// Fold a node's slim session list into status/provider counts. Compact mode
// returns this instead of the full per-session array so the payload does not
// grow O(nodes × sessions). The self-coordinator marker is preserved as a
// dedicated count + id list so the coordinator never mis-reads its own
// generating CLI session as a foreign delegated task.
function summarizeNodeSessions(sessions: any[]): Record<string, unknown> {
    const list = Array.isArray(sessions) ? sessions : [];
    const byStatus: Record<string, number> = {};
    const providerCounts: Record<string, number> = {};
    const selfCoordinatorSessionIds: string[] = [];
    for (const s of list) {
        const status = typeof s?.status === 'string' && s.status ? s.status : 'unknown';
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        const provider = typeof s?.providerType === 'string' && s.providerType ? s.providerType : 'unknown';
        providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
        if (s?.isSelfCoordinator === true && s.id) selfCoordinatorSessionIds.push(String(s.id));
    }
    const summary: Record<string, unknown> = {
        total: list.length,
        byStatus,
        providerCounts,
    };
    if (selfCoordinatorSessionIds.length > 0) {
        summary.selfCoordinatorSessionIds = selfCoordinatorSessionIds;
    }
    return summary;
}

function extractLaunchPayload(value: any): any {
    return findNestedPayload(value, payload => Boolean(payload?.sessionId || payload?.id || payload?.runtimeSessionId));
}

type MeshLaunchFailureClassification = {
    code: string;
    reason: string;
    transport: string;
    recoverable: boolean;
    retryRecommended: boolean;
    nextAction: string;
    noFallbackReason?: string;
};

function classifyMeshLaunchFailure(error: unknown): MeshLaunchFailureClassification {
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

function buildWorktreeCleanupHint(node: LocalMeshNodeEntry): Record<string, unknown> | undefined {
    if (!node.isLocalWorktree) return undefined;
    return {
        tool: 'mesh_remove_node',
        args: { node_id: node.id, session_cleanup_mode: 'preserve' },
        hint: `If the worktree is no longer needed, remove the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`,
    };
}

function buildRecoverableLaunchFailure(
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

function recordRecoverableLaunchFailure(
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

function getLatestActiveLaunchFailure(meshId: string, nodeId: string): Record<string, unknown> | null {
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

type RemoteAgentDispatchResult =
    | { success: true; dispatched: true; sessionId: string; providerType?: string }
    | ({ success: false; error: string } & Record<string, unknown>);

function buildCoordinatorP2pRelayFailure(
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
async function ipcDispatchToRemoteAgent(
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
        return { success: true, dispatched: true, sessionId: sessionId || resolvedProviderType, providerType: resolvedProviderType };
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

function resolveCoordinatorNode(ctx: MeshContext): LocalMeshNodeEntry | undefined {
    const preferredNodeId = typeof ctx.mesh.coordinator?.preferredNodeId === 'string'
        ? ctx.mesh.coordinator.preferredNodeId.trim()
        : '';
    if (preferredNodeId) {
        const preferred = ctx.mesh.nodes.find(n => n.id === preferredNodeId && typeof n.daemonId === 'string' && n.daemonId.trim());
        if (preferred) return preferred;
    }
    if (ctx.localMachineId) {
        const byMachine = ctx.mesh.nodes.find(n => readNodeMachineId(n) === ctx.localMachineId);
        if (byMachine) return byMachine;
    }
    if (ctx.localDaemonId) {
        return ctx.mesh.nodes.find(n => readNodeDaemonId(n) === ctx.localDaemonId);
    }
    return undefined;
}

/**
 * Resolve the coordinator anchor id stamped into a worker dispatch's meshContext
 * (`coordinatorDaemonId`), which the remote router turns into the worker
 * session's `meshCoordinatorDaemonId` relay anchor (router.ts buildMeshWorkerRelayStamp).
 * Without a non-empty value the forwarder gate treats the worker as relay-unsafe
 * and the completion event sits in the pending queue until a later read_chat
 * forces a reconcile.
 *
 * Order: the coordinator mesh node's daemonId → the IPC daemon instanceId
 * (ctx.localDaemonId) → the local machine registry id (ctx.localMachineId). The
 * final fallback mirrors the queue-assignment dispatch path, which stamps
 * `loadConfig().machineId` (== ctx.localMachineId; see server.ts) — so the
 * direct-dispatch path now resolves an anchor whenever the queue path would.
 */
export function resolveCoordinatorDaemonId(ctx: MeshContext): string | undefined {
    return readString(resolveCoordinatorNode(ctx)?.daemonId)
        || readString(ctx.localDaemonId)
        || readString(ctx.localMachineId);
}

function readNodeMachineId(node: LocalMeshNodeEntry): string | undefined {
    return readString((node as any).machineId)
        || readString((node as any).machine_id)
        || readString((node as any).machine?.id)
        || readString((node as any).machine?.machineId)
        || readString((node as any).lastProbe?.machineId)
        || readString((node as any).last_probe?.machine_id)
        || readString((node as any).lastProbe?.machine?.id)
        || readString((node as any).lastProbe?.machine?.machineId)
        || readString((node as any).last_probe?.machine?.id)
        || readString((node as any).last_probe?.machine?.machine_id);
}

function readNodeDaemonId(node: LocalMeshNodeEntry): string | undefined {
    return readString(node.daemonId)
        || readString((node as any).daemon_id)
        || readString((node as any).machine?.daemonId)
        || readString((node as any).machine?.daemon_id)
        || readString((node as any).lastProbe?.daemonId)
        || readString((node as any).last_probe?.daemon_id)
        || readString((node as any).lastProbe?.machine?.daemonId)
        || readString((node as any).lastProbe?.machine?.daemon_id)
        || readString((node as any).last_probe?.machine?.daemonId)
        || readString((node as any).last_probe?.machine?.daemon_id);
}

function normalizeHostname(value: unknown): string | undefined {
    const hostname = readString(value);
    if (!hostname) return undefined;
    return hostname.toLowerCase().replace(/\.$/, '');
}

function readNodeHostname(node: LocalMeshNodeEntry): string | undefined {
    return readString((node as any).hostname)
        || readString((node as any).host)
        || readString((node as any).machineHostname)
        || readString((node as any).machine_hostname)
        || readString((node as any).machine?.hostname)
        || readString((node as any).machine?.host)
        || readString((node as any).lastProbe?.hostname)
        || readString((node as any).last_probe?.hostname)
        || readString((node as any).lastProbe?.machine?.hostname)
        || readString((node as any).last_probe?.machine?.hostname);
}

function readNodeDisplayMachineName(node: LocalMeshNodeEntry): string | undefined {
    return readString((node as any).machineName)
        || readString((node as any).machine_name)
        || readString((node as any).machineLabel)
        || readString((node as any).machine_label)
        || readString((node as any).machineNickname)
        || readString((node as any).machine_nickname)
        || readString((node as any).alias)
        || readString((node as any).machine?.name)
        || readString((node as any).machine?.displayName)
        || readString((node as any).machine?.display_name)
        || readString((node as any).lastProbe?.machineName)
        || readString((node as any).last_probe?.machine_name)
        || readString((node as any).lastProbe?.machine?.name)
        || readString((node as any).last_probe?.machine?.name)
        || readNodeHostname(node);
}

function compactIdentityEvidence(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function pushIdentityEvidence(evidence: string[], label: string, value: string | undefined): void {
    const compact = compactIdentityEvidence(value);
    if (compact) evidence.push(`${label}:${compact}`);
}

function buildNodeMachineIdentity(ctx: MeshContext, node: LocalMeshNodeEntry): Record<string, unknown> {
    const machineId = readNodeMachineId(node);
    const daemonId = readNodeDaemonId(node);
    const hostname = readNodeHostname(node);
    const machineName = readNodeDisplayMachineName(node);
    const coordinatorHostname = readString(ctx.coordinatorHostname);
    const localControlPlaneReason = getLocalControlPlaneMatchReason(ctx, node);
    const directLocal = !!localControlPlaneReason;
    const hostnameMatches = Boolean(
        normalizeHostname(hostname)
        && normalizeHostname(coordinatorHostname)
        && normalizeHostname(hostname) === normalizeHostname(coordinatorHostname),
    );
    const sameMachine = directLocal || hostnameMatches;
    const evidence: string[] = [];
    pushIdentityEvidence(evidence, 'machineName', machineName);
    pushIdentityEvidence(evidence, 'hostname', hostname);
    pushIdentityEvidence(evidence, 'machineId', machineId);
    pushIdentityEvidence(evidence, 'daemonId', daemonId);
    if (localControlPlaneReason) {
        pushIdentityEvidence(evidence, 'localMatch', localControlPlaneReason);
        pushIdentityEvidence(evidence, 'localMachineId', ctx.localMachineId);
        pushIdentityEvidence(evidence, 'localDaemonId', ctx.localDaemonId);
    }
    const locality = sameMachine ? 'same_machine' : (evidence.length > 0 ? 'remote_known' : 'remote_or_unknown');
    const localityReason = sameMachine
        ? (localControlPlaneReason || 'matched coordinator hostname')
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

function nodeHasLocalDaemonEvidence(ctx: MeshContext, node: any): boolean {
    const isLocal = (session: any) => {
        if (!session || typeof session !== 'object') return false;
        // meshCoordinatorDaemonId identifies where a worker should relay completion events.
        // Remote workers also point this at the local coordinator, so it is not locality evidence.
        // Likewise launchedByCoordinator only proves the coordinator created the session, not
        // that the session is running on this daemon.
        if (ctx.localDaemonId && session.runtime?.owner === ctx.localDaemonId) return true;
        if (ctx.localDaemonId && session.daemonClient?.daemonId === ctx.localDaemonId) return true;
        return false;
    };

    const sessionArrays = [
        node?.sessions,
        node?.activeSessions,
        node?.active_sessions,
        node?.lastProbe?.sessions,
        node?.last_probe?.sessions,
        node?.lastProbe?.status?.sessions,
        node?.last_probe?.status?.sessions,
    ];
    for (const arr of sessionArrays) {
        if (Array.isArray(arr) && arr.some(isLocal)) return true;
    }

    const sessionRecords = [
        node?.activeSession,
        node?.active_session,
        node?.currentSession,
        node?.current_session,
        node?.runtimeSession,
        node?.runtime_session,
        node?.session,
        node?.lastProbe?.activeSession,
        node?.last_probe?.active_session,
        node?.lastProbe?.currentSession,
        node?.last_probe?.current_session,
        node?.lastProbe?.session,
        node?.last_probe?.session,
    ];
    for (const session of sessionRecords) {
        if (isLocal(session)) return true;
    }
    
    return false;
}

function isDirectLocalNode(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    const machineId = readNodeMachineId(node);
    const daemonId = readNodeDaemonId(node);
    return Boolean(
        (ctx.localMachineId && machineId === ctx.localMachineId)
        || (ctx.localDaemonId && daemonId === ctx.localDaemonId)
        || nodeHasLocalDaemonEvidence(ctx, node)
    );
}

function isConfiguredCoordinatorNode(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    if (!ctx.localMachineId && !ctx.localDaemonId) return false;
    const nodeId = readString(node.id) || readString((node as any).nodeId) || readString((node as any).node_id);
    if (!nodeId) return false;
    // If the node carries explicit daemon/machine identity that doesn't match the
    // coordinator, it is definitively a remote node — skip the positional fallback.
    const nodeDaemonId = readNodeDaemonId(node);
    const nodeMachineId = readNodeMachineId(node);
    if (nodeDaemonId && ctx.localDaemonId && nodeDaemonId !== ctx.localDaemonId) return false;
    if (nodeMachineId && ctx.localMachineId && nodeMachineId !== ctx.localMachineId) return false;
    const preferredNodeId = readString(ctx.mesh.coordinator?.preferredNodeId)
        || readString((ctx.mesh.coordinator as any)?.preferred_node_id);
    if (preferredNodeId) return nodeId === preferredNodeId;
    const first = ctx.mesh.nodes?.[0] as any;
    const firstNodeId = readString(first?.id) || readString(first?.nodeId) || readString(first?.node_id);
    return !!firstNodeId && nodeId === firstNodeId;
}

function getLocalControlPlaneMatchReason(ctx: MeshContext, node: LocalMeshNodeEntry): string | undefined {
    if (isDirectLocalNode(ctx, node)) return 'matched coordinator daemon or machine id';
    if (isConfiguredCoordinatorNode(ctx, node)) return 'matched configured coordinator node';
    if (node.isLocalWorktree === true) {
        const sourceNode = findClonedFromNode(ctx, node);
        if (sourceNode && isDirectLocalNode(ctx, sourceNode)) return 'matched local cloned-from node';
        if (sourceNode && isConfiguredCoordinatorNode(ctx, sourceNode)) return 'matched configured coordinator source node';
    }
    return undefined;
}

function findClonedFromNode(ctx: MeshContext, node: LocalMeshNodeEntry): LocalMeshNodeEntry | undefined {
    const clonedFromNodeId = readString(node.clonedFromNodeId) || readString((node as any).cloned_from_node_id);
    if (!clonedFromNodeId) return undefined;
    return ctx.mesh.nodes.find(n => n.id === clonedFromNodeId || (n as any).nodeId === clonedFromNodeId || (n as any).node_id === clonedFromNodeId);
}

/**
 * Resolve the node id a `prefer_worktree` enqueue should target.
 *
 * Worktree clones (mesh_clone_node) are appended to `ctx.mesh.nodes`, so the
 * LAST worktree node in array order is the most recently created one — the one
 * the coordinator most likely just spun up for isolated work. Without an
 * explicit target, an unconstrained queue task is claimed by whichever node
 * polls first (typically the base/main workspace), defeating the isolation
 * intent. Returning a concrete node id lets enqueueTask stamp targetNodeId so
 * the existing node-targeted claim tier routes the task to the worktree.
 *
 * Returns undefined when no worktree node exists (the caller treats this as a
 * no-op and falls back to normal unconstrained queueing).
 */
function resolvePreferredWorktreeNodeId(ctx: MeshContext): string | undefined {
    const worktreeNodes = (ctx.mesh.nodes || []).filter(n => (n as any).isLocalWorktree === true);
    if (worktreeNodes.length === 0) return undefined;
    const chosen = worktreeNodes[worktreeNodes.length - 1] as any;
    return readString(chosen?.id) || readString(chosen?.nodeId) || readString(chosen?.node_id);
}

function isLocalControlPlaneNode(ctx: MeshContext, node: LocalMeshNodeEntry): boolean {
    return !!getLocalControlPlaneMatchReason(ctx, node);
}

function meshSessionCacheKey(nodeId: string, runtimeSessionId: string): string {
    return `${nodeId}:${runtimeSessionId}`;
}

function rememberMeshSessionProviderMetadata(
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

function rememberMeshSessionProviderMetadataFromEvent(event: any): void {
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

function resolveMeshSessionProviderMetadataFromLedger(
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

function resolveMeshSessionProviderMetadata(
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

function countUncommittedChanges(status: any): number {
    if (typeof status?.uncommittedChanges === 'number') return status.uncommittedChanges;
    const keys = ['staged', 'modified', 'untracked', 'deleted', 'renamed'];
    const counted = keys.reduce((sum, key) => sum + (Number.isFinite(Number(status?.[key])) ? Number(status[key]) : 0), 0);
    const conflicts = Array.isArray(status?.conflictFiles) ? status.conflictFiles.length : (status?.hasConflicts ? 1 : 0);
    return counted + conflicts;
}

function isGitStatusDirty(status: any): boolean {
    if (typeof status?.isDirty === 'boolean') return status.isDirty;
    if (typeof status?.dirty === 'boolean') return status.dirty;
    if (Array.isArray(status?.submodules) && status.submodules.some((submodule: any) => submodule?.dirty || submodule?.outOfSync || submodule?.error)) return true;
    return countUncommittedChanges(status) > 0;
}

// Large structured fields that bloat refine/batch ledger entries (each can carry a
// full per-node validation plan + suggested config). In compact mode these are
// summarized rather than dropped — full detail stays available via verbose=true /
// mesh_reconcile_ledger.
const LARGE_LEDGER_FIELD_KEYS = new Set(['plan', 'validationPlan', 'suggestedConfig', 'payload']);
const LARGE_LEDGER_OBJECT_THRESHOLD = 800;
// Any nested object/array in a compact payload whose serialized size exceeds this
// is replaced with an elided placeholder. This is the PRIMARY defense: it covers
// arbitrary evidence keys (validationSummary, result, patchEquivalence,
// submoduleReachability, plus any future key) without a hardcoded allowlist. The
// specific per-key rules below are just tuning on top of this general guard.
const LARGE_LEDGER_NESTED_BYTES_THRESHOLD = 2000;

function summarizeLargeLedgerField(key: string, value: unknown): unknown {
    if (typeof value === 'string') {
        return value.length > 500 ? value.slice(0, 500) + '…' : value;
    }
    if (Array.isArray(value)) {
        const serialized = JSON.stringify(value);
        if (serialized && serialized.length > LARGE_LEDGER_OBJECT_THRESHOLD) {
            return `[${key} summarized: ${value.length} items — use verbose=true or mesh_reconcile_ledger]`;
        }
        return value;
    }
    if (value && typeof value === 'object') {
        const serialized = JSON.stringify(value);
        if (serialized && serialized.length > LARGE_LEDGER_OBJECT_THRESHOLD) {
            return `[${key} summarized: ${Object.keys(value as Record<string, unknown>).length} keys — use verbose=true or mesh_reconcile_ledger]`;
        }
        return value;
    }
    return value;
}

// Generic nested-value guard. Replaces any object/array (or oversized string) whose
// serialized size exceeds LARGE_LEDGER_NESTED_BYTES_THRESHOLD with a compact
// placeholder that records the original key, byte size, and a recovery hint. Small
// scalars and short fields (source, success, async, into, mergedBranch, …) pass
// through untouched.
function elideLargeNestedValue(key: string, value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        // Long bare strings (not one of the explicitly-capped fields) get a hard cap
        // so a single multi-KB string blob can't blow the payload either.
        return value.length > 1000 ? value.slice(0, 1000) + '…' : value;
    }
    if (typeof value !== 'object') return value; // number / boolean
    const serialized = JSON.stringify(value);
    const bytes = serialized ? serialized.length : 0;
    if (bytes <= LARGE_LEDGER_NESTED_BYTES_THRESHOLD) return value;
    return {
        _elided: true,
        _kind: key,
        _bytes: bytes,
        _hint: 'full evidence via mesh_reconcile_ledger',
    };
}

function slimLedgerPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const slim: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
        if (k === 'message' || k === 'taskSummary') {
            slim[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
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

function readRelatedRepos(node: LocalMeshNodeEntry): RepoMeshRelatedRepo[] {
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

function summarizeRelatedRepoStatus(repo: RepoMeshRelatedRepo, status: any): Record<string, unknown> {
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

async function collectRelatedRepoStatuses(ctx: MeshContext, node: LocalMeshNodeEntry): Promise<Array<Record<string, unknown>>> {
    const relatedRepos = readRelatedRepos(node);
    if (!relatedRepos.length) return [];

    const results: Array<Record<string, unknown>> = [];
    for (const repo of relatedRepos) {
        try {
            const statusResult = await commandForNode(ctx, node, 'git_status', { workspace: repo.workspace, refreshUpstream: true });
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

function findNodeByWorkspace(mesh: LocalMeshEntry, workspace: string): LocalMeshNodeEntry {
    const node = mesh.nodes.find(n => n.workspace === workspace);
    if (!node) throw new Error(`Workspace '${workspace}' is not a member of mesh '${mesh.name}'`);
    return node;
}

function readProviderPriority(policy: unknown): string[] {
    const raw = (policy as any)?.providerPriority;
    return Array.isArray(raw)
        ? raw.map((type: unknown) => typeof type === 'string' ? type.trim() : '').filter(Boolean)
        : [];
}

function readSpawnedSessionVisibility(policy: unknown): 'visible' | 'hidden' {
    return (policy as any)?.spawnedSessionVisibility === 'hidden' ? 'hidden' : 'visible';
}

function missingProviderPriorityMessage(nodeId: string): string {
    return `Node '${nodeId}' has no providerPriority policy; pass type explicitly or configure node.policy.providerPriority`;
}

function getNodeLaunchReadiness(node: LocalMeshNodeEntry): Record<string, unknown> {
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

function getWorktreeBootstrapLaunchBlock(node: LocalMeshNodeEntry, meshPolicy?: unknown): Record<string, unknown> | undefined {
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

async function collectLiveStatusSessions(ctx: MeshContext, node: LocalMeshNodeEntry): Promise<any[]> {
    try {
        const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
        return extractStatusMetadataSessions(statusResult);
    } catch {
        return [];
    }
}

/**
 * One get_status_metadata probe → both the live session list and the daemon's
 * build stamp. Used by mesh_status so a single daemon-wide probe yields the
 * sessions AND the `daemonBuild` field (commit/version of the running daemon).
 */
async function collectLiveStatusProbe(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
): Promise<{ sessions: any[]; daemonBuild?: { commit: string; commitShort: string; version: string; builtAt?: string } }> {
    try {
        const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
        return {
            sessions: extractStatusMetadataSessions(statusResult),
            daemonBuild: extractDaemonBuildInfo(statusResult),
        };
    } catch {
        return { sessions: [] };
    }
}

function extractDaemonBuildInfo(value: any): { commit: string; commitShort: string; version: string; builtAt?: string } | undefined {
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

async function collectMeshViewQueueNodesWithLiveSessions(ctx: MeshContext): Promise<any[]> {
    const nodes = await Promise.all(ctx.mesh.nodes.map(async (node) => {
        const liveSessions = await collectLiveStatusSessions(ctx, node);
        return liveSessions.length > 0
            ? { ...node, sessions: liveSessions }
            : node;
    }));
    return nodes;
}

function readNumeric(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function buildBranchConvergence(
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
const COMPACT_MAX_CONVERGENCE_FOLLOWUPS = 12;

function summarizeBranchConvergence(nodes: any[], compact = false): Record<string, unknown> {
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

async function commandForNode(
    ctx: MeshContext,
    node: LocalMeshNodeEntry,
    command: string,
    args: Record<string, unknown> = {},
): Promise<any> {
    const isLocalNode = isLocalControlPlaneNode(ctx, node);

    if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
        return ctx.transport.meshCommand(node.daemonId, command, args);
    }
    return ctx.transport.command(command, args);
}

function normalizePendingMeshCoordinatorEvents(value: any): any[] {
    const payload = unwrapCommandPayload(value);
    const events = Array.isArray(payload?.events)
        ? payload.events
        : Array.isArray(value?.events)
            ? value.events
            : [];
    return events.filter((event: unknown) => event && typeof event === 'object');
}

function buildMeshForwardPayloadFromPendingEvent(event: any): Record<string, unknown> {
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
    };
}

async function drainCoordinatorPendingEvents(
    ctx: MeshContext,
    opts?: { nodeIds?: string[] },
): Promise<any[]> {
    const requestedNodeIds = opts?.nodeIds?.length ? new Set(opts.nodeIds) : null;
    const matchesCurrentMesh = (event: any) => readString(event?.meshId) === ctx.mesh.id;

    if (ctx.transport instanceof IpcTransport) {
        const surfacedEvents: any[] = [];
        const coordinatorDaemonId = readString(ctx.localDaemonId);
        const pendingEventArgs = {
            meshId: ctx.mesh.id,
            ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
        };

        try {
            const localEvents = normalizePendingMeshCoordinatorEvents(await ctx.transport.command('get_pending_mesh_events', pendingEventArgs) as any)
                .filter(matchesCurrentMesh);
            for (const event of localEvents) {
                const payload = buildMeshForwardPayloadFromPendingEvent(event);
                if (!payload.event || !payload.meshId) continue;
                let injected = false;
                try {
                    await ctx.transport.command('mesh_forward_event', payload);
                    injected = true;
                } catch { /* best-effort */ }
                rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
                if (!injected) surfacedEvents.push(event);
            }
        } catch {
            // Non-fatal: pending events are best-effort.
        }

        for (const node of ctx.mesh.nodes) {
            if (!node.daemonId || isLocalControlPlaneNode(ctx, node)) continue;
            if (requestedNodeIds && !requestedNodeIds.has(node.id)) continue;

            try {
                const remoteEvents = normalizePendingMeshCoordinatorEvents(
                    await ctx.transport.meshCommand(node.daemonId, 'get_pending_mesh_events', pendingEventArgs),
                ).filter(matchesCurrentMesh);
                if (remoteEvents.length === 0) continue;

                for (const event of remoteEvents) {
                    const payload = buildMeshForwardPayloadFromPendingEvent(event);
                    if (!payload.event || !payload.meshId) continue;
                    await ctx.transport.command('mesh_forward_event', payload);
                    rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
                }
            } catch {
                // Non-fatal: remote pending-event recovery is best-effort.
            }
        }

        try {
            const localEvents = normalizePendingMeshCoordinatorEvents(await ctx.transport.command('get_pending_mesh_events', pendingEventArgs) as any)
                .filter(matchesCurrentMesh);
            for (const event of localEvents) {
                const payload = buildMeshForwardPayloadFromPendingEvent(event);
                if (!payload.event || !payload.meshId) continue;
                let injected = false;
                try {
                    await ctx.transport.command('mesh_forward_event', payload);
                    injected = true;
                } catch { /* best-effort */ }
                rememberMeshSessionProviderMetadataFromEvent({ ...event, metadataEvent: payload });
                if (!injected) surfacedEvents.push(event);
            }
        } catch {
            // Non-fatal: pending events are best-effort.
        }

        return surfacedEvents;
    }

    // (B3) Pass localDaemonId so unicast events targeted at other
    // coordinators are skipped (and requeued) instead of being silently
    // consumed by this MCP. drainPendingMeshCoordinatorEvents already
    // accepts the second arg in the base; we were the missing wiring.
    const events = (drainPendingMeshCoordinatorEvents(ctx.mesh.id, ctx.localDaemonId) as any[]).filter(matchesCurrentMesh);
    events.forEach(rememberMeshSessionProviderMetadataFromEvent);
    return events;
}

function isP2pTransportUnavailableError(error: unknown): boolean {
    return isP2pRelayTransportFailure(error);
}

function buildRemoveNodeArgs(ctx: MeshContext, nodeId: string, sessionCleanupMode?: string, force?: boolean): Record<string, unknown> {
    return {
        meshId: ctx.mesh.id,
        nodeId,
        ...(sessionCleanupMode ? { sessionCleanupMode } : {}),
        ...(force === true ? { force: true } : {}),
        inlineMesh: ctx.mesh,
    };
}

// ─── Tool Definitions ───────────────────────────

export const MESH_STATUS_TOOL = {
    name: 'mesh_status',
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions, recovery hints, and recommended next steps. Use this to decide which node to send work to or how to recover from failures. Also reports the running daemon build per daemonId under top-level daemonBuilds ({commit, commitShort, version}); when a live daemon was built from a commit BEHIND its workspace HEAD it adds staleDaemonBuilds[] + staleDaemonBuildWarning — meaning a just-merged refinery/mesh-tool fix is NOT yet live on that daemon (awaiting deploy/restart; a local dist rebuild does not update a cloud daemon). Do not repeatedly call this to wait for generating delegated work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
            includeStaleDirectWorkDetails: { type: 'boolean', description: 'Opt in to the full staleDirectWork array. Defaults false; normal status returns compact staleDirectWorkSummary only.' },
            includeSessions: { type: 'boolean', description: 'Opt in to per-node live session arrays. Default false: compact mode returns a per-node sessionSummary (counts) and de-duplicated full session lists under top-level daemonSessions keyed by daemonId (sessions are not repeated for every node that shares a daemon). Set true to also include the full session array on each node.' },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Folds per-node session arrays to sessionSummary and de-duplicates daemon-shared sessions into daemonSessions. Set false (or verbose=true) for the full dashboard-grade payload.' },
            verbose: { type: 'boolean', description: 'Force the full payload; overrides compact.' },
        },
    },
};

export const MESH_LIST_NODES_TOOL = {
    name: 'mesh_list_nodes',
    description: 'List all nodes in the mesh with their capabilities, platform, and workspace paths.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
        },
    },
};

export const MESH_ENQUEUE_TASK_TOOL = {
    name: 'mesh_enqueue_task',
    description: 'Add a new task to the mesh work queue. Idle nodes will automatically pull and execute tasks from this queue. Use this instead of mesh_send_task when you do not need to target a specific node.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            message: { type: 'string', description: 'The task instruction for the agent.' },
            task_mode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before dispatch.' },
            taskMode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'CamelCase alias for task_mode.' },
            requiredTags: { type: 'array', items: { type: 'string' }, description: 'Optional capability tags that every eligible node must have, e.g. os=darwin, provider=codex-cli, gpu.' },
            required_tags: { type: 'array', items: { type: 'string' }, description: 'Snake_case alias for requiredTags.' },
            target_node_id: { type: 'string', description: 'Optional: only this node may claim the task. Use to route a queued task to a specific (e.g. freshly cloned) worktree node instead of letting the first idle base node claim it. Takes priority over prefer_worktree.' },
            targetNodeId: { type: 'string', description: 'CamelCase alias for target_node_id.' },
            prefer_worktree: { type: 'boolean', description: 'Optional: when true, route this task to the most recently cloned idle worktree node (avoids the main/base workspace preemptively claiming an isolated task). No-op if no worktree node exists; resolves to a target_node_id when one does.' },
            preferWorktree: { type: 'boolean', description: 'CamelCase alias for prefer_worktree.' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete before this task becomes claimable. Cycles are rejected at enqueue.' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'CamelCase alias for depends_on.' },
            mission_id: { type: 'string', description: 'Mission this task belongs to (mesh_mission record id).' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
        },
        required: ['message'],
    },
};

export const MESH_VIEW_QUEUE_TOOL = {
    name: 'mesh_view_queue',
    description: 'View the mesh work queue with source-of-truth active counts separated from historical completed/failed/cancelled records. Do not repeatedly call this to wait for generating assigned work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            status: {
                type: 'array',
                items: { type: 'string' },
                description: 'Explicit row filter by task status: pending, assigned, completed, failed, cancelled. Source-of-truth counts remain unfiltered; visible* counts describe returned rows.',
            },
            view: {
                type: 'string',
                enum: ['all', 'active', 'historical'],
                description: 'Optional row view. active returns pending/assigned rows, historical returns completed/failed/cancelled rows, all returns every persisted queue row. Defaults to all for compatibility.',
            },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Drops large historical (completed/failed/cancelled) queue row arrays, the full staleDirectWork orphan array (kept as staleDirectWorkSummary counts), and per-row maintenance cleanupCandidates in favor of counts; pending/assigned active rows are retained. Set false (or verbose=true) for the full dashboard-grade payload.' },
            verbose: { type: 'boolean', description: 'Force the full payload; overrides compact.' },
        },
    },
};

export const MESH_QUEUE_CANCEL_TOOL = {
    name: 'mesh_queue_cancel',
    description: 'Cancel a pending/assigned/completed/failed mesh queue task without deleting audit history. Use this to retire stale queue items that target dead sessions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'Queue task ID to cancel.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for cancellation.' },
        },
        required: ['task_id'],
    },
};

export const MESH_QUEUE_REQUEUE_TOOL = {
    name: 'mesh_queue_requeue',
    description: 'Return a mesh queue task to pending for retry. By default clears stale assigned owner and target session so another live session can claim it. When the task has exceeded its retry cap it is auto-failed instead; use force=true to override.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'Queue task ID to requeue.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for requeueing.' },
            target_node_id: { type: 'string', description: 'Optional replacement target node ID.' },
            target_session_id: { type: 'string', description: 'Optional replacement target runtime session ID.' },
            clear_target_node: { type: 'boolean', description: 'When true, remove any existing target node constraint.' },
            keep_target_session: { type: 'boolean', description: 'When true, preserve an existing target session if target_session_id is not provided. Defaults false to avoid stale session targets.' },
            force: { type: 'boolean', description: 'When true, bypass the retry cap and requeue even if maxRetries has been exceeded. Use only for explicit operator recovery.' },
        },
        required: ['task_id'],
    },
};

export const MESH_SEND_TASK_TOOL = {
    name: 'mesh_send_task',
    description: 'Legacy push-based task assignment. Enqueues a task specifically targeted at a given node. The node will pull it immediately if idle.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from mesh_list_nodes).' },
            session_id: { type: 'string', description: 'Agent session ID on the target node.' },
            message: { type: 'string', description: 'Natural-language task to send to the agent.' },
            task_mode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'Optional task-mode contract. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before local or remote direct dispatch.' },
            taskMode: { type: 'string', enum: ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'], description: 'CamelCase alias for task_mode.' },
            mission_id: { type: 'string', description: 'Mission this task belongs to (mesh_mission record id). When set, the directly dispatched task is attributed to the mission task aggregates exactly like mesh_enqueue_task, including terminal completion. Omit for an unattributed direct dispatch.' },
            missionId: { type: 'string', description: 'CamelCase alias for mission_id.' },
        },
        required: ['node_id', 'session_id', 'message'],
    },
};

export const MESH_READ_CHAT_TOOL = {
    name: 'mesh_read_chat',
    description: 'Read recent chat messages from a delegated agent session on a mesh node. Use compact=true for coordinator context-efficient review: it filters tool/internal/debug chatter and returns the final user-visible summary plus recent key messages. If the runtime session has completed, provider_session_id can explicitly target provider transcript history.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to read from.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed sessions.' },
            tail: { type: 'number', description: 'Number of recent messages to return (default: 10).' },
            compact: { type: 'boolean', description: 'When true, return a compact coordinator summary instead of the full transcript: tool/internal/control/debug messages are excluded and only recent user-visible key messages plus the final assistant summary are included.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_READ_DEBUG_TOOL = {
    name: 'mesh_read_debug',
    description: 'Collect a daemon-side chat/parser debug bundle for a delegated agent session on a mesh node without opening the browser UI. Defaults to daemon_file delivery and returns a saved bundle locator.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to debug.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed session history.' },
            tail: { type: 'number', description: 'Number of recent read_chat messages to embed (default: 40).' },
            delivery: { type: 'string', enum: ['daemon_file', 'inline'], description: 'daemon_file saves the full sanitized bundle on the daemon; inline returns it directly. Default: daemon_file.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_LAUNCH_SESSION_TOOL = {
    name: 'mesh_launch_session',
    description: 'Launch a new agent session on a mesh node. Returns the session ID for subsequent send_task/read_chat calls. If the user names a provider, preserve it exactly: Hermes = hermes-cli, Claude Code/Claude = claude-cli, Codex = codex-cli, Gemini = gemini-cli. If type is omitted, resolve strictly from the node policy providerPriority and provider detection; fail closed when no configured provider is usable. Do not default to claude-cli.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            type: { type: 'string', description: 'Optional provider type to launch. Use hermes-cli for Hermes, claude-cli for Claude Code, codex-cli for Codex, gemini-cli for Gemini. When omitted, node.policy.providerPriority is probed in order.' },
        },
        required: ['node_id'],
    },
};

export const MESH_GIT_STATUS_TOOL = {
    name: 'mesh_git_status',
    description: 'Get git status for a mesh node workspace — branch, dirty state, changed files.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
        },
        required: ['node_id'],
    },
};

export const MESH_READ_NODE_LOGS_TOOL = {
    name: 'mesh_read_node_logs',
    description: 'Fetch a recent daemon LOG tail directly from a (possibly remote) mesh node over P2P — no session launch, no PowerShell/shell grep on the remote machine. '
        + 'Use this to debug a node\'s daemon: read its error/warn lines, grep for a pattern, or read since a timestamp. '
        + 'The reply is byte-bounded (≤128KB, default 64KB; truncated:true when the file was larger, newest lines kept) and secrets (API keys, machine secrets, bearer tokens, JWTs, TURN credentials) are redacted before transmission. '
        + 'This reads the DAEMON log, not an agent session transcript — for a session transcript use mesh_read_chat / mesh_read_debug.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (the daemon owning it serves its own log).' },
            grep: { type: 'string', description: 'Optional regex (case-insensitive) — only matching log lines are returned. Invalid regex falls back to a literal substring match.' },
            since_ms: { type: 'number', description: 'Optional epoch-ms floor — only log lines at/after this time are returned (lines without a parseable timestamp are kept).' },
            tail_bytes: { type: 'number', description: 'Max bytes of log tail to read (default 65536, capped at 131072). Larger files are truncated to the newest tail_bytes.' },
            date: { type: 'string', description: 'Optional YYYY-MM-DD log date (defaults to today). Falls back to the size-rotation backup when the active file is absent.' },
        },
        required: ['node_id'],
    },
};

export const MESH_FAST_FORWARD_NODE_TOOL = {
    name: 'mesh_fast_forward_node',
    description: 'Safely dry-run or execute an obvious direct fast-forward for a mesh node without launching an agent session. '
        + 'mode="merge" (default) absorbs upstream commits into the local branch via git merge --ff-only (ahead=0, behind>0). '
        + 'mode="push" publishes local commits to origin via a strict ff-only push (HEAD must be a descendant of origin/<branch>). '
        + 'Defaults to dry-run; execution requires execute=true. Never force-pushes, rebases, resets, cleans, or checks out arbitrary revisions. '
        + 'When the merge path finds the branch ahead with nothing to merge, it returns code "ahead_needs_push" pointing at mode="push".',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            mode: { type: 'string', enum: ['merge', 'push'], description: 'merge (default): git merge --ff-only to absorb upstream. push: strict ff-only push of local commits to origin/<branch>; refuses any non-fast-forward.' },
            branch: { type: 'string', description: 'Optional guard: require the node\'s current branch to match this branch before planning/executing.' },
            execute: { type: 'boolean', description: 'When true, apply the fast-forward/push if all safety gates pass. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview only. Defaults true unless execute=true; dry_run=true overrides execute.' },
            update_submodules: { type: 'boolean', description: 'mode="merge" only: when true, if the root fast-forward changes gitlinks, run only git submodule update --init --recursive and verify submodules clean.' },
            push_submodules: { type: 'boolean', description: 'mode="push" only: also ff-only push submodule HEADs to their origin main. Gated by mesh policy allowAutoPublishSubmoduleMainCommits — skipped unless that policy is enabled. Defaults false (root push only).' },
        },
        required: ['node_id'],
    },
};

export const MESH_CHECKPOINT_TOOL = {
    name: 'mesh_checkpoint',
    description: 'Create a git checkpoint (commit) on a mesh node workspace.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            message: { type: 'string', description: 'Checkpoint commit message.' },
        },
        required: ['node_id', 'message'],
    },
};

export const MESH_MISSION_UPSERT_TOOL = {
    name: 'mesh_mission_upsert',
    description: 'Create or update a persistent mission record so the plan survives coordinator restarts. Create a mission before enqueueing a multi-task batch, attach tasks via mesh_enqueue_task mission_id, and update status to completed/abandoned when the outcome is decided. Progress is derived from task statuses — there is no separate progress field.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mission_id: { type: 'string', description: 'Mission id to update. Omit to create a new mission.' },
            title: { type: 'string', description: 'Short mission title.' },
            goal: { type: 'string', description: 'Free-text mission goal/definition of done.' },
            status: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'], description: 'Mission lifecycle status. Defaults to active on create.' },
        },
        required: ['title'],
    },
};

export const MESH_MISSION_LIST_TOOL = {
    name: 'mesh_mission_list',
    description: 'List missions with their goal, status, and live task progress (total/pending/assigned/completed/failed). '
        + 'Unlike mesh_status (which surfaces live + recent missions), this returns every mission regardless of status by default, '
        + 'so paused/abandoned/completed missions are never hidden. Filter with `status` to scope (e.g. ["paused"] to find paused missions). '
        + 'Compact (default) elides the full goal to a capped preview; pass verbose=true for full goal text. Read-only.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            status: {
                type: 'array',
                items: { type: 'string', enum: ['active', 'paused', 'completed', 'abandoned'] },
                description: 'Optional status filter. Omit to return missions of every status.',
            },
            verbose: { type: 'boolean', description: 'Return full goal text instead of a capped preview. Defaults to false (compact).' },
        },
    },
};

export const MESH_APPROVE_TOOL = {
    name: 'mesh_approve',
    description: 'Approve or reject a pending action on a delegated agent session.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID with pending approval.' },
            action: { type: 'string', enum: ['approve', 'reject'], description: 'Action to take.' },
        },
        required: ['node_id', 'session_id', 'action'],
    },
};

export const MESH_CLONE_NODE_TOOL = {
    name: 'mesh_clone_node',
    description: 'Create a new worktree-based node from an existing node for isolated parallel work. '
        + 'Creates a git worktree on a new branch so multiple tasks can run on separate branches simultaneously.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            source_node_id: { type: 'string', description: 'Node ID to clone from (from mesh_list_nodes).' },
            branch: { type: 'string', description: 'Branch name for the new worktree (e.g. "feat/auth-refactor").' },
            base_branch: { type: 'string', description: 'Starting point for the branch (default: current HEAD).' },
        },
        required: ['source_node_id', 'branch'],
    },
};

export const MESH_REMOVE_NODE_TOOL = {
    name: 'mesh_remove_node',
    description: 'Remove a node from the mesh. If the node is a worktree, also cleans up the git worktree and directory. Session cleanup is controlled by mesh policy sessionCleanupOnNodeRemove unless session_cleanup_mode overrides it for this call. The coordinator\'s own local base node (same machine, NOT a worktree) is protected — removing it breaks live mesh membership and is rejected unless force:true is passed.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID to remove.' },
            session_cleanup_mode: {
                type: 'string',
                enum: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'],
                description: 'Optional override for cleanup of delegated sessions attached to this node. preserve keeps history/processes; stop stops live runtimes only; delete_stopped removes completed transcripts only; stop_and_delete stops live runtimes and deletes records.',
            },
            force: { type: 'boolean', description: 'Override the coordinator-base-node guard. Only set true to intentionally tear down this mesh; the coordinator must then be re-registered/restarted. Worktree nodes never need force.' },
        },
        required: ['node_id'],
    },
};

export const MESH_CLEANUP_SESSIONS_TOOL = {
    name: 'mesh_cleanup_sessions',
    description: 'Manually clean up delegated session records for a mesh node without removing the node. Defaults should preserve reviewable history unless the caller chooses a mode explicitly.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID whose delegated sessions should be considered for cleanup.' },
            mode: {
                type: 'string',
                enum: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'],
                description: 'preserve = no-op; stop = release process occupancy by stopping live runtimes; delete_stopped = remove completed/stopped records while leaving live runtimes alone; stop_and_delete = stop live runtimes and delete records.',
            },
            session_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional explicit session IDs to limit cleanup to. When omitted, sessions are matched by node/workspace metadata.',
            },
            dry_run: { type: 'boolean', description: 'Preview matched/stopped/deleted/skipped session IDs without mutating session-host state.' },
        },
        required: ['node_id', 'mode'],
    },
};

export const MESH_TASK_HISTORY_TOOL = {
    name: 'mesh_task_history',
    description: 'Read the task ledger for this mesh — dispatched tasks, completions, failures, checkpoints, and node lifecycle events. Use to understand what has been done before deciding next steps, to detect repeated failures, and to inform recovery decisions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            tail: { type: 'number', description: 'Number of recent entries to return (default: 20; clamped to 40 in compact mode, 200 in verbose).' },
            kind: { type: 'string', description: 'Filter by entry kind: task_dispatched, task_completed, task_failed, task_stalled, session_launched, checkpoint_created, node_cloned, node_removed, direct_fast_forward.' },
            compact: { type: 'boolean', description: 'Slim payload for LLM callers. Default true. Truncates long payload strings (message/taskSummary ≤200, finalSummary ≤300) and elides any large nested evidence blob (>2KB serialized — e.g. validationSummary/result/patchEquivalence/submoduleReachability) to a {_elided,_kind,_bytes,_hint} placeholder; full evidence stays accessible via mesh_reconcile_ledger. Set false (or verbose=true) for full untruncated payloads.' },
            verbose: { type: 'boolean', description: 'Force the full untruncated payload; overrides compact.' },
        },
    },
};

export const MESH_RECONCILE_LEDGER_TOOL = {
    name: 'mesh_reconcile_ledger',
    description: 'Reconcile daemon-local mesh ledgers by querying bounded ledger slices over P2P/DataChannel and importing missing entries into the coordinator local JSONL ledger. Cloud/D1 is not used as a ledger source of truth.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_ids: { type: 'array', items: { type: 'string' }, description: 'Optional node IDs to query. Defaults to all mesh nodes.' },
            limit: { type: 'number', description: 'Bounded slice size per node. Defaults to 100 and is clamped by daemon-core.' },
            after_id: { type: 'string', description: 'Optional cursor entry ID; remote slices return entries strictly after this ID when present.' },
            since: { type: 'string', description: 'Optional ISO timestamp lower bound for queried entries.' },
            import_entries: { type: 'boolean', description: 'When false, query and report evidence without importing remote entries. Defaults true.' },
        },
    },
};

export const MESH_PRUNE_STALE_DIRECT_TOOL = {
    name: 'mesh_prune_stale_direct',
    description: 'Prune orphaned staleDirect dispatch records — direct task dispatches whose original node/session is no longer present in the live mesh. dry_run (default) reports exactly which records would be pruned without mutating anything; pass execute=true to delete them. Active/pending/assigned/generating work and fresh unacknowledged dispatch failures (node/session still live) are always preserved. The append-only mesh ledger audit history is left intact.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            execute: { type: 'boolean', description: 'When true, actually delete the orphaned records. Defaults false (dry run). Ignored when dry_run=true.' },
            dry_run: { type: 'boolean', description: 'Force a preview without mutation even if execute=true. Defaults to dry-run behavior when execute is not set.' },
            include_terminal: { type: 'boolean', description: 'Also prune terminal (completed/failed) direct dispatch store rows in addition to orphans. Defaults false.' },
        },
    },
};

export const MESH_REFINE_NODE_TOOL = {
    name: 'mesh_refine_node',
    description: 'The Refinery: validate → merge → push → clean up a completed worktree node onto the base branch. '
        + 'Defaults to dry-run (plan only): returns the validation plan with mergeWillRun:false/cleanupWillRun:false and performs NO merge/push/cleanup. '
        + 'Pass execute=true to actually converge the node. execute=true is async: the immediate response includes async:true, status:\'accepted\', jobId, interactionId, target node, and startedAt; completion/failure evidence is delivered through pending mesh events and the mesh task ledger. '
        + 'dry_run=true overrides execute. Matches the mesh_refine_batch / mesh_fast_forward_node dry_run/execute contract.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the completed worktree node to refine and merge.' },
            execute: { type: 'boolean', description: 'When true, run validation/merge/push/cleanup for this node. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview the validation plan without merging. Defaults true unless execute=true; dry_run=true overrides execute.' },
        },
        required: ['node_id'],
    },
};

export const MESH_REFINE_BATCH_TOOL = {
    name: 'mesh_refine_batch',
    description: 'Batch Refinery: converge multiple sibling worktree nodes onto the base branch in one conflict-aware sequential pipeline. '
        + 'Orders nodes by change-area (non-submodule nodes first, submodule-touching nodes serialized last) so each merged sibling advances the base and the next node auto-rebases + re-checks patch-equivalence before its own merge. '
        + 'Each node runs the same validation/patch-equivalence/submodule-reachability/merge/cleanup gates as mesh_refine_node. '
        + 'Conflicting or blocked nodes are isolated as blocked_review while the rest of the batch proceeds. Defaults to dry-run (plan only); set execute=true to converge. Never force-pushes or resets. '
        + 'execute=true is async: the immediate response is async:true / status:\'accepted\' with the batch jobId and ordered target node list; per-node convergence runs in the background and the aggregate completion/failure (with per-node merged / blocked_review / not_mergeable results) is delivered as a terminal refine event via pending mesh events and the ledger — do not re-invoke while a batch is in flight. dry_run returns the plan synchronously.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional explicit node IDs to converge, in any order (the tool computes the safe merge order). When omitted, all local worktree nodes that need convergence are auto-collected.',
            },
            execute: { type: 'boolean', description: 'When true, run validation/rebase/merge for each node in order. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview the ordering + per-node validation plan without executing. Defaults true unless execute=true; dry_run=true overrides execute.' },
        },
        required: [],
    },
};

export const MESH_REFINE_CONFIG_SCHEMA_TOOL = {
    name: 'mesh_refine_config_schema',
    description: 'Return the Repo Mesh Refinery config JSON schema and supported repo-local config locations. This is the validation source of truth; heuristic command detection is suggestions-only.',
    inputSchema: { type: 'object' as const, properties: {} },
};

export const MESH_VALIDATE_REFINE_CONFIG_TOOL = {
    name: 'mesh_validate_refine_config',
    description: 'Validate the repo mesh/refine config for a node/workspace without running validation commands or merging.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Optional node/workspace whose refine config should be loaded. Defaults to the first mesh node.' },
            config: { type: 'object', description: 'Optional inline config object to validate instead of loading from the repo.' },
        },
    },
};

export const MESH_SUGGEST_REFINE_CONFIG_TOOL = {
    name: 'mesh_suggest_refine_config',
    description: 'Suggest a repo mesh/refine config scaffold from project context/package scripts. Suggestions are never executed until saved as explicit refine config.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Optional node/workspace used for suggestions. Defaults to the first mesh node.' },
        },
    },
};

export const MESH_INIT_TOOL = {
    name: 'mesh_init',
    description: 'One-click mesh onboarding for an existing git project. Detects installed CLI providers, suggests Refinery (.adhdev/refine.json) and worktree bootstrap (.adhdev/worktree_bootstrap.json) configs, optionally writes them to disk, and recommends a node providerPriority from the detected providers. Suggestions are scaffold only and never execute until saved; providerPriority is a recommendation to apply to node policy, not auto-applied. Defaults to dry-run (no files written) and never overwrites an existing config unless overwrite=true.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Optional node/workspace to onboard. Defaults to the first mesh node with a workspace.' },
            write: { type: 'boolean', description: 'When true, persist the suggested configs to disk. Defaults false (dry-run preview only).' },
            overwrite: { type: 'boolean', description: 'When true, overwrite an existing config file. Defaults false (never clobber an existing refine/bootstrap config).' },
        },
    },
};

export const MESH_REFINE_PLAN_TOOL = {
    name: 'mesh_refine_plan',
    description: 'Dry-run Refinery plan for a worktree node: reports config source, validation commands, suggestions/unavailable reason, and merge/cleanup intent without executing validation or git merge.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the worktree node to plan.' },
        },
        required: ['node_id'],
    },
};

export const MESH_REVIEW_INBOX_TOOL = {
    name: 'mesh_review_inbox',
    description: 'List local worktree nodes that need human review: merge candidates (pushed feature branches ready to merge) and Refinery-blocked review results. Returns evidence summaries, diff stats vs. the default branch, and suggested actions (Refine / Requeue / Dismiss). Remote nodes are excluded in M4.0.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            mesh_id: { type: 'string', description: 'Mesh ID (optional — inferred from active mesh if omitted).' },
        },
        required: [],
    },
};

export const ALL_MESH_TOOLS = [
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
    MESH_CHECKPOINT_TOOL,
    MESH_APPROVE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_REFINE_BATCH_TOOL,
    MESH_REFINE_CONFIG_SCHEMA_TOOL,
    MESH_VALIDATE_REFINE_CONFIG_TOOL,
    MESH_SUGGEST_REFINE_CONFIG_TOOL,
    MESH_INIT_TOOL,
    MESH_REFINE_PLAN_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
    MESH_PRUNE_STALE_DIRECT_TOOL,
    MESH_TASK_HISTORY_TOOL,
    MESH_RECONCILE_LEDGER_TOOL,
    MESH_MISSION_UPSERT_TOOL,
    MESH_MISSION_LIST_TOOL,
    MESH_REVIEW_INBOX_TOOL,
];

// ─── Tool Implementations ───────────────────────

export async function meshStatus(ctx: MeshContext, args: { includeStaleDirectWorkDetails?: boolean; includeTerminalDirectWork?: boolean; includeSessions?: boolean; compact?: boolean; verbose?: boolean } = {}): Promise<string> {
    const rateResult = recordMeshToolCall({ meshId: ctx.mesh.id, tool: 'mesh_status' });
    // Default to the slim payload for LLM callers; verbose forces the full payload.
    const compact = args.verbose === true ? false : (args.compact ?? true);

    await refreshMeshFromDaemon(ctx);
    const { mesh, transport } = ctx;

    let ledgerSummary = getLedgerSummary(mesh.id);

    // Probe all nodes in parallel — git_status + session collection per node are independent.
    const results = await Promise.all(mesh.nodes.map(async (node) => {
        const entry: any = {
            nodeId: node.id,
            workspace: node.workspace,
            machine: buildNodeMachineIdentity(ctx, node),
            daemonId: readNodeDaemonId(node),
            machineId: readNodeMachineId(node),
            ...getNodeLaunchReadiness(node),
        };

        try {
            const autoDiscover = (node.policy as any)?.autoDiscoverSubmodules !== false;
            const statusResult = await commandForNode(ctx, node, 'git_status', {
                workspace: node.workspace,
                refreshUpstream: true,
                includeSubmodules: autoDiscover,
                submoduleIgnorePaths: (node.policy as any)?.submoduleIgnorePaths || undefined,
            });
            const status = extractGitStatus(statusResult);
            const uncommittedChanges = countUncommittedChanges(status);
            const dirty = isGitStatusDirty(status);
            entry.health = status?.isGitRepo ? (dirty ? 'dirty' : 'online') : 'degraded';
            assignFullGitSnapshot(entry, status);
            entry.branch = status?.branch;
            entry.isDirty = dirty;
            entry.uncommittedChanges = uncommittedChanges;
            entry.branchConvergence = buildBranchConvergence(mesh, node, status, dirty, uncommittedChanges);
            // Stale-daemon-build warning: the live daemon's build commit is a
            // strict ancestor of this workspace HEAD (or its oss submodule),
            // meaning merged code is not yet live (awaiting deploy/restart).
            // Computed git-correctly on the daemon side (git_status →
            // daemonBuildBehind); surfaced here as a top-level node field.
            if (status?.daemonBuildBehind && typeof status.daemonBuildBehind === 'object') {
                entry.staleDaemonBuild = status.daemonBuildBehind;
            }
            // Submodule out-of-sync warning
            const submodules = extractSubmodules(statusResult, (node.policy as any)?.submoduleIgnorePaths || []);
            if (submodules && submodules.some((s: any) => s?.outOfSync)) {
                entry.submoduleWarning = 'One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.';
                entry.outOfSyncSubmodules = submodules.filter((s: any) => s?.outOfSync).map((s: any) => s.path);
            }
        } catch (e: any) {
            const failure = buildCoordinatorP2pRelayFailure(e, {
                command: 'git_status',
                targetDaemonId: node.daemonId,
                nodeId: node.id,
            });
            entry.health = 'degraded';
            entry.error = failure.error;
            entry.degradedReason = failure.recoverable ? 'p2p_relay_failure' : 'git_status_unavailable';
            Object.assign(entry, {
                code: failure.code,
                transport: failure.transport,
                recoverable: failure.recoverable,
                retryRecommended: failure.retryRecommended,
                nextAction: failure.nextAction,
                noFallbackReason: failure.noFallbackReason,
            });
        }

        // Recovery Hints & Next-step reporting
        const recoveryContext = getSessionRecoveryContext(mesh.id, { nodeId: node.id });
        if (recoveryContext.consecutiveNodeFailures > 0) {
            entry.recoveryHints = {
                consecutiveFailures: recoveryContext.consecutiveNodeFailures,
                lastTaskMessage: typeof recoveryContext.lastTaskMessage === 'string'
                    ? recoveryContext.lastTaskMessage.slice(0, 100) + (recoveryContext.lastTaskMessage.length > 100 ? '…' : '')
                    : recoveryContext.lastTaskMessage,
                advice: recoveryContext.advice,
                retryRecommended: recoveryContext.retryRecommended,
            };
        }

        const activeLaunchFailure = getLatestActiveLaunchFailure(mesh.id, node.id);
        if (activeLaunchFailure && node.isLocalWorktree) {
            entry.health = 'degraded';
            entry.degradedReason = 'worktree_launch_failed';
            entry.launchReady = false;
            entry.launchBlockedReason = activeLaunchFailure.code || 'mesh_launch_failed';
            entry.launchBlockedMessage = activeLaunchFailure.error || 'Previous worktree session launch failed';
            entry.lastLaunchFailure = activeLaunchFailure;
        }

        const nextStepHints: string[] = [];
        if (entry.degradedReason === 'worktree_launch_failed') {
            nextStepHints.push(`Retry mesh_launch_session(node_id: "${node.id}") after daemon mesh transport/P2P is healthy.`);
            nextStepHints.push(`If retry is not desired, cleanup the orphan worktree node with mesh_remove_node(node_id: "${node.id}").`);
        } else if (entry.health === 'online' && node.isLocalWorktree) {
            nextStepHints.push(`Merge worktree to base via mesh_refine_node(node_id: "${node.id}")`);
        } else if (entry.health === 'dirty') {
            nextStepHints.push(`Commit changes via mesh_checkpoint(node_id: "${node.id}", message: "...")`);
        } else if (entry.health === 'degraded' && entry.error?.includes('git')) {
            nextStepHints.push('Initialize git repository or check workspace path.');
        }

        if (entry.branchConvergence?.needsConvergence === true && entry.branchConvergence.nextStep) {
            nextStepHints.push(String(entry.branchConvergence.nextStep));
        }

        if (recoveryContext.consecutiveNodeFailures > 0) {
            if (recoveryContext.retryRecommended) {
                nextStepHints.push(`Retry task on this node or launch a fresh session.`);
            } else {
                nextStepHints.push(`Consider reassigning work to a different node.`);
            }
        }

        if (nextStepHints.length > 0) {
            entry.nextStepHints = nextStepHints;
        }

        const relatedRepos = await collectRelatedRepoStatuses(ctx, node);
        if (relatedRepos.length) entry.relatedRepos = relatedRepos;

        const statusProbe = await collectLiveStatusProbe(ctx, node);
        const liveSessions = statusProbe.sessions;
        // Per-node daemon build stamp (commit/version of the running daemon).
        // Compact mode folds these per-daemonId at the response level, but the
        // raw field is kept on the node so verbose callers and self-coordinator
        // shape stay intact.
        if (statusProbe.daemonBuild) entry.daemonBuild = statusProbe.daemonBuild;
        if (liveSessions.length > 0) {
            // Slim to essential fields only — full session objects are expensive in coordinator context.
            entry.sessions = liveSessions
                .map((s: any) => {
                    // A session is marked as a coordinator for THIS mesh when the daemon's
                    // coordinator registry / session settings report its meshId matches ours.
                    // From the caller's perspective (which is itself a coordinator for this
                    // mesh), any such session is "self" — i.e. it is the calling coordinator
                    // session, not a foreign delegated worker. This prevents the coordinator
                    // from mis-reporting its own generating CLI session as someone else's
                    // delegated task.
                    const coordinatorMeshId =
                        typeof s.coordinator?.meshId === 'string' ? s.coordinator.meshId : undefined;
                    const isSelfCoordinator = coordinatorMeshId === mesh.id;
                    return {
                        id: s.instanceId ?? s.id ?? s.sessionId,
                        status: s.status ?? s.lifecycle ?? s.state,
                        providerType: s.providerType ?? s.cliType ?? s.type,
                        ...(s.activeChat?.status ? { chatStatus: s.activeChat.status } : {}),
                        ...(isSelfCoordinator ? { isSelfCoordinator: true, role: 'coordinator' as const } : {}),
                    };
                })
                // Exclude sessions with no resolvable id (malformed or custom provider response).
                .filter((s: any) => s.id);
        }

        return entry;
    }));

    let ledgerEntries = readLedgerEntries(mesh.id, { tail: 200 });
    let directDispatches = getActiveDirectDispatches(mesh.id);
    const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, results, directDispatches, ledgerEntries);
    if (directReconciliation.reconciled > 0) {
        ledgerEntries = readLedgerEntries(mesh.id, { tail: 200 });
        directDispatches = getActiveDirectDispatches(mesh.id);
        ledgerSummary = getLedgerSummary(mesh.id);
    }
    const activeWorkEvidence = buildMeshActiveWork({
        meshId: mesh.id,
        queue: getQueue(mesh.id),
        ledgerEntries,
        directDispatches,
        nodes: results,
    });

    const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);
    const staleDirectWorkSummary = buildCompactStaleDirectWorkSummary(activeWorkEvidence.staleDirectWork, {
        note: activeWorkEvidence.staleDirectWorkNote,
        detailHint: 'Full stale direct entries are omitted from mesh_status by default. Call mesh_status with includeStaleDirectWorkDetails=true or inspect mesh_task_history for ledger detail.',
    });
    // Leak #2: in compact mode each activeWork row drops the duplicated
    // taskSummary/message echoes (keeps a short taskTitle + dispatch scalars).
    // Verbose keeps the full per-record text for debugging.
    const activeWorkForResponse = compact
        ? compactActiveWorkRecords(activeWorkEvidence.activeWork)
        : { records: activeWorkEvidence.activeWork, omitted: 0 };

    // Surface coordinator session identity at the top level so the caller (which
    // is itself a coordinator for this mesh) can immediately recognize which
    // sessions in the response are its own — see the per-session
    // `isSelfCoordinator` marker derived above.
    const coordinatorSessions: Array<Record<string, unknown>> = [];
    for (const nodeEntry of results) {
        const sessions = Array.isArray((nodeEntry as any).sessions) ? (nodeEntry as any).sessions : [];
        for (const s of sessions) {
            if (s?.isSelfCoordinator === true && s.id) {
                coordinatorSessions.push({
                    nodeId: (nodeEntry as any).nodeId,
                    sessionId: s.id,
                    providerType: s.providerType,
                    status: s.status,
                });
            }
        }
    }

    // Compact mode: slim each node's large duplicated `git` blob down to the
    // coordinator-relevant scalars + submodules. branch/health/headCommit/ahead/
    // behind/dirty/upstreamStatus/branchConvergence live as top-level node
    // fields (or inside the slim git snapshot) and are always preserved.
    //
    // Session N×M de-duplication: the per-node session list comes from a
    // daemon-wide `get_status_metadata` probe, so every node that shares a
    // daemonId reports the SAME sessions. Emitting the full array on every node
    // makes the payload grow O(nodes × sessions). In compact mode we therefore
    // (a) fold each node's `sessions` array to a `sessionSummary` (counts only),
    // and (b) emit the full slim session arrays exactly once per daemon under
    // top-level `daemonSessions`. The self-coordinator marker survives in both
    // the per-node summary (`selfCoordinatorSessionIds`) and the top-level
    // `coordinatorSessions`/`selfIdentification`. Individual per-node session
    // detail can be opted back in with `includeSessions=true`.
    const includeSessions = args.includeSessions === true;
    // Top-level per-daemon session map (compact). Sessions are recorded ONCE per
    // daemonId regardless of how many mesh nodes share that daemon, eliminating
    // the N×M duplication. With includeSessions=true the full slim session arrays
    // are emitted; otherwise each daemon is folded to a counts summary.
    const daemonSessions: Record<string, unknown> = {};
    if (compact) {
        const seenDaemons = new Set<string>();
        for (const entry of results as any[]) {
            const daemonId = typeof entry?.daemonId === 'string' && entry.daemonId ? entry.daemonId : '';
            const sessions = Array.isArray(entry?.sessions) ? entry.sessions : [];
            if (daemonId && sessions.length > 0 && !seenDaemons.has(daemonId)) {
                seenDaemons.add(daemonId);
                daemonSessions[daemonId] = includeSessions ? sessions : summarizeNodeSessions(sessions);
            }
        }
    }
    // Per-daemon build fold: the daemon build stamp is identical for every node
    // sharing a daemonId (it's a daemon-wide probe), so record it ONCE per
    // daemonId at the top level. Small field — emitted in both compact and
    // verbose modes so the coordinator can compare the live daemon's commit with
    // a just-merged fix without paging through nodes.
    const daemonBuilds: Record<string, unknown> = {};
    for (const entry of results as any[]) {
        const daemonId = typeof entry?.daemonId === 'string' && entry.daemonId ? entry.daemonId : '';
        if (daemonId && entry?.daemonBuild && !(daemonId in daemonBuilds)) {
            daemonBuilds[daemonId] = entry.daemonBuild;
        }
    }
    // Stale-build aggregate: any node whose live daemon build is behind its
    // workspace HEAD. Deduplicated per daemonId+scope so N worktrees on one
    // stale daemon don't spam N identical warnings.
    const staleDaemonBuilds: Array<Record<string, unknown>> = [];
    const seenStale = new Set<string>();
    for (const entry of results as any[]) {
        const behind = entry?.staleDaemonBuild;
        if (!behind || typeof behind !== 'object') continue;
        const daemonId = typeof entry?.daemonId === 'string' ? entry.daemonId : '';
        const key = `${daemonId}::${behind.scope ?? ''}::${behind.buildCommit ?? ''}::${behind.head ?? ''}`;
        if (seenStale.has(key)) continue;
        seenStale.add(key);
        // web-only stale builds are informational, not "fix not live". Only daemon-
        // affecting stale builds (or ones where the classification is unknown →
        // defaulted true) mean a merged daemon/refinery fix is not yet live.
        const isDaemonAffecting = behind.isDaemonAffecting !== false;
        staleDaemonBuilds.push({
            daemonId,
            nodeId: entry.nodeId,
            scope: behind.scope,
            liveBuildCommit: behind.buildCommit,
            liveBuildCommitShort: behind.buildCommitShort,
            head: behind.head,
            isDaemonAffecting,
            ...(Array.isArray(behind.affectedPackages) && behind.affectedPackages.length > 0
                ? { affectedPackages: behind.affectedPackages }
                : {}),
            // The full ~300-char warning prose is identical for every entry and is
            // already emitted ONCE at the top level as `staleDaemonBuildWarning`.
            // Keep it per-entry only in verbose to avoid N× duplication in compact.
            ...(compact ? {} : { warning: behind.warning }),
        });
    }
    const daemonAffectingStaleBuilds = staleDaemonBuilds.filter((b) => b.isDaemonAffecting !== false);
    const webOnlyStaleBuilds = staleDaemonBuilds.filter((b) => b.isDaemonAffecting === false);

    let stubbedNodeCount = 0;
    let foldedNodesSummary: Record<string, unknown> | undefined;
    const nodesForResponse = compact
        ? (() => {
            const compacted = results.map((entry: any) => {
                const next = compactMeshStatusNode(entry);
                if (!next || typeof next !== 'object') return next;
                if (Array.isArray(next.sessions)) {
                    next.sessionSummary = summarizeNodeSessions(next.sessions);
                    // Drop the full per-node array unless explicitly opted in. The
                    // de-duplicated full lists are available under top-level
                    // `daemonSessions` keyed by daemonId.
                    if (!includeSessions) delete next.sessions;
                }
                // Build stamp is folded per-daemon under top-level `daemonBuilds`;
                // drop the repetitive per-node copy in compact mode.
                if (next.daemonBuild !== undefined) delete next.daemonBuild;
                return next;
            });

            // Two-tier bounding, highest-severity first:
            //  1. detail byte-budget — noteworthy nodes get full compact detail until
            //     COMPACT_DETAILED_NODES_BYTE_BUDGET is spent; the rest degrade to a stub.
            //  2. total node-array byte-budget — quiet/overflow nodes are emitted as
            //     minimal stubs until COMPACT_NODES_TOTAL_BYTE_BUDGET is spent; any node
            //     beyond that is fully folded into the foldedNodes id-list summary.
            // Nodes that survive in the array keep their ORIGINAL order. Every node id is
            // either in the array (detail or stub) or listed in foldedNodes.nodeIds.
            const noteworthy = compacted.filter((n: any) => n && typeof n === 'object' && isNoteworthyCompactNode(n));
            const ranked = [...noteworthy].sort((a, b) => compactNodeSeverity(b) - compactNodeSeverity(a));
            const detailedIds = new Set<string>();
            let detailSpent = 0;
            for (const n of ranked) {
                const cost = JSON.stringify(n).length + 1;
                if (detailedIds.size === 0 || detailSpent + cost <= COMPACT_DETAILED_NODES_BYTE_BUDGET) {
                    detailedIds.add(String(n.nodeId));
                    detailSpent += cost;
                }
            }

            // severity order for awarding the remaining total budget to stubs
            const stubOrder = [...compacted]
                .filter((n: any) => n && typeof n === 'object')
                .sort((a, b) => compactNodeSeverity(b) - compactNodeSeverity(a));
            const keptIds = new Set<string>(detailedIds);
            let totalSpent = detailSpent;
            for (const n of stubOrder) {
                const id = String(n.nodeId);
                if (keptIds.has(id)) continue;
                const stubCost = JSON.stringify(minimalCompactNode(n)).length + 1;
                if (totalSpent + stubCost <= COMPACT_NODES_TOTAL_BYTE_BUDGET) {
                    keptIds.add(id);
                    totalSpent += stubCost;
                }
            }

            const fullyFolded: any[] = [];
            const out = compacted
                .map((n: any) => {
                    if (!n || typeof n !== 'object') return n;
                    const id = String(n.nodeId);
                    if (detailedIds.has(id)) return n;
                    if (keptIds.has(id)) {
                        stubbedNodeCount += 1;
                        return minimalCompactNode(n);
                    }
                    fullyFolded.push(n);
                    return null;
                })
                .filter((n: any) => n !== null);

            if (fullyFolded.length > 0) {
                const byBranchConvergence: Record<string, number> = {};
                const byHealth: Record<string, number> = {};
                const nodeIds: string[] = [];
                for (const n of fullyFolded) {
                    const bc = typeof n?.branchConvergence?.status === 'string' ? n.branchConvergence.status : 'unknown';
                    byBranchConvergence[bc] = (byBranchConvergence[bc] ?? 0) + 1;
                    const h = typeof n?.health === 'string' ? n.health : 'unknown';
                    byHealth[h] = (byHealth[h] ?? 0) + 1;
                    if (n?.nodeId) nodeIds.push(String(n.nodeId));
                }
                foldedNodesSummary = {
                    count: fullyFolded.length,
                    note: 'Node-array byte budget reached: these nodes are listed by id only. Query a specific node_id or use verbose=true for their detail.',
                    byHealth,
                    byBranchConvergence,
                    nodeIds,
                };
            }
            return out;
        })()
        : results;

    const response: Record<string, unknown> = {
        meshId: mesh.id,
        meshName: mesh.name,
        repoIdentity: mesh.repoIdentity,
        policy: mesh.policy,
        payloadMode: compact ? 'compact' : 'full',
        refreshedAt: new Date().toISOString(),
        sourceOfTruth: {
            membership: 'coordinator_daemon_live_mesh',
            currentStatus: 'live_git_and_session_probes',
            activeWork: 'mesh_queue_file_and_local_ledger',
            historicalEvidenceOnly: ['recoveryHints', 'ledgerSummary'],
        },
        nodes: nodesForResponse,
        ...(compact && stubbedNodeCount > 0
            ? {
                stubbedNodesNote: `${stubbedNodeCount} node(s) in the array above are reduced to a minimal stub (marked folded:true) in compact mode — healthy/clean nodes plus any beyond the detail byte-budget. They remain addressable by node_id; use verbose=true for their full detail.`,
            }
            : {}),
        ...(compact && foldedNodesSummary ? { foldedNodes: foldedNodesSummary } : {}),
        ...(compact && Object.keys(daemonSessions).length > 0 ? { daemonSessions } : {}),
        ...(Object.keys(daemonBuilds).length > 0 ? { daemonBuilds } : {}),
        ...(staleDaemonBuilds.length > 0 ? { staleDaemonBuilds } : {}),
        ...(daemonAffectingStaleBuilds.length > 0
            ? {
                staleDaemonBuildWarning: 'One or more live daemons were built from a commit behind the workspace HEAD with daemon-runtime package changes. Merged refinery/mesh-tool fixes are NOT live on those daemons until they are rebuilt/redeployed and restarted — a local daemon-core dist rebuild does not update a cloud daemon. Do not assume a just-merged fix is active.',
            }
            : {}),
        ...(webOnlyStaleBuilds.length > 0
            ? {
                webOnlyStaleBuildNote: 'One or more live daemons are behind workspace HEAD, but only web packages changed in that range. The daemon does NOT need a rebuild/restart — redeploy the web app to reflect those changes. This is informational, not a "fix not live" condition.',
            }
            : {}),
        activeWork: activeWorkForResponse.records,
        ...(compact && activeWorkForResponse.omitted > 0
            ? { activeWorkRowsOmitted: activeWorkForResponse.omitted }
            : {}),
        ...(compact
            ? { activeWorkHint: `Compact activeWork rows carry a short taskTitle + dispatch scalars only; full task prompt/summary text is omitted — use mesh_task_history or mesh_status verbose=true. First ${COMPACT_MAX_ACTIVE_WORK_ROWS} rows serialized.` }
            : {}),
        staleDirectWorkSummary,
        ...(args.includeStaleDirectWorkDetails === true ? { staleDirectWork: activeWorkEvidence.staleDirectWork } : {}),
        // terminalDirectWork is historical (completed/failed direct dispatches) — opt-in only.
        ...(args.includeTerminalDirectWork === true ? { terminalDirectWork: activeWorkEvidence.terminalDirectWork } : {}),
        activeWorkSummary: activeWorkEvidence.summary,
        ...(pollingGuidance ? { pollingGuidance } : {}),
        ...(rateResult.rateLimitExceeded ? { pollingRateAdvisory: { type: 'rate_limit_exceeded', tool: 'mesh_status', callsInWindow: rateResult.callsInWindow, message: rateResult.advisory } } : {}),
        branchConvergenceSummary: summarizeBranchConvergence(results, compact),
        ...(coordinatorSessions.length > 0
            ? {
                coordinatorSessions,
                selfIdentification: {
                    meshId: mesh.id,
                    coordinatorSessions,
                    note: 'Sessions listed here are coordinator sessions for this mesh. The calling coordinator IS one of these sessions — do not treat its own generating CLI session as a foreign delegated task. Per-session marker: sessions[].isSelfCoordinator === true.',
                },
            }
            : {}),
    };

    // Include task ledger summary for coordinator context
    try {
        response.ledgerSummary = ledgerSummary;
    } catch { /* ledger read is best-effort */ }

    // M3-2: mission summaries — goal + live task aggregates (derived, not stored).
    // M7: each mission also carries time/attempt stats derived from the ledger.
    //
    // Visibility: surface ALL live missions (active AND paused) plus a capped slice
    // of completed/abandoned history — getActiveMeshMissionSummaries (active-only)
    // hid paused missions from the coordinator entirely. Compact mode (the default)
    // elides each mission's full goal to a capped goalPreview + goalTruncated flag;
    // verbose returns the full goal text. Identity/status/task aggregates are kept
    // in both modes so a coordinator can always answer "what missions exist".
    try {
        const missions = getMeshStatusMissionSummaries(mesh.id, { verbose: !compact });
        if (missions.length > 0) {
            response.missions = missions.map(mission => {
                try {
                    return { ...mission, stats: computeMeshMissionStats(mesh.id, mission.id) };
                } catch {
                    return mission;
                }
            });
        }
    } catch { /* mission read is best-effort */ }

    try {
        const pendingEvents = await drainCoordinatorPendingEvents(ctx);
        const asyncRefineJobs = buildMeshAsyncRefineJobs({
            meshId: mesh.id,
            ledgerEntries,
            pendingEvents,
        });
        if (asyncRefineJobs.length > 0) {
            if (compact) {
                // Drop terminal (completed/failed) refine jobs — they are historical and
                // dominate the payload. Keep active (non-terminal) job objects so the
                // coordinator can still track in-flight refines, and replace the rest with
                // a status-count summary.
                //
                // Stale terminal jobs (resolved refinery rejections/successes from earlier
                // in the ledger window — often multi-day-old) are folded out of the counts
                // so byStatus.failed reflects *current* breakage, not historical residue.
                // The folded count is surfaced as `staleTerminal` for transparency.
                const summary = summarizeMeshAsyncRefineJobs(asyncRefineJobs);
                if (summary.activeJobs.length > 0) response.asyncRefineJobs = summary.activeJobs;
                response.asyncRefineJobsSummary = {
                    total: summary.total,
                    byStatus: summary.byStatus,
                    ...(summary.staleTerminal > 0 ? { staleTerminal: summary.staleTerminal } : {}),
                };
            } else {
                response.asyncRefineJobs = asyncRefineJobs;
            }
        }
        if (pendingEvents.length > 0) {
            response.pendingCoordinatorEvents = pendingEvents;
        }
    } catch {
        // Non-fatal: pending events are best-effort.
    }

    return JSON.stringify(response, null, 2);
}

export async function meshTaskHistory(
    ctx: MeshContext,
    args: { tail?: number; kind?: string; compact?: boolean; verbose?: boolean },
): Promise<string> {
    const { mesh } = ctx;
    // Default to the slim payload for LLM callers; verbose forces full payloads.
    const compact = args.verbose === true ? false : (args.compact ?? true);
    const pendingEvents = await drainCoordinatorPendingEvents(ctx);
    // Clamp tail so a large default/explicit value can't blow up the payload in
    // compact mode. Full (verbose) callers may request a deeper window.
    const requestedTail = typeof args.tail === 'number' && args.tail > 0 ? Math.floor(args.tail) : 20;
    // Compact: cap conservatively so even large refine-batch entries can't blow the
    // token limit. slimLedgerPayload is the primary defense (it summarizes large
    // plan/validationPlan/suggestedConfig fields); this clamp is the backstop. A deep
    // explicit request (tail > 50) is clamped harder (20) than a modest one (30).
    const compactCap = requestedTail > 50 ? 20 : 30;
    const tail = compact ? Math.min(requestedTail, compactCap) : Math.min(requestedTail, 200);
    const kind = typeof args.kind === 'string' && args.kind.trim() ? [args.kind.trim() as any] : undefined;
    const rawEntries = readLedgerEntries(mesh.id, { tail, kind });
    // Slim large payload fields so coordinator context stays lean. Verbose
    // returns the raw payloads untouched for full audit detail.
    const entries = compact
        ? rawEntries.map(e => ({
            ...e,
            payload: e.payload ? slimLedgerPayload(e.payload) : e.payload,
        }))
        : rawEntries;
    const summary = getLedgerSummary(mesh.id);
    // M7: per-task time/attempt stats for tasks visible in the returned window.
    // Derived from ledger truth at query time; incomplete evidence is flagged,
    // never estimated.
    let taskStats: unknown[] | undefined;
    try {
        const taskIds = [...new Set(rawEntries
            .map(e => (typeof e.payload?.taskId === 'string' ? e.payload.taskId : ''))
            .filter(Boolean))] as string[];
        if (taskIds.length > 0) {
            const stats = computeMeshTaskStats(mesh.id, { taskIds });
            if (stats.length > 0) taskStats = stats;
        }
    } catch { /* stats are best-effort */ }
    return JSON.stringify({
        meshId: mesh.id,
        payloadMode: compact ? 'compact' : 'full',
        entries,
        summary,
        ...(taskStats ? { taskStats } : {}),
        ...(pendingEvents.length > 0 ? { pendingCoordinatorEvents: pendingEvents } : {}),
    }, null, 2);
}

export async function meshReconcileLedger(
    ctx: MeshContext,
    args: { node_ids?: string[]; limit?: number; after_id?: string; since?: string; import_entries?: boolean },
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const requestedNodeIds = Array.isArray(args.node_ids)
        ? new Set(args.node_ids.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean))
        : null;
    const nodes = ctx.mesh.nodes.filter(node => !requestedNodeIds || requestedNodeIds.has(node.id));
    const replicas: any[] = [];
    const shouldImport = args.import_entries !== false;
    const queryArgs = {
        meshId: ctx.mesh.id,
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.after_id === 'string' && args.after_id.trim() ? { afterId: args.after_id.trim() } : {}),
        ...(typeof args.since === 'string' && args.since.trim() ? { since: args.since.trim() } : {}),
    };

    for (const node of nodes) {
        try {
            if (isLocalControlPlaneNode(ctx, node) || !node.daemonId) {
                // G4: Use SQLite mesh_event_ledger (bounded slice) as the local P2P reconcile read path.
                // readLedgerSlice (JSONL) is retained for per-daemon P2P export; coordinator local reads use SQLite.
                const slice = readLedgerSliceFromStore(ctx.mesh.id, queryArgs);
                replicas.push(buildMeshLedgerReplicaEvidence({
                    nodeId: node.id,
                    daemonId: node.daemonId,
                    transport: 'local',
                    slice,
                    status: 'local',
                }));
                continue;
            }

            const result = await commandForNode(ctx, node, 'get_mesh_ledger_slice', queryArgs);
            const payload = unwrapCommandPayload(result);
            if (payload?.success === false) {
                throw new Error(payload.error || 'remote get_mesh_ledger_slice failed');
            }
            const slice = payload?.slice ?? payload;
            if (slice?.protocol !== 'adhdev.mesh.ledger.slice.v1' || !Array.isArray(slice.entries)) {
                throw new Error('remote daemon returned an invalid ledger slice payload');
            }
            const importResult = shouldImport
                ? appendRemoteLedgerEntries(ctx.mesh.id, slice.entries)
                : { accepted: 0, skippedDuplicate: 0, rejectedInvalid: 0, entries: [] };
            replicas.push(buildMeshLedgerReplicaEvidence({
                nodeId: node.id,
                daemonId: node.daemonId,
                transport: 'p2p_datachannel',
                slice,
                importResult,
            }));
            if (shouldImport && importResult.accepted > 0) {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'ledger_replicated',
                    nodeId: node.id,
                    payload: {
                        protocol: 'adhdev.mesh.ledger.slice.v1',
                        imported: importResult.accepted,
                        skippedDuplicate: importResult.skippedDuplicate,
                        rejectedInvalid: importResult.rejectedInvalid,
                        nextAfterId: slice.cursor?.nextAfterId ?? null,
                        via: 'p2p_datachannel',
                    },
                });
            }
        } catch (e: any) {
            replicas.push(buildMeshLedgerReplicaEvidence({
                nodeId: node.id,
                daemonId: node.daemonId,
                transport: node.daemonId ? 'p2p_datachannel' : 'local',
                status: 'failed',
                error: e?.message ?? String(e),
            }));
        }
    }

    const evidence = buildMeshLedgerReconciliationEvidence(ctx.mesh.id, replicas);
    appendLedgerEntry(ctx.mesh.id, {
        kind: 'ledger_reconciled',
        payload: {
            protocol: evidence.protocol,
            sourceOfTruth: evidence.sourceOfTruth,
            totals: evidence.totals,
            convergence: evidence.convergence,
        },
    });
    return JSON.stringify({ success: true, evidence }, null, 2);
}

/**
 * Prune orphaned staleDirect dispatch records — direct dispatches whose original node/session is
 * no longer present in the live mesh (or terminal). dry_run (default) reports exactly which
 * taskIds would be pruned without mutating anything; pass execute=true to actually remove them.
 *
 * Safety:
 *  - Only records classified as staleDirectWork by buildMeshActiveWork against the CURRENT live
 *    mesh are eligible — active/pending/assigned/generating work is never in that set.
 *  - Of those, only orphans (node/session gone) are pruned. Fresh unacknowledged dispatch
 *    failures (staleDispatchUnacknowledged: node/session still live) are explicitly preserved and
 *    reported under preservedUnacknowledged so the caller can recover them.
 *  - Pruning deletes only the mesh_direct_dispatches store rows; the append-only mesh ledger
 *    (audit history) is left intact, and a direct_dispatch_pruned ledger entry is appended on
 *    execute so the prune itself is auditable.
 */
export async function meshPruneStaleDirect(
    ctx: MeshContext,
    args: { execute?: boolean; dry_run?: boolean; include_terminal?: boolean } = {},
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    // execute must be explicit; dry_run is the default unless execute===true.
    const execute = args.execute === true && args.dry_run !== true;
    const includeTerminal = args.include_terminal === true;

    const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
    const ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 500 });
    const directDispatches = getActiveDirectDispatches(ctx.mesh.id);
    const activeWorkEvidence = buildMeshActiveWork({
        meshId: ctx.mesh.id,
        queue: getQueue(ctx.mesh.id),
        ledgerEntries,
        directDispatches,
        nodes: liveNodes,
        includeTerminalDirect: includeTerminal,
    });

    const candidates = [
        ...activeWorkEvidence.staleDirectWork,
        ...(includeTerminal ? activeWorkEvidence.terminalDirectWork : []),
    ];
    // Only prune store-backed dispatch rows (taskIds present in MeshRuntimeStore). Ledger-only
    // remote entries have no store row to delete and are pure audit history — leave them alone.
    const storeTaskIds = new Set(directDispatches.map(d => d.taskId));

    const prunable: typeof candidates = [];
    const preservedUnacknowledged: typeof candidates = [];
    const preservedLedgerOnly: typeof candidates = [];
    const preservedNotOrphan: typeof candidates = [];
    for (const record of candidates) {
        const classification = classifyStaleDirectForPrune(record, { includeTerminal });
        if (classification === 'preserve_unacknowledged') {
            preservedUnacknowledged.push(record);
            continue;
        }
        if (classification === 'preserve_active') {
            preservedNotOrphan.push(record);
            continue;
        }
        // prunable_orphan | prunable_terminal — only delete store-backed rows; ledger-only remote
        // entries have no store row to delete and are pure audit history.
        if (!storeTaskIds.has(record.taskId)) {
            preservedLedgerOnly.push(record);
            continue;
        }
        prunable.push(record);
    }

    const summarize = (records: typeof candidates) => records.map(r => ({
        taskId: r.taskId,
        nodeId: r.nodeId,
        sessionId: r.sessionId,
        status: r.status,
        terminal: r.terminal === true,
        staleReason: r.staleReason,
        taskTitle: r.taskTitle,
        createdAt: r.createdAt,
    }));

    let prunedCount = 0;
    if (execute && prunable.length) {
        prunedCount = deleteDirectDispatchesByTaskId(ctx.mesh.id, prunable.map(r => r.taskId));
        appendLedgerEntry(ctx.mesh.id, {
            kind: 'direct_dispatch_pruned',
            payload: {
                source: 'mesh_prune_stale_direct',
                prunedCount,
                taskIds: prunable.map(r => r.taskId),
                reasons: Array.from(new Set(prunable.map(r => r.staleReason || (r.terminal ? 'terminal' : 'unknown')))),
            },
        });
    }

    return JSON.stringify({
        success: true,
        mode: execute ? 'execute' : 'dry_run',
        meshId: ctx.mesh.id,
        includeTerminal,
        candidateCount: candidates.length,
        prunableCount: prunable.length,
        prunedCount,
        prunable: summarize(prunable),
        preserved: {
            unacknowledgedCount: preservedUnacknowledged.length,
            ledgerOnlyCount: preservedLedgerOnly.length,
            notOrphanCount: preservedNotOrphan.length,
            unacknowledged: summarize(preservedUnacknowledged),
            ledgerOnly: summarize(preservedLedgerOnly),
            notOrphan: summarize(preservedNotOrphan),
        },
        note: execute
            ? `Pruned ${prunedCount} orphaned direct dispatch record(s) from the active staleDirect surface. The append-only mesh ledger audit history is preserved; a direct_dispatch_pruned entry records this prune.`
            : 'Dry run — nothing was deleted. Re-run with execute=true to prune the listed orphaned records. Fresh unacknowledged dispatch failures (node/session still live) and ledger-only audit entries are always preserved.',
    }, null, 2);
}

export async function meshListNodes(ctx: MeshContext): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const { mesh } = ctx;
    return JSON.stringify({
        meshId: mesh.id,
        meshName: mesh.name,
        nodes: mesh.nodes.map(n => ({
            nodeId: n.id,
            workspace: n.workspace,
            repoRoot: n.repoRoot,
            daemonId: readNodeDaemonId(n),
            machineId: readNodeMachineId(n),
            machine: buildNodeMachineIdentity(ctx, n),
            isLocalWorktree: n.isLocalWorktree,
            policy: n.policy,
            relatedRepos: readRelatedRepos(n),
            ...getNodeLaunchReadiness(n),
            userOverrides: n.userOverrides,
        })),
    }, null, 2);
}

export async function meshMissionUpsert(
    ctx: MeshContext,
    args: { mission_id?: string; missionId?: string; title: string; goal?: string; status?: string },
): Promise<string> {
    try {
        const mission = upsertMeshMission(ctx.mesh.id, {
            id: readString(args.mission_id) || readString(args.missionId) || undefined,
            title: args.title,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
            status: readString(args.status) || undefined,
        });
        return JSON.stringify({
            success: true,
            mission,
            nextAction: 'Attach tasks with mesh_enqueue_task mission_id and depends_on. mesh_status shows live task aggregates for this mission.',
        });
    } catch (e: any) {
        const message = e?.message || String(e);
        const code = message.includes('mission_title_required') ? 'mission_title_required'
            : message.includes('invalid_mission_status') ? 'invalid_mission_status'
            : undefined;
        return JSON.stringify({ success: false, ...(code ? { code } : {}), error: message });
    }
}

export async function meshMissionList(
    ctx: MeshContext,
    args: { status?: string | string[]; verbose?: boolean } = {},
): Promise<string> {
    try {
        const rawStatuses = Array.isArray(args.status)
            ? args.status
            : typeof args.status === 'string' && args.status.trim()
                ? [args.status]
                : [];
        const invalid = rawStatuses.filter(s => !MESH_MISSION_STATUSES.includes(s as any));
        if (invalid.length > 0) {
            return JSON.stringify({
                success: false,
                code: 'invalid_mission_status',
                error: `invalid status filter: ${invalid.join(', ')} (valid: ${MESH_MISSION_STATUSES.join(', ')})`,
            });
        }
        const statuses = rawStatuses.length > 0 ? (rawStatuses as any[]) : undefined;
        const missions = listMeshMissionSummaries(ctx.mesh.id, {
            statuses,
            verbose: args.verbose === true,
        }).map(mission => {
            try {
                return { ...mission, stats: computeMeshMissionStats(ctx.mesh.id, mission.id) };
            } catch {
                return mission;
            }
        });
        return JSON.stringify({
            success: true,
            count: missions.length,
            ...(statuses ? { statusFilter: statuses } : {}),
            missions,
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}

export async function meshEnqueueTask(
    ctx: MeshContext,
    args: {
        message: string; task_mode?: string; taskMode?: string;
        requiredTags?: string[]; required_tags?: string[];
        targetNodeId?: string; target_node_id?: string;
        preferWorktree?: boolean; prefer_worktree?: boolean;
        dependsOn?: string[]; depends_on?: string[];
        missionId?: string; mission_id?: string;
    },
): Promise<string> {
    const taskMode = readString(args.task_mode) || readString(args.taskMode);
    const requiredTags = normalizeMeshCapabilityTags(Array.isArray(args.requiredTags) ? args.requiredTags : args.required_tags);
    const dependsOn = Array.isArray(args.dependsOn) ? args.dependsOn : Array.isArray(args.depends_on) ? args.depends_on : undefined;
    const missionId = readString(args.missionId) || readString(args.mission_id) || undefined;
    // Routing hint: explicit target_node_id wins; otherwise prefer_worktree
    // resolves to the most recently cloned worktree node so isolated work is not
    // preemptively claimed by the first idle base node. Either becomes a
    // targetNodeId, which the node-targeted claim tier honors.
    const explicitTarget = readString(args.targetNodeId) || readString(args.target_node_id) || undefined;
    const preferWorktree = args.preferWorktree === true || args.prefer_worktree === true;
    const targetNodeId = explicitTarget
        || (preferWorktree ? resolvePreferredWorktreeNodeId(ctx) : undefined);
    try {
        const task = enqueueTask(ctx.mesh.id, args.message, { taskMode, requiredTags, dependsOn, missionId, targetNodeId });

        // ── LocalTransport: queue-based pull (standalone daemon, all local) ─────
        if (!(ctx.transport instanceof IpcTransport)) {
            const queueTrigger = await triggerMeshQueueAndReport(ctx);
            return JSON.stringify({
                success: true,
                source: 'queue',
                taskId: task.id,
                status: task.status,
                taskMode: task.taskMode,
                requiredTags: task.requiredTags,
                ...(targetNodeId ? { targetNodeId } : {}),
                ...(preferWorktree && !explicitTarget && !targetNodeId ? { preferWorktreeNoOp: true } : {}),
                queueTrigger,
                ...buildQueueTriggerGuidance(queueTrigger),
            });
        }

        // ── IpcTransport (Cloud Mesh): the queue file lives on THIS machine only.
        //    Remote daemons on other machines cannot read the local queue file.
        //    Strategy: trigger local queue for local nodes, and for remote nodes
        //    directly P2P-dispatch to the first idle session found (enqueue-and-push).
        {
            // 1. Trigger local queue for local node pick-up
            const queueTrigger = await triggerMeshQueueAndReport(ctx);

            // 2. For each remote node, directly dispatch to an idle session via P2P
            const dispatchPromises: Promise<void>[] = [];
            for (const node of ctx.mesh.nodes) {
                const isLocalNode = isLocalControlPlaneNode(ctx, node);
                if (isLocalNode || !node.daemonId) continue;
                // When the task targets a specific node, only that node's daemon
                // should receive the P2P push; others would steal the work.
                if (targetNodeId && node.id !== targetNodeId) continue;
                if (!nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(node))) continue;

                dispatchPromises.push(
                    ipcDispatchToRemoteAgent(ctx, node, { message: args.message })
                        .then(result => {
                            if (result.success) {
                                try {
                                    const providerType = result.providerType;
                                    const descriptor = summarizeTaskMessage(args.message);
                                    appendLedgerEntry(ctx.mesh.id, {
                                        kind: 'task_dispatched',
                                        nodeId: node.id,
                                        sessionId: result.sessionId,
                                        providerType,
                                        payload: {
                                            source: 'queue',
                                            via: 'p2p_direct',
                                            taskId: task.id,
                                            message: args.message,
                                            taskTitle: descriptor.taskTitle,
                                            taskSummary: descriptor.taskSummary,
                                            ...(task.taskMode ? { taskMode: task.taskMode } : {}),
                                            ...(providerType ? { providerType } : {}),
                                            targetSessionId: result.sessionId,
                                        },
                                    });
                                } catch { /* best-effort */ }
                            }
                        })
                        .catch((err: any) => {
                            try {
                                appendLedgerEntry(ctx.mesh.id, {
                                    kind: 'p2p_dispatch_failed',
                                    nodeId: node.id,
                                    payload: {
                                        source: 'queue',
                                        via: 'p2p_direct',
                                        taskId: task.id,
                                        error: err?.message || String(err),
                                        dispatchFailedAt: new Date().toISOString(),
                                    },
                                });
                            } catch { /* best-effort */ }
                        }),
                );
            }
            // Fire-and-forget — don't block the coordinator response
            Promise.all(dispatchPromises).catch(() => {});

            return JSON.stringify({
                success: true,
                source: 'queue',
                taskId: task.id,
                status: task.status,
                taskMode: task.taskMode,
                requiredTags: task.requiredTags,
                ...(targetNodeId ? { targetNodeId } : {}),
                ...(preferWorktree && !explicitTarget && !targetNodeId ? { preferWorktreeNoOp: true } : {}),
                queueTrigger,
                ...buildQueueTriggerGuidance(queueTrigger),
            });
        }
    } catch (e: any) {
        const message = e?.message || String(e);
        if (message.includes('live_debug_readonly_guardrail_violation')) {
            return JSON.stringify({ success: false, code: 'live_debug_readonly_guardrail_violation', taskMode, error: message });
        }
        if (message.includes('dependency_cycle_detected')) {
            return JSON.stringify({ success: false, code: 'dependency_cycle_detected', dependsOn, error: message });
        }
        return JSON.stringify({ success: false, error: message });
    }
}

export async function meshViewQueue(
    ctx: MeshContext,
    args: { status?: string[]; view?: QueueViewMode; compact?: boolean; verbose?: boolean },
): Promise<string> {
    const rateResult = recordMeshToolCall({ meshId: ctx.mesh.id, tool: 'mesh_view_queue' });
    // Default to the slim payload for LLM callers; verbose forces the full payload.
    const compact = args.verbose === true ? false : (args.compact ?? true);
    try {
        await refreshMeshFromDaemon(ctx);
        const statusFilter = sanitizeQueueStatusFilter(args.status);
        const view = normalizeQueueViewMode(args.view);
        const rawQueue = getQueue(ctx.mesh.id);
        // M1: annotate dependency state (waitingOn, dependenciesSatisfied) at view time.
        const statusById = new Map(rawQueue.map(task => [task.id, task.status]));
        const withDependencies = rawQueue.map(task => {
            if (!Array.isArray(task.dependsOn) || task.dependsOn.length === 0) return task;
            const depState = describeTaskDependencyState(task, statusById);
            return { ...task, ...depState };
        });
        const fullQueue = prioritizeActiveQueueRows(annotateQueueStaleness(withDependencies, ctx.mesh));
        const queue = filterQueueForView(fullQueue, view, statusFilter);
        const summary = buildQueueStatusSummary(fullQueue);
        const visibleSummary = buildQueueStatusSummary(queue);
        const maintenance = buildQueueMaintenanceReport(fullQueue);
        const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
        let ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
        let directDispatches = getActiveDirectDispatches(ctx.mesh.id);
        const directReconciliation = await reconcileDirectDispatchesFromTranscriptEvidence(ctx, liveNodes, directDispatches, ledgerEntries);
        if (directReconciliation.reconciled > 0) {
            ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
            directDispatches = getActiveDirectDispatches(ctx.mesh.id);
        }
        // Mark dispatched entries with no session activity after 30 min as stale.
        markStaleDirectDispatches(ctx.mesh.id);
        directDispatches = getActiveDirectDispatches(ctx.mesh.id);
        const activeWorkEvidence = buildMeshActiveWork({
            meshId: ctx.mesh.id,
            queue: fullQueue,
            ledgerEntries,
            // Always pass MeshRuntimeStore records (may be empty). buildMeshActiveWork uses them for local
            // dispatches and falls through to ledger scan for remote P2P dispatches not in MeshRuntimeStore.
            directDispatches,
            nodes: liveNodes,
        });
        const recentDispatchFailures = ledgerEntries
            .filter(e => e.kind === 'p2p_dispatch_failed')
            .slice(-20)
            .map(e => ({
                nodeId: e.nodeId,
                taskId: e.payload?.taskId,
                error: e.payload?.error,
                via: e.payload?.via,
                failedAt: e.payload?.dispatchFailedAt || e.timestamp,
            }));
        const staleAssignedTasks = (maintenance as any).staleAssignedTasks || [];
        const requestedHistoricalRows = queue.some((task: any) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
        const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);

        // Compact mode: completed/failed/cancelled historical row arrays are the main
        // payload bloat (mesh_view_queue has overflowed 250k chars on busy meshes).
        // Drop them in favor of the status counts that summary/visibleSummary already
        // carry, but keep pending/assigned active rows — those drive coordinator
        // dispatch decisions. verbose=true returns every row as before.
        const activeOnlyQueue = queue.filter((task: any) => !HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
        // Compact mode: cap active rows and truncate per-row messages (a busy mesh
        // can carry dozens of multi-KB task messages → 70KB+ in the active array).
        const compactQueueResult = compact ? compactQueueRows(activeOnlyQueue) : { rows: activeOnlyQueue, omitted: 0 };
        const visibleQueue = compact ? compactQueueResult.rows : queue;
        const wantActiveQueueArray = view === 'active' || statusFilter?.some(status => ACTIVE_QUEUE_STATUSES.has(status));
        const wantHistoricalQueueArray = !compact && (view === 'historical' || requestedHistoricalRows);
        // activeWork carries the full task message/summary per record — the single
        // largest payload source on a busy mesh. Slim + cap it in compact mode.
        const activeWorkResult = compact
            ? compactActiveWorkRecords(activeWorkEvidence.activeWork)
            : { records: activeWorkEvidence.activeWork, omitted: 0 };

        // staleDirectWork is a full MeshActiveWorkRecord[] of orphaned/historical
        // direct dispatches — it is the second major payload-bloat source (the first
        // being historical queue rows). In compact mode, collapse it to the same
        // bounded summary mesh_status uses and only emit the full array in verbose mode.
        const staleDirectWorkSummary = buildCompactStaleDirectWorkSummary(activeWorkEvidence.staleDirectWork, {
            note: activeWorkEvidence.staleDirectWorkNote,
            detailHint: 'Full stale direct entries are omitted from mesh_view_queue in compact mode. Call mesh_view_queue with verbose=true, or inspect mesh_task_history for ledger detail.',
        });
        // queueMaintenance/cleanupDryRun serialize the same maintenance object whose
        // cleanupCandidates array scales with old historical record count. In compact
        // mode drop the per-row arrays in favor of counts.
        const maintenanceForResponse = compact ? buildCompactQueueMaintenanceReport(maintenance) : maintenance;

        return JSON.stringify({
            success: true,
            payloadMode: compact ? 'compact' : 'full',
            sourceOfTruth: {
                kind: 'mesh_work_queue_file',
                activeStatuses: ['pending', 'assigned'],
                historicalStatuses: ['completed', 'failed', 'cancelled'],
                notes: 'pending/assigned are active work; completed/failed/cancelled are historical ledger records and never stale assignments.',
            },
            filter: {
                view,
                statuses: statusFilter,
                filtered: Boolean(statusFilter?.length) || view !== 'all',
            },
            queue: visibleQueue,
            ...(compact ? { historicalRowsOmitted: true, historicalRowsHint: 'Completed/failed/cancelled rows are omitted in compact mode; see historicalCounts. Call mesh_view_queue with verbose=true (or view=historical, compact=false) for full rows.' } : {}),
            ...(compact && compactQueueResult.omitted > 0 ? {
                activeRowsOmitted: compactQueueResult.omitted,
                activeRowsHint: `Showing the first ${COMPACT_MAX_ACTIVE_QUEUE_ROWS} active rows (per-row messages truncated). ${compactQueueResult.omitted} more active row(s) omitted — see activeCount/activeCounts for the complete total or use verbose=true.`,
            } : {}),
            activeWork: activeWorkResult.records,
            ...(compact && activeWorkResult.omitted > 0 ? {
                activeWorkOmitted: activeWorkResult.omitted,
                activeWorkHint: `Showing the first ${COMPACT_MAX_ACTIVE_WORK_ROWS} active-work records (messages truncated). ${activeWorkResult.omitted} more omitted — see activeWorkSummary for complete counts or use verbose=true.`,
            } : {}),
            staleDirectWorkSummary,
            ...(compact ? {} : { staleDirectWork: activeWorkEvidence.staleDirectWork }),
            activeWorkSummary: activeWorkEvidence.summary,
            ...(pollingGuidance ? { pollingGuidance } : {}),
            ...(rateResult.rateLimitExceeded ? { pollingRateAdvisory: { type: 'rate_limit_exceeded', tool: 'mesh_view_queue', callsInWindow: rateResult.callsInWindow, message: rateResult.advisory } } : {}),
            summary,
            visibleSummary,
            activeCounts: summary.activeCounts,
            historicalCounts: summary.historicalCounts,
            visibleActiveCounts: visibleSummary.activeCounts,
            visibleHistoricalCounts: visibleSummary.historicalCounts,
            activeCount: summary.activeCount,
            historicalCount: summary.historicalCount,
            visibleActiveCount: visibleSummary.activeCount,
            visibleHistoricalCount: visibleSummary.historicalCount,
            staleAssignedTasks: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
            staleAssignedCount: (maintenance as any).staleAssignedCount,
            queueMaintenance: maintenanceForResponse,
            cleanupDryRun: maintenanceForResponse,
            ...(recentDispatchFailures.length > 0 ? {
                recentDispatchFailures,
                dispatchFailureCount: recentDispatchFailures.length,
                dispatchFailureNote: 'Remote P2P dispatch attempts that failed. Affected tasks remain pending and may require mesh_queue_requeue if no idle session picks them up.',
            } : {}),
            ...(wantActiveQueueArray && !compact ? {
                activeQueue: queue.filter((task: any) => ACTIVE_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            // In compact mode the `queue` field already holds exactly the slimmed+
            // capped active rows, so the separate activeQueue array would be a verbatim
            // duplicate (it doubled the payload). Point callers at `queue` instead.
            ...(wantActiveQueueArray && compact ? { activeQueueHint: 'In compact mode the active rows are in `queue` (already filtered to pending/assigned). Use verbose=true for the separate full activeQueue array.' } : {}),
            ...(wantHistoricalQueueArray ? {
                historicalQueue: queue.filter((task: any) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            // Back-compat alias for callers already reading the first hardening payload.
            staleAssignments: compact ? staleAssignedTasks.slice(0, 10).map(compactQueueRow) : staleAssignedTasks,
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueCancel(
    ctx: MeshContext,
    args: { task_id?: string; taskId?: string; reason?: string },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });
        const task = cancelTask(ctx.mesh.id, taskId, { reason: args.reason });
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        return JSON.stringify({ success: true, task }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshQueueRequeue(
    ctx: MeshContext,
    args: {
        task_id?: string;
        taskId?: string;
        reason?: string;
        target_node_id?: string;
        targetNodeId?: string;
        target_session_id?: string;
        targetSessionId?: string;
        clear_target_node?: boolean;
        clearTargetNode?: boolean;
        keep_target_session?: boolean;
        keepTargetSession?: boolean;
        force?: boolean;
    },
): Promise<string> {
    try {
        const taskId = (args.task_id || args.taskId || '').trim();
        if (!taskId) return JSON.stringify({ success: false, error: 'task_id required' });
        const targetNodeId = (args.target_node_id || args.targetNodeId || '').trim() || undefined;
        const targetSessionId = (args.target_session_id || args.targetSessionId || '').trim() || undefined;
        const keepTargetSession = args.keep_target_session === true || args.keepTargetSession === true;
        const task = requeueTask(ctx.mesh.id, taskId, {
            reason: args.reason,
            targetNodeId,
            targetSessionId,
            clearTargetNode: args.clear_target_node === true || args.clearTargetNode === true,
            clearTargetSession: targetSessionId ? false : !keepTargetSession,
            force: args.force === true,
        });
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        if (task.status === 'failed' && task.cancelReason?.startsWith('max_retries_exceeded')) {
            return JSON.stringify({
                success: false,
                code: 'max_retries_exceeded',
                error: task.cancelReason,
                task,
                hint: 'Use force=true to bypass the retry cap for explicit operator recovery.',
            }, null, 2);
        }
        ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        return JSON.stringify({ success: true, task }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshSendTask(
    ctx: MeshContext,
    args: {
        node_id: string; session_id?: string; message: string;
        task_mode?: string; taskMode?: string;
        mission_id?: string; missionId?: string;
    },
): Promise<string> {
    const requestedTaskMode = readString(args.task_mode) || readString(args.taskMode);
    // Optional mission attribution. When set, the direct-dispatched task is also
    // materialised as an assigned queue entry so it counts toward the mission's
    // task aggregates — see recordDirectDispatchTask. Absent → unattributed
    // direct dispatch as before (backward compatible).
    const missionId = readString(args.missionId) || readString(args.mission_id) || undefined;
    const modeValidation = validateMeshTaskModeRequest(requestedTaskMode, args.message);
    if (!modeValidation.valid) {
        return JSON.stringify({
            success: false,
            code: 'live_debug_readonly_guardrail_violation',
            taskMode: modeValidation.taskMode || requestedTaskMode,
            violations: modeValidation.violations,
            allowedOperations: modeValidation.allowedOperations,
            error: `live_debug_readonly_guardrail_violation: forbidden operations (${modeValidation.violations.join(', ')})`,
        });
    }
    const taskMode = modeValidation.taskMode;
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Policy check: read-only node cannot receive tasks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only` });
    }

    let explicitTargetSession: any | undefined;
    if (args.session_id && isWorkerTaskMode(taskMode)) {
        try {
            const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
            const sessions = extractStatusMetadataSessions(statusResult);
            explicitTargetSession = sessions.find(session => readSessionRecordId(session) === args.session_id);
            if (explicitTargetSession && isMeshCoordinatorSessionRecord(explicitTargetSession)) {
                return JSON.stringify({
                    success: false,
                    recoverable: true,
                    code: 'mesh_target_session_is_coordinator',
                    reason: 'mesh_target_session_is_coordinator',
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    taskMode: taskMode || 'unspecified',
                    error: `Session '${args.session_id}' is a Repo Mesh coordinator session, not a visible worker session. Launch or use a visible worker session before dispatching this task.`,
                    nextAction: `Call mesh_launch_session for node '${args.node_id}' and then retry mesh_send_task with that worker session_id, or use mesh_enqueue_task for queue-based worker assignment.`,
                });
            }
            if (explicitTargetSession && isUnmanagedSessionRecord(explicitTargetSession)) {
                // Session exists but lacks mesh delegation metadata (no meshNodeFor,
                // meshCoordinatorFor, or launchedByCoordinator). It could be:
                //   - The coordinator's own session → self-send risk
                //   - A manually launched session not associated with this mesh
                // Completion events from this session would not reach the coordinator
                // ledger. Surface a hard warning but still record the dispatch attempt
                // in the result so the coordinator can decide whether to proceed.
                //
                // Note: if the session happens to have meshCoordinatorFor set, the check
                // above would have already returned mesh_target_session_is_coordinator.
                // This warning fires only for truly unmanaged sessions.
                return JSON.stringify({
                    success: false,
                    recoverable: true,
                    code: 'mesh_target_session_unmanaged',
                    reason: 'mesh_target_session_unmanaged',
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    taskMode: taskMode || 'unspecified',
                    unsafeTranscriptAlias: true,
                    error: `Session '${args.session_id}' on node '${args.node_id}' has no Repo Mesh delegation metadata (missing meshNodeFor/meshCoordinatorFor/launchedByCoordinator). It may be the coordinator's own session or an unrelated session — dispatching risks self-send and orphaned completion events that never reach the coordinator ledger.`,
                    nextAction: `Call mesh_launch_session for node '${args.node_id}' to start a fresh managed worker session, then retry mesh_send_task with the returned session_id. Alternatively use mesh_enqueue_task for queue-based assignment without specifying session_id.`,
                });
            }
        } catch {
            explicitTargetSession = undefined;
        }
    }

    // Avoid duplicate side effects when an MCP/tool call is interrupted after
    // the daemon already accepted the send and the coordinator retries the
    // exact same node/session/message immediately.
    const duplicate = hasRecentDuplicateDispatch(ctx, args);
    if (duplicate.duplicate) {
        return JSON.stringify({
            success: true,
            duplicate: true,
            dispatched: false,
            warning: 'Duplicate mesh_send_task suppressed: the same node/session/message was dispatched recently.',
            nodeId: args.node_id,
            sessionId: args.session_id,
            source: duplicate.source,
            previousDispatch: duplicate.entry ? {
                id: duplicate.entry.id,
                timestamp: duplicate.entry.timestamp || duplicate.entry.updatedAt || duplicate.entry.createdAt,
                nodeId: duplicate.entry.nodeId || duplicate.entry.targetNodeId || duplicate.entry.assignedNodeId,
                sessionId: duplicate.entry.sessionId || duplicate.entry.targetSessionId || duplicate.entry.assignedSessionId,
            } : undefined,
        });
    }

    try {
        // ── IpcTransport + remote node: direct P2P agent_command dispatch ──────
        //
        // The local queue file (mesh-ledger/*.queue.json) is stored on THIS
        // machine and is inaccessible to the remote daemon.  Sending
        // trigger_mesh_queue to the remote daemon would always be a no-op
        // because it cannot read the queue.  Instead we relay agent_command
        // directly over P2P so the remote daemon forwards it to its agent.
        const isLocalNode = isLocalControlPlaneNode(ctx, node);
        if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
            const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id || ''));
            const taskId = randomUUID();
            const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
            const result = await ipcDispatchToRemoteAgent(ctx, node, {
                session_id: args.session_id,
                message: args.message,
                providerType: cached?.providerType,
                verifiedSession: explicitTargetSession,
                meshContext: {
                    meshId: ctx.mesh.id,
                    nodeId: args.node_id,
                    taskId,
                    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                },
            });
            if (result.success) {
                // Record dispatch in ledger so task_history is accurate
                const dispatchedSessionId = args.session_id || result.sessionId;
                const dispatchedAt = new Date().toISOString();
                try {
                    const providerType = result.providerType || cached?.providerType;
                    appendLedgerEntry(ctx.mesh.id, {
                        kind: 'task_dispatched',
                        nodeId: args.node_id,
                        sessionId: dispatchedSessionId,
                        providerType,
                        payload: buildDirectTaskPayload(args.message, 'p2p_direct', {
                            taskId,
                            taskMode,
                            providerType,
                            targetSessionId: dispatchedSessionId,
                        }),
                    });
                    insertDirectDispatch(ctx.mesh.id, {
                        taskId,
                        nodeId: args.node_id,
                        sessionId: dispatchedSessionId,
                        providerType: providerType || undefined,
                        message: args.message,
                        taskMode: taskMode || undefined,
                        via: 'p2p_direct',
                        dispatchedAt,
                    });
                    if (missionId) {
                        recordDirectDispatchTask(ctx.mesh.id, args.message, {
                            id: taskId,
                            missionId,
                            assignedNodeId: args.node_id,
                            assignedSessionId: dispatchedSessionId,
                            taskMode,
                            dispatchedAt,
                        });
                    }
                } catch { /* best-effort */ }
            }
            return JSON.stringify({
                ...result,
                nodeId: args.node_id,
                sessionId: result.success ? (args.session_id || result.sessionId) : args.session_id,
                ...(result.success ? { source: 'direct', taskId } : {}),
                taskMode,
                ...(result.success && result.providerType ? { providerType: result.providerType } : {}),
                dispatched: result.success === true,
            });
        }

        // ── LocalTransport or local IpcTransport node ────────────────────────
        // If the coordinator explicitly targets a runtime session, push directly
        // and surface route failures immediately instead of creating a queue item
        // that can remain pending forever when the session was already stopped.
        if (args.session_id) {
            const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
            let resolvedProviderType = cached?.providerType || '';
            if (!resolvedProviderType) {
                let explicitSession = explicitTargetSession;
                if (!explicitSession) {
                    const statusResult = await commandForNode(ctx, node, 'get_status_metadata', {});
                    const sessions = extractStatusMetadataSessions(statusResult);
                    explicitSession = sessions.find(session => readSessionRecordId(session) === args.session_id);
                }
                if (!explicitSession) {
                    return JSON.stringify({
                        success: false,
                        recoverable: true,
                        code: 'mesh_target_session_not_found',
                        reason: 'mesh_target_session_not_found',
                        transport: 'local_ipc',
                        retryRecommended: true,
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        error: `Local session '${args.session_id}' is not present in live status for node '${args.node_id}'.`,
                        nextAction: `Launch a fresh session with mesh_launch_session(node_id: '${args.node_id}') or retry without session_id so Repo Mesh can target a live delegate session.`,
                    });
                }
                // The early validation block only runs for isWorkerTaskMode (excludes
                // live_debug_readonly). Apply the same coordinator/unmanaged checks here
                // for sessions resolved in this path so no task mode bypasses them.
                if (isMeshCoordinatorSessionRecord(explicitSession)) {
                    return JSON.stringify({
                        success: false,
                        recoverable: true,
                        code: 'mesh_target_session_is_coordinator',
                        reason: 'mesh_target_session_is_coordinator',
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        taskMode: taskMode || 'unspecified',
                        error: `Session '${args.session_id}' is a Repo Mesh coordinator session, not a visible worker session. Launch or use a visible worker session before dispatching this task.`,
                        nextAction: `Call mesh_launch_session for node '${args.node_id}' and then retry mesh_send_task with that worker session_id, or use mesh_enqueue_task for queue-based worker assignment.`,
                    });
                }
                if (isUnmanagedSessionRecord(explicitSession)) {
                    return JSON.stringify({
                        success: false,
                        recoverable: true,
                        code: 'mesh_target_session_unmanaged',
                        reason: 'mesh_target_session_unmanaged',
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        taskMode: taskMode || 'unspecified',
                        unsafeTranscriptAlias: true,
                        unsafeDelegateTarget: true,
                        error: `Session '${args.session_id}' on node '${args.node_id}' has no Repo Mesh delegation metadata (missing meshNodeFor/meshCoordinatorFor/launchedByCoordinator). It may be the coordinator's own session or an unrelated session — dispatching risks self-send and orphaned completion events that never reach the coordinator ledger.`,
                        nextAction: `Call mesh_launch_session for node '${args.node_id}' to start a fresh managed worker session, then retry mesh_send_task with the returned session_id. Alternatively use mesh_enqueue_task for queue-based assignment without specifying session_id.`,
                    });
                }
                resolvedProviderType = resolveSessionProviderType(explicitSession);
                if (resolvedProviderType) {
                    meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, args.session_id), {
                        providerType: resolvedProviderType,
                        providerSessionId: readString(explicitSession?.providerSessionId) || undefined,
                        expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
                    });
                }
            }
            if (!resolvedProviderType) {
                return JSON.stringify({
                    success: false,
                    recoverable: true,
                    code: 'mesh_target_session_provider_unknown',
                    reason: 'mesh_target_session_provider_unknown',
                    transport: 'local_ipc',
                    retryRecommended: false,
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    error: `Local session '${args.session_id}' is live but does not expose providerType/cliType, so agent_command cannot be routed safely.`,
                    nextAction: `Relaunch the target session on node '${args.node_id}' or retry without session_id so Repo Mesh can pick a session with provider metadata.`,
                });
            }
            // Apply delivery policy: check session status and decide immediate vs queued vs rejected.
            // Busy/generating sessions must not receive immediate send_chat injection.
            if (explicitTargetSession && !isIdleSessionRecord(explicitTargetSession) && !isTerminalSessionRecord(explicitTargetSession)) {
                const sessionStatus = typeof explicitTargetSession?.status === 'string' ? explicitTargetSession.status : 'unknown';
                const { createSessionDelivery: createDelivery, resolveDeliveryDecision } = await import('@adhdev/daemon-core');
                const policyResult = resolveDeliveryDecision(sessionStatus, { kind: 'task' });
                if (policyResult.decision === 'queued') {
                    const delivery = createDelivery({
                        meshId: ctx.mesh.id,
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        providerType: resolvedProviderType,
                        kind: 'task',
                        message: args.message,
                        status: 'queued',
                    });
                    return JSON.stringify({
                        success: true,
                        dispatched: false,
                        decision: 'queued_delivery',
                        deliveryId: delivery.id,
                        reason: policyResult.reason,
                        nodeId: args.node_id,
                        sessionId: args.session_id,
                        sessionStatus,
                        taskMode: taskMode || undefined,
                        message: policyResult.message,
                        nextAction: `Use mesh_status to watch for session idle transition, or use mesh_enqueue_task for queue-based assignment. Check deliveryId '${delivery.id}' to track queued delivery.`,
                    });
                }
            }

            // Detect whether the session was idle at dispatch time. An idle session that
            // receives agent_command/send_chat should transition to generating. If it stays
            // idle, the dispatch was not acknowledged. Record this for stale detection and
            // surface it as a dispatchAcknowledgementRisk warning in the success response.
            const sessionWasIdle = explicitTargetSession
                ? isIdleSessionRecord(explicitTargetSession)
                : false;
            const taskId = randomUUID();
            const dispatchedAt = new Date().toISOString();
            const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
            // Stamp the mesh assignment via meshContext so the daemon can
            // attach it to the target instance BEFORE prompt injection.
            // setupMeshEventForwarding reads state.settings.meshNodeFor +
            // meshActiveTaskId to route completion events back. Without
            // this, plain CLI sessions targeted by mesh_send_task --direct
            // would silently drop generating_completed and the coordinator
            // would never observe task_completed.
            // coordinatorDaemonId is required so the completion event is
            // routed to the correct coordinator pendingCoordinatorEvents queue.
            const dispatchResult = await commandForNode(ctx, node, 'agent_command', {
                targetSessionId: args.session_id,
                agentType: resolvedProviderType,
                cliType: resolvedProviderType,
                providerType: resolvedProviderType,
                action: 'send_chat',
                message: args.message,
                meshContext: {
                    meshId: ctx.mesh.id,
                    nodeId: args.node_id,
                    taskId,
                    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                },
            });
            const dispatchPayload = unwrapCommandPayload(dispatchResult);
            if (dispatchPayload?.success === false || dispatchResult?.success === false) {
                const source = dispatchPayload?.success === false ? dispatchPayload : dispatchResult;
                return JSON.stringify({
                    ...(source && typeof source === 'object' ? source : {}),
                    success: false,
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    error: dispatchPayload?.error || dispatchResult?.error || 'agent_command rejected the task',
                });
            }
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'task_dispatched',
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    providerType: resolvedProviderType,
                    payload: buildDirectTaskPayload(args.message, 'local_direct', {
                        taskId,
                        taskMode,
                        providerType: resolvedProviderType,
                        targetSessionId: args.session_id,
                        dispatchedToIdleSession: sessionWasIdle,
                    }),
                });
            } catch { /* best-effort */ }
            insertDirectDispatch(ctx.mesh.id, {
                taskId,
                nodeId: args.node_id,
                sessionId: args.session_id,
                providerType: resolvedProviderType || undefined,
                message: args.message,
                taskMode: taskMode || undefined,
                via: 'local_direct',
                dispatchedToIdleSession: sessionWasIdle,
                dispatchedAt,
            });
            if (missionId) {
                try {
                    recordDirectDispatchTask(ctx.mesh.id, args.message, {
                        id: taskId,
                        missionId,
                        assignedNodeId: args.node_id,
                        assignedSessionId: args.session_id,
                        taskMode,
                        dispatchedAt,
                    });
                } catch { /* best-effort */ }
            }
            // Create a delivery record for session-level ACK tracking
            let deliveryId: string | undefined;
            try {
                const { createSessionDelivery: createDelivery } = await import('@adhdev/daemon-core');
                const delivery = createDelivery({
                    meshId: ctx.mesh.id,
                    nodeId: args.node_id,
                    sessionId: args.session_id,
                    providerType: resolvedProviderType || undefined,
                    taskId,
                    kind: 'task',
                    message: args.message,
                    status: sessionWasIdle ? 'delivered' : 'delivering',
                });
                deliveryId = delivery.id;
            } catch { /* best-effort */ }
            return JSON.stringify({
                success: true,
                dispatched: true,
                decision: 'immediate',
                source: 'direct',
                taskId,
                deliveryId,
                taskMode,
                providerType: resolvedProviderType,
                nodeId: args.node_id,
                sessionId: args.session_id,
                ...(sessionWasIdle ? {
                    dispatchAcknowledgementRisk: true,
                    dispatchAcknowledgementRiskReason: 'session_was_idle_at_dispatch',
                    dispatchAcknowledgementNote: `Session '${args.session_id}' was idle at dispatch time. If it does not transition to generating, this direct task was not acknowledged. Use mesh_status to verify; if the session remains idle, it may appear as stale direct work — launch a fresh session and retry.`,
                } : {}),
            });
        }

        // ── Untargeted local task: use queue pull ─────────────────────────────
        const task = enqueueTask(ctx.mesh.id, args.message, {
            targetNodeId: args.node_id,
            targetSessionId: args.session_id,
            taskMode,
            ...(missionId ? { missionId } : {}),
        });

        const queueTrigger = await triggerMeshQueueAndReport(ctx);

        // Also drain any pending coordinator events so the caller sees them inline
        const pendingEvents = drainPendingMeshCoordinatorEvents(ctx.mesh.id, ctx.localDaemonId);

        const result: Record<string, unknown> = {
            success: true,
            source: 'queue',
            nodeId: args.node_id,
            taskId: task.id,
            status: task.status,
            taskMode: task.taskMode,
            queueTrigger,
            ...buildQueueTriggerGuidance(queueTrigger),
        };
        if (pendingEvents.length > 0) {
            result.pendingCoordinatorEvents = pendingEvents;
        }
        return JSON.stringify(result);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'mesh_send_task',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
            sessionId: args.session_id,
        });
        return JSON.stringify(failure);
    }
}

export async function meshReadChat(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; compact?: boolean },
): Promise<string> {
    const node = await findOptionalNodeWithRefresh(ctx, args.node_id);
    if (!node) {
        return JSON.stringify(buildMissingNodeReadChatRecovery(ctx, args), null, 2);
    }

    await drainCoordinatorPendingEvents(ctx, { nodeIds: [args.node_id] });

    const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
        ? args.provider_session_id.trim()
        : cached?.providerSessionId;
    const result = await commandForNode(ctx, node, 'read_chat', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        tailLimit: args.tail ?? 10,
    });
    const payload = annotateRapidReadChatAdvisory(unwrapCommandPayload(result) as Record<string, any>, {
        key: `mesh:${args.node_id}:${args.session_id}`,
        toolName: 'mesh_read_chat',
        completionCallbackExpected: true,
    });
    // Default compact=true to keep coordinator context lean.
    // Pass compact=false explicitly only when full transcript detail is needed for debugging.
    const useCompact = args.compact !== false;
    if (useCompact) {
        const compactPayload = compactChatPayload(payload, {
            nodeId: args.node_id,
            sessionId: args.session_id,
            limit: args.tail ?? 10,
        });
        return JSON.stringify(
            payload.pollingAdvisory ? { ...compactPayload, pollingAdvisory: payload.pollingAdvisory } : compactPayload,
            null,
            2,
        );
    }
    return JSON.stringify(payload, null, 2);
}

export async function meshReadDebug(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; delivery?: 'daemon_file' | 'inline' },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const cached = resolveMeshSessionProviderMetadata(ctx, args.node_id, args.session_id);
    const providerSessionId = typeof args.provider_session_id === 'string' && args.provider_session_id.trim()
        ? args.provider_session_id.trim()
        : cached?.providerSessionId;
    const delivery = args.delivery === 'inline' ? undefined : 'daemon_file';
    const result = await commandForNode(ctx, node, 'get_chat_debug_bundle', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        tailLimit: args.tail ?? 40,
        ...(delivery ? { delivery } : {}),
    });
    const payload = unwrapCommandPayload(result);
    return JSON.stringify(payload, null, 2);
}

export async function meshLaunchSession(
    ctx: MeshContext,
    args: { node_id: string; type?: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const bootstrapBlock = getWorktreeBootstrapLaunchBlock(node, ctx.mesh.policy);
    if (bootstrapBlock) return JSON.stringify(bootstrapBlock, null, 2);

    {
        let resolvedProviderType = typeof args.type === 'string' && args.type.trim() ? args.type : '';
        if (!resolvedProviderType) {
            const providerPriority = readProviderPriority(node.policy);
            if (!providerPriority.length) {
                return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
            }

            const failed: string[] = [];
            for (const providerType of providerPriority) {
                const detectedResult = await commandForNode(ctx, node, 'detect_provider', { providerType });
                const detectedPayload = unwrapCommandPayload(detectedResult);
                if (detectedPayload?.success && detectedPayload?.detected) {
                    resolvedProviderType = providerType;
                    break;
                }
                failed.push(`${providerType}: ${detectedPayload?.error || 'not detected'}`);
            }
            if (!resolvedProviderType) {
                return JSON.stringify({ success: false, error: `No usable provider detected for node '${args.node_id}' from providerPriority: ${failed.join('; ')}` });
            }
        }

        const coordinatorNode = resolveCoordinatorNode(ctx);
        const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
        const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
        // Worker sessions are coordinator-dispatched; a human shouldn't have to approve
        // each one. Resolve the auto-approve policy (node override → mesh policy → default
        // true) and stamp it into the launch settings envelope so it wins over the global
        // per-provider-type autoApprove config via the settingsOverride merge.
        const delegatedWorkerAutoApprove = resolveDelegatedWorkerAutoApprove(ctx.mesh.policy, node.policy);
        const isLocalNode = isLocalControlPlaneNode(ctx, node);
        if (node.daemonId && !isLocalNode && !coordinatorDaemonId) {
            return JSON.stringify(buildMissingCoordinatorDaemonIdFailure(ctx, node, resolvedProviderType), null, 2);
        }
        let result: any;
        try {
            result = await commandForNode(ctx, node, 'launch_cli', {
                cliType: resolvedProviderType,
                dir: node.workspace,
                settings: {
                    // Worker launch envelope (A5): structured metadata so worker sessions
                    // know their role and can route completion events back correctly.
                    role: 'worker',
                    meshNodeFor: ctx.mesh.id,
                    meshNodeId: args.node_id,
                    spawnedSessionVisibility,
                    // Delegated worker auto-approval (see resolveDelegatedWorkerAutoApprove).
                    // Lands in settingsOverride and beats the global per-provider autoApprove.
                    autoApprove: delegatedWorkerAutoApprove,
                    ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
                    ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                    launchedByCoordinator: true,
                }
            });
        } catch (e: any) {
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
        }
        const launchPayload = extractLaunchPayload(result);
        if (launchPayload?.success === false || result?.success === false) {
            const launchError = new Error(launchPayload?.error || result?.error || 'launch_cli rejected the session launch');
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, launchError), null, 2);
        }
        const runtimeSessionId = typeof launchPayload?.sessionId === 'string'
            ? launchPayload.sessionId
            : typeof launchPayload?.id === 'string'
                ? launchPayload.id
                : typeof launchPayload?.runtimeSessionId === 'string'
                    ? launchPayload.runtimeSessionId
                    : '';
        const providerSessionId = typeof launchPayload?.providerSessionId === 'string' && launchPayload.providerSessionId.trim()
            ? launchPayload.providerSessionId.trim()
            : undefined;
        if (runtimeSessionId) {
            meshSessionProviderMetadata.set(meshSessionCacheKey(args.node_id, runtimeSessionId), {
                providerType: resolvedProviderType,
                ...(providerSessionId ? { providerSessionId } : {}),
                expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
            });
        }
        // Record session launch in ledger
        try {
            appendLedgerEntry(ctx.mesh.id, {
                kind: 'session_launched',
                nodeId: args.node_id,
                sessionId: runtimeSessionId || undefined,
                providerType: resolvedProviderType,
                payload: { providerSessionId },
            });
        } catch { /* ledger append is best-effort */ }

        // Tell daemon to trigger queue processing so the new session immediately picks up pending tasks.
        // Surface the trigger result so coordinators can distinguish "session launched"
        // from "queued work actually claimed by that session".
        const queueTrigger = await triggerMeshQueueAndReport(ctx);

        return JSON.stringify({
            ...launchPayload,
            resolvedProviderType,
            ...(providerSessionId ? { providerSessionId } : {}),
            queueTrigger,
            ...buildQueueTriggerGuidance(queueTrigger),
        }, null, 2);
    }
}

export async function meshGitStatus(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Determine submodule options from node policy
    const autoDiscoverSubmodules = (node.policy as any)?.autoDiscoverSubmodules !== false;
    const submoduleIgnorePaths = (node.policy as any)?.submoduleIgnorePaths || [];

    try {
        const statusResult = await commandForNode(ctx, node, 'git_status', {
            workspace: node.workspace,
            refreshUpstream: true,
            includeSubmodules: autoDiscoverSubmodules,
            submoduleIgnorePaths: submoduleIgnorePaths.length > 0 ? submoduleIgnorePaths : undefined,
        });
        const diffResult = await commandForNode(ctx, node, 'git_diff_summary', {
            workspace: node.workspace,
        });
        return JSON.stringify({
            nodeId: args.node_id,
            workspace: node.workspace,
            status: extractGitStatus(statusResult),
            diff: extractGitDiff(diffResult),
            submodules: autoDiscoverSubmodules ? extractSubmodules(statusResult, submoduleIgnorePaths) : undefined,
            relatedRepos: await collectRelatedRepoStatuses(ctx, node),
        }, null, 2);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'git_status',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
        });
        return JSON.stringify({
            ...failure,
            workspace: node.workspace,
        }, null, 2);
    }
}

export async function meshReadNodeLogs(
    ctx: MeshContext,
    args: { node_id: string; grep?: string; since_ms?: number; tail_bytes?: number; date?: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    try {
        const result = await commandForNode(ctx, node, 'get_mesh_node_logs', {
            meshId: ctx.mesh.id,
            nodeId: args.node_id,
            ...(typeof args.grep === 'string' && args.grep.trim() ? { grep: args.grep.trim() } : {}),
            ...(Number.isFinite(args.since_ms) ? { sinceMs: args.since_ms } : {}),
            ...(Number.isFinite(args.tail_bytes) ? { tailBytes: args.tail_bytes } : {}),
            ...(typeof args.date === 'string' && args.date.trim() ? { date: args.date.trim() } : {}),
        });
        const payload = unwrapCommandPayload(result);
        return JSON.stringify(payload, null, 2);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'get_mesh_node_logs',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
        });
        return JSON.stringify(failure, null, 2);
    }
}

export async function meshFastForwardNode(
    ctx: MeshContext,
    args: { node_id: string; mode?: 'merge' | 'push'; branch?: string; execute?: boolean; dry_run?: boolean; update_submodules?: boolean; push_submodules?: boolean },
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const submoduleIgnorePaths = (node.policy as any)?.submoduleIgnorePaths || [];

    if (node.policy?.readOnly) {
        return JSON.stringify({
            success: false,
            code: 'node_read_only',
            nodeId: args.node_id,
            workspace: node.workspace,
            allowed: false,
            willRun: false,
            executed: false,
            blockingReasons: ['node_read_only'],
        }, null, 2);
    }

    try {
        const dryRun = args.dry_run === true || args.execute !== true;
        const result = await commandForNode(ctx, node, 'fast_forward_mesh_node', {
            meshId: ctx.mesh.id,
            nodeId: node.id,
            workspace: node.workspace,
            mode: args.mode === 'push' ? 'push' : 'merge',
            branch: typeof args.branch === 'string' ? args.branch : undefined,
            execute: args.execute === true && args.dry_run !== true,
            dryRun,
            updateSubmodules: args.update_submodules === true,
            pushSubmodules: args.push_submodules === true,
            submoduleIgnorePaths: submoduleIgnorePaths.length > 0 ? submoduleIgnorePaths : undefined,
        });
        return JSON.stringify(unwrapCommandPayload(result), null, 2);
    } catch (e: any) {
        const failure = buildCoordinatorP2pRelayFailure(e, {
            command: 'fast_forward_mesh_node',
            targetDaemonId: node.daemonId,
            nodeId: args.node_id,
        });
        return JSON.stringify({
            ...failure,
            workspace: node.workspace,
            allowed: false,
            willRun: false,
            executed: false,
            blockingReasons: [failure.code || 'mesh_fast_forward_unavailable'],
        }, null, 2);
    }
}

export async function meshCheckpoint(
    ctx: MeshContext,
    args: { node_id: string; message: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    // Policy checks
    if (node.policy?.readOnly) {
        return JSON.stringify({ error: `Node '${args.node_id}' is read-only — cannot checkpoint` });
    }

    const result = await commandForNode(ctx, node, 'git_checkpoint', {
        workspace: node.workspace,
        message: args.message,
        includeUntracked: true,
    });

    // Record checkpoint in ledger
    try {
        appendLedgerEntry(ctx.mesh.id, {
            kind: 'checkpoint_created',
            nodeId: args.node_id,
            payload: {
                message: args.message,
                commit: (result as any)?.checkpoint?.commit,
                outcome: (result as any)?.checkpoint?.status || ((result as any)?.checkpoint?.noop ? 'skipped' : undefined),
                noop: (result as any)?.checkpoint?.noop === true,
                reason: (result as any)?.checkpoint?.reason,
            },
        });
    } catch { /* ledger append is best-effort */ }

    return JSON.stringify(result, null, 2);
}

export async function meshApprove(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; action: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id); // membership check

    const cached = getSessionMetadata(meshSessionCacheKey(args.node_id, args.session_id));
    const providerSessionId = cached?.providerSessionId;
    const result = await commandForNode(ctx, node, 'resolve_action', {
        sessionId: args.session_id,
        targetSessionId: args.session_id,
        workspace: node.workspace,
        ...(cached?.providerType ? { agentType: cached.providerType, providerType: cached.providerType } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        action: args.action === 'reject' ? 'reject' : 'approve',
    });
    return JSON.stringify(result, null, 2);
}

export async function meshCloneNode(
    ctx: MeshContext,
    args: { source_node_id: string; branch: string; base_branch?: string },
): Promise<string> {
    const sourceNode = await findNodeWithRefresh(ctx, args.source_node_id);

    const result = await commandForNode(ctx, sourceNode, 'clone_mesh_node', {
        meshId: ctx.mesh.id,
        sourceNodeId: args.source_node_id,
        branch: args.branch,
        baseBranch: args.base_branch,
        inlineMesh: ctx.mesh,
    });
    const clonePayload = extractCloneNodePayload(result);
    if (clonePayload?.success && clonePayload.node?.id) {
        const existingIndex = ctx.mesh.nodes.findIndex(n => n.id === clonePayload.node.id);
        if (existingIndex >= 0) ctx.mesh.nodes[existingIndex] = clonePayload.node;
        else ctx.mesh.nodes.push(clonePayload.node);
        ctx.mesh.updatedAt = new Date().toISOString();
        await syncCoordinatorDaemonMeshCache(ctx);
    }
    return JSON.stringify(result, null, 2);
}

export async function meshCleanupSessions(
    ctx: MeshContext,
    args: { node_id: string; mode: string; session_ids?: string[]; dry_run?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const result = await commandForNode(ctx, node, 'cleanup_mesh_sessions', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        mode: args.mode,
        sessionIds: args.session_ids,
        dryRun: args.dry_run === true,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}

export async function meshRemoveNode(
    ctx: MeshContext,
    args: { node_id: string; session_cleanup_mode?: string; force?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const removeArgs = buildRemoveNodeArgs(ctx, args.node_id, args.session_cleanup_mode, args.force === true);
    let result: any;
    let transportFallback: Record<string, unknown> | undefined;
    try {
        result = await commandForNode(ctx, node, 'remove_mesh_node', removeArgs);
    } catch (e: any) {
        if (ctx.transport instanceof IpcTransport && (node as any).isLocalWorktree && isP2pTransportUnavailableError(e)) {
            result = await ctx.transport.command('remove_mesh_node', removeArgs);
            transportFallback = {
                from: 'p2p_mesh_relay',
                to: 'local_control_plane',
                reason: e?.message || String(e),
            };
        } else {
            return JSON.stringify({
                success: false,
                code: isP2pTransportUnavailableError(e) ? 'p2p_unavailable' : 'mesh_remove_node_failed',
                error: e?.message || String(e),
                recoveryHint: isP2pTransportUnavailableError(e)
                    ? 'If this is an ADHDev-managed local worktree, retry from a coordinator connected to the daemon that owns the worktree; dashboard command/data-plane traffic still requires P2P.'
                    : 'Inspect mesh_status and retry after resolving the reported failure.',
            }, null, 2);
        }
    }
    if (result?.success && result.removed !== false) {
        const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
        if (idx >= 0) {
            ctx.mesh.nodes.splice(idx, 1);
            ctx.mesh.updatedAt = new Date().toISOString();
        }
    }
    return JSON.stringify({ ...(result || {}), ...(transportFallback ? { transportFallback } : {}) }, null, 2);
}

function resolveRefineConfigNode(ctx: MeshContext, nodeId?: string): LocalMeshNodeEntry {
    if (nodeId) return findNode(ctx.mesh, nodeId);
    const node = ctx.mesh.nodes.find((entry: LocalMeshNodeEntry) => !!entry.workspace);
    if (!node) throw new Error('No mesh node with a workspace is available');
    return node;
}

export async function meshRefineConfigSchema(ctx: MeshContext): Promise<string> {
    const node = resolveRefineConfigNode(ctx);
    const result = await commandForNode(ctx, node, 'get_mesh_refine_config_schema', {});
    return JSON.stringify(result, null, 2);
}

export async function meshValidateRefineConfig(
    ctx: MeshContext,
    args: { node_id?: string; config?: Record<string, unknown> },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'validate_mesh_refine_config', {
        workspace: node.workspace,
        inlineMesh: ctx.mesh,
        ...(args.config ? { config: args.config } : {}),
    });
    return JSON.stringify(result, null, 2);
}

export async function meshSuggestRefineConfig(
    ctx: MeshContext,
    args: { node_id?: string },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'suggest_mesh_refine_config', {
        workspace: node.workspace,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}

export async function meshInit(
    ctx: MeshContext,
    args: { node_id?: string; write?: boolean; overwrite?: boolean },
): Promise<string> {
    const node = resolveRefineConfigNode(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'mesh_init', {
        workspace: node.workspace,
        inlineMesh: ctx.mesh,
        ...(args.write !== undefined ? { write: args.write } : {}),
        ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
    });
    return JSON.stringify(result, null, 2);
}

export async function meshRefinePlan(
    ctx: MeshContext,
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const result = await commandForNode(ctx, node, 'plan_mesh_refine_node', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}

export async function meshRefineNode(
    ctx: MeshContext,
    args: { node_id: string; execute?: boolean; dry_run?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    const result = await commandForNode(ctx, node, 'refine_mesh_node', {
        meshId: ctx.mesh.id,
        nodeId: args.node_id,
        ...(args.execute !== undefined ? { execute: args.execute } : {}),
        ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        inlineMesh: ctx.mesh,
    });
    if (result?.success && result.async !== true && result.removeResult?.removed !== false) {
        const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
        if (idx >= 0) {
            ctx.mesh.nodes.splice(idx, 1);
            ctx.mesh.updatedAt = new Date().toISOString();
        }
    }
    return JSON.stringify(result, null, 2);
}

export async function meshRefineBatch(
    ctx: MeshContext,
    args: { node_ids?: string[]; execute?: boolean; dry_run?: boolean } = {},
): Promise<string> {
    // Refresh so auto-collection and explicit node IDs resolve against the latest
    // mesh membership (siblings may have been created/removed in this MCP session).
    await refreshMeshFromDaemon(ctx);
    const nodeIds = Array.isArray(args.node_ids)
        ? args.node_ids.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
        : undefined;

    // The batch orchestrator runs on the coordinator daemon that owns the source repo
    // and worktrees. Drive it through the local control-plane transport (the same
    // daemon that hosts these worktree nodes), passing inlineMesh so inline-cache-only
    // clone nodes resolve.
    const result = await ctx.transport.command('batch_refine_mesh_nodes', {
        meshId: ctx.mesh.id,
        ...(nodeIds ? { nodeIds } : {}),
        ...(args.execute !== undefined ? { execute: args.execute } : {}),
        ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        inlineMesh: ctx.mesh,
    });

    // On a successful synchronous execute, prune merged/skipped nodes from the local
    // mesh snapshot so subsequent tool calls don't re-target already-converged worktrees.
    // The execute path is now async (async:true / status:'accepted') — per-node results
    // arrive later via terminal refine events, so there is nothing to prune yet. Only the
    // legacy/synchronous batch result (with inline `results`) is pruned here.
    const payload = unwrapCommandPayload(result) ?? result;
    if (payload?.batch && payload?.dryRun === false && payload?.async !== true && Array.isArray(payload?.results)) {
        for (const outcome of payload.results) {
            if (outcome?.convergence === 'merged_to_main' || outcome?.convergence === 'skipped_patch_equivalent') {
                const idx = ctx.mesh.nodes.findIndex(n => n.id === outcome.nodeId);
                if (idx >= 0) ctx.mesh.nodes.splice(idx, 1);
            }
        }
        ctx.mesh.updatedAt = new Date().toISOString();
    }
    return JSON.stringify(result, null, 2);
}

export async function meshReviewInbox(
    ctx: MeshContext,
    args: { mesh_id?: string } = {},
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const meshId = (args.mesh_id ?? ctx.mesh.id).trim();
    const result = await commandForNode(ctx, ctx.mesh.nodes[0], 'get_mesh_review_inbox', {
        meshId,
        inlineMesh: ctx.mesh,
    });
    return JSON.stringify(result, null, 2);
}
