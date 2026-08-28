import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { probeSubmoduleGitlinkReachability } from '../../src/mesh/mesh-refine-gitlink-utils'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function configureUser(repo: string) {
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

/**
 * Build a bare submodule origin whose default branch is `defaultBranch`, seed a
 * base commit and a branch-side commit on it, and clone it twice: once as the
 * "base repo" submodule checkout (only has the base commit) and once as the
 * "probe root" submodule checkout (only has the branch commit, detached) — the
 * same base/worktree split `classifyPatchEquivalenceFailure` probes in prod.
 */
function buildGitlinkFixture(root: string, defaultBranch: string): {
  baseRepoRoot: string
  probeRoot: string
  path: string
  baseCommit: string
  branchCommit: string
} {
  const path = 'sub'
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  mkdirSync(seed, { recursive: true })
  git(root, ['init', '--bare', '-q', '-b', defaultBranch, origin])
  git(seed, ['init', '-q', '-b', defaultBranch])
  configureUser(seed)
  writeFileSync(join(seed, 'README.md'), 'base\n', 'utf-8')
  git(seed, ['add', 'README.md'])
  git(seed, ['commit', '-q', '-m', 'base'])
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '-q', '-u', 'origin', defaultBranch])
  const baseCommit = git(seed, ['rev-parse', 'HEAD'])

  // Branch-side commit, published to the submodule's default branch (so
  // reachability is genuinely true) — mirrors the "the commit is already on
  // the submodule's default branch" 2026-08-22 false-block scenario.
  writeFileSync(join(seed, 'README.md'), 'branch\n', 'utf-8')
  git(seed, ['add', 'README.md'])
  git(seed, ['commit', '-q', '-m', 'branch'])
  git(seed, ['push', '-q', 'origin', defaultBranch])
  const branchCommit = git(seed, ['rev-parse', 'HEAD'])

  const baseRepoRoot = join(root, 'base-repo')
  const probeRoot = join(root, 'probe-root')
  mkdirSync(join(baseRepoRoot, path), { recursive: true })
  mkdirSync(join(probeRoot, path), { recursive: true })
  // Base checkout: only knows the base commit (clone, then reset to it).
  git(root, ['clone', '-q', origin, join(baseRepoRoot, path)])
  git(join(baseRepoRoot, path), ['checkout', '-q', baseCommit])
  // Probe (worktree) checkout: only knows the branch commit, detached — same
  // shape as a refine node's submodule checkout.
  git(root, ['clone', '-q', origin, join(probeRoot, path)])
  git(join(probeRoot, path), ['checkout', '-q', branchCommit])

  return { baseRepoRoot, probeRoot, path, baseCommit, branchCommit }
}

describe('probeSubmoduleGitlinkReachability — default branch generalization (H1)', () => {
  it('reports reachableFromOriginMain:true for a master-default submodule when defaultBranch is passed', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-gitlink-master-'))
    try {
      const fixture = buildGitlinkFixture(root, 'master')
      const result = probeSubmoduleGitlinkReachability({
        path: fixture.path,
        baseCommit: fixture.baseCommit,
        branchCommit: fixture.branchCommit,
        probeRoot: fixture.probeRoot,
        baseRepoRoot: fixture.baseRepoRoot,
        defaultBranch: 'master',
      })
      expect(result.undeterminable).toBeUndefined()
      expect(result.reachableFromOriginMain).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('★RED without the fix: omitting defaultBranch on a master-default submodule probes the wrong ref and cannot answer', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-gitlink-master-omitted-'))
    try {
      const fixture = buildGitlinkFixture(root, 'master')
      // No defaultBranch passed — falls back to 'main', which this submodule
      // never had (it is master-default), so refs/remotes/origin/main does not
      // resolve and the probe must land 'undeterminable', never a wrong answer.
      const result = probeSubmoduleGitlinkReachability({
        path: fixture.path,
        baseCommit: fixture.baseCommit,
        branchCommit: fixture.branchCommit,
        probeRoot: fixture.probeRoot,
        baseRepoRoot: fixture.baseRepoRoot,
      })
      expect(result.reachableFromOriginMain).toBeUndefined()
      expect(result.undeterminable).toContain('reachableFromOriginMain')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('stays byte-identical (reachableFromOriginMain:true against origin/main) for a main-default submodule with defaultBranch omitted', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-gitlink-main-'))
    try {
      const fixture = buildGitlinkFixture(root, 'main')
      const result = probeSubmoduleGitlinkReachability({
        path: fixture.path,
        baseCommit: fixture.baseCommit,
        branchCommit: fixture.branchCommit,
        probeRoot: fixture.probeRoot,
        baseRepoRoot: fixture.baseRepoRoot,
      })
      expect(result.undeterminable).toBeUndefined()
      expect(result.reachableFromOriginMain).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
})
