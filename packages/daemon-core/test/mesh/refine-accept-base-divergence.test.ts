import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { assessRefineBaseDivergence } from '../../src/mesh/mesh-refine-base-divergence'

// ⓪ accept-time base-divergence pre-check.
//
// The mechanism under test is the one that produced four `patch_equivalence_failed`
// incidents in a single day: parallel refines each pin a baseHead, the first to merge
// advances origin/main, and every sibling then validates against a base that moved.
// This check answers "did the base move out from under this branch?" at ACCEPT time.

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

/** A bare origin + a clone acting as the base repo root, mirroring the real topology. */
function initRepoWithOrigin(root: string) {
  const origin = join(root, 'origin.git')
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '--bare', '-b', 'main')

  const repo = join(root, 'repo')
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'README.md'), 'base\n', 'utf-8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'push', '-q', 'origin', 'main')
  return { origin, repo }
}

/** Branch the worktree off the CURRENT base and add a commit of its own. */
function addWorktree(repo: string, branch: string, file: string) {
  const wt = join(repo, '..', `wt-${branch.replace(/\//g, '-')}`)
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt)
  writeFileSync(join(wt, file), `${file}\n`, 'utf-8')
  git(wt, 'add', '.')
  git(wt, 'commit', '-q', '-m', `work on ${branch}`)
  return wt
}

/** Advance origin/main behind the worktree's back — the sibling-merged-first case. */
function advanceOriginMain(repo: string, file: string) {
  writeFileSync(join(repo, file), `${file}\n`, 'utf-8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', `sibling landed ${file}`)
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'fetch', '-q', 'origin', 'main')
}

describe('⓪ assessRefineBaseDivergence — accept-time base movement pre-check', () => {
  it('reports `clear` when the base has not moved under the branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-divergence-clear-'))
    try {
      const { repo } = initRepoWithOrigin(root)
      const wt = addWorktree(repo, 'feat/a', 'a.txt')

      const assessment = await assessRefineBaseDivergence({
        repoRoot: repo, workspace: wt, baseBranch: 'main', branch: 'feat/a',
      })

      expect(assessment.verdict).toBe('clear')
      // The root scope is always judged, and it is judged CLEAR (not merely absent).
      const rootScope = assessment.scopes.find(s => s.path === '.')
      expect(rootScope?.verdict).toBe('clear')
      // No submodules declared → nothing else was judged.
      expect(assessment.touchedSubmodulePaths).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports `diverged` once a sibling advances origin/main past the branch point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-divergence-moved-'))
    try {
      const { repo } = initRepoWithOrigin(root)
      const wt = addWorktree(repo, 'feat/a', 'a.txt')

      // Before the sibling lands, the branch is clear...
      const before = await assessRefineBaseDivergence({
        repoRoot: repo, workspace: wt, baseBranch: 'main', branch: 'feat/a',
      })
      expect(before.verdict).toBe('clear')

      // ...a sibling refine merges and pushes, advancing origin/main.
      advanceOriginMain(repo, 'sibling.txt')

      const after = await assessRefineBaseDivergence({
        repoRoot: repo, workspace: wt, baseBranch: 'main', branch: 'feat/a',
      })
      expect(after.verdict).toBe('diverged')
      const rootScope = after.scopes.find(s => s.path === '.')
      expect(rootScope?.verdict).toBe('diverged')
      // A real divergence still shares history — the merge base is the fork point.
      expect(rootScope?.mergeBase).toBeTruthy()
      expect(rootScope?.liveBaseHead).toBeTruthy()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('FAILS CLOSED to `unknown` (never `clear`) when the check cannot run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-divergence-failclosed-'))
    try {
      const { repo } = initRepoWithOrigin(root)
      const wt = addWorktree(repo, 'feat/a', 'a.txt')

      // A workspace that is not a git repo at all — every git call errors.
      const notARepo = join(root, 'not-a-repo')
      mkdirSync(notARepo, { recursive: true })
      const broken = await assessRefineBaseDivergence({
        repoRoot: repo, workspace: notARepo, baseBranch: 'main', branch: 'feat/a',
      })
      expect(broken.verdict).toBe('unknown')
      expect(broken.scopes.find(s => s.path === '.')?.verdict).toBe('unknown')

      // A branch ref that does not exist is likewise un-judgeable, not clear.
      const missingBranch = await assessRefineBaseDivergence({
        repoRoot: repo, workspace: wt, baseBranch: 'main', branch: 'feat/does-not-exist',
      })
      expect(missingBranch.verdict).toBe('unknown')
      expect(missingBranch.verdict).not.toBe('clear')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scopes submodule judgement to the submodules the branch actually TOUCHES', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-divergence-subscope-'))
    try {
      const { repo } = initRepoWithOrigin(root)
      // Declare two submodule paths, mirroring this repo's oss + adhdev-providers.
      writeFileSync(
        join(repo, '.gitmodules'),
        '[submodule "oss"]\n\tpath = oss\n\turl = ./oss-origin\n'
        + '[submodule "providers"]\n\tpath = providers\n\turl = ./providers-origin\n',
        'utf-8',
      )
      git(repo, 'add', '.gitmodules')
      git(repo, 'commit', '-q', '-m', 'declare submodules')
      git(repo, 'push', '-q', 'origin', 'main')

      // A branch that bumps ONLY the `oss` gitlink — `providers` is untouched, exactly
      // the incident case where rebasing adhdev-providers would have been pure waste.
      const wt = addWorktree(repo, 'feat/oss-only', 'note.txt')
      const gitlinkSha = git(wt, 'commit-tree', git(wt, 'write-tree'), '-m', 'sub')
      git(wt, 'update-index', '--add', '--cacheinfo', `160000,${gitlinkSha},oss`)
      git(wt, 'commit', '-q', '-m', 'bump oss gitlink')

      const assessment = await assessRefineBaseDivergence({
        repoRoot: repo, workspace: wt, baseBranch: 'main', branch: 'feat/oss-only',
      })

      // Only the touched submodule is in scope; the untouched one is never judged.
      expect(assessment.touchedSubmodulePaths).toContain('oss')
      expect(assessment.touchedSubmodulePaths).not.toContain('providers')
      expect(assessment.scopes.map(s => s.path)).not.toContain('providers')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★zero-latency: the accept-time check is cheap enough to run inline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-divergence-latency-'))
    try {
      const { repo } = initRepoWithOrigin(root)
      const wt = addWorktree(repo, 'feat/a', 'a.txt')

      const started = Date.now()
      const assessment = await assessRefineBaseDivergence({
        repoRoot: repo, workspace: wt, baseBranch: 'main', branch: 'feat/a',
      })
      const wall = Date.now() - started

      // A handful of local git plumbing calls — no fetch, no checkout, no network.
      // The bound is deliberately loose (win32 git spawns are ~3-4s each) but still
      // proves the check is not doing anything expensive like a fetch or a rebase.
      expect(assessment.durationMs).toBeLessThan(5000)
      expect(wall).toBeLessThan(5000)
      // eslint-disable-next-line no-console
      console.log(`[⓪ accept precheck latency] wall=${wall}ms reported=${assessment.durationMs}ms verdict=${assessment.verdict}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
