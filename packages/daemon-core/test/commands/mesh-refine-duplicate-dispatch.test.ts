import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DaemonCommandRouter } from '../../src/commands/router'
import {
  findOpenRefineDispatchForNode,
  REFINE_INFLIGHT_FRESHNESS_MS,
} from '../../src/mesh/mesh-refine-inflight'
import { refineWorktreeVanishedOutcome } from '../../src/commands/router-refine'

/**
 * DURABLE-DUPLICATE-DISPATCH regression suite.
 *
 * Observed live 3/3 on 2026-08-17: ONE coordinator `mesh_refine_node` call produced
 * TWO `task_dispatched` ledger rows for the same node, the second landing 2–5 minutes
 * after the first. The first job always ran to completion (merge + push + worktree
 * cleanup); the second then ran against the directory the first had just removed and
 * always failed spuriously — with a code that varied purely by timing
 * (`validation_failed` once, `dependency_bootstrap_failed` twice).
 *
 * The pre-existing guard (`runningRefineJobs`, CONCURRENT-FIRE) is an IN-MEMORY map,
 * so it only answers "is this PROCESS already refining this node?". A refine job's
 * identity is mesh-wide, and a second dispatch routinely reaches a different process:
 * `refine_mesh_node` forwards to the owning daemon only when the resolved node view
 * carries a `daemonId` that differs from this daemon's, so a view resolving WITHOUT a
 * usable `daemonId` makes the coordinator execute locally instead of forwarding — call
 * #1 on the worker, call #2 on the coordinator, each with its own empty map. A daemon
 * restart loses the map outright.
 *
 * The fix consults the LEDGER — the durable record both processes write — for an open
 * (dispatched, no terminal row) refine on the node before dispatching another.
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

function meshWith(meshId: string, nodeId: string, worktree: string, repo: string) {
  return {
    id: meshId,
    name: 'Duplicate Dispatch Mesh',
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

function dispatchEntry(nodeId: string, jobId: string, timestamp: string) {
  return {
    kind: 'task_dispatched',
    nodeId,
    timestamp,
    payload: { source: 'refine_mesh_node_async_job', refineJob: { jobId, nodeId } },
  }
}

function terminalEntry(kind: 'task_completed' | 'task_failed', nodeId: string, jobId: string, timestamp: string) {
  return {
    kind,
    nodeId,
    timestamp,
    payload: { source: 'refine_mesh_node_async_job', refineJob: { jobId, nodeId } },
  }
}

// ── The durable guard's decision function, in isolation ──────────────────────
describe('findOpenRefineDispatchForNode — durable in-flight detection', () => {
  const now = Date.parse('2026-08-17T03:00:00.000Z')

  it('DETECTS an open dispatch from a DIFFERENT process 5 minutes ago — the exact live shape', () => {
    // Case C timing: dispatch #1 at 03:37:00, duplicate at 03:39:23 (~2m23s later).
    // Nothing terminal in between, because job #1 was still running.
    const match = findOpenRefineDispatchForNode({
      entries: [dispatchEntry('node-wt', 'refine_first', '2026-08-17T02:55:00.000Z')],
      nodeId: 'node-wt',
      nowMs: now,
    })
    expect(match).not.toBeNull()
    expect(match!.jobId).toBe('refine_first')
    expect(match!.ageMs).toBe(5 * 60_000)
  })

  it('does NOT block once the first job has a terminal row (the legitimate re-run case)', () => {
    const match = findOpenRefineDispatchForNode({
      entries: [
        dispatchEntry('node-wt', 'refine_first', '2026-08-17T02:55:00.000Z'),
        terminalEntry('task_completed', 'node-wt', 'refine_first', '2026-08-17T02:58:00.000Z'),
      ],
      nodeId: 'node-wt',
      nowMs: now,
    })
    expect(match).toBeNull()
  })

  it('does NOT block on a dispatch for a DIFFERENT node', () => {
    const match = findOpenRefineDispatchForNode({
      entries: [dispatchEntry('node-other', 'refine_other', '2026-08-17T02:55:00.000Z')],
      nodeId: 'node-wt',
      nowMs: now,
    })
    expect(match).toBeNull()
  })

  it('does NOT block on a STALE dispatch past the freshness window — a crashed job must not wedge its node forever', () => {
    const stale = new Date(now - REFINE_INFLIGHT_FRESHNESS_MS - 60_000).toISOString()
    const match = findOpenRefineDispatchForNode({
      entries: [dispatchEntry('node-wt', 'refine_crashed', stale)],
      nodeId: 'node-wt',
      nowMs: now,
    })
    expect(match).toBeNull()
  })

  it('excludes the job RESUMING under its own preserved jobId (JOBID-RESUME-PRESERVE)', () => {
    // The boot resume path re-dispatches an interrupted job under its ORIGINAL jobId.
    // Its own open row must not be read as a duplicate of itself, or resume never runs.
    const entries = [dispatchEntry('node-wt', 'refine_interrupted', '2026-08-17T02:55:00.000Z')]
    expect(findOpenRefineDispatchForNode({ entries, nodeId: 'node-wt', nowMs: now })).not.toBeNull()
    expect(findOpenRefineDispatchForNode({
      entries, nodeId: 'node-wt', nowMs: now, excludeJobId: 'refine_interrupted',
    })).toBeNull()
  })

  it('treats an archived terminal row as closed, not open', () => {
    const match = findOpenRefineDispatchForNode({
      entries: [dispatchEntry('node-wt', 'refine_archived', '2026-08-17T02:55:00.000Z')],
      nodeId: 'node-wt',
      nowMs: now,
      archivedTerminalKeys: new Set(['refine:node-wt:refine_archived']),
    })
    expect(match).toBeNull()
  })
})

// ── End-to-end through the real router: the cross-process duplicate ──────────
describe('refine_mesh_node — duplicate dispatch across processes', () => {
  it('a SECOND dispatch while the first is still open is refused, and writes NO second task_dispatched row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-dup-dispatch-'))
    const repo = join(root, 'repo')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
      initGitRepo(repo)
      const worktree = join(root, 'worktree')
      mkdirSync(worktree, { recursive: true })
      const meshId = 'mesh-dup-dispatch'
      const mesh = meshWith(meshId, 'node-dup', worktree, repo)

      // Router A === the process that receives the coordinator's first call.
      const routerA = createRouter()
      const first: any = await routerA.execute('refine_mesh_node', {
        meshId, nodeId: 'node-dup', inlineMesh: mesh, execute: true,
      })
      expect(first).toMatchObject({ success: true, async: true, status: 'accepted' })
      expect(first.duplicate).not.toBe(true)

      // Router B === a DIFFERENT process (the routing-divergence / restart case). Its
      // `runningRefineJobs` is empty, so the in-memory guard cannot see job #1 at all —
      // only the shared ledger can. This is the step that used to produce the second
      // `task_dispatched` row and the spurious failure.
      const routerB = createRouter()
      const second: any = await routerB.execute('refine_mesh_node', {
        meshId, nodeId: 'node-dup', inlineMesh: mesh, execute: true,
      })

      expect(second.duplicate).toBe(true)
      expect(second.code).toBe('duplicate_refine_dispatch')
      // It reports the ALREADY-RUNNING job, never a freshly minted one.
      expect(second.jobId).toBe(first.jobId)

      // The ledger is the assertion that matters: exactly ONE dispatch row for this node.
      const { readLedgerEntries } = await import('../../src/mesh/mesh-ledger')
      const dispatches = readLedgerEntries(meshId, { kind: ['task_dispatched'] })
        .filter(e => (e.payload as any)?.source === 'refine_mesh_node_async_job')
        .filter(e => e.nodeId === 'node-dup')
      expect(dispatches).toHaveLength(1)
      expect((dispatches[0].payload as any).refineJob.jobId).toBe(first.jobId)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      rmTempRepo(root)
    }
  })
})

// ── Second line of defence: the worktree vanishing mid-flight ────────────────
describe('refineWorktreeVanishedOutcome — mid-flight worktree teardown', () => {
  it('classifies a worktree removed DURING the job as worktree_missing, not a validation failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-vanish-'))
    try {
      const gone = join(root, 'already-removed')
      const ctx: any = {
        node: { id: 'node-vanished', workspace: gone },
        refineStages: [],
      }
      const outcome = refineWorktreeVanishedOutcome(ctx, 'validation')
      expect(outcome).not.toBeNull()
      const result = outcome!.result as any
      // The whole point: a spurious failure must NOT masquerade as a real one. Before
      // this check, the job spawned validation/bootstrap into a deleted directory and
      // reported validation_failed / dependency_bootstrap_failed.
      expect(result.code).toBe('worktree_missing')
      expect(result.code).not.toBe('validation_failed')
      expect(result.code).not.toBe('dependency_bootstrap_failed')
      expect(result.vanishedMidFlight).toBe(true)
      expect(result.failedStage).toBe('validation')
      expect(result.retryable).toBe(false)
      expect(ctx.refineStages).toHaveLength(1)
      expect(ctx.refineStages[0]).toMatchObject({ status: 'failed', workspaceMissing: true })
    } finally {
      rmTempRepo(root)
    }
  })

  it('returns null (job proceeds) while the worktree is intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'adhdev-refine-intact-'))
    try {
      const ctx: any = { node: { id: 'node-live', workspace: root }, refineStages: [] }
      expect(refineWorktreeVanishedOutcome(ctx, 'validation')).toBeNull()
      expect(ctx.refineStages).toHaveLength(0)
    } finally {
      rmTempRepo(root)
    }
  })
})
