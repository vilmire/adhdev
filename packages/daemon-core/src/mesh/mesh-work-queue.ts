import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getLedgerDir } from './mesh-ledger.js';

export type MeshTaskStatus = 'pending' | 'assigned' | 'completed' | 'failed';

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
    pending: number;
    assigned: number;
    completed: number;
    failed: number;
}

/**
 * Return aggregate queue statistics for the given mesh.
 */
export function getMeshQueueStats(meshId: string): MeshWorkQueueStats {
    const queue = readQueue(meshId);
    return {
        pending: queue.filter(q => q.status === 'pending').length,
        assigned: queue.filter(q => q.status === 'assigned').length,
        completed: queue.filter(q => q.status === 'completed').length,
        failed: queue.filter(q => q.status === 'failed').length,
    };
}
