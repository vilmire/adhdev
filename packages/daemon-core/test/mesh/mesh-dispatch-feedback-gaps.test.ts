import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all mesh file I/O (queue JSON, MeshRuntimeStore db, ledger, pending-events
// JSONL) to a per-run temp dir so production ~/.adhdev state is never touched.
const testTmpDir = path.join(tmpdir(), `adhdev-dispatch-feedback-test-${randomUUID().slice(0, 8)}`)
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

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { getPendingMeshCoordinatorEvents, __clearMeshPendingEventsForTests } from '../../src/mesh/mesh-events-pending.js'

const WT_A = 'node_wt_a'
const WT_B = 'node_wt_b'
const BASE_NODE = 'node_base'

// No idle sessions — both fixes are exercised on the auto-launch skip path, which runs
// after the (empty) idle drain. The skip reason is recorded onto task.autoLaunch and an
// actionable skip is surfaced as a pending coordinator event.
function createComponents(meshId: string) {
  return {
    instanceManager: {
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
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string, nodes: any[]) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'Feedback Mesh', policy: {}, nodes })
}

const node = (id: string, overrides: any = {}) =>
  ({ id, workspace: `/repo/${id}`, repoRoot: `/repo/${id}`, policy: {}, ...overrides })

function autoLaunchReason(meshId: string, taskId: string): string | undefined {
  return getQueue(meshId).find(t => t.id === taskId)?.autoLaunch?.reason
}

function dispatchBlockedEvents(meshId: string) {
  return getPendingMeshCoordinatorEvents(meshId, 'test-machine')
    .filter(e => e.event === 'mesh:dispatch_blocked')
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __clearMeshPendingEventsForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('Fix (2) — convergence-onto-worktree auto-launch skip reason', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('reports mesh_convergence_target_is_worktree (not target_node_id_unmatched / tags) when every candidate is a worktree', async () => {
    const meshId = `mesh_conv_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [
        node(WT_A, { isLocalWorktree: true }),
        node(WT_B, { isLocalWorktree: true }),
      ])
      const components = createComponents(meshId)
      const task = enqueueTask(meshId, 'MERGE+PUSH+DEPLOY', { taskMode: 'convergence' })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('mesh_convergence_target_is_worktree')
    } finally {
      cleanup(meshId)
    }
  })

  it('a convergence task pinned to a worktree node reports the convergence reason, not target_node_id_unmatched', async () => {
    const meshId = `mesh_conv_pin_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(WT_A, { isLocalWorktree: true }), node(BASE_NODE)])
      const components = createComponents(meshId)
      const task = enqueueTask(meshId, 'converge', { taskMode: 'convergence', targetNodeId: WT_A })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('mesh_convergence_target_is_worktree')
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: a convergence task pinned to a genuinely absent node still reports target_node_id_unmatched', async () => {
    const meshId = `mesh_conv_ghost_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(BASE_NODE)])
      const components = createComponents(meshId)
      const task = enqueueTask(meshId, 'converge', { taskMode: 'convergence', targetNodeId: 'node_missing' })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('target_node_id_unmatched')
    } finally {
      cleanup(meshId)
    }
  })
})

describe('Fix (1) — actionable dispatch-skip coordinator notification', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('surfaces an actionable skip (target_node_id_unmatched) as a pending coordinator event with a why+how message', async () => {
    const meshId = `mesh_skip_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(BASE_NODE)])
      const components = createComponents(meshId)
      enqueueTask(meshId, 'do work', { taskMode: 'code_change', targetNodeId: 'node_missing' })

      await triggerMeshQueue(components, meshId)

      const events = dispatchBlockedEvents(meshId)
      expect(events.length).toBe(1)
      expect(events[0].coordinatorMessage).toMatch(/\[System\]/)
      expect(events[0].coordinatorMessage).toMatch(/not being dispatched/i)
      expect(events[0].coordinatorMessage).toMatch(/actionable blocker/i)
      expect((events[0].metadataEvent as any).reason).toBe('target_node_id_unmatched')
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT surface a transient/back-pressure skip (target_session_constraint)', async () => {
    const meshId = `mesh_skip_transient_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(BASE_NODE)])
      const components = createComponents(meshId)
      // targetSessionId → skip reason 'target_session_constraint', a transient/non-actionable
      // reason that clears on its own; it must not page the coordinator.
      const task = enqueueTask(meshId, 'do work', { taskMode: 'code_change', targetSessionId: 'sess-x' })

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('target_session_constraint')
      expect(dispatchBlockedEvents(meshId).length).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('dedups: re-triggering the same unresolved actionable skip surfaces only ONE event', async () => {
    const meshId = `mesh_skip_dedup_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(BASE_NODE)])
      const components = createComponents(meshId)
      enqueueTask(meshId, 'do work', { taskMode: 'code_change', targetNodeId: 'node_missing' })

      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      expect(dispatchBlockedEvents(meshId).length).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })
})
