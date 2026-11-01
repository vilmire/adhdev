// Review-in-task: fold daemon-created review children under their stage parent in mesh_view_queue
// (docs/design/2026-11-01-review-in-task.md §3.1). The parent row carries a compact `stage` summary; the
// children are not listed separately unless the caller asks (`include_stage_children`).

interface StageRow {
    id: string;
    status?: string;
    origin?: string;
    parentTaskId?: string;
    stageRole?: string;
    stageRound?: number;
    stagePlan?: { maxRevisions?: number; independence?: string };
    stageState?: { phase?: string; round?: number; lastVerdict?: string; blockedReason?: string; reviewTaskIds?: string[]; openFindingIds?: string[]; selfCheck?: string };
}

export interface StageSummary {
    phase: string;
    round: number;
    maxRevisions?: number;
    lastVerdict?: string;
    blockedReason?: string;
    selfCheck?: string;
    openFindings: number;
    reviewTaskIds: string[];
}

export function foldStageChildren<T extends StageRow>(rows: readonly T[], includeChildren = false): Array<T & { stage?: StageSummary }> {
    const out: Array<T & { stage?: StageSummary }> = [];
    for (const row of rows) {
        const isChild = row.origin === 'stage' && !!row.parentTaskId && row.stageRole === 'review';
        if (isChild && !includeChildren) continue;
        if (row.stagePlan && row.stageState?.phase) {
            const s = row.stageState;
            out.push({
                ...row,
                stage: {
                    phase: s.phase!, round: s.round ?? 0,
                    ...(row.stagePlan.maxRevisions !== undefined ? { maxRevisions: row.stagePlan.maxRevisions } : {}),
                    ...(s.lastVerdict ? { lastVerdict: s.lastVerdict } : {}),
                    ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
                    ...(s.selfCheck ? { selfCheck: s.selfCheck } : {}),
                    openFindings: s.openFindingIds?.length ?? 0,
                    reviewTaskIds: s.reviewTaskIds ?? [],
                },
            });
        } else out.push(row);
    }
    return out;
}
