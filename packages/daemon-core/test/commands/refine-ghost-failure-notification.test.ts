import { describe, expect, it } from 'vitest'

import {
  extractRefineMergeLanding,
  slimRefineEventResult,
  classifyBatchNodeConvergence,
} from '../../src/commands/router-refine'
import {
  classifyRefineTerminal,
  refineTerminalNextStep,
  buildRefineWorktreeMissingResult,
} from '../../src/mesh/mesh-refine-landing'

// GHOST-FAILURE: a refine that MERGED and PUSHED, then failed a trailing local step,
// was reported to the coordinator as a flat failure (`refine:failed` / `task_failed`)
// with no merge evidence on the event. Four such notifications landed in a single day;
// each time the merge was actually on origin and the worktree already deleted, and the
// coordinator had to run `git log` by hand to avoid misfiling landed work as
// blocked_review — or worse, re-refining an already-merged node.
//
// The two halves under test:
//   (A) reporting  — a post-merge failure is CONVERGED (notify completed) while still
//       carrying its blocker detail, and the landing facts ride on the slim event.
//   (B) prevention — a refine whose worktree is already gone terminates as a named
//       `worktree_missing` blocker instead of dying with a ghost
//       dependency_bootstrap_failed / merge_failed from spawning into a deleted dir.
//
// The load-bearing risk is the inverse: swallowing a REAL failure. Every real-failure
// shape observed on the same day is pinned below and must stay reported.

/**
 * Wraps the PRODUCTION classifier (`classifyRefineTerminal` — the exact function
 * `finishMeshRefineJob` calls) and applies the same converged→event/ledger mapping the
 * job applies. Nothing about the decision is re-implemented here, so these assertions
 * cannot pass while the shipped classification is wrong.
 */
function terminalReporting(result: Record<string, unknown>) {
  const c = classifyRefineTerminal(result)
  return {
    kind: c.kind,
    landing: c.landing,
    isPostMergeWarning: c.isPostMergeWarning,
    converged: c.converged,
    ledgerKind: c.converged ? 'task_completed' : 'task_failed',
    event: c.converged ? 'refine:completed' : 'refine:failed',
  }
}

// ── The four ghost notifications of 2026-08-15, as result shapes ────────────────
//
// Reconstructed from the terminal shapes runRefineMergeAndFinalizeLocked returns after
// a SUCCESSFUL merge+push: cleanup_failed and post_merge_submodule_alignment_failed
// both stamp merged/pushed alongside success:false.

const CLEANUP_FAILED_AFTER_PUSH = {
  success: false,
  code: 'cleanup_failed',
  error: 'Refinery merge + push completed but worktree cleanup failed; the change is on origin.',
  merged: true,
  pushed: true,
  branch: 'fix/quota-fallback-observability',
  into: 'main',
  finalBranchConvergenceState: {
    branch: 'main', mergedBranch: 'fix/quota-fallback-observability', baseBranch: 'main',
    merged: true, pushed: true, removed: false, status: 'merged_cleanup_failed',
  },
}

const POST_MERGE_ALIGNMENT_FAILED = {
  success: false,
  code: 'post_merge_submodule_alignment_failed',
  error: 'Refinery merge completed but post-merge submodule checkout alignment failed.',
  merged: true,
  branch: 'feat/daemon-track-visibility',
  into: 'main',
  finalBranchConvergenceState: {
    branch: 'main', mergedBranch: 'feat/daemon-track-visibility', baseBranch: 'main',
    merged: true, pushed: true, removed: false, status: 'post_merge_alignment_failed',
  },
}

