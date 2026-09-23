import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Phase E — mesh auto-launch launch provenance (harness copied from
// mesh-autolaunch-remote-claim.test.ts).
//
// The auto-launch forwards WHERE the model came from on its launch_cli, so the
// launched session's launch record says `task_override` for an explicit task
// model and `mesh_slot` when the slot supplied it, with `launchedBy: 'mesh'`.
//
// ★PENDING: the forwarding itself is a REQUESTED EDIT in
// src/mesh/mesh-queue-autolaunch.ts (owned by workstream B4 during the
// wiring-unification program). Un-skip these once it is applied.
//
// Original harness notes:
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

const testTmpDir = path.join(tmpdir(), `adhdev-al-launch-record-test-${randomUUID().slice(0, 8)}`)
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
import { withMeshRouter } from './helpers/mesh-router-stub.js'

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
  const components: any = withMeshRouter({
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
  })
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

const pending = it

describe('mesh auto-launch forwards launch provenance to launch_cli (Phase E)', () => {
  afterEach(() => { vi.clearAllMocks() })

  pending('slot-supplied model → modelSource mesh_slot, launchedBy mesh', async () => {
    const meshId = `mesh_al_launch_record_slot_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, { policy: { slots: [
        { provider: 'codex-cli', model: 'gpt-5.3-codex', difficulty: ['difficult'], maxParallel: 2 },
      ] } })
      const components = createComponents()
      enqueueTask(meshId, 'slot model', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'difficult' })

      await triggerMeshQueue(components, meshId)

      const launch = components.dispatchMeshCommand.mock.calls.find((c: unknown[]) => c[1] === 'launch_cli')
      expect(launch?.[2]).toMatchObject({ initialModel: 'gpt-5.3-codex', modelSource: 'mesh_slot', launchedBy: 'mesh' })
    } finally {
      cleanup(meshId)
    }
  })

  pending('explicit task model → modelSource task_override', async () => {
    const meshId = `mesh_al_launch_record_task_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, { policy: { slots: [
        { provider: 'codex-cli', model: 'gpt-5.3-codex', difficulty: ['medium'], maxParallel: 2 },
      ] } })
      const components = createComponents()
      enqueueTask(meshId, 'task model', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium', model: 'gpt-5.3-codex', thinkingLevel: 'high' })

      await triggerMeshQueue(components, meshId)

      const launch = components.dispatchMeshCommand.mock.calls.find((c: unknown[]) => c[1] === 'launch_cli')
      expect(launch?.[2]).toMatchObject({
        initialModel: 'gpt-5.3-codex',
        modelSource: 'task_override',
        initialThinkingLevel: 'high',
        thinkingLevelSource: 'task_override',
        launchedBy: 'mesh',
      })
    } finally {
      cleanup(meshId)
    }
  })

  pending('no model at all → no modelSource claimed (the daemon resolves provider_default itself)', async () => {
    const meshId = `mesh_al_launch_record_none_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents()
      enqueueTask(meshId, 'no model', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'freeform' })

      await triggerMeshQueue(components, meshId)

      const launch = components.dispatchMeshCommand.mock.calls.find((c: unknown[]) => c[1] === 'launch_cli')
      expect(launch?.[2]).toMatchObject({ launchedBy: 'mesh' })
      expect(launch?.[2]).not.toHaveProperty('modelSource')
    } finally {
      cleanup(meshId)
    }
  })
})
