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
}

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
