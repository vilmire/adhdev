import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// WARMUPGAP regression: a mesh worker session spawns and emits a warmup lifecycle cycle
// (idle→generating→completed) BEFORE any task is dispatched to it. With no assigned task,
// meshActiveTaskId is unset, so the forwarded agent:generating_started / generating_completed
// carry no taskId. The coordinator's updateDirectDispatchStatus then falls back to a session_id
// match (mesh-runtime-store: WHERE session_id AND status NOT IN completed,failed), which mutates
// a dispatch row this ghost event does not own. The two callsites
// (mesh-events-coordinator.ts: markSessionTerminal + the generating_started 'acked' path) must
// gate the no-taskId fallback on sessionHasActiveAssignment(): when the firing session holds no
// active assignment AND the event names no task, the dispatch update is skipped (no-op). A
// taskId-carrying completion, or any event whose session holds an active assignment, still flips.

const testTmpDir = path.join(tmpdir(), `adhdev-warmupgap-test-${randomUUID().slice(0, 8)}`)
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
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

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

describe('WARMUPGAP — no-taskId lifecycle events from an unassigned session must not flip dispatch rows', () => {
  it('(a) a warmup generating_completed (no taskId, no active assignment) does NOT call updateDirectDispatchStatus', () => {
    const meshId = `mesh_warmup_completed_${Date.now()}`
    try {
      mockMesh(meshId)
      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      // Spy AFTER setup; vi.spyOn keeps the real implementation (calls through) so any
      // legitimate flip would still be observable — here we assert it is never invoked.
      const spy = vi.spyOn(MeshRuntimeStore.getInstance(), 'updateDirectDispatchStatus')

      // Genuine completion (finalSummary present, no completionDiagnostic → not a false idle),
      // but no task was ever assigned/dispatched to this session.
      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        providerSessionId: 'warmup-provider-history',
        finalSummary: 'warmup banner / first idle',
        timestamp: Date.now(),
      })

      // The handler DID process the completion (the unconditional task_completed ledger entry
      // proves markSessionTerminal was reached) — yet the dispatch-row update was skipped.
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(true)
      expect(spy).not.toHaveBeenCalled()

      spy.mockRestore()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('(a2) a warmup generating_started (no taskId, no active assignment) does NOT call updateDirectDispatchStatus', () => {
    const meshId = `mesh_warmup_started_${Date.now()}`
    try {
      mockMesh(meshId)
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

      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('(b) normal case preserved: a completion carrying a taskId flips its exact dispatch row', () => {
    const meshId = `mesh_normal_taskid_${Date.now()}`
    try {
      mockMesh(meshId)
      insertDirectDispatch(meshId, {
        taskId: 'task_real_b',
        nodeId: 'node_child_1',
        sessionId: SESSION_ID,
        providerType: 'codex-cli',
        message: 'do the real work',
        via: 'local_direct',
        dispatchedAt: new Date().toISOString(),
      })
      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      const spy = vi.spyOn(MeshRuntimeStore.getInstance(), 'updateDirectDispatchStatus')

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        providerSessionId: 'real-b-history',
        finalSummary: 'real task report',
        taskId: 'task_real_b',
        timestamp: Date.now(),
      })

      expect(spy).toHaveBeenCalledWith(meshId, SESSION_ID, 'completed', 'task_real_b')
      // The exact row is now terminal → excluded from the active-dispatch surface.
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === 'task_real_b')).toBe(false)
      spy.mockRestore()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('(c) regression guard: a no-taskId completion whose session HAS an active assignment still flips (session_id fallback)', () => {
    const meshId = `mesh_active_no_taskid_${Date.now()}`
    try {
      mockMesh(meshId)
      // An in-flight direct dispatch binds the session → sessionHasActiveAssignment() is true,
      // so a legacy/relayed worker completion that carries no taskId must still be honored.
      insertDirectDispatch(meshId, {
        taskId: 'task_active_c',
        nodeId: 'node_child_1',
        sessionId: SESSION_ID,
        providerType: 'codex-cli',
        message: 'legacy relayed task',
        via: 'local_direct',
        dispatchedAt: new Date().toISOString(),
      })
      const { components, emit } = createComponents(meshId)
      setupMeshEventForwarding(components)

      const spy = vi.spyOn(MeshRuntimeStore.getInstance(), 'updateDirectDispatchStatus')

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        providerSessionId: 'active-c-history',
        finalSummary: 'legacy worker report',
        // no taskId — exercises the session_id fallback path
        timestamp: Date.now(),
      })

      expect(spy).toHaveBeenCalledWith(meshId, SESSION_ID, 'completed', undefined)
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === 'task_active_c')).toBe(false)
      spy.mockRestore()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
