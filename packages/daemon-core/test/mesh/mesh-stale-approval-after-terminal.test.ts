import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// TERMINAL-STALE-APPROVAL-PROJECTION (two live incidents: M1 queue task b1b412f8 /
// session 4ef94751 and Linux task d7050a53 / session 59095107).
//
// A worker emitted its FULL final result; the completion was recorded — yet a LATE (or
// stale sticky-overlay re-synthesized) agent:waiting_approval arriving AFTER the terminal
// re-pinned every projection surface to awaiting_approval: mesh_list_pending_approvals
// offered the session while mesh_approve against it failed "Not in approval state" (the
// provider exposed NO current matching modal — raw PTY confirmed none). The stale
// projection also deferred the reclaim/redrive the terminal had already earned.
//
// The invariant: an actionable approval/choice may remain projected only while the
// provider exposes a CURRENT matching modal. Once terminal authority exists for the task
// (terminal turn stage / terminal queue row / non-weak terminal ledger entry), a late
// waiting_approval / waiting_choice naming that task is stale by construction and must be
// suppressed BEFORE any side effect (mirror update, ledger append, turn-stage write,
// coordinator forward). A GENUINE approval always precedes the terminal — never touched.
// Choice stays distinct from approval (each suppressed as its own kind, never remapped).
//
// Harness mirrors mesh-autolaunch-causal-completion-gate.test.ts: BOTH forwarding entry
// points (LOCAL setupMeshEventForwarding + REMOTE handleMeshForwardEvent).

