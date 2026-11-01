// Review-in-task: the two worker-report.ts hooks (kept out of that 1,300-line-gated file).
//   checkStageReportRequirements — role-dependent report rules the context-free validator cannot know.
//   stashStageReportForIdentity  — hand the validated report to the pipeline before the terminal commit.

import { validateReviewReport } from '@adhdev/mesh-shared';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { stashStageReport } from './stage-report-stash.js';
import { isStageChild, isStageParent } from './stage-state.js';
import type { WorkerCompletionReport } from './worker-report-validation.js';

interface Identity { meshId: string; taskId: string; attemptId?: string; sessionId?: string }

function entryOf(identity: Identity) {
    try { return MeshRuntimeStore.getInstance().findQueueEntryById(identity.meshId, identity.taskId); } catch { return null; }
}

/** Returns an error string for a refusal (`invalid_for_task_mode`), or null. */
export function checkStageReportRequirements(identity: Identity, report: WorkerCompletionReport): string | null {
    const entry = entryOf(identity);
    if (isStageChild(entry)) {
        if (report.outcome !== 'completed') return null; // blocked/failed reviewer = reviewer_unavailable path
        if (!report.review) return 'review_required: you are the independent reviewer of a stage task — report_completion must carry `review` {verdict, findings, checked, not_checked}.';
        const parent = entry!.parentTaskId ? MeshRuntimeStore.getInstance().findQueueEntryById(identity.meshId, entry!.parentTaskId) : null;
        const prior = parent?.stageState?.openFindingIds ?? [];
        const { errors } = validateReviewReport(report.review, { round: entry!.stageRound ?? 1, priorOpenBlockingIds: prior });
        if (errors.length) return `invalid review: ${errors.map(e => `${e.field}: ${e.message}`).join('; ')}`;
        return null;
    }
    if (report.review) return 'review_not_allowed: `review` is only accepted from the reviewer of a stage task.';
    if (isStageParent(entry) && report.outcome === 'completed' && entry!.stageState!.phase === 'revising') {
        const open = entry!.stageState!.openFindingIds;
        if (open.length) {
            const answered = new Set((report.findingResponses ?? []).map(r => r.id));
            const missing = open.filter(id => !answered.has(id));
            if (missing.length) return `finding_responses_required: answer every open blocking/major finding with fixed|disputed; missing: ${missing.join(', ')}`;
        }
    }
    return null;
}

export function stashStageReportForIdentity(identity: Identity, report: WorkerCompletionReport, nowMs: number): void {
    const entry = entryOf(identity);
    if (!isStageParent(entry) && !isStageChild(entry)) return;
    stashStageReport(identity.meshId, identity.taskId, {
        ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
        ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
        outcome: report.outcome, summary: report.summary,
        ...(report.review ? { review: report.review } : {}),
        ...(report.findingResponses ? { findingResponses: report.findingResponses } : {}),
        ...(report.testsRun ? { testsRun: report.testsRun } : {}),
        ...(report.artifactIds ? { artifactIds: report.artifactIds } : {}),
        ...(report.touchedFiles ? { touchedFiles: report.touchedFiles } : {}),
        at: nowMs,
    });
}
