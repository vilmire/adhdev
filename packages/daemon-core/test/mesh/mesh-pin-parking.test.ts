import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// PIN-PARKING + TTL-WHILE-WORKING + ACTIONABLE-SKIP-FINGERPRINT.
//
// Three coupled defects, all observed in one live incident (2026-08-19 09:13:36):
//
//   [WRN] Expired stale target pin on task b186073c… cleared targetSessionId=1cd5155b…
//   [WRN] [drop:target_session_pin_expired] … unclaimed 902s ≥ ttl 900s → pin cleared, claimable
//
// and NOTHING else — a full scan of the 16MB coordinator log found those two lines
// and zero coordinator notifications.
//
// (1) SILENT SUCCESSION. A task pinned with targetSessionId is a DELTA: a correction
//     addressed to work already in flight in one session's context. Clearing the pin
//     did not make it deliverable-elsewhere, it made it WRONGLY deliverable — the
//     delta lands as a context-free instruction on unrelated work. The session-stop
//     path had already decided the opposite ("a pin often encodes required context
//     continuity, so re-targeting is your decision, not the daemon's"); the two paths
//     contradicted each other. Now both hold the pin, and the TTL path PARKS.
//
// (2) THE TTL RAN BACKWARDS. `unclaimed 902s ≥ ttl 900s` — expired by 2 seconds, on
//     the very `agent:ready` where the worker finished a turn. The TTL was wall-clock
//     age, so it ran while the addressee was generating: the harder that session
//     worked, the sooner its pin died. The pin exists to append to that session's
//     context, so this was exactly inverted. Now the clock only advances while the
//     addressee is NOT demonstrably generating.
//
// (3) THE NOTIFICATION WAS SWALLOWED. `target_session_pin_expired` was already in
//     ACTIONABLE_SKIP_REASON_PREFIXES — added after a PRIOR incident of this same
//     class (74 minutes of silence) — and the emit path built the event correctly. It
//     died one layer lower: buildPendingEventFingerprint keys dispatch_blocked on
//     (mesh, event, node, session, task, …) with NO reason and no timestamp, so any
//     still-undrained earlier alert for the same task collapsed onto the same
//     fingerprint and suppressed it at INFO as a "duplicate". The in-memory de-dup in
//     mesh-skip-notify DOES key on reason and correctly let the change through — which
//     is why the gap survived review: the layer everyone reads is correct, and the
//     suppression happens in a layer the reason never reached.

const testTmpDir = path.join(tmpdir(), `adhdev-pin-parking-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn(async () => ({ path: '/usr/bin/codex' })) }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import {
  __clearMeshQueueForTests,
  __resetMeshRuntimeStoreForTests,
  claimNextTask,
  cancelTask,
  failRetentionExpiredParkedTask,
  getParkedTasks,
  getQueue,
  requeueTask,
} from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import {
  __resetTargetPinGeneratingCreditForTests,
  notifyCoordinatorOfActionableSkip,
  resolveTargetPinTtlVerdict,
  isActionableSkipReason,
} from '../../src/mesh/mesh-skip-notify.js'
import {
  PARK_REASON_PIN_EXPIRED,
  PARKED_SKIP_REASON,
  PARKED_TASK_RETENTION_MS,
  taskIsParked,
} from '../../src/mesh/mesh-task-parking.js'
import { drainPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'

const NODE_ID = 'node_main'
const REMOTE_NODE_ID = 'node_remote'
const COORDINATOR_DAEMON_ID = 'test-machine'
const PAST_TTL_AGE_MS = 16 * 60_000

function liveSession(meshId: string, sessionId: string, status: string, nodeId: string = NODE_ID) {
  const state = {
    instanceId: sessionId,
    status,
    workspace: `/repo/${nodeId}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: nodeId },
  }
  return { category: 'cli', getState: () => state }
}

function createComponents(cliInstances: any[] = []) {
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) =>
        command === 'launch_cli' ? { success: true, sessionId: `spawned-${randomUUID().slice(0, 6)}` } : { success: true }),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Pin Parking Mesh',
    policy: {},
    nodes: [
      { id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } },
      { id: REMOTE_NODE_ID, workspace: `/repo/${REMOTE_NODE_ID}`, daemonId: 'remote-daemon', policy: { providerPriority: ['codex-cli'] } },
    ],
  })
}

