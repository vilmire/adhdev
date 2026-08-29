import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// AUTOLAUNCH-REMOTE-CLAIM (M-MESH-INFRA-0829 defect 5-c).
//
// The LOCAL auto-launch path waits for readiness then calls tryAssignQueueTask. The REMOTE
// path waited the same 15s for agent:ready and then returned WITHOUT claiming, hoping the
// event handler would fire. Live (rc.43): antigravity-cli session e55126a4 launched, never
// emitted agent:ready, task 51c79da2 stayed pending, TUI showed banner + empty prompt.
//
// These cases pin:
//   (a) THE REGRESSION — remote launch + ready-wait timeout still claims through the real
//       auto-launch path (not by planting an idle session for the drain to pick up).
//   (b) expires_at on the registered idle row is in the future so getRemoteIdleSessions
//       cannot drop it (5-b expiry-filter reverse-effect).
//   (c) fail-closed — generating_started observed ⇒ no inject, no idle registration.
//   (d) overcorrection — a truly-generating skip does not launch a second session.

const testTmpDir = path.join(tmpdir(), `adhdev-al-remote-claim-test-${randomUUID().slice(0, 8)}`)
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
const readyWaitMocks = vi.hoisted(() => ({
  waitForRemoteSessionReady: vi.fn(async () => false),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))
vi.mock('../../src/mesh/mesh-remote-ready-wait.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mesh/mesh-remote-ready-wait.js')>()
  return {
    ...actual,
    waitForRemoteSessionReady: (...args: unknown[]) => readyWaitMocks.waitForRemoteSessionReady(...args),
  }
})

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import {
  claimAfterRemoteAutoLaunch,
  markRemoteSessionGenerating,
  __resetRemoteGeneratingMarksForTests,
  __clearAwaitClaimBackoffForTests,
  AUTO_LAUNCH_REMOTE_IDLE_TTL_MS,
} from '../../src/mesh/mesh-autolaunch-integrity.js'

const NODE_ID = 'node_de3c0072b6404341bc5512a77c358421'
const REMOTE_SESSION_ID = 'e55126a4-4347-45a0-99d4-1bf6d7e3563c'

function setMesh(meshId: string, extra: Record<string, unknown> = {}) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Remote Autolaunch Claim Mesh',
    policy: {},
    nodes: [{
      id: NODE_ID,
      daemonId: 'daemon_mach_remotepeer',
      machineId: 'mach_remotepeer',
      workspace: '/home/peer/.adhdev-preview/worktrees/adhdev-cloud-mesh/verify-remote-enqueue-rc43',
      repoRoot: '/home/peer/.adhdev-preview/worktrees/adhdev-cloud-mesh/verify-remote-enqueue-rc43',
      isLocalWorktree: true,
      policy: { providerPriority: ['codex-cli'] },
      ...extra,
    }],
  })
}

function createComponents() {
  const components: any = {
    instanceManager: {
      // Remote shape: this daemon cannot see the launched session in instanceManager.
      // That is the live topology, not a drain-bypass — do NOT plant a local idle
      // session here (that would let triggerMeshQueue's local drain claim the task
      // and the auto-launch path would never run).
      getByCategory: vi.fn((category: string) => (category === 'cli' ? [] : [])),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async () => ({ success: true })),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
      getMeta: vi.fn(() => undefined),
    },
    dispatchMeshCommand: vi.fn(async (_daemonId: string, command: string) => {
      if (command === 'launch_cli') return { success: true, sessionId: REMOTE_SESSION_ID }
      return { success: true }
    }),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  }
  return components
}

