// Review-in-task §2 metrics, derived at query time from queue rows (no aggregate tables).
// Pure: takes the mesh's queue rows. Not yet wired into mesh_status / mesh_mission_list (see the stage doc §10).

import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { isStageChild, isStageParent } from './stage-state.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';

export interface StageReviewStats {
    stageTasks: number;
    /** 1: dispatches the coordinator created (stage children excluded), per mission. */
    coordinatorRowsByMission: Record<string, number>;
    /** 2: every row including daemon-created review children, per mission. */
    allRowsByMission: Record<string, number>;
    /** 4: stage parents whose FIRST review found blocking/major findings that a later round resolved. */
    firstReviewFoundDefects: number;
    approvedStageTasks: number;
    /** 6: rounds distribution of finished stage parents (key = rounds used) and blocked counts by reason. */
    roundsDistribution: Record<string, number>;
    blockedByReason: Record<string, number>;
    /** 7: share of finished stage tasks reviewed through the fresh-session fallback. */
    independenceFallback: { used: number; total: number; share: number };
}

export function computeStageReviewStats(queue: readonly MeshWorkQueueEntry[]): StageReviewStats {
    const out: StageReviewStats = {
        stageTasks: 0, coordinatorRowsByMission: {}, allRowsByMission: {}, firstReviewFoundDefects: 0, approvedStageTasks: 0,
        roundsDistribution: {}, blockedByReason: {}, independenceFallback: { used: 0, total: 0, share: 0 },
    };
    for (const row of queue) {
        const mission = row.missionId ?? '(none)';
        out.allRowsByMission[mission] = (out.allRowsByMission[mission] ?? 0) + 1;
        if (!isStageChild(row)) out.coordinatorRowsByMission[mission] = (out.coordinatorRowsByMission[mission] ?? 0) + 1;
        if (!isStageParent(row)) continue;
        out.stageTasks += 1;
        const s = row.stageState!;
        if (!s.released && row.status !== 'completed' && row.status !== 'blocked') continue; // still running
        const rounds = String(s.round);
        out.roundsDistribution[rounds] = (out.roundsDistribution[rounds] ?? 0) + 1;
        if (row.status === 'blocked' && s.blockedReason) out.blockedByReason[s.blockedReason] = (out.blockedByReason[s.blockedReason] ?? 0) + 1;
        if (row.status === 'completed' && s.lastVerdict) {
            out.approvedStageTasks += 1;
            if (s.round > 1) out.firstReviewFoundDefects += 1;
        }
        if (s.independenceUsed) {
            out.independenceFallback.total += 1;
            if (s.independenceUsed === 'fresh_session_fallback') out.independenceFallback.used += 1;
        }
    }
    const f = out.independenceFallback;
    f.share = f.total ? f.used / f.total : 0;
    return out;
}

/**
 * Slim read of the stage-relevant fields of every queue row of a mesh (no full payload parse of the whole queue).
 * Rows keep only what computeStageReviewStats looks at.
 */
export function readStageStatsRows(meshId: string): MeshWorkQueueEntry[] {
    const rows = MeshRuntimeStore.getInstance().db.prepare(
        `SELECT id, status,
                json_extract(payload, '$.missionId') AS missionId, json_extract(payload, '$.origin') AS origin,
                json_extract(payload, '$.parentTaskId') AS parentTaskId, json_extract(payload, '$.stageRole') AS stageRole,
                json_extract(payload, '$.stagePlan') AS stagePlan, json_extract(payload, '$.stageState') AS stageState
         FROM mesh_queue WHERE mesh_id = ? AND json_valid(payload)`,
    ).all(meshId) as Array<Record<string, unknown>>;
    const parse = (v: unknown) => { if (typeof v !== 'string') return undefined; try { return JSON.parse(v); } catch { return undefined; } };
    return rows.map(r => ({
        id: r.id as string, meshId, status: r.status as MeshWorkQueueEntry['status'],
        ...(r.missionId ? { missionId: r.missionId as string } : {}),
        ...(r.origin ? { origin: r.origin as 'stage' | 'coordinator' } : {}),
        ...(r.parentTaskId ? { parentTaskId: r.parentTaskId as string } : {}),
        ...(r.stageRole ? { stageRole: r.stageRole as 'review' } : {}),
        ...(r.stagePlan ? { stagePlan: parse(r.stagePlan) } : {}),
        ...(r.stageState ? { stageState: parse(r.stageState) } : {}),
    })) as MeshWorkQueueEntry[];
}

/** Mesh-wide review stats, or undefined when the mesh has no stage task at all (keeps payloads unchanged). */
export function computeStageReviewStatsForMesh(meshId: string, missionId?: string): StageReviewStats | undefined {
    try {
        const rows = readStageStatsRows(meshId);
        if (!rows.some(r => isStageParent(r) || isStageChild(r))) return undefined;
        return computeStageReviewStats(missionId ? rows.filter(r => r.missionId === missionId) : rows);
    } catch { return undefined; }
}
