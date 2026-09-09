import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// AUTOLAUNCH-SPAWN-CAP (P3): the durable circuit breaker on auto-launch.
//
// The incident (2026-09-08~09, 8.8h, ~300 launches): a launch/claim mismatch made
// the reconcile loop spawn a session per tick for the same pending task. The
// in-memory brakes (await-claim backoff, cooldowns, dedup) partially held — until
// the session pileup caused an EMFILE crash, the daemon restarted, every
// in-memory brake reset, and the loop re-ignited (127 launches in 27 minutes).
//
// Hence the three properties under test here:
//   (1) CAP TRIPS  — N launches with no successful claim → the task PARKS
//       (claimable by nobody) and the coordinator is paged.
//   (2) DURABLE    — the counter survives a store close/reopen (the restart that
//       defeated every in-memory brake). An in-memory implementation fails this.
//   (3) NO FALSE POSITIVES — a claim resets the budget so healthy tasks never
//       park, and a requeue (the sanctioned exit from the park) restores a fresh
//       budget so the exit is not a dead end.

const testTmpDir = path.join(tmpdir(), `adhdev-spawn-cap-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn(async () => ({ path: '/usr/bin/codex' })) }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  claimNextTask,
  getParkedTasks,
  getQueue,
  recordTaskAutoLaunch,
  requeueTask,
} from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import { taskIsParked } from '../../src/mesh/mesh-task-parking.js'
import {
  AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP,
  SPAWN_CAP_PARK_REASON,
  autoLaunchUnclaimedSpawnCount,
} from '../../src/mesh/mesh-autolaunch-spawn-cap.js'
import { isActionableSkipReason } from '../../src/mesh/mesh-skip-notify.js'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'

const NODE_ID = 'node_main'

function createComponents() {
  return {
    instanceManager: {
      getByCategory: vi.fn(() => []),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) =>
        command === 'launch_cli' ? { success: true, sessionId: `spawned-${randomUUID().slice(0, 6)}` } : { success: true }),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
      getMeta: vi.fn(() => undefined),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Spawn Cap Mesh',
    policy: {},
    nodes: [
      { id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } },
    ],
  })
}

function insertPendingTask(meshId: string): { id: string } {
  const id = `task_${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id, meshId, message: 'do work', status: 'pending', taskMode: 'code_change',
    createdAt: now, updatedAt: now,
  } as any)
  return { id }
}

