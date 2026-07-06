import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// NOTIF-DROP-SYNTH-NO-MESSAGE regression.
//
// Root cause: a FAST direct dispatch (mesh_send_task) to a reused idle session has its
// completion SYNTHESIZED by the transcript-reconcile (~8s before the native completion fires).
// The synthesized pending event used to be queued with coordinatorMessage=undefined and no
// targetCoordinatorSessionId, so:
//   1. The reconcile-loop drain consumed the row (drained=1) but injectPendingIntoCoordinator
//      early-returned on `!pending.coordinatorMessage` → drain-without-inject → no [System].
//   2. ~8s later the native completion (which DOES carry a message) collided on the
//      taskId-anchored fingerprint (idx_mesh_pending_events_fingerprint UNIQUE) and was blocked
//      at INSERT → the notification was lost forever.
//
// Fix asserted here:
//   - The synthesized completion now carries a complete [System] coordinatorMessage
//     (buildMeshSystemMessage) so it is itself deliverable, AND a targetCoordinatorSessionId
//     recovered from the task_dispatched ledger payload (STRICT routing).
//   - synth-then-native for the same taskId: the completion notification still reaches the
//     coordinator (the synth surfaced it; the native dedup is then harmless).

const testTmpDir = path.join(tmpdir(), `adhdev-notif-drop-synth-test-${randomUUID().slice(0, 8)}`)
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
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  insertDirectDispatch,
} from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import {
  drainPendingMeshCoordinatorEvents,
  getPendingMeshCoordinatorEvents,
  __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

const NODE_ID = 'node_child_1'
const SESSION_ID = 'runtime-session-1'
const WORKSPACE = '/repo/worktree-a'
const COORDINATOR_SESSION_ID = 'coordinator-session-abc'

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

// Seed a direct-dispatch ledger entry + dispatch-store row dispatched `ageMs` ago, with the
// originating coordinator session stamped on the task_dispatched payload (as the MCP dispatch
// path does). The backdated ledger entry is written straight to the runtime store so the grace
// gate (which reads findDirectDispatchLedgerEntry) sees the intended dispatch age.
function seedDispatch(meshId: string, taskId: string, opts: { ageMs: number; coordinatorSessionId?: string; coordinatorDaemonId?: string }) {
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
      dispatchedToIdleSession: true,
      ...(opts.coordinatorSessionId ? { coordinatorSessionId: opts.coordinatorSessionId } : {}),
      ...(opts.coordinatorDaemonId ? { coordinatorDaemonId: opts.coordinatorDaemonId } : {}),
    },
  })
  insertDirectDispatch(meshId, {
    taskId,
    nodeId: NODE_ID,
    sessionId: SESSION_ID,
    providerType: 'claude-code',
    message: 'do the task',
    via: 'local_direct',
    dispatchedToIdleSession: true,
    dispatchedAt,
  } as any)
}

function makeComponents() {
  const instanceManager = {
    getInstance: vi.fn(() => undefined),
    getByCategory: vi.fn(() => []),
    onEvent: vi.fn(),
  }
  return { instanceManager } as any
}

