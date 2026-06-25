import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// NOTIF-MISS regression: reconcile early-synthesis suppresses real completion notifications.
//
// When a task is dispatched DIRECTLY to an already-idle, previously-used session
// (mesh_send_task), the reconcile loop's transcript reconciliation could SYNTHESIZE a
// "missing completion" ~1s after dispatch from the session's stale transcript tail (the prior
// turn's final assistant message). When the REAL completion fired minutes later, the coordinator's
// suppression gate dropped it as a duplicate of the synthesized one (stable providerSessionId /
// matching finalSummary) — so the coordinator never learned the task finished.
//
// Three fixes, asserted below:
//   FIX 1 — grace period: reconcileDirectDispatchCompletionFromTranscript refuses to synthesize a
//           completion within the grace window after dispatch (longer for idle-session dispatches).
//   FIX 2 — a SYNTHESIZED (reconciled) terminal must NEVER suppress the authoritative REAL
//           provider completion of the same session.
//   FIX 3 — the completion event preserves its taskId end-to-end (top-level + meshActiveTaskId
//           fallback) so dedup stays task-scoped.

const testTmpDir = path.join(tmpdir(), `adhdev-notif-miss-test-${randomUUID().slice(0, 8)}`)
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
  handleMeshForwardEvent,
  reconcileDirectDispatchCompletionFromTranscript,
} from '../../src/mesh/mesh-events.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  insertDirectDispatch,
  getActiveDirectDispatches,
} from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, readLedgerEntries, appendLedgerEntry } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

const NODE_ID = 'node_child_1'
const SESSION_ID = 'runtime-session-1'
const WORKSPACE = '/repo/worktree-a'

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
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

// Seed a direct-dispatch ledger entry + dispatch-store row for `taskId`, dispatched
// `ageMs` milliseconds ago. dispatchedToIdleSession marks the idle-session race case.
// The public appendLedgerEntry always stamps `now`, so the BACKDATED task_dispatched ledger
// entry (whose timestamp the grace gate reads via findDirectDispatchLedgerEntry) is written
// straight to the runtime store with an explicit timestamp.
function seedDispatch(meshId: string, taskId: string, opts: { ageMs: number; dispatchedToIdleSession: boolean }) {
  const dispatchedAt = new Date(Date.now() - opts.ageMs).toISOString()
  MeshRuntimeStore.getInstance().appendLedgerEntry({
    id: `dispatch-${taskId}`,
    meshId,
    timestamp: dispatchedAt,
    kind: 'task_dispatched',
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    providerType: 'claude-code',
    payload: {
      source: 'direct',
      taskId,
      providerType: 'claude-code',
      targetSessionId: SESSION_ID,
      dispatchedToIdleSession: opts.dispatchedToIdleSession,
    },
  })
  insertDirectDispatch(meshId, {
    taskId,
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    providerType: 'claude-code',
    message: 'do the task',
    via: 'local_direct',
    dispatchedToIdleSession: opts.dispatchedToIdleSession,
    dispatchedAt,
  } as any)
}

function makeComponents() {
  // No live coordinator instance needed for the suppression / ledger assertions; the
  // forward path records the terminal ledger entry regardless of inject targets.
  const instanceManager = {
    getInstance: vi.fn(() => undefined),
    getByCategory: vi.fn(() => []),
    onEvent: vi.fn(),
  }
  return { instanceManager } as any
}

