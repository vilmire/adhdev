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
import { __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js'
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

// An idle local CLI worker session stamped for `nodeId` of `meshId`, plus the
// cliManager/instanceManager surface tryAssignQueueTask's local-claim path needs.
function makeIdleWorkerComponents(meshId: string, nodeId: string, sessionId: string, providerType: string) {
  const handleCliCommand = vi.fn(async () => ({ success: true }))
  const workerInstance = {
    category: 'cli',
    getState: () => ({
      instanceId: sessionId,
      status: 'idle',
      type: providerType,
      settings: { meshNodeFor: meshId, meshNodeId: nodeId, providerType },
    }),
    updateSettings: vi.fn(),
  }
  return {
    handleCliCommand,
    components: {
      instanceManager: {
        getByCategory: (category: string) => (category === 'cli' ? [workerInstance] : []),
        getInstance: (id: string) => (id === sessionId ? workerInstance : undefined),
      },
      cliManager: {
        adapters: new Map([[sessionId, {}]]),
        handleCliCommand,
      },
    } as any,
  }
}

// A live CLI coordinator instance on THIS daemon for `meshId`, with the given status.
function makeCoordinator(meshId: string, status: 'idle' | 'generating', sink: any[]) {
  return {
    category: 'cli',
    getState: () => ({ instanceId: `coord-${status}`, status, settings: { meshCoordinatorFor: meshId } }),
    onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
  }
}

function makeComponents(coordinators: any[], dispatchMeshCommand?: any, statusInstanceId?: string) {
  return {
    instanceManager: {
      getByCategory: (category: string) => (category === 'cli' ? coordinators : []),
    },
    ...(dispatchMeshCommand ? { dispatchMeshCommand } : {}),
    ...(statusInstanceId ? { statusInstanceId } : {}),
  } as any
}

// A completion event stamped with a specific targetCoordinatorDaemonId — mirrors the
// real producer: the MCP layer (mesh_send_task) stamps the worker's
// meshCoordinatorDaemonId from ctx.localDaemonId, which under IPC is the daemon's
// canonical status id (`standalone_<machineId>` / `daemon_<machineId>`), NOT bare machineId.
function queueCompletionForCoordinator(meshId: string, jobSuffix: string, targetCoordinatorDaemonId: string) {
  return queuePendingMeshCoordinatorEvent({
    event: 'agent:generating_completed',
    meshId,
    nodeLabel: "Node 'node_child_1'",
    nodeId: 'node_child_1',
    metadataEvent: { sessionId: `sess-${jobSuffix}`, timestamp: Date.now() },
    coordinatorMessage: `Node 'node_child_1' has completed its task (${jobSuffix}).`,
    queuedAt: Date.now(),
    targetCoordinatorDaemonId,
  })
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

  it('force-drains a completion stamped with the daemon STATUS id (standalone_<machineId>) into a generating coordinator', async () => {
    // Regression for the self-inject bug: the MCP layer stamps the worker's
    // meshCoordinatorDaemonId with the prefixed status id, but the reconcile loop
    // used to drain with bare loadConfig().machineId — so a unicast completion
    // stamped `standalone_test-machine` never matched and the generating coordinator
    // never self-received it (only a manual get_pending_mesh_events pull worked).
    const meshId = `mesh_reconcile_status_id_${Date.now()}`
    const statusInstanceId = 'standalone_test-machine'
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator], undefined, statusInstanceId)
      queueCompletionForCoordinator(meshId, 'statusid', statusInstanceId)

      await runMeshReconcileTick(components)

      // The generating coordinator must self-receive the completion (force-injected),
      // with no manual pull, even though it was stamped with the prefixed status id.
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [, payload] = coordinator.onEvent.mock.calls[0]
      expect(payload.input.textFallback).toContain('has completed its task')
      expect(payload.force).toBe(true)

      // Consumed atomically — a follow-up pull (with the status id) returns nothing.
      expect(drainPendingMeshCoordinatorEvents(meshId, statusInstanceId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('still drains a completion stamped with bare machineId (local queue-assignment path)', async () => {
    // The local queue-assignment path stamps bare loadConfig().machineId. The
    // reconcile loop accepts BOTH the status id and machineId, so this still works.
    const meshId = `mesh_reconcile_bare_machine_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator], undefined, 'standalone_test-machine')
      queueCompletionForCoordinator(meshId, 'bare', 'test-machine')

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][1].force).toBe(true)
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

  it('cloud: pulls with the coordinator NODE config-form daemonId, not just runtime ids (remote form-mismatch regression)', async () => {
    // Real-world remote failure: the worker stamps meshCoordinatorDaemonId from the
    // MCP layer's resolveCoordinatorDaemonId(), which prefers the coordinator MESH
    // NODE's config-form `daemonId` over the runtime status id. That config form
    // (here `daemon_test-machine`) is NOT one of this daemon's runtime drain ids
    // (bare `test-machine` + status `standalone_test-machine`). The remote
    // get_pending_mesh_events drain filters rows by an exact coordinator_daemon_id
    // match, so a pull that supplies ONLY the runtime ids returns 0 — the completion
    // is stranded until a manual read_chat reconcile. The fix unions the self node's
    // config-form daemonId into the pull candidate set.
    const meshId = `mesh_reconcile_remote_form_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)

      const coordinatorNodeDaemonId = 'daemon_test-machine' // config form, ≠ runtime ids
      const remoteEvent = {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_remote'",
        nodeId: 'node_remote',
        metadataEvent: { sessionId: 'sess-remote-form', providerType: 'claude-cli', timestamp: Date.now() },
        coordinatorMessage: "Node 'node_remote' has completed its task (remote-form).",
        queuedAt: Date.now(),
      }

      // Remote drain is form-sensitive: it ONLY returns the event when the pull's
      // coordinatorDaemonId matches the form the worker stamped (the config-form
      // node daemonId). Any other id form (the runtime drain ids) returns [].
      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string, args: any) => {
        if (command === 'get_pending_mesh_events' && daemonId === 'remote-daemon'
            && args?.coordinatorDaemonId === coordinatorNodeDaemonId) {
          return { success: true, events: [remoteEvent] }
        }
        return { success: true, events: [] }
      })

      // Mesh: a self node carrying the config-form coordinator daemonId + the runtime
      // bare machineId, plus a remote worker node on a different daemon.
      meshConfigMocks.listMeshes.mockReturnValue([
        {
          id: meshId,
          nodes: [
            { id: 'node_coord', workspace: '/repo/coord', daemonId: coordinatorNodeDaemonId, machineId: 'test-machine' },
            { id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' },
          ],
        },
      ])

      const components = makeComponents([coordinator], dispatchMeshCommand, 'standalone_test-machine')

      await runMeshReconcileTick(components)

      // The pull must have been issued with the config-form daemonId so the remote
      // form-sensitive drain matched.
      expect(dispatchMeshCommand).toHaveBeenCalledWith(
        'remote-daemon',
        'get_pending_mesh_events',
        expect.objectContaining({ meshId, coordinatorDaemonId: coordinatorNodeDaemonId }),
      )
      // ...and the remote completion was re-injected into the local idle coordinator.
      expect(coordinator.onEvent).toHaveBeenCalled()
      const injected = coordinator.onEvent.mock.calls.map((c: any[]) => c[1]?.input?.textFallback).join('\n')
      expect(injected).toContain('has completed its task')
    } finally {
      cleanup(meshId)
    }
  })

  it('cloud: pulls with the pinned meshHost.hostDaemonId form when it is provably this daemon (self node proves ownership)', async () => {
    // The coordinator anchor can resolve to the pinned meshHost.hostDaemonId (a
    // config-form id) rather than a runtime id. This daemon may legitimately own that
    // host id when a self node carries it as its daemonId AND a runtime id (machineId)
    // also resolves to this daemon — proving ownership. The pull must then include the
    // host-id form so the remote form-sensitive drain matches a worker stamped with it.
    const meshId = `mesh_reconcile_remote_host_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)
      const hostDaemonId = 'daemon_test-machine' // config-form host id, ≠ runtime drain ids

      const remoteEvent = {
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_remote'",
        nodeId: 'node_remote',
        metadataEvent: { sessionId: 'sess-remote-host', providerType: 'claude-cli', timestamp: Date.now() },
        coordinatorMessage: "Node 'node_remote' has completed its task (remote-host).",
        queuedAt: Date.now(),
      }
      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string, args: any) => {
        if (command === 'get_pending_mesh_events' && daemonId === 'remote-daemon'
            && args?.coordinatorDaemonId === hostDaemonId) {
          return { success: true, events: [remoteEvent] }
        }
        return { success: true, events: [] }
      })

      meshConfigMocks.listMeshes.mockReturnValue([
        {
          id: meshId,
          meshHost: { role: 'host', hostDaemonId },
          nodes: [
            // Self node: daemonId is the config-form host id; machineId is the runtime
            // bare id — together they prove this daemon owns the pinned host id.
            { id: 'node_coord', workspace: '/repo/coord', daemonId: hostDaemonId, machineId: 'test-machine' },
            { id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' },
          ],
        },
      ])

      const components = makeComponents([coordinator], dispatchMeshCommand, 'standalone_test-machine')

      await runMeshReconcileTick(components)

      expect(dispatchMeshCommand).toHaveBeenCalledWith(
        'remote-daemon',
        'get_pending_mesh_events',
        expect.objectContaining({ meshId, coordinatorDaemonId: hostDaemonId }),
      )
      expect(coordinator.onEvent).toHaveBeenCalled()
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

  // ── PHASE 3: pending-claim recovery ───────────────────────────────────────
  describe('PHASE 3 pending-claim recovery', () => {
    it('claims a pending queue task for a now-idle local session that never got a ready-event', async () => {
      const meshId = `mesh_reconcile_phase3_claim_${Date.now()}`
      const nodeId = 'node_worker'
      const sessionId = 'sess-idle-worker'
      try {
        // A pending task targeting the worker node, and an idle worker session that
        // already exists — exactly the state left behind when the agent:ready event
        // that would have triggered the claim was missed/dropped.
        enqueueTask(meshId, 'do the work', { targetNodeId: nodeId })

        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: 'test-machine' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        // PHASE 3 ran triggerMeshQueue, which claimed the pending task onto the idle
        // session and dispatched it locally.
        expect(handleCliCommand).toHaveBeenCalledWith('agent_command', expect.objectContaining({
          targetSessionId: sessionId,
          action: 'send_chat',
        }))
        const assigned = getQueue(meshId, { status: ['assigned'] as any })
        expect(assigned).toHaveLength(1)
        expect(assigned[0].assignedNodeId).toBe(nodeId)
        expect(assigned[0].assignedSessionId).toBe(sessionId)
      } finally {
        cleanup(meshId)
      }
    })

    it('O(1) guard: skips triggerMeshQueue entirely when there are no pending tasks', async () => {
      const meshId = `mesh_reconcile_phase3_empty_${Date.now()}`
      const nodeId = 'node_worker'
      try {
        // No pending tasks enqueued — the guard must short-circuit before any claim scan.
        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, 'sess-idle', 'claude-cli')
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: 'test-machine' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        // pendingQueueTaskCount===0 → continue before triggerMeshQueue. triggerMeshQueue
        // resolves the mesh via getMesh (getMeshWithCache); the guard means it is never
        // reached, so getMesh is not called and no claim/dispatch is attempted.
        expect(meshConfigMocks.getMesh).not.toHaveBeenCalled()
        expect(handleCliCommand).not.toHaveBeenCalled()
        expect(getQueue(meshId, { status: ['assigned'] as any })).toHaveLength(0)
      } finally {
        cleanup(meshId)
      }
    })

    it('does not run PHASE 3 for a mesh this daemon does not host', async () => {
      const meshId = `mesh_reconcile_phase3_nothost_${Date.now()}`
      const nodeId = 'node_remote'
      try {
        enqueueTask(meshId, 'remote work', { targetNodeId: nodeId })

        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, 'sess-x', 'claude-cli')
        // Mesh is hosted by a DIFFERENT daemon: a pinned hostDaemonId that is not one
        // of this daemon's ids → daemonHostsMesh is false → PHASE 3 must skip it.
        const mesh = {
          id: meshId,
          meshHost: { role: 'host', hostDaemonId: 'other-daemon' },
          nodes: [{ id: nodeId, workspace: '/repo/remote', daemonId: 'other-daemon' }],
        }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        expect(meshConfigMocks.getMesh).not.toHaveBeenCalled()
        expect(handleCliCommand).not.toHaveBeenCalled()
      } finally {
        cleanup(meshId)
      }
    })
  })
})