describe('NOTIF-DROP-SYNTH-NO-MESSAGE: reconcile-synthesized completion must carry a deliverable message', () => {
  it('transcript-reconcile synth completion carries coordinatorMessage and injects the [System] notification', () => {
    const meshId = `mesh_synth_message_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      // Past both grace windows so the synth actually fires.
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000, coordinatorSessionId: COORDINATOR_SESSION_ID })

      const result = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-synth',
        taskId,
        finalSummary: 'the worker actually finished the task',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(result.reconciled).toBe(true)

      // The queued pending completion now carries a non-empty [System] coordinatorMessage and the
      // originating coordinator session recovered from the dispatch ledger payload (STRICT route).
      const peeked = getPendingMeshCoordinatorEvents(meshId)
      const synthEvent = peeked.find(e => e.event === 'agent:generating_completed')
      expect(synthEvent).toBeTruthy()
      expect(synthEvent!.coordinatorMessage).toBeTruthy()
      expect(synthEvent!.coordinatorMessage).toContain('[System]')
      // The worker's final summary is surfaced directly so the coordinator need not read_chat.
      expect(synthEvent!.coordinatorMessage).toContain('the worker actually finished the task')
      expect(synthEvent!.targetCoordinatorSessionId).toBe(COORDINATOR_SESSION_ID)

      // A drain delivers a deliverable event — i.e. injectPendingIntoCoordinator would NOT
      // early-return on a missing coordinatorMessage (the drain-without-inject loss).
      const drained = drainPendingMeshCoordinatorEvents(meshId)
      const drainedCompletion = drained.find(e => e.event === 'agent:generating_completed')
      expect(drainedCompletion).toBeTruthy()
      expect(drainedCompletion!.coordinatorMessage).toBeTruthy()
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('COORD-EVENT-MISROUTE: synth recovers the DISPATCHING coordinator daemon anchor from the ledger, overriding the caller self-id', () => {
    const meshId = `mesh_synth_daemon_anchor_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const COORDINATOR_DAEMON_ID = 'daemon_mach_coordinatorAAAAAAAAAAAAAAAAAAAA'
      // The WORKER's own daemon — this is what mesh-completion-synthesis passes as
      // targetCoordinatorDaemonId (selfIds), the pre-fix anchor corruption on a remote worker.
      const WORKER_SELF_DAEMON_ID = 'daemon_mach_workerselfBBBBBBBBBBBBBBBBBBBB'
      // The dispatch ledger records BOTH the coordinator session AND daemon anchor.
      seedDispatch(meshId, taskId, {
        ageMs: 5 * 60_000,
        coordinatorSessionId: COORDINATOR_SESSION_ID,
        coordinatorDaemonId: COORDINATOR_DAEMON_ID,
      })

      const result = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-daemon-anchor',
        taskId,
        finalSummary: 'the worker finished on a remote node',
        transcriptMessageAt: new Date().toISOString(),
        // The synth caller supplies the WORKER's self-daemon — the ledger recovery must WIN.
        targetCoordinatorDaemonId: WORKER_SELF_DAEMON_ID,
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(result.reconciled).toBe(true)

      // The completion is anchored to the DISPATCHING coordinator (ledger), NOT the worker self-id,
      // so it stays unicast-addressed to that coordinator instead of broadcasting to any coordinator.
      const synthEvent = getPendingMeshCoordinatorEvents(meshId).find(e => e.event === 'agent:generating_completed')
      expect(synthEvent).toBeTruthy()
      expect(synthEvent!.targetCoordinatorDaemonId).toBe(COORDINATOR_DAEMON_ID)
      expect(synthEvent!.targetCoordinatorDaemonId).not.toBe(WORKER_SELF_DAEMON_ID)
      expect(synthEvent!.targetCoordinatorSessionId).toBe(COORDINATOR_SESSION_ID)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('COORD-EVENT-MISROUTE: with no ledger daemon anchor, the caller-supplied daemon id is used (legacy fallback, no regression)', () => {
    const meshId = `mesh_synth_daemon_fallback_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      const CALLER_DAEMON_ID = 'daemon_mach_callerCCCCCCCCCCCCCCCCCCCCCCCC'
      // Legacy ledger row: no coordinatorDaemonId stamped.
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000, coordinatorSessionId: COORDINATOR_SESSION_ID })

      const result = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-fallback',
        taskId,
        finalSummary: 'legacy dispatch completed',
        transcriptMessageAt: new Date().toISOString(),
        targetCoordinatorDaemonId: CALLER_DAEMON_ID,
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(result.reconciled).toBe(true)

      const synthEvent = getPendingMeshCoordinatorEvents(meshId).find(e => e.event === 'agent:generating_completed')
      expect(synthEvent).toBeTruthy()
      // Absent ledger anchor → the caller-supplied daemon id drives routing (unchanged behaviour).
      expect(synthEvent!.targetCoordinatorDaemonId).toBe(CALLER_DAEMON_ID)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })

  it('synth-then-native same-taskId: completion notification is not silently lost', () => {
    const meshId = `mesh_synth_then_native_${Date.now()}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }], policy: {} })
      meshConfigMocks.getMeshByRepo.mockReturnValue({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }] })
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, { ageMs: 5 * 60_000, coordinatorSessionId: COORDINATOR_SESSION_ID })

      // 1) The synth fires FIRST (the ~8s-early transcript reconcile) and queues a deliverable
      //    completion carrying the [System] message.
      const synth = reconcileDirectDispatchCompletionFromTranscript({
        meshId,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-shared',
        taskId,
        finalSummary: 'shared completion summary',
        transcriptMessageAt: new Date().toISOString(),
        source: 'daemon_reconcile_transcript_completion',
      })
      expect(synth.reconciled).toBe(true)
      const afterSynth = getPendingMeshCoordinatorEvents(meshId)
        .find(e => e.event === 'agent:generating_completed')
      expect(afterSynth?.coordinatorMessage).toBeTruthy()

      // 2) The native completion (same taskId) arrives ~8s later. It collides on the
      //    taskId-anchored fingerprint, so it does NOT add a second deliverable surface — but
      //    that is harmless because the synth already carries the [System] notification.
      const components = makeComponents()
      handleMeshForwardEvent(components, {
        event: 'agent:generating_completed',
        meshId,
        nodeId: NODE_ID,
        targetSessionId: SESSION_ID,
        providerType: 'claude-code',
        providerSessionId: 'claude-history-shared',
        finalSummary: 'shared completion summary',
        taskId,
        timestamp: Date.now(),
        source: 'agent_status_event',
      })

      // The completion notification is surfaceable exactly once: draining the queue yields a
      // generating_completed event WITH a coordinatorMessage. Pre-fix this was empty (synth) and
      // the native one never reached the queue → permanently lost.
      const drained = drainPendingMeshCoordinatorEvents(meshId)
      const deliverableCompletions = drained.filter(
        e => e.event === 'agent:generating_completed' && !!e.coordinatorMessage,
      )
      expect(deliverableCompletions.length).toBeGreaterThanOrEqual(1)
      expect(deliverableCompletions[0].coordinatorMessage).toContain('[System]')

      // A terminal completion was recorded for the task (the notification path is not lost).
      const completed = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
      expect(completed.some(e => e.payload.taskId === taskId)).toBe(true)
    } finally {
      cleanupMeshFiles(meshId)
    }
  })
})
