import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
  exchangeWorkerSessionBind,
  findWorkerTaskTokenForSession,
  liveWorkerSessionBindCount,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
  revokeWorkerSessionBind,
  verifyWorkerSessionBind,
  WORKER_BIND_CANARY_PREFIX,
  WORKER_TOKEN_CANARY_PREFIX,
} from '../../src/mesh/worker-mcp-isolation'
import {
  acceptWorkerCompletionReport,
  validateWorkerCompletionReport,
  WORKER_SUMMARY_MAX_CHARS,
  WORKER_BRANCH_STATES,
} from '../../src/mesh/worker-report'
import {
  FINAL_SUMMARY_PROVENANCE_RANK,
  isStrongerSummaryProvenance,
} from '../../src/providers/completion/evidence'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed'

beforeEach(() => {
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
})
afterEach(() => {
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
})

// ─── Token delivery: the session bind (design §12.1a) ─────────────────────

describe('worker session bind', () => {
  it('mints a bind whose secret is distinguishable from a task token', () => {
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    expect(bind.bind.startsWith(WORKER_BIND_CANARY_PREFIX)).toBe(true)
    // A boundary scan that only greps for the token prefix must not silently
    // miss a leaked bind, which is why the two prefixes differ.
    expect(WORKER_BIND_CANARY_PREFIX).not.toBe(WORKER_TOKEN_CANARY_PREFIX)
    expect(bind.bind.startsWith(WORKER_TOKEN_CANARY_PREFIX)).toBe(false)
  })

  it('re-minting for one session revokes the previous bind', () => {
    const first = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    const second = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    expect(second.bind).not.toBe(first.bind)
    // A respawned session means the first worker is gone; its bind must not
    // survive to keep exchanging against a session it no longer owns.
    expect(verifyWorkerSessionBind(first.bind)).toBeNull()
    expect(verifyWorkerSessionBind(second.bind)).not.toBeNull()
    expect(liveWorkerSessionBindCount()).toBe(1)
  })

  it('keeps binds for different sessions independent', () => {
    const a = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    const b = mintWorkerSessionBind({ meshId: 'm', sessionId: 's2' })
    expect(verifyWorkerSessionBind(a.bind)).not.toBeNull()
    expect(verifyWorkerSessionBind(b.bind)).not.toBeNull()
    revokeWorkerSessionBind(a.bind)
    expect(verifyWorkerSessionBind(a.bind)).toBeNull()
    expect(verifyWorkerSessionBind(b.bind)).not.toBeNull()
  })

  it('rejects a bind mint with no mesh or session', () => {
    expect(() => mintWorkerSessionBind({ meshId: '', sessionId: 's' })).toThrow(/meshId and sessionId/)
    expect(() => mintWorkerSessionBind({ meshId: 'm', sessionId: '  ' })).toThrow(/meshId and sessionId/)
  })

  it('verify is fail-closed for junk, empty and non-string input', () => {
    for (const junk of [undefined, null, '', '   ', 42, {}, 'wsb_nope']) {
      expect(verifyWorkerSessionBind(junk as unknown)).toBeNull()
    }
  })
})

