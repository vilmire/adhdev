import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

const testTmpDir = path.join(tmpdir(), `adhdev-autolaunch-admission-guard-test-${randomUUID().slice(0, 8)}`)
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

import { LOG } from '../../src/logging/logger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { evaluateTaskOwnedPathsAdmission } from '../../src/mesh/mesh-runtime-store-claim.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  enqueueTask,
  getQueueEntryById,
  recordTaskAutoLaunch,
  updateSessionTaskStatus,
} from '../../src/mesh/mesh-work-queue.js'
import {
  handleClaimPathDifficultyFloorRefusal,
  handleDifficultyFloorSkip,
  resetDifficultyFloorReportsForTests,
} from '../../src/mesh/mesh-difficulty-floor.js'
import { logAutoLaunchQuotaFallbackSuccess } from '../../src/mesh/mesh-queue-observability.js'
import {
  AUTO_LAUNCH_AWAIT_CLAIM_MS,
  autoLaunchAwaitClaimBackoff,
  driveExpiredAwaitClaim,
  isProtectedNonAutoLaunchSession,
  sweepAutoLaunchOrphanSessions,
  __clearAwaitClaimBackoffForTests,
  __resetAutoLaunchOrphanNotifiedForTests,
  __seedAutoLaunchOrphanFirstSeenForTests,
} from '../../src/mesh/mesh-autolaunch-integrity.js'
import {
  maybeAutoLaunchOneQueueSession,
  __resetAutoLaunchAwaitClaimBackoffForTests,
} from '../../src/mesh/mesh-queue-autolaunch.js'
import { triggerMeshQueue } from '../../src/mesh/mesh-queue-assignment.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'

const NODE_HOLDER = 'node_holder'
const NODE_WORKER = 'node_worker'
const NODE_WS = '/repo/autolaunch-admission-guard'

function createMesh(meshId: string, overrides: Record<string, any> = {}) {
  const mesh = {
    id: meshId,
    name: 'Autolaunch Admission Guard Mesh',
    policy: { maxParallelTasks: 6, ...(overrides.policy || {}) },
    nodes: overrides.nodes ?? [
      {
        id: NODE_WORKER,
        name: NODE_WORKER,
        workspace: NODE_WS,
        repoRoot: NODE_WS,
        isLocal: true,
        status: 'online',
        health: 'online',
        launchReady: true,
        policy: {
          maxConcurrentSessions: 4,
          slots: [
            {
              provider: 'claude-cli',
              model: 'claude-opus-4-6',
              difficulty: ['easy', 'medium', 'difficult'],
              maxParallel: 3,
            },
          ],
        },
      },
    ],
  }
  meshConfigMocks.getMesh.mockReturnValue(mesh)
  return mesh
}

function createComponents(mesh: any, opts: { localSessions?: any[] } = {}) {
  const launchCalls: any[] = []
  const components: any = withMeshRouter({
    instanceManager: {
      getByCategory: vi.fn((cat: string) => (cat === 'cli' ? (opts.localSessions ?? []) : [])),
      getInstance: vi.fn((id: string) =>
        (opts.localSessions ?? []).find((inst: any) => {
          try {
            return inst.getState()?.instanceId === id
          } catch {
            return false
          }
        }),
      ),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string, args: any) => {
        if (command === 'launch_cli') {
          launchCalls.push(args)
          return { success: true, sessionId: `spawned-${launchCalls.length}` }
        }
        return { success: true }
      }),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
      getMeta: vi.fn(() => ({ id: 'claude-cli', supportsAutoApprove: true })),
    },
    router: {
      getCachedInlineMesh: () => mesh,
    },
    dispatchMeshCommand: vi.fn(async (_daemonId: string, command: string, args: any) => {
      if (command === 'launch_cli') {
        launchCalls.push(args)
        const sessionId = `remote-spawned-${launchCalls.length}`
        MeshRuntimeStore.getInstance().setRemoteIdleSession(
          mesh.id,
          args?.settings?.meshNodeId || NODE_WORKER,
          sessionId,
          args?.cliType || 'codex-cli',
          Date.now() + 60_000,
        )
        return { success: true, sessionId }
      }
      return { success: true }
    }),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  })
  components.__launchCalls = launchCalls
  return components
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __clearAwaitClaimBackoffForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  __resetAutoLaunchOrphanNotifiedForTests()
  resetDifficultyFloorReportsForTests()
  meshConfigMocks.getMesh.mockReset()
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

