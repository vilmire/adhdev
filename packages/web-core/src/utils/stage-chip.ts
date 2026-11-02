/**
 * Review-in-task chip model (docs/design/2026-11-01-review-in-task.md §6). Pure: maps a queue task's
 * stage fields to an i18n key + round, so the task card renders "implementing → … → review done" without
 * knowing the pipeline. Returns null for ordinary tasks.
 */
export interface StageChip { key: string; round?: number; tone: 'active' | 'done' | 'muted'; verdict?: string; blockedReason?: string }

interface StageTaskLike {
    stageState?: { phase?: string; round?: number; blockedReason?: string; lastVerdict?: string; released?: boolean } | null
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
    const blockedReason = task.stageState?.blockedReason || undefined
    // The verdict is only meaningful once a review ran; it rides along on the chip so the row can say "approved" / "changes requested".
    const verdict = round && task.stageState?.lastVerdict ? task.stageState.lastVerdict : undefined
    return {
        key: PHASE_KEYS[phase], ...(round ? { round } : {}), tone: phase === 'done' ? 'done' : 'active',
        ...(verdict ? { verdict } : {}), ...(blockedReason ? { blockedReason } : {}),
    }
}
