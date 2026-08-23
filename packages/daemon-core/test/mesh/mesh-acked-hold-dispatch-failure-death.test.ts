import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// DISPATCH-FAILURE-DEATH-SIGNAL (2026-08-23) regression.
//
// THE DEFECT. The acked-hold axis was structurally BLIND to dispatch failures. When a dispatch
// failed with 'CLI agent not running: kimi' — the adapter map's own authoritative statement that
// no worker exists for the target session — that fact was recorded ONLY on the queue axis, as a
// `dispatch_failed` ledger row that is not a member of MeshLedgerKind, carries no top-level
// taskId, and has zero readers anywhere in src. It never reached the hold, so the hold went on
// probing a session that provably did not exist.
//
// Measured live 2026-08-22: three consecutive `dispatch_failed: "CLI agent not running: kimi"`
// while the hold ran to the 90-min ceiling at 5,405,993ms. The worker had been provably absent
// for roughly the last 57 of those 90 minutes. The evidence existed the entire time; nothing was
// listening for it.
//
// THE FIX is a NEW, EARLIER signal — not a retuning of the ceiling. Coverage here:
//   1. a streak of worker-absence dispatch failures terminalizes the hold early;
//   2. ★ the 90-min ceiling still fires as the last-resort backstop for holds this does not cover;
//   3. ★ a TRANSIENT failure never kills a task — this is the core over-correction guard;
//   4. the reason allow-list: only positively-absent reasons count, everything else resets;
//   5. no completion is ever asserted (a dead worker did not finish);
//   6. a never-acked dispatch is left to the queue axis's own dispatch-failure budget.

const testTmpDir = path.join(tmpdir(), `adhdev-dispatch-death-test-${randomUUID().slice(0, 8)}`)
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
import {
  __resetReconcileInFlightSynthDebounceForTests,
  __resetAckedHoldDispatchFailureStreakForTests,
  recordAckedHoldDispatchOutcome,
  getAckedHoldDispatchFailureStreak,
  isWorkerAbsenceDispatchFailure,
  getHoldState,
  ACKED_DEATH_CONSECUTIVE_DISPATCH_FAILURES,
} from '../../src/mesh/mesh-reconcile-acked-hold.js'
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

const NODE_ID = 'node_worker_absent'
const SESSION_ID = 'sess-dispatch-death'
const WORKSPACE = '/repo/worktree-dispatch-death'

/** The incident's exact error text. */
const ABSENT = 'CLI agent not running: kimi'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
  __resetReclaimUnknownStreakForTests()
  __resetNonIdleEscapeTracksForTests()
  __resetAckedHoldDispatchFailureStreakForTests()
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

function activeTaskIds(meshId: string) {
  return getActiveDirectDispatches(meshId).map(d => d.taskId)
}
function terminalizedEntries(meshId: string) {
  return readLedgerEntries(meshId).filter(e => e.kind === 'acked_hold_terminalized')
}
function completionsQueued(meshId: string) {
  return getPendingMeshCoordinatorEvents(meshId).filter(e => e.event === 'agent:generating_completed')
}

/**
 * A worker that keeps reading `generating` with a MOVING tail. This is the incident's holding
 * shape: it never fails a read, so the read-failure death signal can never arm, and it re-arms
 * the escape anchor every tick. Before this change, the 90-min ceiling was the ONLY thing that
 * could end such a hold.
 */
