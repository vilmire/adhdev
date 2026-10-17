import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

const testTmpDir = path.join(tmpdir(), `adhdev-autolaunch-guard-review-fixes-test-${randomUUID().slice(0, 8)}`)
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
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

const detectCliMocks = vi.hoisted(() => ({
  detectCLI: vi.fn(async () => ({ path: '/usr/local/bin/claude' })),
}))
vi.mock('../../src/detection/cli-detector.js', () => ({
  detectCLI: detectCliMocks.detectCLI,
}))


import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  enqueueTask,
  getQueueEntryById,
  recordTaskAutoLaunch,
  updateSessionTaskStatus,
} from '../../src/mesh/mesh-work-queue.js'
import { handleDifficultyFloorSkip, resetDifficultyFloorReportsForTests } from '../../src/mesh/mesh-difficulty-floor.js'
import { noteSessionClaimRefusal, __resetSessionClaimRefusalsForTests } from '../../src/mesh/mesh-claim-refusal.js'
import {
  AUTO_LAUNCH_AWAIT_CLAIM_MS,
  autoLaunchAwaitClaimBackoff,
  driveExpiredAwaitClaim,
  isTaskKnownAdmissionBlocked,
  __clearAwaitClaimBackoffForTests,
} from '../../src/mesh/mesh-autolaunch-integrity.js'

// Regressions for the three findings of the independent review of the autolaunch
// admission guard (2026-10-17): a stale owned_paths_conflict stamp or cached refusal
// must not outlive the live admission verdict, and a stale auto-launch record must
// never force a task into an assistant / coordinator / null-spawn session.

// Mirrors the module-private AUTO_LAUNCH_AWAIT_CLAIM_BACKOFF_CAP_CYCLES (2).
const BACKOFF_CAP_CYCLES = 2
const NODE_HOLDER = 'node_holder'
const NODE_WORKER = 'node_worker'

function setup(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'review fixes', policy: { maxParallelTasks: 6 }, nodes: [] })
}

