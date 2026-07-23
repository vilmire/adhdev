import { beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'
import { orderMeshRefineBatchNodes } from '../../src/mesh/mesh-refine-batch'
import type { MeshRefineBatchNodeChangeArea } from '../../src/mesh/mesh-refine-batch'
import { classifyBatchNodeConvergence } from '../../src/commands/router-refine'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events'

// ── Pure ordering unit tests (no git, no native bindings) ──────────────────

function area(partial: Partial<MeshRefineBatchNodeChangeArea> & { nodeId: string }): MeshRefineBatchNodeChangeArea {
  return {
    workspace: `/tmp/${partial.nodeId}`,
    branch: `feat/${partial.nodeId}`,
    changedTopLevelPaths: [],
    changedFiles: [],
    touchedSubmodulePaths: [],
    touchesSubmodule: false,
    aheadCount: 1,
    ...partial,
  }
}

describe('orderMeshRefineBatchNodes', () => {
  it('orders non-submodule nodes before submodule-touching nodes', () => {
    const result = orderMeshRefineBatchNodes([
      area({ nodeId: 'sub-a', touchesSubmodule: true, touchedSubmodulePaths: ['oss'], changedTopLevelPaths: ['oss'] }),
      area({ nodeId: 'plain-b', changedTopLevelPaths: ['packages'] }),
      area({ nodeId: 'sub-c', touchesSubmodule: true, touchedSubmodulePaths: ['oss'], changedTopLevelPaths: ['oss', 'packages'] }),
      area({ nodeId: 'plain-d', changedTopLevelPaths: ['docs'] }),
    ])
    // Non-submodule nodes first (sorted by breadth then id), submodule nodes last.
    expect(result.order).toEqual(['plain-b', 'plain-d', 'sub-a', 'sub-c'])
    expect(result.rationale.join(' ')).toContain('Non-submodule nodes first')
    expect(result.rationale.join(' ')).toContain('Submodule-touching nodes last')
  })

  it('breaks ties by breadth then node id deterministically', () => {
    const result = orderMeshRefineBatchNodes([
      area({ nodeId: 'wide', changedTopLevelPaths: ['a', 'b', 'c'] }),
      area({ nodeId: 'zeta', changedTopLevelPaths: ['a'] }),
      area({ nodeId: 'alpha', changedTopLevelPaths: ['a'] }),
    ])
    expect(result.order).toEqual(['alpha', 'zeta', 'wide'])
  })

  it('surfaces degraded analysis in rationale but still orders the node', () => {
    const result = orderMeshRefineBatchNodes([
      area({ nodeId: 'good', changedTopLevelPaths: ['a'] }),
      area({ nodeId: 'bad', error: 'branch not resolved' }),
    ])
    expect(result.order).toContain('bad')
    expect(result.rationale.join(' ')).toContain('change-area analysis degraded')
  })
})

// ── QW4: batch node convergence classification (pure) ──────────────────────

describe('classifyBatchNodeConvergence (QW4)', () => {
  it('classifies a merge_failed code as not_mergeable (not blocked_review)', () => {
    const out = classifyBatchNodeConvergence({
      success: false,
      code: 'merge_failed',
      conflictPaths: ['conflict.txt'],
      refineStages: [
        { stage: 'validation', status: 'passed' },
        { stage: 'patch_equivalence', status: 'passed' },
        { stage: 'merge', status: 'failed' },
      ],
    })
    expect(out.convergence).toBe('not_mergeable')
    expect(out.code).toBe('merge_failed')
    expect(out.stage).toBe('merge')
  })

  it('classifies a failing merge STAGE as not_mergeable even if the code is absent (back-stop)', () => {
    const out = classifyBatchNodeConvergence({
      success: false,
      // no code — only the failing stage identifies the merge failure
      refineStages: [
        { stage: 'validation', status: 'passed' },
        { stage: 'merge', status: 'failed' },
      ],
    })
    expect(out.convergence).toBe('not_mergeable')
    expect(out.stage).toBe('merge')
  })

  it('keeps a rebase (patch_equivalence) conflict as blocked_review, NOT not_mergeable', () => {
    const out = classifyBatchNodeConvergence({
      success: false,
      code: 'needs_rebase_with_conflicts',
      refineStages: [
        { stage: 'validation', status: 'passed' },
        { stage: 'patch_equivalence', status: 'failed' },
        { stage: 'patch_equivalence_after_auto_rebase', status: 'failed' },
      ],
    })
    expect(out.convergence).toBe('blocked_review')
  })

  it('classifies success as merged_to_main and already_merged-via-other-path as skipped_patch_equivalent', () => {
    expect(classifyBatchNodeConvergence({ success: true }).convergence).toBe('merged_to_main')
    expect(classifyBatchNodeConvergence({
      success: false, code: 'already_merged', alreadyMergedViaOtherPath: true,
    }).convergence).toBe('skipped_patch_equivalent')
  })

  it('classifies any other failure (e.g. validation_failed) as blocked_review', () => {
    const out = classifyBatchNodeConvergence({
      success: false,
      code: 'validation_failed',
      refineStages: [{ stage: 'validation', status: 'failed' }],
    })
    expect(out.convergence).toBe('blocked_review')
    expect(out.retryable).toBe(false)
  })

  it('DS2: marks a base-movement blocker (base_moved / base_locked) retryable blocked_review, never not_mergeable', () => {
    for (const code of ['base_moved', 'base_locked']) {
      const out = classifyBatchNodeConvergence({ success: false, code, retryable: true })
      expect(out.convergence).toBe('blocked_review')
      expect(out.retryable).toBe(true)
    }
    // A conflict is NEVER retryable even if a stray retryable flag were present.
    const conflict = classifyBatchNodeConvergence({
      success: false, code: 'merge_failed', retryable: true,
      refineStages: [{ stage: 'merge', status: 'failed' }],
    })
    expect(conflict.convergence).toBe('not_mergeable')
    expect(conflict.retryable).toBe(false)
  })
})

// ── Integration tests over real git repos (no native bindings) ─────────────

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
    packageName: 'adhdev',
    statusVersion: '0.9.76',
  })
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  // Validation always passes — refine focus here is on ordering/merge convergence.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node typecheck.js' } }, null, 2), 'utf-8')
  writeFileSync(join(repo, 'typecheck.js'), 'process.exit(0)\n', 'utf-8')
  writeFileSync(join(repo, 'README.md'), 'base\n', 'utf-8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
}

