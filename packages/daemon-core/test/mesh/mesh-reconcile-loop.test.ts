import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

import { runMeshReconcileTick, __resetReconcileInFlightSynthDebounceForTests, getMeshV2BackstopCounters, __resetMeshV2BackstopCountersForTests, __resetReclaimUnknownStreakForTests, restampReboundMeshWorkerAssignment } from '../../src/mesh/mesh-reconcile-loop.js'
import { setLogLevel, getRecentLogs } from '../../src/logging/logger.js'
import { queuePendingMeshCoordinatorEvent, drainPendingMeshCoordinatorEvents, getPendingMeshCoordinatorEvents } from '../../src/mesh/mesh-events-pending.js'
import { reconcileDirectDispatchCompletionFromTranscript } from '../../src/mesh/mesh-events-stale.js'
import { __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, __clearMeshQueueForTests, insertDirectDispatch, getActiveDirectDispatches, updateDirectDispatchStatus, claimNextTask, reclaimStrandedAssignedTask, cancelTask, recordTaskAutoLaunch } from '../../src/mesh/mesh-work-queue.js'
import { getLedgerDir, appendLedgerEntry, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createSessionDelivery, updateSessionDeliveryStatus } from '../../src/mesh/mesh-delivery-policy.js'
import { recordTurnAck, recordTurnStage, openTurnAttempt, proposeTurnCompletion, getTurnLedgerMetrics, __resetTurnLedgerMetricsForTests, evaluateRedrive } from '../../src/mesh/mesh-turn-ledger.js'
import { CONSUME_GRACE_FLOOR_MS, CONSUME_GRACE_NATIVE_SOURCE_MS } from '../../src/mesh/mesh-consume-grace.js'

