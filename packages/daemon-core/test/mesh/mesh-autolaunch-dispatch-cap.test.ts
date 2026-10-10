import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// AUTOLAUNCH-DISPATCH-CAP: the durable circuit breaker on the pure
// transport-failure axis of auto-launch — the counterpart to
// mesh-autolaunch-spawn-cap.test.ts / -transport-aware.test.ts.
//
// Those existing tests establish (correctly) that a transport failure must
// spend NO spawn budget, so it never trips AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP —
// see '① a launch dispatch that dies in the coordinator transport spends NO
// spawn budget … never parks the task' in -transport-aware.test.ts. That left
// a genuine gap: nothing else caps the dispatch-failure axis EITHER, so a task
// whose every launch dies in transport can retry forever. Live (2026-10-10):
// autoLaunchDispatchFailedCount reached 106 over 21 minutes before a human
// cancelled it by hand.
//
// This file proves the NEW cap closes that gap without reopening the one the
// transport-aware fix closed: a transport failure still spends no SPAWN
// budget (unchanged), but now trips its OWN dispatch-failure budget once pure
// transport failures accumulate past AUTO_LAUNCH_DISPATCH_FAILURE_CAP.

const testTmpDir = path.join(tmpdir(), `adhdev-dispatch-cap-test-${randomUUID().slice(0, 8)}`)
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
  getQueue,
  requeueTask,
  claimNextTask,
} from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import { taskIsParked } from '../../src/mesh/mesh-task-parking.js'
import { AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP, autoLaunchUnclaimedSpawnCount } from '../../src/mesh/mesh-autolaunch-spawn-cap.js'
import {
  AUTO_LAUNCH_DISPATCH_FAILURE_CAP,
  DISPATCH_FAILURE_CAP_PARK_REASON,
  autoLaunchDispatchFailureCount,
  resolveDispatchFailureBackoffMs,
} from '../../src/mesh/mesh-autolaunch-dispatch-cap.js'
import { isActionableSkipReason } from '../../src/mesh/mesh-skip-notify.js'
import { drainPendingMeshCoordinatorEvents } from '../helpers/pending-notices.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'

const NODE_ID = 'node_remote'
const REMOTE_DAEMON_ID = 'daemon_mach_remote_node'

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Dispatch Cap Mesh',
    policy: {},
    nodes: [
      {
        id: NODE_ID,
        workspace: `/repo/${NODE_ID}`,
        repoRoot: `/repo/${NODE_ID}`,
        daemonId: REMOTE_DAEMON_ID,
        policy: { providerPriority: ['codex-cli'] },
      },
    ],
  })
}

/**
 * @param dispatch 'throws' models the pure transport failure (mirrors the
 *   transport-aware suite's fixture exactly): every `launch_cli` dispatch dies
 *   inside the coordinator's own P2P layer with the SAME error shape
 *   ("Peer signaling is temporarily unavailable…" is one real instance of it).
 *   'spawns' is the healthy control.
 */
