import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (MeshRuntimeStore SQLite, ledger JSONL) to a per-run temp dir.
const testTmpDir = path.join(tmpdir(), `adhdev-unresolved-fwd-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-worker-machine' }),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(() => undefined),
  getMeshByRepo: vi.fn(() => undefined),
  listMeshes: vi.fn(() => [] as any[]),
}))

vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: vi.fn() }))
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({ fastForwardMeshNode: vi.fn() }))

import { runMeshReconcileTick, setupMeshEventForwarding } from '../../src/mesh/mesh-events.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import {
  peekUnresolvedDelegateForwards,
  enqueueUnresolvedDelegateForward,
  registerUnresolvedForwardRetryNudge,
  __clearUnresolvedDelegateForwardOutboxForTests,
} from '../../src/mesh/mesh-unresolved-forward-outbox.js'
import { __resetMeshWorkspaceCacheForTests } from '../../src/mesh/mesh-events.js'
import { __resetUnresolvedForwardRejectionCountsForTests, setupMeshReconcileLoop } from '../../src/mesh/mesh-reconcile-loop.js'
import { listMeshes } from '../../src/config/mesh-config.js'

// A worker that is NOT a member of the coordinator's mesh: meshNodeFor absent, no
// workspace→mesh resolution, but it carries the coordinator daemon anchor. Its
// completion routes through forwardUnresolvedDelegateEvent → durable outbox.
function createUnresolvedWorker(coordinatorDaemonId = 'daemon_remote_coordinator') {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: 'worker-session-1',
    workspace: '/repo/worktree-worker',
    settings: {
      meshCoordinatorDaemonId: coordinatorDaemonId,
      meshNodeId: 'node_worker',
      launchedByCoordinator: true,
    },
  }
  const source = { category: 'cli', getState: vi.fn(() => sourceState) }
  const instanceManager = {
    onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
    getInstance: vi.fn((id: string) => (id === 'worker-session-1' ? source : undefined)),
    getByCategory: vi.fn((category: string) => (category === 'cli' ? [source] : [])),
  }
  return {
    components: { instanceManager } as any,
    emit: (event: any) => {
      if (!listener) throw new Error('listener not registered')
      listener(event)
    },
  }
}

const COMPLETION = {
  event: 'agent:generating_completed',
  instanceId: 'worker-session-1',
  targetSessionId: 'worker-session-1',
  providerType: 'claude-cli',
  providerSessionId: 'claude-history-1',
  finalSummary: 'remote task done',
  timestamp: 4242,
}

beforeEach(() => {
  __resetMeshRuntimeStoreForTests()
  __resetMeshWorkspaceCacheForTests()
  __clearUnresolvedDelegateForwardOutboxForTests()
  __resetUnresolvedForwardRejectionCountsForTests()
  registerUnresolvedForwardRetryNudge(undefined)
  vi.mocked(listMeshes).mockReturnValue([])
})

// Polling single-model (docs/refactoring/2026-06-16-mesh-completion-polling-single-model.md
// §2.1): the spontaneous best-effort immediate push was removed. An unresolved-delegate
// event is ONLY persisted to the durable outbox at emit time; delivery happens solely on
// the reconcile loop's PHASE 0 retry (acked), with a data-free nudge for early scheduling.
describe('unresolved-delegate durable forward (queue-only, PHASE 0 delivery)', () => {
  it('(a) emit persists to the outbox and NEVER pushes inline; the reconcile tick delivers with ack', async () => {
    const { components, emit } = createUnresolvedWorker()
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)
    await Promise.resolve()

    // No spontaneous push at emit time — the queue is the only thing written.
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    const queued = peekUnresolvedDelegateForwards()
    expect(queued).toHaveLength(1)
    expect(queued[0].coordinatorDaemonId).toBe('daemon_remote_coordinator')
    expect(queued[0].payload.event).toBe('agent:generating_completed')

    // The reconcile tick (PHASE 0) delivers the queued entry and acks it.
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    const [target, command, payload] = dispatchMeshCommand.mock.calls[0]
    expect(target).toBe('daemon_remote_coordinator')
    expect(command).toBe('mesh_forward_event')
    expect(payload.event).toBe('agent:generating_completed')
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)

    // Delivered → nothing left for a later tick.
    dispatchMeshCommand.mockClear()
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
  })

  it('(b) keeps the event queued when the PHASE 0 push fails, and retries on the next tick', async () => {
    const { components, emit } = createUnresolvedWorker()
    const dispatchMeshCommand = vi.fn(async () => { throw new Error('p2p unreachable') })
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)

    // First tick: push fails (transport threw) → entry stays queued (not acked).
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    expect(peekUnresolvedDelegateForwards()).toHaveLength(1)

    // Next tick: coordinator reachable again → delivered and acked.
    dispatchMeshCommand.mockReset()
    dispatchMeshCommand.mockImplementation(async () => ({ success: true }))
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)
  })

  it('(c) enqueue is idempotent on the event fingerprint (a re-fired completion queues once)', async () => {
    const { components, emit } = createUnresolvedWorker()
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)
    await Promise.resolve()
    emit(COMPLETION) // identical completion fires again
    await Promise.resolve()

    // Idempotent: the unique (mesh_id, fingerprint) index collapses both to one row,
    // and neither emit pushed anything inline.
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    expect(peekUnresolvedDelegateForwards()).toHaveLength(1)
  })

  it('leaves the entry queued when the coordinator rejects the push (success:false)', async () => {
    const { components, emit } = createUnresolvedWorker()
    const dispatchMeshCommand = vi.fn(async () => ({ success: false, error: 'mesh not found yet' }))
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)
    await runMeshReconcileTick(components)

    // A rejected push must NOT ack — the completion stays durable for the next tick.
    expect(peekUnresolvedDelegateForwards()).toHaveLength(1)
  })

  it('(d) emit fires the registered reconcile nudge (data-free, coalesced at the receiver)', async () => {
    const { components, emit } = createUnresolvedWorker()
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    components.dispatchMeshCommand = dispatchMeshCommand
    const nudge = vi.fn()
    registerUnresolvedForwardRetryNudge(nudge)

    setupMeshEventForwarding(components)
    emit(COMPLETION)

    // The nudge fired, but no data was pushed — delivery stays on PHASE 0.
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    expect(peekUnresolvedDelegateForwards()).toHaveLength(1)
  })

  it('(e) the reconcile loop nudge schedules an early PHASE 0 retry (sub-interval delivery)', async () => {
    vi.useFakeTimers()
    try {
      const { components, emit } = createUnresolvedWorker()
      const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
      components.dispatchMeshCommand = dispatchMeshCommand

      // setupMeshReconcileLoop registers the real nudge handler (interval 4s default).
      const loop = setupMeshReconcileLoop(components)
      try {
        setupMeshEventForwarding(components)
        emit(COMPLETION)
        expect(dispatchMeshCommand).not.toHaveBeenCalled() // nothing inline
        expect(peekUnresolvedDelegateForwards()).toHaveLength(1)

        // Advance well past the nudge delay but well short of the 4s tick: the nudged
        // early PHASE 0 pass delivers and acks without waiting for the interval.
        await vi.advanceTimersByTimeAsync(500)
        expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
        expect(dispatchMeshCommand.mock.calls[0][1]).toBe('mesh_forward_event')
        expect(peekUnresolvedDelegateForwards()).toHaveLength(0)
      } finally {
        loop.stop()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

// Regression: the self-forward infinite-retry loop. When the resolved coordinator IS
// this daemon (a self-coordinating / single-node mesh, or a delegate whose coordinator
// anchor resolved to our own id — `daemon_<self machineId>`), a cross-daemon
// mesh_forward_event to our own id is REFUSED by the dispatch self-dial guard
// ("Refusing to send ... to this daemon's own id; route via the local router instead").
// Before the fix the entry was persisted/re-pushed forever (log spam every tick, outbox
// row never drained). It must instead be routed through the local receiver and drained.
// The mocked loadConfig().machineId is 'test-worker-machine', so 'daemon_test-worker-machine'
// is this daemon's OWN id in config form.
describe('unresolved-delegate self-forward loop', () => {
  const SELF_COORDINATOR_ID = 'daemon_test-worker-machine'

  it('routes a self-addressed completion via the local router and never enters the outbox', async () => {
    const { components, emit } = createUnresolvedWorker(SELF_COORDINATOR_ID)
    // If a cross-daemon push were attempted to our own id it would hit the self-dial
    // guard; assert it is never called for this self-addressed event.
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)
    await Promise.resolve()
    await Promise.resolve()

    // No cross-daemon push (would be refused by the self-dial guard); routed locally.
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    // Nothing persisted → no permanently-undrained outbox row, no retry loop.
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)

    // A reconcile tick has nothing to retry and never cross-dials.
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
  })

  it('drains a pre-existing self-addressed outbox entry locally instead of looping on the guard', async () => {
    const { components } = createUnresolvedWorker(SELF_COORDINATOR_ID)
    // The pre-fix daemon left self-addressed rows in the durable outbox; every retry
    // dispatch throws the self-dial guard. Reproduce that here.
    const dispatchMeshCommand = vi.fn(async () => {
      throw new Error("Refusing to send mesh command 'mesh_forward_event' to this daemon's own id; route via the local router instead.")
    })
    components.dispatchMeshCommand = dispatchMeshCommand

    enqueueUnresolvedDelegateForward(SELF_COORDINATOR_ID, 'agent:generating_completed', {
      event: 'agent:generating_completed',
      nodeId: 'node_worker',
      workspace: '/repo/worktree-worker',
      targetSessionId: 'worker-session-1',
    })
    expect(peekUnresolvedDelegateForwards()).toHaveLength(1)

    await runMeshReconcileTick(components)

    // The self-addressed entry must NOT be cross-dialled (that hits the guard forever) …
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    // … and it is drained (routed via the local router), so the retry loop terminates.
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)

    // Subsequent ticks have nothing left to retry — the loop is truly gone.
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)
  })
})

// RECONCILE-MESHID-DROP: the worker forwarded a completion with NO meshId (it "couldn't
// resolve" one locally), and the coordinator's own workspace/nodeId recovery missed — so the
// retry was rejected "meshId required" every tick forever. The worker can usually resolve the
// meshId now (its hosted-node membership / the live session's meshNodeFor), so the retry
// stamps it on; and a genuinely-unresolvable rejection is bounded by a cap instead of looping.
describe('RECONCILE-MESHID-DROP: retry meshId injection + rejection cap', () => {
  const REMOTE_COORDINATOR = 'daemon_remote_coordinator'

  it('stamps a locally-resolvable meshId onto the retry payload so the coordinator accepts it', async () => {
    const { components } = createUnresolvedWorker(REMOTE_COORDINATOR)
    // The worker hosts node_worker as a member — listMeshes resolves the meshId by nodeId,
    // exactly what the stripped forward payload never carried.
    vi.mocked(listMeshes).mockReturnValue([{ id: 'mesh_member', nodes: [{ id: 'node_worker' }] }] as any)

    // A pre-existing outbox row WITHOUT meshId (the bug's stored shape).
    enqueueUnresolvedDelegateForward(REMOTE_COORDINATOR, 'agent:generating_completed', {
      event: 'agent:generating_completed',
      nodeId: 'node_worker',
      workspace: '/repo/worktree-worker',
      targetSessionId: 'worker-session-1',
    })
    expect(peekUnresolvedDelegateForwards()[0].payload.meshId).toBeUndefined()

    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    components.dispatchMeshCommand = dispatchMeshCommand
    await runMeshReconcileTick(components)

    // The retry push carried the recovered meshId, so the coordinator could accept it …
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    const [, command, payload] = dispatchMeshCommand.mock.calls[0]
    expect(command).toBe('mesh_forward_event')
    expect(payload.meshId).toBe('mesh_member')
    // … and on the ok response the entry is drained (loop terminates).
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)
  })

  it('caps hard rejections: drops the entry after MAX attempts to stop the infinite retry loop', async () => {
    const { components } = createUnresolvedWorker(REMOTE_COORDINATOR)
    // No mesh resolvable anywhere — the worker truly cannot stamp a meshId, so the coordinator
    // keeps rejecting "meshId required". This is the infinite-loop case the cap bounds.
    vi.mocked(listMeshes).mockReturnValue([])

    enqueueUnresolvedDelegateForward(REMOTE_COORDINATOR, 'agent:generating_started', {
      event: 'agent:generating_started',
      workspace: '/repo/unknown-workspace',
      targetSessionId: 'ghost-session',
    })

    const dispatchMeshCommand = vi.fn(async () => ({ success: false, error: 'meshId required' }))
    components.dispatchMeshCommand = dispatchMeshCommand
    components.instanceManager.getInstance = vi.fn(() => undefined) // session gone → no late resolution

    // Ticks 1..4: rejected, left queued (under the cap of 5).
    for (let i = 0; i < 4; i++) {
      await runMeshReconcileTick(components)
      expect(peekUnresolvedDelegateForwards()).toHaveLength(1)
    }
    // Tick 5: 5th rejection hits the cap → drained (dropped) with a single warning.
    await runMeshReconcileTick(components)
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(5)

    // The loop is gone: no further pushes for the dropped entry.
    dispatchMeshCommand.mockClear()
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
  })
})