describe('bind → token exchange', () => {
  it('resolves the live token for the task the session currently holds', () => {
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1', nodeId: 'n1' })
    const token = mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a1', sessionId: 's1', nodeId: 'n1' })

    const resolved = exchangeWorkerSessionBind(bind.bind, () => ({ taskId: 't1', attemptId: 'a1' }))
    expect(resolved).toMatchObject({
      token: token.token, meshId: 'm', taskId: 't1', attemptId: 'a1', sessionId: 's1', nodeId: 'n1',
    })
  })

  it('fails closed when the session holds no task', () => {
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a1', sessionId: 's1' })
    // The resolver — not the caller — decides which task is current. No task ⇒ refuse.
    expect(exchangeWorkerSessionBind(bind.bind, () => null)).toBeNull()
  })

  it('fails closed when the task has no live token (post-terminal)', () => {
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    // Task is current, but its token was expired at terminal — the exact state
    // in which a late report must be refused rather than accepted.
    expect(exchangeWorkerSessionBind(bind.bind, () => ({ taskId: 't1' }))).toBeNull()
  })

  it('fails closed on an unknown bind without ever consulting the resolver', () => {
    const resolver = vi.fn(() => ({ taskId: 't1' }))
    expect(exchangeWorkerSessionBind('wsb_forged', resolver)).toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('fails closed when the resolver throws', () => {
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    mintWorkerTaskToken({ meshId: 'm', taskId: 't1', sessionId: 's1' })
    expect(exchangeWorkerSessionBind(bind.bind, () => { throw new Error('db down') })).toBeNull()
  })

  it('carries the TOKEN attemptId, not the resolver one, so a stale attempt stays rejectable', () => {
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'attempt_old', sessionId: 's1' })
    // The resolver reports the NEW attempt; the token still names the old one.
    // Reporting the token's attempt is what lets the reducer see it as stale
    // instead of silently accepting it against the retry's row.
    const resolved = exchangeWorkerSessionBind(bind.bind, () => ({ taskId: 't1', attemptId: 'attempt_new' }))
    expect(resolved?.attemptId).toBe('attempt_old')
  })

  it('a retry mints a new token and the SAME bind resolves to it', () => {
    const bind = mintWorkerSessionBind({ meshId: 'm', sessionId: 's1' })
    const first = mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a1', sessionId: 's1' })
    const retry = mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a2', sessionId: 's1' })

    const resolved = exchangeWorkerSessionBind(bind.bind, () => ({ taskId: 't1', attemptId: 'a2' }))
    // Both attempts' tokens are live (different attempts), and the bind survives
    // the retry — which is the whole reason a bind beats baking a token into the
    // config at spawn.
    expect([first.token, retry.token]).toContain(resolved?.token)
    expect(resolved).not.toBeNull()
  })

  it('does not hand a sibling session the token minted for another session', () => {
    mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a1', sessionId: 'sessionA' })
    expect(findWorkerTaskTokenForSession('m', 't1', 'sessionB')).toBeNull()
    expect(findWorkerTaskTokenForSession('m', 't1', 'sessionA')).not.toBeNull()
  })
})

// ─── B: report schema validation (design §4) ──────────────────────────────

