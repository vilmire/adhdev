import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// LEDGER-AUTOLAUNCH-RETRY-SPAM ⑤ — a task pinned to a SESSION THAT IS ALREADY RUNNING
// re-enters the claim funnel (tryAssignQueueTask → claimNextQueueTask) directly, never
// through the auto-launch selector. When the session's model can't clear the task's
// difficulty floor, the store refuses with the literal 'difficulty_floor_unmet' and — before
// this fix — that refusal returned `false` with NO pager behind it at all: the auto-launch
// path's own handleDifficultyFloorSkip call lived only in markAutoLaunch, which this path
// never runs. A task could sit refused forever, silently, once its session went idle.
//
// Live ledger evidence (per the fix task): 'difficulty_floor_unmet' was the #1 refusal
// reason (816 occurrences), with only 2 pages ever raised for it, and 29 pinned tasks were
// eventually cancelled by a human after sitting unclaimable up to 170 minutes.
//
// This suite pins three things at once:
//   1. TARGET RED (proven by reverting the wiring): the claim path pages after the bounded
//      wait — same as the pre-existing auto-launch path already does.
//   2. DEBOUNCE: repeated refusals across many ticks page exactly ONCE, reusing the existing
//      in-memory + durable double debounce in mesh-difficulty-floor.ts — not a new one.
//   3. NO REGRESSION: the auto-launch path's own difficulty-floor paging is untouched and
//      does not double-page when both paths observe the same stuck task.

const testTmpDir = path.join(tmpdir(), `adhdev-claim-difficulty-pager-test-${randomUUID().slice(0, 8)}`)
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
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { triggerMeshQueue, DIFFICULTY_FLOOR_REPORT_AFTER_MS } from '../../src/mesh/mesh-queue-assignment.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { resetDifficultyFloorReportsForTests } from '../../src/mesh/mesh-difficulty-floor.js'

const NODE_ID = 'node_difficulty_claim'
const NODE_WS = '/repo/difficulty-claim'