function holdPaths(meshId: string, paths: string[]) {
  const holder = enqueueTask(meshId, 'Holder task', { taskMode: 'code_change', difficulty: 'difficult', ownedPaths: paths })
  MeshRuntimeStore.getInstance().claimNextQueueTask(meshId, NODE_HOLDER, 'sess-holder', [], {
    providerType: 'claude-cli',
    assignedModel: 'claude-opus-4-6',
    allowedTaskDifficulties: ['easy', 'medium', 'difficult'],
  })
  return holder
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __clearAwaitClaimBackoffForTests()
  __resetSessionClaimRefusalsForTests()
  resetDifficultyFloorReportsForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

function components(localSessions: any[] = []) {
  return {
    instanceManager: {
      getByCategory: vi.fn((cat: string) => (cat === 'cli' ? localSessions : [])),
      getInstance: vi.fn(() => undefined),
    },
  } as any
}

describe('autolaunch admission guard — review fixes', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('a historical owned_paths_conflict stamp does not suppress the floor pager once ownership is released', () => {
    const meshId = `mesh_review_floor_${randomUUID().slice(0, 8)}`
    try {
      setup(meshId)
      const task = enqueueTask(meshId, 'Floor-waiting task', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/launch.ts'],
      })
      // Stamp left from an earlier conflict; nothing holds the paths now.
      recordTaskAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'owned_paths_conflict', nodeId: NODE_WORKER })

      handleDifficultyFloorSkip({ meshId, taskId: task.id, nodeId: NODE_WORKER, reason: 'task_difficulty_floor_unavailable:difficult' })

      expect(getQueueEntryById(meshId, task.id)?.autoLaunch?.reason).toBe('task_difficulty_floor_unavailable:difficult')
    } finally {
      cleanup(meshId)
    }
  })

  it('a live owned-paths conflict still suppresses the floor pager', () => {
    const meshId = `mesh_review_floor_live_${randomUUID().slice(0, 8)}`
    try {
      setup(meshId)
      holdPaths(meshId, ['oss/packages/daemon-core/src/commands/**'])
      const task = enqueueTask(meshId, 'Blocked task', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/launch.ts'],
      })
      recordTaskAutoLaunch(meshId, task.id, { status: 'skipped', reason: 'owned_paths_conflict', nodeId: NODE_WORKER })

      handleDifficultyFloorSkip({ meshId, taskId: task.id, nodeId: NODE_WORKER, reason: 'task_difficulty_floor_unavailable:difficult' })

      expect(getQueueEntryById(meshId, task.id)?.autoLaunch?.reason).toBe('owned_paths_conflict')
    } finally {
      cleanup(meshId)
    }
  })

  it('a cached owned_paths_conflict refusal does not delay the re-drive after the blocker releases', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T06:00:00.000Z'))
    const meshId = `mesh_review_refusal_${randomUUID().slice(0, 8)}`
    try {
      setup(meshId)
      const holder = holdPaths(meshId, ['oss/packages/daemon-core/src/commands/**'])
      const task = enqueueTask(meshId, 'Blocked task', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/launch.ts'],
      })
      recordTaskAutoLaunch(meshId, task.id, { status: 'completed', nodeId: NODE_WORKER, providerType: 'claude-cli', sessionId: 'sess-worker' })
      vi.advanceTimersByTime(AUTO_LAUNCH_AWAIT_CLAIM_MS + 1_000)

      const ctx = { sessionId: 'sess-worker', nodeId: NODE_WORKER, providerType: 'claude-cli' }
      let assigned = 0
      expect(driveExpiredAwaitClaim(components(), meshId, getQueueEntryById(meshId, task.id)!, ctx, () => { assigned += 1; return false })).toBe('backoff')

      // The claim funnel cached this session's refusal, as tryAssignQueueTask does.
      noteSessionClaimRefusal(meshId, 'sess-worker', { reason: 'owned_paths_conflict', taskId: task.id })
      updateSessionTaskStatus(meshId, 'sess-holder', 'completed', { taskId: holder.id })

      expect(isTaskKnownAdmissionBlocked(meshId, getQueueEntryById(meshId, task.id)!, 'sess-worker').blocked).toBe(false)
      expect(driveExpiredAwaitClaim(components(), meshId, getQueueEntryById(meshId, task.id)!, ctx, () => { assigned += 1; return true })).toBe('claimed')
      expect(assigned).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('a non-ownership cached refusal (node busy) still holds the task in backoff', () => {
    const meshId = `mesh_review_refusal_busy_${randomUUID().slice(0, 8)}`
    try {
      setup(meshId)
      const task = enqueueTask(meshId, 'Task', { taskMode: 'code_change', difficulty: 'difficult' })
      noteSessionClaimRefusal(meshId, 'sess-worker', { reason: 'node_busy_with_active_assignment' })
      expect(isTaskKnownAdmissionBlocked(meshId, getQueueEntryById(meshId, task.id)!, 'sess-worker')).toMatchObject({
        blocked: true,
        reason: 'node_busy_with_active_assignment',
      })
    } finally {
      cleanup(meshId)
    }
  })

  it.each([
    ['assistant', { role: 'assistant' }],
    ['coordinator', { meshRole: 'coordinator' }],
    ['null-spawn', { spawnedForTaskId: null }],
  ])('never dispatches into a protected %s session, even at the backoff cap', (_label, extraSettings) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T06:00:00.000Z'))
    const meshId = `mesh_review_protected_${randomUUID().slice(0, 8)}`
    try {
      setup(meshId)
      const task = enqueueTask(meshId, 'Task', { taskMode: 'code_change', difficulty: 'difficult' })
      recordTaskAutoLaunch(meshId, task.id, { status: 'completed', nodeId: NODE_WORKER, providerType: 'claude-cli', sessionId: 'sess-protected' })
      autoLaunchAwaitClaimBackoff.set(`${meshId}::${task.id}`, { cycles: BACKOFF_CAP_CYCLES, nextAttemptAtMs: 0 })
      const protectedSession = {
        instanceId: 'sess-protected',
        getState: () => ({ instanceId: 'sess-protected', status: 'idle', settings: { meshNodeFor: meshId, meshNodeId: NODE_WORKER, ...extraSettings } }),
      }
      let assigned = 0
      const outcome = driveExpiredAwaitClaim(
        components([protectedSession]),
        meshId,
        getQueueEntryById(meshId, task.id)!,
        { sessionId: 'sess-protected', nodeId: NODE_WORKER, providerType: 'claude-cli' },
        () => { assigned += 1; return true },
      )
      expect(outcome).toBe('respawn')
      expect(assigned).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })
})
