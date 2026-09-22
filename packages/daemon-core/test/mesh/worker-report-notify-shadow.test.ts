/**
 * WORKER-MCP defect family: notification shadowing + silent successes.
 *
 * Every test here pins a behaviour that was MEASURED wrong in production, not a
 * hypothetical. The headline one (F1) is the shadowing: a turn the worker had
 * already reported structurally emitted a SECOND completion from the PTY scrape
 * 25.4s later, and the later one won — so the coordinator read a truncated
 * screen scrape while the authoritative summary sat unread in the ledger. The
 * audit that produced these findings confirmed the ledger writes were fine;
 * what was broken was which record reached the coordinator.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetProgressSurfaceForTest,
  __resetReportedSummariesForTest,
  acceptWorkerCompletionReport,
  acceptWorkerProgressUpdate,
  buildWorkerProgressNotice,
  configureHandoffNoteSink,
  configureWorkerProgressNoticeSink,
  findPriorWorkerReport,
  shouldSurfaceProgressToCoordinator,
  validateWorkerCompletionReport,
  WORKER_PROGRESS_SURFACE_MIN_CHARS,
  WORKER_PROGRESS_SURFACE_MIN_GAP_MS,
  WORKER_REPORT_EVENT_KIND,
} from '../../src/mesh/worker-report'
import {
  __resetHandoffNotesForTest,
  getStoredHandoffNote,
  selectRelevantHandoffNotes,
  storeHandoffNote,
} from '../../src/mesh/worker-handoff-notes'
import { WORKER_HANDOFF_EVENT_KIND } from '../../src/mesh/worker-report'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { defaultScopeForEvent } from '../../src/mesh/contracts'
import { WORKER_PROGRESS_EVENT_NAME } from '../../src/mesh/worker-progress-notify'
import {
  __resetWorkerTaskTokensForTest,
  mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation'
import { openTurnAttempt, recordTurnAck } from '../../src/mesh/mesh-turn-ledger'

// Each test needs its own (mesh, task, attempt) namespace: mesh_turn_events is a
// process-wide SQLite table whose UNIQUE key is (attempt_id, kind, dedupe_key)
// and is NOT scoped by mesh_id, so varying only the mesh id silently drops the
// second insert. Same trap the handoff-notes suite documents.
let seq = 0
function freshIds(): { meshId: string; taskId: string; attemptId: string } {
  seq += 1
  return {
    meshId: `mesh_shadow_${seq}`,
    taskId: `task_shadow_${seq}`,
    attemptId: `attempt_shadow_${seq}`,
  }
}

beforeEach(() => {
  __resetReportedSummariesForTest()
  __resetProgressSurfaceForTest()
  __resetHandoffNotesForTest()
  __resetWorkerTaskTokensForTest()
})
afterEach(() => {
  configureHandoffNoteSink(null)
  configureWorkerProgressNoticeSink(null)
  __resetReportedSummariesForTest()
  __resetProgressSurfaceForTest()
  __resetHandoffNotesForTest()
  __resetWorkerTaskTokensForTest()
})

/**
 * Insert an assigned queue row plus a live turn attempt, so the terminal commit
 * has something to flip and checkReportAgainstTaskMode has a task to read the
 * read-only bit from. Returns the real attemptId the ledger minted — the
 * reducer resolves the attempt itself and refuses `unknown_attempt` otherwise.
 */
function seedQueueRow(
  ids: ReturnType<typeof freshIds>,
  opts: { readonly: boolean },
): string {
  const now = new Date().toISOString()
  const sessionId = `session-${ids.taskId}`
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: ids.taskId,
    meshId: ids.meshId,
    message: 'do the thing',
    status: 'assigned',
    assignedSessionId: sessionId,
    readonly: opts.readonly,
    ...(opts.readonly ? { taskMode: 'live_debug_readonly' as const } : {}),
    createdAt: now,
    updatedAt: now,
  } as any)
  const { attempt } = openTurnAttempt({ meshId: ids.meshId, taskId: ids.taskId, dispatchNonce: 1, sessionId })
  recordTurnAck({ meshId: ids.meshId, taskId: ids.taskId, kind: 'delivered', attemptId: attempt.attemptId })
  recordTurnAck({ meshId: ids.meshId, taskId: ids.taskId, kind: 'consumed', attemptId: attempt.attemptId })
  return attempt.attemptId
}

