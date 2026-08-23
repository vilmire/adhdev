import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildGitlinkFastForwardUndeterminableWarning,
  collectFastForwardGitlinkPaths,
  collectTrivialFastForwardGitlinkResolutions,
  evaluateGitlinkTrivialFastForward,
} from '../../src/commands/router'

/**
 * ★Third recurrence of ONE defect class: a git presence check (`cat-file -e`)
 * and a git ancestry answer (`merge-base --is-ancestor`) sharing a single
 * `catch { return false }`, so "the object is not here" becomes "these commits
 * diverged". Prior instances: `isSubmoduleDivergedSibling`, then `execGitOk`.
 * This file pins the remaining one, `isSubmoduleFastForward`.
 *
 * Two things are asserted, and the SECOND matters more than the first:
 *   1. an unanswerable probe is reported as `undeterminable_gitlinks`, not as
 *      `diverged_gitlinks` (the misdiagnosis this fixes), and
 *   2. ★a genuinely diverged gitlink is STILL BLOCKED and STILL reported as
 *      `diverged_gitlinks` — the tri-state must not become a loophole. Every
 *      block that existed before must still exist; only the WORDING of the
 *      unanswerable case changed.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim()
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

function commitFile(repo: string, name: string, content: string, message: string): string {
  writeFileSync(join(repo, name), content, 'utf-8')
  git(repo, ['add', name])
  git(repo, ['commit', '-q', '-m', message])
  return git(repo, ['rev-parse', 'HEAD'])
}

const cleanups: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refine-gitlink-undet-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/**
 * Root repo + submodule where the BRANCH-side gitlink points at a submodule
 * commit that exists only in the submodule's origin and was never fetched into
 * the root's `sub` checkout. `cat-file -e` therefore fails on it, so no ancestry
 * question about it can be answered at all.
 *
 * The pointer is written with `update-index --cacheinfo`, which records a
 * gitlink SHA without requiring the object to be present locally — exactly the
 * real-world shape (a worktree whose submodule store lacks a commit another
 * machine created).
 */
function setupMissingBranchSideObject() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const root = join(tmp, 'root')

  initRepo(submoduleOrigin)
  const subC1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subC2 = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2')

  initRepo(root)
  commitFile(root, 'top.txt', 'top base\n', 'root init')
  git(root, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(root, 'sub'), ['checkout', '-q', subC1])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'pin submodule at v1'])

  // Base advances the submodule to v2 (present locally — it was cloned in).
  git(join(root, 'sub'), ['checkout', '-q', subC2])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'base: sub v2'])
  const baseHead = git(root, ['rev-parse', 'HEAD'])

  // ★Created in origin AFTER the submodule clone, and never fetched: the object
  // simply does not exist in the root's `sub` store. subUnfetched is a straight
  // DESCENDANT of subC2 — so had the object been present, base→branch would be a
  // clean FAST-FORWARD, not a divergence. That is precisely what makes the old
  // `diverged_gitlinks` label a factually wrong claim about this history.
  const subUnfetched = commitFile(submoduleOrigin, 'mod.txt', 'v3\n', 'sub v3 (never fetched)')

  // Branch records a gitlink to subUnfetched WITHOUT the object being present.
  git(root, ['checkout', '-q', '-b', 'feat'])
  git(root, ['update-index', '--cacheinfo', `160000,${subUnfetched},sub`])
  git(root, ['commit', '-q', '-m', 'branch: sub v3 pointer (object absent locally)'])
  const branchHead = git(root, ['rev-parse', 'HEAD'])

  // Sanity: the branch-side object really is absent from the submodule store.
  let present = true
  try {
    execFileSync('git', ['cat-file', '-e', `${subUnfetched}^{commit}`], { cwd: join(root, 'sub'), stdio: 'ignore' })
  } catch { present = false }
  expect(present).toBe(false)

  return { root, baseHead, branchHead, subC2, subUnfetched }
}

/**
 * Root repo + submodule with a REAL divergence: base and branch point at two
 * submodule commits, both present locally, neither an ancestor of the other.
 */