function task(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

/** Spend N units of the task's durable budget the way the launch path does. */
function recordStartedLaunches(meshId: string, taskId: string, n: number) {
  for (let i = 0; i < n; i++) {
    recordTaskAutoLaunch(meshId, taskId, { status: 'started', nodeId: NODE_ID, providerType: 'codex-cli' })
    // A real local launch follows 'started' with 'failed' or 'completed'; use 'failed'
    // (no sessionId) so the await-claim guard does not absorb the next scan pass —
    // this models the crash-restart loop where no launch ever produces a claim.
    recordTaskAutoLaunch(meshId, taskId, { status: 'failed', reason: 'launch_missing_session_id', nodeId: NODE_ID, providerType: 'codex-cli' })
  }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

// ───────────────────────────────────────────────────────────────────────────
// (1) The cap trips: budget exhausted → parked, unclaimable, coordinator paged.
// ───────────────────────────────────────────────────────────────────────────
describe('(1) a task whose spawn budget is exhausted parks instead of launching again', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('counts each started launch once and parks at the cap with a coordinator page', async () => {
    const meshId = `mesh_cap_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      const t = insertPendingTask(meshId)

      recordStartedLaunches(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP)
      expect(autoLaunchUnclaimedSpawnCount(task(meshId, t.id)!)).toBe(AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP)

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(true)
      expect(after.parked?.reason).toBe(SPAWN_CAP_PARK_REASON)
      expect(after.status).toBe('pending')
      // No further session was spawned for it on the tick that parked it.
      expect(components.cliManager.handleCliCommand).not.toHaveBeenCalled()

      // ★ Claimable by nobody (the same claim-gate property pin parking relies on).
      expect(claimNextTask(meshId, NODE_ID, 'any-idle-session', [])).toBeNull()

      // Visible where the coordinator looks, with the spawn-cap reason.
      expect(getParkedTasks(meshId).map(p => p.id)).toContain(t.id)

      // The reason is actionable and a dispatch_blocked page was queued.
      expect(isActionableSkipReason(SPAWN_CAP_PARK_REASON)).toBe(true)
      const events = drainPendingMeshCoordinatorEvents(meshId, 'test-machine') as any[]
      const page = events.find(e => (e as any).metadataEvent?.taskId === t.id)
      expect(page).toBeDefined()
      expect((page as any).event).toBe('mesh:dispatch_blocked')
      expect((page as any).metadataEvent?.reason).toBe(SPAWN_CAP_PARK_REASON)
      expect((page as any).coordinatorMessage).toContain('NONE ever claimed')
    } finally {
      cleanup(meshId)
    }
  })

  it('BELOW the cap it does not park — the scan proceeds to launch', async () => {
    const meshId = `mesh_below_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      const t = insertPendingTask(meshId)

      recordStartedLaunches(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP - 1)
      await triggerMeshQueue(components, meshId)

      expect(taskIsParked(task(meshId, t.id)!)).toBe(false)
      // The tick fired a real launch instead (the mocked launch_cli).
      expect(components.cliManager.handleCliCommand).toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// (2) ★ DURABILITY — the counter survives the restart that resets every
//     in-memory brake. This test FAILS if the counter is held in a Map/Set.
// ───────────────────────────────────────────────────────────────────────────
describe('(2) the spawn counter is durable across a store close/reopen (daemon restart)', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('persists the count through MeshRuntimeStore close+reopen and still trips the cap after the restart', async () => {
    const meshId = `mesh_durable_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      const t = insertPendingTask(meshId)

      // Pre-crash: spend most of the budget.
      recordStartedLaunches(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP - 2)

      // ★ Simulate the EMFILE crash/restart: close the store singleton WITHOUT
      // touching the on-disk SQLite file. The next getInstance() reopens the same
      // file — exactly what a restarted daemon does. Every in-memory brake in the
      // launch path is reset the same way the crash reset them.
      MeshRuntimeStore.resetForTests()
      __resetAutoLaunchAwaitClaimBackoffForTests()

      // The count survived the restart (an in-memory counter would read 0 here).
      const reloaded = task(meshId, t.id)!
      expect(autoLaunchUnclaimedSpawnCount(reloaded)).toBe(AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP - 2)

      // Post-restart re-ignition burns the remaining budget, then the cap trips —
      // instead of the pre-P3 behavior (fresh brakes, unlimited re-ignition).
      recordStartedLaunches(meshId, t.id, 2)
      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(true)
      expect(after.parked?.reason).toBe(SPAWN_CAP_PARK_REASON)
      expect(components.cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// (3) NO FALSE POSITIVES — claims reset the budget; requeue is a real exit.
// ───────────────────────────────────────────────────────────────────────────
describe('(3) healthy tasks never park, and requeue restores a fresh budget', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('a successful claim resets the counter, so a normally-cycling task is never parked', async () => {
    const meshId = `mesh_healthy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      const t = insertPendingTask(meshId)

      // One unit short of the cap…
      recordStartedLaunches(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP - 1)
      // …then the healthy outcome: a session claims the task.
      const claimed = claimNextTask(meshId, NODE_ID, 'worker-session', [])
      expect(claimed?.id).toBe(t.id)
      // ★ The budget reset at the claim choke point.
      expect(autoLaunchUnclaimedSpawnCount(task(meshId, t.id)!)).toBe(0)

      // The task comes back (worker crashed → operator requeue) and launches again:
      // a fresh sub-cap run of launches must NOT park it.
      requeueTask(meshId, t.id, { reason: 'worker_crashed', force: true })
      recordStartedLaunches(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP - 1)
      await triggerMeshQueue(components, meshId)

      expect(taskIsParked(task(meshId, t.id)!)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  it('requeueing a spawn-cap-parked task unparks it AND restores the budget (the exit is not dead)', async () => {
    const meshId = `mesh_exit_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      const t = insertPendingTask(meshId)

      recordStartedLaunches(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP)
      await triggerMeshQueue(components, meshId)
      expect(taskIsParked(task(meshId, t.id)!)).toBe(true)

      const requeued = requeueTask(meshId, t.id, { reason: 'coordinator fixed the mismatch', force: true })
      expect(taskIsParked(requeued!)).toBe(false)
      // ★ Without the budget reset the next launch attempt would re-park immediately.
      expect(autoLaunchUnclaimedSpawnCount(requeued!)).toBe(0)

      await triggerMeshQueue(components, meshId)
      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(false)
      // The unparked task actually launched again (fresh budget in use).
      expect(components.cliManager.handleCliCommand).toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  it('legacy rows (no counter field) read as 0 and are unaffected', () => {
    const meshId = `mesh_legacy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId)
      expect(autoLaunchUnclaimedSpawnCount(task(meshId, t.id)!)).toBe(0)
      // Non-'started' records spend nothing.
      recordTaskAutoLaunch(meshId, t.id, { status: 'skipped', reason: 'auto_launch_cooldown' })
      recordTaskAutoLaunch(meshId, t.id, { status: 'completed', nodeId: NODE_ID, sessionId: 'sess-x' })
      expect(autoLaunchUnclaimedSpawnCount(task(meshId, t.id)!)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })
})
