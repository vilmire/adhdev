/**
 * Work-queue view / maintenance / compaction helpers for the mesh_* tools.
 *
 * Physically split out of mesh-tools.ts (RF-SURVEY candidate C1) with no behavior
 * change. Holds queue status/view normalization, the liveness index + stale-
 * assignment detection, maintenance reporting, and the compact row/active-work
 * folders. Imports only leaf deps (mesh-tool-shared, mesh-session-helpers) plus the
 * LocalMeshEntry type; mesh-tools.ts imports the exported helpers/constants back, so
 * there is no runtime import cycle.
 */
import type { LocalMeshEntry } from '@adhdev/daemon-core';
import { readString, elideLargeNestedValue } from './mesh-tool-shared.js';
import { collectNodeSessionIds } from './mesh-session-helpers.js';

const STALE_ASSIGNED_QUEUE_MS = 30 * 60_000;
const OLD_HISTORICAL_QUEUE_RECORD_MS = 7 * 24 * 60 * 60_000;
export const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'assigned']);
export const HISTORICAL_QUEUE_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export type QueueViewMode = 'all' | 'active' | 'historical';

type QueueLivenessIndex = {
    nodeIds: Set<string>;
    nodeSessionIds: Map<string, Set<string>>;
    // Node ids that were confirmed by a live probe this call (success OR a probe that
    // succeeded and found zero sessions). Absent/empty when no live-verified nodes were
    // supplied — callers that don't opt in get the pre-existing snapshot-only behavior.
    verifiedLiveNodeIds: Set<string>;
};

// liveVerifiedNodes is OPT-IN evidence from collectMeshViewQueueNodesWithLiveSessionsVerified
// (each node stamped with `__liveProbeVerified`). Callers that don't pass it (e.g. MAGI,
// which only has the persisted mesh snapshot in hand) get byte-identical behavior to before —
// staleness is judged purely from `mesh.nodes`. This matters because a live probe can fail
// for reasons that say nothing about the session (relay hiccup, transient offline peer); only
// a *verified* absence should ever be allowed to override/strengthen the snapshot-based read,
// and only for a caller that explicitly asked for that stronger check.
function buildQueueLivenessIndex(mesh?: LocalMeshEntry, liveVerifiedNodes?: any[]): QueueLivenessIndex {
    const nodeIds = new Set<string>();
    const nodeSessionIds = new Map<string, Set<string>>();
    for (const node of Array.isArray(mesh?.nodes) ? mesh.nodes : []) {
        const nodeId = readString((node as any).id) || readString((node as any).nodeId) || readString((node as any).node_id);
        if (!nodeId) continue;
        nodeIds.add(nodeId);
        const sessions = collectNodeSessionIds(node);
        if (sessions.size > 0) nodeSessionIds.set(nodeId, sessions);
    }

    const verifiedLiveNodeIds = new Set<string>();
    for (const node of Array.isArray(liveVerifiedNodes) ? liveVerifiedNodes : []) {
        if ((node as any)?.__liveProbeVerified !== true) continue;
        const nodeId = readString((node as any).id) || readString((node as any).nodeId) || readString((node as any).node_id);
        if (!nodeId) continue;
        verifiedLiveNodeIds.add(nodeId);
        // A verified probe is a strictly more current source than the persisted
        // snapshot: replace (not merge) this node's session set with what the probe
        // actually saw, including replacing with empty if the probe confirmed none.
        nodeSessionIds.set(nodeId, collectNodeSessionIds(node));
    }

    return { nodeIds, nodeSessionIds, verifiedLiveNodeIds };
}

// A remote worker launch is async — dispatch stamps assignedNodeId/assignedSessionId
// on the queue row before the worker's session has necessarily registered with the
// daemon. A live probe run inside that startup window can come back verified-empty
// for a perfectly healthy, freshly-dispatched task. Require the assignment to have
// aged past this floor before a verified-empty probe is allowed to convict it — short
// enough to catch real ghosts quickly, long enough to clear normal launch latency.
const SESSION_LIVENESS_STARTUP_GRACE_MS = 2 * 60_000;

