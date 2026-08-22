// ---------------------------------------------------------------------------
// GHOST-WORKTREE-CLEANUP-DEADLOCK — convergence for a worktree whose DIRECTORY
// no longer exists.
//
// Before the fix, `getWorktreeForceCleanupConvergence` resolved the head commit
// by running `git rev-parse HEAD` INSIDE the worktree. When the directory was
// gone that spawn failed with ENOENT and the verdict became
// `allow:false / "could not resolve worktree HEAD: spawn git ENOENT"`, which the
// retention pass reports as `convergence_unproven` (candidate:false). The
// causality was inverted: a vanished worktree could never be cleaned up, and
// the very fact that proved it safe to remove was what blocked removal.
//
// The fix resolves the branch tip from the SOURCE REPO's ref store instead, so
// the ordinary containment / patch-equivalence checks still decide merged-ness.
// That is a change of WHERE the commit is read from, never a weakening of the
// verdict — which is what the unmerged case below pins down.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { getWorktreeForceCleanupConvergence } from '../../src/commands/router-worktree-cleanup'

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
  const dir = mkdtempSync(join(tmpdir(), 'worktree-ghost-conv-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// The function only needs `self` for the patch-equivalence fallback, which it
// reaches via a module import rather than `self`; an empty object is enough.
const SELF = {} as any

describe('getWorktreeForceCleanupConvergence — missing worktree directory', () => {
  // INJECTION TEST (reverting the fix turns this red): the worktree path does
  // not exist and the branch IS merged into main. Convergence must be proven
  // from the source repo, NOT refused with a spawn ENOENT.
  it('proves convergence from the source repo when the worktree path is gone but the branch is merged', async () => {
    const root = makeTmp()
    const repo = join(root, 'repo')
    initRepo(repo)
    commitFile(repo, 'f.txt', 'base\n', 'base')

    git(repo, ['checkout', '-q', '-b', 'feat/merged'])
    commitFile(repo, 'f.txt', 'base\nfeature\n', 'feat change')
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge feat', 'feat/merged'])

    // The worktree directory never existed on disk (the ghost shape).
    const ghostWorkspace = join(root, 'gone-worktree')

    const verdict = await getWorktreeForceCleanupConvergence(SELF, {
      repoRoot: repo,
      workspace: ghostWorkspace,
      node: { worktreeBranch: 'feat/merged' },
    })

    expect(verdict.allow).toBe(true)
    expect(verdict.error).toBeUndefined()
    // Resolved via the ordinary containment path, from the source repo.
    expect(verdict.status).toBe('merged_to_default_ref')
  })

  // ★SAFETY PIN: a missing directory must NOT become a blanket "safe to remove".
  // The branch still carries commits that are absent from main, so the verdict
  // stays allow:false — which is what makes the caller PRESERVE the branch ref
  // (`deleteBranchIfMerged` deletes only on a proven-merged status). This is the
  // real case from the field: feat/mesh-ui-observability survived on the remote.
  it('still refuses when the worktree path is gone but the branch has UNMERGED commits', async () => {
    const root = makeTmp()
    const repo = join(root, 'repo')
    initRepo(repo)
    commitFile(repo, 'f.txt', 'base\n', 'base')

    git(repo, ['checkout', '-q', '-b', 'feat/unmerged'])
    commitFile(repo, 'only-here.txt', 'work that never landed\n', 'unmerged work')
    git(repo, ['checkout', '-q', 'main'])

    const ghostWorkspace = join(root, 'gone-worktree')

    const verdict = await getWorktreeForceCleanupConvergence(SELF, {
      repoRoot: repo,
      workspace: ghostWorkspace,
      node: { worktreeBranch: 'feat/unmerged' },
    })

    expect(verdict.allow).toBe(false)
    // Refused on real containment grounds, not on a spawn failure.
    expect(verdict.error).toContain('not contained in checked refs')
    expect(verdict.error).not.toContain('ENOENT')
  })

  // Worktree gone AND the branch ref gone: no commit survives that could hold
  // unmerged work, so there is nothing left to protect.
  it('allows removal when both the worktree path and the branch ref are absent', async () => {
    const root = makeTmp()
    const repo = join(root, 'repo')
    initRepo(repo)
    commitFile(repo, 'f.txt', 'base\n', 'base')

    const verdict = await getWorktreeForceCleanupConvergence(SELF, {
      repoRoot: repo,
      workspace: join(root, 'gone-worktree'),
      node: { worktreeBranch: 'feat/never-existed' },
    })

    expect(verdict.allow).toBe(true)
    expect(verdict.status).toBe('worktree_and_branch_absent')
  })

  // Fail-closed: without a usable source repo the branch tip cannot be read at
  // all, so absence must NOT be read as convergence.
  it('refuses when the worktree path is gone and the source repo root is unavailable', async () => {
    const root = makeTmp()

    const verdict = await getWorktreeForceCleanupConvergence(SELF, {
      repoRoot: join(root, 'no-such-repo'),
      workspace: join(root, 'gone-worktree'),
      node: { worktreeBranch: 'feat/thing' },
    })

    expect(verdict.allow).toBe(false)
    expect(verdict.error).toContain('source repo root is unavailable')
  })

  // Fail-closed: no branch metadata means no ref to resolve the tip from.
  it('refuses when the worktree path is gone and worktreeBranch metadata is missing', async () => {
    const root = makeTmp()
    const repo = join(root, 'repo')
    initRepo(repo)
    commitFile(repo, 'f.txt', 'base\n', 'base')

    const verdict = await getWorktreeForceCleanupConvergence(SELF, {
      repoRoot: repo,
      workspace: join(root, 'gone-worktree'),
      node: {},
    })

    expect(verdict.allow).toBe(false)
    expect(verdict.error).toContain('worktreeBranch metadata is absent')
  })

  // Regression guard: an EXISTING worktree must keep resolving HEAD from the
  // worktree itself (the fix must not reroute the normal path).
  it('still resolves HEAD from the worktree itself when the directory exists', async () => {
    const root = makeTmp()
    const repo = join(root, 'repo')
    initRepo(repo)
    commitFile(repo, 'f.txt', 'base\n', 'base')

    git(repo, ['checkout', '-q', '-b', 'feat/live'])
    commitFile(repo, 'f.txt', 'base\nfeature\n', 'feat change')
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge feat', 'feat/live'])

    const worktreePath = join(root, 'live-worktree')
    git(repo, ['worktree', 'add', '-q', worktreePath, 'feat/live'])

    const verdict = await getWorktreeForceCleanupConvergence(SELF, {
      repoRoot: repo,
      workspace: worktreePath,
      node: { worktreeBranch: 'feat/live' },
    })

    expect(verdict.allow).toBe(true)
    expect(verdict.status).toBe('merged_to_default_ref')
  })
})
