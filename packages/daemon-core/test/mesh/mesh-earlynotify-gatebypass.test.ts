import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// EARLYNOTIFY-GATEBYPASS: the transcript-reconcile / no-progress / fast-collapse synth producers
// each emit a coordinator "completed and is now idle" WITHOUT the CLI-provider completion gate.
// This file asserts the convergence guarantees added for that class of bypass:
//   (1) a mid-turn synth from a plain-text tail is marked WEAK so it never claims the genuine
//       dedup slot — a later REAL genuine completion for the same task still surfaces;
//   (2) a self-attributing final_summary_json synth stays GENUINE;
//   (3) every synth path records a completion-gate trace (the bypass can never be silent).

const testTmpDir = path.join(tmpdir(), `adhdev-earlynotify-gatebypass-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
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

import { reconcileDirectDispatchCompletionFromTranscript, handleMeshForwardEvent } from '../../src/mesh/mesh-events.js'
import { buildNoProgressCompletionReconciliation } from '../../src/mesh/mesh-events-stale.js'
import {
  buildPendingEventFingerprint,
  drainPendingMeshCoordinatorEvents,
  getPendingMeshCoordinatorEvents,
  __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  insertDirectDispatch,
} from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import {
  clearDebugTrace,
  configureDebugTraceStore,
  getRecentDebugTrace,
} from '../../src/logging/debug-trace.js'
import { setDebugRuntimeConfig, resetDebugRuntimeConfig } from '../../src/logging/debug-config.js'

const NODE_ID = 'node_child_1'
const SESSION_ID = 'runtime-session-1'
const WORKSPACE = '/repo/worktree-a'

function cleanupMeshFiles(meshId: string) {
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  const ledgerPath = path.join(getLedgerDir(), `${meshId}.jsonl`)
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  try { __clearMeshPendingEventsForTests(meshId) } catch { /* best-effort */ }
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

// Seed a direct-dispatch dispatched `ageMs` ago (past both grace windows by default).
function seedDispatch(meshId: string, taskId: string, ageMs: number) {
  const dispatchedAt = new Date(Date.now() - ageMs).toISOString()
  MeshRuntimeStore.getInstance().appendLedgerEntry({
    id: `dispatch-${taskId}`,
    meshId,
    timestamp: dispatchedAt,
    kind: 'task_dispatched',
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    providerType: 'claude-code',
    payload: { source: 'direct', taskId, providerType: 'claude-code', targetSessionId: SESSION_ID, dispatchedToIdleSession: true },
  })
  insertDirectDispatch(meshId, {
    taskId, nodeId: NODE_ID, sessionId: SESSION_ID, providerType: 'claude-code',
    message: 'do the task', via: 'local_direct', dispatchedToIdleSession: true, dispatchedAt,
  } as any)
}

function makeComponents() {
  return { instanceManager: { getInstance: vi.fn(() => undefined), getByCategory: vi.fn(() => []), onEvent: vi.fn() } } as any
}

describe('EARLYNOTIFY-GATEBYPASS: converge synth completions through the gate', () => {
  // (c)/(2): a plain-text transcript-reconcile synth is WEAK, and the later REAL genuine
  // completion for the same task is NOT dropped as a duplicate — both surface.
  it('a premature weak synth (plain-text tail) does NOT swallow the later genuine completion', () => {
    const meshId = `mesh_gatebypass_weak_then_genuine_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }] })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)

      const synth = reconcileDirectDispatchCompletionFromTranscript({
        meshId, nodeId: NODE_ID, sessionId: SESSION_ID, providerType: 'claude-code',
        providerSessionId: 'claude-history-1', taskId,
        finalSummary: 'plain-text tail that might be a prior/mid-turn narration',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(synth.reconciled).toBe(true)

      // The queued synth completion is WEAK → its fingerprint ends `::weak`, leaving the
      // `::genuine` slot free.
      const synthEvent = getPendingMeshCoordinatorEvents(meshId).find(e => e.event === 'agent:generating_completed')
      expect(synthEvent).toBeTruthy()
      expect(buildPendingEventFingerprint(synthEvent!)).toMatch(/::weak$/)

      // The worker's REAL genuine completion (no weak marker, carries a real summary) arrives.
      handleMeshForwardEvent(makeComponents(), {
        event: 'agent:generating_completed', meshId, nodeId: NODE_ID, targetSessionId: SESSION_ID,
        providerType: 'claude-code', providerSessionId: 'claude-history-1',
        finalSummary: 'the authoritative final answer', taskId, timestamp: Date.now(),
        source: 'agent_status_event',
      })

      // Draining yields the GENUINE completion (distinct `::genuine` fingerprint) — it was not
      // dropped as a duplicate of the earlier weak synth.
      const drained = drainPendingMeshCoordinatorEvents(meshId)
      const genuine = drained.find(e =>
        e.event === 'agent:generating_completed' && buildPendingEventFingerprint(e).endsWith('::genuine'))
      expect(genuine).toBeTruthy()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  // (c): a self-attributing final_summary_json synth stays GENUINE (it proved turn-finality).
  it('a self-attributing final_summary_json synth stays genuine', () => {
    const meshId = `mesh_gatebypass_selfattrib_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)

      const synth = reconcileDirectDispatchCompletionFromTranscript({
        meshId, nodeId: NODE_ID, sessionId: SESSION_ID, providerType: 'claude-code',
        providerSessionId: 'claude-history-json', taskId,
        // Worker-result-shaped JSON → resolveWorkerResult tags it final_summary_json (self-attributing).
        finalSummary: '{"status":"completed","nextAction":"done","changedFiles":[]}',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(synth.reconciled).toBe(true)
      const synthEvent = getPendingMeshCoordinatorEvents(meshId).find(e => e.event === 'agent:generating_completed')
      expect(synthEvent).toBeTruthy()
      expect(buildPendingEventFingerprint(synthEvent!)).toMatch(/::genuine$/)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  // (d): the transcript-reconcile synth records a completion-gate trace.
  it('the transcript-reconcile synth records a completion-gate synth-fire trace', () => {
    const meshId = `mesh_gatebypass_trace_reconcile_${Date.now()}`
    setDebugRuntimeConfig({ logLevel: 'debug', collectDebugTrace: true, traceContent: true, traceBufferSize: 200, traceCategories: [] })
    configureDebugTraceStore()
    clearDebugTrace()
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)

      reconcileDirectDispatchCompletionFromTranscript({
        meshId, nodeId: NODE_ID, sessionId: SESSION_ID, providerType: 'claude-code',
        providerSessionId: 'claude-history-trace', taskId, finalSummary: 'done',
        transcriptMessageAt: new Date().toISOString(), source: 'daemon_reconcile_transcript_completion',
      })

      const traces = getRecentDebugTrace({ category: 'completion-gate' })
        .filter(t => t.stage === 'synth-fire' && t.payload?.producer === 'transcript_reconcile')
      expect(traces.length).toBeGreaterThanOrEqual(1)
      expect(traces[traces.length - 1].payload?.taskId).toBe(taskId)
      // Content-free: no worker/screen text leaks into the trace payload.
      expect(Object.keys(traces[0].payload ?? {})).not.toContain('finalSummary')
    } finally {
      resetDebugRuntimeConfig()
      configureDebugTraceStore()
      cleanupMeshFiles(meshId)
    }
  })

  // (c)/(d): the no-progress reconcile marks a bare-status completion WEAK and traces it.
  it('the no-progress reconcile marks a bare-status idle completion weak and records a trace', () => {
    setDebugRuntimeConfig({ logLevel: 'debug', collectDebugTrace: true, traceContent: true, traceBufferSize: 200, traceCategories: [] })
    configureDebugTraceStore()
    clearDebugTrace()
    try {
      const reconciled = buildNoProgressCompletionReconciliation({
        meshId: 'mesh-noprog',
        nodeId: NODE_ID,
        nodeLabel: `Node '${NODE_ID}'`,
        // Bare status:'idle' with NO finalSummary / workerResult → weakest "done" evidence.
        metadataEvent: { targetSessionId: SESSION_ID, taskId: 'task-noprog', status: 'idle', providerType: 'codex-cli' },
      })
      expect(reconciled?.source).toBe('no_progress_reconciliation')
      expect(reconciled?.evidenceLevel).toBe('weak')

      const traces = getRecentDebugTrace({ category: 'completion-gate' })
        .filter(t => t.stage === 'synth-fire' && t.payload?.producer === 'no_progress_reconcile')
      expect(traces.length).toBeGreaterThanOrEqual(1)
      expect(traces[traces.length - 1].payload?.evidenceLevel).toBe('weak')
    } finally {
      resetDebugRuntimeConfig()
      configureDebugTraceStore()
    }
  })

  // (c): a no-progress reconcile WITH a real summary stays genuine (self-attributing).
  it('the no-progress reconcile with a real summary stays genuine', () => {
    const reconciled = buildNoProgressCompletionReconciliation({
      meshId: 'mesh-noprog2',
      nodeId: NODE_ID,
      nodeLabel: `Node '${NODE_ID}'`,
      metadataEvent: { targetSessionId: SESSION_ID, taskId: 'task-noprog2', status: 'idle', finalSummary: 'actually done', providerType: 'codex-cli' },
    })
    expect(reconciled?.source).toBe('no_progress_reconciliation')
    expect(reconciled?.evidenceLevel).toBeUndefined()
  })
})
