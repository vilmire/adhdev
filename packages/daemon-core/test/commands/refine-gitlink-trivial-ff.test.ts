import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { evaluateGitlinkTrivialFastForward } from '../../src/commands/router'

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
  const dir = mkdtempSync(join(tmpdir(), 'refine-gitlink-'))
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// Build a root repo with one submodule. Returns root + submodule helpers so a
// test can advance the submodule pointer on base and branch independently.
function setupRootWithSubmodule() {
  const tmp = makeTmp()
  const submoduleOrigin = join(tmp, 'sub-origin')
  const root = join(tmp, 'root')

  // Submodule origin with a small history we can fast-forward through.
  initRepo(submoduleOrigin)
  const subC1 = commitFile(submoduleOrigin, 'mod.txt', 'v1\n', 'sub v1')
  const subC2 = commitFile(submoduleOrigin, 'mod.txt', 'v2\n', 'sub v2')
  const subC3 = commitFile(submoduleOrigin, 'mod.txt', 'v3\n', 'sub v3')
  // A diverged branch off v1 (NOT an ancestor of v3).
  git(submoduleOrigin, ['checkout', '-q', '-b', 'fork', subC1])
  const subForked = commitFile(submoduleOrigin, 'other.txt', 'forked\n', 'sub forked')
  git(submoduleOrigin, ['checkout', '-q', 'main'])

  // Root repo with the submodule pinned at subC1.
  initRepo(root)
  commitFile(root, 'top.txt', 'top base\n', 'root init')
  git(root, ['submodule', 'add', '-q', submoduleOrigin, 'sub'])
  git(join(root, 'sub'), ['checkout', '-q', subC1])
  git(root, ['add', 'sub'])
  git(root, ['commit', '-q', '-m', 'pin submodule at v1'])
  const baseHead = git(root, ['rev-parse', 'HEAD'])

  // Make all sub commits available inside the submodule working dir for ancestry checks.
  git(join(root, 'sub'), ['fetch', '-q', 'origin'])

  const pinRootSubmodule = (commit: string, message: string): string => {
    git(join(root, 'sub'), ['checkout', '-q', commit])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', message])
    return git(root, ['rev-parse', 'HEAD'])
  }

  return { root, baseHead, subC1, subC2, subC3, subForked, pinRootSubmodule }
}

// -----------------------------------------------------------------------

describe('evaluateGitlinkTrivialFastForward', () => {
  it('passes when the only conflict is a fast-forward gitlink bump', () => {
    const { root, baseHead, subC3, pinRootSubmodule } = setupRootWithSubmodule()
    // Branch: advance the submodule pointer to a descendant (v1 -> v3 is ff).
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = pinRootSubmodule(subC3, 'bump submodule to v3')

    const result = evaluateGitlinkTrivialFastForward(root, baseHead, branchHead)
    expect(result.trivial).toBe(true)
    expect(result.gitlinks).toHaveLength(1)
    expect(result.gitlinks[0]).toMatchObject({ path: 'sub', fastForward: true })
  })

  it('blocks when the gitlink diverged (not a fast-forward)', () => {
    const { root, baseHead, subForked, pinRootSubmodule } = setupRootWithSubmodule()
    // First move base forward to v2 so the branch fork is NOT an ancestor.
    const newBase = pinRootSubmodule(git(join(root, 'sub'), ['rev-parse', 'origin/main^']), 'base to v2')
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = pinRootSubmodule(subForked, 'point submodule at forked commit')

    const result = evaluateGitlinkTrivialFastForward(root, newBase, branchHead)
    expect(result.trivial).toBe(false)
    expect(result.reason).toMatch(/diverged_gitlinks/)
  })

  it('blocks when a regular file also conflicts alongside a ff gitlink', () => {
    const { root, baseHead, subC2, subC3, pinRootSubmodule } = setupRootWithSubmodule()
    // Diverge a regular file on BOTH sides relative to merge-base so a 3-way
    // content conflict exists in addition to the ff gitlink bump.
    // Base side: change top.txt + advance submodule to v2.
    writeFileSync(join(root, 'top.txt'), 'top BASE EDIT\n', 'utf-8')
    git(root, ['add', 'top.txt'])
    git(join(root, 'sub'), ['checkout', '-q', subC2])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'base edits top + sub v2'])
    const newBase = git(root, ['rev-parse', 'HEAD'])

    // Branch off the ORIGINAL base, edit top.txt differently + advance sub to v3.
    git(root, ['checkout', '-q', '-b', 'feat', baseHead])
    writeFileSync(join(root, 'top.txt'), 'top BRANCH EDIT\n', 'utf-8')
    git(root, ['add', 'top.txt'])
    git(join(root, 'sub'), ['checkout', '-q', subC3])
    git(root, ['add', 'sub'])
    git(root, ['commit', '-q', '-m', 'branch edits top + sub v3'])
    const branchHead = git(root, ['rev-parse', 'HEAD'])

    const result = evaluateGitlinkTrivialFastForward(root, newBase, branchHead)
    expect(result.trivial).toBe(false)
    expect(result.reason).toMatch(/non_gitlink_overlap/)
  })

  it('blocks when there is no changed gitlink at all', () => {
    const { root, baseHead } = setupRootWithSubmodule()
    git(root, ['checkout', '-q', '-b', 'feat'])
    const branchHead = commitFile(root, 'top.txt', 'top base\nfeature line\n', 'feature edit only')

    const result = evaluateGitlinkTrivialFastForward(root, baseHead, branchHead)
    expect(result.trivial).toBe(false)
    expect(result.reason).toBe('no_changed_gitlinks')
  })
})