describe('report_completion validation', () => {
  const valid = { outcome: 'completed', summary: 'Did the thing.' }

  it('accepts a minimal valid report', () => {
    const { report, errors } = validateWorkerCompletionReport(valid)
    expect(errors).toEqual([])
    expect(report).toMatchObject({ outcome: 'completed', summary: 'Did the thing.' })
  })

  it('rejects a missing or unknown outcome', () => {
    expect(validateWorkerCompletionReport({ summary: 'x' }).errors.some(e => e.field === 'outcome')).toBe(true)
    expect(validateWorkerCompletionReport({ ...valid, outcome: 'done' }).errors.some(e => e.field === 'outcome')).toBe(true)
  })

  it('rejects an empty summary', () => {
    for (const summary of ['', '   ', undefined, 42]) {
      const { errors } = validateWorkerCompletionReport({ outcome: 'completed', summary })
      expect(errors.some(e => e.field === 'summary')).toBe(true)
    }
  })

  it('REJECTS an over-long summary rather than truncating it', () => {
    // The point of the report is that its value is complete by construction.
    // Silently clipping here would recreate the scrape's failure mode.
    const { report, errors } = validateWorkerCompletionReport({
      outcome: 'completed',
      summary: 'x'.repeat(WORKER_SUMMARY_MAX_CHARS + 1),
    })
    expect(report).toBeUndefined()
    expect(errors.some(e => e.field === 'summary' && /shorten/.test(e.message))).toBe(true)
  })

  it('rejects unknown top-level fields instead of ignoring them', () => {
    // A misspelled `handoff_notes` that is silently dropped yields a report that
    // looks complete and has lost its notes.
    const { errors } = validateWorkerCompletionReport({ ...valid, handoffNote: { intent: 'x' } })
    expect(errors.some(e => e.field === 'handoffNote')).toBe(true)
  })

  it('accepts every declared branchState and rejects anything else', () => {
    for (const state of WORKER_BRANCH_STATES) {
      const { errors } = validateWorkerCompletionReport({ ...valid, branchState: state })
      expect(errors).toEqual([])
    }
    expect(validateWorkerCompletionReport({ ...valid, branchState: 'merged' }).errors.some(e => e.field === 'branchState')).toBe(true)
  })

  it('requires intent and the presence of touchedFiles on handoffNotes', () => {
    const noIntent = validateWorkerCompletionReport({ ...valid, handoffNotes: { touchedFiles: ['a.ts'] } })
    expect(noIntent.errors.some(e => e.field === 'handoffNotes.intent')).toBe(true)

    // Omitting the key entirely is still rejected — a note that never considered
    // its touched files cannot be matched to future work.
    const noFiles = validateWorkerCompletionReport({ ...valid, handoffNotes: { intent: 'why' } })
    expect(noFiles.errors.some(e => e.field === 'handoffNotes.touchedFiles')).toBe(true)
  })

  // ★F6: an EMPTY array is the correct answer on a read-only task, and this
  // validator cannot see the task — so emptiness is decided post-identity by
  // checkReportAgainstTaskMode, not here. Rejecting it at this layer is what
  // drove a measured read-only worker to write the placeholder
  // "N/A (read-only verification task, no files touched)" into the file list,
  // storing a non-path as a path and poisoning the enclosure matching key.
  it('accepts an empty touchedFiles array — task mode decides, not the schema', () => {
    const emptyFiles = validateWorkerCompletionReport({ ...valid, handoffNotes: { intent: 'why', touchedFiles: [] } })
    expect(emptyFiles.errors).toEqual([])
    expect(emptyFiles.report?.handoffNotes?.touchedFiles).toEqual([])
  })

  it('accepts a full handoff note and normalizes it', () => {
    const { report, errors } = validateWorkerCompletionReport({
      outcome: 'completed',
      summary: 'Refactored session re-establishment.',
      handoffNotes: {
        intent: '  make re-establish idempotent  ',
        conflictGuidance: 'keep the narrowed key',
        touchedFiles: [' src/session-host.ts ', '', 'src/registry.ts'],
        followUps: ['add a metric'],
      },
      touchedFiles: ['src/session-host.ts'],
      branchState: 'pushed_feature_branch_needs_merge',
    })
    expect(errors).toEqual([])
    expect(report!.handoffNotes).toEqual({
      intent: 'make re-establish idempotent',
      conflictGuidance: 'keep the narrowed key',
      touchedFiles: ['src/session-host.ts', 'src/registry.ts'],
      followUps: ['add a metric'],
    })
  })

  it('rejects unknown fields inside handoffNotes too', () => {
    const { errors } = validateWorkerCompletionReport({
      ...valid,
      handoffNotes: { intent: 'x', touchedFiles: ['a.ts'], conflict_guidance: 'snake case is the wire shape, not this one' },
    })
    expect(errors.some(e => e.field === 'handoffNotes.conflict_guidance')).toBe(true)
  })

  it('rejects a non-object report', () => {
    for (const junk of [null, undefined, 'string', 42, ['a']]) {
      expect(validateWorkerCompletionReport(junk).report).toBeUndefined()
    }
  })

  it('rejects a list containing a non-string', () => {
    const { errors } = validateWorkerCompletionReport({ ...valid, touchedFiles: ['ok.ts', 5] })
    expect(errors.some(e => e.field === 'touchedFiles')).toBe(true)
  })
})

// ─── B: evidence grading (design §4 등급표) ────────────────────────────────

describe('summary provenance grading', () => {
  it('ranks tool_report above every read-derived source', () => {
    expect(FINAL_SUMMARY_PROVENANCE_RANK[0]).toBe('tool_report')
    for (const weaker of ['native_transcript', 'parsed_screen', 'parsed_screen_fallback', 'none'] as const) {
      expect(isStrongerSummaryProvenance('tool_report', weaker)).toBe(true)
      expect(isStrongerSummaryProvenance(weaker, 'tool_report')).toBe(false)
    }
  })

  it('preserves the pre-existing ordering among the read sources', () => {
    // Adding a grade on top must not reshuffle the grades the existing
    // regression suites were written against.
    expect(isStrongerSummaryProvenance('native_transcript', 'parsed_screen')).toBe(true)
    expect(isStrongerSummaryProvenance('parsed_screen', 'parsed_screen_fallback')).toBe(true)
    expect(isStrongerSummaryProvenance('parsed_screen_fallback', 'none')).toBe(true)
  })
})

