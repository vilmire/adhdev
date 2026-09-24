// ---------------------------------------------------------------------------
// turn-ledger/worker-report-evidence — an accepted worker report → `worker_report`
// ---------------------------------------------------------------------------
// Design §F2: `report_completion` is the primary completion evidence, so the
// OWNER daemon that accepted it (worker-report.ts acceptance body — local and
// the F7 forwarded path share it) observes it on its turn ledger. Before this
// (live, preview rc.44 run 12) an accepted report only wrote the content-free
// `worker_tool_report` audit row and flipped the queue row: the reducer never
// saw it, so the idle end that followed re-opened a 600 s `await_report` hold
// and the attempt committed WEAK ten minutes later with the report on file.
//
// The report's text stays local: it rides the evidence row's envelope
// (`payload_json.local`, never published) — deliver.ts renders the completion
// notice from it — and the evidence carries no handoff pointer.
// ---------------------------------------------------------------------------

import type { TurnEvidenceOf, WorkerBranchState, WorkerReportOutcome } from '@adhdev/mesh-shared';
import type { ObserveResult, TurnLedger } from './ledger.js';

export interface AcceptedWorkerReport {
    meshId: string;
    taskId: string;
    /** The attempt the report's credential named; else the task's latest attempt. */
    attemptId?: string;
    sessionId?: string;
    outcome: WorkerReportOutcome;
    /** Local text only (envelope); never put on the evidence. */
    summary: string;
    hasHandoffNotes: boolean;
    touchedFileCount?: number;
    branchState?: WorkerBranchState;
    atMs: number;
}

/**
 * Observe an ACCEPTED report on the owner's ledger. Returns null when no
 * attempt resolves (pre-ledger task) — nothing to reduce. Idempotent: the
 * eventId is (attempt, generation, outcome), so a re-called report dedupes.
 */
export function observeAcceptedWorkerReport(ledger: TurnLedger, report: AcceptedWorkerReport): ObserveResult | null {
    const attempt = report.attemptId
        ? ledger.getAttempt(report.attemptId)
        : ledger.store.findLatestAttemptForTask(report.meshId, report.taskId);
    if (!attempt || attempt.taskId !== report.taskId) return null;
    const evidence: TurnEvidenceOf<'worker_report'> = {
        eventId: `worker_report:${attempt.attemptId}:g${attempt.generation}:${report.outcome}`,
        at: report.atMs,
        source: 'worker_tool',
        sessionId: report.sessionId ?? attempt.sessionId,
        attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
        taskId: report.taskId,
        observedBy: ledger.selfDaemonId,
        kind: 'worker_report',
        outcome: report.outcome,
        hasHandoffNotes: report.hasHandoffNotes,
        ...(typeof report.touchedFileCount === 'number' ? { touchedFileCount: report.touchedFileCount } : {}),
        ...(report.branchState ? { branchState: report.branchState } : {}),
    };
    return ledger.observe(evidence, { envelope: { finalSummary: report.summary } });
}
