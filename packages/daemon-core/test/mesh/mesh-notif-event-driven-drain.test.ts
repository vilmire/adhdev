import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// NOTIF-HELD-DRAIN (Fix 2c): event-driven coordinator drain. When a worker's completion is
// persisted to the pending queue and a local coordinator for that mesh is sitting IDLE awaiting
// it, flushPendingForMeshIdleCoordinators delivers it immediately instead of waiting up to a
// full reconcile poll. A non-idle (generating / modal-parked) coordinator is left untouched —
// the event stays queued for the reconcile loop's idle full-drain.

const testTmpDir = path.join(tmpdir(), `adhdev-notif-eventdrain-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
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

  it('does NOT deliver into a GENERATING coordinator — event stays queued for reconcile', () => {
    queueCompletion('[System] worker-node completed')
    const coord = coordinatorStub({ status: 'generating' })
    flushPendingForMeshIdleCoordinators(makeComponents([coord]), MESH_ID)

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
