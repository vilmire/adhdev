import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// SPAWN-CAP-TRANSPORT-AWARE — two defects, two layers.
//
// The incident (2026-09-17). A 26-minute coordinator WS reconnect storm degraded P2P
// signalling. Ten `launch_cli` dispatches to two nodes failed AT THE SIGNALLING LAYER
// (SIGNAL_RATE_LIMIT, bounded-handshake timeouts, "reconnect retry already scheduled") —
// the commands never left the coordinator's own transport. ZERO sessions were created.
// A third node succeeded in the same window with the same coordinator and code path, so
// this was never a node-health difference.
//
// Two distinct defects followed from that, and each is tested separately here:
//
//   ① COUNTING. `markAutoLaunch('started')` fires BEFORE the dispatch is awaited, and the
//      spawn budget was charged on that record — i.e. on the mere INTENT to launch. The
//      failure path never refunded it, so pure transport failure consumed a DURABLE spawn
//      budget and parked two healthy nodes' tasks. The cap is a launch/claim mismatch
//      detector; it must not double as a transport-failure amplifier.
//
//   ② MESSAGING. The park page asserted, unconditionally, "the daemon auto-launched 5+
//      worker sessions for it and NONE ever claimed the task" and "each further launch
//      would only produce another idle orphan session". With zero sessions in existence
//      that text sent the coordinator hunting through two healthy nodes' logs for hours.
//      All the evidence was coordinator-side (10× `remote_launch_dispatch_failed`).
//
// ★ And the property that must NOT regress: the 2026-09-08 runaway (8.8h, ~300 launches)
//   is why the cap exists. A task whose launches DO spawn sessions that never claim it
//   must still park. §(3) is that regression guard — if a fix to ① achieves "transport
//   failures don't park" by weakening the cap itself, §(3) goes red.

const testTmpDir = path.join(tmpdir(), `adhdev-spawn-cap-transport-${randomUUID().slice(0, 8)}`)
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
  recordTaskAutoLaunch,
} from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import { taskIsParked } from '../../src/mesh/mesh-task-parking.js'
import {
  AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP,
  SPAWN_CAP_PARK_REASON,
  autoLaunchUnclaimedSpawnCount,
} from '../../src/mesh/mesh-autolaunch-spawn-cap.js'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { notifyCoordinatorOfActionableSkip } from '../../src/mesh/mesh-skip-notify.js'

const NODE_ID = 'node_remote'
const REMOTE_DAEMON_ID = 'daemon_mach_remote_node'

/**
 * A REMOTE node: remote auto-launch is the path that goes through
 * `components.dispatchMeshCommand`, i.e. the coordinator's P2P transport — the exact layer
 * that failed in the incident. A local node would spawn in-process and never exercise it.
 */
function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Transport Aware Mesh',
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
 * @param dispatch how the coordinator's transport behaves for `launch_cli`.
 *   'throws'  — the incident: the dispatch dies inside the coordinator's own P2P layer.
 *   'spawns'  — healthy transport: the remote daemon accepts and returns a session id.
 */
