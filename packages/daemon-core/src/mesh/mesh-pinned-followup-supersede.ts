// ---------------------------------------------------------------------------
// mesh-pinned-followup-supersede — a session-pinned follow-up must reach an
// IDLE session whose current attempt only awaits its report
// ---------------------------------------------------------------------------
// Live deadlock (2026-11-07, task bcde60ec / follow-up 6237d42f): a worker's turn
// ended (a rejected permission prompt), the ledger opened the R9r `await_report`
// hold, and the session sat idle at its prompt. A queue attempt that owes a report
// is retained indefinitely (R13q: the hold expiry only records
// `queue_completion_report_missing`), so its row stays `assigned`. A follow-up pinned
// to that session (`target_session_id`) was refused on every drain tick as
// `session_already_assigned` (auto-launch: `target_session_constraint`), and the ledger
// allows only ONE open attempt per session (ux_turn_attempts_open_session), so the
// follow-up could not open its attempt either. The pin names the only session that
// may take it, so nothing ever freed the session.
//
// Mechanism: settle the awaiting attempt through the ledger (`ledger.observe`
// operator_status/failed from the scheduler — the single emitter, new rule R23s)
// right before the claim. Cancel (R22), requeue-retire and plain operator_status
// (R23) all begin a WRITER STOP (they would kill the very idle session the
// follow-up is pinned to); R23s commits without it. The commit is the normal terminal
// chokepoint: the old row becomes `failed` (reason superseded_by_pinned_followup is
// carried in the log; the coordinator gets the usual task-failed notice and can
// requeue — never silently lost), its worker tokens expire (a late report is refused,
// so nothing is reported twice), and the pinned follow-up then claims through the
// ordinary claim path.
//
// Guards (all must hold, else nothing is touched):
//   * the claiming session is idle — never touches a busy/generating session;
//   * a pending, un-parked, due row is pinned to exactly this session;
//   * EVERY active assignment of the session is a mesh_queue attempt owned by this
//     daemon in `finalizing` with no report recorded for its generation
//     (a generating/consumed attempt, a recorded report, a `stopping` writer all refuse).
// ---------------------------------------------------------------------------

import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { PINNED_FOLLOWUP_SETTLE_EVENT_PREFIX } from './turn-ledger/reducer.js';
import { getActiveTurnLedger } from './turn-ledger/active-ledger.js';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { MeshWorkQueueEntry } from './mesh-work-queue-types.js';

export const PINNED_FOLLOWUP_SUPERSEDE_REASON = 'superseded_by_pinned_followup';

export interface PinnedFollowupSupersedeResult {
    /** Task ids whose awaiting-report attempt was settled (row failed, session freed). */
    superseded: string[];
    /** Why nothing (more) was done; absent when at least one row was superseded. */
    skipped?: 'session_busy' | 'no_pinned_followup' | 'no_assignment' | 'not_awaiting_report' | 'has_dependents' | 'no_ledger' | 'settle_refused';
}

export function supersedeAwaitingReportForPinnedFollowup(
    meshId: string,
    sessionId: string,
    opts: { sessionIdle: boolean; nowMs?: number },
): PinnedFollowupSupersedeResult {
    if (!opts.sessionIdle) return { superseded: [], skipped: 'session_busy' };
    const store = MeshRuntimeStore.getInstance();
    const nowMs = opts.nowMs ?? Date.now();

    const pinned = (store.db.prepare(
        `SELECT payload FROM mesh_queue WHERE mesh_id = ? AND status = 'pending' AND target_session_id = ?`,
    ).all(meshId, sessionId) as Array<{ payload: string }>)
        .map(r => JSON.parse(r.payload) as MeshWorkQueueEntry)
        .filter(t => !t.parked && !(t.notBefore && Date.parse(t.notBefore) > nowMs));
    if (pinned.length === 0) return { superseded: [], skipped: 'no_pinned_followup' };

    const assigned = (store.db.prepare(
        `SELECT payload FROM mesh_queue WHERE mesh_id = ? AND status = 'assigned' AND assigned_session_id = ?`,
    ).all(meshId, sessionId) as Array<{ payload: string }>).map(r => JSON.parse(r.payload) as MeshWorkQueueEntry);
    if (assigned.length === 0) return { superseded: [], skipped: 'no_assignment' };

    // Failing a row that other live tasks depend on would cascade their failure; leave that
    // decision to the coordinator (the existing target_session_constraint hold notice).
    const assignedIds = new Set(assigned.map(r => r.id));
    const dependents = (store.db.prepare(
        `SELECT payload FROM mesh_queue WHERE mesh_id = ? AND status IN ('pending', 'assigned')`,
    ).all(meshId) as Array<{ payload: string }>).some(r => {
        const deps = (JSON.parse(r.payload) as MeshWorkQueueEntry).dependsOn ?? [];
        return Array.isArray(deps) && deps.some(d => assignedIds.has(d));
    });
    if (dependents) return { superseded: [], skipped: 'has_dependents' };

    const turns = store.turnStore();
    const ledger = getActiveTurnLedger();
    const awaiting: Array<{ row: MeshWorkQueueEntry; attemptId: string; generation: number }> = [];
    for (const row of assigned) {
        const attempt = turns.findLatestAttemptForTask(meshId, row.id);
        const ok = !!attempt && !attempt.terminal && attempt.scope === 'mesh_queue'
            && attempt.state === 'finalizing' && attempt.sessionId === sessionId
            && !attempt.data.writerStop && attempt.data.report?.generation !== attempt.generation;
        if (!ok || !attempt) return { superseded: [], skipped: 'not_awaiting_report' };
        if (!ledger) return { superseded: [], skipped: 'no_ledger' };
        if (attempt.ownerDaemonId && !daemonIdsEquivalent(attempt.ownerDaemonId, ledger.selfDaemonId)) {
            return { superseded: [], skipped: 'not_awaiting_report' };
        }
        awaiting.push({ row, attemptId: attempt.attemptId, generation: attempt.generation });
    }

    const superseded: string[] = [];
    for (const { row, attemptId, generation } of awaiting) {
        const result = ledger!.observe({
            eventId: `${PINNED_FOLLOWUP_SETTLE_EVENT_PREFIX}${attemptId}:g${generation}:${pinned[0].id}`,
            at: nowMs,
            source: 'scheduler',
            sessionId,
            observedBy: ledger!.selfDaemonId,
            attemptRef: { attemptId, generation },
            kind: 'operator_status',
            status: 'failed',
            reason: 'operator_update',
        });
        if (result.verdict !== 'applied' || !result.attempt?.terminal) {
            LOG.warn('MeshQueue', `Pinned follow-up ${pinned[0].id} cannot take session ${sessionId}: settling awaiting-report task ${row.id} was not applied (${result.verdict}${result.rejection ? ` ${result.rejection}` : ''})`);
            return { superseded, skipped: 'settle_refused' };
        }
        superseded.push(row.id);
    }
    LOG.info('MeshQueue', `Pinned follow-up ${pinned[0].id} → idle session ${sessionId}: settled awaiting-report attempt(s) of ${superseded.join(', ')} as failed/${PINNED_FOLLOWUP_SUPERSEDE_REASON} (writer kept alive; coordinator notified, can requeue)`);
    return { superseded };
}
