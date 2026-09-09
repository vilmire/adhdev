import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// AUTOLAUNCH-FLOOR-RUNAWAY (2026-09-08, task 53fc7bff: ~300 launches in 8.8h) — two fixes,
// each pinned by its own case here:
//
// P1 — WINNER-CLOBBER VIA THE FLOOR BRANCH. handleDifficultyFloorSkip wrote `skipped` over an
//   in-window `completed` winner record: markAutoLaunch's floor branch short-circuits BEFORE
//   its autoLaunchWriteWouldClobberWinner guard, and the claim path
//   (handleClaimPathDifficultyFloorRefusal) calls handleDifficultyFloorSkip directly, so BOTH
//   routes bypassed the guard. Overwriting the winner disarmed the 90s await-claim guard
//   (which requires status==='completed') and reset the 10-minute pager clock every tick.
//
// P2 — LAUNCH/CLAIM DIFFICULTY VERDICT ASYMMETRY. The launch side proved only that SOME slot
//   covers the task's difficulty; an explicit task.model then overrode the covering slot's
//   model (resolveLaunchAxis), landing the launch on a slot whose difficulty ceiling is below
//   the task. The claim side judges by the model (allowedClassifiedDifficultiesForSession) and
//   refuses 'difficulty_floor_unmet' forever → spawn→refuse→orphan→respawn loop. The fix
//   re-checks the FINAL (provider, model) with the SAME function before spawning.

const testTmpDir = path.join(tmpdir(), `adhdev-autolaunch-floor-clobber-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
  getMachineNickname: () => ({ machineId: 'test-machine' } as any).machineNickname ?? null,
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

const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn(async () => ({ path: '/usr/local/bin/claude' })) }))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))

import { triggerMeshQueue } from '../../src/mesh/mesh-queue-assignment.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, recordTaskAutoLaunch } from '../../src/mesh/mesh-work-queue.js'
import { handleClaimPathDifficultyFloorRefusal, resetDifficultyFloorReportsForTests } from '../../src/mesh/mesh-difficulty-floor.js'
import { AUTO_LAUNCH_AWAIT_CLAIM_MS } from '../../src/mesh/mesh-autolaunch-integrity.js'

const NODE_ID = 'node_floor_clobber'
const NODE_WS = '/repo/floor-clobber'

// The incident node shape: a slot that covers 'difficult' next to a slot whose model the
// explicit task override selects but whose ceiling stops at 'medium'.
function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'FLOOR-CLOBBER Mesh',
    policy: {},
    nodes: [{
      id: NODE_ID,
      workspace: NODE_WS,
      repoRoot: NODE_WS,
      policy: {
        slots: [
          { provider: 'claude-cli', model: 'fable', difficulty: ['easy', 'medium', 'difficult'], maxParallel: 4 },
          { provider: 'claude-cli', model: 'opus', difficulty: ['easy', 'medium'], maxParallel: 4 },
        ],
      },
    }],
  })
}

function createComponents() {
  const spawned: string[] = []
  const components: any = {
    instanceManager: {
      getByCategory: vi.fn(() => []),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) => {
        if (command !== 'launch_cli') return { success: true }
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

function autoLaunchOf(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)?.autoLaunch
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  resetDifficultyFloorReportsForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('P1 — handleDifficultyFloorSkip must not clobber an in-window completed winner record', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('keeps status=completed when a claim-path floor refusal lands inside the await-claim window', () => {
    const meshId = `mesh_floor_clobber_p1_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = enqueueTask(meshId, 'incident-shaped work', { taskMode: 'code_change', difficulty: 'difficult' })
      // The launch just completed and named its session — the record the 90s await-claim
      // guard and the pager clock both key off. updatedAt is stamped `now` by the store.
      recordTaskAutoLaunch(meshId, task.id, { status: 'completed', sessionId: 'winner-sess', nodeId: NODE_ID })

      // The spawned session's very first claim attempt bounces off the difficulty floor —
      // the exact write that used to flip the winner record to `skipped`.
      handleClaimPathDifficultyFloorRefusal({
        meshId,
        nodeId: NODE_ID,
        refusalReason: 'difficulty_floor_unmet',
        claimRefusal: { taskId: task.id, difficulty: 'difficult' },
      })

      const record = autoLaunchOf(meshId, task.id)
      expect(record?.status).toBe('completed')
      expect(record?.sessionId).toBe('winner-sess')
    } finally {
      cleanup(meshId)
    }
  })

  it('control: past the await-claim window the floor-wait skip lands again (no over-suppression)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T00:00:00.000Z'))
    const meshId = `mesh_floor_clobber_p1_ctrl_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const task = enqueueTask(meshId, 'stale winner', { taskMode: 'code_change', difficulty: 'difficult' })
      recordTaskAutoLaunch(meshId, task.id, { status: 'completed', sessionId: 'stale-sess', nodeId: NODE_ID })
      // Outside the window the launch record is no longer authoritative
      // (driveExpiredAwaitClaim owns it) — normal floor-wait recording must resume.
      vi.advanceTimersByTime(AUTO_LAUNCH_AWAIT_CLAIM_MS + 1_000)

      handleClaimPathDifficultyFloorRefusal({
        meshId,
        nodeId: NODE_ID,
        refusalReason: 'difficulty_floor_unmet',
        claimRefusal: { taskId: task.id, difficulty: 'difficult' },
      })

      const record = autoLaunchOf(meshId, task.id)
      expect(record?.status).toBe('skipped')
      expect(record?.reason).toBe('task_difficulty_floor_unavailable:difficult')
    } finally {
      cleanup(meshId)
    }
  })
})

describe('P2 — launch side re-checks the resolved model against the claim-side difficulty predicate', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('incident repro: explicit model=opus on fable[difficult]+opus[medium] spawns NOTHING and parks on the floor-wait reason', async () => {
    const meshId = `mesh_floor_clobber_p2_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      // difficulty=difficult passes the slot-existence floor gates via the fable slot, then
      // the EXPLICIT model=opus overrides the covering slot's model (resolveLaunchAxis) —
      // before the fix this spawned a session the claim side refused forever.
      const task = enqueueTask(meshId, 'difficult work explicitly pinned to opus', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        model: 'opus',
      })

      const result = await triggerMeshQueue(components, meshId)

      expect(launchCliCalls(components)).toBe(0)
      expect(components.__spawned).toHaveLength(0)
      expect(result.claimed).toBe(false)
      const record = autoLaunchOf(meshId, task.id)
      expect(record?.status).toBe('skipped')
      expect(record?.reason).toBe('task_difficulty_floor_launch_model_mismatch:difficult')
      // Still pending — parked on the difficulty-floor wait clock, not cancelled or assigned.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })

  it('control: an explicit model whose slot covers the difficulty still launches (no over-blocking)', async () => {
    const meshId = `mesh_floor_clobber_p2_ctrl_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      enqueueTask(meshId, 'difficult work on the covering model', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        model: 'fable',
      })

      await triggerMeshQueue(components, meshId)

      expect(launchCliCalls(components)).toBe(1)
      expect(components.__spawned).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })
})
