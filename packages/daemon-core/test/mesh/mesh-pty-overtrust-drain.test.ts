import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// PTY-OVERTRUST-DRAIN (Defect B). The mesh reconcile loop used to trust the
// coordinator's getState().status (the auto-approve hold-idle VISUAL MASK overlays a
// genuinely-idle adapter as `generating`) and therefore HELD a worker's completion under
// `generating_no_idle_coordinator` even though the coordinator's PTY was at a real turn
// end — the completion was stranded until the user's next turn edge.
//
// These tests model a coordinator instance the way the live CLI provider now exposes it:
// getState().status is the masked surface (generating), but getDrainStatus() reports the
// mask-stripped raw adapter turn-state. They verify:
//   (A) a masked-idle coordinator (getState=generating, getDrainStatus=idle) is now a
//       drain target — the completion is delivered, not held.
//   (B) the age-based escape drains a desync-stranded completion once the hold ages past
//       the threshold AND the raw adapter re-confirms idle; a genuinely-generating
//       coordinator is still held (no force-inject-into-generating).
//   (C) a genuinely-generating coordinator (getDrainStatus=generating) is held — data
//       safety preserved.

const testTmpDir = path.join(tmpdir(), `adhdev-pty-overtrust-test-${randomUUID().slice(0, 8)}`)
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

import { runMeshReconcileTick } from '../../src/mesh/mesh-reconcile-loop.js'
import { queuePendingMeshCoordinatorEvent, getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { __resetMeshRuntimeStoreForTests, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.listMeshes.mockReturnValue([])
  meshConfigMocks.getMesh.mockReset()
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
  const queuePath = path.join(getLedgerDir(), `${meshId}.queue.json`)
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath)
}

function makeComponents(coordinators: any[]) {
  return {
    instanceManager: {
      getByCategory: (category: string) => (category === 'cli' ? coordinators : []),
    },
  } as any
}

// A coordinator whose VISIBLE surface (getState().status) is masked to `generating` by the
// auto-approve hold-idle overlay, while its RAW adapter turn-state (getDrainStatus) is the
// caller-supplied value. This is the exact shape of the live CLI provider during an
// auto-approve settle: dashboard sees generating, the PTY is genuinely idle.
function makeMaskedCoordinator(
  meshId: string,
  drainStatus: 'idle' | 'generating' | 'modal_parked',
  sink: any[],
  sessionId = `coord-${drainStatus}`,
) {
  return {
    category: 'cli',
    // getState().status is the MASKED surface — always `generating` here, the false-busy
    // the reconcile loop used to over-trust.
    getState: () => ({ instanceId: sessionId, status: 'generating', settings: { meshCoordinatorFor: meshId } }),
    getDrainStatus: () => drainStatus,
    isModalParked: () => drainStatus === 'modal_parked',
    onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
    sessionId,
  }
}

function queueCompletion(meshId: string, jobSuffix: string, queuedAt = Date.now()) {
  return queuePendingMeshCoordinatorEvent({
    event: 'agent:generating_completed',
    meshId,
    nodeLabel: "Node 'node_child_1'",
    nodeId: 'node_child_1',
    metadataEvent: { sessionId: `sess-${jobSuffix}`, timestamp: Date.now() },
    coordinatorMessage: `Node 'node_child_1' has completed its task (${jobSuffix}).`,
    queuedAt,
  })
}

