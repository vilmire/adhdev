import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { shouldAutoRetryRefine } from '../../src/commands/router-refine'
import { convergeDivergedSubmoduleGitlinks } from '../../src/mesh/mesh-refine-gates'

// ③ Single-node async auto-retry + the pointer re-targeting gate.
//
// The retry decision is exercised through `shouldAutoRetryRefine`, the single
// predicate `finishMeshRefineJob` consults before re-running the pipeline. The
// discriminator that matters is the ONE-RETRY BOUND: the `refineRetried` marker the
// retry stamps onto its result is the same marker that makes a second retry
// impossible, so a broken bound is directly observable here rather than only as an
// invocation count buried behind a mocked pipeline.

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

describe('③ single-node async path: bounded automatic retry', () => {
  it('retries a base_moved blocker — the peer-advanced-the-base case', () => {
    // A peer advanced origin/main while this node validated. Nothing about this
    // node's own content failed, so a re-run is exactly the right response.
    const decision = shouldAutoRetryRefine({ success: false, code: 'base_moved', retryable: true })
    expect(decision.retry).toBe(true)
    expect(decision.code).toBe('base_moved')
  })

  it('retries a base_locked blocker (the other base-movement code)', () => {
    const decision = shouldAutoRetryRefine({ success: false, code: 'base_locked', retryable: true })
    expect(decision.retry).toBe(true)
    expect(decision.code).toBe('base_locked')
  })

  it('★does NOT retry twice: a result already carrying the retry marker is terminal', () => {
    // This is the bound. The retry stamps `refineRetried` onto its result; that same
    // marker is what makes a THIRD pipeline run impossible even though the failure is
    // still the retryable base_moved. Without it the node could re-queue forever while
    // the base keeps moving.
    const secondFailure = { success: false, code: 'base_moved', retryable: true, refineRetried: true }
    expect(shouldAutoRetryRefine(secondFailure).retry).toBe(false)

    // ...and the very same failure WITHOUT the marker would have been retried, so the
    // marker is doing the work — the assertion is not vacuously true.
    const firstFailure = { success: false, code: 'base_moved', retryable: true }
    expect(shouldAutoRetryRefine(firstFailure).retry).toBe(true)
  })

  it('does NOT retry a real merge conflict — only the base-movement family', () => {
    const decision = shouldAutoRetryRefine({
      success: false, code: 'merge_failed',
      refineStages: [{ stage: 'merge', status: 'failed' }],
    })
    expect(decision.retry).toBe(false)
  })

  it('does NOT retry a validation failure or a rebase conflict', () => {
    expect(shouldAutoRetryRefine({
      success: false, code: 'validation_failed',
      refineStages: [{ stage: 'validation', status: 'failed' }],
    }).retry).toBe(false)

    expect(shouldAutoRetryRefine({
      success: false, code: 'needs_rebase_with_conflicts',
      refineStages: [{ stage: 'patch_equivalence_after_auto_rebase', status: 'failed' }],
    }).retry).toBe(false)
  })

  it('does NOT retry a success — the normal single-refine path is unchanged', () => {
    // Regression guard for the "single refine behaves exactly as today" requirement.
    expect(shouldAutoRetryRefine({ success: true, code: 'merged' }).retry).toBe(false)
    expect(shouldAutoRetryRefine({
      success: false, code: 'already_merged', alreadyMergedViaOtherPath: true,
    }).retry).toBe(false)
  })
})

// ── ★ Pointer re-targeting gate ────────────────────────────────────────────
//
// `git rebase` exits 0 even when it drops every commit it replayed, if the base
// side already contains an equivalent patch. The converged pointer then equals the
// base commit and the branch-side work is unreachable — staging it into the root
// commit silently discards one side's work. Verified empirically before writing
// this test: rebase exit 0, HEAD == baseCommit, branchCommit NOT an ancestor.

function initSubmoduleTopology(root: string) {
  // Root repo declaring an `oss` submodule.
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')

  // The submodule checkout lives at repo/oss as a real git repo.
  const sub = join(repo, 'oss')
  mkdirSync(sub, { recursive: true })
  git(sub, 'init', '-q', '-b', 'main')
  git(sub, 'config', 'user.email', 'test@example.com')
  git(sub, 'config', 'user.name', 'Test User')
  writeFileSync(join(sub, 'lib.txt'), 'base\n', 'utf-8')
  git(sub, 'add', '.')
  git(sub, 'commit', '-q', '-m', 'sub init')
  return { repo, sub }
}

