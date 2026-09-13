import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// NOTIF-HELD-DRAIN (Fix 2c): event-driven coordinator drain. When a worker's completion is
// persisted to the pending queue and a local coordinator for that mesh is sitting IDLE awaiting
// it, flushPendingForMeshIdleCoordinators delivers it immediately instead of waiting up to a
// full reconcile poll.
//
// NOTIF-IMMEDIACY (Tier 1, 2026-09-13): a GENERATING coordinator is no longer left untouched.
// A TERMINAL event now also reaches it immediately via the adapter's outbound FIFO
// ("next-turn-queue"), surfaced at its next turn boundary — no raw PTY write, so force-inject
// stays retired and the modal-park fail-closed is unchanged. Still held for a generating
// coordinator: silent lifecycle events (no coordinatorMessage) and anything whose strict target
// session does not match. A MODAL-PARKED coordinator is still never written to at all.

const testTmpDir = path.join(tmpdir(), `adhdev-notif-eventdrain-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
  getMachineId: () => (({ machineId: 'test-machine' }) as any).machineId,
  getMachineNickname: () => (({ machineId: 'test-machine' }) as any).machineNickname ?? null,
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))

import { flushPendingForMeshIdleCoordinators } from '../../src/mesh/mesh-event-forwarding.js'
import {
  queuePendingMeshCoordinatorEvent,
  getPendingMeshCoordinatorEvents,
  __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'

const MESH_ID = 'mesh-eventdrain-1'

function queueCompletion(coordinatorMessage: string, extra: Record<string, unknown> = {}): void {
  queuePendingMeshCoordinatorEvent({
    event: 'agent:generating_completed',
    meshId: MESH_ID,
    nodeLabel: 'worker-node',
    nodeId: 'node-worker',
    metadataEvent: { taskId: 'task-1', finalSummary: 'done' },
    coordinatorMessage,
    queuedAt: Date.now(),
    ...extra,
  })
}

function coordinatorStub(opts: { status: string; sessionId?: string; modalParked?: boolean }) {
  return {
    category: 'cli' as const,
    getState: () => ({
      status: opts.status,
      instanceId: opts.sessionId ?? 'coord-1',
      settings: { meshCoordinatorFor: MESH_ID },
    }),
    isModalParked: () => opts.modalParked === true,
    onEvent: vi.fn(),
  }
}

function makeComponents(coordinators: any[]) {
  return {
    statusInstanceId: undefined,
    instanceManager: {
      getByCategory: (cat: string) => (cat === 'cli' ? coordinators : []),
    },
  } as any
}

describe('flushPendingForMeshIdleCoordinators (event-driven coordinator drain)', () => {
  beforeEach(() => {
    try { __resetMeshRuntimeStoreForTests() } catch { /* best-effort */ }
    try { __clearMeshPendingEventsForTests(MESH_ID) } catch { /* best-effort */ }
  })

  afterAll(() => {
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('delivers a queued completion immediately to an IDLE coordinator', () => {
    queueCompletion('[System] worker-node completed')
    const coord = coordinatorStub({ status: 'idle' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    expect(coord.onEvent).toHaveBeenCalledTimes(1)
    const [evt, data] = coord.onEvent.mock.calls[0]
    expect(evt).toBe('send_message')
    expect(data.input.text).toContain('worker-node completed')
    // The queue was drained (consumed).
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(0)
  })

  // NOTIF-IMMEDIACY (Tier 1, 2026-09-13) — BEHAVIOUR CHANGE, deliberate.
  //
  // This case previously asserted `onEvent` was NOT called for a generating
  // coordinator: the flush returned the moment it found no idle target, so a
  // completion arriving mid-turn waited for the reconcile poll to catch an idle
  // edge (median ~1min, worst measured 873s).
  //
  // A TERMINAL event now reaches a busy-but-not-modal-parked coordinator right
  // away through the adapter's own outbound FIFO ("next-turn-queue"), which
  // surfaces it at the coordinator's next turn boundary. This is NOT the retired
  // force-inject: no raw PTY write happens, which is why `force` must be absent.
  it('★ delivers a TERMINAL event into a GENERATING coordinator via next-turn-queue (no force)', () => {
    queueCompletion('[System] worker-node completed')
    const coord = coordinatorStub({ status: 'generating' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    expect(coord.onEvent).toHaveBeenCalledTimes(1)
    const [evt, data] = coord.onEvent.mock.calls[0]
    expect(evt).toBe('send_message')
    expect(data.input.text).toContain('worker-node completed')
    // ★ A busy-coordinator delivery must never carry force — that is the
    // force-inject-into-generating path, which stays retired.
    expect(data.force).toBeUndefined()
    // Delivered, so the row is consumed rather than held.
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(0)
  })

  it('★ a SILENT lifecycle event is still NOT injected into a generating coordinator', () => {
    // agent:ready carries no coordinatorMessage and is queued only to re-drive the
    // claim state machine. Tier 1 is terminal-events-only, so this must stay held —
    // injecting it would spam the coordinator mid-turn.
    queuePendingMeshCoordinatorEvent({
      event: 'agent:ready',
      meshId: MESH_ID,
      nodeLabel: 'worker-node',
      nodeId: 'node-worker',
      metadataEvent: { taskId: 'task-lifecycle' },
      queuedAt: Date.now(),
    })
    const coord = coordinatorStub({ status: 'generating' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    expect(coord.onEvent).not.toHaveBeenCalled()
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })

  it('★ a BUSY coordinator is NOT told about its OWN completion (self-completion exclusion)', () => {
    // A coordinator session can itself be a direct-dispatch target. Its completion is
    // queued so the DISPATCHING coordinator (elsewhere) can drain it — telling the
    // producing session about its own completion is the bug this guards.
    //
    // The idle path never hit this (a session emitting its own completion is mid-
    // transition, so it was not an idle drain target); the busy group is exactly where
    // it arises, and a broadcast event would otherwise land back on the emitter.
    queueCompletion('[System] self completed', {
      metadataEvent: { taskId: 'task-self', targetSessionId: 'coord-1', finalSummary: 'done' },
    })
    const coord = coordinatorStub({ status: 'generating', sessionId: 'coord-1' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    expect(coord.onEvent).not.toHaveBeenCalled()
    // Held, not lost — the remote dispatcher still drains it from the shared queue.
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })

  it('★ strict routing still applies to a BUSY coordinator — non-matching session is re-queued', () => {
    queueCompletion('[System] for sibling', { targetCoordinatorSessionId: 'other-session' })
    const coord = coordinatorStub({ status: 'generating', sessionId: 'coord-1' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    // Tier 1 must not become a session-routing bypass.
    expect(coord.onEvent).not.toHaveBeenCalled()
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })

  it('does NOT deliver into a modal-parked coordinator — event stays queued', () => {
    queueCompletion('[System] worker-node completed')
    const coord = coordinatorStub({ status: 'waiting_approval', modalParked: true })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    expect(coord.onEvent).not.toHaveBeenCalled()
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })

  it('strict routing: re-queues (never drops) an event whose target session is not the idle coordinator', () => {
    queueCompletion('[System] for sibling', { targetCoordinatorSessionId: 'other-session' })
    const coord = coordinatorStub({ status: 'idle', sessionId: 'coord-1' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    // Not delivered to the non-matching idle coordinator, and NOT lost — re-queued.
    expect(coord.onEvent).not.toHaveBeenCalled()
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })

  it('strict routing: delivers to the matching idle coordinator session', () => {
    queueCompletion('[System] for coord-1', { targetCoordinatorSessionId: 'coord-1' })
    const coord = coordinatorStub({ status: 'idle', sessionId: 'coord-1' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

    expect(coord.onEvent).toHaveBeenCalledTimes(1)
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(0)
  })

  it('no-op when there are no coordinators for the mesh', () => {
    queueCompletion('[System] orphan')
    flushPendingForMeshIdleCoordinators(makeComponents([]), MESH_ID)
    // Held (not consumed) — nothing to deliver into.
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })
})
