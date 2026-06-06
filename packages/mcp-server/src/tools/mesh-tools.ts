/**
 * Mesh Tools — Mesh-scoped coordinator tools for Repo Mesh orchestration
 *
 * These tools wrap existing MCP transport operations but restrict targets
 * to mesh member nodes only. The coordinator uses these to delegate work
 * to agents across the mesh via natural conversation.
 *
 * 24 tools: mesh_status, mesh_list_nodes, mesh_enqueue_task, mesh_view_queue,
 *           mesh_queue_cancel, mesh_queue_requeue, mesh_send_task, mesh_read_chat,
 *           mesh_read_debug, mesh_launch_session, mesh_git_status,
 *           mesh_fast_forward_node, mesh_checkpoint, mesh_approve,
 *           mesh_clone_node, mesh_remove_node, mesh_refine_node,
 *           mesh_refine_config_schema, mesh_validate_refine_config,
 *           mesh_suggest_refine_config, mesh_refine_plan,
 *           mesh_cleanup_sessions, mesh_task_history, mesh_reconcile_ledger
 */

import { randomUUID } from 'node:crypto';
import { CloudTransport } from '../transports/cloud.js';
import { IpcTransport } from '../transports/ipc.js';
import { isLocalTransport } from '../transports/mode.js';
import type { McpTransport } from '../transports/mode.js';
import { compactChatPayload } from './chat-compact.js';
import { annotateRapidReadChatAdvisory } from './read-chat-polling-advisory.js';
import type { LocalMeshEntry, LocalMeshNodeEntry, MeshActiveWorkSummary, RepoMeshPolicy, RepoMeshRelatedRepo } from '@adhdev/daemon-core';
import {
    appendLedgerEntry,
    appendRemoteLedgerEntries,
    buildCompactStaleDirectWorkSummary,
    buildMeshActiveWork,
    buildMeshAsyncRefineJobs,
    buildMeshLedgerReconciliationEvidence,
    buildMeshLedgerReplicaEvidence,
    buildP2pRelayFailurePayload,
    cancelTask,
    classifyP2pRelayFailure,
    drainPendingMeshCoordinatorEvents,
    enqueueTask,
    getActiveDirectDispatches,
    getQueue,
    getLedgerSummary,
    getSessionRecoveryContext,
    insertDirectDispatch,
    isP2pRelayTransportFailure,
    markStaleDirectDispatches,
    readLedgerEntries,
    readLedgerSlice,
    requeueTask,
    validateMeshTaskModeRequest,
} from '@adhdev/daemon-core';

export interface MeshContext {
    mesh: LocalMeshEntry;
    transport: McpTransport;
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
    if (!isLocalTransport(ctx.transport)) return;
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
    // meshNodeFor is the primary ownership signal. meshCoordinatorDaemonId is required for
    // relay safety on remote nodes but NOT for local ownership matching — older coordinator
    // versions may have launched sessions without it. Allow those sessions as mesh-owned delegates.
    if (sessionMeshId !== meshId) return false;
    return !sessionNodeId || sessionNodeId === nodeId;
}