describe('PTY-OVERTRUST-DRAIN (Defect B)', () => {
  afterEach(() => {
    delete process.env.MESH_PENDING_HELD_DRAIN_ESCALATE_MS
  })

  // ── (A) mask-stripped idle is a drain target ──────────────────────────────
  it('A: a masked-idle coordinator (getState=generating, getDrainStatus=idle) DRAINS the completion', async () => {
    const meshId = `mesh_overtrust_A_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeMaskedCoordinator(meshId, 'idle', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'maskedidle')

      await runMeshReconcileTick(components)

      // The drain decision follows the RAW adapter idle, not the masked `generating`.
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(sink[0]?.input?.text).toContain('has completed its task (maskedidle)')
      // Delivered → drained, nothing left queued.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // ── (C) genuinely generating is HELD (data safety, no force-inject) ───────
  it('C: a genuinely-generating coordinator (getDrainStatus=generating) HOLDS the completion', async () => {
    const meshId = `mesh_overtrust_C_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeMaskedCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'reallybusy')

      await runMeshReconcileTick(components)

      // No raw force-write into a generating PTY — held for the next idle tick.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── modal-park is HELD (human-await, no keystroke corruption) ─────────────
  it('a genuine modal-parked coordinator HOLDS the completion (human-await preserved)', async () => {
    const meshId = `mesh_overtrust_modal_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeMaskedCoordinator(meshId, 'modal_parked', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'humanawait')

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── (B) age-escape: drains a desync-stranded completion once aged + raw idle ──
  it('B: age-escape drains a held completion once it ages past the threshold AND the raw adapter re-confirms idle', async () => {
    const meshId = `mesh_overtrust_B_escape_${Date.now()}`
    try {
      // Tighten the escalate threshold so a single tick crosses it.
      process.env.MESH_PENDING_HELD_DRAIN_ESCALATE_MS = '4000'
      const sink: any[] = []
      // The coordinator's raw adapter reads generating at findLiveCoordinators time (so it
      // is held), but flips to idle by the escape re-confirmation. Model the flip with a
      // mutable drain status: 'generating' on the first read, 'idle' on the re-confirm.
      let drainReads = 0
      const sessionId = 'coord-desync-escape'
      const coordinator: any = {
        category: 'cli',
        getState: () => ({ instanceId: sessionId, status: 'generating', settings: { meshCoordinatorFor: meshId } }),
        getDrainStatus: () => {
          drainReads++
          // 1st read = findLiveCoordinators classification (held as generating).
          // 2nd read = reconfirmGenuinelyIdleCoordinators (now genuinely idle → drain).
          return drainReads <= 1 ? 'generating' : 'idle'
        },
        isModalParked: () => false,
        onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
      }
      const components = makeComponents([coordinator])
      // Queue the completion 10s in the past so its age already exceeds the 4s threshold.
      queueCompletion(meshId, 'desync', Date.now() - 10_000)

      await runMeshReconcileTick(components)

      // The age-escape re-confirmed raw idle and drained once.
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(sink[0]?.input?.text).toContain('has completed its task (desync)')
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('B: age-escape does NOT inject when the raw adapter is still genuinely generating after the threshold', async () => {
    const meshId = `mesh_overtrust_B_hold_${Date.now()}`
    try {
      process.env.MESH_PENDING_HELD_DRAIN_ESCALATE_MS = '4000'
      const sink: any[] = []
      // Always genuinely generating — both the classification read and the escape re-confirm
      // return 'generating', so the escape must NOT inject (no force-inject-into-generating).
      const coordinator = makeMaskedCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'stillbusy', Date.now() - 10_000) // aged past threshold

      await runMeshReconcileTick(components)

      // Aged past the threshold but raw adapter still generating → held, never injected.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('B: a freshly-held completion (below the age threshold) is NOT escaped even with raw idle desync', async () => {
    const meshId = `mesh_overtrust_B_fresh_${Date.now()}`
    try {
      process.env.MESH_PENDING_HELD_DRAIN_ESCALATE_MS = '60000' // 60s threshold
      const sink: any[] = []
      // Raw adapter reads generating on classification; would re-confirm idle on escape — but
      // the event is too FRESH to escape, so the re-confirm must not even run / not inject.
      let drainReads = 0
      const sessionId = 'coord-fresh'
      const coordinator: any = {
        category: 'cli',
        getState: () => ({ instanceId: sessionId, status: 'generating', settings: { meshCoordinatorFor: meshId } }),
        getDrainStatus: () => { drainReads++; return drainReads <= 1 ? 'generating' : 'idle' },
        isModalParked: () => false,
        onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
      }
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'fresh', Date.now()) // just queued, well under 60s

      await runMeshReconcileTick(components)

      // Below threshold → held; the escape did not deliver.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })
})