/** Seed the evidence row acceptWorkerCompletionReport writes at step (2). */
function seedReportEvidence(ids: ReturnType<typeof freshIds>, outcome = 'completed'): void {
  MeshRuntimeStore.getInstance().insertTurnEvent({
    eventId: `evt-report-${ids.taskId}`,
    meshId: ids.meshId,
    attemptId: ids.attemptId,
    taskId: ids.taskId,
    kind: WORKER_REPORT_EVENT_KIND,
    dedupeKey: outcome,
    payload: JSON.stringify({ outcome, summaryLength: 42, touchedFileCount: 1 }),
    occurredAtMs: Date.now(),
    recordedAt: new Date().toISOString(),
  })
}

describe('F1 — prior worker report is discoverable from the ledger', () => {
  it('returns null when the worker never reported', () => {
    const ids = freshIds()
    // The ordinary PTY-only case: a worker that died or never reached MCP files
    // no report, and the scrape must stay the fallback it has always been.
    expect(findPriorWorkerReport(ids.meshId, ids.taskId)).toBeNull()
  })

  it('finds the report a worker filed, with its outcome', () => {
    const ids = freshIds()
    seedReportEvidence(ids, 'completed')
    const prior = findPriorWorkerReport(ids.meshId, ids.taskId)
    expect(prior).not.toBeNull()
    expect(prior?.taskId).toBe(ids.taskId)
    expect(prior?.outcome).toBe('completed')
    expect(prior?.attemptId).toBe(ids.attemptId)
  })

  it("carries a 'blocked' outcome through rather than flattening it to completed", () => {
    const ids = freshIds()
    seedReportEvidence(ids, 'blocked')
    // A blocked report that reads back as 'completed' would let the guard
    // announce success for work that explicitly did not succeed.
    expect(findPriorWorkerReport(ids.meshId, ids.taskId)?.outcome).toBe('blocked')
  })

  it('is scoped to the task — a sibling task does not inherit the report', () => {
    const ids = freshIds()
    const other = freshIds()
    seedReportEvidence(ids)
    expect(findPriorWorkerReport(ids.meshId, other.taskId)).toBeNull()
  })

  it('ignores non-report turn events for the same task', () => {
    const ids = freshIds()
    MeshRuntimeStore.getInstance().insertTurnEvent({
      eventId: `evt-other-${ids.taskId}`,
      meshId: ids.meshId,
      attemptId: ids.attemptId,
      taskId: ids.taskId,
      kind: 'worker_progress_update',
      dedupeKey: 'x',
      payload: JSON.stringify({ noteLength: 5 }),
      occurredAtMs: Date.now(),
      recordedAt: new Date().toISOString(),
    })
    // A progress note is not a completion. Treating any worker-authored row as a
    // report would suppress the PTY completion of a task that never finished.
    expect(findPriorWorkerReport(ids.meshId, ids.taskId)).toBeNull()
  })
})

describe('F2 — handoff note text survives a restart', () => {
  it('re-reads a note whose in-process cache was lost', () => {
    const ids = freshIds()
    configureHandoffNoteSink(null)
    storeHandoffNote({
      meshId: ids.meshId,
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      notes: { intent: 'why it changed', touchedFiles: ['src/a.ts'] },
      recordedAtIso: new Date().toISOString(),
    })
    expect(getStoredHandoffNote(ids.meshId, ids.taskId)?.notes.intent).toBe('why it changed')

    // ★Simulate a daemon restart: the in-process map is cleared while the
    // SQLite rows survive. Before F2 this made the note permanently
    // undeliverable — and report_completion had already told the worker it
    // "will be delivered to related future tasks automatically".
    __resetHandoffNotesForTest()

    const afterRestart = getStoredHandoffNote(ids.meshId, ids.taskId)
    expect(afterRestart).not.toBeNull()
    expect(afterRestart?.notes.intent).toBe('why it changed')
    expect(afterRestart?.notes.touchedFiles).toEqual(['src/a.ts'])
  })

  it('encloses a pre-restart note into a later overlapping task', () => {
    const ids = freshIds()
    const recordedAtIso = new Date().toISOString()
    configureHandoffNoteSink(null)
    MeshRuntimeStore.getInstance().insertTurnEvent({
      eventId: `evt-handoff-${ids.taskId}`,
      meshId: ids.meshId,
      attemptId: ids.attemptId,
      taskId: ids.taskId,
      kind: WORKER_HANDOFF_EVENT_KIND,
      dedupeKey: '',
      payload: JSON.stringify({ touchedFiles: ['src/shared.ts'], intentLength: 4, hasConflictGuidance: false, followUpCount: 0 }),
      occurredAtMs: Date.now(),
      recordedAt: recordedAtIso,
    })
    storeHandoffNote({
      meshId: ids.meshId,
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      notes: { intent: 'kept the retry bounded', touchedFiles: ['src/shared.ts'] },
      recordedAtIso,
    })

    __resetHandoffNotesForTest() // restart

    const selected = selectRelevantHandoffNotes({
      meshId: ids.meshId,
      taskId: `${ids.taskId}_next`,
      touchedFiles: ['src/shared.ts'],
    })
    // This is the end-to-end proof: selection skips any index row whose text is
    // missing, so before F2 a restart emptied this list entirely.
    expect(selected).toHaveLength(1)
    expect(selected[0]?.notes.intent).toBe('kept the retry bounded')
    expect(selected[0]?.reason).toBe('touched_files')
  })
})

