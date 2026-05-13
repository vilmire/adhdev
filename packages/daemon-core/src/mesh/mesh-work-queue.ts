import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getLedgerDir } from './mesh-ledger.js';

export type MeshTaskStatus = 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled';

export interface MeshWorkQueueEntry {
    id: string;
    meshId: string;
    message: string;
    status: MeshTaskStatus;
    /** If specified, only this node can claim the task (used by legacy mesh_send_task) */
    targetNodeId?: string;
    /** If specified, only this runtime session can claim the task */
    targetSessionId?: string;
    /** The node that actually claimed and is executing the task */
    assignedNodeId?: string;
    /** The session currently executing the task */
    assignedSessionId?: string;
    /** Human/operator reason for terminal cancellation. */
    cancelReason?: string;
    cancelledAt?: string;
    /** Human/operator reason for manually requeueing a task. */
    requeueReason?: string;
    requeuedAt?: string;
    requeueCount?: number;
    /** Last automatic queue session spin-up attempt, for mesh_view_queue/debug visibility. */
    autoLaunch?: {
        status: 'skipped' | 'started' | 'failed' | 'completed';
        reason?: string;
        nodeId?: string;
        providerType?: string;
        sessionId?: string;
        updatedAt: string;
    };
    createdAt: string;
    updatedAt: string;
}

