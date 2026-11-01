// Review-in-task §2 metrics, derived at query time from queue rows (no aggregate tables).
// Pure: takes the mesh's queue rows. Not yet wired into mesh_status / mesh_mission_list (see the stage doc §10).

import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';
import { isStageChild, isStageParent } from './stage-state.js';

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
