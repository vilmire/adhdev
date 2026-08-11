import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'

/**
 * CONCURRENT-FIRE regression suite.
 *
 * Observed live: two refine_mesh_node requests for the SAME meshId:nodeId landed
 * ~1ms apart. `startMeshRefineJob` used to check `runningRefineJobs.get(key)` and
 * only call `.set(key, handle)` AFTER `await getMeshForCommand(...)` — a real
 * microtask-yielding gap (dynamic `import('../config/mesh-config.js')`). Both
 * near-simultaneous calls could pass the `get()` check before either had set the
 * map, so both proceeded: the second one raced the first job's cleanup
 * (remove_mesh_node tearing down the worktree after a successful merge) and failed
 * with `dependency_bootstrap_failed` / `commandsRun: 0` — a false "Refinery failed"
 * notification even though the first job had already merged and pushed.
 *
 * The fix (router-refine.ts, startMeshRefineJob) reserves the `runningRefineJobs`
 * map slot with a placeholder SYNCHRONOUSLY — get-check and set happen back to
 * back with no `await` between them — before ever reaching `getMeshForCommand`.
 * This suite exercises that with a literal `Promise.all` double-fire (no artificial
 * sequencing) against a real router, and separately confirms a genuinely sequential
 * retry (after the first job leaves `runningRefineJobs`) is still accepted, so the
 * guard does not overreach into blocking legitimate re-runs.
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
    packageName: 'adhdev',
    statusVersion: '0.9.76',
  } as any)
}

function initGitRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), 'base\n', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
}

function meshWith(nodeId: string, worktree: string, repo: string) {
  return {
    id: `mesh-concurrent-fire-${nodeId}`,
    name: 'Concurrent Fire Mesh',
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: {},
    coordinator: {},
    nodes: [
      { id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'daemon-source', userOverrides: {}, policy: {} },
      { id: nodeId, workspace: worktree, repoRoot: worktree, daemonId: 'daemon-source', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: 'feat/refine', clonedFromNodeId: 'node-source' },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('refine_mesh_node — CONCURRENT-FIRE dedup guard', () => {
  it('a true Promise.all double-fire for the same meshId:nodeId: exactly one call is accepted (non-duplicate), the other is duplicate:true', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-concurrent-fire-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
      initGitRepo(repo)
      // Worktree deliberately has NO real `git worktree add` — the accept path never
      // touches git (see startMeshRefineJob), so a plain directory is enough to pass
      // the `isLocalWorktree && workspace` truthy check. This keeps the test fast and
      // focused on the accept-time dedup race, not the (separately tested) pipeline.
      const worktree = join(root, 'worktree')
      mkdirSync(worktree, { recursive: true })
      const mesh = meshWith('node-race', worktree, repo)
      const router = createRouter()

      const [first, second]: any[] = await Promise.all([
        router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-race', inlineMesh: mesh, execute: true }),
        router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-race', inlineMesh: mesh, execute: true }),
      ])

      const results = [first, second]
      const accepted = results.filter(r => r?.success === true && r?.duplicate !== true)
      const duplicates = results.filter(r => r?.duplicate === true)

      // Exactly one call actually reserved the slot; the other observed the
      // placeholder and bounced off as a duplicate. Before the fix, BOTH could reach
      // acceptance (both minting distinct jobIds) because the get-check/set straddled
      // an `await`.
      expect(accepted).toHaveLength(1)
      expect(duplicates).toHaveLength(1)
      expect(accepted[0].jobId).toMatch(/^refine_/)
      expect(duplicates[0].jobId).toBe(accepted[0].jobId)
      expect(duplicates[0].status).toBe('accepted')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmTempRepo(root)
    }
  })

  it('a genuinely SEQUENTIAL re-request after the first job has left runningRefineJobs is accepted, not blocked as duplicate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-sequential-retry-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
      initGitRepo(repo)
      const worktree = join(root, 'worktree')
      mkdirSync(worktree, { recursive: true })
      const mesh = meshWith('node-sequential', worktree, repo)
      const router = createRouter()

      // First call reserves the slot, accept-time work runs, then the detached
      // background pipeline (setImmediate) fails fast (worktree isn't a real git
      // worktree) and clears `runningRefineJobs` via the terminal path. Give it real
      // ticks to flush — this is exactly the "job has ended" state the guard must not
      // block a fresh, later request against.
      const first: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-sequential', inlineMesh: mesh, execute: true })
      expect(first).toMatchObject({ success: true, async: true, status: 'accepted' })
      expect(first.duplicate).not.toBe(true)

      // Poll until the router's runningRefineJobs no longer holds this key (bounded —
      // the background pipeline fails within milliseconds against a non-git worktree).
      const deadline = Date.now() + 10000
      const key = `${mesh.id}:node-sequential`
      while ((router as any).runningRefineJobs.has(key) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect((router as any).runningRefineJobs.has(key)).toBe(false)

      const retry: any = await router.execute('refine_mesh_node', { meshId: mesh.id, nodeId: 'node-sequential', inlineMesh: mesh, execute: true })
      expect(retry).toMatchObject({ success: true, async: true, status: 'accepted' })
      expect(retry.duplicate).not.toBe(true)
      expect(retry.jobId).not.toBe(first.jobId)
      expect(retry.retryOfJobId).toBe(first.jobId)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmTempRepo(root)
    }
  })
})
