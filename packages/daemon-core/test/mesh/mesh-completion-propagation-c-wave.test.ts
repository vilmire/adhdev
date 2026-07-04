import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore, pending events) to a per-run
// temp dir so the suite never touches the production ~/.adhdev/mesh-ledger. Mirrors the
// mesh-reconcile-loop test harness so runMeshReconcileTick + the claim path resolve a
// mocked config/mesh view.
const testTmpDir = path.join(tmpdir(), `adhdev-mesh-cwave-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
}))

const meshConfigMocks = vi.hoisted(() => ({
  listMeshes: vi.fn(() => [] as any[]),
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  listMeshes: meshConfigMocks.listMeshes,
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
}))

import {
  enqueueTask,
  getQueue,
  claimNextTask,
  updateSessionTaskStatus,
  __clearMeshQueueForTests,
  __replaceMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
} from '../../src/mesh/mesh-work-queue.js'
import { tryAssignQueueTask } from '../../src/mesh/mesh-queue-assignment.js'
import {
  beginTaskDispatchInFlight,
  isTaskDispatchInFlight,
  __resetTaskDispatchInFlightForTests,
} from '../../src/mesh/mesh-task-inflight.js'
import { runMeshReconcileTick } from '../../src/mesh/mesh-reconcile-loop.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createSessionDelivery } from '../../src/mesh/mesh-delivery-policy.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetTaskDispatchInFlightForTests()
  meshConfigMocks.listMeshes.mockReset(); meshConfigMocks.listMeshes.mockReturnValue([])
  meshConfigMocks.getMesh.mockReset()
  for (const suffix of ['pending-events.jsonl', 'queue.json']) {
    const p = path.join(getLedgerDir(), `${meshId}.${suffix}`)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F1 — findAssignedBySession write/read predicate symmetry (session equivalence)
// ─────────────────────────────────────────────────────────────────────────────
describe('COMPLETION-PROPAGATION F1: completion flip matches an equivalent-but-not-byte-identical session', () => {
  afterEach(() => __resetMeshRuntimeStoreForTests())

  it('flips the assigned row completed when the completion sessionId differs only by whitespace (taskId path)', () => {
    const meshId = `mesh_f1_ws_task_${Date.now()}`
    try {
      const t1 = enqueueTask(meshId, 'work')
      claimNextTask(meshId, 'node1', 'sess-1')
      // Simulate the manual-launch skew: the STORED assigned session carries a whitespace
      // form (a raw SQL `assigned_session_id = ?` on the trimmed completion id would miss),
      // exactly the drift resolveEventSessionId re-interpretation produced in the live repro.
      const queue = getQueue(meshId)
      queue[0].assignedSessionId = ' sess-1'
      __replaceMeshQueueForTests(meshId, queue)

      const result = updateSessionTaskStatus(meshId, 'sess-1', 'completed', { taskId: t1.id })
      expect(result?.id).toBe(t1.id)
      expect(getQueue(meshId).find(t => t.id === t1.id)?.status).toBe('completed')
    } finally {
      cleanup(meshId)
    }
  })

  it('flips the assigned row completed via the session-only path under the same skew (no taskId)', () => {
    const meshId = `mesh_f1_ws_session_${Date.now()}`
    try {
      const t1 = enqueueTask(meshId, 'work')
      claimNextTask(meshId, 'node1', 'sess-A')
      const queue = getQueue(meshId)
      queue[0].assignedSessionId = 'sess-A '  // trailing-space skew
      __replaceMeshQueueForTests(meshId, queue)

      const result = updateSessionTaskStatus(meshId, 'sess-A', 'completed')
      expect(result?.id).toBe(t1.id)
      expect(getQueue(meshId).find(t => t.id === t1.id)?.status).toBe('completed')
    } finally {
      cleanup(meshId)
    }
  })

  it('still returns null (no false flip) when no assigned row is equivalent to the completion session', () => {
    const meshId = `mesh_f1_nomatch_${Date.now()}`
    try {
      enqueueTask(meshId, 'work')
      claimNextTask(meshId, 'node1', 'sess-real')
      const result = updateSessionTaskStatus(meshId, 'sess-unrelated', 'completed')
      expect(result).toBeNull()
    } finally {
      cleanup(meshId)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F3 + F4 — delivered-but-lost completion reclaim + single-flight lock release
// ─────────────────────────────────────────────────────────────────────────────
describe('COMPLETION-PROPAGATION F3/F4: delivered-no-turn deadline reclaim', () => {
  // > DELIVERED_NO_TURN_DEADLINE_MS (15 min) so the delivered row is provably past the window.
  const DELIVERED_LOST_MS = 16 * 60_000
  const WITHIN_DEADLINE_MS = 6 * 60_000

  function backdateDispatch(meshId: string, taskId: string, ageMs: number) {
    const store = MeshRuntimeStore.getInstance()
    const entry = store.findQueueEntryById(meshId, taskId)!
    entry.dispatchTimestamp = new Date(Date.now() - ageMs).toISOString()
    store.updateQueueEntry(entry)
  }
  // A local mesh with no idle session / launchable provider, and every session reported
  // non-generating (getInstance → undefined → isSessionActivelyGenerating false), so the
  // reclaim's effect is observable in isolation.
  function makeIdleDeadComponents() {
    return { instanceManager: { getByCategory: () => [], getInstance: () => undefined } } as any
  }
  function hostMesh(meshId: string, nodeId: string) {
    const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
    meshConfigMocks.listMeshes.mockReturnValue([mesh])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
  }

  it('reclaims a delivered-but-uncompleted row once past the deadline with a non-generating session', async () => {
    const meshId = `mesh_f3_lost_${Date.now()}`
    const nodeId = 'node_w'
    try {
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
      const claimed = claimNextTask(meshId, nodeId, 'sess-lost', [])!
      backdateDispatch(meshId, claimed.id, DELIVERED_LOST_MS)
      // Confirmed delivery but NO terminal completion ever landed (the lost-completion signature).
      createSessionDelivery({ meshId, nodeId, sessionId: 'sess-lost', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
      // Simulate the dispatch's single-flight mark still being held.
      beginTaskDispatchInFlight(meshId, claimed.id)
      hostMesh(meshId, nodeId)

      await runMeshReconcileTick(makeIdleDeadComponents())

      const row = getQueue(meshId).find(t => t.id === claimed.id)!
      expect(row.status).toBe('pending')
      expect(row.assignedSessionId).toBeUndefined()
      expect(row.dispatchTimestamp).toBeUndefined()
      const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
      expect(reclaimed).toHaveLength(1)
      expect((reclaimed[0].payload as any).reason).toBe('delivered_no_turn_deadline')
      // F4: the reclaim ended the single-flight window so a re-dispatch/requeue is unblocked.
      expect(isTaskDispatchInFlight(meshId, claimed.id)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT reclaim a delivered row that is still within the delivered-no-turn deadline', async () => {
    const meshId = `mesh_f3_within_${Date.now()}`
    const nodeId = 'node_w'
    try {
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
      const claimed = claimNextTask(meshId, nodeId, 'sess-live', [])!
      backdateDispatch(meshId, claimed.id, WITHIN_DEADLINE_MS)  // past the 5-min stranded window, under 15-min delivered window
      createSessionDelivery({ meshId, nodeId, sessionId: 'sess-live', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
      hostMesh(meshId, nodeId)

      await runMeshReconcileTick(makeIdleDeadComponents())

      const row = getQueue(meshId).find(t => t.id === claimed.id)!
      expect(row.status).toBe('assigned')
      expect(row.assignedSessionId).toBe('sess-live')
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT reclaim a delivered row whose session is still actively generating', async () => {
    const meshId = `mesh_f3_generating_${Date.now()}`
    const nodeId = 'node_w'
    const sessionId = 'sess-busy'
    try {
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
      const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
      backdateDispatch(meshId, claimed.id, DELIVERED_LOST_MS)
      createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
      hostMesh(meshId, nodeId)
      // A live local instance that reports an active/generating state must never be reclaimed.
      const generatingComponents = {
        instanceManager: {
          getByCategory: () => [],
          getInstance: (id: string) => (id === sessionId
            ? { getState: () => ({ status: 'generating' }) }
            : undefined),
        },
      } as any

      await runMeshReconcileTick(generatingComponents)

      const row = getQueue(meshId).find(t => t.id === claimed.id)!
      expect(row.status).toBe('assigned')
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F6 + F7 — C1/C2: the claim gate reads the synchronous inline cache (SSOT) first
// ─────────────────────────────────────────────────────────────────────────────
describe('COMPLETION-PROPAGATION F6/F7: bootstrap gate reads inline-cache SSOT first', () => {
  function makeLocalWorker(meshId: string, nodeId: string, sessionId: string, inlineMesh: any) {
    const handleCliCommand = vi.fn(async () => ({ success: true }))
    const workerInstance = {
      category: 'cli',
      getState: () => ({ instanceId: sessionId, status: 'idle', type: 'claude-cli', settings: { meshNodeFor: meshId, meshNodeId: nodeId, providerType: 'claude-cli' } }),
      updateSettings: vi.fn(),
    }
    return {
      handleCliCommand,
      updateSettings: workerInstance.updateSettings,
      components: {
        instanceManager: {
          getByCategory: (c: string) => (c === 'cli' ? [workerInstance] : []),
          getInstance: (id: string) => (id === sessionId ? workerInstance : undefined),
        },
        cliManager: { adapters: new Map([[sessionId, {}]]), handleCliCommand },
        router: { getCachedInlineMesh: (id: string) => (id === meshId ? inlineMesh : undefined) },
      } as any,
    }
  }

  it('allows the claim when the stale config view says running but the inline SSOT says complete', () => {
    const meshId = `mesh_f7_ssot_ok_${Date.now()}`
    const nodeId = 'wt_node'
    const sessionId = 'sess-wt'
    try {
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
      // Stale local-config view: bootstrap still 'running' (the detached persist lag).
      const configMesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w', worktreeBootstrap: { status: 'running', updatedAt: new Date().toISOString() } }] }
      meshConfigMocks.getMesh.mockReturnValue(configMesh)
      meshConfigMocks.listMeshes.mockReturnValue([configMesh])
      // Fresh inline SSOT: bootstrap already 'complete'.
      const inlineMesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w', worktreeBootstrap: { status: 'complete' } }] }
      const { components, handleCliCommand } = makeLocalWorker(meshId, nodeId, sessionId, inlineMesh)

      const assigned = tryAssignQueueTask(components, meshId, nodeId, sessionId, 'claude-cli')

      expect(assigned).toBe(true)
      expect(handleCliCommand).toHaveBeenCalledWith('agent_command', expect.objectContaining({ targetSessionId: sessionId, action: 'send_chat' }))
      expect(getQueue(meshId).find(t => t.targetNodeId === nodeId)?.status).toBe('assigned')
    } finally {
      cleanup(meshId)
    }
  })

  it('still defers the claim when the inline SSOT itself reports bootstrap running', () => {
    const meshId = `mesh_f7_ssot_defer_${Date.now()}`
    const nodeId = 'wt_node'
    const sessionId = 'sess-wt'
    try {
      const t1 = enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
      const configMesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w', worktreeBootstrap: { status: 'running', updatedAt: new Date().toISOString() } }] }
      meshConfigMocks.getMesh.mockReturnValue(configMesh)
      meshConfigMocks.listMeshes.mockReturnValue([configMesh])
      const inlineMesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w', worktreeBootstrap: { status: 'running', updatedAt: new Date().toISOString() } }] }
      const { components, handleCliCommand } = makeLocalWorker(meshId, nodeId, sessionId, inlineMesh)

      const assigned = tryAssignQueueTask(components, meshId, nodeId, sessionId, 'claude-cli')

      expect(assigned).toBe(false)
      expect(handleCliCommand).not.toHaveBeenCalled()
      expect(getQueue(meshId).find(t => t.id === t1.id)?.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F5 — claim-adopt (re)stamps the coordinator SESSION anchor from the task source
// ─────────────────────────────────────────────────────────────────────────────
describe('COMPLETION-PROPAGATION F5: claim-adopt coordinator session anchor', () => {
  function makeLocalWorker(meshId: string, nodeId: string, sessionId: string) {
    const handleCliCommand = vi.fn(async () => ({ success: true }))
    const updateSettings = vi.fn()
    const workerInstance = {
      category: 'cli',
      getState: () => ({ instanceId: sessionId, status: 'idle', type: 'claude-cli', settings: { meshNodeFor: meshId, meshNodeId: nodeId, providerType: 'claude-cli' } }),
      updateSettings,
    }
    // Node WITHOUT daemonId → tryAssignQueueTask takes the local co-located dispatch branch.
    const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    meshConfigMocks.listMeshes.mockReturnValue([mesh])
    return {
      updateSettings,
      components: {
        instanceManager: {
          getByCategory: (c: string) => (c === 'cli' ? [workerInstance] : []),
          getInstance: (id: string) => (id === sessionId ? workerInstance : undefined),
        },
        cliManager: { adapters: new Map([[sessionId, {}]]), handleCliCommand },
      } as any,
    }
  }

  it('stamps meshCoordinatorSessionId from the task sourceCoordinatorSessionId (priority)', () => {
    const meshId = `mesh_f5_stamp_${Date.now()}`
    const nodeId = 'node_a'
    const sessionId = 'sess-adopt'
    try {
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId, sourceCoordinatorSessionId: 'coord-A' })
      const { components, updateSettings } = makeLocalWorker(meshId, nodeId, sessionId)

      const assigned = tryAssignQueueTask(components, meshId, nodeId, sessionId, 'claude-cli')

      expect(assigned).toBe(true)
      const stamped = updateSettings.mock.calls.map(c => c[0]).find(s => 'meshCoordinatorSessionId' in s)
      expect(stamped).toBeTruthy()
      expect(stamped.meshCoordinatorSessionId).toBe('coord-A')
    } finally {
      cleanup(meshId)
    }
  })

  it('clears the anchor (undefined → broadcast fallback) when the task carries no source coordinator session', () => {
    const meshId = `mesh_f5_clear_${Date.now()}`
    const nodeId = 'node_a'
    const sessionId = 'sess-adopt'
    try {
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId })  // no sourceCoordinatorSessionId
      const { components, updateSettings } = makeLocalWorker(meshId, nodeId, sessionId)

      const assigned = tryAssignQueueTask(components, meshId, nodeId, sessionId, 'claude-cli')

      expect(assigned).toBe(true)
      const stamped = updateSettings.mock.calls.map(c => c[0]).find(s => 'meshCoordinatorSessionId' in s)
      expect(stamped).toBeTruthy()
      expect(stamped.meshCoordinatorSessionId).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })
})