describe('NOTIF-MISS: reconcile early-synthesis must not suppress real completions', () => {
  // ── FIX 1: grace period on early synthesis ────────────────────────────────
  it('FIX 1: does NOT synthesize a completion for a direct dispatch within the idle-session grace window', () => {
    const meshId = `mesh_notifmiss_grace_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      // Dispatched 1s ago to an IDLE session — the exact race. Grace must hold it back.
      seedDispatch(meshId, taskId, { ageMs: 1_000, dispatchedToIdleSession: true })

      const result = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-1',
        taskId,
        finalSummary: 'prior turn summary (stale transcript tail)',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })

      expect(result.reconciled).toBe(false)
      expect(result.reason).toBe('direct_dispatch_grace_period')
      // No synthesized terminal was written.
      expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('FIX 1: SYNTHESIZES the completion once the grace window has elapsed (backstop still works)', () => {
    const meshId = `mesh_notifmiss_grace_elapsed_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      // Dispatched well past both grace windows (5 min ago) — a genuinely-lost completion.
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000, dispatchedToIdleSession: true })

      const result = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-1',
        taskId,
        finalSummary: 'this task is actually done',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })

      expect(result.reconciled).toBe(true)
      expect(result.kind).toBe('task_completed')
      const synthesized = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
      expect(synthesized?.payload.source).toBe('daemon_reconcile_transcript_completion')
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('FIX 1: a non-idle-session direct dispatch uses the shorter grace window', () => {
    const meshId = `mesh_notifmiss_grace_short_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      // 90s ago, NOT an idle-session dispatch → past the 60s short grace, synthesizes.
      seedDispatch(meshId, taskId, { ageMs: 90_000, dispatchedToIdleSession: false })

      const result = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-2',
        taskId,
        finalSummary: 'done',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(result.reconciled).toBe(true)

      // The SAME 90s age, but dispatched to an IDLE session, is still inside the 120s idle grace.
      const meshId2 = `${meshId}_idle`
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId2, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId2 = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId2, taskId2, { ageMs: 90_000, dispatchedToIdleSession: true })
      const idleResult = reconcileDirectDispatchCompletionFromTranscript({
        meshId: meshId2,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-3',
        taskId: taskId2,
        finalSummary: 'done',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(idleResult.reconciled).toBe(false)
      expect(idleResult.reason).toBe('direct_dispatch_grace_period')
      cleanupMeshFiles(meshId2)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  // ── FIX 2: a synthesized terminal must not suppress the real completion ────
  it('FIX 2: a real generating_completed is NOT suppressed by a prior SYNTHESIZED completion for the same session', () => {
    const meshId = `mesh_notifmiss_nosuppress_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }] })
      const taskId = `task-${randomUUID().slice(0, 8)}`

      // Dispatched long ago so the grace permits the (pre-fix-style) early synthesis to land,
      // creating the synthesized terminal that historically masked the real event.
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000, dispatchedToIdleSession: true })
      const synth = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-shared',
        taskId,
        finalSummary: 'shared summary',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(synth.reconciled).toBe(true)
      // Synthesis flipped the dispatch row terminal → no active assignment (the suppression
      // precondition the bug runs under).
      expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(false)

      const components = makeComponents()
      // The REAL provider completion arrives — SAME providerSessionId (stable) and SAME
      // finalSummary as the synthesized one. Pre-fix this was dropped as a duplicate.
      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-shared',
        finalSummary: 'shared summary',
        taskId,
        timestamp: Date.now(),
        source: 'agent_status_event',
      })

      // Not suppressed — the real event was processed, not dropped.
      expect((result as any).suppressed).not.toBe(true)
      // And the authoritative real completion was recorded (a second task_completed appears,
      // this one NOT tagged as a reconcile synthesis).
      const completed = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(completed.length).toBeGreaterThanOrEqual(2)
      const realTerminal = completed.find(e => e.payload.source !== 'daemon_reconcile_transcript_completion')
      expect(realTerminal).toBeTruthy()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('FIX 2: a SECOND synthesized (reconciled) completion is still deduped (no regression)', () => {
    const meshId = `mesh_notifmiss_synthdup_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }] })
      const taskId = `task-${randomUUID().slice(0, 8)}`

      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000, dispatchedToIdleSession: true })
      reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-synthdup',
        taskId,
        finalSummary: 'shared summary',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      const before = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed').length

      // A re-injected RECONCILIATION (carries a reconcile source) — NOT a real provider event.
      const components = makeComponents()
      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-synthdup',
        finalSummary: 'shared summary',
        taskId,
        source: 'daemon_reconcile_transcript_completion',
      })
      expect((result as any).suppressed).toBe(true)
      const after = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed').length
      expect(after).toBe(before)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  // ── FIX 3: taskId is preserved on the forwarded event ─────────────────────
  it('FIX 3: a real completion that carries its taskId is attributed to that task (not suppressed against a different task)', () => {
    const meshId = `mesh_notifmiss_taskid_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }] })

      // A PRIOR task's real terminal is on the ledger for this session.
      const priorTaskId = `task-prior-${randomUUID().slice(0, 8)}`
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        payload: {
          event: 'agent:generating_completed',
          taskId: priorTaskId,
          providerSessionId: 'claude-history-stable',
          finalSummary: 'prior task summary',
        },
      } as any)

      const components = makeComponents()
      // A NEW task's real completion arrives carrying its taskId only as meshActiveTaskId
      // (the worker-stamped carrier). FIX 3 surfaces it as taskId so the distinct-task path
      // recognises it as a different task and never dedups it against the prior terminal.
      const newTaskId = `task-new-${randomUUID().slice(0, 8)}`
      const result = handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-stable', // SAME stable session id as prior
        finalSummary: 'new task summary',
        meshActiveTaskId: newTaskId, // taskId carried only via meshActiveTaskId
        timestamp: Date.now(),
        source: 'agent_status_event',
      })

      expect((result as any).suppressed).not.toBe(true)
      const newTerminal = readLedgerEntries(meshId).find(
        e => e.kind === 'task_completed' && e.payload.taskId === newTaskId,
      )
      expect(newTerminal).toBeTruthy()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
