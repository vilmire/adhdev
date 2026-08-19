import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// AUTOLAUNCH-TASK-RACE. `triggerMeshQueue` has no mesh-level mutex and is driven from five
// non-cooperating call sites (the 4s reconcile timer, three fire-and-forget event triggers,
// and the MCP tool). The only launch lock was keyed `${meshId}:${nodeId}` — per NODE, not per
// TASK — so two overlapping passes scanning the SAME pending task each ran a full launch:
//
//   - unpinned task → the racers pick DIFFERENT candidate nodes, the per-node lock never
//     collides, and BOTH sessions spawn (observed live: task dc9f9dd3);
//   - pinned task   → the racers converge on the one candidate node, one claim wins and the
//     loser is a silent orphan: the task stays `pending` with a session at totalMessages 0
//     (observed live: tasks 912c337f, 7d47d11a).
//
// Every duplicate-suppression gate ahead of the launch reads state the in-flight racer has not
// written yet (task.autoLaunch.status is stamped only AFTER the launch returns; the not-yet-
// spawned session is absent from instanceManager), so a per-TASK lock held across the whole
// await-interruptible per-task body is the only thing that can serialize them.
//
// This suite pins four properties:
//   (a) two concurrent passes launch exactly ONE session for a task;
//   (b) a targetNodeId-pinned task still claims normally after a race;
//   (c) task.autoLaunch names the session that was actually launched (not a late loser write);
//   (d) the lock is released on EVERY exit path, so no task is wedged pending forever.

