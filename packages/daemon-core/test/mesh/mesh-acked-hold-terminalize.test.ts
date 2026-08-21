import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// ACKED-HOLD-DEATH-SIGNAL-TERMINALIZE (mission 91af0cc5) regression.
//
// The defect, confirmed against the live preview daemon's runtime DB before any code was
// written:
//
//   mesh_queue             33bd2a3c → 'cancelled'
//   mesh_direct_dispatches 33bd2a3c → 'acked'          ← drives the loop
//   mesh_inflight_hold     read_failure_count = 20810  ← and still climbing
//
// PHASE 4's read-failure death signal LOGGED that it was "releasing the indefinite synth
// hold to the stranded-reclaim / orphan-prune nets" and then `continue`d. It released
// nothing: no hold delete, no dispatch-row flip, no call into either named net. The log was
// false, and the falseness is what made the incident hard to diagnose — the ledger said the
// handoff happened.
//
// It could not self-terminate either. ACKED_DEATH_CONSECUTIVE_READ_FAILURES is a LOWER
// bound (>= 3): once crossed the condition is true forever, and the counter only resets on a
// SUCCESSFUL read, which a vanished session can never produce. Unlike the queue-side sibling
// (QUEUE_HOLD_HARD_DEADLINE_MS, 90min) there was no elapsed-time ceiling at all.
//
// Four fixes are covered here:
//   1. the death signal TERMINALIZES (dispatch row → 'stale', hold row deleted) and says so;
//   2. an absolute time ceiling bounds an acked hold regardless of failure count;
//   4. a node absent from mesh.nodes is classified GONE, not local (it was falling through
//      `!nodeDaemonId` into this daemon's own commandHandler, manufacturing the very read
//      failures that fed the death signal);
//   + the over-correction guard: a LIVE session's transient read failures must still HOLD.

const testTmpDir = path.join(tmpdir(), `adhdev-acked-terminalize-test-${randomUUID().slice(0, 8)}`)
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

import { reconcileUnterminatedDirectDispatches, __resetNonIdleEscapeTracksForTests } from '../../src/mesh/mesh-completion-synthesis.js'
import { __resetReconcileInFlightSynthDebounceForTests, getHoldState } from '../../src/mesh/mesh-reconcile-acked-hold.js'
import { __resetReclaimUnknownStreakForTests } from '../../src/mesh/mesh-reconcile-loop.js'
import {
  __resetMeshRuntimeStoreForTests,
  __clearMeshQueueForTests,
  insertDirectDispatch,
  getActiveDirectDispatches,
  updateDirectDispatchStatus,
} from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'

const NODE_ID = 'node_worker_gone'
const SESSION_ID = 'sess-acked-terminalize'
const WORKSPACE = '/repo/worktree-acked'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
  __resetReclaimUnknownStreakForTests()
  __resetNonIdleEscapeTracksForTests()
  meshConfigMocks.listMeshes.mockReturnValue([])
  meshConfigMocks.getMesh.mockReset()
  for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
    const p = path.join(getLedgerDir(), `${meshId}${suffix}`)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
}

afterEach(() => {
  delete process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS
  delete process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS
  delete process.env.MESH_INFLIGHT_ACKED_HOLD_HARD_CEILING_MS
})

/** Seed a dispatch row + its task_dispatched ledger entry, dispatched `ageMs` ago. */
function seedDispatch(meshId: string, taskId: string, ageMs: number, nodeId = NODE_ID) {
  const dispatchedAt = new Date(Date.now() - ageMs).toISOString()
  MeshRuntimeStore.getInstance().appendLedgerEntry({
    id: `dispatch-${taskId}`,
    meshId,
    timestamp: dispatchedAt,
    kind: 'task_dispatched',
    nodeId,
    sessionId: SESSION_ID,
    providerType: 'kimi',
    payload: { source: 'direct', taskId, providerType: 'kimi', targetSessionId: SESSION_ID },
  })
  insertDirectDispatch(meshId, {
    taskId,
    nodeId,
    sessionId: SESSION_ID,
    providerType: 'kimi',
    message: 'do the task',
    via: 'local_direct',
    dispatchedAt,
  } as any)
  return dispatchedAt
}

