import { describe, expect, it } from 'vitest'

import {
  classifyRefineRebaseFailure,
  extractRebaseFailureText,
  buildRefineRebaseFailureError,
} from '../../src/mesh/mesh-refine-rebase-failure'

/**
 * ★REBASE-FAILURE-CLASSIFY regression suite (defect observed 2026-08-20).
 *
 * The rebase catch block in router-refine.ts returned a HARDCODED
 * `needs_rebase_with_conflicts` + "auto-rebase failed due to conflicts" for every
 * rebase failure, without ever inspecting the error. The ledger's own `sync_base`
 * stage held git's actual stderr for the two affected jobs:
 *
 *     error: cannot rebase: You have unstaged changes.
 *     error: Please commit or stash them.
 *
 * The rebase never ran. There was no conflict — the branch was ahead:0, behind:1,
 * diverged:false. The invented word "conflicts" is what led the coordinator toward a
 * manual strict-ff bypass of an already-merged branch.
 *
 * The two anchor cases below use the REAL stderr strings as constants.
 */

/** ★The verbatim stderr from the observed defect. */
const OBSERVED_DIRTY_WORKTREE_STDERR = [
  'error: cannot rebase: You have unstaged changes.',
  'error: Please commit or stash them.',
].join('\n')

/** git's real output when a rebase genuinely conflicts. */
const REAL_CONFLICT_STDERR = [
  'Auto-merging src/app.ts',
  'CONFLICT (content): Merge conflict in src/app.ts',
  'error: could not apply 1a2b3c4d… feat: thing',
  'Resolve all conflicts manually, mark them as resolved with "git add/rm <conflicted_files>"',
].join('\n')

/** Shape execFileSync throws: message is generic, stderr carries the cause. */
function execFileSyncError(stderr: string, stdout = '') {
  const err: any = new Error('Command failed: git rebase d8fa65de')
  err.stderr = Buffer.from(stderr)
  err.stdout = Buffer.from(stdout)
  err.status = 1
  return err
}

describe('classifyRefineRebaseFailure — ★the observed false-conflict', () => {
  it('★classifies "cannot rebase: You have unstaged changes." as worktree_dirty, NOT a conflict', () => {
    const c = classifyRefineRebaseFailure(execFileSyncError(OBSERVED_DIRTY_WORKTREE_STDERR))

    // ★The regression: this was `needs_rebase_with_conflicts` before the fix.
    expect(c.code).toBe('worktree_dirty')
    expect(c.conflict).toBe(false)
    expect(c.detail).toBe('unstaged_changes')
    // A dirty worktree may be transient build output — worth one automatic retry.
    expect(c.retryable).toBe(true)
  })

  it('★preserves the ORIGINAL git stderr verbatim — the only reason the defect was diagnosable', () => {
    const c = classifyRefineRebaseFailure(execFileSyncError(OBSERVED_DIRTY_WORKTREE_STDERR))
    expect(c.originalStderr).toContain('cannot rebase: You have unstaged changes.')
    expect(c.originalStderr).toContain('Please commit or stash them.')
  })

  it('★the human-facing error says the rebase REFUSED TO START and never says "conflict"', () => {
    const c = classifyRefineRebaseFailure(execFileSyncError(OBSERVED_DIRTY_WORKTREE_STDERR))
    const msg = buildRefineRebaseFailureError(c, {
      baseBranch: 'main', diverged: false, ahead: 0, behind: 1,
    })

    expect(msg).toContain('REFUSED TO START')
    expect(msg).toContain('uncommitted changes')
    // ★No CLAIM of a conflict survives. The message may only mention conflicts to
    // DENY one ("nothing conflicted") — asserting on the bare word would fail on
    // that denial, which is the sentence doing the actual corrective work here.
    expect(msg).toContain('nothing conflicted')
    for (const invented of [
      'hit conflicts',
      'failed due to conflicts',
      'resolve conflicts manually',
      'CONTENT CONFLICTS',
    ]) {
      expect(msg).not.toContain(invented)
    }
    // ★git's own words ride along in the message itself, not only the ledger.
    expect(msg).toContain('cannot rebase: You have unstaged changes.')
  })

  it('★reproduces the observed divergence framing: behind was TRUE, conflicts were INVENTED', () => {
    const c = classifyRefineRebaseFailure(execFileSyncError(OBSERVED_DIRTY_WORKTREE_STDERR))
    const msg = buildRefineRebaseFailureError(c, {
      baseBranch: 'main', diverged: false, ahead: 0, behind: 1,
    })
    // "behind main" was a true statement about the branch and is kept…
    expect(msg).toContain('behind main')
    // …while the conflict claim, which the error handler authored, is not.
    expect(c.conflict).toBe(false)
  })
})

