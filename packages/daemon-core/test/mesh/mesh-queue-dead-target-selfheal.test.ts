import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Owner hard targets remain pinned when unavailable. The queue parks them for an
// explicit coordinator action, preserving retries and dependent identity.

const testTmpDir = path.join(tmpdir(), `adhdev-dead-target-selfheal-test-${randomUUID().slice(0, 8)}`)
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
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'

// THIS daemon's node (isLocalAutoLaunchNode resolves 'test-machine' as local when the node
// carries no foreign daemonId/machineId). Session-liveness for a LOCAL node is trusted.
const NODE_ID = 'node_main'
// Older than DEAD_TARGET_GRACE_MS (60s) so the conservative age gate passes.
const STALE_ISO = new Date(Date.now() - 5 * 60_000).toISOString()

// A fake live CLI instance bound to `sessionId` on NODE_ID (present in instanceManager).
function liveSession(meshId: string, sessionId: string, status: string) {
  const state = {
    instanceId: sessionId,
    status,
    workspace: `/repo/${NODE_ID}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID },
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

// Mesh whose ONLY node is NODE_ID (the coordinator's local node).
function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Dead Target Mesh',
    policy: {},
    nodes: [{ id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } }],
  })
}

function task(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

// Insert a pending queue row DIRECTLY with a controllable `updatedAt` (updateQueueEntry
// stamps updatedAt=now, which would defeat the age gate — insertQueueEntry preserves it).
function insertPendingTask(
  meshId: string,
  opts: { id?: string; targetNodeId?: string; targetSessionId?: string; updatedAt?: string; maxRetries?: number },
): { id: string } {
  const id = opts.id ?? `task_${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id, meshId, message: 'do work', status: 'pending', taskMode: 'code_change',
    targetNodeId: opts.targetNodeId, targetSessionId: opts.targetSessionId,
    maxRetries: opts.maxRetries,
    createdAt: opts.updatedAt ?? now, updatedAt: opts.updatedAt ?? now,
  } as any)
  return { id }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('owner hard pins — unavailable targets park without automatic unpin', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('parks a dead session pin on a live local node without changing its owner target', async () => {
    const meshId = `mesh_dt_sess_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // The node is alive (in the mesh) but the pinned session is NOT in instanceManager → dead.
      const components = createComponents([])
      // Aged past the grace window so the conservative age gate passes.
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'dead-session', updatedAt: STALE_ISO })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(after.targetSessionId).toBe('dead-session')
      expect(after.targetNodeId).toBe(NODE_ID)
      expect(after.parked?.reason).toBe('owner_hard_pin_unavailable:dead_target_session_absent')
      expect(after.requeueCount ?? 0).toBe(0)
      // No longer permanently walled behind target_session_constraint.
      expect(after.autoLaunch?.reason).not.toBe('target_session_constraint')
    } finally {
      cleanup(meshId)
    }
  })

  it('preserves both owner pins when the target node is absent', async () => {
    const meshId = `mesh_dt_node_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId) // mesh has only NODE_ID
      const components = createComponents([])
      // Pin to a node id that no longer exists in the mesh.
      const t = insertPendingTask(meshId, { targetNodeId: 'node_dead', targetSessionId: 'dead-session', updatedAt: STALE_ISO })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(after.targetSessionId).toBe('dead-session')
      expect(after.targetNodeId).toBe('node_dead')
      expect(after.parked?.reason).toBe('owner_hard_pin_unavailable:dead_target_node_absent')
      expect(after.requeueCount ?? 0).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT disturb a task pinned to a LIVE-but-busy session (no premature unpin)', async () => {
    const meshId = `mesh_dt_live_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // The pinned session is alive and generating on the node → must be left untouched.
      const components = createComponents([liveSession(meshId, 'busy-session', 'generating')])
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'busy-session', updatedAt: STALE_ISO })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      // Pin intact, not requeued — the live session will claim it on its own.
      expect(after.targetSessionId).toBe('busy-session')
      expect(after.targetNodeId).toBe(NODE_ID)
      expect(after.requeueCount ?? 0).toBe(0)
      expect(after.autoLaunch?.reason).toBe('target_session_constraint')
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT unpin a dead target inside the grace window (age gate holds)', async () => {
    const meshId = `mesh_dt_grace_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([]) // session absent → dead, BUT freshly updated
      // updatedAt defaults to now → within the grace window.
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'dead-session' })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      // Grace window not elapsed → still walled behind the ordinary skip, pin intact.
      expect(after.targetSessionId).toBe('dead-session')
      expect(after.requeueCount ?? 0).toBe(0)
      expect(after.autoLaunch?.reason).toBe('target_session_constraint')
    } finally {
      cleanup(meshId)
    }
  })

  it('does not consume execution retries or release dependents merely because a hard pin is unavailable', async () => {
    const meshId = `mesh_dt_cap_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([])
      // Unavailable addressing is a hold, not a failed execution attempt.
      const t = insertPendingTask(meshId, { targetNodeId: 'node_dead', targetSessionId: 'dead-session', maxRetries: 0, updatedAt: STALE_ISO })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(after.status).toBe('pending')
      expect(after.parked).toBeDefined()
      expect(after.requeueCount ?? 0).toBe(0)
      expect(after.targetNodeId).toBe('node_dead')
    } finally {
      cleanup(meshId)
    }
  })
})