function task(meshId: string, taskId: string) {
  return getQueue(meshId).find(t => t.id === taskId)
}

/** Insert a pending row directly so createdAt (the TTL anchor) is controllable. */
function insertPendingTask(
  meshId: string,
  opts: { targetNodeId?: string; targetSessionId?: string; ageMs?: number; message?: string; parkedAgeMs?: number },
): { id: string } {
  const id = `task_${randomUUID().slice(0, 8)}`
  const anchor = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id, meshId, message: opts.message ?? 'do work', status: 'pending', taskMode: 'code_change',
    targetNodeId: opts.targetNodeId, targetSessionId: opts.targetSessionId,
    ...(opts.parkedAgeMs !== undefined
      ? {
        parked: {
          reason: PARK_REASON_PIN_EXPIRED,
          parkedAt: new Date(Date.now() - opts.parkedAgeMs).toISOString(),
          targetSessionId: opts.targetSessionId,
          targetNodeId: opts.targetNodeId,
        },
      }
      : {}),
    createdAt: anchor, updatedAt: anchor,
  } as any)
  return { id }
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  __resetTargetPinGeneratingCreditForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

// ───────────────────────────────────────────────────────────────────────────
// (a) TTL expiry PARKS — it does not silently hand the delta to someone else.
// ───────────────────────────────────────────────────────────────────────────
describe('(a) an expired target pin PARKS the task instead of opening it to silent succession', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('parks the row, preserves the original addressee, and keeps it out of every claim path', async () => {
    const meshId = `mesh_park_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([])
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: PAST_TTL_AGE_MS })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(true)
      expect(after.parked?.reason).toBe(PARK_REASON_PIN_EXPIRED)
      // The original address is preserved for the coordinator even though a later
      // re-target will overwrite the live targetSessionId field.
      expect(after.parked?.targetSessionId).toBe('remote-sess')
      expect(after.status).toBe('pending')

      // ★ THE CORE ASSERTION: nobody can claim it. Not a third-party session…
      expect(claimNextTask(meshId, REMOTE_NODE_ID, 'some-other-session', [])).toBeNull()
      // …and not the pinned session either.
      expect(claimNextTask(meshId, REMOTE_NODE_ID, 'remote-sess', [])).toBeNull()
      // …and not an unpinned node-level claimant.
      expect(claimNextTask(meshId, NODE_ID, 'local-session', [])).toBeNull()
    } finally {
      cleanup(meshId)
    }
  })

  it('does not let the dead-target self-heal quietly rescue (and thereby re-home) a parked task', async () => {
    // The self-heal requeues with clearTargetSession:true — on a parked row that
    // would be precisely the silent succession parking exists to prevent, arriving
    // through a different door.
    const meshId = `mesh_park_selfheal_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // Session absent from the LIVE LOCAL node ⇒ the dead-target verdict would fire.
      const components = createComponents([])
      const t = insertPendingTask(meshId, {
        targetNodeId: NODE_ID, targetSessionId: 'dead-session',
        ageMs: PAST_TTL_AGE_MS, parkedAgeMs: 60_000,
      })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(true)
      expect(after.targetSessionId).toBe('dead-session')
      expect(after.requeueCount ?? 0).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('leaves the NORMAL path untouched: a live pinned session still claims its task', async () => {
    // Regression guard for the non-parked case — parking must not cost ordinary
    // pinned delivery anything.
    const meshId = `mesh_park_normal_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([liveSession(meshId, 'live-idle', 'idle')])
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'live-idle' })

      await triggerMeshQueue(components, meshId)
      expect(taskIsParked(task(meshId, t.id)!)).toBe(false)

      const claimed = claimNextTask(meshId, NODE_ID, 'live-idle', [])
      expect(claimed?.id).toBe(t.id)
      expect(claimed?.status).toBe('assigned')
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// (b) The four exits from parking — without these, a park IS a loss.
// ───────────────────────────────────────────────────────────────────────────
describe('(b) a parked task can be inspected, re-targeted, edited and cancelled', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('INSPECT: parked rows are enumerable with their reason and original addressee', () => {
    const meshId = `mesh_exit_view_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'sess-a', parkedAgeMs: 1_000 })
      insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'sess-b' }) // not parked

      const parked = getParkedTasks(meshId)
      expect(parked.map(p => p.id)).toEqual([t.id])
      expect(parked[0].parked?.targetSessionId).toBe('sess-a')
      expect(parked[0].parked?.reason).toBe(PARK_REASON_PIN_EXPIRED)
    } finally {
      cleanup(meshId)
    }
  })

  it('RE-TARGET: requeue onto a new session unparks it and makes it claimable there', () => {
    const meshId = `mesh_exit_retarget_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'stale-sess', parkedAgeMs: 1_000 })

      const requeued = requeueTask(meshId, t.id, { targetSessionId: 'fresh-sess', reason: 'retargeted by coordinator' })
      expect(requeued?.status).toBe('pending')
      expect(taskIsParked(requeued!)).toBe(false)
      expect(requeued?.targetSessionId).toBe('fresh-sess')

      // The stale addressee must NOT be able to take it after the re-target…
      expect(claimNextTask(meshId, NODE_ID, 'stale-sess', [])).toBeNull()
      // …the new one must.
      expect(claimNextTask(meshId, NODE_ID, 'fresh-sess', [])?.id).toBe(t.id)
    } finally {
      cleanup(meshId)
    }
  })

  it('RE-TARGET (unpin): clearing the session pin unparks it for any compatible session', () => {
    const meshId = `mesh_exit_unpin_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'stale-sess', parkedAgeMs: 1_000 })

      const requeued = requeueTask(meshId, t.id, { clearTargetSession: true, reason: 'coordinator released the pin' })
      expect(taskIsParked(requeued!)).toBe(false)
      expect(requeued?.targetSessionId).toBeUndefined()

      // This is silent succession made EXPLICIT — allowed, because the coordinator asked.
      expect(claimNextTask(meshId, NODE_ID, 'any-session', [])?.id).toBe(t.id)
    } finally {
      cleanup(meshId)
    }
  })

  it('EDIT: requeue can REWRITE the instruction, preserving the task id', () => {
    // The reason this exit exists: the situation changing while a delta waits is the
    // normal case, not an edge case (observed: the worker had already completed the
    // part the delta was written to correct). Before this there was NO message
    // mutator on the queue at all.
    const meshId = `mesh_exit_edit_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, {
        targetNodeId: NODE_ID, targetSessionId: 'stale-sess',
        message: 'also handle the null case', parkedAgeMs: 1_000,
      })

      const requeued = requeueTask(meshId, t.id, {
        targetSessionId: 'fresh-sess',
        message: 'the null case is already done — add the regression test instead',
      })
      expect(requeued?.id).toBe(t.id) // identity (and dependents/mission links) preserved
      expect(requeued?.message).toBe('the null case is already done — add the regression test instead')
      expect(taskIsParked(requeued!)).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  it('EDIT: a blank/absent message never blanks the existing instruction', () => {
    const meshId = `mesh_exit_edit_blank_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 's', message: 'original', parkedAgeMs: 1_000 })

      expect(requeueTask(meshId, t.id, { message: '   ' })?.message).toBe('original')
      expect(requeueTask(meshId, t.id, { force: true })?.message).toBe('original')
    } finally {
      cleanup(meshId)
    }
  })

  it('CANCEL: cancelling a parked task is terminal and clears the parked state', () => {
    const meshId = `mesh_exit_cancel_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'stale-sess', parkedAgeMs: 1_000 })

      const cancelled = cancelTask(meshId, t.id, { reason: 'no longer wanted' })
      expect(cancelled?.status).toBe('cancelled')
      expect(taskIsParked(cancelled!)).toBe(false)
      expect(getParkedTasks(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('RETENTION: an abandoned park is FAILED with a stated reason — never silently deleted', async () => {
    // The owner's constraint on cleanup: it must not reintroduce the silent drop
    // parking was built to remove. So the sweep goes terminal-with-a-reason (and the
    // caller pairs it with a coordinator page), leaving an auditable row behind.
    const meshId = `mesh_exit_retention_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, {
        targetNodeId: NODE_ID, targetSessionId: 'stale-sess',
        parkedAgeMs: PARKED_TASK_RETENTION_MS + 60_000,
      })

      const swept = failRetentionExpiredParkedTask(meshId, t.id)
      expect(swept?.status).toBe('failed')
      expect(swept?.cancelReason).toMatch(/parked_task_retention_expired/)
      // The row survives as the audit record — the work's disappearance is legible.
      expect(task(meshId, t.id)).toBeTruthy()
    } finally {
      cleanup(meshId)
    }
  })

  it('RETENTION: a park still inside the window is NOT swept', () => {
    const meshId = `mesh_exit_retention_young_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, {
        targetNodeId: NODE_ID, targetSessionId: 'stale-sess',
        parkedAgeMs: PARKED_TASK_RETENTION_MS - 60_000,
      })
      expect(failRetentionExpiredParkedTask(meshId, t.id)).toBeNull()
      expect(task(meshId, t.id)!.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// (c) A registered actionable reason must actually REACH the coordinator.
// ───────────────────────────────────────────────────────────────────────────
describe('(c) a registered actionable skip reason survives to a delivered coordinator event', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('★ an earlier undrained alert for the SAME task no longer suppresses the pin alert', () => {
    // THE REGRESSION. Pre-fix, buildPendingEventFingerprint omitted the reason, so
    // this second (different-reason) alert collapsed onto the first's fingerprint and
    // was dropped at INFO as a duplicate — which is why the live incident produced
    // two [WRN] log lines and zero notifications despite correct registration.
    const meshId = `mesh_fp_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'sess' })

      notifyCoordinatorOfActionableSkip(meshId, t.id, 'no_node_satisfies_required_tags', NODE_ID)
      notifyCoordinatorOfActionableSkip(meshId, t.id, PARKED_SKIP_REASON, NODE_ID)

      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const reasons = (events || []).map(e => e?.metadataEvent?.reason)
      expect(reasons).toContain('no_node_satisfies_required_tags')
      expect(reasons).toContain(PARKED_SKIP_REASON)
    } finally {
      cleanup(meshId)
    }
  })

  it('still collapses REPEATS of the same reason (the 4s reconcile loop must not spam)', () => {
    const meshId = `mesh_fp_dedup_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'sess' })

      notifyCoordinatorOfActionableSkip(meshId, t.id, PARKED_SKIP_REASON, NODE_ID)
      notifyCoordinatorOfActionableSkip(meshId, t.id, PARKED_SKIP_REASON, NODE_ID)
      notifyCoordinatorOfActionableSkip(meshId, t.id, PARKED_SKIP_REASON, NODE_ID)

      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      expect((events || []).filter(e => e?.metadataEvent?.reason === PARKED_SKIP_REASON)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('END-TO-END: parking a task through the real scan delivers an actionable page naming the exits', async () => {
    const meshId = `mesh_e2e_notify_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: PAST_TTL_AGE_MS })

      await triggerMeshQueue(createComponents([]), meshId)
      expect(taskIsParked(task(meshId, t.id)!)).toBe(true)

      const events = drainPendingMeshCoordinatorEvents(meshId, COORDINATOR_DAEMON_ID) as any[]
      const hit = (events || []).find(e => e?.metadataEvent?.taskId === t.id)
      expect(hit, 'the park must page the coordinator — silence here is the whole defect').toBeTruthy()
      const msg = String(hit.coordinatorMessage)
      expect(msg).toMatch(/PARKED/)
      // A notification with no exit is indistinguishable from a loss, so the page
      // must name the tools that get the coordinator out of parking.
      expect(msg).toMatch(/mesh_queue_requeue/)
      expect(msg).toMatch(/mesh_queue_cancel/)
      expect(msg).toMatch(/claimable by NOBODY/i)
    } finally {
      cleanup(meshId)
    }
  })

  it('the parked reason is classified actionable', () => {
    expect(isActionableSkipReason(PARKED_SKIP_REASON)).toBe(true)
  })

  it('★ the registration constant is not undefined at module-init (import-cycle TDZ guard)', () => {
    // Hit while building this change, and worth freezing because the failure is
    // invisible: mesh-skip-notify imports PARKED_SKIP_REASON from mesh-task-parking to
    // build ACTIONABLE_SKIP_REASON_PREFIXES at module load. Adding an import BACK from
    // mesh-task-parking into mesh-skip-notify closes a cycle whose TDZ makes that
    // constant `undefined` inside the array — so the reason is silently NOT registered,
    // isActionableSkipReason returns false, and the coordinator page never fires.
    //
    // That is precisely the defect class this whole change exists to close (a reason
    // that looks registered in source but never reaches the coordinator), reachable by
    // an innocuous-looking import. Assert the constant's identity survives the module
    // graph, not merely that some string is listed.
    expect(PARKED_SKIP_REASON).toBe('target_session_pin_parked')
    expect(isActionableSkipReason(undefined as any)).toBe(false)
    // A literal equal to the constant must classify the same way the constant does —
    // if the array captured `undefined`, this is the assertion that goes red.
    expect(isActionableSkipReason('target_session_pin_parked')).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// (d) The TTL must not run while the addressee is demonstrably working.
// ───────────────────────────────────────────────────────────────────────────
describe('(d) the pin TTL measures UNPRODUCTIVE waiting, not wall-clock age', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('★ does NOT expire a long-waiting pin while its target session is generating', async () => {
    // The live inversion: the session that day was implementing P2/P3/P4 in one turn
    // and its pin died at 902s — the pin was killed BY the work it was waiting for.
    const meshId = `mesh_ttl_busy_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([liveSession(meshId, 'busy-sess', 'generating')])
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'busy-sess', ageMs: PAST_TTL_AGE_MS })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(false)
      expect(after.targetSessionId).toBe('busy-sess')
      expect(after.autoLaunch?.reason).toBe('target_session_constraint')
    } finally {
      cleanup(meshId)
    }
  })

  it('DOES expire once the same over-TTL pin\'s target is idle (the clock is suspended, not disabled)', async () => {
    const meshId = `mesh_ttl_idle_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([liveSession(meshId, 'idle-sess', 'idle')])
      const t = insertPendingTask(meshId, { targetNodeId: NODE_ID, targetSessionId: 'idle-sess', ageMs: PAST_TTL_AGE_MS })

      // An idle session COULD claim this and is not doing so — that is the stale-pin
      // case, so waiting counts and the bound still applies.
      const verdict = resolveTargetPinTtlVerdict(components, task(meshId, t.id)!)
      expect(verdict.expired).toBe(true)
      expect(verdict.suspended).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })

  it('★ an UNOBSERVABLE (remote/absent) target does NOT hold the pin open forever', async () => {
    // The hole this must not open. Suspension requires POSITIVE evidence of work
    // (a GENERATING verdict); an UNKNOWN verdict — remote, or simply gone — must keep
    // the clock running, or the original RC.20 wedge (a pin that never delivers and
    // never expires) comes straight back.
    const meshId = `mesh_ttl_unknown_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([])
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: PAST_TTL_AGE_MS })

      const verdict = resolveTargetPinTtlVerdict(components, task(meshId, t.id)!)
      expect(verdict.suspended).toBe(false)
      expect(verdict.expired).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  it('a pin inside the TTL is untouched regardless of target state', async () => {
    const meshId = `mesh_ttl_young_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents([])
      const t = insertPendingTask(meshId, { targetNodeId: REMOTE_NODE_ID, targetSessionId: 'remote-sess', ageMs: 5 * 60_000 })

      await triggerMeshQueue(components, meshId)

      const after = task(meshId, t.id)!
      expect(taskIsParked(after)).toBe(false)
      expect(after.targetSessionId).toBe('remote-sess')
    } finally {
      cleanup(meshId)
    }
  })
})