describe('F3 — progress notes reach the coordinator, filtered', () => {
  it('routes the progress event unicast to the dispatching coordinator', () => {
    // Broadcast would page every coordinator on the daemon about a task they do
    // not own — the same dead-letter/mis-routing class contracts.ts documents.
    expect(defaultScopeForEvent(WORKER_PROGRESS_EVENT_NAME)).toBe('unicast')
  })

  it('surfaces the first substantive note on a task', () => {
    expect(shouldSurfaceProgressToCoordinator({
      note: 'Finished the schema migration; starting the backfill, which takes ~20 minutes.',
      nowMs: 1_000,
    })).toBe(true)
  })

  it('suppresses chatter below the milestone length', () => {
    expect(shouldSurfaceProgressToCoordinator({ note: 'still going', nowMs: 1_000 })).toBe(false)
    expect('still going'.length).toBeLessThan(WORKER_PROGRESS_SURFACE_MIN_CHARS)
  })

  it('throttles a second note until the gap has elapsed', () => {
    const note = 'Backfill is 40% done; no errors so far and the ETA still looks like 20 minutes.'
    const lastSurfacedAtMs = 1_000
    expect(shouldSurfaceProgressToCoordinator({
      note,
      nowMs: lastSurfacedAtMs + WORKER_PROGRESS_SURFACE_MIN_GAP_MS - 1,
      lastSurfacedAtMs,
    })).toBe(false)
    expect(shouldSurfaceProgressToCoordinator({
      note,
      nowMs: lastSurfacedAtMs + WORKER_PROGRESS_SURFACE_MIN_GAP_MS,
      lastSurfacedAtMs,
    })).toBe(true)
  })

  it('tells the coordinator the task is still running', () => {
    const notice = buildWorkerProgressNotice({ taskId: 't1', nodeLabel: 'node-a', note: 'halfway through the sweep' })
    expect(notice).toContain('halfway through the sweep')
    // A coordinator that reads "progress" as "done" would re-dispatch live work.
    expect(notice).toMatch(/NOT a completion/)
    expect(notice).toMatch(/still running/)
  })
})

