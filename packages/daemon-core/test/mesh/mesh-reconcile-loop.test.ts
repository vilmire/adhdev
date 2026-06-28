import { afterEach, describe, expect, it, vi } from 'vitest'
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

import { runMeshReconcileTick, __resetReconcileInFlightSynthDebounceForTests } from '../../src/mesh/mesh-reconcile-loop.js'
import { queuePendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, __clearMeshQueueForTests, insertDirectDispatch, getActiveDirectDispatches, updateDirectDispatchStatus, claimNextTask, reclaimStrandedAssignedTask } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, appendLedgerEntry, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createSessionDelivery } from '../../src/mesh/mesh-delivery-policy.js'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
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
// `waiting_choice`/`waiting_approval` model a coordinator parked on a harness modal
// (claude-cli AskUserQuestion / tool-consent) awaiting a human answer — getState()
// overlays exactly those status strings.
function makeCoordinator(meshId: string, status: 'idle' | 'generating' | 'waiting_choice' | 'waiting_approval', sink: any[]) {
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
    event: 'monitor:no_progress',
    meshId,
    nodeLabel: "Node 'node_child_1'",
    nodeId: 'node_child_1',
    metadataEvent: { sessionId: `sess-progress-${jobSuffix}`, timestamp: Date.now() },
    coordinatorMessage: `Node 'node_child_1' is still generating (${jobSuffix}).`,
    queuedAt: Date.now(),
  })
}

