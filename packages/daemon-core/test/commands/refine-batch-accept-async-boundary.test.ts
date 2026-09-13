/**
 * IPC-ACCEPT-ASYNC-BOUNDARY regression (2026-09-13).
 *
 * `batch_refine_mesh_nodes` used to be only HALF async: startMeshRefineBatchJob awaited
 * the ENTIRE plan — per-node `git branch --show-current` / `rev-parse` / change-area diff
 * plus a `git fetch origin <base>` bounded at 30s — and only THEN returned
 * { async:true, status:'accepted' }. The caller's IPC deadline (30s for this verb) was
 * therefore spent on work that was supposed to happen after acceptance.
 *
 * The production symptom was the dangerous kind: the accept timed out at the IPC layer
 * while the background job kept running and converged normally. The coordinator read that
 * timeout as a FAILURE and could retry — dispatching a second convergence over the same
 * worktrees.
 *
 * These tests pin the boundary itself rather than a duration threshold on the happy path:
 * an unreachable `origin` makes the PLAN's fetch block for its full bound, so if accept
 * were still awaiting the plan it could not possibly return first. That is the exact
 * shape of the original defect, and it fails loudly if the await is ever restored.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events'

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
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
  } as any)
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node typecheck.js' } }, null, 2), 'utf-8')
  writeFileSync(join(repo, 'typecheck.js'), 'process.exit(0)\n', 'utf-8')
  writeFileSync(join(repo, 'README.md'), 'base\n', 'utf-8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
}

function addWorktreeNode(repo: string, nodeId: string, branch: string, file: string) {
  const wt = join(repo, '..', `wt-${nodeId}`)
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt)
  writeFileSync(join(wt, file), `${nodeId}\n`, 'utf-8')
  git(wt, 'add', '.')
  git(wt, 'commit', '-q', '-m', nodeId)
  return { id: nodeId, workspace: wt, repoRoot: wt, daemonId: 'd', userOverrides: {}, policy: {}, isLocalWorktree: true, worktreeBranch: branch, clonedFromNodeId: 'node-source' }
}

function meshWith(repo: string, nodes: any[]) {
  return {
    id: `mesh-accept-boundary-${nodes.map(n => n.id).join('_')}`,
    name: 'accept-boundary',
    repoIdentity: 'example/repo',
    defaultBranch: 'main',
    policy: {},
    coordinator: {},
    nodes: [
      { id: 'node-source', workspace: repo, repoRoot: repo, daemonId: 'd', userOverrides: {}, policy: {} },
      ...nodes,
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Point origin at a blackhole address. `git fetch` against it blocks until its timeout,
 * which is what makes "did accept wait for the plan?" observable rather than a race.
 */
function setBlackholeOrigin(repo: string) {
  git(repo, 'remote', 'add', 'origin', 'git://10.255.255.1/unreachable.git')
}

describe('batch_refine_mesh_nodes accept/plan async boundary', () => {
  it('returns accepted BEFORE the plan runs, even when the plan fetch blocks on an unreachable remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-accept-boundary-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
      const repo = join(root, 'repo')
      initRepo(repo)
      const a = addWorktreeNode(repo, 'node-a', 'feat/a', 'a.txt')
      const b = addWorktreeNode(repo, 'node-b', 'feat/b', 'b.txt')
      setBlackholeOrigin(repo)
      const mesh = meshWith(repo, [a, b])
      const router = createRouter()

      const startedAt = Date.now()
      const accepted: any = await router.execute('batch_refine_mesh_nodes', {
        meshId: mesh.id, execute: true, inlineMesh: mesh,
      })
      const acceptMs = Date.now() - startedAt

      // ── The contract ───────────────────────────────────────────────────────
      expect(accepted).toMatchObject({ success: true, async: true, batch: true, status: 'accepted' })
      expect(accepted.jobId).toMatch(/^refine_batch_/)

      // THE regression assertion. The plan's fetch against the blackhole remote cannot
      // complete inside this window, so an accept that returned here provably did NOT
      // await the plan. Generous enough to absorb CI jitter while still being far below
      // the blocked fetch it is proving we did not wait for.
      expect(acceptMs).toBeLessThan(5_000)

      // The target set is NOT in the accept reply any more — it cannot be, the plan has
      // not run. Empty (not absent) so the handle shape stays stable for consumers.
      expect(accepted.nodeIds).toEqual([])
      expect(accepted.order).toEqual([])
      expect(accepted.plan).toBeUndefined()
      expect(accepted.orderingRationale).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('delivers order / orderingRationale / plan on the refine:accepted event instead of the accept reply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-accept-boundary-event-'))
    const prev = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
      const repo = join(root, 'repo')
      initRepo(repo)
      const a = addWorktreeNode(repo, 'node-a', 'feat/a', 'a.txt')
      const b = addWorktreeNode(repo, 'node-b', 'feat/b', 'b.txt')
      const mesh = meshWith(repo, [a, b])
      const router = createRouter()

      const accepted: any = await router.execute('batch_refine_mesh_nodes', {
        meshId: mesh.id, execute: true, inlineMesh: mesh,
      })
      expect(accepted.status).toBe('accepted')

      // Poll the coordinator event queue for the planned refine:accepted — this is the
      // channel that replaces the plan fields the accept reply used to carry.
      const deadline = Date.now() + 90_000
      const seen: any[] = []
      let planned: any
      while (Date.now() < deadline && !planned) {
        seen.push(...drainPendingMeshCoordinatorEvents(mesh.id))
        planned = seen.find(e =>
          e.event === 'refine:accepted'
          && (e.metadataEvent as any)?.jobId === accepted.jobId
          && (e.metadataEvent as any)?.result?.phase === 'planned')
        if (!planned) await new Promise(r => setTimeout(r, 25))
      }
      expect(planned, 'planned refine:accepted event was delivered').toBeTruthy()

      const result = planned.metadataEvent.result
      expect([...(result.order as string[])].sort()).toEqual(['node-a', 'node-b'])
      expect([...(result.nodeIds as string[])].sort()).toEqual(['node-a', 'node-b'])
      expect(result.nodeCount).toBe(2)
      expect(result.plan).toHaveLength(2)
      expect(result.orderingRationale).toBeTruthy()

      // The event carries the SAME job identity as the accept reply, so a coordinator can
      // correlate the two halves of the split contract.
      expect(planned.metadataEvent.jobId).toBe(accepted.jobId)
    } finally {
      if (prev === undefined) delete process.env.ADHDEV_CONFIG_DIR; else process.env.ADHDEV_CONFIG_DIR = prev
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