function getQueuePath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.queue.json`);
}

function readQueue(meshId: string): MeshWorkQueueEntry[] {
    const path = getQueuePath(meshId);
    if (!existsSync(path)) return [];
    try {
        const content = readFileSync(path, 'utf-8');
        return JSON.parse(content) as MeshWorkQueueEntry[];
    } catch {
        return [];
    }
}

function writeQueue(meshId: string, queue: MeshWorkQueueEntry[]): void {
    const path = getQueuePath(meshId);
    writeFileSync(path, JSON.stringify(queue, null, 2), 'utf-8');
}

/**
 * Add a new task to the mesh queue.
 */
export function enqueueTask(
    meshId: string,
    message: string,
    opts?: { targetNodeId?: string; targetSessionId?: string }
): MeshWorkQueueEntry {
    const queue = readQueue(meshId);
    const entry: MeshWorkQueueEntry = {
        id: randomUUID(),
        meshId,
        message,
        status: 'pending',
        targetNodeId: opts?.targetNodeId,
        targetSessionId: opts?.targetSessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    queue.push(entry);
    writeQueue(meshId, queue);
    return entry;
}

/**
 * Get all tasks in the queue, optionally filtered by status.
 */
export function getQueue(meshId: string, opts?: { status?: MeshTaskStatus[] }): MeshWorkQueueEntry[] {
    let queue = readQueue(meshId);
    if (opts?.status?.length) {
        const statuses = new Set(opts.status);
        queue = queue.filter(q => statuses.has(q.status));
    }
    return queue;
}

/**
 * Find the next pending task that this node is allowed to claim, and mark it as assigned.
 */
export function claimNextTask(meshId: string, nodeId: string, sessionId: string): MeshWorkQueueEntry | null {
    const queue = readQueue(meshId);

    // A worker must finish or fail its current queued assignment before it can
    // claim another one. maxParallelTasks limits total mesh concurrency; it is
    // not permission for one node/session to accumulate multiple assigned items.
    const hasActiveAssignment = queue.some(q => q.status === 'assigned' && (
        q.assignedSessionId === sessionId || q.assignedNodeId === nodeId
    ));
    if (hasActiveAssignment) return null;
    
    // Find highest priority task:
    // 1. Pending tasks explicitly targeted at this runtime session
    // 2. Pending tasks explicitly targeted at this node (but not another session)
    // 3. Pending tasks with no target node/session
    let targetIdx = queue.findIndex(q => q.status === 'pending' && q.targetSessionId === sessionId);
    if (targetIdx === -1) {
        targetIdx = queue.findIndex(q => q.status === 'pending' && q.targetNodeId === nodeId && !q.targetSessionId);
    }
    if (targetIdx === -1) {
        targetIdx = queue.findIndex(q => q.status === 'pending' && !q.targetNodeId && !q.targetSessionId);
    }

    if (targetIdx === -1) return null;

    const entry = queue[targetIdx];
    entry.status = 'assigned';
    entry.assignedNodeId = nodeId;
    entry.assignedSessionId = sessionId;
    entry.updatedAt = new Date().toISOString();

    writeQueue(meshId, queue);
    return entry;
}

/**
 * Update the status of a specific task.
 * Used when a session completes, fails, or stalls.
 */
export function updateTaskStatus(
    meshId: string,
    taskId: string,
    status: MeshTaskStatus,
): MeshWorkQueueEntry | null {
    const queue = readQueue(meshId);
    const idx = queue.findIndex(q => q.id === taskId);
    if (idx === -1) return null;

    queue[idx].status = status;
    queue[idx].updatedAt = new Date().toISOString();
    writeQueue(meshId, queue);
    return queue[idx];
}

export function recordTaskAutoLaunch(
    meshId: string,
    taskId: string,
    autoLaunch: Omit<NonNullable<MeshWorkQueueEntry['autoLaunch']>, 'updatedAt'>,
): MeshWorkQueueEntry | null {
    const queue = readQueue(meshId);
    const idx = queue.findIndex(q => q.id === taskId);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    queue[idx].autoLaunch = {
        ...autoLaunch,
        updatedAt: now,
    };
    queue[idx].updatedAt = now;
    writeQueue(meshId, queue);
    return queue[idx];
}

/**
 * Mark a queue task as manually cancelled without deleting audit history.
 */
export function cancelTask(
    meshId: string,
    taskId: string,
    opts?: { reason?: string },
): MeshWorkQueueEntry | null {
    const queue = readQueue(meshId);
    const idx = queue.findIndex(q => q.id === taskId);
    if (idx === -1) return null;

    const now = new Date().toISOString();
    queue[idx].status = 'cancelled';
    queue[idx].updatedAt = now;
    queue[idx].cancelledAt = now;
    if (opts?.reason) queue[idx].cancelReason = opts.reason;
    writeQueue(meshId, queue);
    return queue[idx];
}

/**
 * Return a queue task to pending for retry. By default, dead session targeting
 * and assigned ownership are cleared so stale assignments do not strand again.
 */
export function requeueTask(
    meshId: string,
    taskId: string,
    opts?: {
        reason?: string;
        targetNodeId?: string;
        targetSessionId?: string;
        clearTargetNode?: boolean;
        clearTargetSession?: boolean;
    },
): MeshWorkQueueEntry | null {
    const queue = readQueue(meshId);
    const idx = queue.findIndex(q => q.id === taskId);
    if (idx === -1) return null;

    const entry = queue[idx];
    const now = new Date().toISOString();
    entry.status = 'pending';
    delete entry.assignedNodeId;
    delete entry.assignedSessionId;
    delete entry.cancelledAt;
    delete entry.cancelReason;
    if (opts?.clearTargetNode) delete entry.targetNodeId;
    if (typeof opts?.targetNodeId === 'string') entry.targetNodeId = opts.targetNodeId;
    if (opts?.clearTargetSession !== false) delete entry.targetSessionId;
    if (typeof opts?.targetSessionId === 'string') entry.targetSessionId = opts.targetSessionId;
    entry.updatedAt = now;
    entry.requeuedAt = now;
    entry.requeueCount = (entry.requeueCount || 0) + 1;
    if (opts?.reason) entry.requeueReason = opts.reason;
    writeQueue(meshId, queue);
    return entry;
}

/**
 * Update the status of the task currently assigned to a specific session.
 */
export function updateSessionTaskStatus(
    meshId: string,
    sessionId: string,
    status: MeshTaskStatus,
): MeshWorkQueueEntry | null {
    const queue = readQueue(meshId);
    // Find the most recently assigned task for this session that isn't already terminal
    // (In case multiple tasks were assigned to the same session over time, though rare)
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].assignedSessionId === sessionId && queue[i].status === 'assigned') {
            queue[i].status = status;
            queue[i].updatedAt = new Date().toISOString();
            writeQueue(meshId, queue);
            return queue[i];
        }
    }
    return null;
}

export interface MeshWorkQueueStats {
    total: number;
    active: number;
    historical: number;
    pending: number;
    assigned: number;
    completed: number;
    failed: number;
    cancelled: number;
    activeAssignments: Array<{
        id: string;
        nodeId?: string;
        sessionId?: string;
        message: string;
    }>;
}

/**
 * Return aggregate queue statistics for the given mesh.
 */
export function getMeshQueueStats(meshId: string): MeshWorkQueueStats {
    const queue = readQueue(meshId);
    const pending = queue.filter(q => q.status === 'pending').length;
    const assigned = queue.filter(q => q.status === 'assigned').length;
    const completed = queue.filter(q => q.status === 'completed').length;
    const failed = queue.filter(q => q.status === 'failed').length;
    const cancelled = queue.filter(q => q.status === 'cancelled').length;
    return {
        total: queue.length,
        active: pending + assigned,
        historical: completed + failed + cancelled,
        pending,
        assigned,
        completed,
        failed,
        cancelled,
        activeAssignments: queue
            .filter(q => q.status === 'assigned')
            .map(q => ({
                id: q.id,
                nodeId: q.assignedNodeId,
                sessionId: q.assignedSessionId,
                message: q.message,
            })),
    };
}