function createComponents(meshId: string) {
  const cliInstance = {
    getState: () => ({
      settings: { meshNodeFor: meshId, providerType: 'claude-cli', meshNodeId: NODE_ID },
      status: 'idle',
      instanceId: 'sess-already-running',
      type: 'claude-cli',
      workspace: NODE_WS,
      controlValues: { model: 'sonnet' },
    }),
    updateSettings: vi.fn(),
  }
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? [cliInstance] : [])),
      getInstance: vi.fn(() => cliInstance),
    },
    cliManager: {
      adapters: new Map([['sess-already-running', { workingDir: NODE_WS }]]),
      handleCliCommand: vi.fn(async () => ({ success: true })),
    },
    providerLoader: {
      resolveAlias: vi.fn((type: string) => type),
      isMachineProviderEnabled: vi.fn(() => true),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string) {
  // The node's ONLY slot is sonnet/medium — a 'difficult' task can never clear this floor
  // for the already-running sonnet session, so the claim funnel refuses it every tick with
  // 'difficulty_floor_unmet' rather than ever assigning it.
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'DIFFICULTY-CLAIM Mesh',
    policy: {},
    nodes: [{
      id: NODE_ID,
      daemonId: 'daemon-local',
      workspace: NODE_WS,
      repoRoot: NODE_WS,
      policy: { slots: [{ provider: 'claude-cli', model: 'sonnet', difficulty: ['easy', 'medium'], maxParallel: 4 }] },
    }],
  })
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  resetDifficultyFloorReportsForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('claim-path difficulty-floor pager (tryAssignQueueTask → handleDifficultyFloorSkip)', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('① TARGET: pages the coordinator after the bounded wait when an already-idle session keeps refusing on the floor gate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    const meshId = `mesh_claim_floor_pager_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents(meshId)
      // TARGET-PIN: pinning to the already-running session is what routes this task
      // EXCLUSIVELY through the claim path. maybeAutoLaunchOneQueueSession skips any
      // task.targetSessionId row unconditionally with 'target_session_constraint'
      // (mesh-queue-assignment.ts ~1946) — it never calls resolveUsableProvider / the
      // difficulty-floor check for a pinned task, so its markAutoLaunch→
      // handleDifficultyFloorSkip pager can never fire here. Only the idle-drain's
      // direct claimNextQueueTask re-entry (tryAssignQueueTask) ever evaluates this
      // task's floor gate — exactly the gap this fix closes.
      const task = enqueueTask(meshId, 'hard work pinned to an already-running sonnet session', {
        targetNodeId: NODE_ID,
        targetSessionId: 'sess-already-running',
        taskMode: 'code_change',
        difficulty: 'difficult',
      })

      // First tick: refused, but not yet past the bounded wait — no page yet.
      const first = await triggerMeshQueue(components, meshId)
      expect(first.claimed).toBe(false)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(0)

      // Advance past the bounded wait and re-tick: the SAME refusal has now persisted long
      // enough that "nobody is coming" — the coordinator must be told.
      vi.advanceTimersByTime(DIFFICULTY_FLOOR_REPORT_AFTER_MS)
      await triggerMeshQueue(components, meshId)

      const events = drainPendingMeshCoordinatorEvents(meshId, 'test-machine') as any[]
      expect(events).toHaveLength(1)
      expect(events[0]?.metadataEvent).toEqual(expect.objectContaining({
        source: 'mesh_queue_difficulty_floor_timeout',
        taskId: task.id,
        reason: 'task_difficulty_floor_timeout',
        difficulty: 'difficult',
      }))
      expect(events[0]?.coordinatorMessage).toContain('explicit task-scoped downgrade')
    } finally {
      cleanup(meshId)
    }
  })

  it('② DEBOUNCE: the same stuck task pages exactly once across many refusal ticks, not once per tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    const meshId = `mesh_claim_floor_debounce_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents(meshId)
      const task = enqueueTask(meshId, 'hard work, many ticks', {
        targetNodeId: NODE_ID,
        targetSessionId: 'sess-already-running',
        taskMode: 'code_change',
        difficulty: 'difficult',
      })

      // Simulate the reconcile loop re-running the claim every ~4s for well past the
      // bounded wait (620s > the 600s/10min report threshold), but staying comfortably
      // under the UNRELATED 15min target-session-pin TTL (mesh-skip-notify.ts) that would
      // otherwise park this session-pinned task and raise its own, different actionable
      // event — this test is isolating the difficulty-floor debounce, not that mechanism.
      for (let i = 0; i < 155; i++) {
        await triggerMeshQueue(components, meshId)
        vi.advanceTimersByTime(4_000)
      }

      // Without the fix's reused debounce, 816 real-world refusals would have become 816
      // notifications. With it reused correctly, this must collapse to exactly one.
      const events = drainPendingMeshCoordinatorEvents(meshId, 'test-machine') as any[]
      expect(events).toHaveLength(1)
      expect(events[0]?.metadataEvent?.taskId).toBe(task.id)

      // Continuing to tick after the page fired must not raise a second one.
      for (let i = 0; i < 30; i++) {
        await triggerMeshQueue(components, meshId)
        vi.advanceTimersByTime(4_000)
      }
      expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('③ NO REGRESSION: the auto-launch path\'s own difficulty-floor paging still fires once and is not duplicated by the claim-path wiring', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'))
    const meshId = `mesh_autolaunch_floor_still_works_${randomUUID().slice(0, 8)}`
    try {
      // No idle session at all — every claim comes through the auto-launch selector, which
      // finds no slot able to clear the 'difficult' floor and skips with its own
      // task_difficulty_floor_wait reason via markAutoLaunch → handleDifficultyFloorSkip.
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId,
        name: 'AUTOLAUNCH-FLOOR Mesh',
        policy: {},
        nodes: [{
          id: NODE_ID,
          daemonId: 'daemon-local',
          workspace: NODE_WS,
          repoRoot: NODE_WS,
          policy: { slots: [{ provider: 'claude-cli', model: 'sonnet', difficulty: ['easy', 'medium'], maxParallel: 4 }] },
        }],
      })
      const components = {
        instanceManager: { getByCategory: vi.fn(() => []), getInstance: vi.fn(() => undefined) },
        cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
        providerLoader: { resolveAlias: vi.fn((t: string) => t), isMachineProviderEnabled: vi.fn(() => true) },
        dispatchMeshCommand: vi.fn(async () => ({ success: true })),
        statusInstanceId: 'daemon-local',
        onStatusChange: vi.fn(),
      } as any
      const task = enqueueTask(meshId, 'hard work, no session at all', {
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        difficulty: 'difficult',
      })

      await triggerMeshQueue(components, meshId)
      vi.advanceTimersByTime(DIFFICULTY_FLOOR_REPORT_AFTER_MS)
      await triggerMeshQueue(components, meshId)

      const events = drainPendingMeshCoordinatorEvents(meshId, 'test-machine') as any[]
      expect(events).toHaveLength(1)
      expect(events[0]?.metadataEvent).toEqual(expect.objectContaining({
        source: 'mesh_queue_difficulty_floor_timeout',
        taskId: task.id,
      }))
    } finally {
      cleanup(meshId)
    }
  })
})
