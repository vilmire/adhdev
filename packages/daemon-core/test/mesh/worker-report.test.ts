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
  validateWorkerCompletionReport,
  WORKER_SUMMARY_MAX_CHARS,
  WORKER_BRANCH_STATES,
} from '../../src/mesh/worker-report'
import {
  FINAL_SUMMARY_PROVENANCE_RANK,
  isStrongerSummaryProvenance,
} from '../../src/providers/completion/evidence'

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

  it('requires intent and touchedFiles on handoffNotes', () => {
    const noIntent = validateWorkerCompletionReport({ ...valid, handoffNotes: { touchedFiles: ['a.ts'] } })
    expect(noIntent.errors.some(e => e.field === 'handoffNotes.intent')).toBe(true)

    // A note with no files can never be matched to future work, so it would be
    // stored and never delivered.
    const noFiles = validateWorkerCompletionReport({ ...valid, handoffNotes: { intent: 'why' } })
    expect(noFiles.errors.some(e => e.field === 'handoffNotes.touchedFiles')).toBe(true)

    const emptyFiles = validateWorkerCompletionReport({ ...valid, handoffNotes: { intent: 'why', touchedFiles: [] } })
    expect(emptyFiles.errors.some(e => e.field === 'handoffNotes.touchedFiles')).toBe(true)
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
