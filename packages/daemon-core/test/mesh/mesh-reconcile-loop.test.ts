import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (ledger JSONL, MeshRuntimeStore, pending events) to a per-run
// temp dir so the suite never touches the production ~/.adhdev/mesh-ledger.
const testTmpDir = path.join(tmpdir(), `adhdev-mesh-reconcile-test-${randomUUID().slice(0, 8)}`)
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
import { queuePendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir } from '../../src/mesh/mesh-ledger.js'

function cleanup(meshId: string) {
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.listMeshes.mockReturnValue([])
  const pendingPath = path.join(getLedgerDir(), `${meshId}.pending-events.jsonl`)
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
}

// A live CLI coordinator instance on THIS daemon for `meshId`, with the given status.
function makeCoordinator(meshId: string, status: 'idle' | 'generating', sink: any[]) {
  return {
    category: 'cli',
    getState: () => ({ instanceId: `coord-${status}`, status, settings: { meshCoordinatorFor: meshId } }),
    onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
  }
}

function makeComponents(coordinators: any[], dispatchMeshCommand?: any) {
  return {
    instanceManager: {
      getByCategory: (category: string) => (category === 'cli' ? coordinators : []),
    },
    ...(dispatchMeshCommand ? { dispatchMeshCommand } : {}),
  } as any
}

function queueCompletion(meshId: string, jobSuffix: string) {
  return queuePendingMeshCoordinatorEvent({
    event: 'agent:generating_completed',
    meshId,
    nodeLabel: "Node 'node_child_1'",
    nodeId: 'node_child_1',
    metadataEvent: { sessionId: `sess-${jobSuffix}`, timestamp: Date.now() },
    coordinatorMessage: `Node 'node_child_1' has completed its task (${jobSuffix}).`,
    queuedAt: Date.now(),
  })
}

// A non-force, intermediate/progress event — must NOT be injected into a generating
// coordinator (only force-inject terminal events bypass the busy send-guard).
function queueProgress(meshId: string, jobSuffix: string) {
  return queuePendingMeshCoordinatorEvent({
    event: 'monitor:long_generating',
    meshId,
    nodeLabel: "Node 'node_child_1'",
    nodeId: 'node_child_1',
    metadataEvent: { sessionId: `sess-progress-${jobSuffix}`, timestamp: Date.now() },
    coordinatorMessage: `Node 'node_child_1' is still generating (${jobSuffix}).`,
    queuedAt: Date.now(),
  })
}

