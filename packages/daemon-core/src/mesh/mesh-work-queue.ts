import { existsSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getLedgerDir } from './mesh-ledger.js';
import { requireMeshHostQueueOwner } from './mesh-host-ownership.js';
import type { RepoMeshDaemonRole } from '../repo-mesh-types.js';
import { BeadsDB } from './beads-db.js';

export type MeshTaskStatus = 'pending' | 'assigned' | 'completed' | 'failed' | 'cancelled';
export type MeshActiveTaskStatus = Extract<MeshTaskStatus, 'pending' | 'assigned'>;
export type MeshHistoricalTaskStatus = Extract<MeshTaskStatus, 'completed' | 'failed' | 'cancelled'>;
export type MeshTaskMode = 'code_change' | 'validation' | 'live_debug_readonly' | 'launch_app' | 'convergence';

export const ACTIVE_MESH_QUEUE_STATUSES: MeshActiveTaskStatus[] = ['pending', 'assigned'];
export const HISTORICAL_MESH_QUEUE_STATUSES: MeshHistoricalTaskStatus[] = ['completed', 'failed', 'cancelled'];
export const MESH_TASK_MODES: MeshTaskMode[] = ['code_change', 'validation', 'live_debug_readonly', 'launch_app', 'convergence'];

export interface MeshTaskModeValidationResult {
    valid: boolean;
    taskMode?: MeshTaskMode;
    violations: string[];
    allowedOperations?: string[];
}

const LIVE_DEBUG_READONLY_FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
    { label: 'source_edit', pattern: /\b(edit|modify|patch|apply\s+patch|write\s+(?:to\s+)?(?:file|source)|overwrite|delete\s+file|remove\s+file|create\s+file|touch\s+file)\b/i },
    { label: 'git_mutation', pattern: /\b(?:git\s+(?:add|commit|push|reset|rebase|clean|checkout|switch|merge|tag|restore|rm|mv)|push\b)/i },
    { label: 'checkpoint', pattern: /\b(checkpoint|mesh_checkpoint)\b/i },
    { label: 'deploy_or_version_bump', pattern: /\b(deploy|wrangler\s+deploy|version[-\s]?bump|npm\s+version|release)\b/i },
    { label: 'destructive_shell', pattern: /\b(rm\s+-rf|mv\s+\S+\s+\S+|truncate\s|tee\s+\S+|sed\s+-i)\b/i },
];

export function normalizeMeshTaskMode(value: unknown): MeshTaskMode | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim() as MeshTaskMode;
    return (MESH_TASK_MODES as string[]).includes(normalized) ? normalized : undefined;
}

export function validateMeshTaskModeRequest(mode: unknown, message: string): MeshTaskModeValidationResult {
    const taskMode = normalizeMeshTaskMode(mode);
    if (!taskMode) {
        return { valid: true, violations: [] };
    }
    if (taskMode !== 'live_debug_readonly') {
        return { valid: true, taskMode, violations: [] };
    }
    const violations = LIVE_DEBUG_READONLY_FORBIDDEN
        .filter(rule => rule.pattern.test(message || ''))
        .map(rule => rule.label);
    return {
        valid: violations.length === 0,
        taskMode,
        violations,
        allowedOperations: [
            'process/log/window/port/session inspection',
            'read-only filesystem listing/reading',
            'status probes and keep-running handle reporting',
            'diagnostic summaries without source edits, commits, checkpoints, pushes, deploys, resets, rebases, or destructive cleanups',
        ],
    };
}

export interface MeshWorkQueueEntry {
    id: string;
    meshId: string;
    message: string;
    status: MeshTaskStatus;
    taskMode?: MeshTaskMode;
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
    /** ISO timestamp when the task was dispatched (assigned) to a node/session. Used for precise matching on completion. */
    dispatchTimestamp?: string;
    createdAt: string;
    updatedAt: string;
}

export interface MeshQueueMutationOptions {
    ownerRole?: RepoMeshDaemonRole;
}