/**
 * PHASE 4 driver. `readChat` decides the probe outcome; `withLiveInstance` controls whether
 * the session resolves on this daemon (the fix-4 axis — a gone node with no live session
 * must NOT be treated as local).
 */
function makeComponents(opts: { readChat: (cmd: string) => any; withLiveInstance?: boolean }) {
  const worker: any = {
    category: 'cli',
    getState: () => ({ instanceId: SESSION_ID, status: 'idle', type: 'kimi', settings: { meshNodeId: NODE_ID } }),
    hasLiveTurnPendingEvidence: vi.fn(() => false),
  }
  const live = opts.withLiveInstance === true
  return {
    instanceManager: {
      getInstance: vi.fn((id: string) => (live && id === SESSION_ID ? worker : undefined)),
      getByCategory: vi.fn((category: string) => (category === 'cli' && live ? [worker] : [])),
    },
    commandHandler: { handle: vi.fn(opts.readChat) },
  } as any
}

const meshWithNode = (meshId: string) => ({ id: meshId, nodes: [{ id: NODE_ID, workspace: WORKSPACE }] }) as any
/** The incident shape: the dispatch's node is no longer a member of the mesh. */
const meshWithoutNode = (meshId: string) => ({ id: meshId, nodes: [] as any[] }) as any

function activeTaskIds(meshId: string) {
  return getActiveDirectDispatches(meshId).map(d => d.taskId)
}
function terminalizedEntries(meshId: string) {
  return readLedgerEntries(meshId).filter(e => e.kind === 'acked_hold_terminalized')
}
function completionsQueued(meshId: string) {
  return getPendingMeshCoordinatorEvents(meshId).filter(e => e.event === 'agent:generating_completed')
}

// A read that always fails — the vanished-session shape.
const failingRead = () => async (cmd: string) => (cmd === 'read_chat' ? { success: false, error: 'CDP not connected' } : { success: true })

