import { describe, expect, it } from 'vitest'
import { hostname } from 'node:os'

import {
  buildRefineExecutorStamp,
  currentRefineExecutorBootId,
  evaluateRefineExecutorLiveness,
  readRefineExecutorStamp,
} from '../../src/mesh/mesh-refine-executor-liveness'
import { classifyRefineDispatch, selectOpenRefineDispatches } from '../../src/mesh/mesh-refine-zombie-sweep'

/**
 * ★REFINE-RESUME-LIVENESS regression suite (defect observed 2026-08-20).
 *
 * `classifyRefineDispatch`'s `isRunning` reads `runningRefineJobs`, an in-memory map
 * that a daemon restart empties by construction — so the boot resume scan asks "is
 * anyone running this?", gets a structurally guaranteed "no", and re-dispatches a job
 * still running in the OLD process. The only thing between that and a ghost was a 60s
 * grace window; the two observed dispatches were 6m30s and 3m51s old and sailed
 * straight past it into `resume`.
 *
 * ★The other half of this suite pins the anti-wedge property: nothing here may make a
 * node permanently un-resumable. There is no lock to leak — liveness is derived from
 * the OS at read time — and an ABSENT stamp must read 'unknown' (resume as before),
 * never 'alive'.
 */

const LOCAL = hostname()

describe('evaluateRefineExecutorLiveness — a live executor blocks the resume', () => {
  it('★a stamp from a process that still exists reads alive', () => {
    const { liveness } = evaluateRefineExecutorLiveness(
      { host: LOCAL, pid: 4242, bootId: 'boot-old' },
      { isPidAlive: () => true },
    )
    expect(liveness).toBe('alive')
  })

  it('★a stamp minted by THIS process reads alive without needing a probe', () => {
    const stamp = buildRefineExecutorStamp()
    expect(stamp.pid).toBe(process.pid)
    expect(stamp.bootId).toBe(currentRefineExecutorBootId())
    const { liveness, reason } = evaluateRefineExecutorLiveness(stamp, {
      isPidAlive: () => { throw new Error('probe must not be needed for the self case') },
    })
    expect(liveness).toBe('alive')
    expect(reason).toBe('executor_is_this_process')
  })
})

describe('★stale locks cannot wedge a node — every "cannot tell" path stays resumable', () => {
  it('★a dead process reads dead — the moment it exits, the job is resumable again', () => {
    const { liveness } = evaluateRefineExecutorLiveness(
      { host: LOCAL, pid: 4242, bootId: 'boot-old' },
      { isPidAlive: () => false },
    )
    // ★No unlock step, no cleanup, no timeout to wait out: the OS answer simply flips.
    expect(liveness).toBe('dead')
  })

  it('★NO stamp at all (every row written before this shipped) reads unknown, not alive', () => {
    // If an absent stamp read 'alive', one pre-upgrade row would block its node
    // forever — creating the exact wedge this design exists to avoid.
    expect(evaluateRefineExecutorLiveness(undefined).liveness).toBe('unknown')
    expect(evaluateRefineExecutorLiveness(null).liveness).toBe('unknown')
    expect(evaluateRefineExecutorLiveness({}).liveness).toBe('unknown')
    expect(evaluateRefineExecutorLiveness('garbage').liveness).toBe('unknown')
  })

  it('an incomplete stamp (no pid, or a bogus pid) reads unknown', () => {
    expect(evaluateRefineExecutorLiveness({ host: LOCAL }).liveness).toBe('unknown')
    expect(evaluateRefineExecutorLiveness({ host: LOCAL, pid: 0 }).liveness).toBe('unknown')
    expect(evaluateRefineExecutorLiveness({ host: LOCAL, pid: -1 }).liveness).toBe('unknown')
    expect(evaluateRefineExecutorLiveness({ pid: 4242 }).liveness).toBe('unknown')
  })

  it('★a stamp from ANOTHER host reads unknown — a remote pid says nothing here', () => {
    const { liveness, reason } = evaluateRefineExecutorLiveness(
      { host: 'some-other-machine', pid: process.pid, bootId: 'boot-x' },
      // Never even probed: a local pid probe would answer about an unrelated process.
      { isPidAlive: () => { throw new Error('must not probe a remote pid') } },
    )
    expect(liveness).toBe('unknown')
    expect(reason).toContain('other_host')
  })

  it('★a RECYCLED pid (same pid, different boot) reads dead, not alive-forever', () => {
    // The OS handed this very daemon the dead executor's pid. Without the bootId
    // comparison the probe would say "that pid exists" (it does — it is us) and the
    // job would defer on every future boot: a permanent wedge.
    const { liveness, reason } = evaluateRefineExecutorLiveness({
      host: LOCAL, pid: process.pid, bootId: 'a-previous-boot',
    })
    expect(liveness).toBe('dead')
    expect(reason).toBe('executor_pid_recycled_by_this_process')
  })

  it('a probe that throws reads unknown — a failure is not evidence of life', () => {
    const { liveness } = evaluateRefineExecutorLiveness(
      { host: LOCAL, pid: 4242, bootId: 'boot-old' },
      { isPidAlive: () => { throw new Error('EPERM-ish') } },
    )
    expect(liveness).toBe('unknown')
  })
})

