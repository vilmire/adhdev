import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { checkWorktreeChangesPatchEquivalentInRef } from '../../src/commands/router'

// --- git helpers --------------------------------------------------------

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
  const dir = mkdtempSync(join(tmpdir(), 'worktree-cleanup-pe-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('checkWorktreeChangesPatchEquivalentInRef', () => {
  // The core convergence case: the worktree branch's content was cherry-picked
  // onto main under a DIFFERENT commit SHA, so the worktree HEAD is not an
  // ancestor of main. The content is nevertheless already present, so the
  // containment check must report `contained: true` (the cleanup guard allows
  // removal via the patch-equivalence fallback).
  it('reports contained when the worktree content was cherry-picked into the ref', async () => {
    const root = makeTmp()
    initRepo(root)
    commitFile(root, 'f.txt', 'base\n', 'base')

    // Worktree branch with a change.
    git(root, ['checkout', '-q', '-b', 'feat'])
    const head = commitFile(root, 'f.txt', 'base\nfeature\n', 'feat change')

    // main advances and cherry-picks the same content under a new SHA.
    git(root, ['checkout', '-q', 'main'])
    commitFile(root, 'g.txt', 'unrelated\n', 'main unrelated')
    git(root, ['cherry-pick', '-x', head])
    const mainCommit = git(root, ['rev-parse', 'main'])

    // Sanity: the SHA-reachability primary guard would (correctly) say NO here.
    expect(() => git(root, ['merge-base', '--is-ancestor', head, mainCommit])).toThrow()

    const result = await checkWorktreeChangesPatchEquivalentInRef(root, mainCommit, head)
    expect(result.contained).toBe(true)
    expect(result.residualPatchId).toBe('')
    expect(result.error).toBeUndefined()
  })

  // The genuine non-convergence case: the worktree carries content that is NOT
  // present on the ref. Merging it would introduce a real patch, so containment
  // must be false and the cleanup guard stays blocked.
  it('reports NOT contained when the worktree content is absent from the ref', async () => {
    const root = makeTmp()
    initRepo(root)
    commitFile(root, 'f.txt', 'base\n', 'base')

    git(root, ['checkout', '-q', '-b', 'feat'])
    const head = commitFile(root, 'f.txt', 'base\nfeature\n', 'feat change')

    // main advances but never receives the feature content.
    git(root, ['checkout', '-q', 'main'])
    const mainCommit = commitFile(root, 'g.txt', 'unrelated\n', 'main unrelated')

    const result = await checkWorktreeChangesPatchEquivalentInRef(root, mainCommit, head)
    expect(result.contained).toBe(false)
    expect(result.residualPatchId).not.toBe('')
  })

  // When the worktree HEAD is already a strict ancestor of the ref (the normal
  // merged case), merging adds nothing — containment must be true. The cleanup
  // guard reaches this helper only after the ancestor check fails, but the
  // containment notion must still agree for an already-merged branch.
  it('reports contained when the worktree HEAD is an ancestor of the ref', async () => {
    const root = makeTmp()
    initRepo(root)
    commitFile(root, 'f.txt', 'base\n', 'base')

    git(root, ['checkout', '-q', '-b', 'feat'])
    const head = commitFile(root, 'f.txt', 'base\nfeature\n', 'feat change')

    // Fast-forward main to include the worktree commit verbatim.
    git(root, ['checkout', '-q', 'main'])
    git(root, ['merge', '-q', '--ff-only', 'feat'])
    const mainCommit = git(root, ['rev-parse', 'main'])
    expect(() => git(root, ['merge-base', '--is-ancestor', head, mainCommit])).not.toThrow()

    const result = await checkWorktreeChangesPatchEquivalentInRef(root, mainCommit, head)
    expect(result.contained).toBe(true)
    expect(result.residualPatchId).toBe('')
  })

  // Conservative failure: an unresolvable ref (bad object) must not throw and must
  // not be treated as contained — a thrown error can never widen the allow-list.
  it('reports NOT contained (conservative) when git fails to resolve the ref', async () => {
    const root = makeTmp()
    initRepo(root)
    const head = commitFile(root, 'f.txt', 'base\n', 'base')

    const result = await checkWorktreeChangesPatchEquivalentInRef(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', head)
    expect(result.contained).toBe(false)
    expect(result.error).toBeTruthy()
  })

  // Partial containment must still block: if the worktree carries TWO changes and
  // only one was cherry-picked into the ref, the residual (the still-missing
  // change) must keep containment false.
  it('reports NOT contained when only part of the worktree content landed on the ref', async () => {
    const root = makeTmp()
    initRepo(root)
    commitFile(root, 'f.txt', 'base\n', 'base')

    git(root, ['checkout', '-q', '-b', 'feat'])
    const firstChange = commitFile(root, 'a.txt', 'alpha\n', 'add a')
    const head = commitFile(root, 'b.txt', 'beta\n', 'add b')

    // main cherry-picks ONLY the first change.
    git(root, ['checkout', '-q', 'main'])
    git(root, ['cherry-pick', '-x', firstChange])
    const mainCommit = git(root, ['rev-parse', 'main'])

    const result = await checkWorktreeChangesPatchEquivalentInRef(root, mainCommit, head)
    expect(result.contained).toBe(false)
    expect(result.residualPatchId).not.toBe('')
  })
})
