/**
 * M3: Mission persistence (minimal form).
 *
 * A mission is a persistent record of a multi-task goal so the plan lives in
 * the system rather than in the coordinator LLM's context. Coordinator
 * sessions can die or compact; a new coordinator reads the mission back at
 * launch and continues.
 *
 * Explicit non-goals (see docs/mesh-product-plan-v2.md Phase M3): this is not
 * a workflow engine and there is no automatic takeover daemon. Progress is
 * never stored — it is derived from queue task statuses (mission_id) at
 * query time.
 */

import { randomUUID } from 'crypto';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getQueue } from './mesh-work-queue.js';
import { computeMeshMissionStats, type MeshMissionStats } from './mesh-task-stats.js';

export type MeshMissionStatus = 'active' | 'paused' | 'completed' | 'abandoned';

export const MESH_MISSION_STATUSES: MeshMissionStatus[] = ['active', 'paused', 'completed', 'abandoned'];

export interface MeshMissionRecord {
    id: string;
    meshId: string;
    title: string;
    goal: string;
    status: MeshMissionStatus;
    createdAt: string;
    updatedAt: string;
}

export interface MeshMissionTaskAggregate {
    total: number;
    pending: number;
    assigned: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Pending tasks held back by a dependency failure (blockedReason set). */
    blocked: number;
    /** Latest updatedAt across the mission's tasks, or null with no tasks. */
    lastActivityAt: string | null;
}

export interface MeshMissionSummary extends MeshMissionRecord {
    tasks: MeshMissionTaskAggregate;
    /**
     * Operational rollup (durations / attempts) derived from the ledger via
     * computeMeshMissionStats. Optional: only populated by surfaces that opt in
     * (e.g. mesh_status), since the rollup scans a bounded ledger tail per
     * mission. Absent on the lightweight task-aggregate-only summaries.
     */
    stats?: MeshMissionStats;
}

/**
 * Slim mission summary for the mesh_status compact (default) surface. Drops the
 * full `goal` text — which can be hundreds of chars per mission and is repeated
 * for every mission on every status call — keeping only a short preview plus a
 * `goalTruncated` flag when the original was longer. The stored goal is never
 * mutated; this is an output-only projection. Coordinators that need the full
 * goal call mesh_status with verbose=true, or read the mission directly via
 * mesh_mission_upsert / getMeshMission.
 */
export interface MeshMissionSlimSummary extends Omit<MeshMissionSummary, 'goal'> {
    /** Short preview of the goal (≤ GOAL_PREVIEW_MAX chars), '' when goal empty. */
    goalPreview: string;
    /** True when the stored goal was longer than the preview (full text elided). */
    goalTruncated: boolean;
}

/** Max chars of goal text retained in the slim (compact) mission summary. */
export const GOAL_PREVIEW_MAX = 120;

function normalizeMissionStatus(value: unknown): MeshMissionStatus {
    return MESH_MISSION_STATUSES.includes(value as MeshMissionStatus)
        ? value as MeshMissionStatus
        : 'active';
}

export function upsertMeshMission(meshId: string, input: {
    id?: string;
    title: string;
    goal?: string;
    status?: string;
}): MeshMissionRecord {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('mission_title_required: a mission needs a non-empty title');
    if (input.status !== undefined && !MESH_MISSION_STATUSES.includes(input.status as MeshMissionStatus)) {
        throw new Error(`invalid_mission_status: '${input.status}' (valid: ${MESH_MISSION_STATUSES.join(', ')})`);
    }
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID();
    const store = MeshRuntimeStore.getInstance();
    const existing = store.getMission(meshId, id);
    const record = {
        id,
        meshId,
        title,
        goal: typeof input.goal === 'string' ? input.goal : existing?.goal ?? '',
        status: normalizeMissionStatus(input.status ?? existing?.status),
    };
    store.upsertMission(record);
    const saved = store.getMission(meshId, id)!;
    return { ...saved, status: normalizeMissionStatus(saved.status) };
}

export function getMeshMissions(meshId: string, statuses?: MeshMissionStatus[]): MeshMissionRecord[] {
    return MeshRuntimeStore.getInstance().getMissions(meshId, statuses)
        .map(m => ({ ...m, status: normalizeMissionStatus(m.status) }));
}

export function getMeshMission(meshId: string, missionId: string): MeshMissionRecord | null {
    const record = MeshRuntimeStore.getInstance().getMission(meshId, missionId);
    return record ? { ...record, status: normalizeMissionStatus(record.status) } : null;
}

/** Aggregate task statuses for a mission at query time (no stored progress). */
export function summarizeMissionTasks(meshId: string, missionId: string): MeshMissionTaskAggregate {
    const tasks = getQueue(meshId).filter(task => task.missionId === missionId);
    const aggregate: MeshMissionTaskAggregate = {
        total: tasks.length,
        pending: 0,
        assigned: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        blocked: 0,
        lastActivityAt: null,
    };
    for (const task of tasks) {
        if (task.status === 'pending') aggregate.pending += 1;
        else if (task.status === 'assigned') aggregate.assigned += 1;
        else if (task.status === 'completed') aggregate.completed += 1;
        else if (task.status === 'failed') aggregate.failed += 1;
        else if (task.status === 'cancelled') aggregate.cancelled += 1;
        if (task.status === 'pending' && task.blockedReason) aggregate.blocked += 1;
        if (task.updatedAt && (!aggregate.lastActivityAt || task.updatedAt > aggregate.lastActivityAt)) {
            aggregate.lastActivityAt = task.updatedAt;
        }
    }
    return aggregate;
}

