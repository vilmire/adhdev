// Review-in-task: structured report extras (review verdict, finding responses, summary) handed from
// worker-report.ts to the pipeline. The terminal choke point (mesh-task-terminal.ts) sees only the normalized
// envelope, so worker-report.ts stashes the validated report here just before committing; the pipeline pulls it
// when the hold / child-terminal hook fires. Process-local, bounded, and optional: a missing stash degrades to
// the envelope's final summary (an implementer) or to reviewer_unavailable (a reviewer with no verdict).

import type { MeshFindingResponse, MeshReviewReport, MeshTestRun } from '@adhdev/mesh-shared';

export interface StashedStageReport {
    attemptId?: string;
    sessionId?: string;
    outcome: 'completed' | 'blocked' | 'failed';
    summary: string;
    review?: MeshReviewReport;
    findingResponses?: MeshFindingResponse[];
    testsRun?: MeshTestRun[];
    artifactIds?: string[];
    touchedFiles?: string[];
    at: number;
}

const MAX_ENTRIES = 256;
const stash = new Map<string, StashedStageReport>();
const key = (meshId: string, taskId: string) => `${meshId}\u0000${taskId}`;

export function stashStageReport(meshId: string, taskId: string, report: StashedStageReport): void {
    stash.delete(key(meshId, taskId));
    stash.set(key(meshId, taskId), report);
    while (stash.size > MAX_ENTRIES) stash.delete(stash.keys().next().value as string);
}

/** Read without consuming (both terminal paths may fire for one attempt). */
export function peekStageReport(meshId: string, taskId: string): StashedStageReport | undefined {
    return stash.get(key(meshId, taskId));
}

export function dropStageReport(meshId: string, taskId: string): void { stash.delete(key(meshId, taskId)); }
export function __resetStageReportStashForTests(): void { stash.clear(); }
