// Review-in-task: pure helpers over the stage fields of a queue row (docs/design/2026-11-01-review-in-task.md).
// Leaf module — imports types only, so terminal choke point, watchdogs and enqueue can all use it.

import { STAGE_PARKED_PHASES, type MeshTaskStageState } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

type StageRow = Pick<MeshWorkQueueEntry, 'status' | 'stagePlan' | 'stageState' | 'origin' | 'parentTaskId' | 'stageRole'>;

export function initialStageState(nowIso: string): MeshTaskStageState {
    return {
        phase: 'implementing', round: 0, selfCheckBounces: 0, startedAt: nowIso, phaseSince: nowIso,
        baseSha: '', stageHeads: [], reviewTaskIds: [], openFindingIds: [],
        artifacts: { diff: [], selfCheck: [], verdict: [] },
    };
}

export function isStageParent(entry: Pick<MeshWorkQueueEntry, 'stagePlan' | 'stageState'> | null | undefined): boolean {
    return !!entry?.stagePlan && !!entry.stageState;
}

export function isStageChild(entry: Pick<MeshWorkQueueEntry, 'origin' | 'parentTaskId' | 'stageRole'> | null | undefined): boolean {
    return entry?.origin === 'stage' && !!entry.parentTaskId && entry.stageRole === 'review';
}

/**
 * THE shared "this stage parent is waiting on the daemon, not on a worker" predicate. The stranded-reclaim
 * watchdog, orphan-dispatch sweep, idle-session reaper and idle-mission reminder all skip such a row:
 * it is `assigned` with no open attempt between pipeline stages (design §6.4).
 */
export function isStagePipelineParked(entry: StageRow | null | undefined): boolean {
    if (!entry || entry.status !== 'assigned' || !isStageParent(entry) || entry.stageState!.released) return false;
    return (STAGE_PARKED_PHASES as readonly string[]).includes(entry.stageState!.phase);
}

/**
 * Terminal-hold predicate used by the terminal choke point: a `completed` commit on a stage parent that is
 * still implementing/revising is an intermediate stage report, not the task's end — the row stays `assigned`
 * and the pipeline takes over. Cleared by `stageState.released` (set before the pipeline's own final commit).
 */
export function shouldHoldStageTerminal(entry: StageRow | null | undefined, status: string): boolean {
    if (!entry || status !== 'completed' || !isStageParent(entry)) return false;
    const s = entry.stageState!;
    return !s.released && (s.phase === 'implementing' || s.phase === 'revising');
}

/** Rows whose terminal/turn notices must NOT wake the coordinator: review children and held stage parents. */
export function isStageNoticeSilent(entry: StageRow | null | undefined): boolean {
    if (!entry) return false;
    if (isStageChild(entry)) return true;
    return isStageParent(entry) && !entry.stageState!.released && entry.status === 'assigned';
}
