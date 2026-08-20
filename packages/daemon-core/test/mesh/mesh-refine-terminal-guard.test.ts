import { describe, expect, it } from 'vitest'

import {
  decideRefineTerminalWrite,
  findExistingRefineTerminal,
} from '../../src/mesh/mesh-refine-terminal-guard'

/**
 * ★REFINE-TERMINAL-ONCE regression suite (defect observed 2026-08-20, 2/2 jobs).
 *
 * A daemon restart mid-refine made the boot resume scan re-dispatch the SAME jobId
 * (JOBID-RESUME-PRESERVE) into a fresh process while the ORIGINAL process was still
 * running the job. Two independent executions, one jobId, two terminal rows:
 *
 *     10:21:06  task_failed    ← the GHOST (execution ix_mt1de9pf_97sexk), 1.5s in
 *     10:21:10  task_completed ← the REAL job (execution ix_mt1d5wir_luwqpf), merged
 *
 * ★The ordering trap this suite pins: the ghost wrote FIRST. A "first terminal write
 * wins" guard would enshrine the ghost's spurious failure and discard the real
 * success — guaranteeing the wrong answer in the one case with real evidence.
 */

// ★Real identities from the observed timeline.
const REAL_EXECUTION = 'ix_mt1d5wir_luwqpf'
const GHOST_EXECUTION = 'ix_mt1de9pf_97sexk'
const JOB_ID = 'refine_ix_mt1d5wir_3226uh'
const NODE_ID = 'node-under-refine'

const CTX = { jobId: JOB_ID, nodeId: NODE_ID }

describe('decideRefineTerminalWrite — ★the observed ghost-first ordering', () => {
  it('★a real SUCCESS supersedes a ghost failure that was written FIRST', () => {
    // The ghost already wrote task_failed at 10:21:06.
    const ghostFailure = {
      kind: 'task_failed' as const,
      interactionId: GHOST_EXECUTION,
      completedAt: '2026-08-20T10:21:06.000Z',
    }
    // The real job now reports success at 10:21:10.
    const decision = decideRefineTerminalWrite(
      { kind: 'task_completed', interactionId: REAL_EXECUTION, completedAt: '2026-08-20T10:21:10.000Z' },
      ghostFailure,
      CTX,
    )

    // ★The whole point: the later, TRUE outcome wins. A naive first-wins guard
    // would return allow:false here and permanently record the ghost's failure.
    expect(decision.allow).toBe(true)
    expect(decision.allow && decision.supersedes).toBe(true)
    expect(decision.reason).toBe('convergence_supersedes_failure')
    // ★And it is loud about it — both execution identities are named, which is what
    // makes the ghost diagnosable at all.
    expect(decision.allow && decision.note).toContain(GHOST_EXECUTION)
    expect(decision.allow && decision.note).toContain(REAL_EXECUTION)
  })

  it('★a ghost FAILURE can never overwrite an already-recorded convergence', () => {
    // Mirror image: the real job won the race and converged first.
    const realSuccess = {
      kind: 'task_completed' as const,
      interactionId: REAL_EXECUTION,
      completedAt: '2026-08-20T10:21:04.000Z',
    }
    const decision = decideRefineTerminalWrite(
      { kind: 'task_failed', interactionId: GHOST_EXECUTION, completedAt: '2026-08-20T10:21:06.000Z' },
      realSuccess,
      CTX,
    )

    expect(decision.allow).toBe(false)
    expect(decision.reason).toBe('failure_cannot_supersede_convergence')
    // ★The refusal explains the destructive outcome it prevents: telling the
    // coordinator to re-refine a branch that is already on origin.
    expect(decision.allow === false && decision.note).toContain('already-merged branch')
  })

  it('★the refusal is NEVER silent — it names both executions and the jobId', () => {
    const decision = decideRefineTerminalWrite(
      { kind: 'task_failed', interactionId: GHOST_EXECUTION },
      { kind: 'task_completed', interactionId: REAL_EXECUTION },
      CTX,
    )
    expect(decision.allow).toBe(false)
    const note = decision.allow === false ? decision.note : ''
    expect(note).toContain(JOB_ID)
    expect(note).toContain(NODE_ID)
    expect(note).toContain(GHOST_EXECUTION)
    expect(note).toContain(REAL_EXECUTION)
    // Points the next reader at the mechanism rather than leaving a bare refusal.
    expect(note).toContain('REFINE-RESUME-LIVENESS')
  })
})

describe('decideRefineTerminalWrite — first write and equal grades', () => {
  it('the first terminal write for a jobId always proceeds', () => {
    const decision = decideRefineTerminalWrite(
      { kind: 'task_completed', interactionId: REAL_EXECUTION },
      undefined,
      CTX,
    )
    expect(decision.allow).toBe(true)
    expect(decision.allow && decision.supersedes).toBe(false)
    expect(decision.reason).toBe('first_terminal')
  })

  it.each([
    ['task_failed' as const],
    ['task_completed' as const],
  ])('a SECOND %s for one jobId is refused — same grade carries no new outcome', (kind) => {
    const decision = decideRefineTerminalWrite(
      { kind, interactionId: GHOST_EXECUTION },
      { kind, interactionId: REAL_EXECUTION, completedAt: '2026-08-20T10:21:06.000Z' },
      CTX,
    )
    expect(decision.allow).toBe(false)
    expect(decision.reason).toBe('duplicate_terminal_same_grade')
    expect(decision.allow === false && decision.note).toContain(GHOST_EXECUTION)
  })
})

