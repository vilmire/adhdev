import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// MESH-DISPATCH-MISROUTE (fix 3, consumer residual): the agent:generating_started 'acked'
// path used to call updateDirectDispatchStatus(meshId, sessionId, 'acked', undefined) whenever
// the firing event carried no taskId but the session held an active assignment. That undefined
// taskId triggers the session_id sweep in the runtime store, which flips EVERY non-terminal
// dispatch row for the session — "may flip a sibling dispatch row" (the live-log warning).
//
// The fix: when the event names no task, resolve the SINGLE active dispatch's taskId
// (getSoleActiveDirectDispatchTaskId) and flip it by PK. With exactly one active row the owner
// is unambiguous; with two or more siblings the owner is ambiguous, so the ack is DROPPED rather
// than mis-flipping a sibling.

const testTmpDir = path.join(tmpdir(), `adhdev-misroute-ack-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ machineId: 'test-machine' } as any)),
}))
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: configMocks.loadConfig,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn() }))
const fastForwardMocks = vi.hoisted(() => ({ fastForwardMeshNode: vi.fn() }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({ fastForwardMeshNode: fastForwardMocks.fastForwardMeshNode }))

import { __resetIdleAutoFastForwardForTests, __resetMeshWorkspaceCacheForTests, setupMeshEventForwarding } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, insertDirectDispatch, getActiveDirectDispatches } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js'

const SESSION_ID = 'runtime-session-1'

function createComponents(meshId: string) {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: SESSION_ID,
    workspace: '/repo/worktree-a',
    settings: { meshNodeFor: meshId, meshNodeId: 'node_child_1' },
  }
  const source = { category: 'cli', getState: vi.fn(() => sourceState) }
  const coordinator = {
    category: 'cli',
    getState: vi.fn(() => ({ instanceId: 'coordinator-session-1', workspace: '/repo/main', status: 'idle', settings: { meshCoordinatorFor: meshId } })),
    onEvent: vi.fn(),
  }
  const instanceManager = {
    onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
    getInstance: vi.fn((id: string) => id === SESSION_ID ? source : undefined),
    getByCategory: vi.fn((category: string) => category === 'cli' ? [source, coordinator] : []),
  }
  return {
    components: { instanceManager } as any,
    emit: (event: any) => {
      if (!listener) throw new Error('listener was not registered')
      listener(event)
    },
  }
}

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetIdleAutoFastForwardForTests()
  __resetMeshWorkspaceCacheForTests()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  fastForwardMocks.fastForwardMeshNode.mockReset()
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

function mockMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    nodes: [{ id: 'node_child_1', workspace: '/repo/worktree-a' }],
    policy: {},
  })
  meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
}

describe('MESH-DISPATCH-MISROUTE fix 3 — getSoleActiveDirectDispatchTaskId (runtime store)', () => {
  it('returns the lone active dispatch task_id', () => {
    const meshId = `mesh_sole_one_${Date.now()}`
    try {
      mockMesh(meshId)
      insertDirectDispatch(meshId, {
        taskId: 'task_only', nodeId: 'node_child_1', sessionId: SESSION_ID,
        providerType: 'codex-cli', message: 'm', via: 'local_direct', dispatchedAt: new Date().toISOString(),
      })
      expect(MeshRuntimeStore.getInstance().getSoleActiveDirectDispatchTaskId(meshId, SESSION_ID)).toBe('task_only')
    } finally { cleanupMeshFiles(meshId) }
  })

  it('returns null with ZERO active dispatches', () => {
    const meshId = `mesh_sole_zero_${Date.now()}`
    try {
      mockMesh(meshId)
      expect(MeshRuntimeStore.getInstance().getSoleActiveDirectDispatchTaskId(meshId, SESSION_ID)).toBeNull()
    } finally { cleanupMeshFiles(meshId) }
  })

  it('returns null with TWO active sibling dispatches (ambiguous owner)', () => {
    const meshId = `mesh_sole_two_${Date.now()}`
    try {
      mockMesh(meshId)
      for (const tid of ['task_a', 'task_b']) {
        insertDirectDispatch(meshId, {
          taskId: tid, nodeId: 'node_child_1', sessionId: SESSION_ID,
          providerType: 'codex-cli', message: 'm', via: 'local_direct', dispatchedAt: new Date().toISOString(),
        })
      }
      expect(MeshRuntimeStore.getInstance().getSoleActiveDirectDispatchTaskId(meshId, SESSION_ID)).toBeNull()
    } finally { cleanupMeshFiles(meshId) }
  })
})

describe('MESH-DISPATCH-MISROUTE fix 3 — generating_started ack resolves the sole dispatch by PK, never sweeps siblings', () => {
  it('(a) no-taskId started + exactly one active dispatch → acks that exact taskId (not a session sweep)', () => {
    const meshId = `mesh_ack_sole_${Date.now()}`
    try {
      mockMesh(meshId)
      insertDirectDispatch(meshId, {
        taskId: 'task_sole', nodeId: 'node_child_1', sessionId: SESSION_ID,
        providerType: 'codex-cli', message: 'work', via: 'local_direct', dispatchedAt: new Date().toISOString(),
      })
      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      const spy = vi.spyOn(MeshRuntimeStore.getInstance(), 'updateDirectDispatchStatus')

      emit({
        event: 'agent:generating_started',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        // no taskId on the event — the legacy/relayed worker case
        timestamp: Date.now(),
      })

      // Resolved to the exact task_id, NOT the session_id sweep (taskId would be undefined).
      expect(spy).toHaveBeenCalledWith(meshId, SESSION_ID, 'acked', 'task_sole')
      expect(spy).not.toHaveBeenCalledWith(meshId, SESSION_ID, 'acked', undefined)
      spy.mockRestore()
    } finally { cleanupMeshFiles(meshId) }
  })

  it('(b) no-taskId started + TWO active siblings → ack DROPPED (no sibling mis-flip)', () => {
    const meshId = `mesh_ack_two_${Date.now()}`
    try {
      mockMesh(meshId)
      // The misroute hazard: a re-dispatch/nudge left two non-terminal rows on the session.
      // The old session_id sweep would mark BOTH 'acked', hiding a genuine non-delivery.
      for (const tid of ['task_x', 'task_y']) {
        insertDirectDispatch(meshId, {
          taskId: tid, nodeId: 'node_child_1', sessionId: SESSION_ID,
          providerType: 'codex-cli', message: 'work', via: 'local_direct', dispatchedAt: new Date().toISOString(),
        })
      }
      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      const spy = vi.spyOn(MeshRuntimeStore.getInstance(), 'updateDirectDispatchStatus')

      emit({
        event: 'agent:generating_started',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        timestamp: Date.now(),
      })

      // No ack flip at all — ambiguous owner → drop, never sweep both rows.
      const ackCalls = spy.mock.calls.filter(c => c[2] === 'acked')
      expect(ackCalls).toHaveLength(0)
      // Both dispatches remain active (still 'dispatched').
      const active = getActiveDirectDispatches(meshId).map(d => d.taskId).sort()
      expect(active).toEqual(['task_x', 'task_y'])
      spy.mockRestore()
    } finally { cleanupMeshFiles(meshId) }
  })

  it('(c) normal case preserved: a started event carrying its taskId acks that exact row by PK', () => {
    const meshId = `mesh_ack_named_${Date.now()}`
    try {
      mockMesh(meshId)
      insertDirectDispatch(meshId, {
        taskId: 'task_named', nodeId: 'node_child_1', sessionId: SESSION_ID,
        providerType: 'codex-cli', message: 'work', via: 'local_direct', dispatchedAt: new Date().toISOString(),
      })
      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)
      const spy = vi.spyOn(MeshRuntimeStore.getInstance(), 'updateDirectDispatchStatus')

      emit({
        event: 'agent:generating_started',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        taskId: 'task_named',
        timestamp: Date.now(),
      })

      expect(spy).toHaveBeenCalledWith(meshId, SESSION_ID, 'acked', 'task_named')
      spy.mockRestore()
    } finally { cleanupMeshFiles(meshId) }
  })
})
