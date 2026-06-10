/**
 * M7: Operational stats (time/attempts) derived from existing truth.
 *
 * No cost/token accounting — ADHDev observes PTY/CDP and cannot see API
 * tokens (explicit non-goal). Everything here is derived at query time from
 * the SQLite ledger and queue rows; there is no separate aggregate table.
 * Tasks with missing ledger evidence report incompleteEvidence instead of
 * estimated numbers.
 */

import { readLedgerEntries } from './mesh-ledger.js';
import type { MeshLedgerEntry } from './mesh-ledger.js';
import { getQueue } from './mesh-work-queue.js';

export interface MeshTaskStats {
    taskId: string;
    status: string;
    dispatchedAt: string | null;
    terminalAt: string | null;
    terminalKind: 'task_completed' | 'task_failed' | null;
    /** dispatched → terminal wall clock; null when evidence is incomplete. */
    durationMs: number | null;
    /** Number of task_dispatched ledger entries observed for this task. */
    dispatchCount: number;
    /** Queue requeueCount (0 when the row is gone or never requeued). */
    requeueCount: number;
    /** True when dispatch or terminal ledger evidence is missing — numbers are withheld, never estimated. */
    incompleteEvidence?: true;
}

export interface MeshMissionStats {
    missionId: string;
    taskCount: number;
    completed: number;
    failed: number;
    /** Sum of per-task durations with complete evidence. */
    totalDurationMs: number;
    /** First dispatch → last terminal across the mission's tasks; null without complete endpoints. */
    wallClockMs: number | null;
    /** Total requeue attempts across the mission's tasks. */
    retries: number;
    /** Task ids whose ledger evidence was incomplete (excluded from sums). */
    incompleteTaskIds: string[];
}

function readPayloadTaskId(entry: MeshLedgerEntry): string {
    const value = entry.payload?.taskId;
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function parseTime(value: string | null | undefined): number | null {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compute per-task stats from ledger entries. Scans a bounded tail window —
 * stats are an operational view of recent work, not a full historical report.
 */
export function computeMeshTaskStats(meshId: string, opts?: { taskIds?: string[]; missionId?: string; tail?: number }): MeshTaskStats[] {
    const queue = getQueue(meshId);
    const queueById = new Map(queue.map(task => [task.id, task]));

    let targetIds: string[];
    if (opts?.taskIds?.length) {
        targetIds = [...new Set(opts.taskIds)];
    } else if (opts?.missionId) {
        targetIds = queue.filter(task => task.missionId === opts.missionId).map(task => task.id);
    } else {
        targetIds = queue.map(task => task.id);
    }
    if (targetIds.length === 0) return [];
    const targetSet = new Set(targetIds);

    const entries = readLedgerEntries(meshId, { tail: opts?.tail ?? 1000 });
    const dispatches = new Map<string, { first: string; count: number }>();
    const terminals = new Map<string, { at: string; kind: 'task_completed' | 'task_failed' }>();
    for (const entry of entries) {
        const taskId = readPayloadTaskId(entry);
        if (!taskId || !targetSet.has(taskId)) continue;
        if (entry.kind === 'task_dispatched') {
            const existing = dispatches.get(taskId);
            if (existing) existing.count += 1;
            else dispatches.set(taskId, { first: entry.timestamp, count: 1 });
        } else if (entry.kind === 'task_completed' || entry.kind === 'task_failed') {
            // Last terminal wins (requeued tasks can have multiple terminals).
            terminals.set(taskId, { at: entry.timestamp, kind: entry.kind });
        }
    }

    return targetIds.map(taskId => {
        const queueEntry = queueById.get(taskId);
        const status = queueEntry?.status ?? 'unknown';
        const dispatch = dispatches.get(taskId);
        const terminal = terminals.get(taskId);
        const isTerminalStatus = status === 'completed' || status === 'failed' || status === 'cancelled';
        const dispatchTime = parseTime(dispatch?.first ?? queueEntry?.dispatchTimestamp);
        const terminalTime = parseTime(terminal?.at);
        const stats: MeshTaskStats = {
            taskId,
            status,
            dispatchedAt: dispatch?.first ?? queueEntry?.dispatchTimestamp ?? null,
            terminalAt: terminal?.at ?? null,
            terminalKind: terminal?.kind ?? null,
            durationMs: null,
            dispatchCount: dispatch?.count ?? 0,
            requeueCount: queueEntry?.requeueCount ?? 0,
        };
        if (dispatchTime !== null && terminalTime !== null && terminalTime >= dispatchTime) {
            stats.durationMs = terminalTime - dispatchTime;
        } else if (isTerminalStatus) {
            // Terminal task without complete dispatch+terminal ledger evidence:
            // withhold numbers rather than estimate (M7 rule).
            stats.incompleteEvidence = true;
        }
        return stats;
    });
}

/** Mission rollup — derived from per-task stats, no stored aggregates. */
export function computeMeshMissionStats(meshId: string, missionId: string): MeshMissionStats {
    const tasks = computeMeshTaskStats(meshId, { missionId });
    const stats: MeshMissionStats = {
        missionId,
        taskCount: tasks.length,
        completed: 0,
        failed: 0,
        totalDurationMs: 0,
        wallClockMs: null,
        retries: 0,
        incompleteTaskIds: [],
    };
    let firstDispatch: number | null = null;
    let lastTerminal: number | null = null;
    for (const task of tasks) {
        if (task.status === 'completed') stats.completed += 1;
        else if (task.status === 'failed') stats.failed += 1;
        stats.retries += task.requeueCount;
        if (task.incompleteEvidence) {
            stats.incompleteTaskIds.push(task.taskId);
            continue;
        }
        if (task.durationMs !== null) stats.totalDurationMs += task.durationMs;
        const dispatchTime = parseTime(task.dispatchedAt);
        const terminalTime = parseTime(task.terminalAt);
        if (dispatchTime !== null && (firstDispatch === null || dispatchTime < firstDispatch)) firstDispatch = dispatchTime;
        if (terminalTime !== null && (lastTerminal === null || terminalTime > lastTerminal)) lastTerminal = terminalTime;
    }
    if (firstDispatch !== null && lastTerminal !== null && lastTerminal >= firstDispatch) {
        stats.wallClockMs = lastTerminal - firstDispatch;
    }
    return stats;
}
