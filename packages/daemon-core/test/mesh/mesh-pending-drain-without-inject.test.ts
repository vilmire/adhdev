import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore, pending events) to a per-run
// temp dir so the suite never touches the production ~/.adhdev/mesh-ledger.
const testTmpDir = path.join(tmpdir(), `adhdev-mesh-drain-noinject-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  listMeshes: vi.fn(() => [] as any[]),
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
}))

import {
  queuePendingMeshCoordinatorEvent,
  drainPendingMeshCoordinatorEvents,
  getPendingMeshCoordinatorEvents,
  __clearMeshPendingEventsForTests,
} from '../../src/mesh/mesh-events-pending.js'
import { shouldHoldPendingDrainForBusyLocalCoordinator } from '../../src/mesh/mesh-reconcile-loop.js'
import { meshEventsHandlers } from '../../src/commands/high-family/mesh-events.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'

function cleanup(meshId: string) {
  try { __clearMeshPendingEventsForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
}

// A live CLI coordinator instance on THIS daemon for `meshId`, with the given status.
function makeCoordinator(meshId: string, status: 'idle' | 'generating' | 'waiting_choice' | 'waiting_approval', sessionId = `coord-${status}`) {
  return {
    category: 'cli',
    getState: () => ({ instanceId: sessionId, status, settings: { meshCoordinatorFor: meshId } }),
    onEvent: vi.fn(),
  }
}

// A worker (non-coordinator) CLI instance — present on the daemon but NOT a coordinator.
function makeWorker(meshId: string) {
  return {
    category: 'cli',
    getState: () => ({ instanceId: 'worker-1', status: 'generating', settings: { meshNodeFor: meshId, meshNodeId: 'node_1' } }),
    onEvent: vi.fn(),
  }
}

function makeComponents(cliInstances: any[], statusInstanceId?: string) {
  return {
    instanceManager: {
      getByCategory: (category: string) => (category === 'cli' ? cliInstances : []),
      getInstance: (id: string) => cliInstances.find((i) => i.getState().instanceId === id),
    },
    ...(statusInstanceId ? { statusInstanceId } : {}),
  } as any
}

function queueCompletion(meshId: string, suffix: string, targetCoordinatorDaemonId?: string) {
  return queuePendingMeshCoordinatorEvent({
    event: 'agent:generating_completed',
    meshId,
    nodeLabel: "Node 'node_1'",
    nodeId: 'node_1',
    metadataEvent: { sessionId: `sess-${suffix}`, taskId: `task-${suffix}`, timestamp: Date.now() },
    coordinatorMessage: `Node 'node_1' completed (${suffix}).`,
    queuedAt: Date.now(),
    ...(targetCoordinatorDaemonId ? { targetCoordinatorDaemonId } : {}),
  })
}

async function callGetPending(components: any, meshId: string, coordinatorDaemonId?: string) {
  const ctx = { deps: components } as any
  return (await meshEventsHandlers.get_pending_mesh_events(ctx, {
    meshId,
    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
  })) as { success: boolean; events: any[]; heldForBusyLocalCoordinator?: boolean }
}

describe('DRAIN-WITHOUT-INJECT: get_pending_mesh_events must not consume events held for a busy local CLI coordinator', () => {
  it('HOLDS the held (unsurfaced) row on a broadcast drain while the local coordinator is generating — never drained, re-drainable when idle', async () => {
    const meshId = `mesh_hold_generating_${Date.now()}`
    cleanup(meshId)
    queueCompletion(meshId, 'A')

    const generating = makeCoordinator(meshId, 'generating')
    const components = makeComponents([generating])

    // The MCP poll path during a generating turn (broadcast drain).
    const res = await callGetPending(components, meshId)
    expect(res.heldForBusyLocalCoordinator).toBe(true)
    expect(res.events).toHaveLength(0)

    // The row is still queued (drained=0) — NOT lost.
    expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)

    // When the coordinator returns to idle, the SAME row drains for delivery.
    const idle = makeCoordinator(meshId, 'idle')
    const idleComponents = makeComponents([idle])
    const res2 = await callGetPending(idleComponents, meshId)
    expect(res2.heldForBusyLocalCoordinator).toBeUndefined()
    expect(res2.events).toHaveLength(1)
    expect(res2.events[0].metadataEvent.taskId).toBe('task-A')

    cleanup(meshId)
  })

  it('HOLDS when the drain is scoped to this daemon id and the local coordinator is modal-parked', async () => {
    const meshId = `mesh_hold_modal_${Date.now()}`
    cleanup(meshId)
    queueCompletion(meshId, 'B', 'test-machine')

    const parked = makeCoordinator(meshId, 'waiting_choice')
    const components = makeComponents([parked], 'test-machine')

    const res = await callGetPending(components, meshId, 'test-machine')
    expect(res.heldForBusyLocalCoordinator).toBe(true)
    expect(res.events).toHaveLength(0)
    expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    cleanup(meshId)
  })

  it('does NOT hold a REMOTE pull (foreign coordinatorDaemonId) even when the local coordinator is generating', async () => {
    const meshId = `mesh_remote_pull_${Date.now()}`
    cleanup(meshId)
    // Event targeted at a remote coordinator daemon.
    queueCompletion(meshId, 'C', 'remote-daemon')

    const generating = makeCoordinator(meshId, 'generating')
    const components = makeComponents([generating], 'test-machine')

    // A remote coordinator pulls our worker's events with its own daemon id.
    const res = await callGetPending(components, meshId, 'remote-daemon')
    expect(res.heldForBusyLocalCoordinator).toBeUndefined()
    expect(res.events).toHaveLength(1)
    expect(getPendingMeshCoordinatorEvents(meshId, 'remote-daemon')).toHaveLength(0)
    cleanup(meshId)
  })

  it('does NOT hold when there is no live CLI coordinator (pure stdio MCP coordinator — tool result IS the surface)', async () => {
    const meshId = `mesh_pure_mcp_${Date.now()}`
    cleanup(meshId)
    queueCompletion(meshId, 'D')

    // Only a worker is present on the daemon — no coordinator session.
    const components = makeComponents([makeWorker(meshId)])

    const res = await callGetPending(components, meshId)
    expect(res.heldForBusyLocalCoordinator).toBeUndefined()
    expect(res.events).toHaveLength(1)
    cleanup(meshId)
  })

  it('does NOT hold when an idle local coordinator exists (deliverable now — draining is the equivalent delivery)', async () => {
    const meshId = `mesh_idle_coord_${Date.now()}`
    cleanup(meshId)
    queueCompletion(meshId, 'E')

    const idle = makeCoordinator(meshId, 'idle')
    const generating = makeCoordinator(meshId, 'generating', 'coord-other-generating')
    // A mix: one idle coordinator makes the mesh deliverable now.
    const components = makeComponents([idle, generating])

    const res = await callGetPending(components, meshId)
    expect(res.heldForBusyLocalCoordinator).toBeUndefined()
    expect(res.events).toHaveLength(1)
    cleanup(meshId)
  })
})

describe('shouldHoldPendingDrainForBusyLocalCoordinator (unit)', () => {
  it('returns false when no coordinator and false when idle, true only for busy local + local/broadcast scope', () => {
    const meshId = `mesh_unit_${Date.now()}`

    // No coordinator → false.
    expect(shouldHoldPendingDrainForBusyLocalCoordinator(makeComponents([]), meshId)).toBe(false)

    // Idle coordinator → false (deliverable).
    expect(
      shouldHoldPendingDrainForBusyLocalCoordinator(makeComponents([makeCoordinator(meshId, 'idle')]), meshId),
    ).toBe(false)

    // Generating coordinator + broadcast → true.
    expect(
      shouldHoldPendingDrainForBusyLocalCoordinator(makeComponents([makeCoordinator(meshId, 'generating')]), meshId),
    ).toBe(true)

    // Generating coordinator + local-id scope → true.
    expect(
      shouldHoldPendingDrainForBusyLocalCoordinator(
        makeComponents([makeCoordinator(meshId, 'generating')], 'test-machine'),
        meshId,
        'test-machine',
      ),
    ).toBe(true)

    // Generating coordinator + remote-id scope → false (remote pull).
    expect(
      shouldHoldPendingDrainForBusyLocalCoordinator(
        makeComponents([makeCoordinator(meshId, 'generating')], 'test-machine'),
        meshId,
        'remote-daemon',
      ),
    ).toBe(false)
  })
})
