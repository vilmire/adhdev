import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// CAUSAL-COMPLETION-GATE (Fix A, rc.15 orchestration RCA): an auto-launched session can emit a
// spurious agent:generating_completed before its target task was ever delivered to / consumed
// by it — a freshly spawned worker's boot/idle-prompt output misread as a finished turn
// (totalMessages=0: the worker never actually processed the task). Before this fix the
// coordinator accepted such a completion at face value (subject only to the provider's own
// self-reported weak/false-idle heuristics, which are not guaranteed to catch a pure boot
// artifact). The fix adds an INDEPENDENT, coordinator-side gate scoped to the exact race: a task
// still 'pending' whose in-window autoLaunch record names the completing session. For that one
// case, causal evidence (a consumed delivery, or a matching task_dispatched ledger entry) is
// required before the completion is accepted; everything else (already-claimed tasks, direct
// dispatches, expired auto-launch windows) is untouched.
//
// Tests exercise BOTH forwarding entry points:
//   - LOCAL:  setupMeshEventForwarding + instanceManager.onEvent (worker co-hosted on this daemon)
//   - REMOTE: handleMeshForwardEvent (a remote worker's event forwarded to the coordinator)

const testTmpDir = path.join(tmpdir(), `adhdev-causal-gate-test-${randomUUID().slice(0, 8)}`)
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

import {
  __resetIdleAutoFastForwardForTests,
  __resetMeshWorkspaceCacheForTests,
  setupMeshEventForwarding,
  handleMeshForwardEvent,
} from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { getLedgerDir, readLedgerEntries, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js'
import { createSessionDelivery } from '../../src/mesh/mesh-delivery-policy.js'

const NODE_ID = 'node_worker_1'
const SESSION_ID = 'auto-launch-session-1'
const WORKSPACE = '/repo/worker'

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetIdleAutoFastForwardForTests()
  __resetMeshWorkspaceCacheForTests()
  meshConfigMocks.getMesh.mockReset()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

function mockMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    nodes: [{ id: NODE_ID, workspace: WORKSPACE }],
    policy: {},
  })
  meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
}

// Seed a pending queue task with an in-window autoLaunch record naming `sessionId` — the exact
// race state: the session was just spawned FOR this task, but the task has not yet been formally
// claimed (status stays 'pending' until the real claim path flips it to 'assigned').
function seedInWindowAutoLaunchTask(meshId: string, sessionId: string, ageMs = 0) {
  const task = enqueueTask(meshId, 'do worktree work', { taskMode: 'code_change',
    difficulty: 'medium',
})
  const store = MeshRuntimeStore.getInstance()
  const entry = store.findQueueEntryById(meshId, task.id)!
  entry.autoLaunch = {
    status: 'completed',
    nodeId: NODE_ID,
    providerType: 'codex-cli',
    sessionId,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  }
  store.updateQueueEntry(entry)
  return task
}

// LOCAL entry point: a worker instance co-hosted on this daemon.
function makeLocalComponents() {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: SESSION_ID,
    workspace: WORKSPACE,
    settings: { meshNodeFor: '', meshNodeId: NODE_ID },
  }
  const source = { category: 'cli', getState: vi.fn(() => sourceState) }
  const instanceManager = {
    onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
    getInstance: vi.fn((id: string) => (id === SESSION_ID ? source : undefined)),
    getByCategory: vi.fn((category: string) => (category === 'cli' ? [source] : [])),
  }
  return {
    components: { instanceManager } as any,
    emit: (event: any) => {
      if (!listener) throw new Error('listener was not registered')
      listener(event)
    },
    setMeshFor: (meshId: string) => { sourceState.settings = { meshNodeFor: meshId, meshNodeId: NODE_ID } },
  }
}

// REMOTE entry point: no live local instance — mirrors a remote worker's forwarded event.
function makeRemoteComponents() {
  return {
    instanceManager: {
      getInstance: vi.fn(() => undefined),
      getByCategory: vi.fn(() => []),
      onEvent: vi.fn(),
    },
  } as any
}