const testTmpDir = path.join(tmpdir(), `adhdev-stale-approval-test-${randomUUID().slice(0, 8)}`)
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
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getActiveDirectDispatches, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { appendLedgerEntry, getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { buildMeshActiveWork, collectPendingApprovals } from '../../src/mesh/mesh-active-work.js'

const NODE_ID = 'node_worker_1'
const SESSION_ID = 'stale-approval-session-1'
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

// Seed an ASSIGNED queue task bound to SESSION_ID (the claim already happened).
function seedAssignedTask(meshId: string, message = 'do the queued work') {
  const task = enqueueTask(meshId, message, { taskMode: 'code_change' })
  const store = MeshRuntimeStore.getInstance()
  const entry = store.findQueueEntryById(meshId, task.id)!
  entry.status = 'assigned'
  entry.assignedNodeId = NODE_ID
  entry.assignedSessionId = SESSION_ID
  store.updateQueueEntry(entry)
  return task
}

function makeRemoteComponents() {
  return {
    instanceManager: {
      getInstance: vi.fn(() => undefined),
      getByCategory: vi.fn(() => []),
      onEvent: vi.fn(),
    },
  } as any
}

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

function remoteCompletion(meshId: string, taskId: string, extra: Record<string, unknown> = {}) {
  return handleMeshForwardEvent(makeRemoteComponents(), {
    event: 'agent:generating_completed',
    meshId,
    nodeId: NODE_ID,
    targetSessionId: SESSION_ID,
    providerType: 'codex-cli',
    finalSummary: 'full final PASS report',
    taskId,
    timestamp: Date.now(),
    ...extra,
  })
}

function remoteEvent(meshId: string, event: string, taskId: string, extra: Record<string, unknown> = {}) {
  return handleMeshForwardEvent(makeRemoteComponents(), {
    event,
    meshId,
    nodeId: NODE_ID,
    targetSessionId: SESSION_ID,
    providerType: 'codex-cli',
    modalMessage: 'Allow Bash command?',
    modalButtons: ['1. Yes', '2. No'],
    taskId,
    timestamp: Date.now(),
    ...extra,
  })
}

describe('STALE-APPROVAL-AFTER-TERMINAL — REMOTE forwarding (handleMeshForwardEvent)', () => {
  it('(incident A/B) a late agent:waiting_approval AFTER the committed completion is fully suppressed — no ledger, no projection, no redrive', () => {
    const meshId = `mesh_stale_apr_remote_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedAssignedTask(meshId)

      // 1. The worker's genuine completion lands first and commits terminal authority.
      remoteCompletion(meshId, task.id)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('completed')
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed').length).toBeGreaterThanOrEqual(1)

      // 2. The LATE approval (stale sticky re-synthesis / reordered event) arrives.
      const late = remoteEvent(meshId, 'agent:waiting_approval', task.id)
      expect((late as any).suppressed).toBe(true)
      expect((late as any).staleApprovalAfterTerminal).toBe(true)

      // No task_approval_needed ledger level state was appended after the terminal.
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_approval_needed')).toHaveLength(0)
      // The queue row stays terminal — no redelivery / redrive / reclaim is proposed.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('completed')
      expect(getQueue(meshId, { status: ['pending', 'assigned'] })).toHaveLength(0)
      // The projection never offers it to mesh_approve.
      const activeWork = buildMeshActiveWork({
        meshId,
        queue: getQueue(meshId),
        ledgerEntries: readLedgerEntries(meshId, { tail: 200 }),
        directDispatches: getActiveDirectDispatches(meshId),
        nodes: [{ id: NODE_ID, sessions: [{ id: SESSION_ID, providerType: 'codex-cli', status: 'waiting_approval' }] }],
      })
      expect(collectPendingApprovals(activeWork.activeWork)).toHaveLength(0)
      expect(activeWork.activeWork.some(r => r.status === 'awaiting_approval')).toBe(false)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('a late agent:waiting_choice after terminal is likewise suppressed — as CHOICE, never remapped to approval', () => {
    const meshId = `mesh_stale_choice_remote_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedAssignedTask(meshId)
      remoteCompletion(meshId, task.id)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('completed')

      const late = remoteEvent(meshId, 'agent:waiting_choice', task.id)
      expect((late as any).suppressed).toBe(true)
      expect((late as any).staleApprovalAfterTerminal).toBe(true)
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_question_pending')).toHaveLength(0)
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_approval_needed')).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('(over-suppression guard) a GENUINE approval PRECEDING the completion is forwarded, recorded, and the completion still commits', () => {
    const meshId = `mesh_genuine_apr_remote_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedAssignedTask(meshId)

      // 1. Approval first — no terminal authority exists yet: must NOT be suppressed.
      const approval = remoteEvent(meshId, 'agent:waiting_approval', task.id)
      expect((approval as any).staleApprovalAfterTerminal).not.toBe(true)
      expect((approval as any).suppressed).not.toBe(true)
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_approval_needed')).toHaveLength(1)

      // 2. The genuine completion still commits normally afterwards.
      remoteCompletion(meshId, task.id)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('completed')

      // 3. Only AFTER the terminal does a repeat approval become stale.
      const late = remoteEvent(meshId, 'agent:waiting_approval', task.id)
      expect((late as any).suppressed).toBe(true)
      expect((late as any).staleApprovalAfterTerminal).toBe(true)
      // Still exactly ONE approval ledger entry (the genuine one).
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_approval_needed')).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('a WEAK (false-idle) completion is NOT terminal authority — a following approval is still surfaced', () => {
    const meshId = `mesh_weak_apr_remote_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedAssignedTask(meshId)

      // A weak terminal ledger entry (idle without a confirmed final assistant) — the
      // worker may still be mid-turn, so a subsequent approval can be GENUINE and must
      // not be suppressed. Seeded directly for determinism (the same weak shape the
      // CANON-C decoupled-immediate path records).
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        providerType: 'codex-cli',
        payload: {
          taskId: task.id,
          evidenceLevel: 'insufficient',
          completionDiagnostic: { blockReason: 'missing_final_assistant', finalAssistantPresent: false },
        },
      })

      const approval = remoteEvent(meshId, 'agent:waiting_approval', task.id)
      expect((approval as any).staleApprovalAfterTerminal).not.toBe(true)
      expect((approval as any).suppressed).not.toBe(true)
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_approval_needed')).toHaveLength(1)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})

describe('STALE-APPROVAL-AFTER-TERMINAL — LOCAL forwarding (setupMeshEventForwarding)', () => {
  it('a late waiting_approval from a locally-hosted worker after its completion commits is suppressed identically', () => {
    const meshId = `mesh_stale_apr_local_${Date.now()}`
    try {
      mockMesh(meshId)
      const task = seedAssignedTask(meshId)
      const { components, emit, setMeshFor } = makeLocalComponents()
      setMeshFor(meshId)
      setupMeshEventForwarding(components)

      emit({
        event: 'agent:generating_completed',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        finalSummary: 'full final PASS report',
        taskId: task.id,
        timestamp: Date.now(),
      })
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('completed')

      emit({
        event: 'agent:waiting_approval',
        instanceId: SESSION_ID,
        targetSessionId: SESSION_ID,
        providerType: 'codex-cli',
        modalMessage: 'Allow Bash command?',
        modalButtons: ['1. Yes', '2. No'],
        taskId: task.id,
        timestamp: Date.now(),
      })

      // The late approval wrote no level state and left the terminal row untouched.
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_approval_needed')).toHaveLength(0)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('completed')
      const activeWork = buildMeshActiveWork({
        meshId,
        queue: getQueue(meshId),
        ledgerEntries: readLedgerEntries(meshId, { tail: 200 }),
        directDispatches: getActiveDirectDispatches(meshId),
        nodes: [{ id: NODE_ID, sessions: [{ id: SESSION_ID, providerType: 'codex-cli', status: 'waiting_approval' }] }],
      })
      expect(collectPendingApprovals(activeWork.activeWork)).toHaveLength(0)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