function queueAssignmentStaleReason(task: any, liveness: QueueLivenessIndex): string | undefined {
    if (task?.status !== 'assigned') return undefined;
    const nodeId = readString(task.assignedNodeId) || readString(task.nodeId) || readString(task.node_id) || readString(task.targetNodeId);
    const sessionId = readString(task.assignedSessionId) || readString(task.sessionId) || readString(task.session_id) || readString(task.targetSessionId);
    const updatedAt = new Date(task.updatedAt).getTime();
    const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : null;

    if (nodeId && liveness.nodeIds.size > 0 && !liveness.nodeIds.has(nodeId)) {
        return 'assigned node is not present in the current mesh snapshot';
    }
    if (nodeId && sessionId && liveness.nodeSessionIds.has(nodeId) && !liveness.nodeSessionIds.get(nodeId)!.has(sessionId)) {
        // Snapshot says the session isn't live on this node. Without live-verified
        // evidence this could just be a stale/never-updated snapshot row, so only
        // report it as stale once a live probe actually confirmed the absence — and
        // even then, only once the assignment has cleared the async-launch grace
        // window (startup race: session registration lags dispatch).
        const verifiedByProbe = liveness.verifiedLiveNodeIds.size === 0 || liveness.verifiedLiveNodeIds.has(nodeId);
        const pastStartupGrace = ageMs === null || ageMs >= SESSION_LIVENESS_STARTUP_GRACE_MS;
        if (verifiedByProbe && pastStartupGrace) {
            return 'assigned session is not live on the assigned node';
        }
    }

    if (!nodeId && ageMs !== null && ageMs >= STALE_ASSIGNED_QUEUE_MS) {
        return 'assigned task has no assigned node metadata';
    }
    return undefined;
}

export function buildQueueStatusSummary(queue: any[]): Record<string, unknown> {
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

export function normalizeQueueViewMode(value: unknown): QueueViewMode {
    return value === 'active' || value === 'historical' || value === 'all' ? value : 'all';
}

export function sanitizeQueueStatusFilter(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const statuses = value
        .map(item => typeof item === 'string' ? item.trim() : '')
        .filter(status => ACTIVE_QUEUE_STATUSES.has(status) || HISTORICAL_QUEUE_STATUSES.has(status));
    return statuses.length ? Array.from(new Set(statuses)) : undefined;
}

export function filterQueueForView(queue: any[], view: QueueViewMode, statuses?: string[]): any[] {
    if (statuses?.length) {
        const allowed = new Set(statuses);
        return queue.filter(task => allowed.has(String(task?.status || '')));
    }
    if (view === 'active') return queue.filter(task => ACTIVE_QUEUE_STATUSES.has(String(task?.status || '')));
    if (view === 'historical') return queue.filter(task => HISTORICAL_QUEUE_STATUSES.has(String(task?.status || '')));
    return queue;
}

export function prioritizeActiveQueueRows(queue: any[]): any[] {
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

export function buildQueueMaintenanceReport(queue: any[]): Record<string, unknown> {
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
export function buildCompactQueueMaintenanceReport(maintenance: Record<string, unknown>): Record<string, unknown> {
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
export const COMPACT_MAX_ACTIVE_QUEUE_ROWS = 15;
const COMPACT_QUEUE_MESSAGE_CAP = 140;
export const COMPACT_MAX_ACTIVE_WORK_ROWS = 12;
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
export function compactQueueRow(task: any): any {
    if (!task || typeof task !== 'object') return task;
    const slim: any = {};
    for (const [k, v] of Object.entries(task)) {
        if (k === 'message') slim[k] = truncateForCompact(v, COMPACT_QUEUE_MESSAGE_CAP);
        else slim[k] = elideLargeNestedValue(k, v);
    }
    return slim;
}

export function compactQueueRows(rows: any[]): { rows: any[]; omitted: number } {
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

export function compactActiveWorkRecords(records: any[]): { records: any[]; omitted: number } {
    if (!Array.isArray(records)) return { records, omitted: 0 };
    const capped = records.slice(0, COMPACT_MAX_ACTIVE_WORK_ROWS).map(compactActiveWorkRecord);
    return { records: capped, omitted: Math.max(0, records.length - capped.length) };
}

export function annotateQueueStaleness(queue: any[], mesh?: LocalMeshEntry, liveVerifiedNodes?: any[]): any[] {
    const liveness = buildQueueLivenessIndex(mesh, liveVerifiedNodes);
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
