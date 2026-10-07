import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'
import { executeMeshRefineNodeSynchronously } from '../../src/commands/router-refine'

/**
 * Refinery pre-gate `branch_worktree_dirty` (docs/design/2026-10-07-mesh-workspace-policy.md B2).
 *
 * Refine merges COMMITS but validated the WORKING TREE, so uncommitted branch work
 * passed validation, missed the merge, and was then deleted by the forced post-merge
 * cleanup. The gate refuses a dirty branch worktree BEFORE validation (and before
 * sync_base's rebase) and never commits on the worker's behalf (owner decision E1).
 *
 * Four cases: an uncommitted tracked edit and a new untracked file block; a
 * submodule-gitlink pointer move and a gitignored file do not. Each blocked case also
 * proves validation never ran — the validation command would drop a marker file.
 */

function rmTempRepo(root: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch {
      const until = Date.now() + 50
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: async () => ({ success: false }) } as any,
    cliManager: {} as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
      getByCategory: () => [],
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: {
      listSessions: vi.fn(async () => []),
      stopSession: vi.fn(async (sessionId: string) => ({ sessionId })),
      deleteSession: vi.fn(async (sessionId: string) => ({ sessionId, deleted: true })),
    } as any,
    packageName: 'adhdev',
    statusVersion: '0.9.76',
  })
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initRepo(repo: string, withSubmodule: boolean, root: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored-build/\n')
  // The validation command leaves a marker: its presence proves validation ran.
  writeFileSync(join(repo, 'validate.js'), "require('fs').writeFileSync(require('path').join(process.cwd(), '..', 'VALIDATION_RAN'), '1')\n")
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  if (withSubmodule) {
    const subOrigin = join(root, 'sub-origin')
    mkdirSync(subOrigin, { recursive: true })
    git(subOrigin, 'init', '-q', '-b', 'main')
    git(subOrigin, 'config', 'user.email', 'test@example.com')
    git(subOrigin, 'config', 'user.name', 'Test User')
    writeFileSync(join(subOrigin, 'SUB.md'), 'sub\n')
    git(subOrigin, 'add', '.')
    git(subOrigin, 'commit', '-q', '-m', 'sub init')
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subOrigin, 'oss'], { cwd: repo, stdio: 'pipe' })
    git(repo, 'commit', '-q', '-m', 'add oss submodule')
  }
  const originBare = `${repo}-origin.git`
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare], { stdio: 'pipe' })
  git(repo, 'remote', 'add', 'origin', originBare)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
}

function createWorktree(root: string, repo: string, withSubmodule: boolean) {
  const worktree = join(root, 'wt', 'feat-refine')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/refine', worktree], { cwd: repo, stdio: 'pipe' })
  if (withSubmodule) execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'], { cwd: worktree, stdio: 'pipe' })
  mkdirSync(join(worktree, 'packages', 'daemon-core', 'src'), { recursive: true })
  writeFileSync(join(worktree, 'packages', 'daemon-core', 'src', 'feature.ts'), 'export const feature = 1\n')
  git(worktree, 'add', '.')
  git(worktree, 'commit', '-q', '-m', 'feature change')
  return worktree
}

function createMesh(repo: string, worktree: string) {
  return {
    id: `mesh-dirty-gate-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Dirty Gate Mesh',
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: {
      requireApprovalForPush: true,
      refineConfig: { version: 1, validation: { required: true, commands: [{ command: 'node validate.js', category: 'test' }] } },
    },
    coordinator: {},
    nodes: [
      { id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'daemon-source', userOverrides: {}, policy: {} },
      { id: 'node-worktree', workspace: worktree, repoRoot: worktree, daemonId: 'daemon-source', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: 'feat/refine', clonedFromNodeId: 'node-source' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

async function runCase(name: string, opts: { withSubmodule?: boolean; dirty: (worktree: string) => void }) {
  const root = mkdtempSync(join(tmpdir(), `adhdev-refine-dirty-${name}-`))
  const repo = join(root, 'repo')
  const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
  process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
  try {
    initRepo(repo, opts.withSubmodule === true, root)
    const worktree = createWorktree(root, repo, opts.withSubmodule === true)
    opts.dirty(worktree)
    const mesh = createMesh(repo, worktree)
    const router = createRouter()
    const result: any = await executeMeshRefineNodeSynchronously(router, mesh.id, 'node-worktree', { execute: true, inlineMesh: mesh })
    const stages: string[] = (result.refineStages || []).map((entry: any) => entry.stage)
    return { result, stages, validationRan: existsSync(join(root, 'wt', 'VALIDATION_RAN')) }
  } finally {
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
    rmTempRepo(root)
  }
}

describe('refine branch_worktree_dirty pre-gate', () => {
  it('blocks an uncommitted tracked edit before validation — blocked_review, file named, validation never ran', async () => {
    const { result, stages, validationRan } = await runCase('modified', {
      dirty: (wt) => writeFileSync(join(wt, 'README.md'), 'base\nuncommitted edit\n'),
    })
    expect(result).toMatchObject({ success: false, code: 'branch_worktree_dirty', convergenceStatus: 'blocked_review' })
    expect(result.branchWorktreeDirty.files).toEqual(['README.md'])
    expect(result.finalBranchConvergenceState).toMatchObject({ merged: false, status: 'blocked_review' })
    expect(result.nextStep).toMatch(/mesh_checkpoint/)
    expect(stages).toContain('branch_worktree_clean')
    expect(stages).not.toContain('validation')
    expect(stages).not.toContain('sync_base')
    expect(validationRan).toBe(false)
  }, 90000)

  it('blocks a new untracked file (work the merge would leave out)', async () => {
    const { result, stages, validationRan } = await runCase('untracked', {
      dirty: (wt) => writeFileSync(join(wt, 'packages', 'daemon-core', 'src', 'helper.ts'), 'export const helper = 2\n'),
    })
    expect(result.code).toBe('branch_worktree_dirty')
    expect(result.branchWorktreeDirty.files).toEqual(['packages/daemon-core/src/helper.ts'])
    expect(stages).not.toContain('validation')
    expect(validationRan).toBe(false)
  }, 90000)

  it('does NOT block on a submodule gitlink pointer move alone', async () => {
    const { result, stages, validationRan } = await runCase('gitlink', {
      withSubmodule: true,
      dirty: (wt) => {
        // Commit inside the submodule → the superproject sees " M oss" only.
        const sub = join(wt, 'oss')
        git(sub, 'config', 'user.email', 'test@example.com')
        git(sub, 'config', 'user.name', 'Test User')
        writeFileSync(join(sub, 'SUB.md'), 'sub\nmoved\n')
        git(sub, 'commit', '-q', '-am', 'move pointer')
      },
    })
    expect(result.code).not.toBe('branch_worktree_dirty')
    expect(stages).toContain('branch_worktree_clean')
    expect(stages).toContain('validation')
    expect(validationRan).toBe(true)
  }, 90000)

  it('does NOT block on a gitignored file', async () => {
    const { result, stages, validationRan } = await runCase('ignored', {
      dirty: (wt) => {
        mkdirSync(join(wt, 'ignored-build'), { recursive: true })
        writeFileSync(join(wt, 'ignored-build', 'out.js'), 'built\n')
      },
    })
    expect(result.code).not.toBe('branch_worktree_dirty')
    expect(stages).toContain('validation')
    expect(validationRan).toBe(true)
  }, 90000)
})