// ─── invalid_for_task_mode fix (preview rc.40, task 441a2f87) ─────────────
//
// Live defect: a task that was NOT declared read-only (so the daemon treats it
// as code-changing) but was in fact a pure inspection task. The worker called
// report_completion(completed, handoff_notes.touched_files: []) → refused
// invalid_for_task_mode. It then tried to EXPLAIN the refusal with
// report_completion(blocked, ...) → refused AGAIN with the same reason, because
// the old checkReportAgainstTaskMode never looked at `outcome` and never told
// missing apart from an explicit empty list.
//
// These tests exercise the real acceptance path (acceptWorkerCompletionReport)
// against a real queue row and a real turn-ledger attempt, so they characterize
// the fix the way the live defect actually manifested — not just the pure
// predicate in isolation.

describe('invalid_for_task_mode — outcome-aware, missing vs explicit-empty (task 441a2f87)', () => {
  // Each test needs its own (mesh, task, attempt, session) namespace — see the
  // identical note in worker-report-notify-shadow.test.ts: the turn-ledger rows
  // are process-wide SQLite tables keyed by ids that are NOT scoped by mesh_id
  // (turn_attempts.session_id is UNIQUE across the whole ledger), so reusing a
  // literal like 'worker-session' across cases silently collides.
  let seq = 0
  function freshIds(): { meshId: string; taskId: string; sessionId: string } {
    seq += 1
    return {
      meshId: `mesh_taskmode_${seq}`,
      taskId: `task_taskmode_${seq}`,
      sessionId: `session_taskmode_${seq}`,
    }
  }

  /** A live task (readonly or code-changing), assigned + a generating attempt, ready for a report. */
  function seedTask(
    ids: ReturnType<typeof freshIds>,
    opts?: { readonly?: boolean; ownedPaths?: { paths: { path: string; subtree: boolean }[] } },
  ) {
    const now = new Date().toISOString()
    MeshRuntimeStore.getInstance().insertQueueEntry({
      id: ids.taskId,
      meshId: ids.meshId,
      message: 'inspect the thing and report back',
      status: 'assigned',
      assignedSessionId: ids.sessionId,
      readonly: !!opts?.readonly,
      ...(opts?.readonly ? { taskMode: 'live_debug_readonly' as const } : {}),
      ...(opts?.ownedPaths ? { ownedPaths: opts.ownedPaths } : {}),
      createdAt: now,
      updatedAt: now,
    } as any)
    const attempt = seedMeshAttempt({ meshId: ids.meshId, taskId: ids.taskId, sessionId: ids.sessionId, stage: 'generating' })
    const token = mintWorkerTaskToken({ meshId: ids.meshId, taskId: ids.taskId, attemptId: attempt.attemptId, sessionId: ids.sessionId })
    return { attempt, token }
  }

  it('BREAK-ONCE table: completed+[] accepted, blocked-without-files accepted, completed-without-files refused-with-field-name, non-empty-on-readonly refused', () => {
    // This single test enumerates the four cells the task asked to pin. Each
    // uses its own (mesh, task, session) so one case cannot leak into another.
    const results: Record<string, unknown> = {}

    // (1) completed + explicit [] on a code-changing task → accepted.
    {
      const { token } = seedTask(freshIds())
      results.completedEmptyTopLevel = acceptWorkerCompletionReport(
        { token: token.token },
        { outcome: 'completed', summary: 'Looked at it; nothing needed changing.', touchedFiles: [] },
      )
    }

    // (2) blocked, no touchedFiles at all, on a code-changing task → accepted.
    {
      const { token } = seedTask(freshIds())
      results.blockedNoFiles = acceptWorkerCompletionReport(
        { token: token.token },
        { outcome: 'blocked', summary: 'Cannot proceed without credentials.', blockers: ['missing API key'] },
      )
    }

    // (3) completed, touchedFiles never mentioned at all, on a code-changing
    // task → still refused, but the message must name the exact wire field.
    {
      const { token } = seedTask(freshIds())
      results.completedMissingFiles = acceptWorkerCompletionReport(
        { token: token.token },
        { outcome: 'completed', summary: 'Did the thing.' },
      )
    }

    // (4) non-empty touchedFiles on a read-only task → still refused, any outcome.
    {
      const { token } = seedTask(freshIds(), { readonly: true })
      results.nonEmptyOnReadonly = acceptWorkerCompletionReport(
        { token: token.token },
        { outcome: 'completed', summary: 'Investigated and also patched a typo.', touchedFiles: ['README.md'] },
      )
    }

    expect.soft(results.completedEmptyTopLevel).toMatchObject({ accepted: true, outcome: 'completed' })
    expect.soft(results.blockedNoFiles).toMatchObject({ accepted: true, outcome: 'blocked' })
    expect.soft(results.completedMissingFiles).toMatchObject({ accepted: false, refusal: 'invalid_for_task_mode' })
    expect.soft((results.completedMissingFiles as any).detail).toMatch(/touched_files/)
    expect.soft(results.nonEmptyOnReadonly).toMatchObject({ accepted: false, refusal: 'invalid_for_task_mode' })
  })

  it('accepts completed + explicit [] via handoffNotes.touchedFiles alone (top-level touchedFiles absent)', () => {
    const { token } = seedTask(freshIds())
    const result = acceptWorkerCompletionReport(
      { token: token.token },
      {
        outcome: 'completed',
        summary: 'Reviewed the module; no change was necessary.',
        handoffNotes: { intent: 'confirms current behavior is correct', touchedFiles: [] },
      },
    )
    expect(result).toMatchObject({ accepted: true, outcome: 'completed' })
  })

  it('refuses a completed report with touchedFiles missing at BOTH the top level and in handoffNotes', () => {
    const { token } = seedTask(freshIds())
    const result: any = acceptWorkerCompletionReport(
      { token: token.token },
      { outcome: 'completed', summary: 'Did the thing but said nothing about files.' },
    )
    expect(result.accepted).toBe(false)
    expect(result.refusal).toBe('invalid_for_task_mode')
    // The worker's next attempt must succeed by sending this exact field —
    // the refusal is useless if it does not name it.
    expect(result.detail).toContain('touched_files')
    expect(result.detail).toMatch(/\[\]/)
  })

  it('failed outcome on a code-changing task never requires touchedFiles either', () => {
    const { token } = seedTask(freshIds())
    const result = acceptWorkerCompletionReport(
      { token: token.token },
      { outcome: 'failed', summary: 'Attempted the change; the build broke and I could not fix it in time.' },
    )
    expect(result).toMatchObject({ accepted: true, outcome: 'failed' })
  })

  it('still refuses non-empty touchedFiles on a read-only task for blocked/failed outcomes too', () => {
    for (const outcome of ['blocked', 'failed'] as const) {
      const { token } = seedTask(freshIds(), { readonly: true })
      const result: any = acceptWorkerCompletionReport(
        { token: token.token },
        { outcome, summary: `outcome=${outcome} but I also changed a file`, touchedFiles: ['oops.ts'] },
      )
      expect.soft(result.accepted).toBe(false)
      expect.soft(result.refusal).toBe('invalid_for_task_mode')
    }
  })

  it('accepts an explicit empty touchedFiles on a read-only task (the unchanged, correct case)', () => {
    const { token } = seedTask(freshIds(), { readonly: true })
    const result = acceptWorkerCompletionReport(
      { token: token.token },
      { outcome: 'completed', summary: 'Inspected only, as instructed.', touchedFiles: [] },
    )
    expect(result).toMatchObject({ accepted: true, outcome: 'completed' })
  })

  it('H1: an explicit empty touchedFiles never trips the owned-paths mismatch evidence', () => {
    const { token } = seedTask(freshIds(), { ownedPaths: { paths: [{ path: 'src/mesh/worker-report.ts', subtree: false }] } })
    const result: any = acceptWorkerCompletionReport(
      { token: token.token },
      { outcome: 'completed', summary: 'Nothing needed changing in my owned lane.', touchedFiles: [] },
    )
    expect(result.accepted).toBe(true)
    expect(result.ownedPathsMismatch).toBeUndefined()
  })
})
