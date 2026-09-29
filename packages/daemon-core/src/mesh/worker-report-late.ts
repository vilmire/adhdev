/**
 * Late worker reports: a `report_completion` that arrives after its attempt already
 * went terminal (stall reclaim, cancel, timeout). Within a grace window the report is
 * still recorded against the recently-terminal attempt and the coordinator is told —
 * never used to reopen the attempt.
 */
import { verifyWorkerSessionBind, type WorkerTokenExchangeResult } from './worker-mcp-isolation.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import type { WorkerCompletionReport } from './worker-report-validation.js';
import { notifyMeshCoordinator } from './turn-ledger/deliver.js';
import { WORKER_REPORT_EVENT_KIND, checkReportAgainstTaskMode, REPORTED_SUMMARY_STORE, summaryKey, recordHandoffNote, type WorkerReportResult } from './worker-report.js';
import { randomUUID } from 'crypto';
import { LOG } from '../logging/logger.js';

// ─── Late report (F7b): the attempt is already terminal ─────────────────

/**
 * How long after the ledger terminalized an attempt its worker's structured
 * report is still ACCEPTED (as evidence, without a state change).
 *
 * ★Why this exists (F7b, preview rc.36): the completion flush declares a turn
 * genuine a few seconds after the PTY FSM sees idle — and a worker blocked in a
 * pending `report_completion` MCP call LOOKS idle. Measured: FSM idle at
 * 03:15:13, flush + commit + attempt-ref release at 03:15:17, the worker's
 * report after that → refused "may already be terminal", and the coordinator
 * got the screen-scraped summary instead of the structured one. The design's
 * R27 rule ("a late completion is recorded, not dropped") applies: the report
 * is the better record of the same turn, so it is kept.
 *
 * 15 minutes covers a slow MCP round trip plus a worker that re-tries after an
 * error, and is short enough that a report for a long-finished task — which is
 * almost certainly a confused or replayed worker — is still refused.
 */
export const WORKER_LATE_REPORT_GRACE_MS = 15 * 60 * 1000;

/** Pending-event name of the one follow-up notice a late report produces (unicast, contracts.ts). */
export const WORKER_LATE_REPORT_EVENT_NAME = 'mesh:worker_late_report';

/** A worker identity whose attempt the ledger already terminalized (recently). */
export interface LateWorkerIdentity extends WorkerTokenExchangeResult {
    attemptId: string;
    terminalOutcome: string;
    terminalAtMs: number;
}

/**
 * The session's most recent MESH attempt, when it is terminal within the grace
 * window AND still its task's current attempt (a retry supersedes it — a report
 * for a superseded attempt is stale, not late). Null otherwise; fail-closed.
 * `isSelfDaemon` (when the caller knows its own id) additionally requires the
 * attempt to be OWNED here — only the owner's ledger may take the report.
 */
export function resolveRecentlyTerminalAttempt(
    meshId: string,
    sessionId: string,
    nowMs: number,
    isSelfDaemon?: (daemonId: string) => boolean,
    reportedAtMs?: number,
): { attemptId: string; taskId: string; nodeId?: string; terminalOutcome: string; terminalAtMs: number } | null {
    try {
        const turns = MeshRuntimeStore.getInstance().turnStore();
        // Durable delivery: with a creation time, the attempt is the one the session was on
        // WHEN THE REPORT WAS WRITTEN (it may since have been handed another task), and the
        // grace is measured from that moment — a report written before or shortly after the
        // terminal is late only in delivery, which the outbox window bounds separately.
        const attempt = reportedAtMs !== undefined
            ? turns.findMeshAttemptForSessionAt(sessionId, reportedAtMs)
            : turns.findPresentationAttemptForSession(sessionId)?.attempt;
        if (!attempt?.terminal || attempt.meshId !== meshId || !attempt.taskId) return null;
        if (!sessionIdsEquivalent(attempt.sessionId, sessionId)) return null;
        if (isSelfDaemon && !isSelfDaemon(attempt.ownerDaemonId)) return null;
        if (reportedAtMs !== undefined) {
            if (reportedAtMs - attempt.terminal.at > WORKER_LATE_REPORT_GRACE_MS) return null;
        } else {
            const age = nowMs - attempt.terminal.at;
            if (!(age >= 0 && age <= WORKER_LATE_REPORT_GRACE_MS)) return null;
        }
        if (turns.findLatestAttemptForTask(meshId, attempt.taskId)?.attemptId !== attempt.attemptId) return null;
        return {
            attemptId: attempt.attemptId,
            taskId: attempt.taskId,
            ...(attempt.nodeId ? { nodeId: attempt.nodeId } : {}),
            terminalOutcome: attempt.terminal.outcome,
            terminalAtMs: attempt.terminal.at,
        };
    } catch {
        return null;
    }
}