export function summarizeMeshMission(meshId: string, mission: MeshMissionRecord): MeshMissionSummary {
    return { ...mission, tasks: summarizeMissionTasks(meshId, mission.id) };
}

/** Active mission summaries for mesh_status / coordinator prompt injection. */
export function getActiveMeshMissionSummaries(meshId: string): MeshMissionSummary[] {
    return getMeshMissions(meshId, ['active']).map(mission => summarizeMeshMission(meshId, mission));
}

/** Project a full mission summary down to the slim (goal-elided) shape. */
function slimMissionSummary(summary: MeshMissionSummary): MeshMissionSlimSummary {
    const goal = typeof summary.goal === 'string' ? summary.goal : '';
    const goalTruncated = goal.length > GOAL_PREVIEW_MAX;
    const { goal: _omitGoal, ...rest } = summary;
    return {
        ...rest,
        goalPreview: goalTruncated ? goal.slice(0, GOAL_PREVIEW_MAX) : goal,
        goalTruncated,
    };
}

/**
 * Mission summaries for the mesh_status dashboard surface: every active/paused
 * mission plus a capped, newest-first slice of completed/abandoned history so
 * the dashboard can render a collapsible "history" section without unbounded
 * payload growth. Returned newest-first within each group (active/paused first,
 * then history), so the frontend can split on `status` directly.
 *
 * Compact mode (the default) elides each mission's full `goal` text — which is
 * repeated verbatim on every status poll and dominates the payload when a mesh
 * has many missions — returning only a short `goalPreview` + `goalTruncated`
 * flag. Pass `verbose: true` to get the full `goal` text per mission. The stored
 * goal is untouched in both modes; this is an output-only projection.
 */
export function getMeshStatusMissionSummaries(
    meshId: string,
    options?: { historyLimit?: number; verbose?: boolean; withStats?: boolean },
): MeshMissionSummary[] | MeshMissionSlimSummary[] {
    const historyLimit = Math.max(0, options?.historyLimit ?? 10);
    const all = getMeshMissions(meshId);
    const live = all.filter(m => m.status === 'active' || m.status === 'paused');
    const history = all
        .filter(m => m.status === 'completed' || m.status === 'abandoned')
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, historyLimit);
    let full = [...live, ...history].map(mission => summarizeMeshMission(meshId, mission));
    // Operational stats (durations / attempts) are an opt-in projection: each
    // mission's rollup scans a bounded ledger tail, so we only compute it for
    // the bounded set we are about to return (live + capped history), not for
    // every mission in the mesh. The dashboard graph opts in so mission detail
    // can show wall-clock / retries without a second round trip.
    if (options?.withStats) {
        full = full.map(summary => ({ ...summary, stats: computeMeshMissionStats(meshId, summary.id) }));
    }
    return options?.verbose ? full : full.map(slimMissionSummary);
}

/**
 * Read-only mission listing for the mesh_mission_list tool. Returns summaries
 * (record + live task aggregate) for missions matching `statuses` — or every
 * mission when `statuses` is omitted/empty — newest-first by updatedAt. Unlike
 * getMeshStatusMissionSummaries this does NOT cap or group by lifecycle, so a
 * coordinator can deliberately surface paused/abandoned/completed missions that
 * the live status view would hide or truncate.
 *
 * Compact (the default) elides each goal to a capped preview + goalTruncated
 * flag; verbose returns the full goal text. The stored goal is never mutated.
 */
export function listMeshMissionSummaries(
    meshId: string,
    options?: { statuses?: MeshMissionStatus[]; verbose?: boolean },
): MeshMissionSummary[] | MeshMissionSlimSummary[] {
    const statuses = options?.statuses && options.statuses.length > 0 ? options.statuses : undefined;
    const missions = getMeshMissions(meshId, statuses)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const full = missions.map(mission => summarizeMeshMission(meshId, mission));
    return options?.verbose ? full : full.map(slimMissionSummary);
}

/**
 * M3-3: render active missions as a prompt section for {{mission}}.
 * Empty string when no active mission — the prompt stays byte-identical to
 * the pre-M3 output in that case (regression guarantee).
 */
export function buildMissionPromptSection(meshId: string): string {
    const summaries = getActiveMeshMissionSummaries(meshId);
    if (summaries.length === 0) return '';
    const lines: string[] = ['## Active Mission' + (summaries.length > 1 ? 's' : '')];
    for (const mission of summaries) {
        const t = mission.tasks;
        lines.push(
            `- **${mission.title}** (id: \`${mission.id}\`)`
            + (mission.goal ? `\n  Goal: ${mission.goal}` : '')
            + `\n  Tasks: ${t.total} total — ${t.pending} pending (${t.blocked} blocked), ${t.assigned} assigned, ${t.completed} completed, ${t.failed} failed, ${t.cancelled} cancelled`
            + (t.lastActivityAt ? `\n  Last activity: ${t.lastActivityAt}` : ''),
        );
    }
    lines.push(
        'Continue this mission from its current task state. Do not re-enqueue tasks that already exist — check mesh_view_queue first. '
        + 'Update the mission with mesh_mission_upsert when its goal changes or it reaches a terminal state (completed/abandoned).',
    );
    return lines.join('\n');
}