describe('runMeshReconcileTick', () => {
  it('drains the queue and injects into an idle coordinator', async () => {
    const meshId = `mesh_reconcile_idle_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'idle')

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = coordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.input.textFallback).toContain('has completed its task')
      // Terminal completion is force-injected so a busy coordinator is not deadlocked.
      expect(payload.force).toBe(true)

      // The event was consumed (atomic drain) — a follow-up drain returns nothing.
      expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('force-drains a force-inject event into a GENERATING coordinator (force:true PTY write)', async () => {
    const meshId = `mesh_reconcile_generating_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'generating')

      await runMeshReconcileTick(components)

      // A generating coordinator awaiting a worker result must still receive the
      // completion — force-injected so it bypasses the busy send-guard.
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = coordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.input.textFallback).toContain('has completed its task')
      expect(payload.force).toBe(true)

      // The event was consumed (atomic drain) — nothing left to re-deliver.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT inject a non-force progress event into a generating coordinator — it stays queued', async () => {
    const meshId = `mesh_reconcile_progress_generating_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueProgress(meshId, 'gen')

      await runMeshReconcileTick(components)

      // Non-force progress events are noise mid-generation; leave them queued for idle.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('generating coordinator: force-drains the force event but leaves a mixed queue\'s non-force event', async () => {
    const meshId = `mesh_reconcile_mixed_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueProgress(meshId, 'mixed')      // non-force — must stay queued
      queueCompletion(meshId, 'mixed')    // force — must be drained + injected

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [, payload] = coordinator.onEvent.mock.calls[0]
      expect(payload.input.textFallback).toContain('has completed its task')
      expect(payload.force).toBe(true)

      // Only the non-force progress event remains queued.
      const remaining = getPendingMeshCoordinatorEvents(meshId)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].event).toBe('monitor:long_generating')
    } finally {
      cleanup(meshId)
    }
  })

  it('idle coordinator receives BOTH force and non-force events', async () => {
    const meshId = `mesh_reconcile_idle_both_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)
      const components = makeComponents([coordinator])
      queueProgress(meshId, 'both')
      queueCompletion(meshId, 'both')

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).toHaveBeenCalledTimes(2)
      const texts = coordinator.onEvent.mock.calls.map((c: any[]) => c[1]?.input?.textFallback).join('\n')
      expect(texts).toContain('has completed its task')
      expect(texts).toContain('is still generating')
      // Both consumed.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('no double-delivery: after a generating force-drain, a follow-up pull-drain returns nothing for that event', async () => {
    const meshId = `mesh_reconcile_no_dupe_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'dupe')

      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)

      // Simulate the coordinator's own pull (MCP drain) racing afterwards — the
      // force-drained completion was atomically consumed, so it must not reappear.
      expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('is a no-op when there is no live coordinator on this daemon (MCP-only — pull-driven)', async () => {
    const meshId = `mesh_reconcile_no_coord_${Date.now()}`
    try {
      const components = makeComponents([])
      queueCompletion(meshId, 'no-coord')

      await runMeshReconcileTick(components)

      // Nothing to inject into; the event remains queued for the LLM's own mesh-tool drain.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('is a no-op when the queue is empty (O(1) pendingEventCount guard)', async () => {
    const meshId = `mesh_reconcile_empty_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)
      const components = makeComponents([coordinator])
      // No events queued.

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  it('cloud: pulls remote worker-node daemon queues over dispatchMeshCommand and re-injects locally', async () => {
    const meshId = `mesh_reconcile_remote_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)

      // A remote worker event the remote daemon would return from get_pending_mesh_events.
      const remoteEvent = {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_remote'",
        nodeId: 'node_remote',
        metadataEvent: { sessionId: 'sess-remote', providerType: 'claude-cli', timestamp: Date.now() },
        coordinatorMessage: "Node 'node_remote' has completed its task (remote).",
        queuedAt: Date.now(),
      }

      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
        if (command === 'get_pending_mesh_events' && daemonId === 'remote-daemon') {
          return { success: true, events: [remoteEvent] }
        }
        return { success: true, events: [] }
      })

      // Mesh has one node on a different daemon ('remote-daemon').
      meshConfigMocks.listMeshes.mockReturnValue([
        { id: meshId, nodes: [{ id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' }] },
      ])

      const components = makeComponents([coordinator], dispatchMeshCommand)

      await runMeshReconcileTick(components)

      // The remote daemon was polled for pending events...
      expect(dispatchMeshCommand).toHaveBeenCalledWith(
        'remote-daemon',
        'get_pending_mesh_events',
        expect.objectContaining({ meshId, coordinatorDaemonId: 'test-machine' }),
      )
      // ...and the pulled remote completion was injected into the local idle coordinator.
      expect(coordinator.onEvent).toHaveBeenCalled()
      const injected = coordinator.onEvent.mock.calls.map((c: any[]) => c[1]?.input?.textFallback).join('\n')
      expect(injected).toContain("has completed its task")
    } finally {
      cleanup(meshId)
    }
  })

  it('cloud: does not poll the local coordinator daemon as if it were a remote node', async () => {
    const meshId = `mesh_reconcile_local_node_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)
      const dispatchMeshCommand = vi.fn(async () => ({ success: true, events: [] }))

      // The only node is on THIS daemon (test-machine) — must be skipped by the remote pull.
      meshConfigMocks.listMeshes.mockReturnValue([
        { id: meshId, nodes: [{ id: 'node_local', workspace: '/repo/local', daemonId: 'test-machine' }] },
      ])

      const components = makeComponents([coordinator], dispatchMeshCommand)

      await runMeshReconcileTick(components)

      // No remote dispatch for a node that lives on the coordinator's own daemon.
      expect(dispatchMeshCommand).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })
})
