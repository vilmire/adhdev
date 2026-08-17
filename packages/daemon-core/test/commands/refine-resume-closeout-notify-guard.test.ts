import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { DaemonCommandRouter } from '../../src/commands/router'
import { resumePendingRefineJobsOnStartup } from '../../src/commands/router-refine'
import { createMesh, addNode } from '../../src/config/mesh-config'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger'
import { getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending'
import { shouldNotifyRefineCloseOut } from '../../src/mesh/mesh-refine-zombie-sweep'

/**
 * NOTIFY-GRADE-WIRING regression suite (task: refine-closeout-notify-guard-wiring).
 *
 * shouldNotifyRefineCloseOut existed with zero call sites — the actual
 * queueRefineJobEvent('refine:failed', ...) call in resumePendingRefineJobsOnStartup
 * fired unconditionally for every close_removed_node / close_stale disposition, with
 * no dedup or rate limit. Observed 2026-08-16: 5 resume_abandoned_stale_dispatch
 * task_failed ledger rows fired within a 4ms window for the same node, flooding
 * coordinator context. This suite pins the wiring itself (not just the pure
 * classifier) so a future refactor cannot silently drop the gate again.
 */

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

function appendDispatchedEntry(meshId: string, nodeId: string, jobId: string, timestamp: string) {
  MeshRuntimeStore.getInstance().appendLedgerEntry({
    id: randomUUID(),
    meshId,
    timestamp,
    kind: 'task_dispatched',
    nodeId,
    payload: {
      source: 'refine_mesh_node_async_job',
      refineJob: { jobId, meshId, nodeId, status: 'accepted', startedAt: timestamp },
      async: true,
    },
  })
}

describe('resumePendingRefineJobsOnStartup — NOTIFY-GRADE-WIRING', () => {
  let root: string
  let previousConfigDir: string | undefined
  let previousHorizonEnv: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adhdev-refine-closeout-notify-'))
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
    previousHorizonEnv = process.env.MESH_REFINE_CLOSEOUT_NOTIFY_HORIZON_MS
    delete process.env.MESH_REFINE_CLOSEOUT_NOTIFY_HORIZON_MS
    MeshRuntimeStore.resetForTests()
  })

  afterEach(() => {
    MeshRuntimeStore.resetForTests()
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
    if (previousHorizonEnv === undefined) delete process.env.MESH_REFINE_CLOSEOUT_NOTIFY_HORIZON_MS
    else process.env.MESH_REFINE_CLOSEOUT_NOTIFY_HORIZON_MS = previousHorizonEnv
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); return } catch { /* retry */ }
    }
  })

  function setUpMeshWithWorktreeNode(nodeId: string) {
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    mkdirSync(repo, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    const mesh = createMesh({ name: 'Closeout Notify Mesh', repoRemoteUrl: 'https://example.com/example/repo.git' })
    const sourceNode = addNode(mesh.id, { workspace: repo, repoRoot: repo })!
    addNode(mesh.id, {
      id: nodeId,
      workspace: worktree,
      repoRoot: worktree,
      isLocalWorktree: true,
      worktreeBranch: 'feat/refine',
      clonedFromNodeId: sourceNode.id,
    })
    return mesh.id
  }

  it('★suppresses the coordinator push for a batch of ancient stale dispatches (reproduces the 2026-08-16 flood) while the ledger still records every one', async () => {
    const meshId = setUpMeshWithWorktreeNode('node-flood')
    // 5 dispatches, 30 days old (past the default 24h zombie cutoff AND the 60s
    // notify horizon) — the exact shape of the observed incident: 5 task_failed
    // rows fired within milliseconds of each other for stranded dispatches.
    const jobIds = Array.from({ length: 5 }, (_, i) => `refine_flood_${i}`)
    for (const jobId of jobIds) {
      appendDispatchedEntry(meshId, 'node-flood', jobId, new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
    }

    const router = createRouter()
    await resumePendingRefineJobsOnStartup(router)

    // Ledger truth: all 5 are still recorded as task_failed — history/mesh_refine_status
    // stay complete. Suppression must never touch this path.
    const terminalEntries = readLedgerEntries(meshId, { kind: ['task_failed'] })
    const floodTerminals = terminalEntries.filter(e => jobIds.includes((e.payload as any)?.refineJob?.jobId))
    expect(floodTerminals).toHaveLength(5)

    // Coordinator push: none of the 5 should have produced a queued refine:failed
    // event — that is the flood this wiring exists to stop.
    const pending = getPendingMeshCoordinatorEvents(meshId)
    const floodPushes = pending.filter(e => e.event === 'refine:failed'
      && jobIds.includes((e.metadataEvent as any)?.jobId))
    expect(floodPushes).toHaveLength(0)
  })

  it('★still notifies a close_stale dispatch that was plausibly in flight this session (younger than the notify horizon) — over-suppression is the worse failure', async () => {
    const meshId = setUpMeshWithWorktreeNode('node-recent-stale')
    const jobId = 'refine_recent_stale_test'
    // Force a tiny grace window and the minimum allowed zombie cutoff (5min, the
    // resolveTunedReconcileMs floor) so this dispatch clears RESUME-DISPATCH-GRACE
    // and is classified close_stale, while widening the notify horizon past that
    // same age — a genuine failure the coordinator may still be actively waiting on.
    process.env.MESH_REFINE_RESUME_DISPATCH_GRACE_MS = '0'
    process.env.MESH_REFINE_RESUME_ZOMBIE_CUTOFF_MS = String(5 * 60_000)
    process.env.MESH_REFINE_CLOSEOUT_NOTIFY_HORIZON_MS = String(10 * 60_000)
    try {
      const dispatchedAt = new Date(Date.now() - 6 * 60_000).toISOString()
      appendDispatchedEntry(meshId, 'node-recent-stale', jobId, dispatchedAt)

      const router = createRouter()
      await resumePendingRefineJobsOnStartup(router)

      const terminalEntries = readLedgerEntries(meshId, { kind: ['task_failed'] })
      expect(terminalEntries.some(e => (e.payload as any)?.refineJob?.jobId === jobId)).toBe(true)

      const pending = getPendingMeshCoordinatorEvents(meshId)
      const notified = pending.some(e => e.event === 'refine:failed' && (e.metadataEvent as any)?.jobId === jobId)
      expect(notified).toBe(true)
    } finally {
      delete process.env.MESH_REFINE_RESUME_DISPATCH_GRACE_MS
      delete process.env.MESH_REFINE_RESUME_ZOMBIE_CUTOFF_MS
      delete process.env.MESH_REFINE_CLOSEOUT_NOTIFY_HORIZON_MS
    }
  })

  it('never notifies a close_removed_node disposition regardless of age — no actionable follow-up exists', async () => {
    const meshId = setUpMeshWithWorktreeNode('node-will-be-removed')
    const jobId = 'refine_removed_node_test'
    // Fresh dispatch (would otherwise be inside the notify horizon) for a node that
    // no longer exists in the mesh once we remove it below.
    appendDispatchedEntry(meshId, 'node-will-be-removed', jobId, new Date(Date.now() - 1_000).toISOString())

    const { removeNode } = await import('../../src/config/mesh-config')
    removeNode(meshId, 'node-will-be-removed')

    const router = createRouter()
    await resumePendingRefineJobsOnStartup(router)

    const terminalEntries = readLedgerEntries(meshId, { kind: ['task_failed'] })
    expect(terminalEntries.some(e => (e.payload as any)?.refineJob?.jobId === jobId)).toBe(true)

    const pending = getPendingMeshCoordinatorEvents(meshId)
    expect(pending.some(e => e.event === 'refine:failed' && (e.metadataEvent as any)?.jobId === jobId)).toBe(false)
  })
})

describe('shouldNotifyRefineCloseOut — fail-open on unparseable age', () => {
  it('notifies (fail-open) when disposition is close_stale but ageMs is undefined', () => {
    // classifyRefineDispatch can only ever produce close_stale WITH ageMs defined —
    // this exercises the defensive branch directly via the Pick<> contract, which a
    // future caller or classifier refactor could still hit. Fail-open mirrors
    // mesh-skip-notify.ts's STALE-SCAN-BLOCKER precedent: an unknown age must not
    // silently read as "safe to suppress".
    expect(shouldNotifyRefineCloseOut({ disposition: 'close_stale', ageMs: undefined }, 60_000)).toBe(true)
  })

  it('still suppresses close_removed_node even with ageMs undefined', () => {
    expect(shouldNotifyRefineCloseOut({ disposition: 'close_removed_node', ageMs: undefined }, 60_000)).toBe(false)
  })
})