/**
 * F7b, local: a BIND whose session's attempt this daemon's ledger terminalized
 * within the grace window. Only a bind — the token died with the terminal.
 */
export function resolveLateWorkerIdentity(
    credential: { bind?: unknown },
    nowMs = Date.now(),
    isSelfDaemon?: (daemonId: string) => boolean,
    reportedAtMs?: number,
): LateWorkerIdentity | null {
    const binding = verifyWorkerSessionBind(credential.bind);
    if (!binding) return null;
    const attempt = resolveRecentlyTerminalAttempt(binding.meshId, binding.sessionId, nowMs, isSelfDaemon, reportedAtMs);
    if (!attempt) return null;
    const nodeId = attempt.nodeId || binding.nodeId;
    return {
        token: '',
        meshId: binding.meshId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        sessionId: binding.sessionId,
        ...(nodeId ? { nodeId } : {}),
        terminalOutcome: attempt.terminalOutcome,
        terminalAtMs: attempt.terminalAtMs,
    };
}

/** The coordinator-facing line for a late report. */
export function buildWorkerLateReportNotice(opts: {
    taskId: string;
    nodeLabel: string;
    terminalOutcome: string;
    report: WorkerCompletionReport;
}): string {
    const r = opts.report;
    const parts = [
        `[System] ${opts.nodeLabel} filed its structured report for task ${opts.taskId} AFTER the task was already marked ${opts.terminalOutcome}`
        + ` — reported outcome: ${r.outcome}.`,
        `Summary: ${r.summary}`,
    ];
    if (r.blockers?.length) parts.push(`Blockers: ${r.blockers.join('; ')}`);
    if (r.branchState) parts.push(`Branch state: ${r.branchState}`);
    if (r.handoffNotes) parts.push(`Handoff intent: ${r.handoffNotes.intent}`);
    const agrees = (r.outcome === 'completed') === (opts.terminalOutcome === 'completed');
    parts.push(agrees
        ? 'This supersedes the earlier completion summary for the same turn; the task state is unchanged.'
        : `★The reported outcome differs from the recorded terminal (${opts.terminalOutcome}); the task state was NOT changed — decide whether follow-up work is needed.`);
    return parts.join('\n');
}

/** Sink for the late-report coordinator notice. `undefined` = production; `null` = disabled. TESTS set it. */
type WorkerLateReportNoticeSink = (notice: {
    meshId: string;
    taskId: string;
    attemptId: string;
    nodeId?: string;
    sessionId?: string;
    coordinatorMessage: string;
    nowMs: number;
}) => void;

let lateNoticeSinkOverride: WorkerLateReportNoticeSink | null | undefined;

/** TESTS ONLY — replace the late-report notice sink; see `__setHandoffNoteSinkForTests`. */
export function __setWorkerLateReportNoticeSinkForTests(sink: WorkerLateReportNoticeSink | null | undefined): void {
    lateNoticeSinkOverride = sink;
}

/**
 * Production sink: one unicast notice to the coordinator session that
 * dispatched the task (the queue row's `sourceCoordinatorSessionId`, the same
 * anchor a completion and a progress note route by). Runs on the OWNER daemon —
 * the only place a report is accepted — so the daemon axis is this daemon.
 */
const queueWorkerLateReportNotice: WorkerLateReportNoticeSink = (notice) => {
    let targetCoordinatorSessionId = '';
    try {
        const task = MeshRuntimeStore.getInstance().findQueueEntryById(notice.meshId, notice.taskId);
        const sid = task?.sourceCoordinatorSessionId;
        if (typeof sid === 'string' && sid.trim()) targetCoordinatorSessionId = sid.trim();
    } catch { /* degrade to any coordinator of the mesh */ }
    notifyMeshCoordinator({
        event: WORKER_LATE_REPORT_EVENT_NAME,
        meshId: notice.meshId,
        nodeLabel: notice.nodeId || notice.sessionId || notice.taskId,
        ...(notice.nodeId ? { nodeId: notice.nodeId } : {}),
        metadataEvent: {
            source: WORKER_REPORT_EVENT_KIND,
            taskId: notice.taskId,
            attemptId: notice.attemptId,
            ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
            // Never terminal: the ledger already committed; this is evidence.
            terminal: false,
            coordinatorMessage: notice.coordinatorMessage,
        },
        coordinatorMessage: notice.coordinatorMessage,
        // One notice per attempt, however often the worker re-calls.
        eventId: `worker_late_report:${notice.attemptId}`,
        queuedAt: notice.nowMs,
        ...(targetCoordinatorSessionId ? { targetCoordinatorSessionId } : {}),
    });
};

