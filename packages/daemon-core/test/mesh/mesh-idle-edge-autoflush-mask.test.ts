import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// NOTIF-LOSS (A1). The coordinator idle-edge auto-flush in setupMeshEventForwarding's
// instanceManager.onEvent handler is the ONLY delivery path that is interval-independent:
// it fires the moment the coordinator's turn ends, so a coordinator whose idle window is
// shorter than the 4s reconcile cadence still receives its workers' completions.
//
// PTY-OVERTRUST-DRAIN (Defect B) taught that `getState().status` is NOT the drain truth:
// it overlays the auto-approve hold-idle mask, which paints a genuinely-idle adapter
// `generating` to suppress UI flicker (cli-provider-instance.ts ~:783). Two of the three
// idle-decision sites were converted to the mask-stripped `getDrainStatus()`; this inline
// handler was missed, so on any coordinator with auto-approve active the fast path
// silently no-opped and every completion fell back to the poll — landing in the ledger as
// `generating_no_idle_coordinator` (50 of 51 holds measured 2026-09-02).
//
// These tests pin the RAW turn-state as the gate. Reverting the gate to
// `flushState.status` turns the first two red.

const testTmpDir = path.join(tmpdir(), `adhdev-idleedge-mask-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(() => undefined),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))

import { setupMeshEventForwarding } from '../../src/mesh/mesh-event-forwarding.js'
import {
  queuePendingMeshCoordinatorEvent,
  getPendingMeshCoordinatorEvents,
  __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'

const MESH_ID = 'mesh-idleedge-mask-1'
const COORD_SESSION = 'coord-session-1'

function queueCompletion(): void {
  queuePendingMeshCoordinatorEvent({
    event: 'agent:generating_completed',
    meshId: MESH_ID,
    nodeLabel: 'worker-node',
    nodeId: 'node-worker',
    metadataEvent: { taskId: 'task-1', finalSummary: 'done' },
    coordinatorMessage: '[System] worker-node completed',
    queuedAt: Date.now(),
  })
}

/**
 * A coordinator CLI instance whose VISIBLE status and RAW drain status can diverge —
 * exactly the auto-approve hold-idle mask the fix is about.
 */
function coordinatorStub(opts: {
  visibleStatus: string
  drainStatus: 'idle' | 'generating' | 'modal_parked' | 'other'
}) {
  return {
    category: 'cli' as const,
    getState: () => ({
      status: opts.visibleStatus,
      instanceId: COORD_SESSION,
      settings: { meshCoordinatorFor: MESH_ID },
    }),
    getDrainStatus: () => opts.drainStatus,
    isModalParked: () => opts.drainStatus === 'modal_parked',
    onEvent: vi.fn(),
  }
}

/**
 * Registers the forwarding handlers and returns the captured instanceManager.onEvent
 * callback so a test can fire a synthetic idle edge directly.
 */
function wireIdleEdge(coord: any): (event: Record<string, unknown>) => void {
  let captured: ((event: any) => void) | undefined
  const components = {
    statusInstanceId: undefined,
    instanceManager: {
      onEvent: (cb: (event: any) => void) => { captured = cb },
      getInstance: (id: string) => (id === COORD_SESSION ? coord : undefined),
      getByCategory: (cat: string) => (cat === 'cli' ? [coord] : []),
    },
  } as any
  setupMeshEventForwarding(components)
  if (!captured) throw new Error('instanceManager.onEvent was never registered')
  return captured
}

function fireIdleEdge(handler: (event: Record<string, unknown>) => void): void {
  handler({ event: 'agent:generating_completed', instanceId: COORD_SESSION })
}

describe('coordinator idle-edge auto-flush — decides idle on RAW turn-state (A1/notif-loss)', () => {
  beforeEach(() => {
    try { __resetMeshRuntimeStoreForTests() } catch { /* best-effort */ }
    try { __clearMeshPendingEventsForTests(MESH_ID) } catch { /* best-effort */ }
  })

  afterAll(() => {
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  // THE REGRESSION. Auto-approve is settling, so getState() reports `generating` while the
  // PTY is at a real turn end. Pre-fix this returned without draining and the completion
  // was held under `generating_no_idle_coordinator` until the next poll.
  it('flushes on the idle edge when the auto-approve mask paints a genuinely-idle coordinator as generating', () => {
    queueCompletion()
    const coord = coordinatorStub({ visibleStatus: 'generating', drainStatus: 'idle' })
    fireIdleEdge(wireIdleEdge(coord))

    expect(coord.onEvent).toHaveBeenCalledTimes(1)
    const [evt, data] = coord.onEvent.mock.calls[0]
    expect(evt).toBe('send_message')
    expect(data.input.text).toContain('worker-node completed')
    // Consumed from the queue — nothing left for the reconcile poll to hold.
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(0)
  })

  it('flushes on the idle edge when visible and raw status agree on idle', () => {
    queueCompletion()
    const coord = coordinatorStub({ visibleStatus: 'idle', drainStatus: 'idle' })
    fireIdleEdge(wireIdleEdge(coord))

    expect(coord.onEvent).toHaveBeenCalledTimes(1)
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(0)
  })

  // The inverse mask must NOT open the gate: a raw-generating PTY never receives a
  // force-inject (raw keystrokes mid-turn are not consumed as a turn → data loss).
  it('does NOT flush into a raw-GENERATING coordinator even when getState() reads idle', () => {
    queueCompletion()
    const coord = coordinatorStub({ visibleStatus: 'idle', drainStatus: 'generating' })
    fireIdleEdge(wireIdleEdge(coord))

    expect(coord.onEvent).not.toHaveBeenCalled()
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })

  // A genuine human-await modal stays excluded — a force-inject here is eaten by the modal.
  it('does NOT flush into a modal-parked coordinator', () => {
    queueCompletion()
    const coord = coordinatorStub({ visibleStatus: 'waiting_approval', drainStatus: 'modal_parked' })
    fireIdleEdge(wireIdleEdge(coord))

    expect(coord.onEvent).not.toHaveBeenCalled()
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(1)
  })

  // Legacy/foreign instances without the accessor must still work off the masked literal.
  it('falls back to the visible status when the instance has no getDrainStatus()', () => {
    queueCompletion()
    const coord: any = coordinatorStub({ visibleStatus: 'idle', drainStatus: 'idle' })
    delete coord.getDrainStatus
    fireIdleEdge(wireIdleEdge(coord))

    expect(coord.onEvent).toHaveBeenCalledTimes(1)
    expect(getPendingMeshCoordinatorEvents(MESH_ID).length).toBe(0)
  })
})