describe('runMeshReconcileTick', () => {
  // R4e in-flight-synth time knobs are env-tunable and read at call time; always clear them
  // after each case so a test that sets them never leaks into the next.
  afterEach(() => {
    delete process.env.MESH_INFLIGHT_MIN_IDLE_SETTLE_MS
    delete process.env.MESH_INFLIGHT_ACKED_TURN_SETTLE_MS
  })

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

  it('NOTIF-SURFACE-LOCAL: a completion is HELD (not injected, not drained) when the only coordinator is generating', async () => {
    const meshId = `mesh_reconcile_generating_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'generating')

      await runMeshReconcileTick(components)

      // A raw force-write into a generating claude-cli PTY is not consumed as a turn,
      // so we do NOT inject and do NOT drain — the completion stays queued (drained=0)
      // for the coordinator's next idle tick. (This is the false-idle local-worktree
      // miss: previously the row was force-written + drained=1 and lost forever.)
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('NOTIF-SURFACE-LOCAL: a held completion lands EXACTLY ONCE when the coordinator returns to idle', async () => {
    const meshId = `mesh_reconcile_false_idle_${Date.now()}`
    try {
      const sink: any[] = []
      // Same instance, status flips generating → idle between ticks (the coordinator's
      // own turn ends). The held completion must surface on the idle tick, exactly once.
      let status: 'generating' | 'idle' = 'generating'
      const coordinator = {
        category: 'cli',
        getState: () => ({ instanceId: 'coord-false-idle', status, settings: { meshCoordinatorFor: meshId } }),
        onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
      }
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'falseidle')

      // Tick 1: coordinator generating → held, nothing injected, nothing drained.
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)

      // The coordinator's turn ends → idle. Tick 2 delivers the held completion.
      status = 'idle'
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][1].input.textFallback).toContain('has completed its task')
      // Consumed exactly once — a follow-up drain (e.g. an MCP pull race) returns nothing.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
      expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(0)
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

  it('generating coordinator: holds BOTH the force and non-force events (nothing injected/drained)', async () => {
    const meshId = `mesh_reconcile_mixed_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueProgress(meshId, 'mixed')      // non-force — held for idle
      queueCompletion(meshId, 'mixed')    // force — also held for idle (no PTY force-write)

      await runMeshReconcileTick(components)

      // No idle target → nothing is injected and nothing is drained. Both events stay queued.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      const remaining = getPendingMeshCoordinatorEvents(meshId)
      expect(remaining).toHaveLength(2)
      expect(remaining.map(e => e.event).sort()).toEqual(['agent:generating_completed', 'monitor:no_progress'])
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

  it('no double-delivery: a held generating completion is NOT consumed, but a racing MCP pull-drain takes it exactly once', async () => {
    const meshId = `mesh_reconcile_no_dupe_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'dupe')

      await runMeshReconcileTick(components)
      // Generating coordinator → held, never injected.
      expect(coordinator.onEvent).not.toHaveBeenCalled()

      // The coordinator's own pull (MCP drain) races and consumes the still-queued event
      // atomically. A second drain returns nothing — the row is consumed by exactly one
      // drainer (no PTY force-write means there is no separate delivery to double up with).
      expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(1)
      expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // ── modal-park guard ([I]): a coordinator parked on a harness modal (AskUserQuestion
  // → waiting_choice, or tool-consent → waiting_approval) must NOT be force-injected.
  // A force-inject writes raw keystrokes into the PTY, which the modal key handler eats
  // and silently resolves a choice the user never made (data corruption). The event is
  // held — left queued (drained=0) — for a later tick once the modal is resolved.
  for (const modalStatus of ['waiting_choice', 'waiting_approval'] as const) {
    it(`does NOT force-inject into a ${modalStatus} coordinator — event stays queued (no drain)`, async () => {
      const meshId = `mesh_reconcile_modal_${modalStatus}_${Date.now()}`
      try {
        const sink: any[] = []
        const coordinator = makeCoordinator(meshId, modalStatus, sink)
        const components = makeComponents([coordinator])
        queueCompletion(meshId, 'modal')

        await runMeshReconcileTick(components)

        // No keystrokes injected while the user is mid-modal.
        expect(coordinator.onEvent).not.toHaveBeenCalled()
        // The completion is preserved (drained=0) for redelivery once the modal clears —
        // a subsequent drain still returns it intact.
        expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
        expect(drainPendingMeshCoordinatorEvents(meshId, 'test-machine')).toHaveLength(1)
      } finally {
        cleanup(meshId)
      }
    })
  }

  it('modal-parked coordinator clears → the held event is delivered on the next tick', async () => {
    const meshId = `mesh_reconcile_modal_then_clear_${Date.now()}`
    try {
      const sink: any[] = []
      // First tick: the (only) coordinator is parked on a modal → event is held.
      let status: 'waiting_choice' | 'idle' = 'waiting_choice'
      const coordinator = {
        category: 'cli',
        getState: () => ({ instanceId: 'coord-modal', status, settings: { meshCoordinatorFor: meshId } }),
        onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
      }
      const components = makeComponents([coordinator])
      queueCompletion(meshId, 'held')

      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)

      // The user answers the modal and the coordinator's turn ends → idle. The next tick
      // delivers the still-queued completion into the idle input box as a real turn.
      status = 'idle'
      await runMeshReconcileTick(components)
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(coordinator.onEvent.mock.calls[0][1].force).toBe(true)
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('C1: a held modal-parked completion is mirrored into the ledger as event_held (recoverable, idempotent)', async () => {
    const meshId = `mesh_reconcile_held_ledger_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'waiting_choice', sink)
      const components = makeComponents([coordinator])
      const finalSummary = 'Worker completed: refactored auth module, 3 files changed, tests pass.'
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'node_child_1'",
        nodeId: 'node_child_1',
        metadataEvent: { sessionId: 'sess-held', timestamp: Date.now(), finalSummary },
        coordinatorMessage: `Node 'node_child_1' has completed its task.`,
        queuedAt: Date.now(),
      })

      await runMeshReconcileTick(components)

      // Held (no inject, still queued for re-drain) but mirrored into the ledger so the
      // worker summary is recoverable even if the modal is never resolved / file trimmed.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
      const held = readLedgerEntries(meshId).filter(e => e.kind === 'event_held')
      expect(held).toHaveLength(1)
      expect(held[0].payload.reason).toBe('modal_parked')
      expect(held[0].payload.recoverable).toBe(true)
      expect(held[0].payload.finalSummary).toBe(finalSummary)
      expect(held[0].nodeId).toBe('node_child_1')

      // Idempotent: a second tick while still parked does not duplicate the audit record.
      await runMeshReconcileTick(components)
      expect(readLedgerEntries(meshId).filter(e => e.kind === 'event_held')).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('C1: pending-file trim records dropped undelivered completions to the ledger (no silent loss)', () => {
    const meshId = `mesh_trim_drop_${Date.now()}`
    try {
      // Each event carries a ~4KB finalSummary; 60 unique events push the per-mesh pending
      // JSONL well past the 100KB / 50-entry trim threshold, so the oldest are dropped on a
      // later queue call. The trim must mirror each dropped (coordinator-facing) event into
      // the ledger rather than discarding it silently.
      const bigSummary = 'S'.repeat(4096)
      for (let i = 0; i < 60; i++) {
        queuePendingMeshCoordinatorEvent({
          event: 'agent:generating_completed',
          meshId,
          nodeLabel: "Node 'n'",
          nodeId: 'n',
          metadataEvent: { sessionId: `sess-${i}`, timestamp: 1000 + i, finalSummary: bigSummary },
          coordinatorMessage: `completion ${i}`,
          queuedAt: 1000 + i,
        })
      }
      const dropped = readLedgerEntries(meshId)
        .filter(e => e.kind === 'event_held' && (e.payload as any).reason === 'pending_trim_dropped')
      expect(dropped.length).toBeGreaterThan(0)
      expect((dropped[0].payload as any).recoverable).toBe(true)
      expect((dropped[0].payload as any).finalSummary).toBe(bigSummary)
    } finally {
      cleanup(meshId)
    }
  })

  // ── (3) strict session routing — multi-coordinator misroute fix ──────────────
  // A completion event that names an originating coordinator session must reach ONLY
  // that session, never a sibling coordinator on the same daemon.
  function makeCoordinatorWithSession(meshId: string, sessionId: string, status: 'idle' | 'generating', sink: any[]) {
    return {
      category: 'cli',
      getState: () => ({ instanceId: sessionId, status, settings: { meshCoordinatorFor: meshId } }),
      onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
    }
  }

  it('(3) strict route: a session-targeted completion is delivered ONLY to that session, not a sibling', async () => {
    const meshId = `mesh_strict_${Date.now()}`
    try {
      const sinkA: any[] = []
      const sinkB: any[] = []
      const coordA = makeCoordinatorWithSession(meshId, 'coord-A', 'idle', sinkA)
      const coordB = makeCoordinatorWithSession(meshId, 'coord-B', 'idle', sinkB)
      const components = makeComponents([coordA, coordB])
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'n'",
        nodeId: 'n',
        metadataEvent: { sessionId: 'worker-1', timestamp: Date.now() },
        coordinatorMessage: 'Node done.',
        queuedAt: Date.now(),
        targetCoordinatorSessionId: 'coord-A',
      })

      await runMeshReconcileTick(components)

      // Only the originating coordinator session receives it; the sibling is untouched.
      expect(coordA.onEvent).toHaveBeenCalledTimes(1)
      expect(coordB.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('(3) strict route: an event whose coordinator session is not live is held (re-queued), never broadcast to a sibling', async () => {
    const meshId = `mesh_strict_nomatch_${Date.now()}`
    try {
      const sinkB: any[] = []
      const coordB = makeCoordinatorWithSession(meshId, 'coord-B', 'idle', sinkB)
      const components = makeComponents([coordB])
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'n'",
        nodeId: 'n',
        metadataEvent: { sessionId: 'worker-1', timestamp: Date.now() },
        coordinatorMessage: 'Node done.',
        queuedAt: Date.now(),
        targetCoordinatorSessionId: 'coord-GONE',
      })

      await runMeshReconcileTick(components)

      // The sibling is NOT written to (the misroute we prevent) …
      expect(coordB.onEvent).not.toHaveBeenCalled()
      // … and the event is held for re-drain once the originating session returns.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('(3) legacy fallback: an event with NO target session is broadcast to all coordinators (regression-0)', async () => {
    const meshId = `mesh_legacy_broadcast_${Date.now()}`
    try {
      const sinkA: any[] = []
      const sinkB: any[] = []
      const coordA = makeCoordinatorWithSession(meshId, 'coord-A', 'idle', sinkA)
      const coordB = makeCoordinatorWithSession(meshId, 'coord-B', 'idle', sinkB)
      const components = makeComponents([coordA, coordB])
      // No targetCoordinatorSessionId → legacy/single-coordinator broadcast path.
      queueCompletion(meshId, 'legacy')

      await runMeshReconcileTick(components)

      expect(coordA.onEvent).toHaveBeenCalledTimes(1)
      expect(coordB.onEvent).toHaveBeenCalledTimes(1)
    } finally {
      cleanup(meshId)
    }
  })

  // ── modal-park ORPHAN escape: a strict-routed completion whose originating
  // coordinator session is GONE must NOT be wedged forever under `modal_parked` just
  // because a SIBLING coordinator sits on a modal. It is routed to the strict-route
  // hold/expire path (bounded TTL) so it eventually expires (recoverable) instead of
  // being held permanently — the "restart doesn't clear it" event_held leak.
  it('modal-park orphan escape: a strict event whose coordinator session is gone is re-queued via strict-route (not held as modal_parked)', async () => {
    const meshId = `mesh_modal_orphan_escape_${Date.now()}`
    try {
      const modalSink: any[] = []
      // The ONLY live coordinator is parked on a modal — and it is NOT the event's target.
      const modalCoordinator = makeCoordinatorWithSession(meshId, 'coord-PARKED', 'idle', modalSink)
      // Override status to a modal-park status (makeCoordinatorWithSession only does idle/generating).
      modalCoordinator.getState = () => ({ instanceId: 'coord-PARKED', status: 'waiting_choice', settings: { meshCoordinatorFor: meshId } }) as any
      const components = makeComponents([modalCoordinator])
      // A completion strictly targeting a coordinator session that is NOT live (orphan).
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'n'",
        nodeId: 'n',
        metadataEvent: { sessionId: 'worker-1', timestamp: Date.now(), finalSummary: 'orphan task done' },
        coordinatorMessage: 'Node done.',
        queuedAt: Date.now(),
        targetCoordinatorSessionId: 'coord-GONE',
      })

      await runMeshReconcileTick(components)

      // The modal-parked sibling is never written to (no misroute, no force-inject).
      expect(modalCoordinator.onEvent).not.toHaveBeenCalled()
      // The orphan event was routed through the strict-route hold (still within TTL) — it is
      // re-queued (preserved) rather than ledgered as `modal_parked`. The strict-route hold
      // is what eventually ledger-expires it past the TTL, breaking the permanent-held leak.
      const heldModalParked = readLedgerEntries(meshId).filter(e => e.kind === 'event_held' && (e.payload as any).reason === 'modal_parked')
      expect(heldModalParked).toHaveLength(0)
      // The event is still queued (held within TTL) for re-evaluation, not silently lost.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('modal-park orphan escape: an aged-out orphan strict event is ledger-expired (recoverable), not held forever', async () => {
    const meshId = `mesh_modal_orphan_expire_${Date.now()}`
    try {
      const modalSink: any[] = []
      const modalCoordinator = makeCoordinatorWithSession(meshId, 'coord-PARKED', 'idle', modalSink)
      modalCoordinator.getState = () => ({ instanceId: 'coord-PARKED', status: 'waiting_approval', settings: { meshCoordinatorFor: meshId } }) as any
      const components = makeComponents([modalCoordinator])
      // queuedAt well past the 60s strict TTL → the strict path must ledger-expire it.
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'n'",
        nodeId: 'n',
        metadataEvent: { sessionId: 'worker-1', timestamp: Date.now(), finalSummary: 'aged orphan summary' },
        coordinatorMessage: 'Node done.',
        queuedAt: Date.now() - 120_000,
        targetCoordinatorSessionId: 'coord-GONE',
      })

      await runMeshReconcileTick(components)

      expect(modalCoordinator.onEvent).not.toHaveBeenCalled()
      // Aged past TTL → ledger-expired (recoverable), and removed from the pending queue.
      const expired = readLedgerEntries(meshId).filter(e => e.kind === 'event_held' && (e.payload as any).reason === 'strict_route_expired')
      expect(expired).toHaveLength(1)
      expect((expired[0].payload as any).recoverable).toBe(true)
      expect((expired[0].payload as any).finalSummary).toBe('aged orphan summary')
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('modal-park: a strict event whose target session IS live (but modal-parked) is still held as modal_parked (not orphan-escaped)', async () => {
    const meshId = `mesh_modal_live_target_held_${Date.now()}`
    try {
      const modalSink: any[] = []
      // The target session IS the live (modal-parked) coordinator — genuinely transiently blocked.
      const modalCoordinator = makeCoordinatorWithSession(meshId, 'coord-LIVE', 'idle', modalSink)
      modalCoordinator.getState = () => ({ instanceId: 'coord-LIVE', status: 'waiting_choice', settings: { meshCoordinatorFor: meshId } }) as any
      const components = makeComponents([modalCoordinator])
      queuePendingMeshCoordinatorEvent({
        event: 'agent:generating_completed',
        meshId,
        nodeLabel: "Node 'n'",
        nodeId: 'n',
        metadataEvent: { sessionId: 'worker-1', timestamp: Date.now(), finalSummary: 'live target summary' },
        coordinatorMessage: 'Node done.',
        queuedAt: Date.now(),
        targetCoordinatorSessionId: 'coord-LIVE',
      })

      await runMeshReconcileTick(components)

      // Not orphaned → held as modal_parked (the existing, correct transient-block behavior).
      expect(modalCoordinator.onEvent).not.toHaveBeenCalled()
      const heldModalParked = readLedgerEntries(meshId).filter(e => e.kind === 'event_held' && (e.payload as any).reason === 'modal_parked')
      expect(heldModalParked).toHaveLength(1)
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('idle coordinator alongside a modal-parked one: idle gets the event, modal-parked is skipped', async () => {
    const meshId = `mesh_reconcile_modal_plus_idle_${Date.now()}`
    try {
      const idleSink: any[] = []
      const modalSink: any[] = []
      const idleCoordinator = makeCoordinator(meshId, 'idle', idleSink)
      const modalCoordinator = makeCoordinator(meshId, 'waiting_choice', modalSink)
      const components = makeComponents([idleCoordinator, modalCoordinator])
      queueCompletion(meshId, 'mixed-modal')

      await runMeshReconcileTick(components)

      // The idle coordinator receives the completion; the modal-parked one is never written to.
      expect(idleCoordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(modalCoordinator.onEvent).not.toHaveBeenCalled()
      // Consumed via the idle path (atomic drain) — nothing left queued.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('drains a completion stamped with the daemon STATUS id (standalone_<machineId>) into an idle coordinator', async () => {
    // Regression for the self-inject bug: the MCP layer stamps the worker's
    // meshCoordinatorDaemonId with the prefixed status id, but the reconcile loop
    // used to drain with bare loadConfig().machineId — so a unicast completion
    // stamped `standalone_test-machine` never matched and the coordinator never
    // self-received it (only a manual get_pending_mesh_events pull worked). The
    // id-form match is exercised at the drain-scope filter regardless of status;
    // an idle coordinator is the deliverable target (a generating one is held).
    const meshId = `mesh_reconcile_status_id_${Date.now()}`
    const statusInstanceId = 'standalone_test-machine'
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'idle', sink)
      const components = makeComponents([coordinator], undefined, statusInstanceId)
      queueCompletionForCoordinator(meshId, 'statusid', statusInstanceId)

      await runMeshReconcileTick(components)

      // The coordinator must self-receive the completion with no manual pull, even
      // though it was stamped with the prefixed status id (the id-form match works).
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
      const coordinator = makeCoordinator(meshId, 'idle', sink)
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

  // ── PHASE 4: synthesize lost completions for unterminated direct dispatches ──
  // [H] A worker completed + went idle but its terminal completion event was never
  // persisted (dropped before reaching the queue/outbox). The reconcile loop reads
  // the worker's transcript and synthesizes the missing completion so the coordinator
  // stops believing it is still generating. Previously this only ran when an LLM
  // polled mesh_status; now the daemon timer drives it.
  describe('PHASE 4 — transcript completion reconcile for unterminated direct dispatches', () => {
    function dispatchTimeIso(secondsAgo: number): string {
      // Fixed epoch base avoids Date.now() (the runtime forbids it in some contexts)
      // while keeping the transcript message provably after the dispatch.
      return new Date(1_700_000_000_000 - secondsAgo * 1000).toISOString()
    }

    it('local node: synthesizes task_completed from a live idle session transcript when no terminal ledger exists', async () => {
      const meshId = `mesh_reconcile_phase4_local_${Date.now()}`
      try {
        const sessionId = 'sess-local-done'
        const nodeId = 'node_local'
        const taskId = 'task_local_done'

        // A dispatch was recorded but no terminal event ever landed.
        appendLedgerEntry(meshId, {
          kind: 'task_dispatched',
          nodeId,
          sessionId,
          providerType: 'claude-cli',
          payload: { source: 'direct', via: 'local_direct', taskId, message: 'do work' },
          timestamp: dispatchTimeIso(60),
        } as any)
        insertDirectDispatch(meshId, {
          taskId,
          nodeId,
          sessionId,
          providerType: 'claude-cli',
          message: 'do work',
          via: 'local_direct',
          dispatchedAt: dispatchTimeIso(60),
        })

        // A local node (no daemonId) so read_chat is resolved via the local commandHandler.
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'claude-history-local',
            messages: [
              { role: 'user', content: 'do work', timestamp: 1_700_000_000_000 - 30_000 },
              { role: 'assistant', content: 'All done — built and tests pass.', timestamp: 1_700_000_000_000 - 5_000 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: () => [],
            getInstance: () => undefined,
          },
          commandHandler: { handle: readChat },
        } as any

        await runMeshReconcileTick(components)

        // read_chat was issued for the idle session.
        expect(readChat).toHaveBeenCalledWith('read_chat', expect.objectContaining({ targetSessionId: sessionId }))
        // A synthetic task_completed ledger entry now exists for the missed completion.
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.source).toBe('daemon_reconcile_transcript_completion')
        expect((completed?.payload as any)?.finalSummary).toContain('All done')
        // ...and the coordinator gets a pending completion event to drain.
        const pending = getPendingMeshCoordinatorEvents(meshId)
        expect(pending.some(p => p.event === 'agent:generating_completed')).toBe(true)
        // The dispatch is now terminal, so the next tick is a no-op (idempotent).
        readChat.mockClear()
        await runMeshReconcileTick(components)
        const completedCount = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed' && e.sessionId === sessionId).length
        expect(completedCount).toBe(1)
      } finally {
        cleanup(meshId)
      }
    })

    it('remote node: reads the worker transcript over dispatchMeshCommand and synthesizes the missing completion', async () => {
      const meshId = `mesh_reconcile_phase4_remote_${Date.now()}`
      try {
        const sessionId = 'sess-remote-done'
        const nodeId = 'node_remote'
        const taskId = 'task_remote_done'

        appendLedgerEntry(meshId, {
          kind: 'task_dispatched',
          nodeId,
          sessionId,
          providerType: 'claude-cli',
          payload: { source: 'direct', via: 'p2p_direct', taskId, message: 'do work' },
          timestamp: dispatchTimeIso(120),
        } as any)
        insertDirectDispatch(meshId, {
          taskId,
          nodeId,
          sessionId,
          providerType: 'claude-cli',
          message: 'do work',
          via: 'p2p_direct',
          dispatchedAt: dispatchTimeIso(120),
        })

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/remote', daemonId: 'remote-daemon' }] },
        ])

        const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
          if (command === 'read_chat' && daemonId === 'remote-daemon') {
            return {
              success: true,
              payload: {
                status: 'idle',
                providerSessionId: 'claude-history-remote',
                messages: [
                  { role: 'assistant', content: 'Finished the remote task.', timestamp: 1_700_000_000_000 - 5_000 },
                ],
              },
            }
          }
          return { success: true, events: [] }
        })

        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: vi.fn(async () => ({ success: true })) },
          dispatchMeshCommand,
        } as any

        await runMeshReconcileTick(components)

        expect(dispatchMeshCommand).toHaveBeenCalledWith(
          'remote-daemon',
          'read_chat',
          expect.objectContaining({ targetSessionId: sessionId }),
        )
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.finalSummary).toContain('Finished the remote task')
      } finally {
        cleanup(meshId)
      }
    })

    it('STALE-SUMMARY guard: does NOT attribute a PRIOR task\'s summary (reused session) when the final assistant message predates this task\'s dispatch', async () => {
      const meshId = `mesh_reconcile_phase4_stale_summary_${Date.now()}`
      try {
        const sessionId = 'sess-reused'
        const nodeId = 'node_local'
        const priorTaskId = 'task_prior_4eca2d9d'
        const newTaskId = 'task_new_2e3f501e'

        // A PRIOR task ran and produced its summary at T-100s. Then a NEW task is dispatched
        // into the SAME session at T-10s, but has not yet produced its own assistant message.
        // The session momentarily reads idle between turns; read_chat's tail still shows the
        // PRIOR task's summary as the latest user-facing assistant message. The reconcile must
        // NOT copy that prior summary onto the new task (the 2843ms-duration stale bug).
        appendLedgerEntry(meshId, {
          kind: 'task_dispatched', nodeId, sessionId, providerType: 'claude-cli',
          payload: { source: 'direct', via: 'local_direct', taskId: newTaskId, message: 'new work' },
          timestamp: dispatchTimeIso(10),
        } as any)
        insertDirectDispatch(meshId, {
          taskId: newTaskId, nodeId, sessionId, providerType: 'claude-cli', message: 'new work',
          via: 'local_direct', dispatchedAt: dispatchTimeIso(10),
        })

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        const readChat = vi.fn(async (cmd: string) => {
          // PHASE 5 live-session probe: the session IS live (just between turns), so the
          // dispatch is not an orphan and must not be pruned — isolating the PHASE 4 guard.
          if (cmd === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'claude-history-reused',
            messages: [
              // The PRIOR task's final summary, produced 100s ago — BEFORE the new task's
              // dispatch (10s ago). It is the latest user-facing assistant message.
              { role: 'assistant', content: 'Prior task summary: refactored module X.', timestamp: 1_700_000_000_000 - 100_000 },
            ],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        await runMeshReconcileTick(components)

        // No completion synthesized for the new task — the prior summary is NOT attributed to it.
        const completed = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed')
        expect(completed).toHaveLength(0)
        // The dispatch stays active for a later tick (once a genuine post-dispatch assistant
        // message exists), and no misattributed pending completion was queued.
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === newTaskId)).toBe(true)
        expect(getPendingMeshCoordinatorEvents(meshId).some(p => p.event === 'agent:generating_completed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('STALE-SUMMARY guard: DOES attribute a final assistant message produced AFTER this task\'s dispatch (genuine completion still reconciles)', async () => {
      const meshId = `mesh_reconcile_phase4_fresh_summary_${Date.now()}`
      try {
        const sessionId = 'sess-reused-2'
        const nodeId = 'node_local'
        const taskId = 'task_fresh'

        appendLedgerEntry(meshId, {
          kind: 'task_dispatched', nodeId, sessionId, providerType: 'claude-cli',
          payload: { source: 'direct', via: 'local_direct', taskId, message: 'fresh work' },
          timestamp: dispatchTimeIso(60),
        } as any)
        insertDirectDispatch(meshId, {
          taskId, nodeId, sessionId, providerType: 'claude-cli', message: 'fresh work',
          via: 'local_direct', dispatchedAt: dispatchTimeIso(60),
        })

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-fresh',
            messages: [
              // Produced 5s ago — AFTER the 60s-ago dispatch → genuinely this task's output.
              { role: 'assistant', content: 'Completed the fresh task — all green.', timestamp: 1_700_000_000_000 - 5_000 },
            ],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        await runMeshReconcileTick(components)

        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.finalSummary).toContain('Completed the fresh task')
      } finally {
        cleanup(meshId)
      }
    })

    it('does NOT synthesize a completion while the session is still generating', async () => {
      const meshId = `mesh_reconcile_phase4_busy_${Date.now()}`
      try {
        const sessionId = 'sess-busy'
        const nodeId = 'node_local'
        const taskId = 'task_busy'

        appendLedgerEntry(meshId, {
          kind: 'task_dispatched',
          nodeId,
          sessionId,
          providerType: 'claude-cli',
          payload: { source: 'direct', via: 'local_direct', taskId, message: 'do work' },
          timestamp: dispatchTimeIso(30),
        } as any)
        insertDirectDispatch(meshId, {
          taskId, nodeId, sessionId, providerType: 'claude-cli', message: 'do work',
          via: 'local_direct', dispatchedAt: dispatchTimeIso(30),
        })

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: {
            handle: vi.fn(async (cmd: string) => {
              // PHASE 5's live-session probe: a generating session is present in the live
              // status — so PHASE 5 sees it as live (not an orphan) and never prunes it.
              if (cmd === 'get_status_metadata') {
                return { success: true, status: { sessions: [{ id: sessionId, status: 'generating' }] } }
              }
              // PHASE 4's read_chat: mid-turn, must not be completed.
              return {
                success: true,
                status: 'generating',
                messages: [{ role: 'assistant', content: 'still working…', timestamp: 1_700_000_000_000 - 5_000 }],
              }
            }),
          },
        } as any

        await runMeshReconcileTick(components)

        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
        expect(completed).toBeFalsy()
        // The dispatch stays active (non-terminal) for a future reconcile — and PHASE 5 must
        // not prune a session that is still live + generating, even though it is old.
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    // ── RECONCILE-SYNTH-PREEMPTS-COMPLETION: in-flight idle-flicker debounce ────
    // A worker that was OBSERVED to start generating (dispatch row flipped to 'acked' by the
    // agent:generating_started event) and has no terminal yet can momentarily read `idle`
    // mid-turn — a CLI PTY inter-turn blip or a racing probe. A single such idle read must NOT
    // synthesize a completion: the synthesized terminal then masks the REAL completion when it
    // lands seconds later (drop:duplicate_completion_terminal_ledger; the observed 71s task
    // a250fb44 lost its [System] notification this way). The synth is held until the session
    // reads idle on consecutive reconcile ticks.
    function seedAckedDispatch(meshId: string, nodeId: string, sessionId: string, taskId: string, secondsAgo: number) {
      appendLedgerEntry(meshId, {
        kind: 'task_dispatched', nodeId, sessionId, providerType: 'claude-cli',
        payload: { source: 'direct', via: 'local_direct', taskId, message: 'do work' },
        timestamp: dispatchTimeIso(secondsAgo),
      } as any)
      insertDirectDispatch(meshId, {
        taskId, nodeId, sessionId, providerType: 'claude-cli', message: 'do work',
        via: 'local_direct', dispatchedAt: dispatchTimeIso(secondsAgo),
      })
      // agent:generating_started was observed → the worker genuinely started a turn.
      updateDirectDispatchStatus(meshId, sessionId, 'acked', taskId)
    }

    it('in-flight (acked) worker: a SINGLE idle read does NOT synthesize a premature completion (idle flicker held)', async () => {
      const meshId = `mesh_reconcile_phase4_inflight_hold_${Date.now()}`
      try {
        const sessionId = 'sess-inflight'
        const nodeId = 'node_local'
        const taskId = 'task_inflight'
        // Old enough that the downstream grace would NOT block — isolating the in-flight gate.
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        // read_chat reports idle with a post-dispatch final assistant message — but the worker
        // is actually still generating (this idle is a transient mid-turn blip).
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'claude-history-inflight',
            messages: [{ role: 'assistant', content: 'intermediate text', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        // Tick 1: first idle observation → held, NOT synthesized.
        await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
        expect(getPendingMeshCoordinatorEvents(meshId).some(p => p.event === 'agent:generating_completed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('in-flight (acked) worker: an idle BLIP then back to generating resets the streak — no synth even after later idle', async () => {
      const meshId = `mesh_reconcile_phase4_inflight_blip_${Date.now()}`
      try {
        const sessionId = 'sess-blip'
        const nodeId = 'node_local'
        const taskId = 'task_blip'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        let status: 'idle' | 'generating' = 'idle'
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: sessionId, status }] } }
          }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status,
            providerSessionId: 'claude-history-blip',
            messages: [{ role: 'assistant', content: 'intermediate text', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        // Tick 1: idle blip (streak=1, held).
        await runMeshReconcileTick(components)
        // Tick 2: back to generating → streak reset.
        status = 'generating'
        await runMeshReconcileTick(components)
        // Tick 3: idle again, but streak restarts at 1 → still held, no premature synth.
        status = 'idle'
        await runMeshReconcileTick(components)

        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    it('genuinely-lost completion (acked, persistently idle): synthesizes AND queues a coordinator completion once the idle settle is confirmed', async () => {
      const meshId = `mesh_reconcile_phase4_lost_settled_${Date.now()}`
      // Disable the R4e TIME hurdles (settle / acked-turn) so this case exercises the original
      // consecutive-TICK confirmation path in isolation. The time hurdles get their own tests below.
      process.env.MESH_INFLIGHT_MIN_IDLE_SETTLE_MS = '0'
      process.env.MESH_INFLIGHT_ACKED_TURN_SETTLE_MS = '0'
      try {
        const sessionId = 'sess-settled'
        const nodeId = 'node_local'
        const taskId = 'task_settled'
        // Worker started (acked), finished, but the completion event was lost — the session is
        // now genuinely idle and stays idle every tick.
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'claude-history-settled',
            messages: [{ role: 'assistant', content: 'All done — built and tests pass.', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        // Tick 1: held (streak=1).
        await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        // Tick 2: idle confirmed (streak=2) → synthesize the genuinely-lost completion AND surface it.
        await runMeshReconcileTick(components)
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.source).toBe('daemon_reconcile_transcript_completion')
        expect((completed?.payload as any)?.finalSummary).toContain('All done')
        // The coordinator gets a pending completion event to surface — the notification is not lost.
        expect(getPendingMeshCoordinatorEvents(meshId).some(p => p.event === 'agent:generating_completed')).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    it('never-acked (dispatched) lost completion: still synthesizes on the FIRST idle tick (debounce is acked-only)', async () => {
      const meshId = `mesh_reconcile_phase4_dispatched_firsttick_${Date.now()}`
      try {
        const sessionId = 'sess-dispatched'
        const nodeId = 'node_local'
        const taskId = 'task_dispatched_lost'
        // No generating_started ever observed (status stays 'dispatched') — there is no in-flight
        // generation to protect, so the existing first-tick synth behavior is preserved.
        appendLedgerEntry(meshId, {
          kind: 'task_dispatched', nodeId, sessionId, providerType: 'claude-cli',
          payload: { source: 'direct', via: 'local_direct', taskId, message: 'do work' },
          timestamp: dispatchTimeIso(5 * 60),
        } as any)
        insertDirectDispatch(meshId, {
          taskId, nodeId, sessionId, providerType: 'claude-cli', message: 'do work',
          via: 'local_direct', dispatchedAt: dispatchTimeIso(5 * 60),
        })
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') {
            return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'claude-history-dispatched',
            messages: [{ role: 'assistant', content: 'All done on the dispatched task.', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        await runMeshReconcileTick(components)
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.finalSummary).toContain('All done on the dispatched task')
      } finally {
        cleanup(meshId)
      }
    })

    // ── R4e: RECONCILE-SYNTH-PREEMPTS-COMPLETION race hardening ───────────────
    // The consecutive-tick guard alone is a ~8s window a long worker turn can straddle with a
    // mid-turn idle read, synthesizing a completion ~11s BEFORE the worker's real emit (the synth
    // then wins the taskId fingerprint dedup and masks the genuine one). R4e adds: (1) a time-based
    // idle-settle hurdle, (2) a live re-probe at commit, (3) worker-emit priority (yield to a real
    // emit already queued), and (4) an acked-turn settle window. All four are FINITE so a truly
    // dead worker that never emits is still eventually synthesized (notification-miss stays 0).

    it('R4e worker-emit priority (live race): when the worker\'s REAL completion is already queued, the in-flight synth YIELDS — no premature pre-empting synth', async () => {
      const meshId = `mesh_reconcile_r4e_emit_priority_${Date.now()}`
      // Disable the time hurdles so this isolates the worker-emit-priority yield (fix 3).
      process.env.MESH_INFLIGHT_MIN_IDLE_SETTLE_MS = '0'
      process.env.MESH_INFLIGHT_ACKED_TURN_SETTLE_MS = '0'
      try {
        const sessionId = 'sess-emit-priority'
        const nodeId = 'node_local'
        const taskId = 'task_emit_priority'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        // read_chat reads idle with a post-dispatch tail summary — the synth WOULD fire on tick 2.
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-emit',
            messages: [{ role: 'assistant', content: 'mid-turn rendered text', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        // Tick 1: first idle (streak=1) → held.
        await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)

        // The worker's REAL generating_completed lands in the pending queue (forwarded by the
        // worker) BEFORE the synth-eligible tick — the exact R4e race.
        queuePendingMeshCoordinatorEvent({
          event: 'agent:generating_completed',
          meshId,
          nodeLabel: `Node '${nodeId}'`,
          nodeId,
          metadataEvent: { taskId, sessionId, providerSessionId: 'claude-history-emit', finalSummary: 'REAL worker completion — full 53s turn result.', timestamp: Date.now() },
          coordinatorMessage: `Node '${nodeId}' has completed its task.`,
          queuedAt: Date.now(),
        })

        // Tick 2: streak=2 + time hurdles disabled → would synth, but the real emit is queued →
        // worker-emit priority YIELDS. No synthesized terminal is written.
        await runMeshReconcileTick(components)
        const synth = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed' && (e.payload as any)?.source === 'daemon_reconcile_transcript_completion')
        expect(synth).toHaveLength(0)
        // The worker's own completion is intact in the queue (it surfaces to the coordinator).
        const pending = getPendingMeshCoordinatorEvents(meshId).filter(p => p.event === 'agent:generating_completed')
        expect(pending).toHaveLength(1)
        expect((pending[0].metadataEvent as any)?.finalSummary).toContain('REAL worker completion')
      } finally {
        cleanup(meshId)
      }
    })

    it('R4e time settle: a long-turn mid-turn idle (2 consecutive ticks) is DEFERRED until MIN_IDLE_SETTLE elapses — then still synthesizes (finite, no notif-miss)', async () => {
      const meshId = `mesh_reconcile_r4e_settle_${Date.now()}`
      // Acked-turn hurdle off; only the idle-settle hurdle under test. Set settle huge so two
      // back-to-back ticks cannot clear it.
      process.env.MESH_INFLIGHT_ACKED_TURN_SETTLE_MS = '0'
      process.env.MESH_INFLIGHT_MIN_IDLE_SETTLE_MS = '3600000'
      try {
        const sessionId = 'sess-settle'
        const nodeId = 'node_local'
        const taskId = 'task_settle'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-settle',
            messages: [{ role: 'assistant', content: 'mid-turn idle window text', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any

        // Two idle ticks satisfy the tick-count guard, but the time hurdle holds the synth.
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)

        // A genuinely-stalled worker stays idle forever; once the settle window is satisfied the
        // synth MUST eventually fire so the notification is never lost (finite, not an infinite hold).
        process.env.MESH_INFLIGHT_MIN_IDLE_SETTLE_MS = '0'
        await runMeshReconcileTick(components)
        const settled = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(settled).toBeTruthy()
        expect((settled?.payload as any)?.source).toBe('daemon_reconcile_transcript_completion')
      } finally {
        cleanup(meshId)
      }
    })

    it('R4e acked-turn settle: a synth is DEFERRED within ACKED_TURN_SETTLE of the generating_started ack, even with idle reads (a just-started turn is never completed off an early blip)', async () => {
      const meshId = `mesh_reconcile_r4e_ackgrace_${Date.now()}`
      // Idle-settle hurdle off; only the acked-turn hurdle under test. seedAckedDispatch flips the
      // dispatch to 'acked' "just now", so dispatch.updatedAt ≈ now → a huge window holds the synth.
      process.env.MESH_INFLIGHT_MIN_IDLE_SETTLE_MS = '0'
      process.env.MESH_INFLIGHT_ACKED_TURN_SETTLE_MS = '3600000'
      try {
        const sessionId = 'sess-ackgrace'
        const nodeId = 'node_local'
        const taskId = 'task_ackgrace'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-ackgrace',
            messages: [{ role: 'assistant', content: 'idle blip right after ack', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        // The ack happened "just now" → within the acked-turn settle window → no synth.
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    it('R4e live re-probe: a worker that resumed generating between ticks is NOT synthesized off a stale idle snapshot (re-probe at commit time defers)', async () => {
      const meshId = `mesh_reconcile_r4e_reprobe_${Date.now()}`
      process.env.MESH_INFLIGHT_MIN_IDLE_SETTLE_MS = '0'
      process.env.MESH_INFLIGHT_ACKED_TURN_SETTLE_MS = '0'
      try {
        const sessionId = 'sess-reprobe'
        const nodeId = 'node_local'
        const taskId = 'task_reprobe'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        // read_chat reads idle for the per-tick top reads, but the synth-commit RE-PROBE (the 3rd
        // read_chat call, on tick 2) catches the worker having resumed generating.
        let readChatCalls = 0
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          readChatCalls++
          const status = readChatCalls >= 3 ? 'generating' : 'idle'
          return {
            success: true, status, providerSessionId: 'claude-history-reprobe',
            messages: [{ role: 'assistant', content: 'intermediate text', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any
        await runMeshReconcileTick(components) // tick 1: top read idle (#1) → streak=1, held
        await runMeshReconcileTick(components) // tick 2: top read idle (#2) → streak=2 → re-probe (#3)=generating → defer
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })
  })

  // ── PHASE 5: auto-prune orphaned direct dispatch records ────────────────────
  // staleDirectWork (orphaned direct-dispatch rows whose node/session is no longer in
  // the live mesh) otherwise accumulates for days. PHASE 5 runs the shared prune core
  // (the same one mesh_prune_stale_direct uses) on the daemon timer, in execute mode,
  // gated by a conservative age threshold so transiently-invisible work is never pruned.
  describe('PHASE 5 — auto-prune orphaned direct dispatches', () => {
    function ageIso(ms: number): string {
      return new Date(Date.now() - ms).toISOString()
    }
    const HOUR = 60 * 60_000
    const DAY = 24 * HOUR

    // A components surface with no live coordinators and no remote transport — PHASE 5 only
    // needs commandHandler.handle('get_status_metadata') for live-session probing.
    function makeAutoPruneComponents(statusSessions: any[] = []) {
      const handle = vi.fn(async (cmd: string) => {
        if (cmd === 'get_status_metadata') return { success: true, status: { sessions: statusSessions } }
        return { success: true }
      })
      return {
        components: {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle },
        } as any,
        handle,
      }
    }

    function seedDispatch(meshId: string, taskId: string, nodeId: string, sessionId: string, ageMs: number) {
      insertDirectDispatch(meshId, {
        taskId,
        nodeId,
        sessionId,
        providerType: 'claude-cli',
        message: `work for ${taskId}`,
        via: 'local_direct',
        dispatchedAt: ageIso(ageMs),
      })
    }

    it('orphan (node no longer in mesh) past the age threshold → auto-pruned + ledger entry', async () => {
      const meshId = `mesh_reconcile_phase5_orphan_old_${Date.now()}`
      try {
        const taskId = 'task_orphan_old'
        // Dispatch targets a node that is NOT in the live mesh → "node no longer in live mesh" orphan.
        seedDispatch(meshId, taskId, 'node_gone', 'sess-gone', 2 * DAY)
        // The live mesh has a different node only — node_gone is absent.
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_present', workspace: '/repo/present' }] },
        ])

        const { components } = makeAutoPruneComponents()
        await runMeshReconcileTick(components)

        // The orphaned row is gone from the active surface...
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(false)
        // ...and a direct_dispatch_pruned ledger entry records the prune (audit-only).
        const pruned = readLedgerEntries(meshId).find(e => e.kind === 'direct_dispatch_pruned')
        expect(pruned).toBeTruthy()
        expect((pruned?.payload as any)?.source).toBe('daemon_reconcile_auto_prune')
        expect((pruned?.payload as any)?.taskIds).toContain(taskId)
      } finally {
        cleanup(meshId)
      }
    })

    it('orphan younger than the age threshold → preserved (transient-invisibility protection)', async () => {
      const meshId = `mesh_reconcile_phase5_orphan_young_${Date.now()}`
      try {
        const taskId = 'task_orphan_young'
        // Same orphan shape (node absent) but dispatched only 1h ago — under the 24h gate.
        seedDispatch(meshId, taskId, 'node_gone', 'sess-gone', 1 * HOUR)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_present', workspace: '/repo/present' }] },
        ])

        const { components } = makeAutoPruneComponents()
        await runMeshReconcileTick(components)

        // Held back: still active, and no prune ledger entry written.
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'direct_dispatch_pruned')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('active work (node + session live, generating) → never pruned even when old', async () => {
      const meshId = `mesh_reconcile_phase5_active_${Date.now()}`
      try {
        const taskId = 'task_active'
        const nodeId = 'node_live'
        const sessionId = 'sess-live'
        // Old dispatch, but the node IS in the mesh and the session IS live + generating.
        seedDispatch(meshId, taskId, nodeId, sessionId, 3 * DAY)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/live' }] },
        ])

        // get_status_metadata reports the session as live + generating → not stale at all.
        const { components } = makeAutoPruneComponents([
          { id: sessionId, status: 'generating' },
        ])
        await runMeshReconcileTick(components)

        // Active work is never an orphan → preserved, no prune.
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'direct_dispatch_pruned')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('idempotent: a second tick prunes nothing more (one prune ledger entry only)', async () => {
      const meshId = `mesh_reconcile_phase5_idempotent_${Date.now()}`
      try {
        const taskId = 'task_idem'
        seedDispatch(meshId, taskId, 'node_gone', 'sess-gone', 2 * DAY)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_present', workspace: '/repo/present' }] },
        ])

        const { components } = makeAutoPruneComponents()
        // First tick prunes the orphan.
        await runMeshReconcileTick(components)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(false)

        // Second tick: the row is already gone → nothing to prune, no extra ledger entry.
        await runMeshReconcileTick(components)
        const pruneEntries = readLedgerEntries(meshId).filter(e => e.kind === 'direct_dispatch_pruned')
        expect(pruneEntries).toHaveLength(1)
        expect((pruneEntries[0].payload as any)?.prunedCount).toBe(1)
      } finally {
        cleanup(meshId)
      }
    })

    it('prune preserves the original task_dispatched audit entry (only the store row is removed)', async () => {
      const meshId = `mesh_reconcile_phase5_audit_${Date.now()}`
      try {
        const taskId = 'task_audit'
        const sessionId = 'sess-gone'
        // Record both the audit ledger entry AND the store row for an orphaned dispatch.
        appendLedgerEntry(meshId, {
          kind: 'task_dispatched',
          nodeId: 'node_gone',
          sessionId,
          providerType: 'claude-cli',
          payload: { source: 'direct', via: 'local_direct', taskId, message: 'work for audit' },
        } as any)
        seedDispatch(meshId, taskId, 'node_gone', sessionId, 2 * DAY)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_present', workspace: '/repo/present' }] },
        ])

        const { components } = makeAutoPruneComponents()
        await runMeshReconcileTick(components)

        // Store row pruned...
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(false)
        // ...but the append-only audit history (task_dispatched) is intact, and the prune is recorded.
        const entries = readLedgerEntries(meshId)
        expect(entries.some(e => e.kind === 'task_dispatched' && (e.payload as any)?.taskId === taskId)).toBe(true)
        expect(entries.some(e => e.kind === 'direct_dispatch_pruned')).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    it('does not auto-prune for a mesh this daemon does not host', async () => {
      const meshId = `mesh_reconcile_phase5_nothost_${Date.now()}`
      try {
        const taskId = 'task_nothost'
        seedDispatch(meshId, taskId, 'node_gone', 'sess-gone', 2 * DAY)
        // Hosted by a different daemon → daemonHostsMesh is false → PHASE 5 must skip it.
        meshConfigMocks.listMeshes.mockReturnValue([
          {
            id: meshId,
            meshHost: { role: 'host', hostDaemonId: 'other-daemon' },
            nodes: [{ id: 'node_present', workspace: '/repo/present', daemonId: 'other-daemon' }],
          },
        ])

        const { components } = makeAutoPruneComponents()
        await runMeshReconcileTick(components)

        // Not our mesh → the orphan is left untouched.
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'direct_dispatch_pruned')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })
  })

  // ── PHASE 2.5: assigned-stranded dispatch watchdog (Bug B) ──────────────────
  // claimNextTask atomically marks a row 'assigned' BEFORE its fire-and-forget
  // dispatch runs. A dispatch that neither rejects nor is confirmed delivered (a
  // relay that hangs without acking, or a confirm timer lost to a daemon restart)
  // would leave the row 'assigned' forever — PHASE 3 skips it (0 pending). This
  // watchdog returns such a row to 'pending' with ownership cleared.
  describe('PHASE 2.5 — assigned-stranded dispatch watchdog', () => {
    // > ASSIGNED_STRANDED_DEADLINE_MS (5 min) so the row is provably past the window.
    const STRANDED_MS = 6 * 60_000

    function backdateDispatch(meshId: string, taskId: string, ageMs: number) {
      const store = MeshRuntimeStore.getInstance()
      const entry = store.findQueueEntryById(meshId, taskId)!
      entry.dispatchTimestamp = new Date(Date.now() - ageMs).toISOString()
      store.updateQueueEntry(entry)
    }

    // A local mesh (node has no daemonId → hosted by this daemon) with NO idle session
    // and no launchable provider, so PHASE 3 cannot re-dispatch — the reclaimed row stays
    // pending and the watchdog's effect is observable in isolation.
    function makeNoWorkerComponents() {
      return { instanceManager: { getByCategory: () => [], getInstance: () => undefined } } as any
    }
    function hostMesh(meshId: string, nodeId: string) {
      const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])
      meshConfigMocks.getMesh.mockReturnValue(mesh)
    }

    it('reclaims an assigned row whose dispatch was never confirmed, once past the deadline', async () => {
      const meshId = `mesh_phase25_strand_${Date.now()}`
      const nodeId = 'node_w'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
        const claimed = claimNextTask(meshId, nodeId, 'sess-hung', [])
        expect(claimed).not.toBeNull()
        backdateDispatch(meshId, claimed!.id, STRANDED_MS)
        hostMesh(meshId, nodeId)

        await runMeshReconcileTick(makeNoWorkerComponents())

        const row = getQueue(meshId).find(t => t.id === claimed!.id)!
        expect(row.status).toBe('pending')
        expect(row.assignedNodeId).toBeUndefined()
        expect(row.assignedSessionId).toBeUndefined()
        expect(row.dispatchTimestamp).toBeUndefined()
        expect(row.strandedReclaimCount).toBe(1)
        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect((reclaimed[0].payload as any).taskId).toBe(claimed!.id)
        expect((reclaimed[0].payload as any).outcome).toBe('pending')
      } finally {
        cleanup(meshId)
      }
    })

    it('does NOT reclaim or re-dispatch an assigned row that already has terminal task ledger evidence', async () => {
      const meshId = `mesh_phase25_terminal_skip_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-idle-worker'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
        const claimed = claimNextTask(meshId, nodeId, 'sess-finished', [])!
        backdateDispatch(meshId, claimed.id, STRANDED_MS)
        appendLedgerEntry(meshId, {
          kind: 'task_completed',
          nodeId,
          sessionId: 'sess-finished',
          providerType: 'claude-cli',
          payload: {
            taskId: claimed.id,
            finalSummary: 'finished before dispatch confirm was observed',
            evidenceLevel: 'sufficient',
          },
        } as any)

        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: 'test-machine' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        expect(handleCliCommand).not.toHaveBeenCalled()
        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('completed')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('does NOT reclaim an assigned row whose dispatch WAS confirmed delivered (genuine in-flight)', async () => {
      const meshId = `mesh_phase25_confirmed_${Date.now()}`
      const nodeId = 'node_w'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
        const claimed = claimNextTask(meshId, nodeId, 'sess-live', [])!
        backdateDispatch(meshId, claimed.id, STRANDED_MS)
        // A confirmed delivery for this task → genuinely dispatched (or completion-lost):
        // PHASE 4's responsibility, never the dispatch watchdog's.
        createSessionDelivery({ meshId, nodeId, sessionId: 'sess-live', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
        hostMesh(meshId, nodeId)

        await runMeshReconcileTick(makeNoWorkerComponents())

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe('sess-live')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('matches bare and daemon_ coordinator id forms when deciding this daemon hosts queue recovery', async () => {
      const meshId = `mesh_phase25_canon_host_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-idle-worker'
      const coordinatorCore = 'coord_form_safe'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
        Object.assign(components, { statusInstanceId: coordinatorCore })
        const mesh = {
          id: meshId,
          meshHost: { role: 'host', hostDaemonId: `daemon_${coordinatorCore}` },
          nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: `daemon_${coordinatorCore}` }],
        }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        expect(handleCliCommand).toHaveBeenCalledWith('agent_command', expect.objectContaining({
          targetSessionId: sessionId,
          action: 'send_chat',
        }))
      } finally {
        cleanup(meshId)
      }
    })

    it('does NOT dispatch a pending task that already has terminal task ledger evidence', async () => {
      const meshId = `mesh_phase25_pending_terminal_skip_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-idle-worker'
      const taskId = 'task-already-terminal'
      try {
        enqueueTask(meshId, 'do work', { id: taskId, targetNodeId: nodeId })
        appendLedgerEntry(meshId, {
          kind: 'task_completed',
          nodeId,
          sessionId: 'sess-previous-worker',
          providerType: 'claude-cli',
          payload: {
            taskId,
            finalSummary: 'already finished',
            evidenceLevel: 'sufficient',
          },
        } as any)

        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: 'test-machine' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        expect(handleCliCommand).not.toHaveBeenCalled()
        const row = getQueue(meshId).find(t => t.id === taskId)!
        expect(row.status).toBe('completed')
      } finally {
        cleanup(meshId)
      }
    })

    it('does NOT reclaim an assigned row still inside the dispatch-confirm window (no premature requeue)', async () => {
      const meshId = `mesh_phase25_fresh_${Date.now()}`
      const nodeId = 'node_w'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
        const claimed = claimNextTask(meshId, nodeId, 'sess-fresh', [])!
        // dispatchTimestamp is "now" (just claimed) — well under the deadline.
        hostMesh(meshId, nodeId)

        await runMeshReconcileTick(makeNoWorkerComponents())

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe('sess-fresh')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('reclaimed task is re-dispatched the same tick onto a now-idle local worker (PHASE 2.5 → PHASE 3)', async () => {
      const meshId = `mesh_phase25_redispatch_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-idle-worker'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId })
        // Stranded on a (now gone) session; an idle worker session is available to re-claim.
        const claimed = claimNextTask(meshId, nodeId, 'sess-dead', [])!
        backdateDispatch(meshId, claimed.id, STRANDED_MS)

        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: 'test-machine' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        // PHASE 2.5 returned it to pending + cleared ownership; PHASE 3 re-dispatched it
        // onto the idle worker in the same tick.
        expect(handleCliCommand).toHaveBeenCalledWith('agent_command', expect.objectContaining({
          targetSessionId: sessionId,
          action: 'send_chat',
        }))
        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe(sessionId)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })
  })
})