/**
 * F7b acceptance body: the attempt is terminal, so NOTHING about task state
 * changes — no fence, no terminal commit, no graph advance (the reducer already
 * decided, and it is the only terminal writer). What the report adds is kept:
 * the content-free evidence row (`worker_tool_report`, flagged `late`), the
 * handoff note (index row + text on `mesh.<id>.handoff`), the verbatim summary
 * for the shadowing guard, and ONE coordinator notice so the structured result
 * is seen even though the completion notice already went out.
 */
export function acceptLateWorkerCompletionReport(
    identity: LateWorkerIdentity,
    report: WorkerCompletionReport,
    nowMs: number,
): WorkerReportResult {
    const taskModeError = checkReportAgainstTaskMode(identity, report);
    if (taskModeError) return { accepted: false, refusal: 'invalid_for_task_mode', detail: taskModeError };

    const nowIso = new Date(nowMs).toISOString();
    const turns = MeshRuntimeStore.getInstance().turnStore();
    REPORTED_SUMMARY_STORE.set(summaryKey(identity.meshId, identity.taskId), { summary: report.summary, recordedAtMs: nowMs });

    let inserted = false;
    try {
        inserted = turns.insertWorkerEvent({
            eventId: randomUUID(),
            attemptId: identity.attemptId,
            sessionId: identity.sessionId || null,
            kind: WORKER_REPORT_EVENT_KIND,
            dedupeKey: report.outcome,
            payload: {
                outcome: report.outcome,
                summaryLength: report.summary.length,
                touchedFileCount: report.touchedFiles?.length ?? 0,
                blockerCount: report.blockers?.length ?? 0,
                hasHandoffNotes: !!report.handoffNotes,
                ...(report.branchState ? { branchState: report.branchState } : {}),
                late: true,
                terminalOutcome: identity.terminalOutcome,
                lateByMs: Math.max(0, nowMs - identity.terminalAtMs),
            },
            atMs: nowMs,
        });
    } catch (e: any) {
        LOG.error('WorkerReport', `Failed to record late report evidence for task ${identity.taskId}: ${e?.message || e}`);
        return { accepted: false, refusal: 'storage_failed', detail: `could not persist the report evidence row for task ${identity.taskId}` };
    }
    // `false` = the UNIQUE key already holds this outcome: an idempotent re-call.
    const duplicate = !inserted;

    let handoffNoteRecorded = false;
    let handoffNoteError: string | null = null;
    if (report.handoffNotes && !duplicate) {
        const noteResult = recordHandoffNote(identity, report.handoffNotes, nowMs, nowIso);
        handoffNoteRecorded = noteResult.recorded;
        handoffNoteError = noteResult.error;
    } else if (report.handoffNotes) {
        handoffNoteRecorded = true;
    }

    if (!duplicate) {
        const sink = lateNoticeSinkOverride === undefined ? queueWorkerLateReportNotice : lateNoticeSinkOverride;
        if (sink) {
            try {
                sink({
                    meshId: identity.meshId,
                    taskId: identity.taskId,
                    attemptId: identity.attemptId,
                    ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
                    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
                    coordinatorMessage: buildWorkerLateReportNotice({
                        taskId: identity.taskId,
                        nodeLabel: identity.nodeId || identity.sessionId || identity.taskId,
                        terminalOutcome: identity.terminalOutcome,
                        report,
                    }),
                    nowMs,
                });
            } catch (e: any) {
                // The evidence is recorded; a notice failure must not refuse it.
                LOG.warn('WorkerReport', `Failed to queue late-report notice for task ${identity.taskId}: ${e?.message || e}`);
            }
        }
    }

    LOG.info(
        'WorkerReport',
        `Accepted LATE ${report.outcome} report for task ${identity.taskId} attempt ${identity.attemptId}`
        + ` (already ${identity.terminalOutcome} ${Math.round((nowMs - identity.terminalAtMs) / 1000)}s ago)`
        + (duplicate ? ' (duplicate replay)' : '')
        + (handoffNoteRecorded ? ' with handoff note' : ''),
    );
    return {
        accepted: true,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        outcome: report.outcome,
        duplicate,
        handoffNoteRecorded,
        ...(handoffNoteError ? { handoffNoteError } : {}),
        late: { terminalOutcome: identity.terminalOutcome },
    };
}