describe('★ pointer re-targeting gate: never silently drop a side', () => {
  it('refuses to converge when the rebase dropped the branch-side commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-pointer-gate-drop-'))
    try {
      const { repo, sub } = initSubmoduleTopology(root)
      const forkPoint = git(sub, 'rev-parse', 'HEAD')

      // Branch side adds a feature.
      git(sub, 'checkout', '-q', '-b', 'feat')
      writeFileSync(join(sub, 'lib.txt'), 'base\nfeature\n', 'utf-8')
      git(sub, 'commit', '-q', '-am', 'branch adds feature')
      const branchCommit = git(sub, 'rev-parse', 'HEAD')

      // Base side independently lands the SAME content (a sibling refine merged it).
      git(sub, 'checkout', '-q', 'main')
      writeFileSync(join(sub, 'lib.txt'), 'base\nfeature\n', 'utf-8')
      git(sub, 'commit', '-q', '-am', 'sibling landed equivalent content')
      const baseCommit = git(sub, 'rev-parse', 'HEAD')

      // Sanity: this really is a sibling divergence off a shared fork point.
      expect(baseCommit).not.toBe(branchCommit)
      expect(git(sub, 'merge-base', baseCommit, branchCommit)).toBe(forkPoint)

      // Root commits: base tree points at baseCommit, branch tree at branchCommit.
      git(repo, 'update-index', '--add', '--cacheinfo', `160000,${baseCommit},oss`)
      writeFileSync(join(repo, 'root.txt'), 'root\n', 'utf-8')
      git(repo, 'add', 'root.txt')
      git(repo, 'commit', '-q', '-m', 'base points at baseCommit')
      const baseHead = git(repo, 'rev-parse', 'HEAD')

      git(repo, 'checkout', '-q', '-b', 'feat/branch')
      git(repo, 'update-index', '--add', '--cacheinfo', `160000,${branchCommit},oss`)
      git(repo, 'commit', '-q', '-m', 'branch points at branchCommit')
      const branchHead = git(repo, 'rev-parse', 'HEAD')

      const result = convergeDivergedSubmoduleGitlinks(repo, repo, baseHead, branchHead)

      // The gate must refuse: rebasing branchCommit onto baseCommit drops it entirely,
      // so converging would stage a pointer from which the branch work is unreachable.
      expect(result.converged).toBe(false)
      expect(result.reason).toBe('rebase_dropped_branch_commits')
      expect(result.resolutions).toEqual([])
      expect(result.gitlinks.some(g => g.action === 'rebase_dropped_branch_commits')).toBe(true)

      // And the branch's work genuinely did NOT survive the rebase: the tip collapsed
      // onto the base commit, so zero commits were replayed on top of it. This is the
      // loss the gate prevented, not a hypothetical.
      const rebased = result.gitlinks.find(g => g.action === 'rebase_dropped_branch_commits')?.rebasedCommit
      expect(rebased).toBe(baseCommit)
      expect(git(sub, 'rev-list', '--count', `${baseCommit}..${rebased}`)).toBe('0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still converges normally when the rebase PRESERVES the branch-side commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-pointer-gate-ok-'))
    try {
      const { repo, sub } = initSubmoduleTopology(root)

      // Branch side and base side touch DIFFERENT files — the rebase replays cleanly
      // and the branch commit survives as a descendant.
      git(sub, 'checkout', '-q', '-b', 'feat')
      writeFileSync(join(sub, 'branch-only.txt'), 'branch\n', 'utf-8')
      git(sub, 'add', '.')
      git(sub, 'commit', '-q', '-m', 'branch adds its own file')
      const branchCommit = git(sub, 'rev-parse', 'HEAD')

      git(sub, 'checkout', '-q', 'main')
      writeFileSync(join(sub, 'base-only.txt'), 'base\n', 'utf-8')
      git(sub, 'add', '.')
      git(sub, 'commit', '-q', '-m', 'base adds its own file')
      const baseCommit = git(sub, 'rev-parse', 'HEAD')

      git(repo, 'update-index', '--add', '--cacheinfo', `160000,${baseCommit},oss`)
      writeFileSync(join(repo, 'root.txt'), 'root\n', 'utf-8')
      git(repo, 'add', 'root.txt')
      git(repo, 'commit', '-q', '-m', 'base points at baseCommit')
      const baseHead = git(repo, 'rev-parse', 'HEAD')

      git(repo, 'checkout', '-q', '-b', 'feat/branch')
      git(repo, 'update-index', '--add', '--cacheinfo', `160000,${branchCommit},oss`)
      git(repo, 'commit', '-q', '-m', 'branch points at branchCommit')
      const branchHead = git(repo, 'rev-parse', 'HEAD')

      const result = convergeDivergedSubmoduleGitlinks(repo, repo, baseHead, branchHead)

      // Genuine convergence is NOT blocked by the gate.
      expect(result.reason).not.toBe('rebase_dropped_branch_commits')
      expect(result.converged).toBe(true)
      expect(result.resolutions).toHaveLength(1)
      const rebased = result.resolutions[0].rebasedCommit
      // The base is an ancestor of the converged pointer (a strict fast-forward), and
      // the branch's work was really replayed on top of it rather than dropped.
      expect(() => git(sub, 'merge-base', '--is-ancestor', baseCommit, rebased)).not.toThrow()
      expect(Number(git(sub, 'rev-list', '--count', `${baseCommit}..${rebased}`))).toBeGreaterThan(0)
      // The branch-only file survived into the converged tree.
      expect(git(sub, 'show', `${rebased}:branch-only.txt`)).toBe('branch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