function chooseDispatchableSession(sessions: any[], providerType: string, meshId: string, nodeId: string): any | undefined {
    const live = sessions.filter(session => !isTerminalSessionRecord(session));
    const matchingProvider = (session: any) => !providerType || session?.providerType === providerType || session?.cliType === providerType;
    const meshSessions = live.filter((session: any) =>
        isMeshOwnedDelegateSession(session, meshId, nodeId)
    );
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
    args: { session_id?: string; message: string; providerType?: string; verifiedSession?: any },
): Promise<RemoteAgentDispatchResult> {
    const transport = ctx.transport as IpcTransport;
    const daemonId = node.daemonId!;

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
        if (!isMeshOwnedDelegateSession(explicitSession, ctx.mesh.id, node.id)) {
            return buildRelayUnsafeRemoteSessionFailure(
                ctx,
                node,
                sessionId,
                resolvedProviderType || resolveSessionProviderType(explicitSession) || undefined,
            );
        }
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
                if (!isMeshOwnedDelegateSession(explicitSession, ctx.mesh.id, node.id)) {
                    return buildRelayUnsafeRemoteSessionFailure(
                        ctx,
                        node,
                        sessionId,
                        resolvedProviderType || resolveSessionProviderType(explicitSession) || undefined,
                    );
                }
                if (!resolvedProviderType) {
                    resolvedProviderType = resolveSessionProviderType(explicitSession);
                }
            } else {
                // Prefer live idle sessions launched for this mesh node. Never route
                // a new task into restored/stopped session records; that produces the
                // coordinator-visible "pending only, chat never received it" failure.
                const targetSession = chooseDispatchableSession(sessions, resolvedProviderType, ctx.mesh.id, node.id);

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
        if (ctx.localDaemonId && session.settings?.meshCoordinatorDaemonId === ctx.localDaemonId) return true;
        if (session.launchedByCoordinator === true) return true;
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
    return countUncommittedChanges(status) > 0;
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
        } else {
            slim[k] = v;
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
            const statusResult = !isLocalTransport(ctx.transport) && node.daemonId
                ? await (ctx.transport as CloudTransport).gitStatus(node.daemonId, repo.workspace, false, true)
                : await commandForNode(ctx, node, 'git_status', { workspace: repo.workspace, refreshUpstream: true });
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

function getWorktreeBootstrapLaunchBlock(node: LocalMeshNodeEntry): Record<string, unknown> | undefined {
    const bootstrap = (node as any).worktreeBootstrap;
    if (!(node as any).isLocalWorktree || bootstrap?.status !== 'failed' || bootstrap?.required === false) return undefined;
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

function summarizeBranchConvergence(nodes: any[]): Record<string, unknown> {
    const followUps = nodes
        .filter(node => node?.branchConvergence?.needsConvergence === true)
        .map(node => ({
            nodeId: node.nodeId,
            workspace: node.workspace,
            branch: node.branchConvergence.branch,
            status: node.branchConvergence.status,
            reason: node.branchConvergence.reason,
            nextStep: node.branchConvergence.nextStep,
        }));

    return {
        needsFollowUp: followUps.length > 0,
        unresolvedCount: followUps.length,
        requiredFinalStates: ['merged_to_main', 'pushed_feature_branch_needs_merge', 'blocked_review', 'cleanup_candidate', 'not_mergeable'],
        followUps,
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
    if (isLocalTransport(ctx.transport)) {
        return ctx.transport.command(command, args);
    }
    const identity = buildNodeMachineIdentity(ctx, node);
    throw new Error(`Command '${command}' requires daemon IPC/local transport for node '${node.id}' (hostname=${identity.hostname || 'unknown'}, coordinatorHostname=${identity.coordinatorHostname || 'unknown'}, sameMachine=${identity.sameMachine})`);
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

        try {
            surfacedEvents.push(
                ...normalizePendingMeshCoordinatorEvents(await ctx.transport.command('get_pending_mesh_events', { meshId: ctx.mesh.id }) as any)
                    .filter(matchesCurrentMesh),
            );
            surfacedEvents.forEach(rememberMeshSessionProviderMetadataFromEvent);
        } catch {
            // Non-fatal: pending events are best-effort.
        }

        for (const node of ctx.mesh.nodes) {
            if (!node.daemonId || isLocalControlPlaneNode(ctx, node)) continue;
            if (requestedNodeIds && !requestedNodeIds.has(node.id)) continue;

            try {
                const remoteEvents = normalizePendingMeshCoordinatorEvents(
                    await ctx.transport.meshCommand(node.daemonId, 'get_pending_mesh_events', { meshId: ctx.mesh.id }),
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
            surfacedEvents.push(
                ...normalizePendingMeshCoordinatorEvents(await ctx.transport.command('get_pending_mesh_events', { meshId: ctx.mesh.id }) as any)
                    .filter(matchesCurrentMesh),
            );
            surfacedEvents.forEach(rememberMeshSessionProviderMetadataFromEvent);
        } catch {
            // Non-fatal: pending events are best-effort.
        }

        return surfacedEvents;
    }

    if (isLocalTransport(ctx.transport)) {
        // (B3) Pass localDaemonId so unicast events targeted at other
        // coordinators are skipped (and requeued) instead of being silently
        // consumed by this MCP. drainPendingMeshCoordinatorEvents already
        // accepts the second arg in the base; we were the missing wiring.
        const events = (drainPendingMeshCoordinatorEvents(ctx.mesh.id, ctx.localDaemonId) as any[]).filter(matchesCurrentMesh);
        events.forEach(rememberMeshSessionProviderMetadataFromEvent);
        return events;
    }

    return [];
}

function isP2pTransportUnavailableError(error: unknown): boolean {
    return isP2pRelayTransportFailure(error);
}

function buildRemoveNodeArgs(ctx: MeshContext, nodeId: string, sessionCleanupMode?: string): Record<string, unknown> {
    return {
        meshId: ctx.mesh.id,
        nodeId,
        ...(sessionCleanupMode ? { sessionCleanupMode } : {}),
        inlineMesh: ctx.mesh,
    };
}

// ─── Tool Definitions ───────────────────────────

export const MESH_STATUS_TOOL = {
    name: 'mesh_status',
    description: 'Get the current status of all nodes in the repo mesh — health, git state, active sessions, recovery hints, and recommended next steps. Use this to decide which node to send work to or how to recover from failures. Do not repeatedly call this to wait for generating delegated work; wait for pendingCoordinatorEvents/completion events or an explicit user status request.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            _gemini_compat: { type: 'string', description: 'Dummy property for Gemini compatibility. Ignore this.' },
            includeStaleDirectWorkDetails: { type: 'boolean', description: 'Opt in to the full staleDirectWork array. Defaults false; normal status returns compact staleDirectWorkSummary only.' },
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
    description: 'Return a mesh queue task to pending for retry. By default clears stale assigned owner and target session so another live session can claim it.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            task_id: { type: 'string', description: 'Queue task ID to requeue.' },
            reason: { type: 'string', description: 'Optional operator-visible reason for requeueing.' },
            target_node_id: { type: 'string', description: 'Optional replacement target node ID.' },
            target_session_id: { type: 'string', description: 'Optional replacement target runtime session ID.' },
            clear_target_node: { type: 'boolean', description: 'When true, remove any existing target node constraint.' },
            keep_target_session: { type: 'boolean', description: 'When true, preserve an existing target session if target_session_id is not provided. Defaults false to avoid stale session targets.' },
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

export const MESH_FAST_FORWARD_NODE_TOOL = {
    name: 'mesh_fast_forward_node',
    description: 'Safely dry-run or execute an obvious direct fast-forward for a mesh node without launching an agent session. Defaults to dry-run; execution requires execute=true. Never pushes, rebases, resets, cleans, or checks out arbitrary revisions.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            branch: { type: 'string', description: 'Optional guard: require the node\'s current branch to match this branch before planning/executing.' },
            execute: { type: 'boolean', description: 'When true, apply the fast-forward if all safety gates pass. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview only. Defaults true unless execute=true; dry_run=true overrides execute.' },
            update_submodules: { type: 'boolean', description: 'When true, if the root fast-forward changes gitlinks, run only git submodule update --init --recursive and verify submodules clean.' },
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
    description: 'Remove a node from the mesh. If the node is a worktree, also cleans up the git worktree and directory. Session cleanup is controlled by mesh policy sessionCleanupOnNodeRemove unless session_cleanup_mode overrides it for this call.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID to remove.' },
            session_cleanup_mode: {
                type: 'string',
                enum: ['preserve', 'stop', 'delete_stopped', 'stop_and_delete'],
                description: 'Optional override for cleanup of delegated sessions attached to this node. preserve keeps history/processes; stop stops live runtimes only; delete_stopped removes completed transcripts only; stop_and_delete stops live runtimes and deletes records.',
            },
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
            tail: { type: 'number', description: 'Number of recent entries to return (default: 20).' },
            kind: { type: 'string', description: 'Filter by entry kind: task_dispatched, task_completed, task_failed, task_stalled, session_launched, checkpoint_created, node_cloned, node_removed, direct_fast_forward.' },
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

export const MESH_REFINE_NODE_TOOL = {
    name: 'mesh_refine_node',
    description: 'The Refinery: Accept an async validation/merge/cleanup job for a completed worktree node. The immediate response includes async:true, status:\'accepted\', jobId, interactionId, target node, and startedAt; completion/failure evidence is delivered through pending mesh events and the mesh task ledger.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node ID of the completed worktree node to refine and merge.' },
        },
        required: ['node_id'],
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
    MESH_FAST_FORWARD_NODE_TOOL,
    MESH_CHECKPOINT_TOOL,
    MESH_APPROVE_TOOL,
    MESH_CLONE_NODE_TOOL,
    MESH_REMOVE_NODE_TOOL,
    MESH_REFINE_NODE_TOOL,
    MESH_REFINE_CONFIG_SCHEMA_TOOL,
    MESH_VALIDATE_REFINE_CONFIG_TOOL,
    MESH_SUGGEST_REFINE_CONFIG_TOOL,
    MESH_REFINE_PLAN_TOOL,
    MESH_CLEANUP_SESSIONS_TOOL,
    MESH_TASK_HISTORY_TOOL,
    MESH_RECONCILE_LEDGER_TOOL,
];

// ─── Tool Implementations ───────────────────────

export async function meshStatus(ctx: MeshContext, args: { includeStaleDirectWorkDetails?: boolean; includeTerminalDirectWork?: boolean } = {}): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const { mesh, transport } = ctx;

    const ledgerSummary = getLedgerSummary(mesh.id);

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
            if (!isLocalTransport(transport) && node.daemonId) {
                const result = await (transport as CloudTransport).gitStatus(node.daemonId, node.workspace, false, true);
                const status = extractGitStatus(result);
                const uncommittedChanges = countUncommittedChanges(status);
                const dirty = isGitStatusDirty(status);
                entry.health = status?.isGitRepo ? (dirty ? 'dirty' : 'online') : 'degraded';
                assignFullGitSnapshot(entry, status);
                entry.branch = status?.branch;
                entry.isDirty = dirty;
                entry.uncommittedChanges = uncommittedChanges;
                entry.branchConvergence = buildBranchConvergence(mesh, node, status, dirty, uncommittedChanges);
                // Submodule out-of-sync warning
                const submodules = extractSubmodules(result, (node.policy as any)?.submoduleIgnorePaths || []);
                if (submodules && submodules.some((s: any) => s?.outOfSync)) {
                    entry.submoduleWarning = 'One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.';
                    entry.outOfSyncSubmodules = submodules.filter((s: any) => s?.outOfSync).map((s: any) => s.path);
                }
            } else if (isLocalTransport(transport)) {
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
                // Submodule out-of-sync warning
                const submodules = extractSubmodules(statusResult, (node.policy as any)?.submoduleIgnorePaths || []);
                if (submodules && submodules.some((s: any) => s?.outOfSync)) {
                    entry.submoduleWarning = 'One or more submodules are out of sync with the parent repo. Run `git submodule update` or check deployment readiness.';
                    entry.outOfSyncSubmodules = submodules.filter((s: any) => s?.outOfSync).map((s: any) => s.path);
                }
            } else {
                entry.health = 'unknown';
                entry.note = 'No daemonId available for cloud status probe';
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

        const liveSessions = await collectLiveStatusSessions(ctx, node);
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

    const ledgerEntries = readLedgerEntries(mesh.id, { tail: 200 });
    const activeWorkEvidence = buildMeshActiveWork({
        meshId: mesh.id,
        queue: getQueue(mesh.id),
        ledgerEntries,
        nodes: results,
    });

    const pollingGuidance = buildActiveWorkPollingGuidance(activeWorkEvidence.summary);
    const staleDirectWorkSummary = buildCompactStaleDirectWorkSummary(activeWorkEvidence.staleDirectWork, {
        note: activeWorkEvidence.staleDirectWorkNote,
        detailHint: 'Full stale direct entries are omitted from mesh_status by default. Call mesh_status with includeStaleDirectWorkDetails=true or inspect mesh_task_history for ledger detail.',
    });

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

    const response: Record<string, unknown> = {
        meshId: mesh.id,
        meshName: mesh.name,
        repoIdentity: mesh.repoIdentity,
        policy: mesh.policy,
        refreshedAt: new Date().toISOString(),
        sourceOfTruth: {
            membership: 'coordinator_daemon_live_mesh',
            currentStatus: 'live_git_and_session_probes',
            activeWork: 'mesh_queue_file_and_local_ledger',
            historicalEvidenceOnly: ['recoveryHints', 'ledgerSummary'],
        },
        nodes: results,
        activeWork: activeWorkEvidence.activeWork,
        staleDirectWorkSummary,
        ...(args.includeStaleDirectWorkDetails === true ? { staleDirectWork: activeWorkEvidence.staleDirectWork } : {}),
        // terminalDirectWork is historical (completed/failed direct dispatches) — opt-in only.
        ...(args.includeTerminalDirectWork === true ? { terminalDirectWork: activeWorkEvidence.terminalDirectWork } : {}),
        activeWorkSummary: activeWorkEvidence.summary,
        ...(pollingGuidance ? { pollingGuidance } : {}),
        branchConvergenceSummary: summarizeBranchConvergence(results),
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

    try {
        const pendingEvents = await drainCoordinatorPendingEvents(ctx);
        const asyncRefineJobs = buildMeshAsyncRefineJobs({
            meshId: mesh.id,
            ledgerEntries,
            pendingEvents,
        });
        if (asyncRefineJobs.length > 0) {
            response.asyncRefineJobs = asyncRefineJobs;
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
    args: { tail?: number; kind?: string },
): Promise<string> {
    const { mesh } = ctx;
    const pendingEvents = await drainCoordinatorPendingEvents(ctx);
    const tail = typeof args.tail === 'number' && args.tail > 0 ? args.tail : 20;
    const kind = typeof args.kind === 'string' && args.kind.trim() ? [args.kind.trim() as any] : undefined;
    const rawEntries = readLedgerEntries(mesh.id, { tail, kind });
    // Slim large payload fields so coordinator context stays lean.
    const entries = rawEntries.map(e => ({
        ...e,
        payload: e.payload ? slimLedgerPayload(e.payload) : e.payload,
    }));
    const summary = getLedgerSummary(mesh.id);
    return JSON.stringify({
        meshId: mesh.id,
        entries,
        summary,
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
                const slice = readLedgerSlice(ctx.mesh.id, queryArgs);
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

export async function meshEnqueueTask(
    ctx: MeshContext,
    args: { message: string; task_mode?: string; taskMode?: string },
): Promise<string> {
    const taskMode = readString(args.task_mode) || readString(args.taskMode);
    try {
        const task = enqueueTask(ctx.mesh.id, args.message, { taskMode });

        // ── LocalTransport: queue-based pull (standalone daemon, all local) ─────
        if (isLocalTransport(ctx.transport) && !(ctx.transport instanceof IpcTransport)) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
            return JSON.stringify({ success: true, source: 'queue', taskId: task.id, status: task.status, taskMode: task.taskMode });
        }

        // ── IpcTransport (Cloud Mesh): the queue file lives on THIS machine only.
        //    Remote daemons on other machines cannot read the local queue file.
        //    Strategy: trigger local queue for local nodes, and for remote nodes
        //    directly P2P-dispatch to the first idle session found (enqueue-and-push).
        if (ctx.transport instanceof IpcTransport) {
            // 1. Trigger local queue for local node pick-up
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});

            // 2. For each remote node, directly dispatch to an idle session via P2P
            const dispatchPromises: Promise<void>[] = [];
            for (const node of ctx.mesh.nodes) {
                const isLocalNode = isLocalControlPlaneNode(ctx, node);
                if (isLocalNode || !node.daemonId) continue;

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

            return JSON.stringify({ success: true, source: 'queue', taskId: task.id, status: task.status, taskMode: task.taskMode });
        }

        // ── CloudTransport fallback ───────────────────────────────────────────────
        return JSON.stringify({ success: true, source: 'queue', taskId: task.id, status: task.status, taskMode: task.taskMode });
    } catch (e: any) {
        const message = e?.message || String(e);
        if (message.includes('live_debug_readonly_guardrail_violation')) {
            return JSON.stringify({ success: false, code: 'live_debug_readonly_guardrail_violation', taskMode, error: message });
        }
        return JSON.stringify({ success: false, error: message });
    }
}

export async function meshViewQueue(
    ctx: MeshContext,
    args: { status?: string[]; view?: QueueViewMode },
): Promise<string> {
    try {
        await refreshMeshFromDaemon(ctx);
        const statusFilter = sanitizeQueueStatusFilter(args.status);
        const view = normalizeQueueViewMode(args.view);
        const fullQueue = prioritizeActiveQueueRows(annotateQueueStaleness(getQueue(ctx.mesh.id), ctx.mesh));
        const queue = filterQueueForView(fullQueue, view, statusFilter);
        const summary = buildQueueStatusSummary(fullQueue);
        const visibleSummary = buildQueueStatusSummary(queue);
        const maintenance = buildQueueMaintenanceReport(fullQueue);
        const liveNodes = await collectMeshViewQueueNodesWithLiveSessions(ctx);
        // Mark dispatched entries with no session activity after 30 min as stale.
        markStaleDirectDispatches(ctx.mesh.id);
        const ledgerEntries = readLedgerEntries(ctx.mesh.id, { tail: 200 });
        const directDispatches = getActiveDirectDispatches(ctx.mesh.id);
        const activeWorkEvidence = buildMeshActiveWork({
            meshId: ctx.mesh.id,
            queue: fullQueue,
            ledgerEntries,
            // Always pass BeadsDB records (may be empty). buildMeshActiveWork uses them for local
            // dispatches and falls through to ledger scan for remote P2P dispatches not in BeadsDB.
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
        return JSON.stringify({
            success: true,
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
            queue,
            activeWork: activeWorkEvidence.activeWork,
            staleDirectWork: activeWorkEvidence.staleDirectWork,
            activeWorkSummary: activeWorkEvidence.summary,
            ...(pollingGuidance ? { pollingGuidance } : {}),
            summary,
            staleAssignedTasks,
            staleAssignedCount: (maintenance as any).staleAssignedCount,
            queueMaintenance: maintenance,
            cleanupDryRun: maintenance,
            ...(recentDispatchFailures.length > 0 ? {
                recentDispatchFailures,
                dispatchFailureCount: recentDispatchFailures.length,
                dispatchFailureNote: 'Remote P2P dispatch attempts that failed. Affected tasks remain pending and may require mesh_queue_requeue if no idle session picks them up.',
            } : {}),
            ...(view === 'active' || statusFilter?.some(status => ACTIVE_QUEUE_STATUSES.has(status)) ? {
                activeQueue: queue.filter((task: any) => ACTIVE_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            ...(view === 'historical' || requestedHistoricalRows ? {
                historicalQueue: queue.filter((task: any) => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || ''))),
            } : {}),
            // Back-compat alias for callers already reading the first hardening payload.
            staleAssignments: staleAssignedTasks,
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
        if (isLocalTransport(ctx.transport)) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        }
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
        });
        if (!task) return JSON.stringify({ success: false, error: `Queue task '${taskId}' not found` });
        if (isLocalTransport(ctx.transport)) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        }
        return JSON.stringify({ success: true, task }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

export async function meshSendTask(
    ctx: MeshContext,
    args: { node_id: string; session_id?: string; message: string; task_mode?: string; taskMode?: string },
): Promise<string> {
    const requestedTaskMode = readString(args.task_mode) || readString(args.taskMode);
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
    if (args.session_id && isWorkerTaskMode(taskMode) && (ctx.transport instanceof IpcTransport || isLocalTransport(ctx.transport))) {
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
        // ── CloudTransport: delegate to Cloud API ──────────────────────────────
        if (!isLocalTransport(ctx.transport) && node.daemonId) {
            const res = await (ctx.transport as CloudTransport).meshEnqueueTask(node.daemonId, {
                meshId: ctx.mesh.id,
                message: args.message,
                targetNodeId: args.node_id,
                ...(taskMode ? { taskMode } : {}),
            });
            return JSON.stringify(res);
        }

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
            const result = await ipcDispatchToRemoteAgent(ctx, node, {
                session_id: args.session_id,
                message: args.message,
                providerType: cached?.providerType,
                verifiedSession: explicitTargetSession,
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
        if (args.session_id && isLocalTransport(ctx.transport)) {
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
            // Detect whether the session was idle at dispatch time. An idle session that
            // receives agent_command/send_chat should transition to generating. If it stays
            // idle, the dispatch was not acknowledged. Record this for stale detection and
            // surface it as a dispatchAcknowledgementRisk warning in the success response.
            const sessionWasIdle = explicitTargetSession
                ? isIdleSessionRecord(explicitTargetSession)
                : false;
            const dispatchResult = await commandForNode(ctx, node, 'agent_command', {
                targetSessionId: args.session_id,
                agentType: resolvedProviderType,
                cliType: resolvedProviderType,
                providerType: resolvedProviderType,
                action: 'send_chat',
                message: args.message,
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
            const taskId = randomUUID();
            const dispatchedAt = new Date().toISOString();
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
            return JSON.stringify({
                success: true,
                dispatched: true,
                source: 'direct',
                taskId,
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
        });

        if (isLocalTransport(ctx.transport) || ctx.transport instanceof IpcTransport) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        }

        // Also drain any pending coordinator events so the caller sees them inline
        const pendingEvents = isLocalTransport(ctx.transport)
            ? drainPendingMeshCoordinatorEvents(ctx.mesh.id, ctx.localDaemonId)
            : [];

        const result: Record<string, unknown> = { success: true, source: 'queue', nodeId: args.node_id, taskId: task.id, status: task.status, taskMode: task.taskMode };
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

    if (ctx.transport instanceof IpcTransport || isLocalTransport(ctx.transport)) {
        await drainCoordinatorPendingEvents(ctx, { nodeIds: [args.node_id] });
    }

    if (isLocalTransport(ctx.transport)) {
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
            tailLimit: args.tail ?? 3,
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
                limit: args.tail ?? 3,
            });
            return JSON.stringify(
                payload.pollingAdvisory ? { ...compactPayload, pollingAdvisory: payload.pollingAdvisory } : compactPayload,
                null,
                2,
            );
        }
        return JSON.stringify(payload, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const targetId = `${node.daemonId}:session:${args.session_id}`;
            const res = await (ctx.transport as CloudTransport).readChat(targetId, {
                limit: args.tail ?? 3,
                sessionId: args.session_id,
            });
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh read_chat requires node daemonId' });
    }
}

export async function meshReadDebug(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; provider_session_id?: string; tail?: number; delivery?: 'daemon_file' | 'inline' },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
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
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const targetId = `${node.daemonId}:session:${args.session_id}`;
            const res = await (ctx.transport as CloudTransport).getChatDebugBundle(targetId, {
                sessionId: args.session_id,
                tailLimit: args.tail ?? 40,
                delivery: args.delivery,
            });
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    }

    return JSON.stringify({ error: 'Cloud mesh read_debug requires node daemonId' });
}

export async function meshLaunchSession(
    ctx: MeshContext,
    args: { node_id: string; type?: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);
    const bootstrapBlock = getWorktreeBootstrapLaunchBlock(node);
    if (bootstrapBlock) return JSON.stringify(bootstrapBlock, null, 2);

    if (isLocalTransport(ctx.transport)) {
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
        const coordinatorDaemonId = coordinatorNode?.daemonId || ctx.localDaemonId;
        const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
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
                    meshNodeFor: ctx.mesh.id,
                    meshNodeId: args.node_id,
                    spawnedSessionVisibility,
                    ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
                    ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                    launchedByCoordinator: true
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

        // Tell daemon to trigger queue processing so the new session immediately picks up pending tasks
        if (ctx.transport instanceof IpcTransport && node.daemonId && !isLocalNode) {
            ctx.transport.meshCommand(node.daemonId, 'trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        } else if (isLocalTransport(ctx.transport)) {
            ctx.transport.command('trigger_mesh_queue', { meshId: ctx.mesh.id }).catch(() => {});
        }

        return JSON.stringify({
            ...launchPayload,
            resolvedProviderType,
            ...(providerSessionId ? { providerSessionId } : {}),
        }, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        let resolvedProviderType = typeof args.type === 'string' && args.type.trim() ? args.type : '';
        if (!resolvedProviderType) {
            const providerPriority = readProviderPriority(node.policy);
            if (!providerPriority.length) {
                return JSON.stringify({ success: false, error: missingProviderPriorityMessage(args.node_id) });
            }
            resolvedProviderType = providerPriority[0]; // Best effort for cloud, skip detection
        }

        const coordinatorNode = resolveCoordinatorNode(ctx);
        const coordinatorDaemonId = coordinatorNode?.daemonId || ctx.localDaemonId;
        const spawnedSessionVisibility = readSpawnedSessionVisibility(ctx.mesh.policy);
        if (!coordinatorDaemonId) {
            return JSON.stringify(buildMissingCoordinatorDaemonIdFailure(ctx, node, resolvedProviderType), null, 2);
        }

        try {
            const res = await (ctx.transport as CloudTransport).launch(node.daemonId, {
                type: resolvedProviderType,
                dir: node.workspace,
                settings: {
                    meshNodeFor: ctx.mesh.id,
                    meshNodeId: args.node_id,
                    spawnedSessionVisibility,
                    ...(coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}),
                    ...(coordinatorNode?.id ? { meshCoordinatorNodeId: coordinatorNode.id } : {}),
                    launchedByCoordinator: true
                }
            });

            const runtimeSessionId = typeof res?.sessionId === 'string' ? res.sessionId : typeof res?.id === 'string' ? res.id : '';
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'session_launched',
                    nodeId: args.node_id,
                    sessionId: runtimeSessionId || undefined,
                    providerType: resolvedProviderType,
                    payload: {},
                });
            } catch { /* best-effort */ }

            return JSON.stringify({ ...res, resolvedProviderType }, null, 2);
        } catch (e: any) {
            return JSON.stringify(recordRecoverableLaunchFailure(ctx, node, resolvedProviderType, e), null, 2);
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh launch_session requires node daemonId' });
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
        if (!isLocalTransport(ctx.transport) && node.daemonId) {
            const result = await (ctx.transport as CloudTransport).gitStatus(node.daemonId, node.workspace, true, true);
            return JSON.stringify({
                nodeId: args.node_id,
                workspace: node.workspace,
                status: extractGitStatus(result),
                diff: extractGitDiff(result),
                submodules: autoDiscoverSubmodules ? extractSubmodules(result, submoduleIgnorePaths) : undefined,
                relatedRepos: await collectRelatedRepoStatuses(ctx, node),
            }, null, 2);
        } else if (isLocalTransport(ctx.transport)) {
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
        } else {
            return JSON.stringify({ error: 'No daemonId available for cloud git_status probe' });
        }
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

export async function meshFastForwardNode(
    ctx: MeshContext,
    args: { node_id: string; branch?: string; execute?: boolean; dry_run?: boolean; update_submodules?: boolean },
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
            branch: typeof args.branch === 'string' ? args.branch : undefined,
            execute: args.execute === true && args.dry_run !== true,
            dryRun,
            updateSubmodules: args.update_submodules === true,
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

    if (isLocalTransport(ctx.transport)) {
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
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).gitCheckpoint(node.daemonId, {
                workspace: node.workspace,
                message: args.message,
                includeUntracked: true,
            });
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'checkpoint_created',
                    nodeId: args.node_id,
                    payload: {
                        message: args.message,
                        commit: (res as any)?.checkpoint?.commit,
                        outcome: (res as any)?.checkpoint?.status || ((res as any)?.checkpoint?.noop ? 'skipped' : undefined),
                        noop: (res as any)?.checkpoint?.noop === true,
                        reason: (res as any)?.checkpoint?.reason,
                    },
                });
            } catch { /* best-effort */ }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh checkpoint requires node daemonId' });
    }
}

export async function meshApprove(
    ctx: MeshContext,
    args: { node_id: string; session_id: string; action: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id); // membership check

    if (isLocalTransport(ctx.transport)) {
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
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const targetId = `${node.daemonId}:session:${args.session_id}`;
            const res = await (ctx.transport as CloudTransport).approve(targetId, args.action === 'reject' ? 'reject' : 'approve');
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh approve requires node daemonId' });
    }
}

export async function meshCloneNode(
    ctx: MeshContext,
    args: { source_node_id: string; branch: string; base_branch?: string },
): Promise<string> {
    const sourceNode = await findNodeWithRefresh(ctx, args.source_node_id);

    if (isLocalTransport(ctx.transport)) {
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
    } else if (!isLocalTransport(ctx.transport) && sourceNode.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshCloneNode(sourceNode.daemonId, {
                meshId: ctx.mesh.id,
                sourceNodeId: args.source_node_id,
                branch: args.branch,
                baseBranch: args.base_branch,
                inlineMesh: ctx.mesh,
            });
            const clonePayload = extractCloneNodePayload(res);
            if (clonePayload?.success && clonePayload.node?.id) {
                const existingIndex = ctx.mesh.nodes.findIndex(n => n.id === clonePayload.node.id);
                if (existingIndex >= 0) ctx.mesh.nodes[existingIndex] = clonePayload.node;
                else ctx.mesh.nodes.push(clonePayload.node);
                ctx.mesh.updatedAt = new Date().toISOString();
                await syncCoordinatorDaemonMeshCache(ctx);
            }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh clone_node requires source node daemonId' });
    }
}

export async function meshCleanupSessions(
    ctx: MeshContext,
    args: { node_id: string; mode: string; session_ids?: string[]; dry_run?: boolean },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, node, 'cleanup_mesh_sessions', {
            meshId: ctx.mesh.id,
            nodeId: args.node_id,
            mode: args.mode,
            sessionIds: args.session_ids,
            dryRun: args.dry_run === true,
            inlineMesh: ctx.mesh,
        });
        return JSON.stringify(result, null, 2);
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshCleanupSessions(node.daemonId, {
                meshId: ctx.mesh.id,
                nodeId: args.node_id,
                mode: args.mode,
                sessionIds: args.session_ids,
                dryRun: args.dry_run === true,
                inlineMesh: ctx.mesh,
            });
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh cleanup_sessions requires node daemonId' });
    }
}

export async function meshRemoveNode(
    ctx: MeshContext,
    args: { node_id: string; session_cleanup_mode?: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const removeArgs = buildRemoveNodeArgs(ctx, args.node_id, args.session_cleanup_mode);
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
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshRemoveNode(node.daemonId, {
                meshId: ctx.mesh.id,
                nodeId: args.node_id,
                ...(args.session_cleanup_mode ? { sessionCleanupMode: args.session_cleanup_mode } : {}),
                inlineMesh: ctx.mesh,
            });
            if (res?.success && res.removed !== false) {
                const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
                if (idx >= 0) {
                    ctx.mesh.nodes.splice(idx, 1);
                    ctx.mesh.updatedAt = new Date().toISOString();
                }
            }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh remove_node requires node daemonId' });
    }
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
    args: { node_id: string },
): Promise<string> {
    const node = await findNodeWithRefresh(ctx, args.node_id);

    if (isLocalTransport(ctx.transport)) {
        const result = await commandForNode(ctx, node, 'refine_mesh_node', {
            meshId: ctx.mesh.id,
            nodeId: args.node_id,
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
    } else if (!isLocalTransport(ctx.transport) && node.daemonId) {
        try {
            const res = await (ctx.transport as CloudTransport).meshRefineNode(node.daemonId, {
                meshId: ctx.mesh.id,
                nodeId: args.node_id,
                inlineMesh: ctx.mesh,
            });
            if (res?.success && res.async !== true && res.removeResult?.removed !== false) {
                const idx = ctx.mesh.nodes.findIndex(n => n.id === args.node_id);
                if (idx >= 0) {
                    ctx.mesh.nodes.splice(idx, 1);
                    ctx.mesh.updatedAt = new Date().toISOString();
                }
            }
            return JSON.stringify(res, null, 2);
        } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
        }
    } else {
        return JSON.stringify({ error: 'Cloud mesh refine_node requires node daemonId' });
    }
}