describe('findExistingRefineTerminal', () => {
  const entry = (kind: string, jobId: string, interactionId: string, timestamp: string, nodeId = NODE_ID) => ({
    kind, nodeId, timestamp,
    payload: { source: 'refine_mesh_node_async_job', refineJob: { jobId, interactionId, completedAt: timestamp } },
  })

  it('finds the terminal row for a jobId', () => {
    const found = findExistingRefineTerminal(
      [entry('task_failed', JOB_ID, GHOST_EXECUTION, '2026-08-20T10:21:06.000Z')],
      NODE_ID, JOB_ID,
    )
    expect(found?.kind).toBe('task_failed')
    expect(found?.interactionId).toBe(GHOST_EXECUTION)
  })

  it('returns undefined when only a dispatch row exists (the normal in-flight case)', () => {
    const found = findExistingRefineTerminal(
      [{ kind: 'task_dispatched', nodeId: NODE_ID, timestamp: '2026-08-20T10:14:34.000Z',
         payload: { refineJob: { jobId: JOB_ID } } }],
      NODE_ID, JOB_ID,
    )
    expect(found).toBeUndefined()
  })

  it('does not match a different jobId or a different node', () => {
    const entries = [entry('task_completed', 'refine_other', REAL_EXECUTION, '2026-08-20T10:21:10.000Z')]
    expect(findExistingRefineTerminal(entries, NODE_ID, JOB_ID)).toBeUndefined()
    expect(findExistingRefineTerminal(
      [entry('task_completed', JOB_ID, REAL_EXECUTION, '2026-08-20T10:21:10.000Z', 'other-node')],
      NODE_ID, JOB_ID,
    )).toBeUndefined()
  })

  it('★returns the EARLIEST terminal row when the store already holds duplicates', () => {
    // Rows written before this guard shipped — e.g. the observed pair. The earliest
    // is the one every later row was implicitly compared against.
    const found = findExistingRefineTerminal(
      [
        entry('task_completed', JOB_ID, REAL_EXECUTION, '2026-08-20T10:21:10.000Z'),
        entry('task_failed', JOB_ID, GHOST_EXECUTION, '2026-08-20T10:21:06.000Z'),
      ],
      NODE_ID, JOB_ID,
    )
    expect(found?.interactionId).toBe(GHOST_EXECUTION)
  })

  it('★an unparseable timestamp still counts as a terminal row (it just sorts last)', () => {
    const found = findExistingRefineTerminal(
      [entry('task_failed', JOB_ID, GHOST_EXECUTION, 'not-a-date')],
      NODE_ID, JOB_ID,
    )
    // Dropping it would reopen the duplicate window on exactly the corrupt data most
    // likely to confuse a reader.
    expect(found).toBeDefined()
    expect(found?.kind).toBe('task_failed')
  })
})

describe('★end-to-end: the observed 2026-08-20 sequence produces ONE correct terminal', () => {
  it('ghost failure then real success → the ledger ends up reporting the SUCCESS', () => {
    const ledger: Array<{ kind: string; nodeId: string; timestamp: string; payload: unknown }> = []
    const write = (kind: 'task_completed' | 'task_failed', interactionId: string, timestamp: string) => {
      const existing = findExistingRefineTerminal(ledger, NODE_ID, JOB_ID)
      const decision = decideRefineTerminalWrite({ kind, interactionId, completedAt: timestamp }, existing, CTX)
      if (decision.allow) {
        ledger.push({ kind, nodeId: NODE_ID, timestamp,
          payload: { refineJob: { jobId: JOB_ID, interactionId, completedAt: timestamp } } })
      }
      return decision
    }

    // 10:21:06 — the ghost fails first.
    expect(write('task_failed', GHOST_EXECUTION, '2026-08-20T10:21:06.000Z').allow).toBe(true)
    // 10:21:10 — the real job converges.
    const real = write('task_completed', REAL_EXECUTION, '2026-08-20T10:21:10.000Z')
    expect(real.allow).toBe(true)
    expect(real.allow && real.supersedes).toBe(true)

    // ★The winning outcome — the one a coordinator reading latest-wins sees — is the
    // real success, not the ghost's failure.
    expect(ledger[ledger.length - 1].kind).toBe('task_completed')

    // And a THIRD write (a further ghost) cannot undo it.
    const third = write('task_failed', 'ix_another_ghost', '2026-08-20T10:21:12.000Z')
    expect(third.allow).toBe(false)
    expect(ledger[ledger.length - 1].kind).toBe('task_completed')
  })
})