describe('Autolaunch Admission Guard — 7 durable invariants', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('1. pre-spawn owned_paths_conflict admission shares claim evaluator and blocks launch_cli until holder completes', async () => {
    const meshId = `mesh_guard_prespawn_${randomUUID().slice(0, 8)}`
    try {
      const mesh = createMesh(meshId)
      const components = createComponents(mesh)
      const store = MeshRuntimeStore.getInstance()

      const holderTask = enqueueTask(meshId, 'Active holder owning commands/**', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/**'],
      })
      const claimedHolder = store.claimNextQueueTask(meshId, NODE_HOLDER, 'sess-holder', [], {
        providerType: 'claude-cli',
        assignedModel: 'claude-opus-4-6',
        allowedTaskDifficulties: ['easy', 'medium', 'difficult'],
      })
      expect(claimedHolder?.id).toBe(holderTask.id)

      const blockedTask = enqueueTask(meshId, 'Overlapping pending task', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/launch.ts'],
      })

      const admission = evaluateTaskOwnedPathsAdmission(store, meshId, blockedTask)
      expect(admission.allowed).toBe(false)
      expect(admission.detail).toContain(holderTask.id)

      const launchedWhileBlocked = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(launchedWhileBlocked).toBe(false)
      expect(components.__launchCalls).toHaveLength(0)

      const afterSkip = getQueueEntryById(meshId, blockedTask.id)
      expect(afterSkip?.status).toBe('pending')
      expect(afterSkip?.autoLaunch?.status).toBe('skipped')
      expect(afterSkip?.autoLaunch?.reason).toBe('owned_paths_conflict')

      // Release the holder task -> next auto-launch pass admits and spawns exactly once.
      updateSessionTaskStatus(meshId, 'sess-holder', 'completed', { taskId: holderTask.id })
      expect(evaluateTaskOwnedPathsAdmission(store, meshId, blockedTask).allowed).toBe(true)

      const launchedAfterRelease = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(launchedAfterRelease).toBe(true)
      expect(components.__launchCalls).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('2. unknown-model session claim cannot mask owned_paths_conflict or clobber durable path reason', () => {
    const meshId = `mesh_guard_unknown_model_${randomUUID().slice(0, 8)}`
    try {
      createMesh(meshId)
      const store = MeshRuntimeStore.getInstance()

      const holderTask = enqueueTask(meshId, 'Holder task', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/**'],
      })
      store.claimNextQueueTask(meshId, NODE_HOLDER, 'sess-holder', [], {
        providerType: 'claude-cli',
        assignedModel: 'claude-opus-4-6',
        allowedTaskDifficulties: ['easy', 'medium', 'difficult'],
      })

      const blockedTask = enqueueTask(meshId, 'Blocked difficult task', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/launch.ts'],
      })
      recordTaskAutoLaunch(meshId, blockedTask.id, {
        status: 'skipped',
        reason: 'owned_paths_conflict',
        nodeId: NODE_WORKER,
      })

      const outRefusal: any = {}
      const claimed = store.claimNextQueueTask(meshId, NODE_WORKER, 'sess-unknown-model', [], {
        providerType: 'antigravity-cli',
        // assignedModel intentionally omitted (unknown model at early boot)
        allowedTaskDifficulties: ['easy'],
        outRefusal,
      })
      expect(claimed).toBeNull()
      expect(outRefusal.reason).toBe('owned_paths_conflict')
      expect(outRefusal.taskId).toBe(blockedTask.id)

      handleClaimPathDifficultyFloorRefusal({
        meshId,
        nodeId: NODE_WORKER,
        refusalReason: 'difficulty_floor_unmet',
        claimRefusal: { reason: 'difficulty_floor_unmet', taskId: blockedTask.id, difficulty: 'difficult' },
      })
      expect(getQueueEntryById(meshId, blockedTask.id)?.autoLaunch?.reason).toBe('owned_paths_conflict')

      handleDifficultyFloorSkip({
        meshId,
        taskId: blockedTask.id,
        reason: 'task_difficulty_floor_unavailable:difficult',
        nodeId: NODE_WORKER,
      })
      expect(getQueueEntryById(meshId, blockedTask.id)?.autoLaunch?.reason).toBe('owned_paths_conflict')
    } finally {
      cleanup(meshId)
    }
  })

  it('3. 90s await-claim expiry across two consecutive expiry cycles never respawns while admission-blocked and re-drives immediately when blocker releases', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T06:00:00.000Z'))
    const meshId = `mesh_guard_expiry_blocked_${randomUUID().slice(0, 8)}`
    try {
      const mesh = createMesh(meshId)
      const components = createComponents(mesh)
      const store = MeshRuntimeStore.getInstance()

      const holderTask = enqueueTask(meshId, 'Holder task', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/**'],
      })
      store.claimNextQueueTask(meshId, NODE_HOLDER, 'sess-holder', [], {
        providerType: 'claude-cli',
        assignedModel: 'claude-opus-4-6',
        allowedTaskDifficulties: ['easy', 'medium', 'difficult'],
      })

      const blockedTask = enqueueTask(meshId, 'Blocked task with existing worker', {
        taskMode: 'code_change',
        difficulty: 'difficult',
        ownedPaths: ['oss/packages/daemon-core/src/commands/launch.ts'],
      })
      recordTaskAutoLaunch(meshId, blockedTask.id, {
        status: 'completed',
        nodeId: NODE_WORKER,
        providerType: 'claude-cli',
        sessionId: 'sess-existing-worker',
      })

      // Expiry cycle #1: advance past the initial 90s await-claim window.
      vi.advanceTimersByTime(AUTO_LAUNCH_AWAIT_CLAIM_MS + 1_000)
      let assignCalls = 0
      const cycle1 = driveExpiredAwaitClaim(
        components,
        meshId,
        getQueueEntryById(meshId, blockedTask.id)!,
        { sessionId: 'sess-existing-worker', nodeId: NODE_WORKER, providerType: 'claude-cli' },
        () => {
          assignCalls += 1
          return false
        },
      )
      expect(cycle1).toBe('backoff')
      expect(assignCalls).toBe(0)
      expect(autoLaunchAwaitClaimBackoff.get(`${meshId}::${blockedTask.id}`)?.admissionBlocked).toBe(true)

      const autoLaunchCycle1 = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(autoLaunchCycle1).toBe(false)
      expect(components.__launchCalls).toHaveLength(0)

      // Expiry cycle #2 (consecutive): advance past the extended backoff window (another 95s, >185s total).
      vi.advanceTimersByTime(AUTO_LAUNCH_AWAIT_CLAIM_MS + 5_000)
      const cycle2 = driveExpiredAwaitClaim(
        components,
        meshId,
        getQueueEntryById(meshId, blockedTask.id)!,
        { sessionId: 'sess-existing-worker', nodeId: NODE_WORKER, providerType: 'claude-cli' },
        () => {
          assignCalls += 1
          return false
        },
      )
      expect(cycle2).toBe('backoff')
      expect(assignCalls).toBe(0)

      const autoLaunchCycle2 = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(autoLaunchCycle2).toBe(false)
      expect(components.__launchCalls).toHaveLength(0)
      expect(getQueueEntryById(meshId, blockedTask.id)?.autoLaunch?.sessionId).toBe('sess-existing-worker')

      // Release the admission blocker without advancing the clock: driveExpiredAwaitClaim must
      // immediately re-drive and claim into sess-existing-worker without waiting out nextAttemptAtMs.
      updateSessionTaskStatus(meshId, 'sess-holder', 'completed', { taskId: holderTask.id })
      const afterRelease = driveExpiredAwaitClaim(
        components,
        meshId,
        getQueueEntryById(meshId, blockedTask.id)!,
        { sessionId: 'sess-existing-worker', nodeId: NODE_WORKER, providerType: 'claude-cli' },
        () => {
          assignCalls += 1
          return true
        },
      )
      expect(afterRelease).toBe('claimed')
      expect(assignCalls).toBe(1)
      expect(autoLaunchAwaitClaimBackoff.has(`${meshId}::${blockedTask.id}`)).toBe(false)
      expect(components.__launchCalls).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('4. live healthy idle local worker does not spawn a duplicate empty process across two consecutive 90s+ expiry cycles', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T06:00:00.000Z'))
    const meshId = `mesh_guard_local_live_${randomUUID().slice(0, 8)}`
    try {
      const mesh = createMesh(meshId)
      const localWorker = {
        getState: () => ({
          instanceId: 'sess-local-healthy',
          status: 'idle',
          settings: {
            meshNodeFor: meshId,
            meshNodeId: NODE_WORKER,
            autoLaunchedForQueueTaskId: 'pending-local-task',
          },
        }),
      }
      const components = createComponents(mesh, { localSessions: [localWorker] })
      const task = enqueueTask(meshId, 'Task with live local idle worker', {
        taskMode: 'code_change',
        difficulty: 'medium',
      })
      recordTaskAutoLaunch(meshId, task.id, {
        status: 'completed',
        nodeId: NODE_WORKER,
        providerType: 'claude-cli',
        sessionId: 'sess-local-healthy',
      })

      // Expiry cycle #1 (past 90s): assignQueueTask returns false (e.g. transient deferral),
      // but local worker is still live in instanceManager -> must back off, never respawn.
      vi.advanceTimersByTime(AUTO_LAUNCH_AWAIT_CLAIM_MS + 1_000)
      const outcome1 = driveExpiredAwaitClaim(
        components,
        meshId,
        getQueueEntryById(meshId, task.id)!,
        { sessionId: 'sess-local-healthy', nodeId: NODE_WORKER, providerType: 'claude-cli' },
        () => false,
      )
      expect(outcome1).toBe('backoff')

      // Expiry cycle #2 (past another 180s at cap): still live in instanceManager -> must back off, never respawn.
      vi.advanceTimersByTime(AUTO_LAUNCH_AWAIT_CLAIM_MS * 2 + 5_000)
      const outcome2 = driveExpiredAwaitClaim(
        components,
        meshId,
        getQueueEntryById(meshId, task.id)!,
        { sessionId: 'sess-local-healthy', nodeId: NODE_WORKER, providerType: 'claude-cli' },
        () => false,
      )
      expect(outcome2).toBe('backoff')

      const launched = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(launched).toBe(false)
      expect(components.__launchCalls).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('5. post-fallback and post-compat provider/model must satisfy difficulty floor and slot coverage', async () => {
    const meshId = `mesh_guard_post_fallback_floor_${randomUUID().slice(0, 8)}`
    try {
      const fallbackNode = {
        id: NODE_WORKER,
        name: NODE_WORKER,
        workspace: '/home/peer/repo',
        repoRoot: '/home/peer/repo',
        isLocalWorktree: true,
        status: 'online',
        health: 'online',
        launchReady: true,
        daemonId: 'daemon_mach_remotepeer',
        machineId: 'mach_remotepeer',
        policy: {
          maxConcurrentSessions: 5,
          slots: [
            // Candidate #1 (primary winner): antigravity-cli has a model-less [difficult] slot + a [easy] slot,
            // so launching with model=undefined fails the unknown-model difficulty intersection ([easy]).
            { provider: 'antigravity-cli', difficulty: ['difficult'], maxParallel: 2 },
            { provider: 'antigravity-cli', model: 'gemini-3-flash', difficulty: ['easy'], maxParallel: 2 },
            // Candidate #2: codex-cli with explicit model gpt-5-codex covering [difficult].
            { provider: 'codex-cli', model: 'gpt-5-codex', difficulty: ['difficult'], maxParallel: 2 },
          ],
        },
      }
      const mesh = createMesh(meshId, {
        nodes: [fallbackNode],
        policy: {
          maxParallelTasks: 5,
          quotaRouting: { enabled: true, quotaBusyFallback: true },
        },
      })
      const components = createComponents(mesh)

      enqueueTask(meshId, 'Difficult task requiring floor-valid fallback', {
        targetNodeId: NODE_WORKER,
        taskMode: 'code_change',
        difficulty: 'difficult',
      })

      const launched = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(launched).toBe(true)
      expect(components.__launchCalls).toHaveLength(1)
      expect(components.__launchCalls[0].cliType).toBe('codex-cli')
      expect(components.__launchCalls[0].initialModel).toBe('gpt-5-codex')
      expect(components.__launchCalls[0].settings?.initialModel).toBe('gpt-5-codex')

      // Control: when every candidate fails the post-compat difficulty floor (including when
      // isModelCompatibleWithProvider strips a foreign model to undefined), nothing is spawned.
      __clearMeshQueueForTests(meshId)
      __resetAutoLaunchAwaitClaimBackoffForTests()
      components.__launchCalls.length = 0
      fallbackNode.policy.slots = [
        // Foreign model 'claude-opus-4-6' on codex-cli is stripped by isModelCompatibleWithProvider -> undefined,
        // which then intersects with the [easy] codex-cli slot below -> ['easy'] -> fails difficult floor.
        { provider: 'codex-cli', model: 'claude-opus-4-6', difficulty: ['difficult'], maxParallel: 2 },
        { provider: 'codex-cli', model: 'gpt-5-codex', difficulty: ['easy'], maxParallel: 2 },
      ]
      const unlaunchableTask = enqueueTask(meshId, 'Difficult task with only post-compat floor-invalid slots', {
        targetNodeId: NODE_WORKER,
        taskMode: 'code_change',
        difficulty: 'difficult',
      })
      const unlaunchableResult = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(unlaunchableResult).toBe(false)
      expect(components.__launchCalls).toHaveLength(0)
      expect(getQueueEntryById(meshId, unlaunchableTask.id)?.autoLaunch?.status).toBe('skipped')
      expect(getQueueEntryById(meshId, unlaunchableTask.id)?.autoLaunch?.reason).toBe(
        'task_difficulty_floor_launch_model_mismatch:difficult',
      )
    } finally {
      cleanup(meshId)
    }
  })

  it('6. logAutoLaunchQuotaFallbackSuccess logs effectiveProviderType in both direct call and live launch flow', async () => {
    const meshId = `mesh_guard_quota_log_${randomUUID().slice(0, 8)}`
    const infoSpy = vi.spyOn(LOG, 'info').mockImplementation(() => {})
    try {
      logAutoLaunchQuotaFallbackSuccess(
        {
          providerType: 'claude-cli',
          quotaGated: [
            {
              providerType: 'antigravity-cli',
              block: { reason: 'below_threshold', remainingPercent: 4, thresholdPercent: 10, window: '5h' },
            },
          ],
        },
        'task-log-test',
        NODE_WORKER,
        'sess-codex-fallback',
        'codex-cli',
      )
      expect(infoSpy.mock.calls.some(c => String(c[1]).includes("spawned provider 'codex-cli'"))).toBe(true)

      infoSpy.mockClear()
      const quota = (provider: string, usedPercent: number) => ({
        provider,
        status: 'ok',
        updatedAt: Date.now(),
        error: null,
        weekly: { usedPercent, windowMinutes: 10080, resetsAt: Date.now() + 86400000 },
        session: { usedPercent, windowMinutes: 300, resetsAt: Date.now() + 3600000 },
      })
      const node = {
        id: NODE_WORKER,
        name: NODE_WORKER,
        workspace: '/home/peer/repo',
        repoRoot: '/home/peer/repo',
        isLocalWorktree: true,
        status: 'online',
        health: 'online',
        launchReady: true,
        daemonId: 'daemon_mach_remotepeer',
        machineId: 'mach_remotepeer',
        nodeFacts: {
          schemaVersion: 1,
          reportedAt: Date.now(),
          quota: {
            'claude-cli': quota('claude-cli', 98),
            'antigravity-cli': quota('antigravity-cli', 10),
            'codex-cli': quota('codex-cli', 20),
          },
        },
        policy: {
          maxConcurrentSessions: 5,
          slots: [
            // Quota-gated (98% used -> 2% remaining < 5% default threshold)
            { provider: 'claude-cli', model: 'claude-opus-4-6', difficulty: ['difficult'], maxParallel: 2 },
            // Primary quota-clear winner, but fails post-compat floor because model is undefined alongside an [easy] slot
            { provider: 'antigravity-cli', difficulty: ['difficult'], maxParallel: 2 },
            { provider: 'antigravity-cli', model: 'gemini-3-flash', difficulty: ['easy'], maxParallel: 2 },
            // Fallback winner
            { provider: 'codex-cli', model: 'gpt-5-codex', difficulty: ['difficult'], maxParallel: 2 },
          ],
        },
      }
      const mesh = createMesh(meshId, {
        nodes: [node],
        policy: {
          maxParallelTasks: 5,
          quotaRouting: { enabled: true, quotaBusyFallback: true, minRemainingPercent: 10 },
        },
      })
      const components = createComponents(mesh)
      enqueueTask(meshId, 'Quota-gated + floor-fallback task', {
        targetNodeId: NODE_WORKER,
        taskMode: 'code_change',
        difficulty: 'difficult',
      })

      const launched = await maybeAutoLaunchOneQueueSession(components, meshId, mesh)
      expect(launched).toBe(true)
      expect(
        infoSpy.mock.calls.some(
          c =>
            String(c[1]).includes('QUOTA GATE: auto-launch fallback succeeded') &&
            String(c[1]).includes("spawned provider 'codex-cli'"),
        ),
      ).toBe(true)
    } finally {
      infoSpy.mockRestore()
      cleanup(meshId)
    }
  })

  it('7. assistant, coordinator, and spawnedForTaskId === null sessions are protected from orphan sweep', () => {
    const meshId = `mesh_guard_protected_sessions_${randomUUID().slice(0, 8)}`
    try {
      createMesh(meshId)
      expect(
        isProtectedNonAutoLaunchSession({
          instanceId: 'sess-null-spawned',
          settings: { spawnedForTaskId: null, meshNodeFor: meshId, autoLaunchedForQueueTaskId: 'gone-task' },
        }),
      ).toBe(true)
      expect(
        isProtectedNonAutoLaunchSession({
          instanceId: 'sess-assistant',
          settings: { role: 'assistant', meshNodeFor: meshId, autoLaunchedForQueueTaskId: 'gone-task' },
        }),
      ).toBe(true)
      expect(
        isProtectedNonAutoLaunchSession({
          instanceId: 'sess-coordinator',
          settings: { meshRole: 'coordinator', meshNodeFor: meshId, autoLaunchedForQueueTaskId: 'gone-task' },
        }),
      ).toBe(true)

      const pastGrace = Date.now() - 120_000
      __seedAutoLaunchOrphanFirstSeenForTests(meshId, 'sess-null-spawned', pastGrace)
      __seedAutoLaunchOrphanFirstSeenForTests(meshId, 'sess-assistant', pastGrace)
      __seedAutoLaunchOrphanFirstSeenForTests(meshId, 'sess-coordinator', pastGrace)
      __seedAutoLaunchOrphanFirstSeenForTests(meshId, 'sess-genuine-orphan', pastGrace)

      const warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => {})
      try {
        sweepAutoLaunchOrphanSessions(
          {
            instanceManager: {
              getByCategory: () => [
                {
                  getState: () => ({
                    instanceId: 'sess-null-spawned',
                    status: 'idle',
                    settings: {
                      meshNodeFor: meshId,
                      meshNodeId: NODE_WORKER,
                      spawnedForTaskId: null,
                      autoLaunchedForQueueTaskId: 'gone-task',
                    },
                  }),
                },
                {
                  getState: () => ({
                    instanceId: 'sess-assistant',
                    status: 'idle',
                    settings: {
                      meshNodeFor: meshId,
                      meshNodeId: NODE_WORKER,
                      role: 'assistant',
                      autoLaunchedForQueueTaskId: 'gone-task',
                    },
                  }),
                },
                {
                  getState: () => ({
                    instanceId: 'sess-coordinator',
                    status: 'idle',
                    settings: {
                      meshNodeFor: meshId,
                      meshNodeId: NODE_WORKER,
                      meshRole: 'coordinator',
                      autoLaunchedForQueueTaskId: 'gone-task',
                    },
                  }),
                },
                {
                  getState: () => ({
                    instanceId: 'sess-genuine-orphan',
                    status: 'idle',
                    settings: {
                      meshNodeFor: meshId,
                      meshNodeId: NODE_WORKER,
                      spawnedForTaskId: 'gone-task',
                      autoLaunchedForQueueTaskId: 'gone-task',
                    },
                  }),
                },
              ],
            },
          } as any,
          meshId,
        )

        const orphanWarnings = warnSpy.mock.calls.map(c => String(c[1]))
        expect(orphanWarnings.some(msg => msg.includes('sess-null-spawned'))).toBe(false)
        expect(orphanWarnings.some(msg => msg.includes('sess-assistant'))).toBe(false)
        expect(orphanWarnings.some(msg => msg.includes('sess-coordinator'))).toBe(false)
        expect(orphanWarnings.some(msg => msg.includes('sess-genuine-orphan'))).toBe(true)
      } finally {
        warnSpy.mockRestore()
      }
    } finally {
      cleanup(meshId)
    }
  })
})