function setupRealDivergence() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const root = join(tmp, 'root')

  initRepo(submoduleOrigin)
  const subC1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subC2 = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2')
  git(submoduleOrigin, ['checkout', '-q', '-b', 'fork', subC1])
  const subForked = commitFile(submoduleOrigin, 'other.txt', 'forked\n', 'sub forked')
  git(submoduleOrigin, ['checkout', '-q', 'main'])

  initRepo(root)
  commitFile(root, 'top.txt', 'top base\n', 'root init')
  git(root, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(root, 'sub'), ['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
  git(join(root, 'sub'), ['checkout', '-q', subC2])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'base: sub v2'])
  const baseHead = git(root, ['rev-parse', 'HEAD'])

  git(root, ['checkout', '-q', '-b', 'feat'])
  git(join(root, 'sub'), ['checkout', '-q', subForked])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'branch: sub forked'])
  const branchHead = git(root, ['rev-parse', 'HEAD'])

  return { root, baseHead, branchHead, subC2, subForked }
}

// -----------------------------------------------------------------------

describe('gitlink fast-forward probe: undeterminable is not diverged', () => {
  // ★INJECTION TEST. Revert `isSubmoduleFastForward` to the shared
  // `catch { return false }` and this goes red: the reason reads
  // `diverged_gitlinks:sub`, asserting a divergence that was never measured
  // (the two commits are in fact a clean fast-forward).
  it('reports a missing gitlink object as undeterminable, NOT as diverged', () => {
    const { root, baseHead, branchHead } = setupMissingBranchSideObject()

    const result = evaluateGitlinkTrivialFastForward(root, baseHead, branchHead)

    // Still blocked — the gate's strength is unchanged.
    expect(result.trivial).toBe(false)
    // ...but the reason must not claim a divergence we never measured.
    expect(result.reason).toMatch(/undeterminable_gitlinks:sub/)
    expect(result.reason).not.toMatch(/diverged_gitlinks/)
    expect(result.gitlinks[0]).toMatchObject({
      path: 'sub',
      fastForward: false,
      fastForwardUndeterminable: true,
    })
  })

  it('emits a loud "undeterminable, NOT diverged" warning for the unanswerable case', () => {
    const { root, baseHead, branchHead } = setupMissingBranchSideObject()
    const result = evaluateGitlinkTrivialFastForward(root, baseHead, branchHead)

    const warning = buildGitlinkFastForwardUndeterminableWarning('test node', result.gitlinks)
    expect(warning).toBeTruthy()
    expect(warning).toMatch(/NOT "diverged"/)
    expect(warning).toMatch(/sub/)
  })

  // ★★OVER-CORRECTION GUARD — the most important assertion in this file.
  // A genuine submodule divergence (both objects present, neither an ancestor of
  // the other) must STILL block and STILL be labelled `diverged_gitlinks`. If a
  // future change makes the tri-state leak real divergences through as
  // "undeterminable" (or, worse, as trivial), submodule integrity is gone.
  it('still blocks a REAL divergence and still calls it diverged', () => {
    const { root, baseHead, branchHead } = setupRealDivergence()

    const result = evaluateGitlinkTrivialFastForward(root, baseHead, branchHead)

    expect(result.trivial).toBe(false)
    expect(result.reason).toMatch(/diverged_gitlinks:sub/)
    expect(result.reason).not.toMatch(/undeterminable_gitlinks/)
    expect(result.gitlinks[0]).toMatchObject({ path: 'sub', fastForward: false })
    expect(result.gitlinks[0].fastForwardUndeterminable).toBeUndefined()
    // No warning for a measured divergence — the loud path is for "could not judge" only.
    expect(buildGitlinkFastForwardUndeterminableWarning('test node', result.gitlinks)).toBeUndefined()
  })

  // ★Over-correction guard for the OTHER two call sites: both must remain
  // conservative. An unanswerable probe is not a proven fast-forward, so the
  // path must NOT be excluded from patch-id comparison and must NOT get a
  // rebase resolution — identical to the pre-fix behaviour.
  it('does not treat an unanswerable gitlink as a proven fast-forward at any call site', () => {
    const { root, baseHead, branchHead } = setupMissingBranchSideObject()

    expect(collectFastForwardGitlinkPaths(root, baseHead, branchHead)).toEqual([])
    expect(collectTrivialFastForwardGitlinkResolutions(root, root, baseHead, branchHead)).toEqual([])
  })

  it('does not treat a real divergence as a proven fast-forward at any call site', () => {
    const { root, baseHead, branchHead } = setupRealDivergence()

    expect(collectFastForwardGitlinkPaths(root, baseHead, branchHead)).toEqual([])
    expect(collectTrivialFastForwardGitlinkResolutions(root, root, baseHead, branchHead)).toEqual([])
  })
})