describe('CAUSAL-COMPLETION-GATE — LOCAL forwarding (setupMeshEventForwarding)', () => {
  it('suppresses agent:generating_completed for an in-window unclaimed auto-launch task with no delivery/turn-start evidence', () => {
    const meshId = `mesh_causal_local_suppress_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedInWindowAutoLaunchTask(meshId, SESSION_ID)
      const { components, emit, setMeshFor } = makeLocalComponents()
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'done',
        timestamp: Date.now(),
      })

      // No terminal ledger entry recorded — the false completion must not become a real terminal.
      const completed = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(completed).toHaveLength(0)
      // The queue task is untouched — still pending, no false redrive/terminal possible from it.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      expect(MeshRuntimeStore.getInstance().taskDeliveryConsumed(meshId, task.id)).toBe(false)
      // Suppressed BEFORE the accept path — the session was never re-registered as remote-idle.
      const idleSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
      expect(idleSessions.some(s => s.sessionId === SESSION_ID)).toBe(false)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('accepts the completion once the delivery was consumed (taskDeliveryConsumed) before it arrives', () => {
    const meshId = `mesh_causal_local_delivered_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedInWindowAutoLaunchTask(meshId, SESSION_ID)
      // Simulate a real turn-start: a delivery for this task/session was created, then the
      // worker's agent:generating_started acked it (consumeSessionDelivery flips delivered→acked).
      createSessionDelivery({
        meshId, nodeId: NODE_ID, sessionId: SESSION_ID, providerType: 'codex-cli',
        taskId: task.id, kind: 'task', message: 'do worktree work', status: 'delivered',
      })
      const { components, emit, setMeshFor } = makeLocalComponents()
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'agent:generating_started',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        taskId: task.id,
        timestamp: Date.now(),
      })
      expect(MeshRuntimeStore.getInstance().taskDeliveryConsumed(meshId, task.id)).toBe(true)

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'done',
        taskId: task.id,
        timestamp: Date.now(),
      })

      // The causal gate must NOT have short-circuited — execution reached the normal accept
      // path, which (for a non-weak completion) re-registers the now-idle session. That
      // registration is synchronous, so its presence proves the gate did not suppress.
      const idleSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
      expect(idleSessions.some(s => s.sessionId === SESSION_ID)).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('accepts the completion when a matching task_dispatched ledger entry proves the turn started (alternate causal signal)', () => {
    const meshId = `mesh_causal_local_dispatched_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedInWindowAutoLaunchTask(meshId, SESSION_ID)
      appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        providerType: 'codex-cli',
        payload: { taskId: task.id, message: 'do worktree work', source: 'direct' },
      })
      const { components, emit, setMeshFor } = makeLocalComponents()
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'done',
        taskId: task.id,
        timestamp: Date.now(),
      })

      // Gate passed via the alternate (task_dispatched) signal — same observable proof.
      const idleSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
      expect(idleSessions.some(s => s.sessionId === SESSION_ID)).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  // ★LEDGER-KIND-TAIL-BLINDSPOT: hasMatchingTaskDispatchedLedgerEntry used to read a bare
  // `readLedgerEntries(meshId, { tail: 200 })` then filter by kind in the loop — a bare tail
  // window can be crowded out by unrelated mesh traffic before reaching the real
  // task_dispatched row, and a false negative here suppresses a GENUINE completion as a "boot
  // artifact" (the CAUSAL-COMPLETION-GATE below this check). The fix reads with an explicit
  // kind filter and no tail, so the alternate causal signal must still be found even when
  // buried under 200+ unrelated entries.
  it('★accepts the completion via the task_dispatched alternate signal even when buried beyond the 200-entry tail window', () => {
    const meshId = `mesh_causal_local_dispatched_buried_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedInWindowAutoLaunchTask(meshId, SESSION_ID)
      appendLedgerEntry(meshId, {
        kind: 'task_dispatched',
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        providerType: 'codex-cli',
        payload: { taskId: task.id, message: 'do worktree work', source: 'direct' },
      })
      for (let i = 0; i < 260; i++) {
        appendLedgerEntry(meshId, {
          kind: 'session_launched',
          nodeId: 'node-other',
          payload: { source: 'unrelated_traffic', seq: i },
        })
      }
      const { components, emit, setMeshFor } = makeLocalComponents()
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'done',
        taskId: task.id,
        timestamp: Date.now(),
      })

      // Gate passed via the alternate (task_dispatched) signal even though it was buried —
      // same observable proof as the un-buried variant above.
      const idleSessions = MeshRuntimeStore.getInstance().getRemoteIdleSessions(meshId)
      expect(idleSessions.some(s => s.sessionId === SESSION_ID)).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT suppress a completion for a task already claimed (assigned) — narrow scope regression guard', () => {
    const meshId = `mesh_causal_local_assigned_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = enqueueTask(meshId, 'assigned work', { taskMode: 'code_change',
    difficulty: 'medium',
})
      const store = MeshRuntimeStore.getInstance()
      const entry = store.findQueueEntryById(meshId, task.id)!
      entry.status = 'assigned'
      entry.assignedNodeId = NODE_ID
      entry.assignedSessionId = SESSION_ID
      // Give it an autoLaunch record too — claimed tasks are no longer 'pending', so the gate's
      // status filter must exclude this row even though autoLaunch still names the session.
      entry.autoLaunch = { status: 'completed', nodeId: NODE_ID, providerType: 'codex-cli', sessionId: SESSION_ID, updatedAt: new Date().toISOString() }
      store.updateQueueEntry(entry)

      const { components, emit, setMeshFor } = makeLocalComponents()
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'real work done',
        taskId: task.id,
        timestamp: Date.now(),
      })

      // The already-claimed task's genuine completion is recorded normally (not blocked by the gate).
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('completed')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

describe('CAUSAL-COMPLETION-GATE — REMOTE forwarding (handleMeshForwardEvent)', () => {
  it('suppresses a remote-forwarded agent:generating_completed for an in-window unclaimed auto-launch task', () => {
    const meshId = `mesh_causal_remote_suppress_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedInWindowAutoLaunchTask(meshId, SESSION_ID)
      const components = makeRemoteComponents()

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'done',
        timestamp: Date.now(),
      })

      expect((result as any).suppressed).toBe(true)
      expect((result as any).autoLaunchCausalGateFailed).toBe(true)
      const completed = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(completed).toHaveLength(0)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('accepts a remote-forwarded completion once the delivery was consumed', () => {
    const meshId = `mesh_causal_remote_delivered_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedInWindowAutoLaunchTask(meshId, SESSION_ID)
      createSessionDelivery({
        meshId, nodeId: NODE_ID, sessionId: SESSION_ID, providerType: 'codex-cli',
        taskId: task.id, kind: 'task', message: 'do worktree work', status: 'delivered',
      })
      const components = makeRemoteComponents()

      // Remote worker's generating_started forwarded first — acks the delivery.
      const startedResult = handleMeshForwardEvent(components, {
        event: 'agent:generating_started',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        taskId: task.id,
        timestamp: Date.now(),
      })
      expect((startedResult as any).suppressed).not.toBe(true)
      expect(MeshRuntimeStore.getInstance().taskDeliveryConsumed(meshId, task.id)).toBe(true)

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'done',
        taskId: task.id,
        timestamp: Date.now(),
      })

      expect((result as any).autoLaunchCausalGateFailed).not.toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('suppression is bounded to the AUTO_LAUNCH_AWAIT_CLAIM_MS window — an expired autoLaunch record no longer gates', () => {
    const meshId = `mesh_causal_remote_expired_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedInWindowAutoLaunchTask(meshId, SESSION_ID, 200_000) // far past the 90s window
      const components = makeRemoteComponents()

      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'done',
        timestamp: Date.now(),
      })

      expect((result as any).autoLaunchCausalGateFailed).not.toBe(true)
      void task
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