describe('(A) a merge that LANDED is never notified as a failure', () => {
  it('★cleanup_failed after a successful push notifies refine:completed, not refine:failed', () => {
    const r = terminalReporting(CLEANUP_FAILED_AFTER_PUSH)

    // The whole defect in one assertion: this is the notification the coordinator acted on.
    expect(r.event).toBe('refine:completed')
    expect(r.ledgerKind).toBe('task_completed')
    expect(r.converged).toBe(true)
    expect(r.isPostMergeWarning).toBe(true)
    expect(r.landing).toEqual({ merged: true, pushed: true })
    // ...but it is NOT reported as a clean success — the unclean state is named, so the
    // residual worktree cleanup still surfaces to the operator.
    expect(r.kind).toBe('completed_with_warnings')
  })

  it('★post-merge submodule alignment failure is likewise converged', () => {
    // Note this shape sets `merged` at top level but `pushed` only inside
    // finalBranchConvergenceState — the landing extractor must read both places, or
    // this real ghost slips back through as a failure.
    const r = terminalReporting(POST_MERGE_ALIGNMENT_FAILED)
    expect(r.event).toBe('refine:completed')
    expect(r.landing).toEqual({ merged: true, pushed: true })
  })

  it('a fully clean success is still a plain success (no warning misfiling)', () => {
    const r = terminalReporting({ success: true, merged: true, pushed: true })
    expect(r.event).toBe('refine:completed')
    expect(r.isPostMergeWarning).toBe(false) // clean, not "converged with warnings"
  })
})

describe('(B) real failures MUST still be reported — the load-bearing risk', () => {
  // Every one of these merged NOTHING. If the ghost fix ever reclassifies one of them
  // as converged, landed-vs-not becomes unknowable and the fix is worse than the bug.
  const REAL_FAILURES: Array<[string, Record<string, unknown>]> = [
    ['runner error (no code, outer catch)', { success: false, error: 'spawn ETIMEDOUT' }],
    ['file-size gate', {
      success: false, code: 'validation_failed',
      validationSummary: { status: 'failed', failureCode: 'validation_failed' },
    }],
    ['vendor drift', {
      success: false, code: 'validation_failed',
      validationSummary: { status: 'failed', failureKind: 'validation_failed' },
    }],
    ['output limit exceeded', { success: false, code: 'output_limit_exceeded' }],
    ['dependency bootstrap (genuine)', { success: false, code: 'dependency_bootstrap_failed' }],
    ['rebase conflict (genuine)', { success: false, code: 'needs_rebase_with_conflicts' }],
    ['merge conflict', {
      success: false, code: 'merge_failed', conflictPaths: ['src/a.ts'],
      finalBranchConvergenceState: { merged: false, status: 'not_mergeable' },
    }],
    ['submodule reachability', { success: false, code: 'submodule_reachability_failed' }],
    ['worktree missing (the new code)', { success: false, code: 'worktree_missing', workspaceMissing: true }],
  ]

  it.each(REAL_FAILURES)('★%s still notifies refine:failed', (_label, shape) => {
    const r = terminalReporting(shape)
    expect(r.event).toBe('refine:failed')
    expect(r.ledgerKind).toBe('task_failed')
    expect(r.converged).toBe(false)
    expect(r.landing.merged).toBe(false)
  })

  it('★merged LOCALLY but push FAILED is NOT converged — origin does not have it', () => {
    // The tightest boundary in the fix. The merge commit exists on the local base, so a
    // naive "did we merge?" check would call this converged and the coordinator would
    // stop chasing a change that never reached origin.
    const pushFailed = {
      success: false,
      code: 'push_failed',
      merged: true,
      mergedLocal: true,
      pushed: false,
      finalBranchConvergenceState: { merged: true, pushed: false, status: 'merged_push_failed' },
    }
    const r = terminalReporting(pushFailed)
    expect(r.event).toBe('refine:failed')
    expect(r.converged).toBe(false)
    expect(r.landing).toEqual({ merged: true, pushed: false })
  })

  it('a `pushed` marker without a `merged` marker is never treated as landed', () => {
    // Incoherent shape (no stage produces it); refuse to infer a landing from it.
    expect(extractRefineMergeLanding({ success: false, pushed: true })).toEqual({
      merged: false, pushed: false,
    })
  })
})

