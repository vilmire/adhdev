import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// NO-DISPATCH-NATIVE-COMPLETION-GATE (rc.16 follow-up).
//
// Verified live defect: a Cursor session that was launched but never given ANY task emitted
// its own native agent:generating_completed off a startup/greeting artifact (cursor-cli's
// "→ Plan, search, build anything" idle prompt right after boot, queued_delivery never
// actually consumed). The WARMUPGAP note on markSessionTerminal already recognized this shape
// (no echoed taskId, no active assignment) but only skipped the dispatch-row side effect — the
// event itself still became a coordinator-visible task_completed, an "insufficient native
// completion" that terminalizes work that was never assigned.
//
// Fix under test: a new suppression clause in evaluateMeshEventSuppression, ordered BEFORE the
// autoLaunch causal gate. Structural/causal only (taskId echo, active assignment, terminal
// ledger history, weak-evidence flag) — no message-content/language heuristics. Scope is
// deliberately narrow:
//   - no taskId on the event
//   - session holds no active assignment (queue OR direct-dispatch)
//   - session has NO terminal ledger history at all (a session dispatched at least once
//     before falls through unchanged to the existing terminal/dedup logic)
//   - the completion evidence is WEAK (false-idle / no confirmed final assistant) — a genuine
//     answer (real final summary / worker result) is never suppressed even without a tracked
//     dispatch, so a real reply is never silently dropped.

const testTmpDir = path.join(tmpdir(), `adhdev-no-dispatch-gate-test-${randomUUID().slice(0, 8)}`)
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

import { setupMeshEventForwarding } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, insertDirectDispatch } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

const NODE_ID = 'node_cursor_1'
const SESSION_ID = 'cursor-session-1'
const WORKSPACE = '/repo/local'

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

function mockMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
  meshConfigMocks.getMeshByRepo.mockReturnValue(undefined)
}

// A fake live CliProviderInstance-shaped source, resolvable by the delegate router (R1's
// resolveWorkerDelegateRouting requires a resolvable instance to route the event at all — a
// harness with NO instance never reaches injectMeshSystemMessage / evaluateMeshEventSuppression
// in the first place, same requirement as the mid-turn-live-state-gate sibling test's
// makeLocalComponents). No hasLiveTurnPendingEvidence method: this gate is independent of the
// mid-turn live-state gate under test elsewhere.
function makeLocalComponents(meshId: string) {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: SESSION_ID,
    workspace: WORKSPACE,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID },
  }
  const source: any = {
    category: 'cli',
    getState: vi.fn(() => sourceState),
    onEvent: vi.fn(),
  }
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
  }
}

function startupGreetingCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: 'agent:generating_completed',
    instanceId: SESSION_ID,
    targetSessionId: SESSION_ID,
    meshNodeId: NODE_ID,
    providerType: 'cursor-cli',
    // No taskId — the session was never dispatched. Weak/false-idle evidence: no real final
    // summary, completionDiagnostic marks the missing final assistant (the startup-greeting
    // shape, not a real answer).
    completionDiagnostic: { finalAssistantPresent: false, blockReason: 'missing_final_assistant' },
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('NO-DISPATCH-NATIVE-COMPLETION-GATE — suppresses a never-dispatched session\'s startup/greeting completion', () => {
  it('suppresses: no taskId, no active assignment, no terminal ledger history, weak evidence (the cursor-cli startup-greeting shape)', () => {
    const meshId = `mesh_no_dispatch_${Date.now()}`
    try {
      mockMesh(meshId)
      const { components, emit } = makeLocalComponents(meshId)
      setupMeshEventForwarding(components)

      emit(startupGreetingCompletedEvent())

      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT suppress a genuine completion with a real final summary, even with no tracked dispatch (a real answer is never silently dropped)', () => {
    const meshId = `mesh_no_dispatch_genuine_${Date.now()}`
    try {
      mockMesh(meshId)
      const { components, emit } = makeLocalComponents(meshId)
      setupMeshEventForwarding(components)

      emit(startupGreetingCompletedEvent({
        finalSummary: 'Here is the real answer to your question.',
        completionDiagnostic: { finalAssistantPresent: true },
      }))

      // Gate did not suppress — execution reached the normal accept path and recorded the
      // completion in the terminal ledger (the universal, unconditional side effect of every
      // unsuppressed agent:generating_completed — EVENT_TO_LEDGER_KIND writes it regardless of
      // evidence strength, so it is reliable even for a WEAK/false-idle completion where the
      // remote-idle-session registration is deliberately skipped).
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT suppress when the event carries a taskId (a real dispatched task, not a startup artifact)', () => {
    const meshId = `mesh_no_dispatch_taskid_${Date.now()}`
    try {
      mockMesh(meshId)
      const { components, emit } = makeLocalComponents(meshId)
      setupMeshEventForwarding(components)

      emit(startupGreetingCompletedEvent({ taskId: 'task-real-1' }))

      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT suppress when the session holds an active queue assignment', () => {
    const meshId = `mesh_no_dispatch_active_queue_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = enqueueTask(meshId, 'do the work', { taskMode: 'code_change' })
      const store = MeshRuntimeStore.getInstance()
      const entry = store.findQueueEntryById(meshId, task.id)!
      entry.status = 'assigned'
      entry.assignedSessionId = SESSION_ID
      entry.assignedNodeId = NODE_ID
      store.updateQueueEntry(entry)

      const { components, emit } = makeLocalComponents(meshId)
      setupMeshEventForwarding(components)

      emit(startupGreetingCompletedEvent())

      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('does NOT suppress when the session holds an active direct dispatch', () => {
    const meshId = `mesh_no_dispatch_active_direct_${Date.now()}`
    try {
      mockMesh(meshId)
      insertDirectDispatch(meshId, {
        taskId: 'direct-task-1',
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'cursor-cli',
        message: 'do the work',
        via: 'test',
        dispatchedAt: new Date().toISOString(),
      })

      const { components, emit } = makeLocalComponents(meshId)
      setupMeshEventForwarding(components)

      emit(startupGreetingCompletedEvent())

      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('falls through unchanged for a session with PRIOR terminal ledger history (a previously-dispatched session is handled by the EXISTING terminal/dedup logic, not this gate)', () => {
    const meshId = `mesh_no_dispatch_prior_terminal_${Date.now()}`
    try {
      mockMesh(meshId)
      const sharedFinalSummary = 'identical final summary — proves the EXISTING dedup matched, not this gate'
      MeshRuntimeStore.getInstance().appendLedgerEntry({
        id: `prior-terminal-1`,
        meshId,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        kind: 'task_completed',
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'cursor-cli',
        payload: { taskId: 'prior-task-1', finalSummary: sharedFinalSummary },
      })

      const { components, emit } = makeLocalComponents(meshId)
      setupMeshEventForwarding(components)

      emit(startupGreetingCompletedEvent({ finalSummary: sharedFinalSummary }))

      // The no-dispatch gate does not apply (prior terminal exists) — the event proceeds to the
      // EXISTING terminal-ledger dedup logic (finalSummary match), which suppresses this as a
      // duplicate. The ledger holds exactly the ONE prior entry — proving control reached the
      // pre-existing dedup clause rather than being caught (or missed) by this new gate.
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('falls through unchanged for a session with PRIOR terminal ledger history AND a distinct new taskId (existing distinct-task-completion logic records the new one, proving this gate did not suppress it)', () => {
    const meshId = `mesh_no_dispatch_prior_terminal_distinct_task_${Date.now()}`
    try {
      mockMesh(meshId)
      MeshRuntimeStore.getInstance().appendLedgerEntry({
        id: `prior-terminal-2`,
        meshId,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        kind: 'task_completed',
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'cursor-cli',
        payload: { taskId: 'prior-task-2', finalSummary: 'earlier real answer' },
      })

      const { components, emit } = makeLocalComponents(meshId)
      setupMeshEventForwarding(components)

      emit(startupGreetingCompletedEvent({
        taskId: 'new-distinct-task-2',
        finalSummary: 'a new genuine answer for a distinct task',
        completionDiagnostic: { finalAssistantPresent: true },
      }))

      // distinctTaskCompletion lets the new, DIFFERENT task's completion through — proving
      // this event reached the existing logic rather than being caught by the no-dispatch gate
      // (which only applies when there is NO prior terminal at all).
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(2)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
