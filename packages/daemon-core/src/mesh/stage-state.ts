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
    // Every `completed` before the pipeline releases the row is held, not only the first one: the turn
    // ledger commits the same attempt again on the idle edge after the worker report, by which time the
    // phase has already moved on to self_checking/awaiting_review.
    return !s.released && s.phase !== 'done';
}

/**
 * Terminals that must not replace a released stage block. `failed` too: a writer the
 * ledger could only settle after the block (live 2026-11-06, c1cdb3f7: the stopped
 * worker's attempt committed `failed` over `stage_pipeline_ceiling`). `cancelled` stays
 * open — `abandon` is the coordinator's own decision and writes it.
 */
const STAGE_BLOCK_OVERWRITING_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

/**
 * The review stage released this row as `blocked`: from here only the pipeline or the
 * coordinator's `mesh_task_stage_decide` moves it. A later `completed` from the worker's
 * report or the turn ledger's idle-edge re-commit of the same attempt must not turn an
 * unapproved review into a finished task (live 2026-11-06: re-review then refused with
 * stage_task_not_blocked).
 */
export function isStageBlockLocked(entry: StageRow | null | undefined, status: string): boolean {
    if (!entry || !STAGE_BLOCK_OVERWRITING_STATUSES.has(status) || !isStageParent(entry)) return false;
    const s = entry.stageState!;
    return entry.status === 'blocked' && !!s.released && !!s.blockedReason;
}

/**
 * A row the review released as blocked that a late `completed` overwrote before
 * `isStageBlockLocked` existed: still undecided, so the coordinator may decide it.
 * `accept` clears `blockedReason`, so an accepted row never qualifies.
 */
export function isStageBlockOverwritten(entry: StageRow | null | undefined): boolean {
    if (!entry || !STAGE_BLOCK_OVERWRITING_STATUSES.has(entry.status) || !isStageParent(entry)) return false;
    const s = entry.stageState!;
    return !!s.released && !!s.blockedReason;
}

/** A held `completed` that is the implementer's stage report (hand it to the pipeline), not a repeat commit. */
export function isStageImplReport(entry: StageRow | null | undefined): boolean {
    if (!entry || !isStageParent(entry)) return false;
    const s = entry.stageState!;
    return !s.released && (s.phase === 'implementing' || s.phase === 'revising');
}

/** Rows whose terminal/turn notices must NOT wake the coordinator: review children and held stage parents. */
export function isStageNoticeSilent(entry: StageRow | null | undefined): boolean {
    if (!entry) return false;
    if (isStageChild(entry)) return true;
    return isStageParent(entry) && !entry.stageState!.released && entry.status === 'assigned';
}

/** Footer `stage` input for a stage dispatch (implement / revise parent, or a review child), else undefined. */
export function stageFooterInput(task: Pick<MeshWorkQueueEntry, 'stagePlan' | 'stageState' | 'origin' | 'parentTaskId' | 'stageRole' | 'stageRound' | 'reviewerWorkspace'>):
    { role: 'implement' | 'revise' | 'review'; round: number; maxRevisions: number; workspace?: string } | undefined {
    if (isStageChild(task)) return { role: 'review', round: task.stageRound ?? 1, maxRevisions: 0, ...(task.reviewerWorkspace ? { workspace: task.reviewerWorkspace.path } : {}) };
    if (!isStageParent(task)) return undefined;
    const s = task.stageState!;
    const revising = s.round > 0 || s.selfCheckBounces > 0;
    return { role: revising ? 'revise' : 'implement', round: Math.max(1, s.round), maxRevisions: task.stagePlan!.maxRevisions };
}

/** §7: latest diff + latest self-check + latest verdict + one previous verdict, plus named worker evidence (max 12). */
export function selectStageInputArtifacts(st: MeshTaskStageState): string[] {
    const v = st.artifacts.verdict;
    return [...new Set([
        ...st.artifacts.diff.slice(-1), ...st.artifacts.selfCheck.slice(-1), ...v.slice(-1), ...(v.length > 1 ? v.slice(-2, -1) : []), ...(st.workerArtifactIds ?? []).slice(-8),
    ])];
}