describe('(C) the coordinator can tell landed-from-not WITHOUT running git', () => {
  it('★the slim event carries the merge-landing facts', () => {
    // The coordinator sees ONLY the slim result. Before this fix the merge markers were
    // dropped here, so even a correctly-classified result arrived with no evidence and
    // the coordinator fell back to a manual `git log` — the operational cost being paid
    // four times a day.
    const slim = slimRefineEventResult({
      ...CLEANUP_FAILED_AFTER_PUSH,
      postMergeWarning: 'Merge landed and was pushed to origin/main.',
      validationSummary: { status: 'passed', commandsRun: [{ command: 'npm', passed: true }] },
    })

    expect(slim.merged).toBe(true)
    expect(slim.pushed).toBe(true)
    expect(slim.postMergeWarning).toContain('pushed to origin/main')
    expect(slim.code).toBe('cleanup_failed') // blocker detail is NOT swallowed
  })

  it('the slim event still drops the heavy per-command detail it was slimming', () => {
    const slim = slimRefineEventResult({
      success: true, merged: true, pushed: true,
      validationSummary: {
        status: 'passed',
        commandsRun: [{ command: 'npm', args: ['run', 'ci'], stdout: 'x'.repeat(5000), passed: true }],
      },
    })
    expect(JSON.stringify(slim).length).toBeLessThan(1000)
  })
})

describe('(D) the ghost SECOND job: a refine whose worktree is already gone', () => {
  // How the observed ghosts were manufactured: a first refine merged, pushed and
  // deleted the worktree. A re-refine of that node then spawned git / the bootstrap
  // commands with cwd = the deleted directory, dying with ENOENT — surfaced as
  // `dependency_bootstrap_failed`, or (no `code` at all) as the `merge_failed`
  // fallback. Both are the reported ghost codes. The guard names the state instead.
  const missing = buildRefineWorktreeMissingResult('node-x', '/gone/worktree', [])

  it('★is a named blocker, never a ghost bootstrap/merge failure', () => {
    expect(missing.code).toBe('worktree_missing')
    expect(missing.success).toBe(false)
    expect(missing.code).not.toBe('dependency_bootstrap_failed')
    expect(missing.code).not.toBe('merge_failed')
  })

  it('★classifies as blocked_review — NOT the misleading merge_failed fallback', () => {
    expect(classifyRefineTerminal(missing).kind).toBe('blocked_review')
  })

  it('★never claims success, and is never auto-retried', () => {
    // It must not claim a merge it did not perform...
    const c = classifyRefineTerminal(missing)
    expect(c.converged).toBe(false)
    expect(c.landing.merged).toBe(false)
    // ...and retrying cannot recreate a deleted worktree, so it must not be retryable.
    expect(missing.retryable).toBe(false)
  })

  it('tells the coordinator to VERIFY rather than re-refine', () => {
    expect(String(missing.error)).toContain('most likely already merged')
    expect(String(missing.nextStep)).toContain('merged_to_main')
  })
})

describe('(E) next-step never tells a coordinator to re-refine landed work', () => {
  it('★a post-merge warning must NOT suggest retrying mesh_refine_node', () => {
    const step = refineTerminalNextStep('completed_with_warnings')
    expect(step).toContain('do NOT re-run mesh_refine_node')
    expect(step).toContain('merged_to_main')
  })

  it('genuine failures DO still suggest a retry after fixing the cause', () => {
    expect(refineTerminalNextStep('validation_failed')).toContain('retry mesh_refine_node')
    expect(refineTerminalNextStep('merge_failed')).toContain('retry mesh_refine_node')
  })
})

describe('(F) batch convergence classification is unchanged', () => {
  // The batch path was deliberately left alone; pin that it still classifies these the
  // way it always did, so the reporting fix cannot have leaked into merge behaviour.
  it('a post-merge cleanup failure is still blocked_review for the BATCH', () => {
    expect(classifyBatchNodeConvergence(CLEANUP_FAILED_AFTER_PUSH).convergence).toBe('blocked_review')
  })

  it('a real merge conflict is still not_mergeable and never retryable', () => {
    const c = classifyBatchNodeConvergence({
      success: false, code: 'merge_failed', refineStages: [{ stage: 'merge', status: 'failed' }],
    })
    expect(c.convergence).toBe('not_mergeable')
    expect(c.retryable).toBe(false)
  })
})