describe('ACKED-HOLD-TERMINALIZE: the death signal does what it says', () => {
  // ── Fix 1 (core) ────────────────────────────────────────────────────────────
  it('terminalizes the dispatch row and deletes the hold once the read-failure streak crosses the threshold', async () => {
    const meshId = `mesh_acked_death_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)

      // The node IS still in the mesh here, so the read is genuinely attempted and fails —
      // isolating fix 1 from fix 4.
      const mesh = meshWithNode(meshId)

      // Tick 1: a successful read establishes liveConfirmedSinceAck (the death signal's
      // precondition — we only call a session dead if we once saw it alive).
      let alive = true
      const components = makeComponents({
        withLiveInstance: true,
        readChat: async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          if (!alive) return { success: false, error: 'CDP not connected' }
          return { success: true, status: 'generating', providerSessionId: 'kimi-1', messages: [] }
        },
      })
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)
      expect(getHoldState(`${meshId}::${taskId}`, meshId)?.liveConfirmedSinceAck).toBe(true)

      // The worker session vanishes. Failures 1 and 2 must NOT terminalize — the threshold is
      // a streak, so a transient blip is still just a blip.
      alive = false
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)
      expect(getHoldState(`${meshId}::${taskId}`, meshId)?.consecutiveReadFailures).toBe(2)

      // Failure 3 crosses ACKED_DEATH_CONSECUTIVE_READ_FAILURES → terminalize.
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      // The row left the ACTIVE set (status 'stale') — this is the step whose absence made
      // the loop infinite.
      expect(activeTaskIds(meshId)).not.toContain(taskId)
      // The hold row is gone from BOTH the Map cache and the store.
      expect(getHoldState(`${meshId}::${taskId}`, meshId)).toBeUndefined()
      expect(MeshRuntimeStore.getInstance().getInflightHold(taskId)).toBeNull()

      // An audit record naming the reason, so the next occurrence is diagnosable from the
      // ledger rather than re-derived from symptoms.
      const audit = terminalizedEntries(meshId)
      expect(audit).toHaveLength(1)
      expect((audit[0].payload as any).reason).toBe('acked_read_failure_death')
      expect((audit[0].payload as any).consecutiveReadFailures).toBe(3)

      // ★ NO completion is asserted: the worker is gone, the transcript never showed a
      // result, and a timeout is never completion evidence.
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Fix 1: the loop actually STOPS ─────────────────────────────────────────
  it('stops re-probing after terminalization — the read-failure counter cannot climb again', async () => {
    const meshId = `mesh_acked_loopstop_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)
      const mesh = meshWithNode(meshId)

      let alive = true
      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        if (!alive) return { success: false, error: 'CDP not connected' }
        return { success: true, status: 'generating', providerSessionId: 'kimi-1', messages: [] }
      })
      const components = makeComponents({ withLiveInstance: true, readChat })

      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)
      alive = false
      for (let i = 0; i < 3; i++) await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).not.toContain(taskId)

      // 20 further ticks — the shape that reached read_failure_count = 20810 live.
      const callsAtTerminalize = readChat.mock.calls.length
      for (let i = 0; i < 20; i++) await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      // Not one further probe, and no resurrected hold row.
      expect(readChat.mock.calls.length).toBe(callsAtTerminalize)
      expect(getHoldState(`${meshId}::${taskId}`, meshId)).toBeUndefined()
      expect(MeshRuntimeStore.getInstance().getInflightHold(taskId)).toBeNull()
      // And exactly one audit record — terminalization is not re-emitted per tick.
      expect(terminalizedEntries(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Fix 2: the time ceiling ────────────────────────────────────────────────
  it('terminalizes on the absolute time ceiling even when the read keeps SUCCEEDING (no failure streak at all)', async () => {
    const meshId = `mesh_acked_ceiling_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)
      const mesh = meshWithNode(meshId)

      // A worker that reads `generating` forever with a MOVING tail: it re-arms the escape
      // anchor every tick, never fails a read, and so never arms the death streak. Before the
      // ceiling this hold had no upper bound whatsoever — the class the ceiling closes.
      let tick = 0
      const components = makeComponents({
        withLiveInstance: true,
        readChat: async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          tick += 1
          return {
            success: true,
            status: 'generating',
            providerSessionId: 'kimi-1',
            messages: [{ role: 'assistant', content: `working ${tick}`, timestamp: Date.now() }],
          }
        },
      })

      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      // Still holding, with zero read failures — the ceiling is the only thing that can end it.
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(getHoldState(`${meshId}::${taskId}`, meshId)?.consecutiveReadFailures).toBe(0)

      // Backdate the hold anchor past the ceiling (the live row had been held for hours).
      // held_at is insert-once — upsertInflightHold deliberately preserves it on conflict —
      // so the existing row must be dropped first for the backdate to take.
      const ceilingMs = 90 * 60_000
      MeshRuntimeStore.getInstance().deleteInflightHold(taskId)
      MeshRuntimeStore.getInstance().upsertInflightHold({
        taskId, meshId, holdReason: 'live', heldAt: Date.now() - (ceilingMs + 60_000), readFailureCount: 0,
      })
      __resetReconcileInFlightSynthDebounceForTests() // force a store re-read of the anchor

      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      expect(activeTaskIds(meshId)).not.toContain(taskId)
      const audit = terminalizedEntries(meshId)
      expect(audit).toHaveLength(1)
      expect((audit[0].payload as any).reason).toBe('acked_hold_time_ceiling')
      expect((audit[0].payload as any).ceilingMs).toBe(ceilingMs)
      expect((audit[0].payload as any).heldMs).toBeGreaterThanOrEqual(ceilingMs)
      // Still no completion asserted.
      expect(completionsQueued(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('does not apply the ceiling to a hold that is still within it', async () => {
    const meshId = `mesh_acked_underceiling_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)
      const mesh = meshWithNode(meshId)
      const components = makeComponents({
        withLiveInstance: true,
        readChat: async (cmd: string) => (cmd === 'read_chat'
          ? { success: true, status: 'generating', providerSessionId: 'kimi-1', messages: [] }
          : { success: true }),
      })

      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      // Held for 30min — well under the 90min ceiling. (held_at is insert-once, so drop first.)
      MeshRuntimeStore.getInstance().deleteInflightHold(taskId)
      MeshRuntimeStore.getInstance().upsertInflightHold({
        taskId, meshId, holdReason: 'live', heldAt: Date.now() - 30 * 60_000, readFailureCount: 0,
      })
      __resetReconcileInFlightSynthDebounceForTests()

      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // ── Fix 4: a gone node is not local ────────────────────────────────────────
  it('classifies a node absent from mesh.nodes as GONE — never routing its dispatch into this daemon\'s local handler', async () => {
    const meshId = `mesh_acked_gone_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)

      // No live local session, and the node is NOT in mesh.nodes — the incident shape.
      const readChat = vi.fn(failingRead())
      const components = makeComponents({ withLiveInstance: false, readChat })

      for (let i = 0; i < 5; i++) {
        await reconcileUnterminatedDirectDispatches(components, meshWithoutNode(meshId), [], 'daemon-local')
      }

      // ★ The local commandHandler was never consulted for this session: pre-fix, `!nodeDaemonId`
      // made a gone node look local and every tick manufactured a `CDP not connected` failure.
      expect(readChat).not.toHaveBeenCalled()
      // And because nothing was probed, no death signal was fabricated: no hold, no streak.
      expect(getHoldState(`${meshId}::${taskId}`, meshId)).toBeUndefined()
      expect(terminalizedEntries(meshId)).toHaveLength(0)
      // The row is left for the orphan prune, which owns "node no longer in live mesh".
      expect(activeTaskIds(meshId)).toContain(taskId)
    } finally {
      cleanup(meshId)
    }
  })

  it('still reads a session that is live on THIS daemon even when its node is missing from mesh.nodes', async () => {
    const meshId = `mesh_acked_gone_but_live_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)

      const readChat = vi.fn(async (cmd: string) => (cmd === 'read_chat'
        ? { success: true, status: 'generating', providerSessionId: 'kimi-1', messages: [] }
        : { success: true }))
      // withLiveInstance: the session IS instantiated here — positive evidence that beats the
      // node table, so the gone verdict must yield to it.
      const components = makeComponents({ withLiveInstance: true, readChat })

      await reconcileUnterminatedDirectDispatches(components, meshWithoutNode(meshId), [], 'daemon-local')
      expect(readChat).toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  // ── Over-correction guard ──────────────────────────────────────────────────
  it('★ HOLDS a LIVE session through transient read failures — a recovered read resets the streak and never terminalizes', async () => {
    const meshId = `mesh_acked_transient_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)
      const mesh = meshWithNode(meshId)

      let failing = false
      const components = makeComponents({
        withLiveInstance: true,
        readChat: async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          if (failing) return { success: false, error: 'transient transport blip' }
          return { success: true, status: 'generating', providerSessionId: 'kimi-1', messages: [] }
        },
      })

      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)

      // Two consecutive failures — one short of the threshold.
      failing = true
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(getHoldState(`${meshId}::${taskId}`, meshId)?.consecutiveReadFailures).toBe(2)
      expect(activeTaskIds(meshId)).toContain(taskId)

      // The blip clears: the worker was alive all along.
      failing = false
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(getHoldState(`${meshId}::${taskId}`, meshId)?.consecutiveReadFailures).toBe(0)

      // Two MORE failures must not terminalize — the streak restarted from zero, so a worker
      // that keeps recovering is never torn off its turn.
      failing = true
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('does not terminalize a NEVER-ACKED dispatch on read failures — there is no in-flight turn to declare dead', async () => {
    const meshId = `mesh_neveracked_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)
      const mesh = meshWithNode(meshId)
      const components = makeComponents({ withLiveInstance: true, readChat: failingRead() })

      // Status stays 'dispatched' (never acked) across many failing ticks.
      for (let i = 0; i < 6; i++) await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })
})
