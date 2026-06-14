import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runMeshRefineEffectiveDiffGate } from '../../src/commands/router'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const cleanups: string[] = []

function mkrepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'refine-noop-'))
  cleanups.push(repo)
  return repo
}

function git(cwd: string, args: string[], opts: { allowFileProtocol?: boolean } = {}): string {
  const full = opts.allowFileProtocol ? ['-c', 'protocol.file.allow=always', ...args] : args
  return execFileSync('git', full, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
}

function initRepo(repo: string) {
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

function rev(repo: string, ref: string): string {
  return git(repo, ['rev-parse', ref])
}

afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('runMeshRefineEffectiveDiffGate', () => {
  it('(a) passes when the branch has a real root-tree diff against base', async () => {
    const repo = mkrepo()
    initRepo(repo)
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'init'])
    const baseHead = rev(repo, 'HEAD')

    git(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'feature.txt'), 'real change\n', 'utf8')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'feature work'])
    const branchHead = rev(repo, 'feature')

    const result = await runMeshRefineEffectiveDiffGate(repo, baseHead, branchHead)
    expect(result.status).toBe('passed')
    expect(result.hasEffectiveDiff).toBe(true)
    expect(result.changedPaths).toContain('feature.txt')
  })

  it('(a2) passes when the only change is a committed submodule gitlink (pointer) bump', async () => {
    // Submodule origin
    const subOrigin = mkrepo()
    initRepo(subOrigin)
    writeFileSync(join(subOrigin, 'README.md'), 'sub base\n', 'utf8')
    git(subOrigin, ['add', '.'])
    git(subOrigin, ['commit', '-q', '-m', 'sub init'])

    // Root repo with the submodule
    const repo = mkrepo()
    initRepo(repo)
    writeFileSync(join(repo, 'README.md'), 'root base\n', 'utf8')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'root init'])
    git(repo, ['submodule', 'add', '-q', subOrigin, 'oss'], { allowFileProtocol: true })
    git(repo, ['commit', '-q', '-m', 'add oss submodule'])
    const baseHead = rev(repo, 'HEAD')

    // Advance the submodule with a new commit, then commit the pointer bump on a branch.
    const subPath = join(repo, 'oss')
    writeFileSync(join(subPath, 'feature.txt'), 'sub work\n', 'utf8')
    git(subPath, ['add', '.'])
    git(subPath, ['commit', '-q', '-m', 'sub work'])

    git(repo, ['checkout', '-q', '-b', 'feature'])
    git(repo, ['add', 'oss'])
    git(repo, ['commit', '-q', '-m', 'bump oss pointer'])
    const branchHead = rev(repo, 'feature')

    const result = await runMeshRefineEffectiveDiffGate(repo, baseHead, branchHead)
    expect(result.status).toBe('passed')
    expect(result.hasEffectiveDiff).toBe(true)
    expect(result.changedPaths).toContain('oss')
  })

  it('(b) blocks no_effective_diff when the submodule has commits but the root pointer bump is NOT committed', async () => {
    // Submodule origin
    const subOrigin = mkrepo()
    initRepo(subOrigin)
    writeFileSync(join(subOrigin, 'README.md'), 'sub base\n', 'utf8')
    git(subOrigin, ['add', '.'])
    git(subOrigin, ['commit', '-q', '-m', 'sub init'])

    // Root repo with the submodule
    const repo = mkrepo()
    initRepo(repo)
    writeFileSync(join(repo, 'README.md'), 'root base\n', 'utf8')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'root init'])
    git(repo, ['submodule', 'add', '-q', subOrigin, 'oss'], { allowFileProtocol: true })
    git(repo, ['commit', '-q', '-m', 'add oss submodule'])
    const baseHead = rev(repo, 'HEAD')

    // Branch that carries NO root-tree change (the trap): advance the submodule but never
    // commit the gitlink bump on the root branch.
    git(repo, ['checkout', '-q', '-b', 'feature'])
    const subPath = join(repo, 'oss')
    writeFileSync(join(subPath, 'feature.txt'), 'sub work\n', 'utf8')
    git(subPath, ['add', '.'])
    git(subPath, ['commit', '-q', '-m', 'sub work'])
    // NOTE: intentionally do NOT `git add oss` / commit on the root branch.
    const branchHead = rev(repo, 'feature') // identical tree to baseHead

    const result = await runMeshRefineEffectiveDiffGate(repo, baseHead, branchHead)
    expect(result.status).toBe('failed')
    expect(result.hasEffectiveDiff).toBe(false)
    // Should surface the dirty submodule as an actionable hint.
    expect(result.submoduleHints?.some(h => h.path === 'oss')).toBe(true)
  })

  it('(b2) blocks no_effective_diff for a degenerate branch with no changes at all', async () => {
    const repo = mkrepo()
    initRepo(repo)
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'init'])
    const baseHead = rev(repo, 'HEAD')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    const branchHead = rev(repo, 'feature')

    const result = await runMeshRefineEffectiveDiffGate(repo, baseHead, branchHead)
    expect(result.status).toBe('failed')
    expect(result.hasEffectiveDiff).toBe(false)
  })
})