describe('classifyRefineRebaseFailure — real conflicts still classify as conflicts', () => {
  it('★a genuine CONFLICT marker keeps needs_rebase_with_conflicts', () => {
    const c = classifyRefineRebaseFailure(execFileSyncError(REAL_CONFLICT_STDERR))
    expect(c.code).toBe('needs_rebase_with_conflicts')
    expect(c.conflict).toBe(true)
    expect(c.detail).toBe('merge_conflict')
    // A real content conflict needs a human — never auto-retried.
    expect(c.retryable).toBe(false)
  })

  it('the conflict error message still tells the coordinator to resolve manually', () => {
    const c = classifyRefineRebaseFailure(execFileSyncError(REAL_CONFLICT_STDERR))
    const msg = buildRefineRebaseFailureError(c, {
      baseBranch: 'main', diverged: true, ahead: 3, behind: 2,
    })
    expect(msg).toContain('CONTENT CONFLICTS')
    expect(msg).toContain('diverged from main (ahead 3, behind 2)')
    expect(msg).toContain('Merge conflict in src/app.ts')
  })

  it.each([
    ['CONFLICT (content): Merge conflict in a.ts'],
    ['error: could not apply abc1234... some commit'],
    ['Automatic merge failed; fix conflicts and then commit the result.'],
  ])('recognizes conflict marker: %s', (stderr) => {
    expect(classifyRefineRebaseFailure(execFileSyncError(stderr)).conflict).toBe(true)
  })

  it('★does NOT self-confirm on the word "conflict" appearing in our OWN advice prose', () => {
    // If CONFLICT were matched case-insensitively, this string — which is the tail of
    // the OLD hardcoded error message — would classify as a conflict, making the
    // classifier agree with the very bug it replaces.
    const c = classifyRefineRebaseFailure(
      execFileSyncError('fatal: some unrelated failure; resolve conflicts manually and retry.'),
    )
    expect(c.conflict).toBe(false)
    expect(c.code).toBe('rebase_failed')
  })
})

describe('classifyRefineRebaseFailure — other non-conflict preconditions', () => {
  it.each([
    ['error: cannot rebase: Your index contains uncommitted changes.', 'worktree_dirty', 'uncommitted_changes'],
    ['error: The following untracked working tree files would be overwritten by merge:\n\tdist/x.js', 'worktree_dirty', 'untracked_would_be_overwritten'],
    ['error: Your local changes to the following files would be overwritten by merge:\n\tpkg.json', 'worktree_dirty', 'uncommitted_changes'],
    ['fatal: It seems that there is already a rebase-merge directory', 'rebase_precondition_failed', 'rebase_in_progress'],
    ['error: Recursive merging with submodules currently only supports trivial cases.', 'rebase_precondition_failed', 'submodule_non_trivial_merge'],
  ])('%s → %s / %s', (stderr, code, detail) => {
    const c = classifyRefineRebaseFailure(execFileSyncError(stderr))
    expect(c.code).toBe(code)
    expect(c.detail).toBe(detail)
    expect(c.conflict).toBe(false)
  })

  it('★an unrecognized failure is rebase_failed — honest, not "conflict"', () => {
    const c = classifyRefineRebaseFailure(execFileSyncError('fatal: not a git repository'))
    expect(c.code).toBe('rebase_failed')
    expect(c.conflict).toBe(false)
    expect(c.detail).toBe('unclassified')
    // Even with nothing recognized, the raw text survives for the next reader.
    expect(c.originalStderr).toContain('not a git repository')
  })

  it('★a precondition abort wins over a stray conflict word in the same output', () => {
    // git's dirty-worktree abort can be followed by unrelated advice text. The rebase
    // did not run, so no conflict claim can be true whatever else the text contains.
    const c = classifyRefineRebaseFailure(execFileSyncError(
      `${OBSERVED_DIRTY_WORKTREE_STDERR}\nhint: CONFLICT (content): Merge conflict in old.ts`,
    ))
    expect(c.code).toBe('worktree_dirty')
    expect(c.conflict).toBe(false)
  })
})

describe('extractRebaseFailureText', () => {
  it('★prefers stderr — execFileSync\'s message alone NEVER carries the cause', () => {
    const text = extractRebaseFailureText(execFileSyncError(OBSERVED_DIRTY_WORKTREE_STDERR))
    expect(text).toContain('cannot rebase: You have unstaged changes.')
    // The generic message is still present as context, but is not the only content —
    // which is exactly why the old handler (reading only `message`) could not classify.
    expect(text).toContain('Command failed: git rebase')
  })

  it('folds in the gitlink-aware rebase\'s synthetic reason and conflict paths', () => {
    const err: any = new Error('gitlink-aware rebase aborted: conflict')
    err.gitlinkRebaseReason = 'Recursive merging with submodules currently only supports trivial cases'
    err.gitlinkRebaseConflicts = ['oss']
    const text = extractRebaseFailureText(err)
    expect(text).toContain('trivial cases')
    expect(text).toContain('conflicting paths: oss')
    // …and that path classifies as the submodule precondition, not a content conflict.
    expect(classifyRefineRebaseFailure(err).detail).toBe('submodule_non_trivial_merge')
  })

  it('handles a string, a bare Error, and null without throwing', () => {
    expect(extractRebaseFailureText('boom')).toBe('boom')
    expect(extractRebaseFailureText(new Error('boom'))).toBe('boom')
    expect(extractRebaseFailureText(null)).toBe('')
    expect(classifyRefineRebaseFailure(null).code).toBe('rebase_failed')
  })
})

describe('buildRefineRebaseFailureError — stderr excerpt bound', () => {
  it('truncates a pathological stderr but says where the full text lives', () => {
    const huge = 'x'.repeat(5_000)
    const c = classifyRefineRebaseFailure(execFileSyncError(huge))
    const msg = buildRefineRebaseFailureError(c, { baseBranch: 'main', diverged: false, ahead: 0, behind: 1 })
    expect(msg).toContain('[truncated; full text in the sync_base stage record]')
    // The classification itself keeps the untruncated text.
    expect(c.originalStderr.length).toBeGreaterThan(4_900)
  })
})