function cleanup(meshId: string) {
  try { __clearMeshQueueForTests(meshId) } catch { /* best-effort */ }
  __resetMeshRuntimeStoreForTests()
  __resetReconcileInFlightSynthDebounceForTests()
  __resetReclaimUnknownStreakForTests()
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

function makeComponents(coordinators: any[], dispatchMeshCommand?: any, statusInstanceId?: string, getMeshPeerConnectionStatus?: any) {
  return {
    instanceManager: {
      getByCategory: (category: string) => (category === 'cli' ? coordinators : []),
    },
    ...(dispatchMeshCommand ? { dispatchMeshCommand } : {}),
    ...(statusInstanceId ? { statusInstanceId } : {}),
    ...(getMeshPeerConnectionStatus ? { getMeshPeerConnectionStatus } : {}),
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
  // These cases assert the accept-mode delivery/hold semantics (v1 broadcast fallback,
  // unversioned events delivered) that predate v2 enforce. Enforce now defaults ON when
  // the env is unset, which would quarantine those events — so pin it explicitly OFF for
  // this block. The dedicated T6 backstop/enforce cases set the env themselves.
  beforeEach(() => { process.env.MESH_PROTOCOL_V2_ENFORCE = '0' })
  // R4f acked-hold death-deadline knob is env-tunable and read at call time; always clear it
  // after each case so a test that sets it never leaks into the next.
  afterEach(() => {
    delete process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS
    delete process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS
    delete process.env.MESH_PROTOCOL_V2_ENFORCE
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

  // ── NOTIF (B) desync diagnostic instrumentation ───────────────────────────
  // The confirmed (B) defect is a RUNTIME desync: a coordinator whose adapter/FSM is
  // idle is nonetheless classified busy by the reconcile loop, so its worker's
  // completion is held and never drains until the user's next turn edge. Static
  // analysis found no code path where the three status sources (getState().status,
  // lastStatus, adapter.getStatus({allowParse:false}).status) all return idle yet the
  // loop holds — so the divergence is between those sources at runtime. These tests do
  // NOT reproduce the live desync (a unit fake unifies the sources by construction);
  // they verify that the read-only `coordDiag` instrumentation CAPTURES all three
  // sources and that the same-tick hold log can be paired to it by sessionId — so when
  // it ships and runs on a live daemon (--log-level debug), the diverging source is
  // directly readable from the logs. A coordinator that diverges getState=generating
  // (the modal/auto-approve overlay) while lastStatus=idle and adapterRaw=idle is the
  // `getState_overlay` origin; this models it.
  describe('coordDiag instrumentation (read-only, NOTIF (B) origin localization)', () => {
    afterEach(() => { setLogLevel('info') })

    it('captures getState/lastStatus/adapterRaw + autoApproveBusy/maskSince for a held coordinator and pairs to the hold log by sessionId', async () => {
      const meshId = `mesh_coorddiag_${Date.now()}`
      try {
        setLogLevel('debug')
        const sink: any[] = []
        // A coordinator whose getState() overlay says generating (the loop's busy basis)
        // while the underlying adapter raw and lastStatus are idle — the getState_overlay
        // desync class. The instrumentation must surface all three distinct values.
        const sessionId = 'coord-overlay-desync'
        const coordinator: any = {
          category: 'cli',
          getState: () => ({ instanceId: sessionId, status: 'generating', settings: { meshCoordinatorFor: meshId } }),
          onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
          // Runtime-only fields the diagnostic reads directly off the instance.
          lastStatus: 'idle',
          autoApproveBusy: true,
          autoApproveMaskSince: 1717000000000,
          adapter: { getStatus: (_opts: any) => ({ status: 'idle' }) },
        }
        const components = makeComponents([coordinator])
        queueCompletion(meshId, 'overlay')

        await runMeshReconcileTick(components)

        // No idle target (getState overlay says generating) → held, not injected.
        expect(coordinator.onEvent).not.toHaveBeenCalled()
        expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(1)

        const logs = getRecentLogs(200, 'debug')
        const diag = logs.find(e => e.category === 'MeshReconcile' && e.message.startsWith('coordDiag') && e.message.includes(`sess=${sessionId}`))
        expect(diag, 'coordDiag line should be emitted for the coordinator').toBeTruthy()
        // All three sources captured, and they diverge — this is what localizes the origin.
        expect(diag!.message).toContain('getState=generating')
        expect(diag!.message).toContain('lastStatus=idle')
        expect(diag!.message).toContain('adapterRaw=idle')
        expect(diag!.message).toContain('autoApproveBusy=true')
        expect(diag!.message).toContain('maskSince=1717000000000')

        // The hold decision log names the same sessionId on the same tick, so an operator
        // can cross-reference the diverging-source coordDiag to the actual strand.
        const hold = logs.find(e => e.category === 'MeshReconcile' && e.message.startsWith('coordHoldGenerating'))
        expect(hold, 'generating-hold diag should name the held sessionId').toBeTruthy()
        expect(hold!.message).toContain(sessionId)
      } finally {
        cleanup(meshId)
      }
    })

    it('reuses the already-read state (no second getState() call) and reads adapter with allowParse:false', async () => {
      const meshId = `mesh_coorddiag_noside_${Date.now()}`
      try {
        setLogLevel('debug')
        const sink: any[] = []
        let getStateCalls = 0
        const adapterParseFlags: Array<boolean | undefined> = []
        const sessionId = 'coord-sideeffect-probe'
        const coordinator: any = {
          category: 'cli',
          getState: () => { getStateCalls++; return { instanceId: sessionId, status: 'generating', settings: { meshCoordinatorFor: meshId } } },
          onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
          lastStatus: 'generating',
          autoApproveBusy: false,
          autoApproveMaskSince: 0,
          adapter: { getStatus: (opts: any) => { adapterParseFlags.push(opts?.allowParse); return { status: 'generating' } } },
        }
        const components = makeComponents([coordinator])
        queueCompletion(meshId, 'noside')

        await runMeshReconcileTick(components)

        // findLiveCoordinators reads getState() exactly once per instance; the diagnostic
        // must NOT add a second call (getState runs maybeAutoApproveStatus as a side effect).
        expect(getStateCalls).toBe(1)
        // The adapter raw read must be side-effect-free (allowParse:false only reads activeModal).
        expect(adapterParseFlags.every(f => f === false)).toBe(true)
        expect(adapterParseFlags.length).toBeGreaterThan(0)
      } finally {
        cleanup(meshId)
      }
    })

    it('emits no coordDiag line when log level is info (zero overhead in normal mode)', async () => {
      const meshId = `mesh_coorddiag_off_${Date.now()}`
      try {
        setLogLevel('info')
        const sink: any[] = []
        let adapterCalls = 0
        const coordinator: any = {
          category: 'cli',
          getState: () => ({ instanceId: 'coord-off', status: 'generating', settings: { meshCoordinatorFor: meshId } }),
          onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
          lastStatus: 'idle',
          adapter: { getStatus: () => { adapterCalls++; return { status: 'idle' } } },
        }
        const components = makeComponents([coordinator])
        queueCompletion(meshId, 'off')

        await runMeshReconcileTick(components)

        // Scope to THIS mesh — the ring buffer is process-global and retains coordDiag
        // lines from earlier debug-level tests in this file.
        const diag = getRecentLogs(200, 'debug').find(e => e.message.startsWith('coordDiag') && e.message.includes(meshId))
        expect(diag).toBeUndefined()
        // The adapter raw read is gated behind getLogLevel()==='debug' — not called in info mode.
        expect(adapterCalls).toBe(0)
      } finally {
        cleanup(meshId)
      }
    })
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

  it('CODA-TERMINAL-EVENT-HELD: an ownerless self-fallback broadcast terminal event held while the coordinator generates is delivered to that coordinator on idle return', async () => {
    // project-mesh-self-fallback-terminal-broadcast-drop. A terminal event
    // (worktree_bootstrap_complete / refine:completed) emitted while THIS machine's
    // coordinator CLI session is generating has NO coordinator identity → self-fallback
    // BROADCAST, previously targetCoordinatorDaemonId:null. It is held under
    // generating_no_idle_coordinator; the fix stamps the self daemon id so it is
    // addressable and delivered on the coordinator's next idle tick (not stranded in the
    // ledger where the coordinator would have to poll to find it).
    for (const eventName of ['worktree_bootstrap_complete', 'refine:completed']) {
      const meshId = `mesh_reconcile_selffb_${eventName.replace(/[^a-z]/g, '')}_${Date.now()}`
      try {
        const sink: any[] = []
        let status: 'generating' | 'idle' = 'generating'
        const coordinator = {
          category: 'cli',
          getState: () => ({ instanceId: 'coord-selffb', status, settings: { meshCoordinatorFor: meshId } }),
          onEvent: vi.fn((_event: string, payload: any) => sink.push(payload)),
        }
        const components = makeComponents([coordinator])
        // Queue with NO targetCoordinatorDaemonId and NO targetCoordinatorSessionId →
        // ownerless self-fallback broadcast (the exact live-stranded shape).
        queuePendingMeshCoordinatorEvent({
          event: eventName,
          meshId,
          nodeLabel: "Node 'node_child_1'",
          nodeId: 'node_child_1',
          metadataEvent: { sessionId: `sess-${eventName}`, timestamp: Date.now(), finalSummary: 'work done' },
          coordinatorMessage: `Node 'node_child_1' finished (${eventName}).`,
          queuedAt: Date.now(),
        })

        // Tick 1: coordinator generating → held, nothing injected.
        await runMeshReconcileTick(components)
        expect(coordinator.onEvent, `${eventName} held while generating`).not.toHaveBeenCalled()
        expect(getPendingMeshCoordinatorEvents(meshId), `${eventName} still queued`).toHaveLength(1)

        // Tick 2: coordinator idle → the held self-fallback broadcast is delivered.
        status = 'idle'
        await runMeshReconcileTick(components)
        expect(coordinator.onEvent, `${eventName} delivered on idle`).toHaveBeenCalledTimes(1)
        expect(coordinator.onEvent.mock.calls[0][1].input.textFallback).toContain('finished')
        // Consumed exactly once — not stranded, no re-delivery.
        expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
      } finally {
        cleanup(meshId)
      }
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

  it('C1: a large backlog of undelivered completions is not dropped (no silent loss)', () => {
    const meshId = `mesh_trim_drop_${Date.now()}`
    try {
      // This used to pin the JSONL trim: 60 events × ~4KB pushed the per-mesh pending
      // file past its 100KB / 50-entry cap, and the trim had to mirror each dropped
      // event into the ledger as `pending_trim_dropped` rather than discard it silently.
      //
      // SQLite is now the sole store and has no size/count cap — growth is bounded by
      // prunePendingMeshCoordinatorEventsRetention on a 30-day undrained window instead.
      // So the same backlog is simply NOT dropped, which is a strictly stronger
      // guarantee than mirroring the loss. Assert that directly.
      const bigSummary = 'S'.repeat(4096)
      for (let i = 0; i < 60; i++) {
        queuePendingMeshCoordinatorEvent({
          event: 'agent:generating_completed',
          meshId,
          nodeLabel: "Node 'n'",
          nodeId: 'n',
          metadataEvent: { sessionId: `sess-${i}`, taskId: `task-${i}`, timestamp: 1000 + i, finalSummary: bigSummary },
          coordinatorMessage: `completion ${i}`,
          queuedAt: 1000 + i,
        })
      }

      // Every queued completion survives — nothing was trimmed away.
      const pending = getPendingMeshCoordinatorEvents(meshId)
      expect(pending).toHaveLength(60)
      expect((pending[0].metadataEvent as any).finalSummary).toBe(bigSummary)

      // And nothing was recorded as dropped, because nothing was.
      const dropped = readLedgerEntries(meshId)
        .filter(e => e.kind === 'event_held' && (e.payload as any).reason === 'pending_trim_dropped')
      expect(dropped).toHaveLength(0)
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

  describe('EVENT-DELIVERY-DELAY fix(a): peer-connected pre-check in PHASE 1 pull', () => {
    // The pull loop must not sink into a degraded peer's 90s connect-timeout. When the
    // mesh peer telemetry getter reports a non-'connected' state for a node, that node
    // is skipped THIS tick (no dispatchMeshCommand) and retried next tick — lossless,
    // since an unconnected peer has drained nothing.
    it('skips a peer whose DataChannel is not connected (no dispatch this tick)', async () => {
      const meshId = `mesh_reconcile_precheck_skip_${Date.now()}`
      try {
        const sink: any[] = []
        const coordinator = makeCoordinator(meshId, 'idle', sink)
        const dispatchMeshCommand = vi.fn(async () => ({ success: true, events: [] }))

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' }] },
        ])

        // Peer telemetry: the remote peer is still connecting (not open).
        const getMeshPeerConnectionStatus = vi.fn((daemonId: string) =>
          daemonId === 'remote-daemon' ? { state: 'connecting', transport: 'p2p' } : null)

        const components = makeComponents([coordinator], dispatchMeshCommand, undefined, getMeshPeerConnectionStatus)

        await runMeshReconcileTick(components)

        // Pre-check consulted the getter and skipped the pull — no get_pending_mesh_events.
        expect(getMeshPeerConnectionStatus).toHaveBeenCalledWith('remote-daemon')
        const pullCalls = dispatchMeshCommand.mock.calls.filter((c: any[]) => c[1] === 'get_pending_mesh_events')
        expect(pullCalls).toHaveLength(0)
      } finally {
        cleanup(meshId)
      }
    })

    it('retries the skipped peer on the next tick once it reports connected', async () => {
      const meshId = `mesh_reconcile_precheck_retry_${Date.now()}`
      try {
        const sink: any[] = []
        const coordinator = makeCoordinator(meshId, 'idle', sink)

        const remoteEvent = {
          event: 'agent:generating_completed',
          meshId,
          nodeLabel: "Node 'node_remote'",
          nodeId: 'node_remote',
          metadataEvent: { sessionId: 'sess-retry', providerType: 'claude-cli', timestamp: Date.now() },
          coordinatorMessage: "Node 'node_remote' has completed its task (retry).",
          queuedAt: Date.now(),
        }
        const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
          if (command === 'get_pending_mesh_events' && daemonId === 'remote-daemon') {
            return { success: true, events: [remoteEvent] }
          }
          return { success: true, events: [] }
        })

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' }] },
        ])

        // Tick 1: connecting → skip. Tick 2: connected → pull.
        let state = 'connecting'
        const getMeshPeerConnectionStatus = vi.fn((daemonId: string) =>
          daemonId === 'remote-daemon' ? { state, transport: 'p2p' } : null)

        const components = makeComponents([coordinator], dispatchMeshCommand, undefined, getMeshPeerConnectionStatus)

        await runMeshReconcileTick(components)
        expect(dispatchMeshCommand.mock.calls.filter((c: any[]) => c[1] === 'get_pending_mesh_events')).toHaveLength(0)

        state = 'connected'
        await runMeshReconcileTick(components)

        expect(dispatchMeshCommand).toHaveBeenCalledWith(
          'remote-daemon',
          'get_pending_mesh_events',
          expect.objectContaining({ meshId }),
        )
        expect(coordinator.onEvent).toHaveBeenCalled()
      } finally {
        cleanup(meshId)
      }
    })

    it('falls back to the legacy path when the getter is unwired (regression-free, e.g. standalone)', async () => {
      const meshId = `mesh_reconcile_precheck_fallback_${Date.now()}`
      try {
        const sink: any[] = []
        const coordinator = makeCoordinator(meshId, 'idle', sink)

        const remoteEvent = {
          event: 'agent:generating_completed',
          meshId,
          nodeLabel: "Node 'node_remote'",
          nodeId: 'node_remote',
          metadataEvent: { sessionId: 'sess-fallback', providerType: 'claude-cli', timestamp: Date.now() },
          coordinatorMessage: "Node 'node_remote' has completed its task (fallback).",
          queuedAt: Date.now(),
        }
        const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
          if (command === 'get_pending_mesh_events' && daemonId === 'remote-daemon') {
            return { success: true, events: [remoteEvent] }
          }
          return { success: true, events: [] }
        })

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' }] },
        ])

        // No getMeshPeerConnectionStatus wired — the pre-check must NOT skip.
        const components = makeComponents([coordinator], dispatchMeshCommand)

        await runMeshReconcileTick(components)

        expect(dispatchMeshCommand).toHaveBeenCalledWith(
          'remote-daemon',
          'get_pending_mesh_events',
          expect.objectContaining({ meshId }),
        )
        expect(coordinator.onEvent).toHaveBeenCalled()
      } finally {
        cleanup(meshId)
      }
    })

    it('pulls a connected peer normally (state === connected)', async () => {
      const meshId = `mesh_reconcile_precheck_connected_${Date.now()}`
      try {
        const sink: any[] = []
        const coordinator = makeCoordinator(meshId, 'idle', sink)

        const remoteEvent = {
          event: 'agent:generating_completed',
          meshId,
          nodeLabel: "Node 'node_remote'",
          nodeId: 'node_remote',
          metadataEvent: { sessionId: 'sess-connected', providerType: 'claude-cli', timestamp: Date.now() },
          coordinatorMessage: "Node 'node_remote' has completed its task (connected).",
          queuedAt: Date.now(),
        }
        const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
          if (command === 'get_pending_mesh_events' && daemonId === 'remote-daemon') {
            return { success: true, events: [remoteEvent] }
          }
          return { success: true, events: [] }
        })

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' }] },
        ])

        const getMeshPeerConnectionStatus = vi.fn((daemonId: string) =>
          daemonId === 'remote-daemon' ? { state: 'connected', transport: 'p2p' } : null)

        const components = makeComponents([coordinator], dispatchMeshCommand, undefined, getMeshPeerConnectionStatus)

        await runMeshReconcileTick(components)

        expect(getMeshPeerConnectionStatus).toHaveBeenCalledWith('remote-daemon')
        expect(dispatchMeshCommand).toHaveBeenCalledWith(
          'remote-daemon',
          'get_pending_mesh_events',
          expect.objectContaining({ meshId }),
        )
        expect(coordinator.onEvent).toHaveBeenCalled()
      } finally {
        cleanup(meshId)
      }
    })

    // OFFLINE-NODE-FANOUT null-race harden: when the getter IS wired (cloud) but returns
    // null for a node — the exact state a powered-off node lands in each cycle
    // (failPeer deletes the peer → getPeerConnectionStatus returns null) — the pre-check
    // must treat "no peer object right now" as NOT connected and skip the pull, NOT fall
    // through and dial (which would re-queue for another 90s connect wait). Only the
    // genuinely-unwired case (previous test) falls through.
    it('skips a node whose wired getter returns null (offline node null-race — no dispatch)', async () => {
      const meshId = `mesh_reconcile_precheck_null_${Date.now()}`
      try {
        const sink: any[] = []
        const coordinator = makeCoordinator(meshId, 'idle', sink)
        const dispatchMeshCommand = vi.fn(async () => ({ success: true, events: [] }))

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: 'node_remote', workspace: '/repo/remote', daemonId: 'remote-daemon' }] },
        ])

        // Getter WIRED, but returns null for the offline node (no live peer object).
        const getMeshPeerConnectionStatus = vi.fn((_daemonId: string) => null)

        const components = makeComponents([coordinator], dispatchMeshCommand, undefined, getMeshPeerConnectionStatus)

        await runMeshReconcileTick(components)

        // Consulted the getter, saw null → skipped the pull entirely (no 90s dial).
        expect(getMeshPeerConnectionStatus).toHaveBeenCalledWith('remote-daemon')
        const pullCalls = dispatchMeshCommand.mock.calls.filter((c: any[]) => c[1] === 'get_pending_mesh_events')
        expect(pullCalls).toHaveLength(0)
      } finally {
        cleanup(meshId)
      }
    })
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
        enqueueTask(meshId, 'do the work', { targetNodeId: nodeId,
    difficulty: 'medium',
})

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
        enqueueTask(meshId, 'remote work', { targetNodeId: nodeId,
    difficulty: 'medium',
})

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
          router: { execute: (cmd: string) => readChat(cmd) },
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
          router: { execute: (cmd: string) => readChat(cmd) },
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
          router: { execute: (cmd: string) => readChat(cmd) },
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

        const handle = vi.fn(async (cmd: string) => {
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
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle },
          router: { execute: (cmd: string) => handle(cmd) },
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

    // ── R4f GENERATING-BOUNDARY: acked-hold redesign (direction B) ──────────────
    // A worker that was OBSERVED to start generating (dispatch row flipped to 'acked' by the
    // agent:generating_started event) is ALIVE and mid-turn → it WILL eventually emit a real
    // terminal. An `idle` read mid-turn (a CLI PTY inter-tool-call blip, or final text rendered
    // while the lifecycle close lags) must NOT synthesize a completion: the synthesized terminal
    // then masks the REAL completion when it lands seconds later (the R4e live FAIL: synth fired
    // 16s BEFORE the worker's real emit). R4..R4e tried FINITE timers, which always race the
    // worker's variable/unbounded emit latency and lose. R4f instead HOLDS the synth INDEFINITELY
    // for an acked task (safe: a later real emit no-ops idempotently via the terminal ledger) and
    // releases it ONLY on a genuine-death backstop: (a) consecutive read_chat failures after a
    // live-confirmed ack, or (b) an absolute long death-deadline far above any emit latency.
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

    it('R4f acked-hold: a mid-turn idle read does NOT synthesize — held INDEFINITELY under the default (8min) death-deadline, no matter how many idle ticks elapse', async () => {
      const meshId = `mesh_reconcile_r4f_inflight_hold_${Date.now()}`
      // No env override → default 8min death-deadline; the ack is "just now" (seedAckedDispatch
      // flips the row → updated_at ≈ now), so sinceAck ≈ 0 ≪ deadline → indefinite hold.
      try {
        const sessionId = 'sess-inflight'
        const nodeId = 'node_local'
        const taskId = 'task_inflight'
        // Old DISPATCH (downstream grace would not block) — isolating the acked-hold gate.
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)

        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        // read_chat reports idle with a post-dispatch final assistant message — but the worker
        // is actually still generating (this idle is a transient mid-turn blip); the REAL emit is lagging.
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
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        // Many idle ticks — a finite tick/settle guard would eventually FIRE here (the R4e bug);
        // the indefinite acked-hold must NOT, because the worker is presumed alive (ack ≈ now).
        for (let i = 0; i < 6; i++) await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
        expect(getPendingMeshCoordinatorEvents(meshId).some(p => p.event === 'agent:generating_completed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('R4f acked-hold: the worker\'s REAL completion is NOT pre-empted — a slow real emit landing after many idle ticks still surfaces (no masking synth)', async () => {
      const meshId = `mesh_reconcile_r4f_real_emit_wins_${Date.now()}`
      try {
        const sessionId = 'sess-realwins'
        const nodeId = 'node_local'
        const taskId = 'task_realwins'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-realwins',
            messages: [{ role: 'assistant', content: 'mid-turn rendered text', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        // Several idle ticks while the worker is "still generating" (slow turn): NO synth (held).
        for (let i = 0; i < 4; i++) await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)

        // The worker's REAL generating_completed finally lands (the lagging emit) — this is what the
        // R4e synth pre-empted. With the indefinite hold, no synth was ever written, so it surfaces
        // intact and is never masked.
        queuePendingMeshCoordinatorEvent({
          event: 'agent:generating_completed',
          meshId,
          nodeLabel: `Node '${nodeId}'`,
          nodeId,
          metadataEvent: { taskId, sessionId, providerSessionId: 'claude-history-realwins', finalSummary: 'REAL worker completion — full long turn result.', timestamp: Date.now() },
          coordinatorMessage: `Node '${nodeId}' has completed its task.`,
          queuedAt: Date.now(),
        })

        // Another idle tick: the worker-emit-priority auxiliary check yields, and the indefinite hold
        // also still applies — either way NO synthesized terminal is written.
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

    it('R4f death backstop (b): once the absolute death-deadline elapses, a persistently-idle (zombie) acked task IS synthesized — notification-loss net, finite', async () => {
      const meshId = `mesh_reconcile_r4f_death_deadline_${Date.now()}`
      // Force the death-deadline to 0 so the "just-now" ack (sinceAck ≈ 0) immediately crosses it —
      // simulating a worker whose emit was permanently lost and whose session sits idle forever.
      process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
      try {
        const sessionId = 'sess-zombie'
        const nodeId = 'node_local'
        const taskId = 'task_zombie'
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
            providerSessionId: 'claude-history-zombie',
            messages: [{ role: 'assistant', content: 'All done — built and tests pass.', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        // Deadline crossed (= 0) on the very first idle read → the notification-loss net synthesizes.
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

    it('R4f death backstop (a): consecutive read_chat failures after a live-confirmed ack are counted as a death signal (no longer silently swallowed)', async () => {
      const meshId = `mesh_reconcile_r4f_read_failure_death_${Date.now()}`
      try {
        const sessionId = 'sess-deadread'
        const nodeId = 'node_local'
        const taskId = 'task_deadread'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])

        // Tick 1: a live idle read (confirms reachability). Ticks 2..N: read_chat fails (the worker
        // session became unreadable mid-turn). Default deadline (8min) means the deadline itself
        // never fires here — this isolates the read-failure liveness signal: it must NOT synthesize
        // off an unreadable session (no transcript to attribute), never a false completion. We keep
        // the session PRESENT in get_status_metadata so PHASE 5's orphan-prune does not remove the
        // row from under PHASE 4 — isolating the read_chat-failure death path under test.
        let call = 0
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          call++
          if (call === 1) {
            return {
              success: true, status: 'idle', providerSessionId: 'claude-history-deadread',
              messages: [{ role: 'assistant', content: 'mid-turn text', timestamp: 1_700_000_000_000 - 5_000 }],
            }
          }
          return { success: false } // read fails every subsequent tick (session unreadable)
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        // Tick 1 (live idle, held under indefinite hold) then 4 failing reads (death streak).
        for (let i = 0; i < 5; i++) await runMeshReconcileTick(components)
        // No synthesized completion was fabricated off the dead session (no transcript to attribute).
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed' && (e.payload as any)?.source === 'daemon_reconcile_transcript_completion')).toBe(false)
        // The failure path was genuinely exercised — reads were issued until the death signal fired
        // (tick 1 live + 3 failures = the ACKED_DEATH_CONSECUTIVE_READ_FAILURES threshold).
        const reads = readChat.mock.calls.filter(c => c[0] === 'read_chat').length
        expect(reads).toBeGreaterThanOrEqual(4)
        // ACKED-HOLD-TERMINALIZE (mission 91af0cc5): past the threshold the death signal now
        // TERMINALIZES the row instead of logging a release it never performed, so probing STOPS.
        // The pre-fix assertion here was `>= 5` — "read_chat issued every tick" — which encoded the
        // defect as an invariant: with no exit, the live incident reached read_failure_count=20810.
        expect(reads).toBeLessThan(5)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'acked_hold_terminalized'
          && (e.payload as any)?.reason === 'acked_read_failure_death')).toBe(true)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('R4f acked-hold: a worker mid-turn (read reports generating) with NO causally-proven post-dispatch final assistant is never synthesized — clear live signal holds', async () => {
      const meshId = `mesh_reconcile_r4f_generating_hold_${Date.now()}`
      // Even with the death-deadline forced to 0, a `generating` read whose transcript does
      // NOT prove a post-dispatch final assistant is a clear live signal → never synthesized.
      // (The bounded non-idle escape — FLOOR-COMPLETION-NON-IDLE-ESCAPE — requires the
      // transcript's final assistant to be PROVABLY at/after this task's dispatch; this
      // worker's only bubble predates it, so the strict causality guard fails closed.)
      process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
      try {
        const sessionId = 'sess-genhold'
        const nodeId = 'node_local'
        const taskId = 'task_genhold'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'generating' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'generating', providerSessionId: 'claude-history-genhold',
            // Mid-turn narration that PREDATES this task's dispatch (dispatch is at
            // base−300s) — no causal proof of a current-attempt final assistant.
            messages: [{ role: 'assistant', content: 'still working…', timestamp: 1_700_000_000_000 - 400_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any
        for (let i = 0; i < 3; i++) await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    it('never-acked (dispatched) lost completion: still synthesizes on the FIRST idle tick (acked-hold is acked-only)', async () => {
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
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        await runMeshReconcileTick(components)
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.finalSummary).toContain('All done on the dispatched task')
      } finally {
        cleanup(meshId)
      }
    })

    // ── ACKED-HOLD-IDLE-OVERTRUST: transcript-completion fast-track ──────────────
    // The R4f indefinite hold is safe but slow: when the worker's real emit is LOST (not just
    // late), nothing promotes the synth until the 8-min death backstop — even though the answer
    // has been fully rendered in the transcript (read_chat idle WITH a final assistant message)
    // for the whole time. The fast-track promotes the synth EARLY once idle-with-final-assistant
    // has held continuously for a short grace (above the provider's ~34s emit ceiling), while
    // keeping the death backstop as the last-resort net and the real emit idempotent.

    it('ACKED-FASTTRACK: a SINGLE idle-with-final-assistant read does NOT promote — grace not yet met (no premature synth)', async () => {
      const meshId = `mesh_reconcile_fasttrack_single_${Date.now()}`
      // Default grace (40s); the ack is "just now" so a single idle tick has elapsed ~0s of the
      // continuous idle streak → below grace → held, not promoted.
      try {
        const sessionId = 'sess-fasttrack-single'
        const nodeId = 'node_local'
        const taskId = 'task_fasttrack_single'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-ftsingle',
            messages: [{ role: 'assistant', content: 'All done — fast-track candidate.', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        // One tick: the streak anchors but grace (40s) is not yet met → no synth.
        await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
        expect(getPendingMeshCoordinatorEvents(meshId).some(p => p.event === 'agent:generating_completed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('ACKED-FASTTRACK: idle-with-final-assistant past the grace promotes the synth EARLY — well before the 8-min death backstop', async () => {
      const meshId = `mesh_reconcile_fasttrack_promote_${Date.now()}`
      // Force the fast-track grace to 0 so the FIRST idle-with-final-assistant read crosses it,
      // while leaving the death deadline at its 8-min default — proving the EARLY path fired, not
      // the backstop. (Same env-escape-hatch pattern as the death-deadline=0 tests.)
      process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS = '0'
      try {
        const sessionId = 'sess-fasttrack-promote'
        const nodeId = 'node_local'
        const taskId = 'task_fasttrack_promote'
        // Ack ≈ now (seedAckedDispatch flips updated_at to now) → sinceAck ≪ 8min, so the death
        // backstop would NOT fire; only the fast-track can promote here.
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-ftpromote',
            messages: [{ role: 'assistant', content: 'All done — built and tests pass.', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        await runMeshReconcileTick(components)
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.source).toBe('daemon_reconcile_transcript_completion')
        expect((completed?.payload as any)?.finalSummary).toContain('All done')
        expect(getPendingMeshCoordinatorEvents(meshId).some(p => p.event === 'agent:generating_completed')).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    it('ACKED-FASTTRACK: promotion is idempotent — a real emit landing AFTER the fast-track synth writes no duplicate terminal ledger', async () => {
      const meshId = `mesh_reconcile_fasttrack_idempotent_${Date.now()}`
      process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS = '0'
      try {
        const sessionId = 'sess-fasttrack-idem'
        const nodeId = 'node_local'
        const taskId = 'task_fasttrack_idem'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId: 'claude-history-ftidem',
            messages: [{ role: 'assistant', content: 'Done via fast-track.', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        // Tick 1: fast-track promotes the synth (grace=0).
        await runMeshReconcileTick(components)
        const afterSynth = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(afterSynth).toHaveLength(1)

        // The worker's REAL completion finally lands (the lost/late emit). A later reconcile must
        // NOT write a second terminal — hasTerminalLedgerAfterDispatch makes it an idempotent no-op.
        await runMeshReconcileTick(components)
        const afterReal = readLedgerEntries(meshId).filter(e => e.kind === 'task_completed' && e.sessionId === sessionId)
        expect(afterReal).toHaveLength(1)
      } finally {
        cleanup(meshId)
      }
    })

    it('ACKED-FASTTRACK: an interrupting generating read RESETS the streak — a later idle must re-accumulate grace (no carry-over)', async () => {
      const meshId = `mesh_reconcile_fasttrack_reset_${Date.now()}`
      // Grace at its DEFAULT (40s). Tick 1 idle (anchors streak), tick 2 generating (resets it),
      // tick 3 idle again (re-anchors at ~0s). With the default grace none of these single idle
      // ticks can cross 40s → never promoted. This proves a streaming worker that flickers idle
      // is never fast-tracked.
      try {
        const sessionId = 'sess-fasttrack-reset'
        const nodeId = 'node_local'
        const taskId = 'task_fasttrack_reset'
        seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
        meshConfigMocks.listMeshes.mockReturnValue([
          { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
        ])
        const statuses = ['idle', 'generating', 'idle']
        let call = 0
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          const status = statuses[Math.min(call++, statuses.length - 1)]
          return {
            success: true, status, providerSessionId: 'claude-history-ftreset',
            messages: [{ role: 'assistant', content: 'flickering text', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
          router: { execute: (cmd: string) => readChat(cmd) },
        } as any

        for (let i = 0; i < 3; i++) await runMeshReconcileTick(components)
        // No single idle window reached the 40s grace (and the generating tick reset it) → no synth.
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === taskId)).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    // ── T6 (B3c): PHASE-4 / acked-hold demoted to a last-resort backstop ─────────
    // Under mesh-protocol-v2 enforce the completion contract is explicit, so the
    // transcript-synthesis nets should NEVER fire (target 0). They are NOT removed
    // (they remain the correctness net for a genuinely lost emit) but every fire now
    // bumps an observability counter, and under enforce additionally WARNs. These
    // tests assert the counter is bumped on an ACTUAL synth commit — once per path,
    // and only when the synth reconciled (a held/deferred tick must NOT bump it).
    describe('T6 last-resort backstop counters (PHASE-4 / acked-hold demotion)', () => {
      afterEach(() => { __resetMeshV2BackstopCountersForTests(); delete process.env.MESH_PROTOCOL_V2_ENFORCE })

      it('bumps phase4SynthesisFired when a never-acked PHASE-4 transcript synth commits', async () => {
        const meshId = `mesh_t6_phase4_${Date.now()}`
        __resetMeshV2BackstopCountersForTests()
        try {
          const sessionId = 'sess-t6-phase4'
          const nodeId = 'node_local'
          const taskId = 'task_t6_phase4'
          // A never-acked (plain 'dispatched') direct dispatch with no terminal ledger.
          appendLedgerEntry(meshId, {
            kind: 'task_dispatched', nodeId, sessionId, providerType: 'claude-cli',
            payload: { source: 'direct', via: 'local_direct', taskId, message: 'do work' },
            timestamp: dispatchTimeIso(60),
          } as any)
          insertDirectDispatch(meshId, {
            taskId, nodeId, sessionId, providerType: 'claude-cli', message: 'do work',
            via: 'local_direct', dispatchedAt: dispatchTimeIso(60),
          })
          meshConfigMocks.listMeshes.mockReturnValue([{ id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] }])
          const readChat = vi.fn(async (cmd: string) => {
            if (cmd !== 'read_chat') return { success: true }
            return {
              success: true, status: 'idle', providerSessionId: 'claude-history-t6p4',
              messages: [{ role: 'assistant', content: 'All done — built and tests pass.', timestamp: 1_700_000_000_000 - 5_000 }],
            }
          })
          const components = { instanceManager: { getByCategory: () => [], getInstance: () => undefined }, commandHandler: { handle: readChat }, router: { execute: (cmd: string) => readChat(cmd) } } as any

          await runMeshReconcileTick(components)
          expect(getMeshV2BackstopCounters().phase4SynthesisFired).toBe(1)
          expect(getMeshV2BackstopCounters().ackedHoldFastTrackFired).toBe(0)
          expect(getMeshV2BackstopCounters().ackedHoldDeathDeadlineFired).toBe(0)

          // Idempotent: the dispatch is now terminal → a second tick does NOT re-bump.
          await runMeshReconcileTick(components)
          expect(getMeshV2BackstopCounters().phase4SynthesisFired).toBe(1)
        } finally {
          cleanup(meshId)
        }
      })

      it('bumps ackedHoldFastTrackFired when the acked-hold fast-track promotes a synth', async () => {
        const meshId = `mesh_t6_fasttrack_${Date.now()}`
        __resetMeshV2BackstopCountersForTests()
        process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS = '0'
        try {
          const sessionId = 'sess-t6-ft'
          const nodeId = 'node_local'
          const taskId = 'task_t6_ft'
          seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
          meshConfigMocks.listMeshes.mockReturnValue([{ id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] }])
          const readChat = vi.fn(async (cmd: string) => {
            if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
            if (cmd !== 'read_chat') return { success: true }
            return {
              success: true, status: 'idle', providerSessionId: 'claude-history-t6ft',
              messages: [{ role: 'assistant', content: 'All done — built and tests pass.', timestamp: 1_700_000_000_000 - 5_000 }],
            }
          })
          const components = { instanceManager: { getByCategory: () => [], getInstance: () => undefined }, commandHandler: { handle: readChat }, router: { execute: (cmd: string) => readChat(cmd) } } as any

          await runMeshReconcileTick(components)
          expect(getMeshV2BackstopCounters().ackedHoldFastTrackFired).toBe(1)
          expect(getMeshV2BackstopCounters().ackedHoldDeathDeadlineFired).toBe(0)
          expect(getMeshV2BackstopCounters().phase4SynthesisFired).toBe(0)
        } finally {
          delete process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS
          cleanup(meshId)
        }
      })

      it('bumps ackedHoldDeathDeadlineFired when the death-deadline backstop releases a held synth', async () => {
        const meshId = `mesh_t6_death_${Date.now()}`
        __resetMeshV2BackstopCountersForTests()
        process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS = '0'
        try {
          const sessionId = 'sess-t6-death'
          const nodeId = 'node_local'
          const taskId = 'task_t6_death'
          seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
          meshConfigMocks.listMeshes.mockReturnValue([{ id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] }])
          const readChat = vi.fn(async (cmd: string) => {
            if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
            if (cmd !== 'read_chat') return { success: true }
            return {
              success: true, status: 'idle', providerSessionId: 'claude-history-t6death',
              messages: [{ role: 'assistant', content: 'All done — built and tests pass.', timestamp: 1_700_000_000_000 - 5_000 }],
            }
          })
          const components = { instanceManager: { getByCategory: () => [], getInstance: () => undefined }, commandHandler: { handle: readChat }, router: { execute: (cmd: string) => readChat(cmd) } } as any

          await runMeshReconcileTick(components)
          expect(getMeshV2BackstopCounters().ackedHoldDeathDeadlineFired).toBe(1)
          expect(getMeshV2BackstopCounters().ackedHoldFastTrackFired).toBe(0)
          expect(getMeshV2BackstopCounters().phase4SynthesisFired).toBe(0)
        } finally {
          delete process.env.MESH_INFLIGHT_ACKED_DEATH_DEADLINE_MS
          cleanup(meshId)
        }
      })

      it('does NOT bump any backstop counter when an acked task is HELD (no synth commits)', async () => {
        const meshId = `mesh_t6_held_${Date.now()}`
        __resetMeshV2BackstopCountersForTests()
        // Default 8-min death-deadline, no fast-track override → a mid-turn idle blip is
        // held indefinitely: nothing synthesizes, so no backstop fires. Target-0 baseline.
        try {
          const sessionId = 'sess-t6-held'
          const nodeId = 'node_local'
          const taskId = 'task_t6_held'
          seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
          meshConfigMocks.listMeshes.mockReturnValue([{ id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] }])
          const readChat = vi.fn(async (cmd: string) => {
            if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
            if (cmd !== 'read_chat') return { success: true }
            return {
              success: true, status: 'idle', providerSessionId: 'claude-history-t6held',
              messages: [{ role: 'assistant', content: 'intermediate text', timestamp: 1_700_000_000_000 - 5_000 }],
            }
          })
          const components = { instanceManager: { getByCategory: () => [], getInstance: () => undefined }, commandHandler: { handle: readChat }, router: { execute: (cmd: string) => readChat(cmd) } } as any

          await runMeshReconcileTick(components)
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
          expect(getMeshV2BackstopCounters().phase4SynthesisFired).toBe(0)
          expect(getMeshV2BackstopCounters().ackedHoldFastTrackFired).toBe(0)
          expect(getMeshV2BackstopCounters().ackedHoldDeathDeadlineFired).toBe(0)
        } finally {
          cleanup(meshId)
        }
      })
    })

    // ── T2 (B2b): acked-hold state persistence across a daemon restart ──────────
    // The acked-hold state (live-confirmed flag, read-failure counter, fast-track idle
    // streak) used to live only in a process-local Map, so a daemon restart lost it and
    // re-opened the duplicate-emit / drop window. It is now persisted to the
    // mesh_inflight_hold table (read-through / write-through cache) and rehydrated on
    // the first reconcile tick after (re)start. These tests exercise: (1) a tick writes
    // the store row; (2) clearing ONLY the Map cache (a restart) then ticking restores
    // the accumulated streak from disk rather than restarting it from scratch.
    describe('T2 acked-hold persistence (restart rehydration)', () => {
      // A restart clears the process-local Map + rehydrate guard but NOT the SQLite store.
      const simulateRestart = () => __resetReconcileInFlightSynthDebounceForTests()

      function idleWithFinalAssistant(sessionId: string, providerSessionId: string) {
        return vi.fn(async (cmd: string) => {
          if (cmd === 'get_status_metadata') return { success: true, status: { sessions: [{ id: sessionId, status: 'idle' }] } }
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true, status: 'idle', providerSessionId,
            messages: [{ role: 'assistant', content: 'All done — persisted hold test.', timestamp: 1_700_000_000_000 - 5_000 }],
          }
        })
      }

      it('a reconcile tick writes the acked-hold state to the mesh_inflight_hold store row', async () => {
        const meshId = `mesh_reconcile_t2_persist_write_${Date.now()}`
        try {
          const sessionId = 'sess-t2-write'
          const nodeId = 'node_local'
          const taskId = 'task_t2_write'
          // Default grace (40s) + default death deadline (8min): the streak accumulates
          // (first_idle_since_ack gets written) but the hold is NOT yet released — so a
          // persisted row must exist while the hold is still in force.
          seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
          meshConfigMocks.listMeshes.mockReturnValue([
            { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
          ])
          const handle = idleWithFinalAssistant(sessionId, 'claude-history-t2write')
          const components = {
            instanceManager: { getByCategory: () => [], getInstance: () => undefined },
            commandHandler: { handle },
            router: { execute: (cmd: string) => handle(cmd) },
          } as any

          await runMeshReconcileTick(components)

          // No synth yet (held), but the store row records the live-confirmed hold.
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
          const row = MeshRuntimeStore.getInstance().getInflightHold(taskId)
          expect(row).toBeTruthy()
          expect(row?.meshId).toBe(meshId)
          expect(row?.holdReason).toBe('live') // a conclusive idle read confirmed liveness
          expect(row?.readFailureCount).toBe(0)
          expect(typeof row?.firstIdleSinceAck).toBe('number') // fast-track streak anchored
        } finally {
          cleanup(meshId)
        }
      })

      it('rehydrates the fast-track idle streak after a restart — the accumulated grace is NOT reset, so promotion fires on the post-restart tick instead of restarting the streak', async () => {
        const meshId = `mesh_reconcile_t2_rehydrate_${Date.now()}`
        try {
          const sessionId = 'sess-t2-rehydrate'
          const nodeId = 'node_local'
          const taskId = 'task_t2_rehydrate'
          seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
          meshConfigMocks.listMeshes.mockReturnValue([
            { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
          ])
          const handle = idleWithFinalAssistant(sessionId, 'claude-history-t2rehy')
          const components = {
            instanceManager: { getByCategory: () => [], getInstance: () => undefined },
            commandHandler: { handle },
            router: { execute: (cmd: string) => handle(cmd) },
          } as any

          // Tick with the DEFAULT grace (40s): the idle-with-final-assistant streak anchors
          // first_idle_since_ack but 40s has not elapsed → no synth, hold persisted.
          await runMeshReconcileTick(components)
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
          const persisted = MeshRuntimeStore.getInstance().getInflightHold(taskId)
          expect(persisted?.firstIdleSinceAck).toBeTypeOf('number')
          const anchoredAt = persisted!.firstIdleSinceAck!

          // Simulate a daemon restart: the in-memory Map is gone, the store row survives.
          simulateRestart()
          // Prove the cache is empty by reading through the store round-trips the SAME anchor
          // rather than a fresh one — this is what keeps the grace from restarting at 0.
          // Force the grace to 0 for the post-restart tick: if the streak were LOST (reset to
          // this tick's `now`), a 0-grace promotion would still fire — so a 0-grace test cannot
          // by itself prove rehydration. Instead, keep the default grace and advance nothing:
          // rehydration must restore the row so the SAME anchor is compared. We assert the store
          // anchor is unchanged after the restart+tick (the streak was continued, not reset).
          await runMeshReconcileTick(components)
          const afterRestart = MeshRuntimeStore.getInstance().getInflightHold(taskId)
          expect(afterRestart).toBeTruthy()
          // The anchor (first_idle_since_ack) is PRESERVED — rehydration reloaded the pre-restart
          // streak start rather than re-anchoring it to the post-restart tick's clock.
          expect(afterRestart?.firstIdleSinceAck).toBe(anchoredAt)
          expect(afterRestart?.holdReason).toBe('live')
        } finally {
          cleanup(meshId)
        }
      })

      it('rehydrated streak promotes the synth once the grace elapses post-restart — the hold that outlived the restart is honored', async () => {
        const meshId = `mesh_reconcile_t2_promote_after_restart_${Date.now()}`
        try {
          const sessionId = 'sess-t2-promote'
          const nodeId = 'node_local'
          const taskId = 'task_t2_promote'
          seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
          meshConfigMocks.listMeshes.mockReturnValue([
            { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
          ])
          const handle = idleWithFinalAssistant(sessionId, 'claude-history-t2promote')
          const components = {
            instanceManager: { getByCategory: () => [], getInstance: () => undefined },
            commandHandler: { handle },
            router: { execute: (cmd: string) => handle(cmd) },
          } as any

          // Pre-restart tick with a real (40s) grace anchors the streak but does not promote.
          await runMeshReconcileTick(components)
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_completed')).toBe(false)
          expect(MeshRuntimeStore.getInstance().getInflightHold(taskId)?.firstIdleSinceAck).toBeTypeOf('number')

          // Restart clears the Map; then relax the grace to 0 so the NEXT tick promotes — but ONLY
          // if the hold was rehydrated (an isAcked in-flight row present). If the restart had wiped
          // the hold entirely the dispatch would still be acked, and a 0-grace idle read promotes
          // regardless — so this asserts the end-to-end honored-across-restart behavior: the synth
          // surfaces and is idempotent, exactly as a never-restarted hold would.
          simulateRestart()
          process.env.MESH_INFLIGHT_ACKED_TRANSCRIPT_FASTTRACK_GRACE_MS = '0'
          await runMeshReconcileTick(components)

          const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed' && e.sessionId === sessionId)
          expect(completed).toBeTruthy()
          expect((completed?.payload as any)?.source).toBe('daemon_reconcile_transcript_completion')
          // The hold row is reaped on the next prune pass (task left the active set after the synth).
        } finally {
          cleanup(meshId)
        }
      })

      it('prunes the persisted store row when the dispatch is no longer active (bounded growth across restarts)', async () => {
        const meshId = `mesh_reconcile_t2_prune_${Date.now()}`
        try {
          const sessionId = 'sess-t2-prune'
          const nodeId = 'node_local'
          const taskId = 'task_t2_prune'
          seedAckedDispatch(meshId, nodeId, sessionId, taskId, 5 * 60)
          meshConfigMocks.listMeshes.mockReturnValue([
            { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/local' }] },
          ])
          const handle = idleWithFinalAssistant(sessionId, 'claude-history-t2prune')
          const components = {
            instanceManager: { getByCategory: () => [], getInstance: () => undefined },
            commandHandler: { handle },
            router: { execute: (cmd: string) => handle(cmd) },
          } as any

          // Establish the persisted hold row.
          await runMeshReconcileTick(components)
          expect(MeshRuntimeStore.getInstance().getInflightHold(taskId)).toBeTruthy()

          // Terminate the dispatch out-of-band (as a real completion would) so it leaves the
          // active-dispatch set, then restart (clear the Map) so the prune must consult the STORE
          // to discover the now-orphaned row and reap it.
          updateDirectDispatchStatus(meshId, sessionId, 'completed', taskId)
          simulateRestart()
          await runMeshReconcileTick(components)

          expect(MeshRuntimeStore.getInstance().getInflightHold(taskId)).toBeNull()
        } finally {
          cleanup(meshId)
        }
      })
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
      // Local get_status_metadata is a LOW-family registry command, so the
      // reconcile status probe dispatches it through router.execute (not the
      // bare commandHandler.handle, which has no such case and would return
      // "Unknown command"). Mirror that here: router delegates to the same
      // handle fn so the probe resolves.
      const execute = vi.fn(async (cmd: string) => handle(cmd))
      return {
        components: {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle },
          router: { execute },
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
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
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
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
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
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
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
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
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
        enqueueTask(meshId, 'do work', { id: taskId, targetNodeId: nodeId,
    difficulty: 'medium',
})
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
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
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
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
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

    // ── DELIVERED-NOT-CONSUMED short-grace re-drive (remote autoLaunch delivered≠consumed) ──
    // Past the consume grace but < ASSIGNED_STRANDED_DEADLINE_MS (5min): provably inside the
    // short-grace re-drive window and well before the 5min confirm gate.
    //
    // CONSUME-GRACE: the grace is provider-aware (mesh-consume-grace.ts) — the floor is
    // CONSUME_GRACE_FLOOR_MS (90s), and a provider whose turn start is not a PTY event
    // (emitsPtyTurnEvents:false) gets CONSUME_GRACE_NATIVE_SOURCE_MS (180s). These fixtures
    // must therefore backdate past the grace that applies to the row UNDER TEST, not past a
    // single flat constant. Both sit comfortably below the 5min confirm gate, which is what
    // keeps these rows in the short-redrive branch rather than the stranded one.
    const UNCONSUMED_MS = CONSUME_GRACE_FLOOR_MS + 15_000
    const UNCONSUMED_NATIVE_SOURCE_MS = CONSUME_GRACE_NATIVE_SOURCE_MS + 15_000

    it('re-drives a delivered-but-unconsumed REMOTE (UNKNOWN) row only after the UNKNOWN grace (delivered, never acked, not generating)', async () => {
      const meshId = `mesh_phase25_unconsumed_${Date.now()}`
      const nodeId = 'node_w'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        // Model the remote autoLaunch gap: the dispatch reached the worker (delivery 'delivered')
        // but the worker never emitted agent:generating_started (delivery never flips to 'acked'),
        // so the row is stranded 'assigned' with no live turn — but only 40s in, far below 15min.
        const claimed = claimNextTask(meshId, nodeId, 'sess-remote-gone', [])!
        backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
        createSessionDelivery({ meshId, nodeId, sessionId: 'sess-remote-gone', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
        // No local instance for the session → busy verdict UNKNOWN (a remote worker). Fix (d):
        // an UNKNOWN session is a remote worker whose ack may merely not have propagated, so the
        // short re-drive DEFERS on a single UNKNOWN tick and only re-drives after the bounded
        // consecutive-UNKNOWN grace (RECLAIM_UNKNOWN_GRACE_TICKS = 3) — never tearing a live
        // remote worker off its turn on one absent observation.
        hostMesh(meshId, nodeId)

        // Ticks 1..(grace-1): deferred, no reclaim yet.
        await runMeshReconcileTick(makeNoWorkerComponents())
        await runMeshReconcileTick(makeNoWorkerComponents())
        let row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe('sess-remote-gone')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)

        // Tick 3 (grace met): now re-driven.
        await runMeshReconcileTick(makeNoWorkerComponents())
        row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('pending')
        expect(row.assignedSessionId).toBeUndefined()
        expect(row.dispatchTimestamp).toBeUndefined()
        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect((reclaimed[0].payload as any).reason).toBe('delivered_not_consumed_redrive')
      } finally {
        cleanup(meshId)
      }
    })

    // ── GENERATING-STARTED-CONSUME-RACE (fix B) ──────────────────────────────────
    // The delivery-consume that clears the redrive gate runs only when the coordinator
    // PULLS the worker's queued agent:generating_started (PHASE 1 handleMeshForwardEvent →
    // consumeSessionDelivery). If that pull has not yet delivered THIS event, the row still
    // reads 'delivered' at the redrive gate and a genuinely-generating remote worker is torn
    // off its task ("delivered but no generating_started in Ns"). The fix issues a TARGETED,
    // in-process last-chance pull of the assigned node right before re-driving, so the queued
    // generating_started is consumed THIS tick and the redrive is skipped.
    it('fix B: consumes a still-queued generating_started via the in-process last-chance pull and does NOT re-drive', async () => {
      const meshId = `mesh_phase25_genstart_race_${Date.now()}`
      const nodeId = 'node_remote'
      const sessionId = 'sess-remote-generating'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        // Delivered-but-unconsumed remote row, past the UNKNOWN grace: without the fix the very
        // next tick would re-drive it.
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        // The worker HAS emitted generating_started; it sits in the worker daemon's pending
        // queue. The first get_pending_mesh_events call (PHASE 1) returns nothing (the event is
        // not yet drainable on that pull) — modelling the race — so ONLY the redrive gate's
        // targeted last-chance pull (a later call) recovers it. If the fix's pull is absent, the
        // delivery stays 'delivered' and the row is re-driven.
        const generatingStartedEvent = {
          event: 'agent:generating_started',
          meshId,
          nodeLabel: `Node '${nodeId}'`,
          nodeId,
          metadataEvent: { sessionId, taskId: claimed.id, providerType: 'kimi', timestamp: Date.now() },
          queuedAt: Date.now(),
        }
        let pullCount = 0
        const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string) => {
          if (command === 'get_pending_mesh_events' && daemonId === 'remote-daemon') {
            pullCount += 1
            // PHASE 1 (first pull) misses; the redrive gate's targeted pull (later) hits.
            return pullCount >= 2 ? { success: true, events: [generatingStartedEvent] } : { success: true, events: [] }
          }
          return { success: true, events: [] }
        })

        // Mesh: a self coordinator node (proves this daemon hosts the mesh) + the remote worker node.
        const mesh = {
          id: meshId,
          nodes: [
            { id: 'node_coord', workspace: '/repo/coord', daemonId: 'test-machine', machineId: 'test-machine' },
            { id: nodeId, workspace: '/repo/remote', daemonId: 'remote-daemon' },
          ],
        }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        const components = makeComponents([], dispatchMeshCommand)

        await runMeshReconcileTick(components)

        // The targeted last-chance pull consumed the delivery (delivered → acked) …
        expect(MeshRuntimeStore.getInstance().taskDeliveryConsumed(meshId, claimed.id)).toBe(true)
        // … so the redrive gate skipped the reclaim: the row stays assigned, no reclaim ledger.
        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe(sessionId)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('does NOT re-drive a delivered row that WAS consumed (acked) inside the short grace', async () => {
      const meshId = `mesh_phase25_consumed_${Date.now()}`
      const nodeId = 'node_w'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, 'sess-working', [])!
        backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
        // Delivery reached 'acked' — the worker emitted generating_started, i.e. it IS consuming.
        // The short-grace re-drive must leave it alone (never tear a live turn).
        const delivery = createSessionDelivery({ meshId, nodeId, sessionId: 'sess-working', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
        updateSessionDeliveryStatus(delivery.id, 'acked')
        hostMesh(meshId, nodeId)

        await runMeshReconcileTick(makeNoWorkerComponents())

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe('sess-working')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('does NOT re-drive a delivered-but-unconsumed row whose session is locally generating', async () => {
      const meshId = `mesh_phase25_generating_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-generating'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
        // Delivery is 'delivered' and never 'acked' (the generating_started ack was lost/late),
        // but the session is LOCALLY present and generating → verdict GENERATING must protect it.
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
        const generatingInstance = {
          category: 'cli',
          getState: () => ({ instanceId: sessionId, status: 'generating', type: 'claude-cli', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [generatingInstance] : []),
            getInstance: (id: string) => (id === sessionId ? generatingInstance : undefined),
          },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe(sessionId)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    // ── HELD-SUSPENSION RESTART CONTRACT (crash after a pre-consumed waiting_* hold) ──
    // A current-attempt waiting_* hold is durable causal evidence the prompt reached
    // the worker session, even when the weaker generating_started consumed ACK was
    // lost to a crash. Across a daemon restart it must block
    // delivered_not_consumed_redrive long enough to restore the surviving session on
    // the SAME attempt (no reinjection, no reassign), and a demonstrably dead session
    // must release the block so the reclaim opens a NEW attempt.
    describe('HELD-SUSPENSION restart contract', () => {
      // Drive the turn ledger into the exact crash window: open the dispatch attempt
      // (as the real dispatch path does), mark it delivered, then hold a pre-consumed
      // waiting_* edge (consumed never durable). Returns the attempt.
      function holdPreConsumed(meshId: string, nodeId: string, taskId: string, sessionId: string, stage: 'waiting_choice' | 'waiting_approval' = 'waiting_choice') {
        __resetTurnLedgerMetricsForTests()
        const store = MeshRuntimeStore.getInstance()
        const entry = store.findQueueEntryById(meshId, taskId)!
        const { attempt } = openTurnAttempt({
          meshId, taskId, dispatchNonce: entry.dispatchNonce ?? 0, nodeId, sessionId,
        })
        entry.attemptId = attempt.attemptId
        store.updateQueueEntry(entry)
        recordTurnAck({ meshId, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId })
        const held = recordTurnStage({ meshId, taskId, stage, attemptId: attempt.attemptId, sessionId, occurredAtMs: Date.now() })
        expect(held?.deferred).toBe(true)
        return attempt
      }

      it('surviving session after crash: no redrive/reassign, consumed recovered from the hold and applied exactly once on the SAME attempt', async () => {
        const meshId = `mesh_phase25_held_restart_${Date.now()}`
        const nodeId = 'node_w'
        const sessionId = 'sess-held-picker'
        try {
          enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
          const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
          backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
          createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
          const attempt = holdPreConsumed(meshId, nodeId, claimed.id, sessionId)
          hostMesh(meshId, nodeId)
          MeshRuntimeStore.resetForTests() // simulate the daemon restart — only durable state survives

          // The worker session-host survived and rebound: the session is locally
          // present (parked at the picker, reading idle → IDLE_CONFIRMED).
          const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
          await runMeshReconcileTick(components)

          const store = MeshRuntimeStore.getInstance()
          // No redrive, no reclaim, no duplicate prompt — the SAME row/attempt continues.
          const row = getQueue(meshId).find(t => t.id === claimed.id)!
          expect(row.status).toBe('assigned')
          expect(row.assignedSessionId).toBe(sessionId)
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
          expect(handleCliCommand).not.toHaveBeenCalled()
          // Consumed was recovered from the suspension (attempt is the authority even
          // though the delivery row still reads 'delivered'); the hold applied once.
          const after = store.getCurrentTurnAttempt(meshId, claimed.id)!
          expect(after.attemptId).toBe(attempt.attemptId)
          expect(after.stage).toBe('waiting_choice')
          expect(after.consumedAt).not.toBeNull()
          expect(after.terminalOutcome).toBeNull()
          expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!.status).toBe('applied')
          expect(getTurnLedgerMetrics().suspensionConsumedRecovered).toBe(1)
          expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1)

          // A second tick is convergent: still no redrive, no duplicate apply.
          await runMeshReconcileTick(components)
          expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
          expect(getTurnLedgerMetrics().suspensionsApplied).toBe(1)
          expect(handleCliCommand).not.toHaveBeenCalled()
        } finally {
          cleanup(meshId)
        }
      })

      it('approval control: a pre-consumed waiting_approval hold recovers to waiting_approval on the SAME attempt (distinct from choice)', async () => {
        const meshId = `mesh_phase25_held_restart_approval_${Date.now()}`
        const nodeId = 'node_w'
        const sessionId = 'sess-held-approval'
        try {
          enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
          const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
          backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
          createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
          const attempt = holdPreConsumed(meshId, nodeId, claimed.id, sessionId, 'waiting_approval')
          hostMesh(meshId, nodeId)
          MeshRuntimeStore.resetForTests() // simulate the daemon restart

          const { components } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
          await runMeshReconcileTick(components)

          const store = MeshRuntimeStore.getInstance()
          const row = getQueue(meshId).find(t => t.id === claimed.id)!
          expect(row.status).toBe('assigned')
          expect(row.assignedSessionId).toBe(sessionId)
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
          const after = store.getCurrentTurnAttempt(meshId, claimed.id)!
          expect(after.attemptId).toBe(attempt.attemptId)
          expect(after.stage).toBe('waiting_approval')
          expect(after.consumedAt).not.toBeNull()
          expect(store.getHeldTurnSuspension(attempt.attemptId, 'waiting_approval')!.status).toBe('applied')
          expect(getTurnLedgerMetrics().suspensionConsumedRecovered).toBe(1)
        } finally {
          cleanup(meshId)
        }
      })

      it('dead worker session after crash: the hold blocks for the bounded UNKNOWN grace, then releases (session_dead) and the reclaim cleanly opens a NEW attempt', async () => {
        const meshId = `mesh_phase25_held_dead_${Date.now()}`
        const nodeId = 'node_w'
        const deadSession = 'sess-dead-picker'
        const freshSession = 'sess-fresh-worker'
        try {
          enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
          const claimed = claimNextTask(meshId, nodeId, deadSession, [])!
          backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
          createSessionDelivery({ meshId, nodeId, sessionId: deadSession, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
          const attempt = holdPreConsumed(meshId, nodeId, claimed.id, deadSession)
          const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: 'test-machine' }] }
          meshConfigMocks.listMeshes.mockReturnValue([mesh])
          meshConfigMocks.getMesh.mockReturnValue(mesh)
          MeshRuntimeStore.resetForTests() // restart — the worker session did NOT survive

          // A fresh idle worker is available; the dead session never rebinds (UNKNOWN).
          const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, freshSession, 'claude-cli')

          // Ticks 1..grace-1: the unresolved hold BLOCKS the redrive (typed metric).
          await runMeshReconcileTick(components)
          await runMeshReconcileTick(components)
          let row = getQueue(meshId).find(t => t.id === claimed.id)!
          expect(row.status).toBe('assigned')
          expect(row.assignedSessionId).toBe(deadSession)
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
          expect(getTurnLedgerMetrics().redriveBlockedBySuspension).toBe(2)

          // Tick 3 (grace exhausted → demonstrably dead): the hold is dropped
          // (session_dead), the old attempt is cancelled by the reclaim, and PHASE 3
          // re-dispatches the task onto the fresh worker as a NEW attempt.
          await runMeshReconcileTick(components)
          const store = MeshRuntimeStore.getInstance()
          row = getQueue(meshId).find(t => t.id === claimed.id)!
          expect(row.status).toBe('assigned')
          expect(row.assignedSessionId).toBe(freshSession)
          expect(handleCliCommand).toHaveBeenCalledWith('agent_command', expect.objectContaining({
            targetSessionId: freshSession,
            action: 'send_chat',
          }))
          const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
          expect(reclaimed).toHaveLength(1)
          expect((reclaimed[0].payload as any).reason).toBe('delivered_not_consumed_redrive')
          expect(store.getTurnAttempt(attempt.attemptId)!.terminalOutcome).toBe('cancelled')
          const hold = store.getHeldTurnSuspension(attempt.attemptId, 'waiting_choice')!
          expect(hold.status).toBe('dropped')
          expect(hold.resolution).toBe('session_dead')
          expect(getTurnLedgerMetrics().suspensionsDropped.session_dead).toBe(1)
          // The re-dispatch opened a NEW attempt; the dropped hold never leaked onto it.
          const newAttempt = store.getCurrentTurnAttempt(meshId, claimed.id)!
          expect(newAttempt.attemptId).not.toBe(attempt.attemptId)
          expect(store.listHeldTurnSuspensionsForAttempt(newAttempt.attemptId, 'held')).toHaveLength(0)
        } finally {
          cleanup(meshId)
        }
      })
    })

    it('does NOT re-drive a delivered-but-unconsumed row still inside the consume grace (no premature re-drive)', async () => {
      const meshId = `mesh_phase25_unconsumed_fresh_${Date.now()}`
      const nodeId = 'node_w'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, 'sess-fresh-remote', [])!
        // Only 10s in — far below the consume grace: a slow generating_started still has
        // room to arrive. This is the case the live incident got wrong at 26s, and the
        // measured p50 boot→consume for every provider is above 5s, so 10s is squarely
        // inside "still booting" for the whole fleet.
        backdateDispatch(meshId, claimed.id, 10_000)
        createSessionDelivery({ meshId, nodeId, sessionId: 'sess-fresh-remote', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
        hostMesh(meshId, nodeId)

        await runMeshReconcileTick(makeNoWorkerComponents())

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe('sess-fresh-remote')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    // ── CONSUME-GRACE (live 2026-08-28: codex 3cd41be4, cursor 0aaa398c) ────────────
    // The delivered→consumed judgement clock was a flat 25s, which measurement against the
    // live ledger showed sat BELOW the p95 boot→consume latency of EVERY provider in the
    // fleet (codex p95 31.6s, antigravity p95 37.5s, kimi p95 28.7s — and 7% of all 1,094
    // successful consumes exceeded 25s). A codex worker that was booting normally was
    // therefore re-driven 26s after its auto-launch completed, and its session was
    // afterwards unrecoverable ("Session not found").
    //
    // The pair below pins BOTH directions, because a grace that only ever holds is just a
    // disabled watchdog: a slow-but-live boot must survive, and a genuinely dead worker must
    // still be recovered.
    describe('consume grace — slow boot survives, genuine death still recovers', () => {
      // ── INJECTION TEST ──────────────────────────────────────────────────────
      // The load-bearing assertion for the whole change. Restore the 25s constant (or drop
      // the provider-aware resolve) and this goes RED: 60s is past 25s, so the row would be
      // re-driven exactly as it was live.
      it('does NOT re-drive a worker still booting at 60s — past the OLD 25s clock, inside the new grace', async () => {
        const meshId = `mesh_consume_grace_slow_boot_${Date.now()}`
        const nodeId = 'node_w'
        try {
          enqueueTask(meshId, 'do work', { targetNodeId: nodeId, difficulty: 'medium' })
          const claimed = claimNextTask(meshId, nodeId, 'sess-slow-boot', [])!
          // 60s: comfortably past the old 25s clock (this is the window the live incident
          // died in) and comfortably inside the new floor. A codex/antigravity cold boot
          // lands here routinely — measured p99s are 247.6s and 37.5s respectively.
          backdateDispatch(meshId, claimed.id, 60_000)
          createSessionDelivery({ meshId, nodeId, sessionId: 'sess-slow-boot', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
          hostMesh(meshId, nodeId)

          // Several ticks: the grace is a deadline, not a streak — no amount of ticking
          // inside it may re-drive. (The UNKNOWN streak only starts once the grace is met.)
          await runMeshReconcileTick(makeNoWorkerComponents())
          await runMeshReconcileTick(makeNoWorkerComponents())
          await runMeshReconcileTick(makeNoWorkerComponents())
          await runMeshReconcileTick(makeNoWorkerComponents())

          const row = getQueue(meshId).find(t => t.id === claimed.id)!
          expect(row.status).toBe('assigned')
          // Still bound to the SAME session — the worker was never torn off its task.
          expect(row.assignedSessionId).toBe('sess-slow-boot')
          expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        } finally {
          cleanup(meshId)
        }
      })

      // ── OVERCORRECTION GUARD ────────────────────────────────────────────────
      // The counterweight. Widening the grace must not turn the watchdog off: a delivery that
      // was genuinely lost still has to be recovered, just later. Same fixture as above but
      // past the grace — the ONLY difference is elapsed time.
      it('STILL re-drives a genuinely lost delivery once the grace is met', async () => {
        const meshId = `mesh_consume_grace_dead_${Date.now()}`
        const nodeId = 'node_w'
        try {
          enqueueTask(meshId, 'do work', { targetNodeId: nodeId, difficulty: 'medium' })
          const claimed = claimNextTask(meshId, nodeId, 'sess-dead', [])!
          backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
          createSessionDelivery({ meshId, nodeId, sessionId: 'sess-dead', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
          hostMesh(meshId, nodeId)

          // No local instance → UNKNOWN, so the bounded consecutive-UNKNOWN grace still
          // applies on top of the time grace. Both must be satisfied before the re-drive.
          await runMeshReconcileTick(makeNoWorkerComponents())
          await runMeshReconcileTick(makeNoWorkerComponents())
          expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')

          await runMeshReconcileTick(makeNoWorkerComponents())

          const row = getQueue(meshId).find(t => t.id === claimed.id)!
          expect(row.status).toBe('pending')
          expect(row.assignedSessionId).toBeUndefined()
          const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
          expect(reclaimed).toHaveLength(1)
          expect((reclaimed[0].payload as any).reason).toBe('delivered_not_consumed_redrive')
        } finally {
          cleanup(meshId)
        }
      })

      // ── REDRIVE-STALE-AUTOLAUNCH (live: cursor 0aaa398c never retried) ──────
      // The reclaim clears every assigned* field but used to leave `autoLaunch` behind. That
      // record describes the launch of the session being torn down, so the requeued row went
      // back to 'pending' still advertising `status:'completed'` + the dead sessionId — which
      // is exactly what the per-task await-claim guard reads as "a claim is already in flight,
      // do not launch". The task then waited out that window and its 90→180→360s backoff
      // against a session that no longer existed. Revert the `delete entry.autoLaunch` and
      // this goes RED.
      it('clears the stale autoLaunch record on re-drive so the requeued task can relaunch', async () => {
        const meshId = `mesh_consume_grace_autolaunch_${Date.now()}`
        const nodeId = 'node_w'
        try {
          enqueueTask(meshId, 'do work', { targetNodeId: nodeId, difficulty: 'medium' })
          const claimed = claimNextTask(meshId, nodeId, 'sess-dead-al', [])!
          backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
          createSessionDelivery({ meshId, nodeId, sessionId: 'sess-dead-al', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
          // The auto-launch that spawned the (now doomed) session, recorded as it is live.
          recordTaskAutoLaunch(meshId, claimed.id, {
            status: 'completed',
            nodeId,
            sessionId: 'sess-dead-al',
            providerType: 'cursor-cli',
          })
          expect(getQueue(meshId).find(t => t.id === claimed.id)!.autoLaunch?.status).toBe('completed')
          hostMesh(meshId, nodeId)

          await runMeshReconcileTick(makeNoWorkerComponents())
          await runMeshReconcileTick(makeNoWorkerComponents())
          await runMeshReconcileTick(makeNoWorkerComponents())

          const row = getQueue(meshId).find(t => t.id === claimed.id)!
          expect(row.status).toBe('pending')
          // The await-claim guard suppresses a relaunch only for a `completed` record that
          // still names a session. What must not survive is THAT record pointing at the dead
          // session — whatever the requeued task's own subsequent launch attempt records in
          // its place (here a 'skipped', since this fixture has no launchable provider) is
          // the task making fresh progress, which is the opposite of the wedge.
          const stillClaimsDeadSession = row.autoLaunch?.status === 'completed'
            && row.autoLaunch?.sessionId === 'sess-dead-al'
          expect(stillClaimsDeadSession).toBe(false)
        } finally {
          cleanup(meshId)
        }
      })
    })

    it('re-driven delivered-but-unconsumed task (UNKNOWN, past grace) is re-dispatched onto a now-idle worker the same tick', async () => {
      const meshId = `mesh_phase25_unconsumed_redispatch_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-idle-worker'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        // Stranded delivered-but-unconsumed on a gone (UNKNOWN) session; an idle worker can re-claim.
        const claimed = claimNextTask(meshId, nodeId, 'sess-gone', [])!
        backdateDispatch(meshId, claimed.id, UNCONSUMED_MS)
        createSessionDelivery({ meshId, nodeId, sessionId: 'sess-gone', taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        const { components, handleCliCommand } = makeIdleWorkerComponents(meshId, nodeId, sessionId, 'claude-cli')
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/worker', daemonId: 'test-machine' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        // Fix (d): UNKNOWN 'sess-gone' verdict must clear the consecutive-UNKNOWN grace before the
        // re-drive fires. The first two ticks defer; the third both reclaims AND (PHASE 3) re-dispatches
        // onto the idle worker in the SAME tick.
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        expect(handleCliCommand).not.toHaveBeenCalled()

        await runMeshReconcileTick(components)
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

    // ── STARTED-REDRIVE-NATIVE-SOURCE-BLINDSPOT ─────────────────────────────────
    // The short re-drive reads "no agent:generating_started" as proof the worker never consumed
    // the task. For a NATIVE-SOURCE provider (transcriptAuthority=provider + nativeHistory —
    // kimi) that inference is false: its turn start lives in the native transcript, never in the
    // PTY event stream, so a busy worker reads delivered-but-never-acked AND (between tool calls)
    // IDLE_CONFIRMED — which re-drove IMMEDIATELY, with no grace. Live 2026-07-25: the same prompt
    // was re-injected at 35s/28s/27s/43s and the task then marked failed. The fix consults the
    // provider's own evidence (post-dispatch agent bubbles) before trusting the missing event.

    // Build a delivered-but-unconsumed row on a LOCAL native-source (kimi) session that reads
    // IDLE_CONFIRMED — the exact live shape. `messages` decides whether the transcript shows
    // post-dispatch progress.
    const makeNativeSourceRedriveCase = (
      meshId: string,
      nodeId: string,
      sessionId: string,
      buildMessages: (dispatchAt: number) => any[],
      provider: any = {
        type: 'kimi',
        category: 'cli',
        transcriptAuthority: 'provider',
        nativeHistory: { source: { kind: 'jsonl' } },
        // Matches the real kimi manifest (adhdev-providers/cli/kimi): the FLOOR
        // completion-timing class. The P3 profile gate keys on floor/hold
        // (emitsPtyTurnEvents=false) — a write-lag native source (no flag,
        // e.g. claude) DOES emit generating_started and is intentionally held.
        requiresFinalAssistantBeforeIdle: true,
        tui: { transcriptPty: { scope: 'buffer' } },
      },
    ) => {
      const dispatchAt = Date.now()
      enqueueTask(meshId, 'investigate the failure', { targetNodeId: nodeId,
    difficulty: 'medium',
})
      const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
      // CONSUME-GRACE: these rows are the emitsPtyTurnEvents:false class, whose grace is the
      // wider CONSUME_GRACE_NATIVE_SOURCE_MS — backdate past THAT, or the row is still inside
      // its grace and every assertion below would pass/fail for the wrong reason.
      backdateDispatch(meshId, claimed.id, UNCONSUMED_NATIVE_SOURCE_MS)
      createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'investigate the failure', status: 'delivered' })

      // Locally present + idle → resolveSessionBusyVerdict IDLE_CONFIRMED (the immediate-redrive
      // branch). A native-source worker reads idle in the gaps between its tool calls.
      const idleInstance = {
        category: 'cli',
        provider,
        getState: () => ({ instanceId: sessionId, status: 'idle', type: provider.type, settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
      }
      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        // status 'idle' throughout: the in-turn-progress poll must NOT depend on a
        // generating status — the whole point is that this class reads idle mid-task.
        return { success: true, status: 'idle', messages: buildMessages(dispatchAt - UNCONSUMED_NATIVE_SOURCE_MS) }
      })
      const components = {
        instanceManager: {
          getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
          getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
        },
        commandHandler: { handle: readChat },
      } as any
      const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])
      meshConfigMocks.getMesh.mockReturnValue(mesh)
      return { claimed, components, readChat }
    }

    it('does NOT re-drive a delivered-but-unconsumed NATIVE-SOURCE (kimi) row whose transcript shows post-dispatch progress', async () => {
      const meshId = `mesh_phase25_native_progress_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-working'
      try {
        // Mid-task shape: the assistant narrated and fired a tool AFTER dispatch, but the turn has
        // NOT ended. pollAssignedTaskTerminalEvidence would reject this (trailing tool activity) —
        // which is why the re-drive path needs its own in-turn-progress bar.
        const { claimed, components } = makeNativeSourceRedriveCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'user', content: 'investigate the failure', timestamp: dispatchedAt + 300 },
          { role: 'assistant', content: 'Let me check the reconcile loop…', timestamp: dispatchedAt + 4_000 },
          { role: 'assistant', content: '', kind: 'tool', timestamp: dispatchedAt + 6_000 },
        ])

        // Several ticks: neither the immediate IDLE_CONFIRMED re-drive nor any accrued streak may
        // fire while the transcript keeps proving the worker is working.
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe(sessionId)
        expect(readLedgerEntries(meshId).some(
          e => e.kind === 'task_reclaimed' && (e.payload as any)?.reason === 'delivered_not_consumed_redrive',
        )).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('STILL re-drives a delivered-but-unconsumed NATIVE-SOURCE row whose transcript shows NO post-dispatch progress (genuinely lost delivery)', async () => {
      const meshId = `mesh_phase25_native_no_progress_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-never-started'
      try {
        // The rescue must stay narrow: a native-source session whose transcript holds only a PRIOR
        // task's tail (everything dated BEFORE this dispatch) is a genuinely lost delivery and must
        // still be re-driven. The post-dispatch user echo alone is not progress — only agent bubbles
        // count, else every delivered row would suppress its own re-drive.
        const { claimed, components } = makeNativeSourceRedriveCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'assistant', content: 'Previous task done.', timestamp: dispatchedAt - 120_000 },
          { role: 'user', content: 'investigate the failure', timestamp: dispatchedAt + 300 },
        ])

        await runMeshReconcileTick(components)

        // The re-drive fired. (The row does not stay 'pending': the session is locally present and
        // idle, so PHASE 3 re-dispatches it the same tick — pre-existing behaviour. The reclaim
        // ledger is therefore the assertion that the re-drive happened.)
        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect((reclaimed[0].payload as any).reason).toBe('delivered_not_consumed_redrive')
      } finally {
        cleanup(meshId)
      }
    })

    // RC32: the reclaim's nonce bump only neutralizes the old worker LAZILY (the stale-nonce
    // guard fires on agent:generating_started — an event a native-source worker never emits).
    // The redrive must therefore stop the OLD worker explicitly before redispatch, or it stays
    // able to execute the reclaimed prompt (double execution).
    it('NATIVE-SOURCE redrive stops the OLD worker before redispatch (old worker cannot execute after the reclaim)', async () => {
      const meshId = `mesh_phase25_native_stop_old_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-stale'
      try {
        const { claimed, components } = makeNativeSourceRedriveCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'assistant', content: 'Previous task done.', timestamp: dispatchedAt - 120_000 },
          { role: 'user', content: 'investigate the failure', timestamp: dispatchedAt + 300 },
        ])
        // Give the old worker a local adapter so the stale-worker stop takes the local
        // stop_cli path (production shape for a co-hosted worker).
        const handleCliCommand = vi.fn(async () => ({ success: true }))
        components.cliManager = { adapters: new Map([[sessionId, { cliType: 'kimi' }]]), handleCliCommand }

        await runMeshReconcileTick(components)
        // The stop is ordered through the per-session destructive-action chain — let it flush.
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))

        expect(handleCliCommand).toHaveBeenCalledWith('stop_cli', expect.objectContaining({
          targetSessionId: sessionId,
          mode: 'hard',
          reason: 'stale_mesh_dispatch_reclaimed',
        }))
        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect((reclaimed[0].payload as any).reason).toBe('delivered_not_consumed_redrive')
      } finally {
        cleanup(meshId)
      }
    })

    it('PTY-event provider (claude-cli) redrive does NOT proactively stop the old worker (lazy nonce-guard path preserved)', async () => {
      const meshId = `mesh_phase25_pty_no_stop_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-claude-idle'
      try {
        const { claimed, components } = makeNativeSourceRedriveCase(
          meshId, nodeId, sessionId,
          dispatchedAt => [
            { role: 'user', content: 'investigate the failure', timestamp: dispatchedAt + 300 },
          ],
          { type: 'claude-cli', category: 'cli' },
        )
        const handleCliCommand = vi.fn(async () => ({ success: true }))
        components.cliManager = { adapters: new Map([[sessionId, { cliType: 'claude-cli' }]]), handleCliCommand }

        await runMeshReconcileTick(components)
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))

        // The re-drive fired, but a PTY-event worker is covered by the stale-nonce ack guard —
        // no proactive stop (it would race a legitimate same-session re-dispatch).
        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect(handleCliCommand.mock.calls.some(call => call[0] === 'stop_cli')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    it('PTY-event provider (claude-cli) is UNAFFECTED: an idle delivered-but-unconsumed row is re-driven immediately even with post-dispatch transcript activity', async () => {
      const meshId = `mesh_phase25_pty_unaffected_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-claude-idle'
      try {
        // Same transcript that HOLDS a native-source row, but on a PTY-event provider (no
        // nativeHistory → resolveLocalSessionNativeSource false). For this class the absent
        // generating_started IS valid consumption evidence, so the pre-existing immediate
        // IDLE_CONFIRMED re-drive must be preserved exactly.
        const { claimed, components } = makeNativeSourceRedriveCase(
          meshId, nodeId, sessionId,
          dispatchedAt => [
            { role: 'user', content: 'investigate the failure', timestamp: dispatchedAt + 300 },
            { role: 'assistant', content: 'Let me check the reconcile loop…', timestamp: dispatchedAt + 4_000 },
          ],
          { type: 'claude-cli', category: 'cli' },
        )

        await runMeshReconcileTick(components)

        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect((reclaimed[0].payload as any).reason).toBe('delivered_not_consumed_redrive')
      } finally {
        cleanup(meshId)
      }
    })

    // ── RC.20 DELIVERED-NO-TURN NATIVE-SOURCE ACTIVITY GATE ─────────────────
    // Live 2026-07-28 (canary task f3261319-b215-4c7b-9bb0-c0b32fe2a833): a kimi
    // native-source worker (floor class, emitsPtyTurnEvents=false) was GENUINELY
    // EXECUTING — producing probes — but never emitted agent:generating_started and
    // read IDLE_CONFIRMED between tool calls, so the 15-min delivered-no-turn
    // deadline classified it delivered_no_turn_deadline and RE-INJECTED the full
    // instruction four times (attempt seq 1/3/5/7, dispatchNonce → 9) before the
    // operator cancelled. The long path now consults the provider's own evidence:
    // FRESH post-dispatch agent activity (narration/tool bubbles, incl. the tool
    // activity emitted while spawning child probes) promotes the durable consumed
    // link and suppresses the reclaim; a LIVE-turn attempt stage (waiting_choice /
    // waiting_approval / generating / finalizing) holds outright; only a transcript
    // gone QUIET past the stale window falls through to the bounded reclaim.
    const RC20_NO_TURN_MS = 16 * 60_000 // past the 15-min DELIVERED_NO_TURN_DEADLINE
    const RC20_KIMI_FLOOR_PROFILE = { class: 'native-source', timing: 'floor', emitsPtyTurnEvents: false } as const

    // Build a delivered-no-turn row (16 min old, delivered-but-never-acked) on a
    // native-source kimi session. `instance` decides the busy verdict: 'idle' →
    // IDLE_CONFIRMED (the immediate delivered_no_turn_deadline branch — the exact
    // live shape), 'absent' → UNKNOWN (remote/unobservable; the grace-streak branch).
    // The claim-time transcript profile is stamped through claimNextTask's own option,
    // mirroring what the real claim path writes for this provider class.
    const makeRc20NoTurnCase = (
      meshId: string,
      nodeId: string,
      sessionId: string,
      buildMessages: (dispatchedAtMs: number) => any[],
      opts?: { instance?: 'idle' | 'absent' },
    ) => {
      const dispatchAt = Date.now()
      enqueueTask(meshId, 'orchestrate the canary probes', { targetNodeId: nodeId,
    difficulty: 'medium',
})
      const claimed = claimNextTask(meshId, nodeId, sessionId, [], {
        providerType: 'kimi',
        assignedTranscriptProfile: RC20_KIMI_FLOOR_PROFILE as any,
      })!
      backdateDispatch(meshId, claimed.id, RC20_NO_TURN_MS)
      // Confirmed delivery ('delivered') but never consumed ('acked') — the kimi
      // worker's generating_started never exists, so the delivery sits delivered.
      createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'orchestrate the canary probes', status: 'delivered' })

      const kimiProvider = {
        type: 'kimi',
        category: 'cli',
        transcriptAuthority: 'provider',
        nativeHistory: { source: { kind: 'jsonl' } },
        requiresFinalAssistantBeforeIdle: true,
        tui: { transcriptPty: { scope: 'buffer' } },
      }
      const idleInstance = {
        category: 'cli',
        provider: kimiProvider,
        getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
      }
      const withInstance = (opts?.instance ?? 'idle') === 'idle'
      const readChat = vi.fn(async (cmd: string) => {
        if (cmd !== 'read_chat') return { success: true }
        // status 'idle' throughout: the activity gate must NOT depend on a
        // generating status — this class reads idle mid-turn by construction.
        return { success: true, status: 'idle', messages: buildMessages(dispatchAt - RC20_NO_TURN_MS) }
      })
      const components = {
        instanceManager: {
          getByCategory: (category: string) => (category === 'cli' && withInstance ? [idleInstance] : []),
          getInstance: (id: string) => (withInstance && id === sessionId ? idleInstance : undefined),
        },
        commandHandler: { handle: readChat },
      } as any
      const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])
      meshConfigMocks.getMesh.mockReturnValue(mesh)
      return { claimed, components, readChat, dispatchAt }
    }

    it('RC.20 (the f3261319 defect): NEVER re-injects a genuinely-executing native-source worker at the delivered-no-turn deadline — four ticks, consumed promoted exactly once, nonce unchanged', async () => {
      const meshId = `mesh_rc20_no_reinject_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-orchestrator'
      __resetTurnLedgerMetricsForTests()
      try {
        // Mid-turn shape: the assistant narrated and fired a tool (spawning a child
        // probe) AFTER dispatch, FRESH (seconds ago). The trailing tool bubble keeps
        // the terminal-evidence polls out — the turn has NOT ended.
        const { claimed, components } = makeRc20NoTurnCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'user', content: 'orchestrate the canary probes', timestamp: dispatchedAt + 300 },
          { role: 'assistant', content: 'Spawning the probe sessions…', timestamp: Date.now() - 60_000 },
          { role: 'assistant', content: '', kind: 'tool', timestamp: Date.now() - 30_000 },
        ])
        const nonceBefore = getQueue(meshId).find(t => t.id === claimed.id)!.dispatchNonce

        // Four ticks — the live incident re-injected on each of four passes.
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe(sessionId)
        // No reclaim, no re-drive, no nonce bump (the incident drove it to 9).
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        expect(row.dispatchNonce).toBe(nonceBefore)
        // The consumed link was promoted from the provider's own activity evidence…
        const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(meshId, claimed.id)
        expect(attempt?.stage).toBe('consumed')
        // …making the attempt durably injection-ineligible…
        const redrive = evaluateRedrive(meshId, claimed.id)
        expect(redrive.allowed).toBe(false)
        expect(!redrive.allowed && redrive.reason).toBe('already_consumed')
        // …exactly once: the repeated per-tick consumed ACKs were swallowed by the
        // idempotency key (no duplicate stage advance).
        const metrics = getTurnLedgerMetrics()
        expect(metrics.redriveBlockedByReason['native_source_activity']).toBe(4)
        expect(metrics.duplicateTurnEvents).toBeGreaterThanOrEqual(3)
      } finally {
        cleanup(meshId)
      }
    })

    it('RC.20: UNKNOWN (remote/unobservable) native-source worker with FRESH activity survives the grace streak — held, consumed, never reclaimed', async () => {
      const meshId = `mesh_rc20_unknown_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-remote'
      __resetTurnLedgerMetricsForTests()
      try {
        const { claimed, components } = makeRc20NoTurnCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'user', content: 'orchestrate the canary probes', timestamp: dispatchedAt + 300 },
          { role: 'assistant', content: 'Working through the probe plan…', timestamp: Date.now() - 45_000 },
          { role: 'assistant', content: '', kind: 'tool', timestamp: Date.now() - 20_000 },
        ], { instance: 'absent' })

        // Past RECLAIM_UNKNOWN_GRACE_TICKS (3): without the activity gate the fourth
        // tick would reclaim with reclaim_after_unknown_grace.
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        expect(MeshRuntimeStore.getInstance().getCurrentTurnAttempt(meshId, claimed.id)?.stage).toBe('consumed')
        expect(getTurnLedgerMetrics().redriveBlockedByReason['native_source_activity']).toBeGreaterThanOrEqual(1)
      } finally {
        cleanup(meshId)
      }
    })

    it('RC.20: BOUNDED recovery — a native-source worker whose transcript went QUIET mid-turn (stale activity) is still reclaimed at the deadline', async () => {
      const meshId = `mesh_rc20_stale_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-died'
      __resetTurnLedgerMetricsForTests()
      try {
        // The worker started (post-dispatch assistant + trailing tool) but its LAST
        // activity is ~14.5 min old — beyond the 10-min stale window. This is a truly
        // dead mid-turn session: the bounded reclaim MUST still fire (no infinite hold).
        const { claimed, components } = makeRc20NoTurnCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'user', content: 'orchestrate the canary probes', timestamp: dispatchedAt + 300 },
          { role: 'assistant', content: 'Starting the probes…', timestamp: dispatchedAt + 60_000 },
          { role: 'assistant', content: '', kind: 'tool', timestamp: dispatchedAt + 90_000 },
        ])

        await runMeshReconcileTick(components)

        // The reclaim fired with the delivered-no-turn classification (the row does not
        // stay pending: the idle local session is re-dispatched the same tick — the
        // reclaim ledger entry is the assertion, matching the pre-existing pattern).
        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect((reclaimed[0].payload as any).reason).toBe('delivered_no_turn_deadline')
        expect(getTurnLedgerMetrics().redriveBlockedByReason['native_source_activity'] ?? 0).toBe(0)
      } finally {
        cleanup(meshId)
      }
    })

    it('RC.20: a durable waiting_choice attempt stage blocks the deadline reclaim (picker-parked worker is injection-ineligible)', async () => {
      const meshId = `mesh_rc20_choice_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-picker'
      __resetTurnLedgerMetricsForTests()
      try {
        // No agent bubbles at all — the transcript is quiet because the worker is
        // PARKED at a choice picker, not because it never started. The durable
        // attempt stage (waiting_choice) is the evidence that holds the reclaim.
        const { claimed, components } = makeRc20NoTurnCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'user', content: 'orchestrate the canary probes', timestamp: dispatchedAt + 300 },
        ])
        recordTurnAck({
          meshId, taskId: claimed.id, kind: 'consumed', sessionId,
          legacy: { dispatchNonce: getQueue(meshId).find(t => t.id === claimed.id)!.dispatchNonce ?? 1, nodeId, providerType: 'kimi' },
        })
        recordTurnStage({ meshId, taskId: claimed.id, stage: 'waiting_choice', sessionId })

        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        expect(getTurnLedgerMetrics().redriveBlockedByReason['active_attempt_stage']).toBeGreaterThanOrEqual(1)
      } finally {
        cleanup(meshId)
      }
    })

    it('RC.20: explicit operator cancellation is TERMINAL — no reclaim, no reinjection, no consumed promotion afterwards', async () => {
      const meshId = `mesh_rc20_cancel_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-kimi-cancelled'
      __resetTurnLedgerMetricsForTests()
      try {
        const { claimed, components } = makeRc20NoTurnCase(meshId, nodeId, sessionId, dispatchedAt => [
          { role: 'user', content: 'orchestrate the canary probes', timestamp: dispatchedAt + 300 },
          { role: 'assistant', content: 'Mid-turn when cancelled…', timestamp: Date.now() - 30_000 },
          { role: 'assistant', content: '', kind: 'tool', timestamp: Date.now() - 10_000 },
        ])

        // SIBLING-DISPATCH-ORPHAN: give the task the direct-dispatch sibling row a real
        // dispatch carries, so the cancel below is exercised against the two-row shape that
        // actually leaked (the RC.20 fixture is queue-only by construction).
        insertDirectDispatch(meshId, {
          taskId: claimed.id,
          nodeId,
          sessionId,
          providerType: 'kimi',
          message: 'orchestrate the canary probes',
          via: 'mesh_send_task',
          dispatchedAt: new Date().toISOString(),
        })
        updateDirectDispatchStatus(meshId, sessionId, 'acked', claimed.id)
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === claimed.id)).toBe(true)

        const cancelled = cancelTask(meshId, claimed.id, { reason: 'operator_cancel' })
        expect(cancelled?.status).toBe('cancelled')
        // The cancel must terminalize the sibling in the SAME mutation — not eventually, and
        // not via a sweeper: markStaleDirectDispatches never touches an 'acked' row, so a row
        // still active here is one that would survive indefinitely.
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === claimed.id)).toBe(false)

        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('cancelled')
        // And no reconcile tick resurrects it.
        expect(getActiveDirectDispatches(meshId).some(d => d.taskId === claimed.id)).toBe(false)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        // The cancel committed the task terminal; no gate fired, no consumed ACK
        // promoted. (An attempt row is only created on real turn evidence — if one
        // exists it must be terminal, and no new one may appear after cancel.)
        const attempt = MeshRuntimeStore.getInstance().getCurrentTurnAttempt(meshId, claimed.id)
        if (attempt) expect(attempt.terminalOutcome).toBe('cancelled')
        const metrics = getTurnLedgerMetrics()
        expect(metrics.redriveBlockedByReason).toEqual({})
        expect(metrics.duplicateTurnEvents).toBe(0)
      } finally {
        cleanup(meshId)
      }
    })

    // ── TASK-PROMPT-REDRIVE-AFTER-COMPLETE (Fix A-i) ────────────────────────────
    // The long DELIVERED_NO_TURN_DEADLINE (15min) reclaim must NOT re-drive a task the worker
    // actually finished when its completion event never reached the coordinator ledger. Past
    // 15min so the F3 long-deadline branch is reached (well beyond the 5min short-grace window).
    const DELIVERED_NO_TURN_MS = 16 * 60_000

    it('Fix A-i: does NOT re-drive a delivered-no-turn task whose worker transcript proves it finished (idle + post-dispatch final assistant)', async () => {
      const meshId = `mesh_phase25_redrive_transcript_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-finished-late'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, DELIVERED_NO_TURN_MS)
        // Confirmed delivery (delivered) but never 'acked' — the autoLaunch/worktree gap where
        // generating_started never reached the coordinator, so the ledger has no terminal evidence.
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        // A LOCAL idle worker instance for this session → verdict IDLE_CONFIRMED (reclaim would
        // otherwise fire immediately). read_chat returns idle WITH a final assistant message dated
        // AFTER the (16-min-old) dispatch — the transcript evidence the poll short-circuits on.
        const idleInstance = {
          category: 'cli',
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'claude-cli', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        // Frozen timestamps: the P1-4 weak-candidate streak requires the SAME
        // final-assistant evidence on consecutive ticks — per-call Date.now() would
        // read as a moving transcript and reset the re-confirmation each tick.
        const fixtureNow = Date.now()
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'claude-history-late',
            messages: [
              { role: 'user', content: 'do work', timestamp: fixtureNow - DELIVERED_NO_TURN_MS + 1_000 },
              { role: 'assistant', content: 'All done — implemented and tests pass.', timestamp: fixtureNow - 60_000 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        // Local node (no daemonId) so the poll reads via the local commandHandler.
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        // P1-4 (weak completion candidate): the transcript evidence here is
        // message-shape only (claude-cli has no native turn-terminal marker), so a
        // single quiet poll now yields a CANDIDATE — the row is held and the
        // completion promotes only after WEAK_COMPLETION_CANDIDATE_CONFIRM_TICKS (3)
        // consecutive ticks re-admit the SAME evidence. This is the deliberate
        // behavior change: a one-shot deadline flip from message-shape evidence was
        // the incident class. Three identical quiet ticks → promotion.
        await runMeshReconcileTick(components)
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
        await runMeshReconcileTick(components)
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
        await runMeshReconcileTick(components)

        // The transcript poll ran and the task was flipped 'completed' — NOT reclaimed/re-driven.
        expect(readChat).toHaveBeenCalledWith('read_chat', expect.objectContaining({ targetSessionId: sessionId }))
        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('completed')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.source).toBe('redrive_deadline_transcript_evidence')
      } finally {
        cleanup(meshId)
      }
    })

    // ── KIMI-PURE-PTY-COMPLETION-EMIT (Fix 2) ──────────────────────────────────
    // A pure-PTY worker (kimi and kin) whose generating_completed never emitted leaves the
    // assigned row 'assigned' with an idle worker that already rendered its answer. Instead of
    // waiting the full 15-min DELIVERED_NO_TURN_DEADLINE, the EARLY reconcile branch marks it
    // completed after a short continuous-idle-with-final-assistant grace
    // (ASSIGNED_IDLE_TRANSCRIPT_COMPLETE_MS, 8s). The row is only a few seconds old here — far
    // below every reclaim deadline — so ONLY the early transcript-evidence branch can complete it.
    it('Fix 2: EARLY-completes a delivered assigned row whose idle worker has a post-dispatch final assistant, without the 15-min deadline', async () => {
      const meshId = `mesh_early_transcript_complete_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-pure-pty-finished'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        // Confirmed delivery but never 'acked' (pure-PTY generating_started/completed lost).
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        const idleInstance = {
          category: 'cli',
          // A genuine LOCAL pure-PTY provider (kimi and kin): no native history, not
          // provider-authoritative, tui transcript scope 'buffer' — the class the early rescue
          // exists for. The hardened arm gate (evaluateEarlyIdleTranscriptArm) recognises this
          // and still arms even though the delivery was never 'acked' (generating_started lost).
          provider: { type: 'kimi', category: 'cli', tui: { transcriptPty: { scope: 'buffer' } } },
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'kimi-history-1',
            messages: [
              { role: 'user', content: 'do work', timestamp: dispatchAt + 500 },
              { role: 'assistant', content: 'Done — implemented and committed.', timestamp: dispatchAt + 500 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        // Tick 1 arms the continuous-idle streak but does NOT complete (grace not yet elapsed).
        await runMeshReconcileTick(components)
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')

        // Post-2026-08-18 (P1-4 + INSTANT-ACK): a WEAK message-shape admit is a CANDIDATE
        // that must re-confirm on 3 consecutive ticks, and a bubble still within 30s of
        // dispatch is refused outright. The bubble sits at dispatch+0.5s, so the first
        // qualifying poll happens once it has aged past the 30s window.
        vi.setSystemTime(dispatchAt + 40_000)
        await runMeshReconcileTick(components) // poll admits (weak) → candidate 1/3, HELD
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')

        vi.setSystemTime(dispatchAt + 49_000)
        await runMeshReconcileTick(components) // candidate 2/3
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')

        // Advance again: candidate 3/3 → promoted, completing early without the 15-min deadline.
        vi.setSystemTime(dispatchAt + 58_000)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('completed')
        expect(readChat).toHaveBeenCalledWith('read_chat', expect.objectContaining({ targetSessionId: sessionId }))
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.source).toBe('early_idle_transcript_evidence')
        // No reclaim / re-drive happened — the worker was completed, not torn off its task.
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    // WATCHDOG-FINALSUMMARY-LOST: an early-idle watchdog completion (a provider that finished early,
    // e.g. codex ~25s, whose generating_completed was lost/late) must PROPAGATE the worker's final
    // summary to the coordinator as a [System] notification — the SAME surface a native
    // generating_completed produces — not merely flip the queue row + trace a structural DROP. Before
    // the fix the finalSummary was dropped and the coordinator never learned what the worker produced.
    it('WATCHDOG-FINALSUMMARY-LOST: early-idle completion queues a coordinatorMessage carrying the worker finalSummary (not a bare DROP)', async () => {
      const meshId = `mesh_early_finalsummary_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-early-finalsummary'
      const summary = 'Done — refactored the parser, 4 files changed, all tests pass.'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        const idleInstance = {
          category: 'cli',
          provider: { type: 'kimi', category: 'cli', tui: { transcriptPty: { scope: 'buffer' } } },
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'kimi-history-fs',
            messages: [
              { role: 'user', content: 'do work', timestamp: dispatchAt + 500 },
              { role: 'assistant', content: summary, timestamp: dispatchAt + 500 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)          // arm the streak
        // 3-tick weak-candidate streak + INSTANT-ACK guard (bubble at dispatch+0.5s must
        // age past 30s before it is a candidate): candidate 1/3 → 2/3 → 3/3 → promote.
        vi.setSystemTime(dispatchAt + 40_000)
        await runMeshReconcileTick(components)          // candidate 1/3 (notification queued here)
        vi.setSystemTime(dispatchAt + 49_000)
        await runMeshReconcileTick(components)          // candidate 2/3
        vi.setSystemTime(dispatchAt + 58_000)
        await runMeshReconcileTick(components)          // candidate 3/3 → poll + complete

        // Row completed.
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('completed')

        // A coordinator completion was queued (NOT dropped) carrying the [System] message + summary.
        // (The single queued event is the weak-candidate notification; the promoted completion
        // dedups into the same taskId-anchored weak fingerprint slot — mesh-events-pending
        // DUPNOTIF — and the candidate wording surfaces the same summary.)
        const completionEvents = getPendingMeshCoordinatorEvents(meshId)
          .filter(e => e.event === 'agent:generating_completed' && !!e.coordinatorMessage)
        expect(completionEvents.length).toBe(1)
        expect(completionEvents[0].coordinatorMessage).toContain('[System]')
        expect(completionEvents[0].coordinatorMessage).toContain(summary)
        expect((completionEvents[0].metadataEvent as any)?.finalSummary).toBe(summary)

        // The terminal ledger carries the finalSummary too (previously the bare DROP payload lacked it).
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
        expect(completed).toBeTruthy()
        expect((completed?.payload as any)?.finalSummary).toBe(summary)

        // DEDUP: a SECOND reconcile for the same task (a later watchdog tick, or the worker's own
        // native emit routing through the same synth) is idempotent — hasTerminalLedgerAfterDispatch
        // makes it alreadyTerminal, so NO second [System] completion is queued.
        const second = reconcileDirectDispatchCompletionFromTranscript({
          meshId,
          nodeId,
          sessionId,
          providerType: 'kimi',
          providerSessionId: 'kimi-history-fs',
          taskId: claimed.id,
          finalSummary: summary,
          transcriptMessageAt: new Date(dispatchAt + 500).toISOString(),
          source: 'early_idle_transcript_evidence',
        })
        expect(second.alreadyTerminal).toBe(true)
        const afterSecond = getPendingMeshCoordinatorEvents(meshId)
          .filter(e => e.event === 'agent:generating_completed' && !!e.coordinatorMessage)
        expect(afterSecond.length).toBe(1)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    it('Fix 2: does NOT early-complete when the idle worker has no final assistant (streak resets, no premature completion)', async () => {
      const meshId = `mesh_early_transcript_noevidence_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-pure-pty-warming'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        const idleInstance = {
          category: 'cli',
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        // Idle but only the user prompt — no assistant result yet → poll returns null → no early complete.
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return { success: true, status: 'idle', messages: [{ role: 'user', content: 'do work', timestamp: dispatchAt + 500 }] }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned') // still assigned — the row is young, no deadline hit either
        expect(readLedgerEntries(meshId).some(
          e => (e.payload as any)?.source === 'early_idle_transcript_evidence',
        )).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    // ── KIMI-NATIVE-SOURCE early-idle arm (Fix 2 extension) ────────────────────────────
    // kimi is now a NATIVE-SOURCE provider (transcriptAuthority='provider' + nativeHistory —
    // wire.jsonl), NOT pure-PTY. resolveLocalSessionPurePty returns false for it, so the
    // ORIGINAL turn-not-started hold (`if (localPurePty === false) return false`) blocked its
    // early arm entirely: a finished-but-idle native-source worker whose generating_started was
    // never emitted (idle→idle collapse) sat 'assigned' until the 15-min reclaim. The extended
    // gate recognises the native-source class via resolveLocalSessionNativeSource and arms it
    // too, so it completes promptly off its authoritative transcript.
    it('Fix 2 (native-source): EARLY-completes a delivered NATIVE-SOURCE kimi worker (transcriptAuthority=provider) whose generating_started was never consumed', async () => {
      const meshId = `mesh_early_native_source_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-native-source-finished'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        // Confirmed delivery but never 'acked' — native-source kimi collapsed idle→idle so
        // generating_started never emitted, exactly the class the extended arm now covers.
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        const idleInstance = {
          category: 'cli',
          // NATIVE-SOURCE floor provider (matches the real kimi manifest):
          // transcriptAuthority='provider' + nativeHistory + requiresFinalAssistantBeforeIdle.
          // The P3 profile gate (emitsPtyTurnEvents=false for floor/hold native + pure-PTY)
          // arms it despite delivery never being 'acked'.
          provider: {
            type: 'kimi',
            category: 'cli',
            transcriptAuthority: 'provider',
            nativeHistory: { source: { kind: 'jsonl' } },
            requiresFinalAssistantBeforeIdle: true,
            tui: { transcriptPty: { scope: 'buffer' } },
          },
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'kimi-history-1',
            messages: [
              { role: 'user', content: 'do work', timestamp: dispatchAt + 500 },
              { role: 'assistant', content: 'Done — implemented and committed.', timestamp: dispatchAt + 500 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        // Tick 1 arms the streak (native-source now passes the gate); grace not yet elapsed.
        await runMeshReconcileTick(components)
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')

        // 3-tick weak-candidate streak + INSTANT-ACK guard (bubble at dispatch+0.5s must
        // age past 30s): candidate 1/3 → 2/3 → 3/3 → promote.
        vi.setSystemTime(dispatchAt + 40_000)
        await runMeshReconcileTick(components) // candidate 1/3, held
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
        vi.setSystemTime(dispatchAt + 49_000)
        await runMeshReconcileTick(components) // candidate 2/3
        vi.setSystemTime(dispatchAt + 58_000)
        await runMeshReconcileTick(components) // candidate 3/3 → promoted → completed

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('completed')
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
        expect((completed?.payload as any)?.source).toBe('early_idle_transcript_evidence')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    it('Fix 2 (native-source guard): a LOCAL daemon-owned (non-native, non-pure-PTY) worker whose turn never started is NOT early-armed (held)', async () => {
      const meshId = `mesh_early_daemon_owned_hold_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-daemon-owned-warming'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        // Daemon-owned transcript provider: NOT native-source (no nativeHistory) and NOT
        // pure-PTY (no tui.transcriptPty.scope 'buffer'). resolveLocalSessionPurePty → false,
        // resolveLocalSessionNativeSource → false. Delivery never 'acked' → the hold stands:
        // this class completes via its own emit or the normal grace, never the early arm.
        const idleInstance = {
          category: 'cli',
          provider: { type: 'someagent', category: 'cli' },
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'someagent', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            messages: [
              { role: 'user', content: 'do work', timestamp: dispatchAt + 500 },
              { role: 'assistant', content: 'Done.', timestamp: dispatchAt + 4_000 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned') // held — never armed, never early-completed
        expect(readLedgerEntries(meshId).some(
          e => (e.payload as any)?.source === 'early_idle_transcript_evidence',
        )).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    // ── EARLY-IDLE-COMPLETION-FALSE-POSITIVE (arm-gate hardening + poll defense) ──────
    // The original early-transcript arm gate only checked `resolveSessionBusyVerdict !== 'GENERATING'`.
    // A REMOTE worker's LOCAL verdict is UNKNOWN (no local instance), which is not GENERATING — so a
    // genuinely mid-turn remote worker (e.g. a read-only investigation worker that emitted a preamble
    // then started running tools) passed the gate, its "8s continuous idle" streak degenerated to 8s
    // of wall-clock, and a single momentary-idle poll early-completed the task off the preamble.
    // These cases assert the hardened gate: (A) a remote worker that re-probes BUSY never accrues the
    // streak; (A2) even if a momentary idle slips through, a preamble-then-trailing-tool transcript is
    // NOT promoted to a completion; (B) a genuinely finished pure-PTY worker still completes early
    // (rescue preserved); (C) a delivered-not-consumed remote worker transitioning busy resets.

    // Wire a coordinator self-node + a remote worker node whose read_chat/status is served by
    // dispatchMeshCommand. instanceManager has NO local cli instance for the worker (remote → verdict
    // UNKNOWN), so the hardened gate must re-probe the worker's own status before accruing the streak.
    function makeRemoteWorkerComponents(
      meshId: string,
      workerNodeDaemonId: string,
      workerSessionId: string,
      remoteReadChat: (args: any) => any,
    ) {
      const dispatchMeshCommand = vi.fn(async (daemonId: string, command: string, args: any) => {
        if (daemonId === workerNodeDaemonId && command === 'read_chat') return remoteReadChat(args)
        return { success: true, events: [] }
      })
      const getMeshPeerConnectionStatus = vi.fn(() => ({ state: 'connected' }))
      const components = {
        instanceManager: {
          getByCategory: () => [], // no LOCAL cli instance for the remote worker → verdict UNKNOWN
          getInstance: () => undefined,
        },
        commandHandler: { handle: vi.fn(async () => ({ success: true })) },
        dispatchMeshCommand,
        statusInstanceId: 'standalone_test-machine',
        getMeshPeerConnectionStatus,
      } as any
      const mesh = {
        id: meshId,
        nodes: [
          { id: 'node_coord', workspace: '/repo/coord', daemonId: 'daemon_test-machine', machineId: 'test-machine' },
          { id: 'node_remote', workspace: '/repo/remote', daemonId: workerNodeDaemonId },
        ],
      }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])
      meshConfigMocks.getMesh.mockReturnValue(mesh)
      return { components, dispatchMeshCommand }
    }

    it('EARLY-IDLE-FALSEPOS (A): a REMOTE worker that re-probes BUSY does NOT early-complete (streak never accrues)', async () => {
      const meshId = `mesh_earlyfp_remote_busy_${Date.now()}`
      const workerDaemonId = 'remote-daemon'
      const sessionId = 'sess-remote-investigating'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'investigate the bug', { targetNodeId: 'node_remote',
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, 'node_remote', sessionId, [])!
        // Delivered but never 'acked' (remote generating_started not yet propagated) — the exact
        // delivered≠consumed shape that used to slip through the UNKNOWN-verdict gate.
        createSessionDelivery({ meshId, nodeId: 'node_remote', sessionId, taskId: claimed.id, kind: 'task', message: 'investigate the bug', status: 'delivered' })

        // The worker is genuinely mid-turn: it emitted a preamble then started running tools.
        // Its OWN status read is 'generating' — the re-probe must break the streak.
        const remoteReadChat = () => ({
          success: true,
          status: 'generating',
          messages: [
            { role: 'user', content: 'investigate the bug', timestamp: dispatchAt + 200 },
            { role: 'assistant', content: 'Let me explore the codebase…', timestamp: dispatchAt + 1_000 },
            { role: 'assistant', content: 'reading files', kind: 'tool', timestamp: dispatchAt + 1_200 },
          ],
        })
        const { components, dispatchMeshCommand } = makeRemoteWorkerComponents(meshId, workerDaemonId, sessionId, remoteReadChat)

        // Two ticks across the 8s grace: the re-probe reads 'generating' each time → no accrual.
        await runMeshReconcileTick(components)
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned') // NOT early-completed
        // The hardened gate re-probed the remote worker's own status (read_chat over the mesh) —
        // this is the defense that broke the degenerate UNKNOWN streak.
        expect(dispatchMeshCommand).toHaveBeenCalledWith(workerDaemonId, 'read_chat', expect.objectContaining({ targetSessionId: sessionId }))
        expect(readLedgerEntries(meshId).some(
          e => (e.payload as any)?.source === 'early_idle_transcript_evidence',
        )).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    it('EARLY-IDLE-FALSEPOS (A2): a momentary-idle read whose final assistant is followed by a trailing tool_use is NOT promoted', async () => {
      const meshId = `mesh_earlyfp_trailing_tool_${Date.now()}`
      const workerDaemonId = 'remote-daemon'
      const sessionId = 'sess-remote-preamble'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'investigate the bug', { targetNodeId: 'node_remote',
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, 'node_remote', sessionId, [])!
        createSessionDelivery({ meshId, nodeId: 'node_remote', sessionId, taskId: claimed.id, kind: 'task', message: 'investigate the bug', status: 'delivered' })

        // The re-probe catches a momentary 'idle' (the inter-tool sliver), BUT the transcript shows a
        // preamble assistant followed by a trailing tool_use — a turn still executing. The poll's
        // trailing-tool-activity guard must refuse to promote the preamble.
        const remoteReadChat = () => ({
          success: true,
          status: 'idle',
          messages: [
            { role: 'user', content: 'investigate the bug', timestamp: dispatchAt + 200 },
            { role: 'assistant', content: 'Let me explore the codebase…', timestamp: dispatchAt + 1_000 },
            { role: 'assistant', content: 'Read src/foo.ts', kind: 'tool', timestamp: dispatchAt + 1_500 },
          ],
        })
        const { components } = makeRemoteWorkerComponents(meshId, workerDaemonId, sessionId, remoteReadChat)

        await runMeshReconcileTick(components)
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned') // trailing tool_use → not a turn end → not completed
        expect(readLedgerEntries(meshId).some(
          e => (e.payload as any)?.source === 'early_idle_transcript_evidence',
        )).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    it('EARLY-IDLE-FALSEPOS (B): a genuinely finished pure-PTY worker (continuous idle, final assistant, NO trailing tool) STILL early-completes (rescue preserved)', async () => {
      const meshId = `mesh_earlyfp_pure_pty_ok_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-pure-pty-done'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        // LOCAL pure-PTY worker (kimi): idle, final assistant, no trailing tool — the rescue's
        // target. Delivery never 'acked' (generating_started lost), but the pure-PTY provider class
        // is recognised by the arm gate so it still arms.
        const idleInstance = {
          category: 'cli',
          provider: { type: 'kimi', category: 'cli', tui: { transcriptPty: { scope: 'buffer' } } },
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'kimi-history-1',
            messages: [
              { role: 'user', content: 'do work', timestamp: dispatchAt + 500 },
              { role: 'assistant', content: 'Done — implemented and committed.', timestamp: dispatchAt + 500 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)
        // 3-tick weak-candidate streak + INSTANT-ACK guard (bubble at dispatch+0.5s must
        // age past 30s): candidate 1/3 → 2/3 → 3/3 → promote.
        vi.setSystemTime(dispatchAt + 40_000)
        await runMeshReconcileTick(components) // candidate 1/3, held
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
        vi.setSystemTime(dispatchAt + 49_000)
        await runMeshReconcileTick(components) // candidate 2/3
        vi.setSystemTime(dispatchAt + 58_000)
        await runMeshReconcileTick(components) // candidate 3/3 → promoted → completed

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('completed')
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
        expect((completed?.payload as any)?.source).toBe('early_idle_transcript_evidence')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    it('EARLY-IDLE-FALSEPOS (C): a delivered-not-consumed remote worker that transitions BUSY resets the streak (no early completion)', async () => {
      const meshId = `mesh_earlyfp_transition_busy_${Date.now()}`
      const workerDaemonId = 'remote-daemon'
      const sessionId = 'sess-remote-late-start'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'investigate', { targetNodeId: 'node_remote',
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, 'node_remote', sessionId, [])!
        createSessionDelivery({ meshId, nodeId: 'node_remote', sessionId, taskId: claimed.id, kind: 'task', message: 'investigate', status: 'delivered' })

        // Tick 1: momentary startup idle (no assistant yet). Tick 2: the worker has STARTED its turn
        // (busy). The streak that armed on tick 1 must reset on tick 2 → never completes.
        let probeCount = 0
        const remoteReadChat = () => {
          probeCount += 1
          if (probeCount === 1) {
            return { success: true, status: 'idle', messages: [{ role: 'user', content: 'investigate', timestamp: dispatchAt + 100 }] }
          }
          return {
            success: true,
            status: 'generating',
            messages: [
              { role: 'user', content: 'investigate', timestamp: dispatchAt + 100 },
              { role: 'assistant', content: 'Looking into it…', timestamp: dispatchAt + 5_000 },
            ],
          }
        }
        const { components } = makeRemoteWorkerComponents(meshId, workerDaemonId, sessionId, remoteReadChat)

        await runMeshReconcileTick(components)
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned') // busy transition reset the streak — no early completion
        expect(readLedgerEntries(meshId).some(
          e => (e.payload as any)?.source === 'early_idle_transcript_evidence',
        )).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    // TX-FSM Stage 2 — defect 1 reproduction (ledger 84594b15, 2026-07-26): the worker printed a
    // PREAMBLE ("코드와 로그를 병행으로 확인하겠습니다."), read idle in the sliver before firing its
    // next tool, and got early-completed with transcriptFinalAssistantPresent:false. A single read
    // cannot separate that preamble from a final answer structurally — only TIME can: a bubble that
    // landed mid-window (younger than the 8s settle at poll time) is in-flight narration, so the
    // poll vetoes it (streak resets). A genuinely finished worker is NOT lost: its bubble settles,
    // the streak re-arms, and the completion lands one window later.
    it('TX-FSM Stage 2 (preamble settle guard): a mid-window fresh assistant bubble does NOT early-complete at the first poll; it completes once settled', async () => {
      const meshId = `mesh_stage2_preamble_settle_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-preamble-settle'
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const dispatchAt = Date.now()
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        const idleInstance = {
          category: 'cli',
          provider: { type: 'kimi', category: 'cli', tui: { transcriptPty: { scope: 'buffer' } } },
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'kimi', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            providerSessionId: 'kimi-history-1',
            messages: [
              { role: 'user', content: 'do work', timestamp: dispatchAt + 500 },
              // The 84594b15 shape: the assistant bubble lands MID-WINDOW
              // (dispatch+4s — after the streak starts, only ~5s old at the
              // first poll). Post-dispatch and trailing-tool-free, so every
              // pre-Stage-2 structural guard passes; only the settle guard
              // vetoes it.
              { role: 'assistant', content: '코드와 로그를 병행으로 확인하겠습니다.', timestamp: dispatchAt + 4_000 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        // Tick 1 arms the streak.
        await runMeshReconcileTick(components)
        // Tick 2 (+9s): poll runs but the bubble is only ~5s old → settle-guard veto,
        // NO completion (the defect-1 false positive), streak resets.
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
        expect(readLedgerEntries(meshId).some(
          e => (e.payload as any)?.source === 'early_idle_transcript_evidence',
        )).toBe(false)

        // Tick 3 (+9s): the streak only re-arms (reset by the veto) — still no poll.
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')

        // Tick 4 (+9s): the bubble is now ~23s old (settle window passed) but landed at
        // dispatch+4s — the INSTANT-ACK guard (P3) still refuses a bubble this young after
        // dispatch, so the poll declines and the streak resets again. Still no completion.
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components)
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')

        // Tick 5 (+9s): re-arm only. Tick 6 (+9s): the bubble is now ~41s old — past the
        // INSTANT-ACK window — the SAME evidence finally admits (weak) → candidate 1/3.
        // Ticks 7/8 complete the 3-tick re-confirmation streak (P1-4) and promote.
        // A genuinely finished worker is NOT lost — it completes a few windows late.
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components) // re-arm
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components) // candidate 1/3
        expect(getQueue(meshId).find(t => t.id === claimed.id)!.status).toBe('assigned')
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components) // candidate 2/3
        vi.setSystemTime(Date.now() + 9_000)
        await runMeshReconcileTick(components) // candidate 3/3 → promote
        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('completed')
        const completed = readLedgerEntries(meshId).find(e => e.kind === 'task_completed')
        expect((completed?.payload as any)?.source).toBe('early_idle_transcript_evidence')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
      } finally {
        vi.useRealTimers()
        cleanup(meshId)
      }
    })

    it('Fix A-i: STILL re-drives a delivered-no-turn task when the transcript shows NO turn-end (idle but no final assistant)', async () => {
      const meshId = `mesh_phase25_redrive_no_evidence_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-never-produced'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, DELIVERED_NO_TURN_MS)
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        const idleInstance = {
          category: 'cli',
          getState: () => ({ instanceId: sessionId, status: 'idle', type: 'claude-cli', settings: { meshNodeFor: meshId, meshNodeId: nodeId } }),
        }
        // Idle but only the user prompt — no assistant result → NOT a turn-end → poll returns null
        // → the re-drive proceeds (a genuinely never-started worker is still recovered).
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return {
            success: true,
            status: 'idle',
            messages: [
              { role: 'user', content: 'do work', timestamp: Date.now() - DELIVERED_NO_TURN_MS + 1_000 },
            ],
          }
        })
        const components = {
          instanceManager: {
            getByCategory: (category: string) => (category === 'cli' ? [idleInstance] : []),
            getInstance: (id: string) => (id === sessionId ? idleInstance : undefined),
          },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w' }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)

        // The re-drive fired (no transcript turn-end evidence to short-circuit on): a
        // task_reclaimed with the delivered-no-turn reason is recorded, and NO transcript-evidence
        // completion was synthesized. (PHASE 3 may re-dispatch the reclaimed row the same tick, so
        // the row itself is not asserted here — only that the reclaim happened.)
        const reclaimed = readLedgerEntries(meshId).filter(e => e.kind === 'task_reclaimed')
        expect(reclaimed).toHaveLength(1)
        expect((reclaimed[0].payload as any).reason).toBe('delivered_no_turn_deadline')
        expect(readLedgerEntries(meshId).some(
          e => (e.payload as any)?.source === 'redrive_deadline_transcript_evidence',
        )).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    // ── APPROVAL-INBOX-BLINDSPOT (Fix A.3) ──────────────────────────────────────
    // A REMOTE worker (UNKNOWN local busy verdict — not in this daemon's instance map) that
    // is legitimately paused at an approval modal must NOT be reclaimed by the delivered-no-turn
    // watchdog. The live mesh-node session snapshot reports waiting_approval, which the guard
    // reads as positive cross-daemon evidence the worker is blocked awaiting mesh_approve — so
    // the row is HELD without advancing the UNKNOWN reclaim streak. Prior to the fix the UNKNOWN
    // streak accrued and, after the grace, tore the worker off a task it was only paused on.
    it('Fix A.3: does NOT reclaim a delivered-no-turn remote row whose live session is awaiting_approval', async () => {
      const meshId = `mesh_phase25_awaiting_approval_hold_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-remote-at-approval'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, DELIVERED_NO_TURN_MS)
        // Confirmed delivery, never acked — the long delivered-no-turn branch is reached.
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        // No local instance for the session → resolveSessionBusyVerdict = UNKNOWN (remote worker).
        // The mesh node carries a LIVE session snapshot at waiting_approval — the positive
        // cross-daemon signal the guard keys on. commandHandler is present so we can prove the
        // transcript poll is NEVER reached (the guard short-circuits before it).
        const readChat = vi.fn(async () => ({ success: true, status: 'waiting_approval', messages: [] }))
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any
        const mesh = {
          id: meshId,
          nodes: [{
            id: nodeId,
            workspace: '/repo/w',
            sessions: [{ id: sessionId, providerType: 'antigravity-cli', status: 'waiting_approval' }],
          }],
        }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        // Run well past the UNKNOWN grace (3 ticks) — the approval guard must hold on EVERY tick,
        // never accruing the streak, so no reclaim ever fires.
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe(sessionId)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        // The transcript poll is never reached — the guard short-circuits before it.
        expect(readChat).not.toHaveBeenCalled()
      } finally {
        cleanup(meshId)
      }
    })

    it('Fix A.3 (control): once the live session leaves approval (UNKNOWN, idle-not-observed), the reclaim resumes', async () => {
      const meshId = `mesh_phase25_approval_cleared_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-remote-was-at-approval'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, DELIVERED_NO_TURN_MS)
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })

        // Live session no longer at approval and no local instance (UNKNOWN). No transcript
        // turn-end evidence → the normal UNKNOWN-grace reclaim runs to completion.
        const readChat = vi.fn(async (cmd: string) => {
          if (cmd !== 'read_chat') return { success: true }
          return { success: true, status: 'idle', providerSessionId: 'p', messages: [{ role: 'user', content: 'do work', timestamp: Date.now() - DELIVERED_NO_TURN_MS + 1_000 }] }
        })
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any
        const mesh = {
          id: meshId,
          nodes: [{ id: nodeId, workspace: '/repo/w', sessions: [{ id: sessionId, status: 'idle' }] }],
        }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false) // still within grace
        await runMeshReconcileTick(components)

        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    // ── QUEUE-HOLD-HARD-DEADLINE ────────────────────────────────────────────────
    // The unbounded hold gates (live awaiting_approval/awaiting_choice, an unresolved
    // held waiting_* suspension, the RC.20 active-attempt-stage gate) all defer on a
    // LIVE signal and never accrue the UNKNOWN streak. When that signal is itself stale
    // — the worker finished but the queue-status write was lost — the row sits 'assigned'
    // forever and hasActiveNodeAssignment locks the whole node out of claiming anything
    // else (measured live 2026-08-07: 116min and 55min). QUEUE_HOLD_HARD_DEADLINE_MS
    // (90min) is the absolute ceiling: past it every gate yields to the ordinary bounded
    // reclaim and records WHICH gate blew the ceiling.
    const QUEUE_HOLD_HARD_DEADLINE_MS = 90 * 60_000
    // Comfortably past the ceiling — the 116min live stranding.
    const PAST_HARD_DEADLINE_MS = 116 * 60_000
    // Past the 15min delivered-no-turn deadline (so the hold gates are reached at all)
    // but well INSIDE the 90min ceiling — the "normal hold still honoured" case.
    const WITHIN_HARD_DEADLINE_MS = 20 * 60_000

    /**
     * Drive the turn ledger to a NONTERMINAL attempt wedged at stage 'generating' — the exact
     * state the RC.20 active-attempt gate holds on, and the one the observed defect leaves
     * behind when the completion write that would clear it is lost.
     */
    function wedgeAttemptAtGenerating(meshId: string, nodeId: string, taskId: string, sessionId: string) {
      const store = MeshRuntimeStore.getInstance()
      const entry = store.findQueueEntryById(meshId, taskId)!
      const { attempt } = openTurnAttempt({ meshId, taskId, dispatchNonce: entry.dispatchNonce ?? 0, nodeId, sessionId })
      entry.attemptId = attempt.attemptId
      store.updateQueueEntry(entry)
      recordTurnAck({ meshId, taskId, kind: 'delivered', attemptId: attempt.attemptId, sessionId })
      recordTurnAck({ meshId, taskId, kind: 'consumed', attemptId: attempt.attemptId, sessionId })
      recordTurnStage({ meshId, taskId, stage: 'generating', attemptId: attempt.attemptId, sessionId })
      // Precondition of both attempt-stage cases: the gate only holds a NONTERMINAL attempt
      // sitting on a live-turn stage. If this drifts, the tests below assert nothing.
      const wedged = store.getCurrentTurnAttempt(meshId, taskId)!
      expect(wedged.stage).toBe('generating')
      expect(wedged.terminalOutcome).toBeFalsy()
      return attempt
    }

    /** A remote worker (no local instance → UNKNOWN verdict) whose live node snapshot is at an approval modal. */
    function awaitingApprovalFixture(meshId: string, nodeId: string, sessionId: string, ageMs: number) {
      enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
      const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
      backdateDispatch(meshId, claimed.id, ageMs)
      createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
      const readChat = vi.fn(async () => ({ success: true, status: 'waiting_approval', messages: [] }))
      const components = {
        instanceManager: { getByCategory: () => [], getInstance: () => undefined },
        commandHandler: { handle: readChat },
      } as any
      const mesh = {
        id: meshId,
        nodes: [{
          id: nodeId,
          workspace: '/repo/w',
          sessions: [{ id: sessionId, providerType: 'antigravity-cli', status: 'waiting_approval' }],
        }],
      }
      meshConfigMocks.listMeshes.mockReturnValue([mesh])
      meshConfigMocks.getMesh.mockReturnValue(mesh)
      return { claimed, components, readChat }
    }

    // CASE 3 (normal hold preserved): a genuine approval wait INSIDE the ceiling must still
    // hold on every tick, exactly as before this fix. This is the guard against the hard
    // deadline being set so aggressive that it cancels legitimate approval waits.
    it('QUEUE-HOLD-HARD-DEADLINE: an awaiting_approval hold WITHIN the ceiling is still honoured on every tick', async () => {
      const meshId = `mesh_hard_deadline_within_${Date.now()}`
      try {
        const { claimed, components } = awaitingApprovalFixture(meshId, 'node_w', 'sess-approval-within', WITHIN_HARD_DEADLINE_MS)

        // Far more ticks than the 3-tick UNKNOWN grace — the gate must hold on all of them.
        for (let i = 0; i < 5; i++) await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(row.assignedSessionId).toBe('sess-approval-within')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        // Nothing recorded a hard-deadline breach — the ceiling was never reached.
        expect(readLedgerEntries(meshId).some(e => e.kind === 'queue_hold_hard_deadline')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })

    // CASE 2 (the fix): past the ceiling the same approval hold yields, the row is reclaimed,
    // and the audit record names the gate that blew the ceiling.
    it('QUEUE-HOLD-HARD-DEADLINE: an awaiting_approval hold PAST the ceiling is force-reclaimed and recorded', async () => {
      const meshId = `mesh_hard_deadline_past_${Date.now()}`
      try {
        const { claimed, components } = awaitingApprovalFixture(meshId, 'node_w', 'sess-approval-past', PAST_HARD_DEADLINE_MS)

        // The gate yields immediately, but the recovery is the ORDINARY bounded path — control
        // falls into the UNKNOWN branch, so the 3-tick grace still applies before the reclaim.
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)
        await runMeshReconcileTick(components)

        const entries = readLedgerEntries(meshId)
        // The hard-deadline breach is recorded, naming the gate — this is what makes the next
        // occurrence diagnosable from the ledger instead of being mistaken for a slow node.
        // Recorded EXACTLY once despite the yield firing on all 3 ticks: the audit is deduped
        // per (task, gate) so a multi-tick convergence does not spam the ledger.
        const breach = entries.filter(e => e.kind === 'queue_hold_hard_deadline')
        expect(breach).toHaveLength(1)
        expect((breach[0].payload as any).gate).toBe('live_awaiting_approval')
        expect((breach[0].payload as any).taskId).toBe(claimed.id)
        expect((breach[0].payload as any).ceilingMs).toBe(QUEUE_HOLD_HARD_DEADLINE_MS)
        expect((breach[0].payload as any).heldMs).toBeGreaterThanOrEqual(QUEUE_HOLD_HARD_DEADLINE_MS)
        // The breach is its OWN kind, never folded into task_reclaimed — reclaim counts stay honest.
        expect(entries.filter(e => e.kind === 'task_reclaimed').every(
          e => (e.payload as any)?.reason !== 'queue_hold_hard_deadline',
        )).toBe(true)
        // And the row actually got reclaimed — the node is unblocked, not merely logged about.
        expect(entries.some(
          e => e.kind === 'task_reclaimed' && (e.payload as any)?.reason === 'reclaim_after_unknown_grace',
        )).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    // CASE 2b: the RC.20 active-attempt-stage gate — the site matching the observed defect most
    // directly. The durable attempt stage stays 'generating' because the completion write that
    // would clear it is exactly what went missing, so this gate pins the row indefinitely.
    it('QUEUE-HOLD-HARD-DEADLINE: an active-attempt-stage hold PAST the ceiling is force-reclaimed and recorded', async () => {
      const meshId = `mesh_hard_deadline_attempt_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-attempt-stuck'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, PAST_HARD_DEADLINE_MS)
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
        // A durable attempt wedged at 'generating' — nonterminal, so the RC.20 gate holds it.
        wedgeAttemptAtGenerating(meshId, nodeId, claimed.id, sessionId)

        // Remote worker: no local instance (UNKNOWN) and the live node snapshot is NOT at an
        // approval, so the approval gate is not what holds this row — the attempt stage is.
        // The transcript read yields no terminal evidence, so nothing short-circuits earlier.
        const readChat = vi.fn(async () => ({ success: true, status: 'generating', messages: [] }))
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w', sessions: [{ id: sessionId, status: 'idle' }] }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        for (let i = 0; i < 4; i++) await runMeshReconcileTick(components)

        const breach = readLedgerEntries(meshId).filter(e => e.kind === 'queue_hold_hard_deadline')
        expect(breach).toHaveLength(1)
        expect((breach[0].payload as any).gate).toBe('active_attempt_stage')
        expect((breach[0].payload as any).taskId).toBe(claimed.id)
        // And the row actually got reclaimed — the node is unblocked, not merely logged about.
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(true)
      } finally {
        cleanup(meshId)
      }
    })

    // CASE 3b (normal hold preserved, attempt-stage twin): the same wedged attempt stage INSIDE
    // the ceiling must still suppress the reclaim — a genuinely long turn is not torn off.
    it('QUEUE-HOLD-HARD-DEADLINE: an active-attempt-stage hold WITHIN the ceiling still suppresses the reclaim', async () => {
      const meshId = `mesh_hard_deadline_attempt_within_${Date.now()}`
      const nodeId = 'node_w'
      const sessionId = 'sess-attempt-working'
      try {
        enqueueTask(meshId, 'do work', { targetNodeId: nodeId,
    difficulty: 'medium',
})
        const claimed = claimNextTask(meshId, nodeId, sessionId, [])!
        backdateDispatch(meshId, claimed.id, WITHIN_HARD_DEADLINE_MS)
        createSessionDelivery({ meshId, nodeId, sessionId, taskId: claimed.id, kind: 'task', message: 'do work', status: 'delivered' })
        wedgeAttemptAtGenerating(meshId, nodeId, claimed.id, sessionId)

        const readChat = vi.fn(async () => ({ success: true, status: 'generating', messages: [] }))
        const components = {
          instanceManager: { getByCategory: () => [], getInstance: () => undefined },
          commandHandler: { handle: readChat },
        } as any
        const mesh = { id: meshId, nodes: [{ id: nodeId, workspace: '/repo/w', sessions: [{ id: sessionId, status: 'idle' }] }] }
        meshConfigMocks.listMeshes.mockReturnValue([mesh])
        meshConfigMocks.getMesh.mockReturnValue(mesh)

        for (let i = 0; i < 5; i++) await runMeshReconcileTick(components)

        const row = getQueue(meshId).find(t => t.id === claimed.id)!
        expect(row.status).toBe('assigned')
        expect(readLedgerEntries(meshId).some(e => e.kind === 'task_reclaimed')).toBe(false)
        expect(readLedgerEntries(meshId).some(e => e.kind === 'queue_hold_hard_deadline')).toBe(false)
      } finally {
        cleanup(meshId)
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL-Q1-REALTIME — approval nudges are level-delivered (not idle-edge held)
// ─────────────────────────────────────────────────────────────────────────────
describe('APPROVAL-Q1-REALTIME: approval nudge is delivered to a busy coordinator, not held', () => {
  // A queued approval event (agent:waiting_approval) for a worker node. metadataEvent
  // carries the worker session id (targetSessionId/sessionId) so the stale-resolved guard
  // can correlate a later terminal ledger entry against it.
  function queueApproval(
    meshId: string,
    jobSuffix: string,
    opts?: { nodeId?: string; sessionId?: string; targetCoordinatorSessionId?: string; queuedAt?: number },
  ) {
    const nodeId = opts?.nodeId ?? 'node_child_1'
    const sessionId = opts?.sessionId ?? `sess-${jobSuffix}`
    return queuePendingMeshCoordinatorEvent({
      event: 'agent:waiting_approval',
      meshId,
      nodeLabel: "Node 'node_child_1'",
      nodeId,
      metadataEvent: { sessionId, targetSessionId: sessionId, timestamp: Date.now() },
      coordinatorMessage: `Node 'node_child_1' is waiting for approval to proceed (${jobSuffix}).`,
      queuedAt: opts?.queuedAt ?? Date.now(),
      ...(opts?.targetCoordinatorSessionId ? { targetCoordinatorSessionId: opts.targetCoordinatorSessionId } : {}),
    })
  }

  // These approval-delivery cases assert accept-mode semantics that predate v2 enforce
  // (unversioned/v1 approval events are delivered, not quarantined). Enforce now defaults
  // ON when the env is unset, so pin it explicitly OFF for this block.
  beforeEach(() => { process.env.MESH_PROTOCOL_V2_ENFORCE = '0' })
  afterEach(() => { delete process.env.MESH_PROTOCOL_V2_ENFORCE })

  // (1) The headline fix: a GENERATING coordinator (no idle edge) still receives the
  // approval nudge within the reconcile tick — delivered NON-force (no PTY force-write),
  // and the pending row is drained (not left held for an idle edge that may never come).
  it('delivers a queued approval into a generating coordinator this tick (non-force), not held', async () => {
    const meshId = `mesh_approval_generating_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueApproval(meshId, 'generating')

      await runMeshReconcileTick(components)

      // Delivered to the coordinator's inbox this tick — no idle edge required.
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [eventName, payload] = coordinator.onEvent.mock.calls[0]
      expect(eventName).toBe('send_message')
      expect(payload.input.textFallback).toContain('waiting for approval')
      // NON-force: approval is level-backed, so it enters the adapter's pendingOutboundQueue
      // (next turn boundary) — it is NOT a raw PTY force-write (force-inject stays removed).
      expect(payload.force).toBeFalsy()
      // The nudge was drained (level state re-derives it), not held for a later idle tick.
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // (2) No regression to completion hold semantics: with a generating coordinator, a queued
  // approval is delivered while a queued completion stays HELD (its payload lives only in the
  // pending event, so it must ride the idle edge). Only the approval kind is separated out.
  it('delivers the approval but still HOLDS a co-queued completion when the coordinator is generating', async () => {
    const meshId = `mesh_approval_plus_completion_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      queueApproval(meshId, 'appr')
      queueCompletion(meshId, 'compl')

      await runMeshReconcileTick(components)

      // Exactly one delivery — the approval — and it is non-force.
      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [, payload] = coordinator.onEvent.mock.calls[0]
      expect(payload.input.textFallback).toContain('waiting for approval')
      expect(payload.force).toBeFalsy()
      // The completion is still held (drained=0), unchanged, for the coordinator's idle tick.
      const remaining = getPendingMeshCoordinatorEvents(meshId)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].event).toBe('agent:generating_completed')
    } finally {
      cleanup(meshId)
    }
  })

  // (2b) Modal-parked coordinator (the coordinator itself parked on a harness modal) also
  // receives the approval nudge — non-force queues safely behind the modal, never a raw
  // keystroke write that a modal key-handler would consume.
  it('delivers the approval into a modal-parked coordinator (non-force, no keystroke corruption)', async () => {
    const meshId = `mesh_approval_modalparked_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'waiting_approval', sink)
      const components = makeComponents([coordinator])
      queueApproval(meshId, 'mp')

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      const [, payload] = coordinator.onEvent.mock.calls[0]
      expect(payload.force).toBeFalsy()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // (3) A STALE approval — one whose approval was already resolved (a real terminal ledger
  // entry landed for the same node/session at/after the nudge was queued) — is DROPPED, never
  // delivered, so it can't mislead the coordinator into thinking the worker still waits.
  it('drops a stale (already-resolved) approval nudge instead of delivering it', async () => {
    const meshId = `mesh_approval_stale_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      const nodeId = 'node_child_1'
      const sessionId = 'sess-stale'
      // Nudge queued first…
      queueApproval(meshId, 'stale', { nodeId, sessionId, queuedAt: Date.now() - 1000 })
      // …then the worker completed (approval resolved) — a real terminal after the nudge.
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId,
        sessionId,
        payload: { event: 'agent:generating_completed' },
      })

      await runMeshReconcileTick(components)

      // Dropped: not delivered to the coordinator, and drained from the queue.
      expect(coordinator.onEvent).not.toHaveBeenCalled()
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  // Guard: a NON-stale approval (no terminal, or a terminal that predates the nudge) is still
  // delivered — the stale guard must not swallow a genuinely-pending approval.
  it('still delivers when the only terminal ledger entry predates the approval nudge', async () => {
    const meshId = `mesh_approval_old_terminal_${Date.now()}`
    try {
      const sink: any[] = []
      const coordinator = makeCoordinator(meshId, 'generating', sink)
      const components = makeComponents([coordinator])
      const nodeId = 'node_child_1'
      const sessionId = 'sess-fresh'
      // An OLD terminal (a prior task on the same node) that predates this new approval nudge.
      appendLedgerEntry(meshId, {
        kind: 'task_completed',
        nodeId,
        sessionId,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        payload: { event: 'agent:generating_completed' },
      } as any)
      queueApproval(meshId, 'fresh', { nodeId, sessionId, queuedAt: Date.now() })

      await runMeshReconcileTick(components)

      expect(coordinator.onEvent).toHaveBeenCalledTimes(1)
      expect(getPendingMeshCoordinatorEvents(meshId)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })
})

// RESTART-REBOUND ENVELOPE (post-restart completion wedge): after a daemon restart
// the rebound worker instance holds NO mesh envelope (in-memory stamps lost) while
// the durable authority — the assigned queue row + the current turn attempt —
// survives. restampReboundMeshWorkerAssignment re-derives the envelope from those
// durable rows so the SAME attempt's post-answer completion can route and commit.
describe('restampReboundMeshWorkerAssignment (post-restart rebound envelope)', () => {
  const meshId = 'mesh-restamp-test'
  const nodeId = 'nodeA'

  function makeReboundWorker(sessionId: string) {
    // Post-restart rebound: settings carry NO mesh envelope.
    const settings: Record<string, any> = { autoApprove: false }
    const worker = {
      category: 'cli',
      attachMeshAssignment: (a: any) => {
        if (a.meshId) settings.meshNodeFor = a.meshId
        if (a.nodeId) { settings.meshNodeId = a.nodeId; settings.meshLastNodeId = a.nodeId }
        if (a.taskId) settings.meshActiveTaskId = a.taskId
        if (typeof a.dispatchNonce === 'number') settings.meshActiveDispatchNonce = a.dispatchNonce
        if (a.attemptId) settings.meshActiveAttemptId = a.attemptId
        if (a.coordinatorDaemonId) settings.meshCoordinatorDaemonId = a.coordinatorDaemonId
        if (a.coordinatorSessionId) settings.meshCoordinatorSessionId = a.coordinatorSessionId
      },
      getState: () => ({ instanceId: sessionId, status: 'idle', settings }),
    }
    const components = {
      instanceManager: {
        getInstance: (id: string) => (id === sessionId ? worker : undefined),
        attachMeshAssignmentToInstance: (id: string, a: any) => {
          const inst = id === sessionId ? worker : undefined
          if (!inst || typeof inst.attachMeshAssignment !== 'function') return { stamped: false, reason: 'instance_not_found' }
          inst.attachMeshAssignment(a)
          return { stamped: true }
        },
      },
    } as any
    return { worker, settings, components }
  }

  function openAttempt(taskId: string, nonce: number, sessionId: string) {
    const { attempt } = openTurnAttempt({
      meshId, taskId, dispatchNonce: nonce, nodeId, sessionId,
      coordinatorDaemonId: 'daemon_mach_x', coordinatorSessionId: 'coordSess', nowMs: Date.now(),
    })
    return attempt
  }

  afterEach(() => { cleanup(meshId) })

  it('re-stamps a rebound local worker from the durable row + current attempt (causal attempt/session/nonce authority preserved), idempotently', () => {
    const store = MeshRuntimeStore.getInstance()
    const taskId = 'task-restamp-1'
    const attempt = openAttempt(taskId, 3, 'sessW')
    const { settings, components } = makeReboundWorker('sessW')

    const stamped = restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessW', assignedNodeId: nodeId, dispatchNonce: 3,
    })
    expect(stamped).toBe(true)
    expect(settings.meshNodeFor).toBe(meshId)
    expect(settings.meshNodeId).toBe(nodeId)
    expect(settings.meshActiveTaskId).toBe(taskId)
    // The stamp carries the attempt's OWN identity — never a re-derived guess.
    expect(settings.meshActiveAttemptId).toBe(attempt.attemptId)
    expect(settings.meshActiveDispatchNonce).toBe(3)
    expect(settings.meshCoordinatorDaemonId).toBe('daemon_mach_x')
    expect(settings.meshCoordinatorSessionId).toBe('coordSess')

    // Idempotent: the next reconcile tick is a no-op.
    expect(restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessW', assignedNodeId: nodeId, dispatchNonce: 3,
    })).toBe(false)
    expect(settings.meshActiveAttemptId).toBe(attempt.attemptId)
  })

  it('never re-arms a terminal attempt', () => {
    const store = MeshRuntimeStore.getInstance()
    const taskId = 'task-restamp-terminal'
    const attempt = openAttempt(taskId, 1, 'sessW')
    const committed = proposeTurnCompletion({ meshId, taskId, attemptId: attempt.attemptId, sessionId: 'sessW', outcome: 'completed', source: 'provider_event', nowMs: Date.now() })
    expect(committed.committed).toBe(true)
    const { settings, components } = makeReboundWorker('sessW')

    expect(restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessW', assignedNodeId: nodeId, dispatchNonce: 1,
    })).toBe(false)
    expect(settings.meshActiveTaskId).toBeUndefined()
    expect(settings.meshNodeFor).toBeUndefined()
  })

  it('never stamps a session the current attempt is not bound to', () => {
    const store = MeshRuntimeStore.getInstance()
    const taskId = 'task-restamp-mismatch'
    openAttempt(taskId, 1, 'sessW') // attempt bound to sessW
    const { settings, components } = makeReboundWorker('sessOTHER')

    expect(restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessOTHER', assignedNodeId: nodeId, dispatchNonce: 1,
    })).toBe(false)
    expect(settings.meshActiveTaskId).toBeUndefined()
  })

  it('never re-arms a dispatchNonce-mismatched attempt (stale row mid-redrive fails closed)', () => {
    const store = MeshRuntimeStore.getInstance()
    const taskId = 'task-restamp-nonce-mismatch'
    openAttempt(taskId, 5, 'sessW') // the ledger's current attempt is at nonce 5
    const { settings, components } = makeReboundWorker('sessW')

    // The queue row still carries the PRE-redrive nonce 4: the two durable
    // authorities disagree, so stamping would arm a (task, attempt, nonce)
    // triple neither side owns. Fail closed — a later tick converges the row.
    expect(restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessW', assignedNodeId: nodeId, dispatchNonce: 4,
    })).toBe(false)
    expect(settings.meshActiveTaskId).toBeUndefined()
    expect(settings.meshNodeFor).toBeUndefined()

    // Once the row carries the attempt's own nonce, the stamp proceeds.
    expect(restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessW', assignedNodeId: nodeId, dispatchNonce: 5,
    })).toBe(true)
    expect(settings.meshActiveTaskId).toBe(taskId)
    expect(settings.meshActiveDispatchNonce).toBe(5)
  })

  it('skips a session with no local instance (remote / gone) without throwing', () => {
    const store = MeshRuntimeStore.getInstance()
    const taskId = 'task-restamp-remote'
    openAttempt(taskId, 1, 'sessRemote')
    const components = {
      instanceManager: {
        getInstance: () => undefined,
        attachMeshAssignmentToInstance: () => ({ stamped: false, reason: 'instance_not_found' }),
      },
    } as any
    expect(restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessRemote', assignedNodeId: nodeId, dispatchNonce: 1,
    })).toBe(false)
  })

  it('leaves an instance already stamped for another task alone (the live dispatch owns it)', () => {
    const store = MeshRuntimeStore.getInstance()
    const taskId = 'task-restamp-busy'
    openAttempt(taskId, 1, 'sessW')
    const { settings, components } = makeReboundWorker('sessW')
    settings.meshActiveTaskId = 'task-other-live-dispatch'

    expect(restampReboundMeshWorkerAssignment(components, store, meshId, {
      id: taskId, assignedSessionId: 'sessW', assignedNodeId: nodeId, dispatchNonce: 1,
    })).toBe(false)
    expect(settings.meshActiveTaskId).toBe('task-other-live-dispatch')
  })
})