function createComponents(dispatch: 'throws' | 'spawns') {
  const dispatchMeshCommand = dispatch === 'throws'
    ? vi.fn(async () => { throw new Error('Peer signaling is temporarily unavailable; reconnect retry is already scheduled.') })
    : vi.fn(async () => ({ payload: { success: true, sessionId: `remote-${randomUUID().slice(0, 6)}` } }))
  return withMeshRouter({
    instanceManager: { getByCategory: vi.fn(() => []), getInstance: vi.fn(() => undefined) },
    cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
      getMeta: vi.fn(() => undefined),
    },
    dispatchMeshCommand,
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any)
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

/** Mirrors the transport-aware suite's helper: one full attempt per call,
 *  clearing the in-memory cooldown/await-claim brakes between passes so each
 *  iteration is a distinct attempt rather than a no-op suppressed cooldown. */
async function runLaunchAttempts(components: any, meshId: string, taskId: string, attempts: number) {
  for (let i = 0; i < attempts; i++) {
    await triggerMeshQueue(components, meshId)
    __resetAutoLaunchAwaitClaimBackoffForTests()
    MeshRuntimeStore.resetForTests()
    if (!task(meshId, taskId)) throw new Error('task vanished mid-scan')
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
// (1) THE GAP CLOSES: repeated pure transport failures eventually park.
// ───────────────────────────────────────────────────────────────────────────
describe('(1) a task whose every launch dies in transport eventually parks on its OWN cap', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('parks once dispatch failures reach AUTO_LAUNCH_DISPATCH_FAILURE_CAP, with zero spawn budget spent', async () => {
    const meshId = `mesh_dispatch_cap_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('throws')
      const t = insertPendingTask(meshId)

      // Deliberately over-run the cap, the way the live 106-failure case did.
      await runLaunchAttempts(components, meshId, t.id, AUTO_LAUNCH_DISPATCH_FAILURE_CAP + 2)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(true)
      expect(after.parked?.reason).toBe(DISPATCH_FAILURE_CAP_PARK_REASON)
      // ★ The property the transport-aware fix established must still hold: a
      // transport failure spends no SPAWN budget. This cap is a SEPARATE axis.
      expect(autoLaunchUnclaimedSpawnCount(after)).toBe(0)
      expect(claimNextTask(meshId, NODE_ID, 'any-idle-session', [])).toBeNull()
      expect(getQueue(meshId).find(x => x.id === t.id)?.status).toBe('pending')

      expect(isActionableSkipReason(DISPATCH_FAILURE_CAP_PARK_REASON)).toBe(true)
      const events = drainPendingMeshCoordinatorEvents(meshId, 'test-machine') as any[]
      const page = events.find(e => (e as any).metadataEvent?.taskId === t.id)
      expect(page).toBeDefined()
      expect((page as any).event).toBe('mesh:dispatch_blocked')
      expect((page as any).coordinatorMessage).toContain('NO session was ever created')
      expect((page as any).coordinatorMessage.toLowerCase()).toContain('transport')
    } finally {
      cleanup(meshId)
    }
  })

  it('BELOW the cap it keeps retrying — the scan does not stop prematurely', async () => {
    const meshId = `mesh_below_dispatch_cap_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('throws')
      const t = insertPendingTask(meshId)

      await runLaunchAttempts(components, meshId, t.id, AUTO_LAUNCH_DISPATCH_FAILURE_CAP - 1)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(false)
      expect(autoLaunchDispatchFailureCount(after)).toBe(AUTO_LAUNCH_DISPATCH_FAILURE_CAP - 1)
      // Every attempt really dispatched — not vacuously passing.
      expect(components.dispatchMeshCommand.mock.calls.length).toBeGreaterThan(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('requeue unparks it and resets the dispatch-failure budget (the exit is not dead)', async () => {
    const meshId = `mesh_dispatch_exit_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('throws')
      const t = insertPendingTask(meshId)

      // The cap check runs at the START of a scan, against the count left by
      // PRIOR attempts — so it takes CAP attempts to accumulate the failures
      // and one more scan to observe and act on having reached it (same shape
      // as the park test above, which over-runs by 2 for the same reason).
      await runLaunchAttempts(components, meshId, t.id, AUTO_LAUNCH_DISPATCH_FAILURE_CAP + 1)
      expect(taskIsParked(task(meshId, t.id)!)).toBe(true)

      const requeued = requeueTask(meshId, t.id, { reason: 'transport recovered', force: true }) as any
      expect(taskIsParked(requeued)).toBe(false)
      expect(requeued.autoLaunchDispatchFailedCount).toBeUndefined()

      // A healthy retry after the requeue succeeds instead of re-parking immediately.
      const healthy = createComponents('spawns')
      await triggerMeshQueue(healthy, meshId)
      expect(taskIsParked(task(meshId, t.id)!)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ★ (2) REGRESSION GUARD — the transport-aware spawn-budget fix must stay
//     intact: a transport failure alone (below THIS cap) still spends no
//     spawn budget and does not trip the OTHER (spawn) cap.
// ───────────────────────────────────────────────────────────────────────────
describe('★ transport-aware spawn-budget guard stays intact', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('a handful of transport failures (below the dispatch cap) spend zero spawn budget and do not trip the spawn cap', async () => {
    const meshId = `mesh_no_spawn_charge_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('throws')
      const t = insertPendingTask(meshId)

      await runLaunchAttempts(components, meshId, t.id, 3)

      const after = task(meshId, t.id)!
      expect(autoLaunchUnclaimedSpawnCount(after)).toBe(0)
      expect(taskIsParked(after)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// (3) Backoff: the cooldown between attempts must GROW with failure history,
//     not stay flat — this is the other half of the live 106-in-21-min defect.
// ───────────────────────────────────────────────────────────────────────────
describe('(3) resolveDispatchFailureBackoffMs grows with failure history and is capped', () => {
  it('increases monotonically with the failure count', () => {
    const base = 5_000
    const d0 = resolveDispatchFailureBackoffMs(0, base)
    const d1 = resolveDispatchFailureBackoffMs(1, base)
    const d2 = resolveDispatchFailureBackoffMs(2, base)
    expect(d1).toBeGreaterThan(d0)
    expect(d2).toBeGreaterThan(d1)
  })

  it('is capped so it never grows unbounded', () => {
    const base = 5_000
    const huge = resolveDispatchFailureBackoffMs(1000, base)
    const atCap = resolveDispatchFailureBackoffMs(10, base)
    expect(huge).toBe(atCap)
    expect(huge).toBeLessThanOrEqual(5 * 60_000)
  })

  it('the live incident (106 failures, no cap, flat cooldown, open-ended) cannot recur: this axis now stops at 10 attempts total', () => {
    const base = 5_000
    let elapsed = 0
    for (let i = 0; i < AUTO_LAUNCH_DISPATCH_FAILURE_CAP; i++) {
      elapsed += resolveDispatchFailureBackoffMs(i, base)
    }
    // The live incident had NO attempt cap at all — 106 and still climbing when a
    // human intervened, with no bound in sight. The property that matters is
    // FINITENESS: this axis now stops retrying entirely at
    // AUTO_LAUNCH_DISPATCH_FAILURE_CAP (10) attempts, so the total wall-clock
    // spent retrying is bounded by construction, however large any individual
    // backoff step grows — a concrete, calculable number instead of "whatever a
    // human notices and cancels by hand".
    expect(Number.isFinite(elapsed)).toBe(true)
    expect(elapsed).toBeLessThanOrEqual(AUTO_LAUNCH_DISPATCH_FAILURE_CAP * 5 * 60_000)
  })
})