describe('classifyRefineDispatch — ★liveness supersedes the age heuristics', () => {
  const nodeExists = () => true
  const isRunning = () => false
  const OPTS = { graceMs: 60_000, zombieCutoffMs: 24 * 60 * 60_000, nodeExists, isRunning }

  // ★The two observed ghost dispatches: 6m30s and 3m51s old — long past the 60s
  // grace window, with their original processes still running.
  it.each([
    ['6m30s (refine_ix_mt1d5wir_3226uh)', 6 * 60_000 + 30_000],
    ['3m51s (refine_ix_mt1ew71i_zobslj)', 3 * 60_000 + 51_000],
  ])('★%s past grace but executor ALIVE → defer_executor_alive, not resume', (_label, ageMs) => {
    const record = {
      nodeId: 'n1', jobId: 'refine_observed', executor: { host: LOCAL, pid: 4242, bootId: 'old' },
      timestamp: new Date(Date.now() - ageMs).toISOString(),
    }
    const nowMs = Date.now()

    // ★Without the liveness probe this is the pre-fix behavior: `resume` → ghost.
    expect(classifyRefineDispatch(record, { ...OPTS, nowMs })!.disposition).toBe('resume')

    // With it, the live executor is respected.
    const decision = classifyRefineDispatch(record, {
      ...OPTS, nowMs, executorLiveness: () => 'alive',
    })
    expect(decision!.disposition).toBe('defer_executor_alive')
  })

  it('★a DEAD executor still resumes — the legitimate purpose of resume is preserved', () => {
    const record = {
      nodeId: 'n1', jobId: 'refine_crashed', executor: { host: LOCAL, pid: 4242, bootId: 'old' },
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    }
    const decision = classifyRefineDispatch(record, {
      ...OPTS, nowMs: Date.now(), executorLiveness: () => 'dead',
    })
    expect(decision!.disposition).toBe('resume')
  })

  it('★an UNKNOWN executor resumes exactly as before — unstamped rows are unaffected', () => {
    const record = {
      nodeId: 'n1', jobId: 'refine_legacy',
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    }
    const decision = classifyRefineDispatch(record, {
      ...OPTS, nowMs: Date.now(), executorLiveness: () => 'unknown',
    })
    expect(decision!.disposition).toBe('resume')
  })

  it('★a live executor is NOT closed out even past the 24h zombie cutoff', () => {
    // Writing a terminal row for a demonstrably running job is a worse version of the
    // same bug — the close-out itself becomes the ghost.
    const record = {
      nodeId: 'n1', jobId: 'refine_long', executor: { host: LOCAL, pid: 4242, bootId: 'old' },
      timestamp: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
    }
    expect(classifyRefineDispatch(record, {
      ...OPTS, nowMs: Date.now(), executorLiveness: () => 'alive',
    })!.disposition).toBe('defer_executor_alive')

    // ★But once that process is gone, the cutoff still terminates it — so even a
    // pathological "alive" answer cannot keep a node open indefinitely.
    expect(classifyRefineDispatch(record, {
      ...OPTS, nowMs: Date.now(), executorLiveness: () => 'dead',
    })!.disposition).toBe('close_stale')
  })

  it('a removed node is still closed out before liveness is ever consulted', () => {
    const record = {
      nodeId: 'gone', jobId: 'refine_x', executor: { host: LOCAL, pid: 4242, bootId: 'old' },
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    }
    const decision = classifyRefineDispatch(record, {
      ...OPTS, nowMs: Date.now(), nodeExists: () => false, executorLiveness: () => 'alive',
    })
    expect(decision!.disposition).toBe('close_removed_node')
  })

  it('an executorLiveness probe that throws falls through to the age logic', () => {
    const record = {
      nodeId: 'n1', jobId: 'refine_x', executor: { host: LOCAL, pid: 4242 },
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    }
    const decision = classifyRefineDispatch(record, {
      ...OPTS, nowMs: Date.now(), executorLiveness: () => { throw new Error('probe blew up') },
    })
    expect(decision!.disposition).toBe('resume')
  })
})

describe('the executor stamp survives the ledger round-trip', () => {
  it('selectOpenRefineDispatches carries refineJob.executor onto the record', () => {
    const stamp = buildRefineExecutorStamp()
    const open = selectOpenRefineDispatches([{
      kind: 'task_dispatched', nodeId: 'n1', timestamp: new Date().toISOString(),
      payload: { source: 'refine_mesh_node_async_job', refineJob: { jobId: 'refine_a', executor: stamp } },
    }])
    expect(open).toHaveLength(1)
    expect(open[0].executor).toEqual(stamp)
    expect(evaluateRefineExecutorLiveness(open[0].executor).liveness).toBe('alive')
  })

  it('a dispatch row with no executor yields no executor field (and classifies unknown)', () => {
    const open = selectOpenRefineDispatches([{
      kind: 'task_dispatched', nodeId: 'n1', timestamp: new Date().toISOString(),
      payload: { source: 'refine_mesh_node_async_job', refineJob: { jobId: 'refine_legacy' } },
    }])
    expect(open[0].executor).toBeUndefined()
    expect(evaluateRefineExecutorLiveness(open[0].executor).liveness).toBe('unknown')
  })

  it('readRefineExecutorStamp reads the payload shape appendRefineJobLedger writes', () => {
    const stamp = buildRefineExecutorStamp()
    expect(readRefineExecutorStamp({ refineJob: { executor: stamp } })).toEqual(stamp)
    expect(readRefineExecutorStamp({ refineJob: {} })).toBeUndefined()
    expect(readRefineExecutorStamp(undefined)).toBeUndefined()
  })
})