describe('F4/F5 — a failed write is never reported as success', () => {
  it('refuses a progress update that has no attempt to record against', () => {
    const ids = freshIds()
    // ★Pre-fix this returned { accepted: true } without writing a single row,
    // and the MCP layer printed "Progress noted for task …". Nothing existed to
    // note it. No attemptId means no turn-event row is possible.
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId })
    const result = acceptWorkerProgressUpdate({ token: token.token }, 'a note that will not be recorded anywhere at all')
    expect(result.accepted).toBe(false)
    expect(result.refusal).toBe('storage_failed')
    expect(result.detail).toMatch(/no active attempt/)
  })

  it('records a progress update when an attempt exists', () => {
    const ids = freshIds()
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId: ids.attemptId })
    const result = acceptWorkerProgressUpdate(
      { token: token.token },
      'Finished the first sweep of the migration; starting verification now.',
    )
    expect(result.accepted).toBe(true)
    expect(result.taskId).toBe(ids.taskId)
    // The row must actually exist — "accepted" is only meaningful if it did.
    const rows = MeshRuntimeStore.getInstance().listTurnEventsForTask(ids.meshId, ids.taskId)
    expect(rows.filter(r => r.kind === 'worker_progress_update')).toHaveLength(1)
  })

  it('reports handoffNoteRecorded:false with a reason when the note cannot be stored', () => {
    const ids = freshIds()
    const attemptId = seedQueueRow(ids, { readonly: false })
    // A sink that throws is the measured shape of "the text did not persist".
    // Pre-fix the throw was swallowed and the call still answered
    // handoffNoteRecorded:true, so the worker was told the note was filed.
    configureHandoffNoteSink(() => { throw new Error('sink unavailable') })
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId })
    const result: any = acceptWorkerCompletionReport({ token: token.token }, {
      outcome: 'completed',
      summary: 'Did the work.',
      handoffNotes: { intent: 'why', touchedFiles: ['src/a.ts'] },
    })
    // The completion itself is not discarded over an optional note.
    expect(result.accepted).toBe(true)
    expect(result.handoffNoteRecorded).toBe(false)
    expect(result.handoffNoteError).toMatch(/could not be stored/)
  })

  it('reports handoffNoteRecorded:true when the note does store', () => {
    const ids = freshIds()
    const attemptId = seedQueueRow(ids, { readonly: false })
    let stored = 0
    configureHandoffNoteSink(() => { stored += 1 })
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId })
    const result: any = acceptWorkerCompletionReport({ token: token.token }, {
      outcome: 'completed',
      summary: 'Did the work.',
      handoffNotes: { intent: 'why', touchedFiles: ['src/a.ts'] },
    })
    expect(result.accepted).toBe(true)
    expect(result.handoffNoteRecorded).toBe(true)
    expect(result.handoffNoteError).toBeUndefined()
    expect(stored).toBe(1)
  })
})

describe('F6 — touchedFiles is validated against the task mode', () => {
  it('accepts an empty list at the schema layer', () => {
    const { report, errors } = validateWorkerCompletionReport({
      outcome: 'completed',
      summary: 'Verified the invariant holds; changed nothing.',
      handoffNotes: { intent: 'read-only audit', touchedFiles: [] },
    })
    expect(errors).toEqual([])
    expect(report?.handoffNotes?.touchedFiles).toEqual([])
  })

  it('still rejects an omitted list', () => {
    const { errors } = validateWorkerCompletionReport({
      outcome: 'completed',
      summary: 'Did some work.',
      handoffNotes: { intent: 'x' },
    })
    expect(errors.some(e => e.field === 'handoffNotes.touchedFiles')).toBe(true)
  })

  // ─── both halves, against a real task row ────────────────────────────

  it('accepts an empty list on a READ-ONLY task', () => {
    const ids = freshIds()
    const attemptId = seedQueueRow(ids, { readonly: true })
    configureHandoffNoteSink(() => {})
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId })
    const result: any = acceptWorkerCompletionReport({ token: token.token }, {
      outcome: 'completed',
      summary: 'Verified the invariant; changed nothing.',
      handoffNotes: { intent: 'read-only audit', touchedFiles: [] },
    })
    expect(result.accepted).toBe(true)
  })

  it('refuses a read-only task that claims it touched files', () => {
    const ids = freshIds()
    const attemptId = seedQueueRow(ids, { readonly: true })
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId })
    const result: any = acceptWorkerCompletionReport({ token: token.token }, {
      outcome: 'completed',
      summary: 'Changed things I was not supposed to change.',
      touchedFiles: ['src/a.ts'],
    })
    // The report contradicts the task mode. Accepting it would record an
    // unauthorized change as though it were sanctioned work.
    expect(result.accepted).toBe(false)
    expect(result.refusal).toBe('invalid_for_task_mode')
    expect(result.detail).toMatch(/read-only/)
  })

  it('still refuses an empty list on a CODE-CHANGING task', () => {
    const ids = freshIds()
    const attemptId = seedQueueRow(ids, { readonly: false })
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId })
    const result: any = acceptWorkerCompletionReport({ token: token.token }, {
      outcome: 'completed',
      summary: 'Changed some code.',
      handoffNotes: { intent: 'why', touchedFiles: [] },
    })
    // The original requirement, preserved — it is now applied where it is
    // actually true instead of to every task indiscriminately.
    expect(result.accepted).toBe(false)
    expect(result.refusal).toBe('invalid_for_task_mode')
    expect(result.detail).toMatch(/non-empty/)
  })
})