function foreverGeneratingComponents() {
  let tick = 0
  return makeComponents({
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
}

/** Drive a task to an established acked hold, then return its ids. */
async function establishAckedHold(meshId: string, components: any) {
  const taskId = `task-${randomUUID().slice(0, 8)}`
  seedDispatch(meshId, taskId, 5 * 60_000)
  const mesh = meshWithNode(meshId)
  await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
  updateDirectDispatchStatus(meshId, SESSION_ID, 'acked', taskId)
  return { taskId, mesh }
}

// ───────────────────────────────────────────────────────────────────────────
// The reason allow-list (pure predicate — no harness needed)
// ───────────────────────────────────────────────────────────────────────────
describe('DISPATCH-FAILURE-DEATH-SIGNAL: which reasons prove worker absence', () => {
  it('admits ONLY the reasons where the transport positively resolved the target and found no worker', () => {
    // Included: the adapter map is authoritative that nothing is there.
    expect(isWorkerAbsenceDispatchFailure('CLI agent not running: kimi')).toBe(true)
    expect(isWorkerAbsenceDispatchFailure('CLI agent not running: claude')).toBe(true)
    expect(isWorkerAbsenceDispatchFailure("No provider instance for session 'sess-1' — cannot deliver multipart input for agent 'kimi'")).toBe(true)
    expect(isWorkerAbsenceDispatchFailure("No mesh worker session bound to node 'node_x' for agent 'kimi' on this daemon; refusing provider-only fuzzy match to avoid cross-node dispatch")).toBe(true)
    // Case-insensitive: the text crosses a P2P boundary that preserves only `message`.
    expect(isWorkerAbsenceDispatchFailure('cli agent NOT RUNNING: kimi')).toBe(true)
  })

  it('★ EXCLUDES every transient/transport/permanent-but-not-absence reason — the full enumeration', () => {
    const notDeath = [
      // Timeouts: the worker may be alive and merely wedged. A timeout is never positive
      // evidence of absence.
      'dispatch_confirm_timeout after 120000ms',
      'timeout',
      // Transport down — worker fate unknown, and these routinely recover.
      'p2p_timeout',
      'p2p_no_route',
      'p2p_not_connected',
      'p2p_datachannel_closed',
      'p2p_unavailable',
      // Target daemon unreachable: often death, but owned by the daemon-liveness /
      // orphan-prune axis, not this one. Claiming it here would double-own it.
      'p2p_daemon_offline',
      'daemon_mesh_target_offline',
      // The OPPOSITE of death: positive proof a live session is already working the task.
      'Refusing duplicate mesh dispatch: task abc is already being worked by a live session on this daemon',
      // Payload is unacceptable — says nothing about whether the worker exists.
      'message required for send_chat',
      "Provider 'kimi' does not support image input",
      // Routing/logic defects, already terminal by their own path.
      "Refusing to send mesh command to this daemon's own id",
      'mesh_logic_or_provider_failure',
    ]
    for (const reason of notDeath) {
      expect(isWorkerAbsenceDispatchFailure(reason), `must NOT be a death signal: ${reason}`).toBe(false)
    }
  })

  it('defaults an unknown/empty reason to NOT-death, so a future failure reason is never a death signal by omission', () => {
    expect(isWorkerAbsenceDispatchFailure('some brand new failure mode nobody has seen')).toBe(false)
    expect(isWorkerAbsenceDispatchFailure('')).toBe(false)
    expect(isWorkerAbsenceDispatchFailure(undefined)).toBe(false)
    expect(isWorkerAbsenceDispatchFailure(null)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The streak: only an UNBROKEN run of absence advances it
// ───────────────────────────────────────────────────────────────────────────
describe('DISPATCH-FAILURE-DEATH-SIGNAL: streak accounting', () => {
  const MESH = 'mesh_streak_unit'
  const TASK = 'task_streak_unit'
  afterEach(() => __resetAckedHoldDispatchFailureStreakForTests())

  it('advances only on worker-absence failures', () => {
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    expect(getAckedHoldDispatchFailureStreak(MESH, TASK)?.count).toBe(2)
    expect(getAckedHoldDispatchFailureStreak(MESH, TASK)?.lastReason).toBe(ABSENT)
  })

  it('★ a SUCCESS resets the run — a worker that recovers can never accumulate toward death', () => {
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: true })
    expect(getAckedHoldDispatchFailureStreak(MESH, TASK)).toBeUndefined()
    // And the run restarts from scratch, so 2 + 2 never reaches the threshold of 3.
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    expect(getAckedHoldDispatchFailureStreak(MESH, TASK)?.count).toBe(2)
  })

  it('★ a NON-absence failure also resets the run — an outage interleaved with absence is not a death run', () => {
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, TASK, { ok: false, reason: 'p2p_timeout' })
    expect(getAckedHoldDispatchFailureStreak(MESH, TASK)).toBeUndefined()
  })

  it('keeps streaks per-task — one dead worker does not implicate another task', () => {
    recordAckedHoldDispatchOutcome(MESH, 'task-a', { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, 'task-a', { ok: false, reason: ABSENT })
    recordAckedHoldDispatchOutcome(MESH, 'task-b', { ok: false, reason: ABSENT })
    expect(getAckedHoldDispatchFailureStreak(MESH, 'task-a')?.count).toBe(2)
    expect(getAckedHoldDispatchFailureStreak(MESH, 'task-b')?.count).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// End-to-end through the reconcile loop
// ───────────────────────────────────────────────────────────────────────────
describe('DISPATCH-FAILURE-DEATH-SIGNAL: the hold ends early on proven worker absence', () => {
  // ── Core: the signal fires ────────────────────────────────────────────────
  it('terminalizes the hold once the absence streak crosses the threshold — WITHOUT waiting for the 90min ceiling', async () => {
    const meshId = `mesh_dispatch_death_${Date.now()}`
    try {
      const components = foreverGeneratingComponents()
      const { taskId, mesh } = await establishAckedHold(meshId, components)

      // The hold is live and well inside the ceiling — the ceiling cannot be what ends this.
      expect(activeTaskIds(meshId)).toContain(taskId)
      const heldSinceMs = getHoldState(`${meshId}::${taskId}`, meshId)?.heldSinceMs
      expect(Date.now() - (heldSinceMs ?? Date.now())).toBeLessThan(5 * 60_000)

      // Failures 1 and 2 must NOT terminalize — the threshold is a streak.
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)

      // Failure 3 crosses the threshold.
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      // The row left the ACTIVE set, and the hold is gone from both cache and store.
      expect(activeTaskIds(meshId)).not.toContain(taskId)
      expect(getHoldState(`${meshId}::${taskId}`, meshId)).toBeUndefined()
      expect(MeshRuntimeStore.getInstance().getInflightHold(taskId)).toBeNull()

      // An audit record naming the reason and the evidence it acted on.
      const audit = terminalizedEntries(meshId)
      expect(audit).toHaveLength(1)
      expect((audit[0].payload as any).reason).toBe('acked_dispatch_failure_death')
      expect((audit[0].payload as any).consecutiveDispatchFailures).toBe(ACKED_DEATH_CONSECUTIVE_DISPATCH_FAILURES)
      expect((audit[0].payload as any).lastReason).toBe(ABSENT)

      // ★ NO completion is asserted: the worker is gone and the transcript never showed a
      // result. A death signal is not completion evidence.
      expect(completionsQueued(meshId)).toHaveLength(0)
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('stops re-probing after terminalization — the hold does not resurrect', async () => {
    const meshId = `mesh_dispatch_death_loopstop_${Date.now()}`
    try {
      const components = foreverGeneratingComponents()
      const { taskId, mesh } = await establishAckedHold(meshId, components)

      for (let i = 0; i < ACKED_DEATH_CONSECUTIVE_DISPATCH_FAILURES; i++) {
        recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      }
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).not.toContain(taskId)

      const callsAtTerminalize = components.commandHandler.handle.mock.calls.length
      for (let i = 0; i < 20; i++) {
        await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      }
      expect(components.commandHandler.handle.mock.calls.length).toBe(callsAtTerminalize)
      expect(getHoldState(`${meshId}::${taskId}`, meshId)).toBeUndefined()
      // Exactly one audit record — terminalization is not re-emitted per tick.
      expect(terminalizedEntries(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('clears the streak on terminalization, so a re-dispatched task does not inherit the dead run', async () => {
    const meshId = `mesh_dispatch_death_rearm_${Date.now()}`
    try {
      const components = foreverGeneratingComponents()
      const { taskId, mesh } = await establishAckedHold(meshId, components)
      for (let i = 0; i < ACKED_DEATH_CONSECUTIVE_DISPATCH_FAILURES; i++) {
        recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      }
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).not.toContain(taskId)

      // The synth key is task-scoped: without the clear, a re-dispatch of this same task id
      // would inherit a count of 3 and die on its very first failure.
      expect(getAckedHoldDispatchFailureStreak(meshId, taskId)).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  // ── ★ Over-correction guard: transient failures must NOT kill the task ────
  it('★ HOLDS through TRANSIENT dispatch failures — a transport outage never terminalizes', async () => {
    const meshId = `mesh_dispatch_transient_${Date.now()}`
    try {
      const components = foreverGeneratingComponents()
      const { taskId, mesh } = await establishAckedHold(meshId, components)

      // Ten consecutive transport failures — far past the threshold in COUNT, but not one of
      // them proves the worker is absent. The hold must survive all of them.
      for (const reason of [
        'p2p_timeout', 'p2p_no_route', 'dispatch_confirm_timeout after 120000ms',
        'timeout', 'p2p_datachannel_closed', 'p2p_not_connected', 'p2p_unavailable',
        'p2p_daemon_offline', 'mesh_logic_or_provider_failure', 'message required for send_chat',
      ]) {
        recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason })
        await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      }

      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)
      expect(completionsQueued(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('★ HOLDS when absence failures are INTERRUPTED by a recovery — the run must be unbroken', async () => {
    const meshId = `mesh_dispatch_recovers_${Date.now()}`
    try {
      const components = foreverGeneratingComponents()
      const { taskId, mesh } = await establishAckedHold(meshId, components)

      // Two absences, a success, then two more absences. Five failures' worth of noise, but
      // never three IN A ROW — the worker kept proving it was there.
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: true })
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('does not terminalize a NEVER-ACKED dispatch — its redelivery belongs to the queue axis budget', async () => {
    const meshId = `mesh_dispatch_neveracked_${Date.now()}`
    try {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      seedDispatch(meshId, taskId, 5 * 60_000)
      const mesh = meshWithNode(meshId)
      const components = foreverGeneratingComponents()

      // Status stays 'dispatched' (never acked) — there is no in-flight turn to declare dead.
      for (let i = 0; i < ACKED_DEATH_CONSECUTIVE_DISPATCH_FAILURES + 2; i++) {
        recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: ABSENT })
        await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      }

      expect(activeTaskIds(meshId)).toContain(taskId)
      expect(terminalizedEntries(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // ── ★ The ceiling remains the last-resort backstop ────────────────────────
  it('★ the 90min ceiling STILL fires for a hold the dispatch signal does not cover (no dispatch failures at all)', async () => {
    const meshId = `mesh_ceiling_still_last_resort_${Date.now()}`
    try {
      const components = foreverGeneratingComponents()
      const { taskId, mesh } = await establishAckedHold(meshId, components)

      // Not a single dispatch failure is recorded — the new signal is entirely silent here.
      expect(getAckedHoldDispatchFailureStreak(meshId, taskId)).toBeUndefined()
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      expect(activeTaskIds(meshId)).toContain(taskId)

      // Backdate the hold anchor past the ceiling (held_at is insert-once — drop first).
      const ceilingMs = 90 * 60_000
      MeshRuntimeStore.getInstance().deleteInflightHold(taskId)
      MeshRuntimeStore.getInstance().upsertInflightHold({
        taskId, meshId, holdReason: 'live', heldAt: Date.now() - (ceilingMs + 60_000), readFailureCount: 0,
      })
      __resetReconcileInFlightSynthDebounceForTests()

      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      // ★ The ceiling is untouched by this change and still ends the hold.
      expect(activeTaskIds(meshId)).not.toContain(taskId)
      const audit = terminalizedEntries(meshId)
      expect(audit).toHaveLength(1)
      expect((audit[0].payload as any).reason).toBe('acked_hold_time_ceiling')
      expect((audit[0].payload as any).ceilingMs).toBe(ceilingMs)
      expect(completionsQueued(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('★ the ceiling still fires even when TRANSIENT failures have been accruing the whole time', async () => {
    const meshId = `mesh_ceiling_with_transients_${Date.now()}`
    try {
      const components = foreverGeneratingComponents()
      const { taskId, mesh } = await establishAckedHold(meshId, components)

      // A permanently-unreachable transport: never a death signal, so the hold is carried all
      // the way to the ceiling — which must still be there to catch it.
      for (let i = 0; i < 5; i++) {
        recordAckedHoldDispatchOutcome(meshId, taskId, { ok: false, reason: 'p2p_timeout' })
        await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')
      }
      expect(activeTaskIds(meshId)).toContain(taskId)

      const ceilingMs = 90 * 60_000
      MeshRuntimeStore.getInstance().deleteInflightHold(taskId)
      MeshRuntimeStore.getInstance().upsertInflightHold({
        taskId, meshId, holdReason: 'live', heldAt: Date.now() - (ceilingMs + 60_000), readFailureCount: 0,
      })
      __resetReconcileInFlightSynthDebounceForTests()
      await reconcileUnterminatedDirectDispatches(components, mesh, [], 'daemon-local')

      expect(activeTaskIds(meshId)).not.toContain(taskId)
      expect((terminalizedEntries(meshId)[0].payload as any).reason).toBe('acked_hold_time_ceiling')
    } finally {
      cleanup(meshId)
    }
  })
})
