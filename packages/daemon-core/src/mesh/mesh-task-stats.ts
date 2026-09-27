/**
 * M7: Operational stats (time/attempts) derived from existing truth.
 *
 * No cost/token accounting — ADHDev observes PTY/CDP and cannot see API
 * tokens (explicit non-goal). Everything here is derived at query time from
 * the SQLite ledger and queue rows; there is no separate aggregate table.
 * Tasks with missing ledger evidence report incompleteEvidence instead of
 * estimated numbers.
 */

// C3 `own` read (wiring-unification C-W3): the coordinator owns every attempt
// it dispatched, so task lifecycle comes from this daemon's own writer on the
// topic index (task_dispatched records) plus the turn tables (terminals).
import { meshTopicIndexFor, readOwnTaskLifecycle, type MeshIndexView } from './mesh-topic-index.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { meshPublisherWriterId } from '../seqscribe/mesh-publisher.js';
import type { MeshQueueFacts } from './mesh-runtime-store-queue-reads.js';

type ProjectedLedgerView = MeshIndexView;

function readTaskStatsEntries(meshId: string, tail: number): ProjectedLedgerView[] {
    const store = MeshRuntimeStore.getInstance();
    return readOwnTaskLifecycle(meshTopicIndexFor(store.db), store.turnStore(), meshId, { ownWriter: meshPublisherWriterId(), tail });
}

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

function readPayloadTaskId(entry: ProjectedLedgerView): string {
    // ★ payload.taskId ONLY — deliberately not the `taskId` base field, and not
    // a fallback between them. The two are not interchangeable: meshRecord
    // derives the base field FROM payload.taskId for the task-lifecycle kinds,
    // but an explicitly-set base field wins over the payload, so a kind that
    // sets `taskId` directly without a payload copy would start matching here if
    // this preferred the base field. Both keys survive the projection, so this
    // resolves identically on either read path — the constraint is preserving
    // THIS site's pre-cutover semantics, not using the richer field.
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
    // Slim queue read (json_extract of the scalars below) — not getQueue(), which
    // JSON.parses every payload of the mesh (MCP read-latency pass, 2026-09-27).
    const queue = MeshRuntimeStore.getInstance().getQueueFacts(meshId);

    let targetIds: string[];
    if (opts?.taskIds?.length) {
        targetIds = [...new Set(opts.taskIds)];
    } else if (opts?.missionId) {
        targetIds = queue.filter(task => task.missionId === opts.missionId).map(task => task.id);
    } else {
        targetIds = queue.map(task => task.id);
    }
    if (targetIds.length === 0) return [];
    return taskStatsFromFacts(queue, readTaskStatsEntries(meshId, opts?.tail ?? 1000), targetIds);
}

/** Per-task stats for `targetIds` from an already-read queue + record window (no I/O). */
function taskStatsFromFacts(queue: readonly MeshQueueFacts[], entries: readonly ProjectedLedgerView[], targetIds: string[]): MeshTaskStats[] {
    const queueById = new Map(queue.map(task => [task.id, task]));
    const targetSet = new Set(targetIds);
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
        const dispatch = dispatches.get(taskId);
        const terminal = terminals.get(taskId);
        // Direct dispatches (mesh_send_task) have no work-queue row, so queueEntry is undefined.
        // Derive a terminal status from the attributed terminal ledger entry instead of reporting
        // status='unknown' — without this a completed direct task showed unknown + terminalKind=null
        // even though its task_completed event fired (see mesh-events-coordinator Fix B attribution).
        const status = queueEntry?.status
            ?? (terminal
                ? (terminal.kind === 'task_completed' ? 'completed' : 'failed')
                : 'unknown');
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
    return computeMeshMissionStatsBatch(meshId, [missionId]).get(missionId)!;
}

/**
 * Mission rollups for several missions in ONE pass: one slim queue read and ONE
 * record-window read shared by every mission. Before 2026-09-27 each rollup did
 * its own full `getQueue` parse + record read (twice, when task_stats_query also
 * computed the per-task list), and mesh_status verbose / the dashboard mission
 * list asked for one rollup per mission — O(missions × queue) daemon work,
 * measured at multiple seconds on the preview daemon. Every id gets an entry.
 */
export function computeMeshMissionStatsBatch(meshId: string, missionIds: readonly string[], opts?: { tail?: number }): Map<string, MeshMissionStats> {
    const out = new Map<string, MeshMissionStats>();
    const wanted = [...new Set(missionIds)];
    if (wanted.length === 0) return out;
    const queue = MeshRuntimeStore.getInstance().getQueueFacts(meshId);
    const wantedSet = new Set(wanted);
    const taskIdsByMission = new Map<string, string[]>(wanted.map(id => [id, [] as string[]]));
    for (const task of queue) {
        if (task.missionId && wantedSet.has(task.missionId)) taskIdsByMission.get(task.missionId)!.push(task.id);
    }
    const anyTasks = [...taskIdsByMission.values()].some(ids => ids.length > 0);
    const entries = anyTasks ? readTaskStatsEntries(meshId, opts?.tail ?? 1000) : [];
    for (const missionId of wanted) {
        const ids = taskIdsByMission.get(missionId)!;
        out.set(missionId, rollupMissionStats(missionId, ids.length > 0 ? taskStatsFromFacts(queue, entries, ids) : []));
    }
    return out;
}

/** Mission rollup from its per-task stats (pure). */
export function rollupMissionStats(missionId: string, tasks: readonly MeshTaskStats[]): MeshMissionStats {
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
