import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  getSubmoduleConfiguredBranches,
  resolveSubmoduleDefaultBranch,
  SUBMODULE_DEFAULT_BRANCH_FALLBACK,
} from '../../src/mesh/worktree-bootstrap-config'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function configureUser(repo: string) {
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
}

/**
 * Build a bare origin repo whose default branch is `defaultBranch`, seed one commit
 * on it, and clone it into `<root>/checkout`. `git clone` records the remote's HEAD
 * as `refs/remotes/origin/HEAD`, so the checkout can resolve the default branch with
 * no network (tier 2). Returns the checkout dir.
 */
function createSubmoduleCheckout(root: string, defaultBranch: string): string {
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const checkout = join(root, 'checkout')
  mkdirSync(seed, { recursive: true })
  git(root, ['init', '--bare', '-q', '-b', defaultBranch, origin])
  git(seed, ['init', '-q', '-b', defaultBranch])
  configureUser(seed)
  writeFileSync(join(seed, 'README.md'), 'seed\n', 'utf-8')
  git(seed, ['add', 'README.md'])
  git(seed, ['commit', '-q', '-m', 'init'])
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '-q', '-u', 'origin', defaultBranch])
  git(root, ['clone', '-q', origin, checkout])
  return checkout
}

describe('getSubmoduleConfiguredBranches', () => {
  it('joins submodule.<name>.path with .branch and omits the "." (superproject-tracking) value', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-subbranch-config-'))
    try {
      writeFileSync(
        join(root, '.gitmodules'),
        [
          '[submodule "oss"]',
          '\tpath = oss',
          '\turl = https://example.com/oss.git',
          '\tbranch = master',
          '[submodule "providers"]',
          '\tpath = vendor/providers',
          '\turl = https://example.com/providers.git',
          // '.' means "track the superproject branch" — must be omitted, not returned literally.
          '\tbranch = .',
          '[submodule "nobranch"]',
          '\tpath = nobranch',
          '\turl = https://example.com/nobranch.git',
        ].join('\n') + '\n',
        'utf-8',
      )
      const branches = getSubmoduleConfiguredBranches(root)
      expect(branches.get('oss')).toBe('master')
      expect(branches.has('vendor/providers')).toBe(false) // '.' omitted
      expect(branches.has('nobranch')).toBe(false) // no branch key
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an empty map when there is no .gitmodules', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-subbranch-none-'))
    try {
      expect(getSubmoduleConfiguredBranches(root).size).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resolveSubmoduleDefaultBranch', () => {
  it('resolves a master-default submodule to "master" (not the hardcoded main)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-subbranch-master-'))
    try {
      const checkout = createSubmoduleCheckout(root, 'master')
      const branch = await resolveSubmoduleDefaultBranch({ submoduleRepoPath: checkout })
      expect(branch).toBe('master')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('stays byte-identical (resolves "main") for a main-default submodule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-subbranch-main-'))
    try {
      const checkout = createSubmoduleCheckout(root, 'main')
      const branch = await resolveSubmoduleDefaultBranch({ submoduleRepoPath: checkout })
      expect(branch).toBe('main')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('prefers the .gitmodules configured branch over the checkout remote HEAD (tier 1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-subbranch-tier1-'))
    try {
      // Checkout defaults to master, but .gitmodules pins the submodule to "trunk".
      const checkout = createSubmoduleCheckout(root, 'master')
      writeFileSync(
        join(root, '.gitmodules'),
        ['[submodule "sub"]', '\tpath = sub', '\turl = https://example.com/sub.git', '\tbranch = trunk'].join('\n') + '\n',
        'utf-8',
      )
      const branch = await resolveSubmoduleDefaultBranch({
        submoduleRepoPath: checkout,
        superprojectWorkspace: root,
        submodulePath: 'sub',
      })
      expect(branch).toBe('trunk')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('falls back to "main" when no configured branch, remote HEAD, or reachable remote exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-subbranch-fallback-'))
    try {
      // A bare local repo with no origin remote: tier 2 (symbolic-ref origin/HEAD) and
      // tier 3 (ls-remote origin) both fail, so the fallback must apply.
      const repo = join(root, 'repo')
      mkdirSync(repo, { recursive: true })
      git(repo, ['init', '-q', '-b', 'master'])
      configureUser(repo)
      writeFileSync(join(repo, 'f.txt'), 'x\n', 'utf-8')
      git(repo, ['add', 'f.txt'])
      git(repo, ['commit', '-q', '-m', 'init'])
      const branch = await resolveSubmoduleDefaultBranch({ submoduleRepoPath: repo })
      expect(branch).toBe(SUBMODULE_DEFAULT_BRANCH_FALLBACK)
      expect(branch).toBe('main')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
})
