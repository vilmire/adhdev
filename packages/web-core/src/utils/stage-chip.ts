/**
 * Review-in-task chip model (docs/design/2026-11-01-review-in-task.md §6). Pure: maps a queue task's
 * stage fields to an i18n key + round, so the task card renders "implementing → … → review done" without
 * knowing the pipeline. Returns null for ordinary tasks.
 */
export interface StageChip { key: string; round?: number; tone: 'active' | 'done' | 'muted' }

interface StageTaskLike {
    stageState?: { phase?: string; round?: number; blockedReason?: string; released?: boolean } | null
    origin?: string | null
    stageRole?: string | null
    stageRound?: number | null
}

const PHASE_KEYS: Record<string, string> = {
    implementing: 'stageImplementing',
    self_checking: 'stageSelfCheck',
    awaiting_review: 'stageAwaitingReview',
    reviewing: 'stageReviewing',
    revising: 'stageRevising',
    done: 'stageDone',
}

export function stageChip(task: StageTaskLike | null | undefined): StageChip | null {
    if (!task) return null
    if (task.origin === 'stage' && task.stageRole === 'review') {
        return { key: 'stageReviewChild', round: task.stageRound ?? 1, tone: 'muted' }
    }
    const phase = task.stageState?.phase
    if (!phase || !PHASE_KEYS[phase]) return null
    const round = task.stageState?.round && task.stageState.round > 0 ? task.stageState.round : undefined
    return { key: PHASE_KEYS[phase], ...(round ? { round } : {}), tone: phase === 'done' ? 'done' : 'active' }
}