function createComponents(dispatch: 'throws' | 'spawns') {
  const dispatchMeshCommand = dispatch === 'throws'
    ? vi.fn(async () => { throw new Error('SIGNAL_RATE_LIMIT: mesh signalling rate limit exceeded') })
    : vi.fn(async () => ({ payload: { success: true, sessionId: `remote-${randomUUID().slice(0, 6)}` } }))
  return {
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
  } as any
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

/**
 * Run the auto-launch scan repeatedly, clearing the per-launch cooldown between passes the
 * way wall-clock does in production. Each pass is one full launch attempt for the task.
 */
async function runLaunchAttempts(components: any, meshId: string, taskId: string, attempts: number) {
  for (let i = 0; i < attempts; i++) {
    await triggerMeshQueue(components, meshId)
    // The 25s post-attempt cooldown and the await-claim window are in-memory brakes; a real
    // retry happens after they lapse. Reset them so each iteration is a distinct attempt
    // rather than a no-op suppressed by the previous one's cooldown.
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
// ① COUNTING: a transport failure must not spend durable spawn budget.
// ───────────────────────────────────────────────────────────────────────────
describe('① a launch dispatch that dies in the coordinator transport spends NO spawn budget', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('burns zero budget across MORE attempts than the cap, and never parks the task', async () => {
    const meshId = `mesh_transport_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('throws')
      const t = insertPendingTask(meshId)

      // Deliberately over-run the cap: the incident made 10 attempts against a cap of 5.
      const attempts = AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP * 2
      await runLaunchAttempts(components, meshId, t.id, attempts)

      // The dispatches really were attempted (this is not a vacuous pass).
      expect(components.dispatchMeshCommand.mock.calls.length).toBeGreaterThan(0)
      for (const call of components.dispatchMeshCommand.mock.calls) expect(call[1]).toBe('launch_cli')

      const after = task(meshId, t.id)!
      // ★ THE PROPERTY: no session was created, so no budget was spent.
      expect(autoLaunchUnclaimedSpawnCount(after)).toBe(0)
      // ★ And therefore the task is NOT parked — a pure transport outage must not consume a
      //   durable budget and hand a healthy task to the coordinator as a dead row.
      expect(taskIsParked(after)).toBe(false)
      expect(after.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })

  it('records the failures on the separate dispatch-failure axis (so the page can name them)', async () => {
    const meshId = `mesh_axis_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('throws')
      const t = insertPendingTask(meshId)

      await runLaunchAttempts(components, meshId, t.id, 1)

      const after = task(meshId, t.id)! as any
      // Counted on its own axis — evidence for the message, no effect on the budget.
      expect(after.autoLaunchDispatchFailedCount).toBeGreaterThan(0)
      expect(autoLaunchUnclaimedSpawnCount(after)).toBe(0)
      // The autoLaunch record names the real transport error for diagnosis. (Note the
      // dispatch-failure COUNT is deliberately independent of this field: the field is
      // overwritten wholesale by later ticks and is subject to the winner-clobber guard,
      // which is exactly why the count lives on its own axis.)
      expect(after.autoLaunch?.status).toBe('failed')
      expect(after.autoLaunch?.reason).toContain('remote_launch_dispatch_failed')
    } finally {
      cleanup(meshId)
    }
  })

  it('a successful dispatch DOES spend budget — the fix is not "never count"', async () => {
    const meshId = `mesh_spend_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('spawns')
      const t = insertPendingTask(meshId)

      await runLaunchAttempts(components, meshId, t.id, 1)

      // A session was created, so exactly one unit was charged.
      expect(autoLaunchUnclaimedSpawnCount(task(meshId, t.id)!)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ★ (3) REGRESSION GUARD — the 2026-09-08 runaway defense must stay intact.
//     Sessions that spawn and never claim MUST still park.
// ───────────────────────────────────────────────────────────────────────────
describe('★ runaway defense intact: sessions that spawn but never claim still park', () => {
  afterEach(() => { vi.clearAllMocks() })

  /**
   * Spend N units the way a REAL spawned-but-unclaimed launch cycle does: the 'completed'
   * record that proves a session exists (this is the call the production launch path makes,
   * with the same `spendSpawnBudget` assertion), followed by the 'failed' record that models
   * the session dying without ever claiming — which also clears the `completed` + sessionId
   * pair the await-claim guard would otherwise use to suppress the next launch.
   */
  function recordUnclaimedSpawns(meshId: string, taskId: string, n: number) {
    for (let i = 0; i < n; i++) {
      recordTaskAutoLaunch(
        meshId, taskId,
        { status: 'completed', nodeId: NODE_ID, providerType: 'codex-cli', sessionId: `orphan-${i}` },
        { spendSpawnBudget: true },
      )
      recordTaskAutoLaunch(meshId, taskId, { status: 'failed', reason: 'session_exited_without_claim', nodeId: NODE_ID, providerType: 'codex-cli' })
    }
  }

  it('a healthy transport whose spawned sessions never claim the task still trips the cap', async () => {
    const meshId = `mesh_runaway_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // Transport is FINE; every launch creates a real remote session. But no session ever
      // claims the task — the launch/claim mismatch of the 2026-09-08 runaway.
      const components = createComponents('spawns')
      const t = insertPendingTask(meshId)

      recordUnclaimedSpawns(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP)
      // Every launch spawned a session and was charged for it.
      expect(autoLaunchUnclaimedSpawnCount(task(meshId, t.id)!)).toBe(AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP)

      // Next scan: the budget is exhausted, so this pass must PARK rather than launch again.
      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      // ★ THE REGRESSION PROPERTY: still parked, with the spawn-cap reason.
      expect(taskIsParked(after)).toBe(true)
      expect(after.parked?.reason).toBe(SPAWN_CAP_PARK_REASON)
      // ★ And the loop really stopped: no session was spawned on the parking pass.
      expect(components.dispatchMeshCommand).not.toHaveBeenCalled()
      // Claimable by nobody until the coordinator acts.
      expect(claimNextTask(meshId, NODE_ID, 'any-idle-session', [])).toBeNull()
    } finally {
      cleanup(meshId)
    }
  })

  it('requeue is still a real exit: it clears BOTH counters so the row is not re-parked', async () => {
    const meshId = `mesh_exit_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents('spawns')
      const t = insertPendingTask(meshId)

      recordUnclaimedSpawns(meshId, t.id, AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP)
      // Seed a transport failure too, so the reset covers BOTH axes.
      await runLaunchAttempts(createComponents('throws'), meshId, t.id, 1)
      await triggerMeshQueue(components, meshId)
      expect(taskIsParked(task(meshId, t.id)!)).toBe(true)

      const requeued = requeueTask(meshId, t.id, { reason: 'coordinator fixed it', force: true }) as any
      expect(taskIsParked(requeued)).toBe(false)
      expect(autoLaunchUnclaimedSpawnCount(requeued)).toBe(0)
      // The dispatch-failure tally is scoped to the same window, else a stale tally would
      // keep mislabelling a LATER, genuinely-mismatched park as a transport failure.
      expect(requeued.autoLaunchDispatchFailedCount).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② MESSAGING: the park page must branch on the cause and point at the
//    side that actually holds the evidence.
// ───────────────────────────────────────────────────────────────────────────
describe('② the spawn-cap park page names the real failure mode', () => {
  afterEach(() => { vi.clearAllMocks() })

  /** Page the coordinator for a spawn-cap park on a row seeded with the given counters. */
  function pageFor(meshId: string, counters: { spent?: number; dispatchFailed?: number }): string {
    const t = insertPendingTask(meshId)
    const entry = task(meshId, t.id)! as any
    if (counters.spent !== undefined) entry.autoLaunchUnclaimedCount = counters.spent
    if (counters.dispatchFailed !== undefined) entry.autoLaunchDispatchFailedCount = counters.dispatchFailed
    MeshRuntimeStore.getInstance().updateQueueEntry(entry)

    notifyCoordinatorOfActionableSkip(meshId, t.id, SPAWN_CAP_PARK_REASON, NODE_ID)
    const events = drainPendingMeshCoordinatorEvents(meshId, 'test-machine') as any[]
    const page = events.find(e => e.metadataEvent?.taskId === t.id)
    expect(page).toBeDefined()
    expect(page.event).toBe('mesh:dispatch_blocked')
    return String(page.coordinatorMessage)
  }

  it('DISPATCH-FAILED: says no session was created and points at the coordinator, not the node', () => {
    const meshId = `mesh_msg_transport_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const msg = pageFor(meshId, { spent: 0, dispatchFailed: 10 })

      // ★ It must NOT make the claim that misled the coordinator for hours.
      expect(msg).not.toContain('NONE ever claimed')
      expect(msg).not.toContain('idle orphan session')

      // ★ It must state the true facts: zero sessions, failure inside this coordinator.
      expect(msg).toContain('NO session was ever created')
      expect(msg).toContain('10 launch dispatch(es)')
      expect(msg.toLowerCase()).toContain('transport')

      // ★ And it must redirect the diagnosis to where the evidence actually is.
      expect(msg).toContain('remote_launch_dispatch_failed')
      expect(msg).toContain("Diagnose the COORDINATOR's transport, not the target node")
    } finally {
      cleanup(meshId)
    }
  })

  it('SESSIONS-NEVER-CLAIMED: keeps the original mismatch wording and node-log guidance', () => {
    const meshId = `mesh_msg_mismatch_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const msg = pageFor(meshId, { spent: AUTO_LAUNCH_UNCLAIMED_SPAWN_CAP, dispatchFailed: 0 })

      expect(msg).toContain('NONE ever claimed')
      expect(msg).toContain('idle orphan session')
      expect(msg).toContain('mesh_read_node_logs')
      // It must NOT borrow the transport wording — that would be the same error mirrored.
      expect(msg).not.toContain('NO session was ever created')
    } finally {
      cleanup(meshId)
    }
  })

  it('MIXED: names both modes and sends the coordinator to both places', () => {
    const meshId = `mesh_msg_mixed_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const msg = pageFor(meshId, { spent: 3, dispatchFailed: 4 })

      expect(msg).toContain('MIX of two failure modes')
      expect(msg).toContain('4 further launch dispatch(es)')
      // Both evidence locations are named.
      expect(msg).toContain('remote_launch_dispatch_failed')
      expect(msg).toContain('mesh_read_node_logs')
    } finally {
      cleanup(meshId)
    }
  })

  it('LEGACY rows (neither counter present) fall back to the original mismatch wording', () => {
    const meshId = `mesh_msg_legacy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // No counters at all — a row written before this change. The safe default is the
      // historical message, which points at the node exactly as it always did.
      const msg = pageFor(meshId, {})
      expect(msg).toContain('NONE ever claimed')
      expect(msg).not.toContain('NO session was ever created')
    } finally {
      cleanup(meshId)
    }
  })
})