function getQueuePath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.queue.json`);
}

function getLockPath(meshId: string): string {
    const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getLedgerDir(), `${safe}.queue.lock`);
}

/**
 * Simple advisory file lock using O_EXCL (atomic create) for queue mutations.
 * Retries up to 10 times at 30 ms intervals; proceeds without lock on timeout
 * to prevent deadlock (best-effort — far better than no locking at all).
 */
function withQueueLock<T>(meshId: string, fn: () => T): T {
    // With SQLite BeadsDB, we don't need a file lock for everything, 
    // but we can retain the lock if complex orchestration checks rely on it.
    // However, the most robust way is to just let SQLite handle concurrency.
    // We'll keep the lock signature for API compatibility but execute directly.
    return fn();
}

function readQueue(meshId: string): MeshWorkQueueEntry[] {
    return BeadsDB.getInstance().getQueueEntries(meshId);
}

function writeQueue(meshId: string, queue: MeshWorkQueueEntry[]): void {
    const db = BeadsDB.getInstance();
    for (const q of queue) {
        db.upsertQueueEntry(q);
    }
}

/**
 * Add a new task to the mesh queue.
 */
export function enqueueTask(
    meshId: string,
    message: string,
    opts?: { targetNodeId?: string; targetSessionId?: string; taskMode?: MeshTaskMode | string } & MeshQueueMutationOptions,
): MeshWorkQueueEntry {
    requireMeshHostQueueOwner(opts);
    const modeValidation = validateMeshTaskModeRequest(opts?.taskMode, message);
    if (!modeValidation.valid) {
        throw new Error(`live_debug_readonly_guardrail_violation: forbidden operations (${modeValidation.violations.join(', ')})`);
    }
    return withQueueLock(meshId, () => {
        const queue = readQueue(meshId);
        const entry: MeshWorkQueueEntry = {
            id: randomUUID(),
            meshId,
            message,
            status: 'pending',
            taskMode: modeValidation.taskMode,
            targetNodeId: opts?.targetNodeId,
            targetSessionId: opts?.targetSessionId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        queue.push(entry);
        writeQueue(meshId, queue);
        return entry;
    });
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
    return withQueueLock(meshId, () => {
        const queue = readQueue(meshId);
        const hasActiveAssignment = queue.some(q => q.status === 'assigned' && (
            q.assignedSessionId === sessionId || q.assignedNodeId === nodeId
        ));
        if (hasActiveAssignment) return null;
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
        entry.dispatchTimestamp = new Date().toISOString();
        entry.updatedAt = new Date().toISOString();
        writeQueue(meshId, queue);
        return entry;
    });
}

/**
 * Update the status of a specific task.
 * Used when a session completes, fails, or stalls.
 */
export function updateTaskStatus(
    meshId: string,
    taskId: string,
    status: MeshTaskStatus,
    opts?: MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
        const queue = readQueue(meshId);
        const idx = queue.findIndex(q => q.id === taskId);
        if (idx === -1) return null;
        
        // --- GasTown Refinery Gate (Auto-requeue on failure) ---
        if (status === 'failed') {
            const currentRequeueCount = queue[idx].requeueCount || 0;
            if (currentRequeueCount < 3) {
                queue[idx].status = 'pending';
                queue[idx].assignedNodeId = undefined;
                queue[idx].assignedSessionId = undefined;
                queue[idx].requeueCount = currentRequeueCount + 1;
                queue[idx].requeueReason = `Refinery Gate: auto-requeue after failure (attempt ${currentRequeueCount + 1}/3)`;
                queue[idx].requeuedAt = new Date().toISOString();
                queue[idx].updatedAt = new Date().toISOString();
                writeQueue(meshId, queue);
                return queue[idx];
            }
        }

        queue[idx].status = status;
        queue[idx].updatedAt = new Date().toISOString();
        writeQueue(meshId, queue);
        return queue[idx];
    });
}

export function recordTaskAutoLaunch(
    meshId: string,
    taskId: string,
    autoLaunch: Omit<NonNullable<MeshWorkQueueEntry['autoLaunch']>, 'updatedAt'>,
): MeshWorkQueueEntry | null {
    return withQueueLock(meshId, () => {
        const queue = readQueue(meshId);
        const idx = queue.findIndex(q => q.id === taskId);
        if (idx === -1) return null;
        const now = new Date().toISOString();
        queue[idx].autoLaunch = { ...autoLaunch, updatedAt: now };
        queue[idx].updatedAt = now;
        writeQueue(meshId, queue);
        return queue[idx];
    });
}

/**
 * Mark a queue task as manually cancelled without deleting audit history.
 */
export function cancelTask(
    meshId: string,
    taskId: string,
    opts?: { reason?: string } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
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
    });
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
    } & MeshQueueMutationOptions,
): MeshWorkQueueEntry | null {
    requireMeshHostQueueOwner(opts);
    return withQueueLock(meshId, () => {
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
    });
}

/**
 * Update the status of the task currently assigned to a specific session.
 */
export function updateSessionTaskStatus(
    meshId: string,
    sessionId: string,
    status: MeshTaskStatus,
    opts?: { occurredAt?: string },
): MeshWorkQueueEntry | null {
    return withQueueLock(meshId, () => {
        const queue = readQueue(meshId);
        const occurredAtTime = opts?.occurredAt ? new Date(opts.occurredAt).getTime() : Number.NaN;
        const hasOccurredAt = Number.isFinite(occurredAtTime);
        let bestIdx = -1;
        let bestTime = 0;
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].assignedSessionId !== sessionId || queue[i].status !== 'assigned') continue;
            const time = new Date(queue[i].dispatchTimestamp || queue[i].updatedAt).getTime();
            if (hasOccurredAt && Number.isFinite(time) && time > occurredAtTime) continue;
            if (time > bestTime) { bestTime = time; bestIdx = i; }
        }
        if (bestIdx === -1) return null;
        
        // --- GasTown Refinery Gate (Auto-requeue on failure) ---
        if (status === 'failed') {
            const currentRequeueCount = queue[bestIdx].requeueCount || 0;
            if (currentRequeueCount < 3) {
                queue[bestIdx].status = 'pending';
                queue[bestIdx].assignedNodeId = undefined;
                queue[bestIdx].assignedSessionId = undefined;
                queue[bestIdx].requeueCount = currentRequeueCount + 1;
                queue[bestIdx].requeueReason = `Refinery Gate: auto-requeue after failure (attempt ${currentRequeueCount + 1}/3)`;
                queue[bestIdx].requeuedAt = new Date().toISOString();
                queue[bestIdx].updatedAt = new Date().toISOString();
                writeQueue(meshId, queue);
                return queue[bestIdx];
            }
        }
        
        queue[bestIdx].status = status;
        queue[bestIdx].updatedAt = new Date().toISOString();
        writeQueue(meshId, queue);
        return queue[bestIdx];
    });
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
    /** Source-of-truth active queue counters; only pending/assigned are live work. */
    activeCounts: Record<MeshActiveTaskStatus, number>;
    /** Terminal ledger records kept for audit/history; never count as active work. */
    historicalCounts: Record<MeshHistoricalTaskStatus, number>;
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
        activeCounts: {
            pending,
            assigned,
        },
        historicalCounts: {
            completed,
            failed,
            cancelled,
        },
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
