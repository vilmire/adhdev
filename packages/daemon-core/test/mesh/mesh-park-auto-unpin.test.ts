import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// PARK-AUTO-UNPIN (owner 2026-11-09): a pin-derived park nobody resolved within
// PARK_AUTO_UNPIN_MS is unpinned and returned to the claimable pool.

const testTmpDir = path.join(tmpdir(), `adhdev-park-auto-unpin-test-${randomUUID().slice(0, 8)}`)
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
  getQueue,
} from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import {
  __resetTargetPinGeneratingCreditForTests,
} from '../../src/mesh/mesh-skip-notify.js'
import {
  PARK_REASON_PIN_EXPIRED,
  PARK_AUTO_UNPIN_MS,
  PARK_AUTO_UNPIN_REASON,
  taskIsParked,
} from '../../src/mesh/mesh-task-parking.js'
import { drainPendingMeshCoordinatorEvents } from '../helpers/pending-notices.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'

const NODE_ID = 'node_main'
const REMOTE_NODE_ID = 'node_remote'
const COORDINATOR_DAEMON_ID = 'test-machine'

function liveSession(meshId: string, sessionId: string, status: string, nodeId: string = NODE_ID) {
  const state = {
    instanceId: sessionId,
    status,
    workspace: `/repo/${nodeId}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: nodeId },
  }
  return { category: 'cli', getState: () => state }
}

function createComponents(cliInstances: any[] = []) {
  return withMeshRouter({
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
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
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any)
}

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Pin Parking Mesh',
    policy: {},
    nodes: [
      { id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } },
      { id: REMOTE_NODE_ID, workspace: `/repo/${REMOTE_NODE_ID}`, daemonId: 'remote-daemon', policy: { providerPriority: ['codex-cli'] } },
    ],
  })
}

function task(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

/** Insert a pending row directly so createdAt (the TTL anchor) is controllable. */
function insertPendingTask(
  meshId: string,
  opts: { targetNodeId?: string; targetSessionId?: string; ageMs?: number; message?: string; parkedAgeMs?: number; parkReason?: string; requeueCount?: number },
): { id: string } {
  const id = `task_${randomUUID().slice(0, 8)}`
  const anchor = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id, meshId, message: opts.message ?? 'do work', status: 'pending', taskMode: 'code_change',
    targetNodeId: opts.targetNodeId, targetSessionId: opts.targetSessionId,
    ...(opts.parkedAgeMs !== undefined
      ? {
        parked: {
          reason: opts.parkReason ?? PARK_REASON_PIN_EXPIRED,
          parkedAt: new Date(Date.now() - opts.parkedAgeMs).toISOString(),
          targetSessionId: opts.targetSessionId,
          targetNodeId: opts.targetNodeId,
        },
      }
      : {}),
    ...(opts.requeueCount ? { requeueCount: opts.requeueCount } : {}),
    createdAt: anchor, updatedAt: anchor,
  } as any)
  return { id }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  __resetTargetPinGeneratingCreditForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}


const AGE_OVER = PARK_AUTO_UNPIN_MS + 60_000

function unpinNotices(meshId: string, taskId: string) {
  const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
  return (events || []).filter(e => e?.metadataEvent?.taskId === taskId && e?.metadataEvent?.reason === PARK_AUTO_UNPIN_REASON)
}

describe('parked pin auto-unpins after the bound', () => {
  afterEach(() => { vi.clearAllMocks(); delete process.env.ADHDEV_PARK_AUTO_UNPIN_MS })

  it('a park younger than the bound stays parked and pinned', async () => {
    const meshId = `mesh_unpin_young_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: AGE_OVER, parkedAgeMs: PARK_AUTO_UNPIN_MS - 60_000 })
      await triggerMeshQueue(createComponents([]), meshId)
      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(true)
      expect(after.targetSessionId).toBe('remote-sess')
      expect(unpinNotices(meshId, t.id)).toHaveLength(0)
    } finally { cleanup(meshId) }
  })

  it('a park at/over the bound is unpinned, claimable by another session, retry budget untouched, notice once', async () => {
    const meshId = `mesh_unpin_old_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: AGE_OVER, parkedAgeMs: AGE_OVER, requeueCount: 1 })
      const components = createComponents([])
      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(false)
      expect(after.status).toBe('pending')
      expect(after.targetSessionId).toBeUndefined()
      expect(after.targetNodeId).toBeUndefined()
      expect(after.requeueReason).toBe(PARK_AUTO_UNPIN_REASON)
      // maxRetries defaults to 1 and requeueCount was already 1: a budget-consuming
      // requeue would have failed the row instead of reopening it.
      expect(after.requeueCount).toBe(1)

      const notices = unpinNotices(meshId, t.id)
      expect(notices).toHaveLength(1)
      expect(String(notices[0].coordinatorMessage)).toMatch(/unpinned so another worker can take it/)

      // Further ticks neither re-notify nor re-park.
      await triggerMeshQueue(components, meshId)
      expect(unpinNotices(meshId, t.id)).toHaveLength(0)

      // Any eligible session may now claim it (the pinned one included).
      expect(claimNextTask(meshId, NODE_ID, 'some-other-session', [])?.id).toBe(t.id)
    } finally { cleanup(meshId) }
  })

  it('owner_hard_pin_unavailable parks are also released; non-pin (spawn-cap) parks are not', async () => {
    const meshId = `mesh_unpin_reasons_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const hard = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'gone', ageMs: AGE_OVER, parkedAgeMs: AGE_OVER, parkReason: 'owner_hard_pin_unavailable:session_absent' })
      const cap = insertPendingTask(meshId, { ageMs: AGE_OVER, parkedAgeMs: AGE_OVER, parkReason: 'auto_launch_spawn_cap_parked' })
      await triggerMeshQueue(createComponents([]), meshId)
      expect(taskIsParked(task(meshId, hard.id)!)).toBe(false)
      expect(taskIsParked(task(meshId, cap.id)!)).toBe(true)
    } finally { cleanup(meshId) }
  })

  it('ADHDEV_PARK_AUTO_UNPIN_MS=0 disables auto-unpin', async () => {
    const meshId = `mesh_unpin_off_${randomUUID().slice(0, 8)}`
    try {
      process.env.ADHDEV_PARK_AUTO_UNPIN_MS = '0'
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: AGE_OVER, parkedAgeMs: AGE_OVER })
      await triggerMeshQueue(createComponents([]), meshId)
      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(true)
      expect(after.targetSessionId).toBe('remote-sess')
    } finally { cleanup(meshId) }
  })
})