function refineConfigPolicy() {
  return {
    refineConfig: { version: 1, validation: { required: true, commands: [{ command: 'npm run typecheck', category: 'typecheck' }] } },
  }
}

// Managed worktrees now default to <home>/.adhdev/worktrees/<meshName>/<safeBranch>,
// but these tests deliberately place them at the LEGACY dirname(repoRoot)/.adhdev-worktrees
// layout to exercise the cleanup guard's back-compat path (a legacy-located worktree must
// still be recognized as managed, not refused with mesh_worktree_cleanup_unexpected_path).
const MESH_NAME = 'Batch Mesh'

function managedWorktreePath(repo: string, branch: string) {
  const safeBranch = branch.replace(/[/\\:*?"<>|]/g, '-')
  const safeMeshName = MESH_NAME.replace(/[/\\:*?"<>|]/g, '-')
  return join(repo, '..', '.adhdev-worktrees', safeMeshName, safeBranch)
}

function meshWith(repo: string, nodes: any[], policy: any = {}) {
  return {
    id: `mesh-batch-${Math.abs(repo.length * 7 + nodes.length)}-${nodes.map(n => n.id).join('_')}`,
    name: MESH_NAME,
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: { ...refineConfigPolicy(), ...policy },
    coordinator: {},
    nodes: [
      { id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'd', userOverrides: {}, policy: {} },
      ...nodes,
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function addWorktreeNode(root: string, repo: string, nodeId: string, branch: string, mutate: (wt: string) => void) {
  const wt = managedWorktreePath(repo, branch)
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt)
  mutate(wt)
  return {
    node: { id: nodeId, workspace: wt, repoRoot: wt, daemonId: 'd', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'node-source' },
    workspace: wt,
  }
}

function withConfigDir(root: string) {
  process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
}

// Execute is async: the immediate response is an accepted batch job handle; the
// aggregate per-node results arrive in the terminal ledger entry + refine event.
function expectAcceptedBatch(result: any, expectedNodeIds: string[]) {
  expect(result).toMatchObject({ success: true, async: true, batch: true, status: 'accepted' })
  expect(result.jobId).toMatch(/^refine_batch_/)
  expect(result.interactionId).toMatch(/^ix_/)
  expect(result.startedAt).toMatch(/T/)
  expect([...result.nodeIds].sort()).toEqual([...expectedNodeIds].sort())
}

async function waitForBatchLedger(meshId: string, jobId: string, timeoutMs = 90000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = readLedgerEntries(meshId)
    const terminal = entries.find(entry =>
      (entry.kind === 'task_completed' || entry.kind === 'task_failed')
      && (entry.payload as any)?.refineJob?.batch === true
      && (entry.payload as any)?.refineJob?.jobId === jobId
    )
    if (terminal) return terminal
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for batch refine job ${jobId}`)
}

// Run an async batch execute end-to-end: dispatch → assert accepted → await terminal
// ledger → return the aggregate result payload the background job produced.
async function executeBatchAndAwait(router: any, meshId: string, args: any, expectedNodeIds: string[]): Promise<any> {
  const accepted: any = await router.execute('batch_refine_mesh_nodes', { meshId, execute: true, ...args })
  expectAcceptedBatch(accepted, expectedNodeIds)
  const terminal = await waitForBatchLedger(meshId, accepted.jobId)
  return { accepted, terminal, result: terminal.payload.result }
}

describe('batch_refine_mesh_nodes', () => {
  beforeAll(() => { vi.setConfig({ testTimeout: 120000 }) })

  it('dry-run reports ordering and per-node validation plan without merging', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-dryrun-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'docs.md'), 'a\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a')
      })
      const b = addWorktreeNode(root, repo, 'node-b', 'feat/b', wt => {
        writeFileSync(join(wt, 'src.md'), 'b\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'b')
      })
      const mesh = meshWith(repo, [a.node, b.node])
      const router = createRouter()

      const result: any = await router.execute('batch_refine_mesh_nodes', { meshId: mesh.id, inlineMesh: mesh })
      expect(result).toMatchObject({ success: true, batch: true, dryRun: true, nodeCount: 2 })
      expect(result.order.sort()).toEqual(['node-a', 'node-b'])
      expect(result.plan).toHaveLength(2)
      expect(result.plan[0].mergeWillRun).toBe(false)
      // Nothing merged.
      expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('base\n')
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('classifies a gitlink (submodule) change as touchesSubmodule via real git change-area analysis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-submodule-analyze-'))
    try {
      const repo = join(root, 'repo')
      initRepo(repo)
      // Declare an 'oss' submodule path in .gitmodules without needing a real checkout.
      writeFileSync(join(repo, '.gitmodules'), '[submodule "oss"]\n\tpath = oss\n\turl = ./oss-origin\n', 'utf-8')
      git(repo, 'add', '.gitmodules'); git(repo, 'commit', '-q', '-m', 'declare oss submodule')
      const base = git(repo, 'rev-parse', 'HEAD').trim()

      // branch that bumps the oss gitlink: stage a 160000 gitlink entry for 'oss'.
      git(repo, 'checkout', '-q', '-b', 'feat/sub')
      // Create a throwaway commit object to use as the gitlink target SHA.
      const gitlinkSha = git(repo, 'commit-tree', git(repo, 'write-tree').trim(), '-m', 'sub').trim()
      git(repo, 'update-index', '--add', '--cacheinfo', `160000,${gitlinkSha},oss`)
      git(repo, 'commit', '-q', '-m', 'bump oss gitlink')
      const branchRef = git(repo, 'rev-parse', 'HEAD').trim()
      git(repo, 'checkout', '-q', 'main')

      const { analyzeMeshRefineNodeChangeArea } = await import('../../src/mesh/mesh-refine-batch')
      const submodulePaths = new Set(['oss'])
      const area = await analyzeMeshRefineNodeChangeArea({
        nodeId: 'node-sub', workspace: repo, branch: 'feat/sub',
        baseRef: base, branchRef, diffCwd: repo, submodulePaths,
      })
      expect(area.touchesSubmodule).toBe(true)
      expect(area.touchedSubmodulePaths).toContain('oss')
      expect(area.aheadCount).toBeGreaterThan(0)

      // And ordering puts this node after a non-submodule node.
      const plainArea = await analyzeMeshRefineNodeChangeArea({
        nodeId: 'node-plain', workspace: repo, branch: 'main',
        baseRef: base, branchRef: base, diffCwd: repo, submodulePaths,
      })
      const ordering = orderMeshRefineBatchNodes([area, plainArea])
      expect(ordering.order).toEqual(['node-plain', 'node-sub'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('converges two siblings sequentially: first merges, second auto-rebases onto advanced base then merges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-converge-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      // Two siblings that both append distinct lines to the same shared file.
      // Sibling B starts from base; after A merges, base advances and B must
      // auto-rebase (its diff context still applies cleanly) before merging.
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'a.txt'), 'a-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a change')
      })
      const b = addWorktreeNode(root, repo, 'node-b', 'feat/b', wt => {
        writeFileSync(join(wt, 'b.txt'), 'b-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'b change')
      })
      const mesh = meshWith(repo, [a.node, b.node])
      const router = createRouter()

      const { result } = await executeBatchAndAwait(router, mesh.id, { inlineMesh: mesh }, ['node-a', 'node-b'])
      expect(result).toMatchObject({ success: true, batch: true, dryRun: false, allConverged: true })
      expect(result.summary).toMatchObject({ merged: 2, blocked: 0, notMergeable: 0 })
      const byId = Object.fromEntries(result.results.map((r: any) => [r.nodeId, r]))
      expect(byId['node-a'].convergence).toBe('merged_to_main')
      expect(byId['node-b'].convergence).toBe('merged_to_main')
      // Both changes are present on base after convergence.
      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('a-change\n')
      expect(readFileSync(join(repo, 'b.txt'), 'utf-8')).toBe('b-change\n')
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('DS2: the second batch node is a diverged laggard rebased in sync_base; the converged base has linear ancestry (both merges reachable)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-ds2-laggard-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      // node-a and node-b both branch from the same base and each add a disjoint file.
      // When node-a merges first, the base advances; node-b is then a DIVERGED laggard
      // (it has its own commit AND base has node-a's merge it lacks). The DS2 sync_base
      // stage rebases node-b onto the advanced base before it merges — the old
      // ancestor-only auto-rebase would still catch this fast-forward case, but the
      // important DS2 guarantee is the resulting linear ancestry.
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'a.txt'), 'a-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a change')
      })
      const b = addWorktreeNode(root, repo, 'node-b', 'feat/b', wt => {
        writeFileSync(join(wt, 'b.txt'), 'b-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'b change')
      })
      const mesh = meshWith(repo, [a.node, b.node])
      const router = createRouter()

      const baseBefore = git(repo, 'rev-parse', 'HEAD').trim()
      const { result } = await executeBatchAndAwait(router, mesh.id, { nodeIds: ['node-a', 'node-b'], inlineMesh: mesh }, ['node-a', 'node-b'])
      expect(result.summary).toMatchObject({ merged: 2, blocked: 0, notMergeable: 0 })
      const baseAfter = git(repo, 'rev-parse', 'HEAD').trim()
      // Linear ancestry: the pre-batch base is a strict ancestor of the converged base,
      // and both node changes are present (each merge landed, in order, no divergence).
      expect(() => git(repo, 'merge-base', '--is-ancestor', baseBefore, baseAfter)).not.toThrow()
      expect(baseAfter).not.toBe(baseBefore)
      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('a-change\n')
      expect(readFileSync(join(repo, 'b.txt'), 'utf-8')).toBe('b-change\n')
      // The base HEAD linearly contains BOTH auto-merge commits.
      const log = git(repo, 'log', '--oneline').trim()
      expect(log).toContain("Auto-merge branch 'feat/a'")
      expect(log).toContain("Auto-merge branch 'feat/b'")
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('isolates a genuinely conflicting sibling as blocked_review and continues the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-conflict-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      // node-a edits conflict.txt; node-conflict edits the SAME line of conflict.txt
      // from base — after A merges, B's rebase hits a real content conflict.
      writeFileSync(join(repo, 'conflict.txt'), 'original\n', 'utf-8')
      git(repo, 'add', 'conflict.txt'); git(repo, 'commit', '-q', '-m', 'add conflict file')
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'conflict.txt'), 'changed-by-a\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a edits conflict')
      })
      const c = addWorktreeNode(root, repo, 'node-conflict', 'feat/c', wt => {
        writeFileSync(join(wt, 'conflict.txt'), 'changed-by-c\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'c edits conflict')
      })
      const d = addWorktreeNode(root, repo, 'node-d', 'feat/d', wt => {
        writeFileSync(join(wt, 'untouched.txt'), 'd\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'd unrelated')
      })
      const mesh = meshWith(repo, [a.node, c.node, d.node])
      const router = createRouter()

      // Force order so node-a merges first, then node-conflict (must conflict), then node-d.
      const { result } = await executeBatchAndAwait(router, mesh.id, {
        nodeIds: ['node-a', 'node-conflict', 'node-d'], inlineMesh: mesh,
      }, ['node-a', 'node-conflict', 'node-d'])
      expect(result).toMatchObject({ success: true, batch: true, dryRun: false, allConverged: false })
      const byId = Object.fromEntries(result.results.map((r: any) => [r.nodeId, r]))
      expect(byId['node-a'].convergence).toBe('merged_to_main')
      expect(byId['node-conflict'].convergence).toBe('blocked_review')
      // The batch did NOT stop at the conflict — node-d still converged.
      expect(byId['node-d'].convergence).toBe('merged_to_main')
      expect(result.summary.blocked).toBe(1)
      expect(result.nextStep).toContain('blocked_review')
      // conflict.txt retains node-a's content; node-conflict was not merged.
      expect(readFileSync(join(repo, 'conflict.txt'), 'utf-8')).toBe('changed-by-a\n')
      expect(readFileSync(join(repo, 'untouched.txt'), 'utf-8')).toBe('d\n')
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips a patch-equivalent sibling already landed on base (not an error)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-equiv-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'shared.txt'), 'shared-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'shared change')
      })
      // node-equiv carries the SAME content change as node-a, but applied directly
      // on base (cherry-pick style) before the batch runs — so after node-a merges,
      // node-equiv's merge-tree produces no diff vs base → skipped, not error.
      const equiv = addWorktreeNode(root, repo, 'node-equiv', 'feat/equiv', wt => {
        writeFileSync(join(wt, 'shared.txt'), 'shared-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'equivalent change')
      })
      const mesh = meshWith(repo, [a.node, equiv.node])
      const router = createRouter()

      const { result } = await executeBatchAndAwait(router, mesh.id, {
        nodeIds: ['node-a', 'node-equiv'], inlineMesh: mesh,
      }, ['node-a', 'node-equiv'])
      expect(result.success).toBe(true)
      const byId = Object.fromEntries(result.results.map((r: any) => [r.nodeId, r]))
      expect(byId['node-a'].convergence).toBe('merged_to_main')
      // node-equiv content is already on base after node-a → skipped as patch-equivalent.
      expect(byId['node-equiv'].convergence).toBe('skipped_patch_equivalent')
      expect(result.summary.skipped).toBe(1)
      expect(result.allConverged).toBe(true)
      expect(readFileSync(join(repo, 'shared.txt'), 'utf-8')).toBe('shared-change\n')
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('execute returns an accepted async batch handle immediately and delivers the aggregate as a terminal refine event', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-async-event-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'a.txt'), 'a-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a change')
      })
      const b = addWorktreeNode(root, repo, 'node-b', 'feat/b', wt => {
        writeFileSync(join(wt, 'b.txt'), 'b-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'b change')
      })
      const mesh = meshWith(repo, [a.node, b.node])
      const router = createRouter()

      const accepted: any = await router.execute('batch_refine_mesh_nodes', { meshId: mesh.id, execute: true, inlineMesh: mesh })
      // Immediate accepted handle — no per-node results inline yet.
      expectAcceptedBatch(accepted, ['node-a', 'node-b'])
      expect(accepted.results).toBeUndefined()
      expect(accepted.order.sort()).toEqual(['node-a', 'node-b'])
      // A provisional refine:accepted event is queued for the coordinator. The batch
      // identity rides in the refine_batch_ jobId prefix (intrinsic to the handle and
      // preserved through the forward path).
      const acceptedEvents = drainPendingMeshCoordinatorEvents(mesh.id)
      expect(acceptedEvents.some(e => e.event === 'refine:accepted' && /^refine_batch_/.test((e.metadataEvent as any)?.jobId ?? ''))).toBe(true)

      // Background convergence finishes and writes a terminal ledger entry + event.
      const terminal = await waitForBatchLedger(mesh.id, accepted.jobId)
      expect(terminal.kind).toBe('task_completed')
      const result = terminal.payload.result
      expect(result).toMatchObject({ batch: true, allConverged: true })
      expect(result.summary).toMatchObject({ merged: 2, blocked: 0, notMergeable: 0 })
      const completedEvents = drainPendingMeshCoordinatorEvents(mesh.id)
      expect(completedEvents.some(e => e.event === 'refine:completed' && /^refine_batch_/.test((e.metadataEvent as any)?.jobId ?? ''))).toBe(true)
      // Both changes are present on base.
      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('a-change\n')
      expect(readFileSync(join(repo, 'b.txt'), 'utf-8')).toBe('b-change\n')
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reuses the in-flight batch job for a duplicate execute trigger instead of spawning a second convergence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-async-dup-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      // Slow validation so the first batch job is still in flight when the
      // duplicate trigger arrives.
      writeFileSync(join(repo, 'typecheck.js'), 'setTimeout(() => process.exit(0), 600)\n', 'utf-8')
      git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'slow typecheck')
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'a.txt'), 'a-change\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a change')
      })
      const mesh = meshWith(repo, [a.node])
      const router = createRouter()

      const first: any = await router.execute('batch_refine_mesh_nodes', { meshId: mesh.id, execute: true, inlineMesh: mesh })
      expectAcceptedBatch(first, ['node-a'])
      const second: any = await router.execute('batch_refine_mesh_nodes', { meshId: mesh.id, execute: true, inlineMesh: mesh })
      // Same job, flagged duplicate — no second background convergence.
      expect(second).toMatchObject({ success: true, async: true, batch: true, duplicate: true, jobId: first.jobId })

      const terminal = await waitForBatchLedger(mesh.id, first.jobId)
      expect(terminal.kind).toBe('task_completed')
      // Exactly one dispatched + one terminal ledger entry for this batch job.
      const entries = readLedgerEntries(mesh.id).filter(e => (e.payload as any)?.refineJob?.batch === true)
      const dispatched = entries.filter(e => e.kind === 'task_dispatched' && (e.payload as any)?.refineJob?.jobId === first.jobId)
      const terminals = entries.filter(e => (e.kind === 'task_completed' || e.kind === 'task_failed') && (e.payload as any)?.refineJob?.jobId === first.jobId)
      expect(dispatched).toHaveLength(1)
      expect(terminals).toHaveLength(1)
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('dry-run stays synchronous (no async handle) even though execute is async', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-dryrun-sync-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'a.txt'), 'a\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a')
      })
      const mesh = meshWith(repo, [a.node])
      const router = createRouter()
      const result: any = await router.execute('batch_refine_mesh_nodes', { meshId: mesh.id, dry_run: true, inlineMesh: mesh })
      expect(result).toMatchObject({ success: true, batch: true, dryRun: true })
      expect(result.async).toBeUndefined()
      expect(result.jobId).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects non-worktree / missing requested node ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-batch-reject-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      withConfigDir(root)
      const repo = join(root, 'repo')
      initRepo(repo)
      const a = addWorktreeNode(root, repo, 'node-a', 'feat/a', wt => {
        writeFileSync(join(wt, 'a.txt'), 'a\n', 'utf-8'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'a')
      })
      const mesh = meshWith(repo, [a.node])
      const router = createRouter()
      const result: any = await router.execute('batch_refine_mesh_nodes', {
        meshId: mesh.id, nodeIds: ['node-source', 'ghost'], inlineMesh: mesh,
      })
      expect(result.success).toBe(false)
      expect(result.missingNodeIds).toContain('ghost')
      expect(result.nonWorktreeNodeIds).toContain('node-source')
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  })
})