function taskRow(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __clearAwaitClaimBackoffForTests()
  __resetRemoteGeneratingMarksForTests()
  readyWaitMocks.waitForRemoteSessionReady.mockReset()
  readyWaitMocks.waitForRemoteSessionReady.mockImplementation(async () => false)
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('AUTOLAUNCH-REMOTE-CLAIM — remote auto-launch claims after the ready wait', () => {
  afterEach(() => { vi.clearAllMocks() })

  // ── INJECTION TEST ────────────────────────────────────────────────────────
  // Revert claimAfterRemoteAutoLaunch at the remote-launch return (leave the wait, still
  // `return true`) and this goes RED: launch_cli ran, wait timed out, task stays pending,
  // remote_idle_sessions is empty. Planting a remote-idle row up front would let the drain
  // claim it and the case would pass with the fix reverted — that is the bypass this
  // fixture exists to refuse.
  it('(a) remote launch whose agent:ready never arrives still claims the launched session', async () => {
    const meshId = `mesh_al_remote_claim_a_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      const task = enqueueTask(meshId, 'inject into the auto-launched remote session', {
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        difficulty: 'medium',
      })

      await triggerMeshQueue(components, meshId)

      const launchCalls = components.dispatchMeshCommand.mock.calls.filter((c: unknown[]) => c[1] === 'launch_cli')
      expect(launchCalls).toHaveLength(1)
      expect(readyWaitMocks.waitForRemoteSessionReady).toHaveBeenCalled()
      expect(readyWaitMocks.waitForRemoteSessionReady.mock.calls[0][2]).toBe(REMOTE_SESSION_ID)

      const row = taskRow(meshId, task.id)
      expect(row?.autoLaunch?.status).toBe('completed')
      expect(row?.autoLaunch?.sessionId).toBe(REMOTE_SESSION_ID)
      expect(row?.status).toBe('assigned')
      expect(row?.assignedSessionId).toBe(REMOTE_SESSION_ID)
      expect(row?.assignedNodeId).toBe(NODE_ID)
    } finally {
      cleanup(meshId)
    }
  })

  it('(b) a refused claim still registers the session with a future expiresAt (expiry filter cannot drop it)', () => {
    const meshId = `mesh_al_remote_claim_b_${randomUUID().slice(0, 8)}`
    const assign = vi.fn(() => false)
    const before = Date.now()
    const result = claimAfterRemoteAutoLaunch(
      {} as any,
      meshId,
      NODE_ID,
      REMOTE_SESSION_ID,
      'antigravity-cli',
      assign,
    )
    expect(result).toBe('registered')
    expect(assign).toHaveBeenCalledTimes(1)
    const rows = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
    expect(rows).toHaveLength(1)
    expect(rows[0].sessionId).toBe(REMOTE_SESSION_ID)
    expect(rows[0].expiresAt).toBeGreaterThan(before)
    expect(rows[0].expiresAt).toBeGreaterThanOrEqual(before + AUTO_LAUNCH_REMOTE_IDLE_TTL_MS - 50)
    cleanup(meshId)
  })

  it('(c) fail-closed: generating_started observed → no claim and no idle registration', () => {
    const meshId = `mesh_al_remote_claim_c_${randomUUID().slice(0, 8)}`
    markRemoteSessionGenerating(meshId, REMOTE_SESSION_ID)
    const assign = vi.fn(() => true)
    const result = claimAfterRemoteAutoLaunch(
      {} as any,
      meshId,
      NODE_ID,
      REMOTE_SESSION_ID,
      'antigravity-cli',
      assign,
    )
    expect(result).toBe('skipped_generating')
    expect(assign).not.toHaveBeenCalled()
    expect(MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)).toEqual([])
    cleanup(meshId)
  })

  it('(d) overcorrection: a generating skip on the post-launch claim does not respawn', async () => {
    const meshId = `mesh_al_remote_claim_d_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      markRemoteSessionGenerating(meshId, REMOTE_SESSION_ID)
      const task = enqueueTask(meshId, 'do not double-launch a generating worker', {
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        difficulty: 'medium',
      })

      await triggerMeshQueue(components, meshId)

      expect(components.dispatchMeshCommand.mock.calls.filter((c: unknown[]) => c[1] === 'launch_cli')).toHaveLength(1)
      expect(taskRow(meshId, task.id)?.status).toBe('pending')
      expect(taskRow(meshId, task.id)?.autoLaunch?.status).toBe('completed')
      expect(MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)).toEqual([])
    } finally {
      cleanup(meshId)
    }
  })

  it('no session id → no_session and assign is never called', () => {
    const assign = vi.fn(() => true)
    expect(claimAfterRemoteAutoLaunch({} as any, 'mesh_x', NODE_ID, undefined, 'codex-cli', assign)).toBe('no_session')
    expect(assign).not.toHaveBeenCalled()
  })
})