const testTmpDir = path.join(tmpdir(), `adhdev-al-task-race-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
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
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import {
  __resetAutoLaunchAwaitClaimBackoffForTests,
  __autoLaunchTaskLockHeldForTests,
  __markAutoLaunchForTests,
} from '../../src/mesh/mesh-queue-assignment.js'
import { __seedAutoLaunchOrphanFirstSeenForTests } from '../../src/mesh/mesh-autolaunch-integrity.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

const NODE_A = 'node_alpha'
const NODE_B = 'node_beta'

// Two-node mesh. An UNPINNED task can land on either node, which is exactly the shape that let
// two racers spawn two sessions without ever contending on the per-node lock.
function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Auto-launch Race Mesh',
    policy: {},
    nodes: [
      { id: NODE_A, workspace: `/repo/${NODE_A}`, repoRoot: `/repo/${NODE_A}`, policy: { providerPriority: ['codex-cli'] } },
      { id: NODE_B, workspace: `/repo/${NODE_B}`, repoRoot: `/repo/${NODE_B}`, policy: { providerPriority: ['codex-cli'] } },
    ],
  })
}

// `launchDelayMs` widens the await window inside the per-task body (standing in for the real
// resolveUsableProvider/launch_cli round trip) so two concurrently-started passes genuinely
// overlap rather than running to completion one after the other.
function createComponents(opts: { launchDelayMs?: number } = {}) {
  const spawned: string[] = []
  const components: any = {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? [] : [])),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) => {
        if (command !== 'launch_cli') return { success: true }
        if (opts.launchDelayMs) await new Promise(r => setTimeout(r, opts.launchDelayMs))
        const sessionId = `spawned-${randomUUID().slice(0, 8)}`
        spawned.push(sessionId)
        return { success: true, sessionId }
      }),
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
  }
  components.__spawned = spawned
  return components
}

function launchCliCalls(components: any): number {
  return components.cliManager.handleCliCommand.mock.calls.filter((c: any[]) => c[0] === 'launch_cli').length
}

function taskRow(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  // Also clears the per-task/per-node launch locks and the orphan-report de-dup, so a case
  // cannot inherit another's suppression state.
  __resetAutoLaunchAwaitClaimBackoffForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('AUTOLAUNCH-TASK-RACE — per-task lock serializes concurrent triggerMeshQueue passes', () => {
  afterEach(() => { vi.clearAllMocks() })

  // (a) The core property. Without the per-task lock both passes clear every gate (neither has
  // written task.autoLaunch yet, and each picks a different node so the per-NODE lock never
  // collides) and TWO launch_cli calls fire for one task.
  it('(a) two concurrent passes launch exactly ONE session for the same pending task', async () => {
    const meshId = `mesh_race_one_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents({ launchDelayMs: 25 })
      const task = enqueueTask(meshId, 'racy work', { taskMode: 'code_change', difficulty: 'medium' })

      // Started together, without awaiting the first — the live shape (reconcile tick and an
      // event trigger firing in the same window).
      await Promise.all([
        triggerMeshQueue(components, meshId),
        triggerMeshQueue(components, meshId),
      ])

      expect(launchCliCalls(components)).toBe(1)
      expect(components.__spawned).toHaveLength(1)
      // And the lock did not leak, so the task is not wedged.
      expect(__autoLaunchTaskLockHeldForTests(meshId, task.id)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  // (b) The PINNED variant — the same race, but with only one candidate node it presented as a
  // silent claim failure (task stuck `pending`, orphan session at totalMessages 0) rather than
  // as a visible duplicate. After the fix the pinned task launches once and claims.
  it('(b) a targetNodeId-pinned task launches once and reaches assigned under concurrent passes', async () => {
    const meshId = `mesh_race_pin_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents({ launchDelayMs: 25 })
      const task = enqueueTask(meshId, 'pinned work', {
        taskMode: 'code_change',
        difficulty: 'medium',
        targetNodeId: NODE_A,
      })

      await Promise.all([
        triggerMeshQueue(components, meshId),
        triggerMeshQueue(components, meshId),
      ])

      expect(launchCliCalls(components)).toBe(1)
      const row = taskRow(meshId, task.id)
      // The launch landed on the pinned node and the task did NOT stay silently pending.
      expect(row?.autoLaunch?.nodeId).toBe(NODE_A)
      expect(row?.status).toBe('assigned')
      expect(__autoLaunchTaskLockHeldForTests(meshId, task.id)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  // (c) AUTOLAUNCH-WINNER-CLOBBER. recordTaskAutoLaunch replaces entry.autoLaunch wholesale, so
  // whichever racer finished LAST owned the field regardless of which won the claim — the field
  // pointed at the ORPHAN, and that is what misled diagnosis of this defect. The field must name
  // the session that was actually launched and assigned.
  it('(c) task.autoLaunch names the session that was actually launched and assigned', async () => {
    const meshId = `mesh_race_field_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents({ launchDelayMs: 25 })
      const task = enqueueTask(meshId, 'field work', { taskMode: 'code_change', difficulty: 'medium' })

      await Promise.all([
        triggerMeshQueue(components, meshId),
        triggerMeshQueue(components, meshId),
      ])

      const row = taskRow(meshId, task.id)
      const launchedSessionId = components.__spawned[0]
      expect(launchedSessionId).toBeTruthy()
      expect(row?.autoLaunch?.status).toBe('completed')
      expect(row?.autoLaunch?.sessionId).toBe(launchedSessionId)
      // The authoritative field agrees with the actual assignment — no loser clobber.
      expect(row?.assignedSessionId).toBe(launchedSessionId)
    } finally {
      cleanup(meshId)
    }
  })

  // (d) Lock-release completeness. The per-task body exits through `continue` (every gate), a
  // `return` (launch success/failure), and a throw from the awaited launch. A leak on ANY of
  // them wedges the task pending forever — strictly worse than the duplicate it prevents. Drive
  // a THROWING launch, then confirm the lock is free and a later pass can still launch.
  it('(d) the per-task lock is released when the launch throws, so a later pass still launches', async () => {
    const meshId = `mesh_race_release_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      let failNext = true
      components.cliManager.handleCliCommand = vi.fn(async (command: string) => {
        if (command !== 'launch_cli') return { success: true }
        if (failNext) { failNext = false; throw new Error('simulated launch explosion') }
        return { success: true, sessionId: 'recovered-session' }
      })
      const task = enqueueTask(meshId, 'throwing work', { taskMode: 'code_change', difficulty: 'medium' })

      await triggerMeshQueue(components, meshId)
      // The throw was caught by the launch's own catch and must NOT have stranded the lock.
      expect(__autoLaunchTaskLockHeldForTests(meshId, task.id)).toBe(false)

      // A later pass must be able to launch the same task again — proof the lock is not wedged.
      // (The per-node cooldown set by the failure applies to the node that threw; the sibling
      // node is still eligible, which is what makes this a lock check rather than a cooldown one.)
      await triggerMeshQueue(components, meshId)
      expect(__autoLaunchTaskLockHeldForTests(meshId, task.id)).toBe(false)
      expect(launchCliCalls(components)).toBeGreaterThanOrEqual(2)
    } finally {
      cleanup(meshId)
    }
  })

  // (d, gate-path variant) A task blocked by a plain gate (`continue`, no launch at all) must
  // also release the lock — the most common path by far, and the easiest to leak on.
  it('(d) the per-task lock is released on a gate skip path (no launch)', async () => {
    const meshId = `mesh_race_gate_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      // targetSessionId pins the task to a session that does not exist → the loop takes the
      // `target_session_constraint` / dead-target `continue` well before any launch.
      const task = enqueueTask(meshId, 'gated work', {
        taskMode: 'code_change',
        difficulty: 'medium',
        targetSessionId: 'no-such-session',
      })

      await triggerMeshQueue(components, meshId)

      expect(launchCliCalls(components)).toBe(0)
      expect(__autoLaunchTaskLockHeldForTests(meshId, task.id)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})

// AUTOLAUNCH-WINNER-CLOBBER, tested directly. `recordTaskAutoLaunch` replaces entry.autoLaunch
// WHOLESALE, so a late-arriving non-winning write silently repoints the field at a session that
// did not get the work. The per-task lock above prevents the concurrent case, so this guard is
// the second layer covering records that still arrive out of order — it needs a direct write to
// exercise, or it rots untested behind the lock.
describe('AUTOLAUNCH-WINNER-CLOBBER — a losing write must not overwrite the in-window launch record', () => {
  afterEach(() => { vi.clearAllMocks() })

  function seedWinner(meshId: string, winnerSessionId: string) {
    const task = enqueueTask(meshId, 'winner work', { taskMode: 'code_change', difficulty: 'medium' })
    __markAutoLaunchForTests(meshId, task.id, {
      status: 'completed',
      nodeId: NODE_A,
      providerType: 'codex-cli',
      sessionId: winnerSessionId,
    })
    return task
  }

  it('a late skipped/failed write leaves the winner session on the record', async () => {
    const meshId = `mesh_clobber_skip_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = seedWinner(meshId, 'winner-session')

      // The loser racer's trailing writes, in the two shapes actually observed.
      __markAutoLaunchForTests(meshId, task.id, { status: 'skipped', reason: 'auto_launch_cooldown', nodeId: NODE_B })
      __markAutoLaunchForTests(meshId, task.id, { status: 'failed', reason: 'remote_launch_cli_failed', nodeId: NODE_B })

      const row = taskRow(meshId, task.id)
      expect(row?.autoLaunch?.status).toBe('completed')
      expect(row?.autoLaunch?.sessionId).toBe('winner-session')
      expect(row?.autoLaunch?.nodeId).toBe(NODE_A)
    } finally {
      cleanup(meshId)
    }
  })

  it('a completed write naming a DIFFERENT session does not steal the record', async () => {
    const meshId = `mesh_clobber_other_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = seedWinner(meshId, 'winner-session')

      __markAutoLaunchForTests(meshId, task.id, {
        status: 'started', nodeId: NODE_B, providerType: 'codex-cli', sessionId: 'loser-session',
      })

      expect(taskRow(meshId, task.id)?.autoLaunch?.sessionId).toBe('winner-session')
    } finally {
      cleanup(meshId)
    }
  })

  it('the SAME session\'s own progression still records (the guard is not a freeze)', async () => {
    const meshId = `mesh_clobber_same_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = seedWinner(meshId, 'winner-session')

      // A genuine terminal for the winning session must land — otherwise the guard would
      // freeze the field and hide real failures.
      __markAutoLaunchForTests(meshId, task.id, {
        status: 'failed', reason: 'launch_cli_failed', nodeId: NODE_A, sessionId: 'winner-session',
      })

      expect(taskRow(meshId, task.id)?.autoLaunch?.status).toBe('failed')
    } finally {
      cleanup(meshId)
    }
  })
})

// AUTOLAUNCH-ORPHAN-SWEEP. Defence layer behind the per-task lock: a race-loser session holds no
// assigned task (invisible to the reclaim watchdog) and is idle (invisible to stall monitors), so
// nothing recovered it — live, an unrelated PTY-stall monitor noticed three minutes later and it
// took a manual mesh_remove_node. The sweep surfaces it to the coordinator instead.
describe('AUTOLAUNCH-ORPHAN-SWEEP — an auto-launched session whose task went elsewhere is reported', () => {
  afterEach(() => { vi.clearAllMocks() })

  // An idle CLI session stamped as auto-launched for `taskId` on NODE_A.
  function orphanSession(meshId: string, sessionId: string, taskId: string) {
    const state = {
      instanceId: sessionId,
      status: 'idle',
      workspace: `/repo/${NODE_A}`,
      activeChat: null,
      settings: { meshNodeFor: meshId, meshNodeId: NODE_A, autoLaunchedForQueueTaskId: taskId },
    }
    return { category: 'cli', getState: () => state }
  }

  function orphanLedgerReasons(meshId: string): string[] {
    try {
      // recordAutoLaunchEvent writes the reason into the `session_auto_launch` payload.
      return readLedgerEntries(meshId)
        .map((e: any) => e?.payload?.reason)
        .filter((r: any) => r === 'auto_launch_orphan_session_detected')
    } catch {
      return []
    }
  }

  it('reports an idle auto-launched session whose task is assigned to a different session', async () => {
    const meshId = `mesh_orphan_hit_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = enqueueTask(meshId, 'raced work', { taskMode: 'code_change', difficulty: 'medium' })
      // The task went to the WINNER; this session lost and holds nothing.
      MeshRuntimeStore.getInstance().updateQueueEntry({
        ...task, status: 'assigned', assignedNodeId: NODE_B, assignedSessionId: 'winner-session',
        updatedAt: new Date().toISOString(),
      } as any)
      const components = createComponents()
      components.instanceManager.getByCategory = vi.fn((category: string) =>
        category === 'cli' ? [orphanSession(meshId, 'orphan-session', task.id)] : [])

      // The condition must PERSIST past the grace window before it is reported, so a single
      // tick records nothing. Backdate the first-seen stamp rather than sleeping it out.
      await triggerMeshQueue(components, meshId)
      expect(orphanLedgerReasons(meshId)).toHaveLength(0)

      __seedAutoLaunchOrphanFirstSeenForTests(meshId, 'orphan-session', Date.now() - 60_000)
      await triggerMeshQueue(components, meshId)

      expect(orphanLedgerReasons(meshId).length).toBeGreaterThanOrEqual(1)
    } finally {
      cleanup(meshId)
    }
  })

  // The healthy path: the session's own task is still PENDING, i.e. this session is the
  // launched worker on its way to claim it. That must never be reported — not even with the
  // grace long elapsed, because a slow remote claim legitimately sits here for tens of seconds
  // (the whole reason AUTO_LAUNCH_AWAIT_CLAIM_MS is 90s).
  it('does NOT report a session whose own task is still pending (it is converging to claim it)', async () => {
    const meshId = `mesh_orphan_miss_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = enqueueTask(meshId, 'converging work', { taskMode: 'code_change', difficulty: 'medium' })
      // Hold the task pending and give the mesh no launchable node, so the drain cannot
      // reassign it to a fresh spawn and the pending-origin branch is what the sweep sees.
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'No Nodes', policy: {}, nodes: [] })
      const components = createComponents()
      components.instanceManager.getByCategory = vi.fn((category: string) =>
        category === 'cli' ? [orphanSession(meshId, 'converging-session', task.id)] : [])

      __seedAutoLaunchOrphanFirstSeenForTests(meshId, 'converging-session', Date.now() - 60_000)
      await triggerMeshQueue(components, meshId)

      expect(taskRow(meshId, task.id)?.status).toBe('pending')
      expect(orphanLedgerReasons(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // The grace exists because a single matching tick is not evidence: an idle worker the drain
  // merely did not pick this pass is indistinguishable from a race loser at that instant, and
  // paging the coordinator about a session that is about to be reused is a false blocker. This
  // is the exact shape that made the sweep fire during development.
  it('does NOT report an idle worker on its FIRST matching tick (grace not yet elapsed)', async () => {
    const meshId = `mesh_orphan_grace_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = enqueueTask(meshId, 'raced work', { taskMode: 'code_change', difficulty: 'medium' })
      MeshRuntimeStore.getInstance().updateQueueEntry({
        ...task, status: 'assigned', assignedNodeId: NODE_B, assignedSessionId: 'winner-session',
        updatedAt: new Date().toISOString(),
      } as any)
      const components = createComponents()
      components.instanceManager.getByCategory = vi.fn((category: string) =>
        category === 'cli' ? [orphanSession(meshId, 'fresh-idle-session', task.id)] : [])

      await triggerMeshQueue(components, meshId)

      expect(orphanLedgerReasons(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })
})
