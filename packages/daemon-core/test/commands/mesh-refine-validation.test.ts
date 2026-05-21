import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'

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
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    packageName: 'adhdev',
    statusVersion: '0.9.76',
  })
}

function initGitRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), 'base\n', 'utf-8')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node validation.js',
      typecheck: 'node typecheck.js',
    },
  }, null, 2), 'utf-8')
  writeFileSync(join(repo, 'validation.js'), 'process.exit(0)\n', 'utf-8')
  writeFileSync(join(repo, 'typecheck.js'), 'process.exit(0)\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
}

function createMesh(repo: string, worktree: string, nodeId = 'node-worktree', commands: any = {
  test: [{ command: 'npm run test', sourcePath: 'package.json', confidence: 'high' }],
  typecheck: [{ command: 'npm run typecheck', sourcePath: 'package.json', confidence: 'high' }],
}) {
  return {
    id: `mesh-${nodeId}`,
    name: 'Validation Mesh',
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: {},
    coordinator: {},
    projectContext: {
      version: 1,
      generatedAt: new Date().toISOString(),
      sources: [],
      repo: { identity: 'example/repo', defaultBranch: 'main', currentBranches: ['main', 'feat/refine'] },
      layout: { packageManager: 'npm', workspaceFiles: ['package.json'], packageRoots: [repo], likelyEntryPoints: [] },
      commands,
      instructions: { files: [], summary: '' },
      conventions: { pathHints: [], validationNotes: [], riskyAreas: [] },
    },
    nodes: [
      { id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'daemon-source', userOverrides: {}, policy: {} },
      { id: nodeId, workspace: worktree, repoRoot: worktree, daemonId: 'daemon-source', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: 'feat/refine', clonedFromNodeId: 'node-source' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function createWorktreeWithCommit(root: string, repo: string) {
  const worktree = join(root, '.adhdev-worktrees', 'Validation Mesh', 'feat-refine')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/refine', worktree], { cwd: repo })
  writeFileSync(join(worktree, 'README.md'), 'base\nfeature\n', 'utf-8')
  execFileSync('git', ['add', 'README.md'], { cwd: worktree })
  execFileSync('git', ['commit', '-q', '-m', 'feature change'], { cwd: worktree })
  return worktree
}

describe('refine_mesh_node validation gate', () => {
  it('blocks merge/refine when an allowlisted validation command fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-validation-fail-'))
    const repo = join(root, 'repo')
    try {
      initGitRepo(repo)
      writeFileSync(join(repo, 'validation.js'), 'console.error("validation failed")\nprocess.exit(7)\n', 'utf-8')
      execFileSync('git', ['add', 'validation.js'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'make validation fail'], { cwd: repo })
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-fail', {
        test: [{ command: 'npm run test', sourcePath: 'package.json', confidence: 'high' }],
      })
      const router = createRouter()

      const result: any = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: 'node-fail',
        inlineMesh: mesh,
      })

      expect(result).toMatchObject({ success: false, code: 'validation_failed', convergenceStatus: 'blocked_review' })
      expect(result.validationSummary.status).toBe('failed')
      expect(result.validationSummary.commandsRun).toHaveLength(1)
      expect(result.validationSummary.commandsRun[0]).toMatchObject({ command: 'npm', args: ['run', 'test'], exitCode: 7, passed: false })
      expect(result.validationSummary.commandsRun[0].stderr).toContain('validation failed')
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-fail')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('runs allowlisted ProjectContextSnapshot commands before merging a clean worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-validation-pass-'))
    const repo = join(root, 'repo')
    try {
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      writeFileSync(join(repo, 'SOURCE_ONLY.md'), 'source change\n', 'utf-8')
      execFileSync('git', ['add', 'SOURCE_ONLY.md'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'source-only change'], { cwd: repo })
      const mesh = createMesh(repo, worktree)
      const router = createRouter()

      const result: any = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: 'node-worktree',
        inlineMesh: mesh,
      })

      expect(result).toMatchObject({ success: true, merged: true })
      expect(result.validationSummary.status).toBe('passed')
      expect(result.validationSummary.commandsRun.map((entry: any) => `${entry.command} ${entry.args.join(' ')}`)).toEqual([
        'npm run typecheck',
        'npm run test',
      ])
      expect(result.refineStages.map((entry: any) => entry.stage)).toEqual([
        'resolve_refs',
        'validation',
        'patch_equivalence',
        'merge',
        'cleanup',
        'ledger',
      ])
      expect(result.patchEquivalence).toMatchObject({ status: 'passed', equivalent: true })
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
      expect(readFileSync(join(repo, 'SOURCE_ONLY.md'), 'utf-8')).toBe('source change\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-worktree')).toBe(false)
      expect(result.finalBranchConvergenceState).toMatchObject({ branch: 'main', merged: true, validation: 'passed' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports cleanup failure as an observable partial convergence state after merge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-cleanup-fail-'))
    const repo = join(root, 'repo')
    try {
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const mesh = createMesh(repo, worktree, 'node-cleanup-fail')
      delete mesh.nodes[1].worktreeBranch
      const router = createRouter()

      const result: any = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: 'node-cleanup-fail',
        inlineMesh: mesh,
      })

      expect(result).toMatchObject({ success: false, code: 'cleanup_failed', merged: true })
      expect(result.removeResult).toMatchObject({ success: false, removed: false, code: 'mesh_worktree_cleanup_missing_branch' })
      expect(result.refineStages.map((entry: any) => `${entry.stage}:${entry.status}`)).toContain('cleanup:failed')
      expect(result.finalBranchConvergenceState).toMatchObject({ status: 'merged_cleanup_failed', merged: true, removed: false })
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\nfeature\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-cleanup-fail')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects arbitrary command injection instead of passing it to a shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-validation-injection-'))
    const repo = join(root, 'repo')
    try {
      initGitRepo(repo)
      const worktree = createWorktreeWithCommit(root, repo)
      const pwned = join(worktree, 'pwned')
      const mesh = createMesh(repo, worktree, 'node-injection', {
        test: [{ command: `npm run test && touch ${pwned}`, sourcePath: 'package.json', confidence: 'high' }],
      })
      const router = createRouter()

      const result: any = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: 'node-injection',
        inlineMesh: mesh,
      })

      expect(result).toMatchObject({ success: false, code: 'validation_unavailable', convergenceStatus: 'blocked_review' })
      expect(result.validationSummary.status).toBe('skipped')
      expect(result.validationSummary.rejectedCommands[0].reason).toMatch(/not allowlisted|unsafe/i)
      expect(existsSync(pwned)).toBe(false)
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
      expect(mesh.nodes.some((node: any) => node.id === 'node-injection')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
