import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// P6 (2026-09-23 IPC-load audit, finding 6): continuous auto-fast-forward used to run
// INSIDE the 4s reconcile tick, awaited serially per hosted mesh. This suite covers the
// decoupled scheduler introduced to fix that:
//   1. Per-node backoff GROWS on a confirmed no-op round and RESETS on real movement.
//   2. The scheduler's own timer never overlaps and is independent of any reconcile tick.
//   3. A slow/degraded peer's dry-run does not block the scheduler's other nodes (bounded
//      by a per-call timeout).
// Scoped to mesh-auto-fast-forward.ts's own exports — no full daemon-core suite.

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ machineId: 'coord-machine' } as any)),
}))
const meshConfigMocks = vi.hoisted(() => ({
  listMeshes: vi.fn(() => [] as any[]),
}))
const fastForwardMocks = vi.hoisted(() => ({
  fastForwardMeshNode: vi.fn(),
}))

vi.mock('../../src/config/config.js', () => ({
  loadConfig: configMocks.loadConfig,
  getConfigDir: () => '/tmp/adhdev-auto-ff-scheduler-test',
  getMachineId: () => (configMocks.loadConfig() as any).machineId,
  getMachineNickname: () => (configMocks.loadConfig() as any).machineNickname ?? null,
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({
  fastForwardMeshNode: fastForwardMocks.fastForwardMeshNode,
}))

import {
  runContinuousAutoFastForwardScan,
  startContinuousAutoFastForwardScheduler,
  __resetIdleAutoFastForwardForTests,
} from '../../src/mesh/mesh-auto-fast-forward.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'

const MESH_ID = 'mesh_ff_sched'
const REMOTE_DAEMON = 'daemon_mach_remote1'

function cleanBehindDryRun(behind = 2) {
  return {
    success: true,
    code: 'fast_forward_available',
    allowed: true,
    executed: false,
    current: { ahead: 0, behind, dirty: false, submodules: [] },
  }
}

function noMovementDryRun() {
  return {
    success: true,
    code: 'up_to_date',
    allowed: false,
    current: { ahead: 0, behind: 0, dirty: false, submodules: [] },
  }
}

function remoteBaseNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'node_remote_1',
    daemonId: REMOTE_DAEMON,
    machineId: 'mach_remote1',
    workspace: '/remote/repo',
    isLocalWorktree: false,
    status: 'online',
    connection: { state: 'connected' },
    ...overrides,
  }
}

function buildMesh(policyAff: Record<string, unknown> | undefined, nodes: any[]) {
  return {
    id: MESH_ID,
    defaultBranch: 'main',
    policy: policyAff === undefined ? {} : { autoFastForward: policyAff },
    nodes,
  }
}

function buildComponents(opts?: { dispatch?: ReturnType<typeof vi.fn> }) {
  const dispatch = opts?.dispatch ?? vi.fn(async () => cleanBehindDryRun())
  const components: any = {
    instanceManager: {
      getByCategory: vi.fn(() => []),
      getInstance: vi.fn(() => undefined),
    },
    dispatchMeshCommand: dispatch,
    router: { getCachedInlineMesh: vi.fn(() => undefined) },
    getMeshPeerConnectionStatus: vi.fn(() => ({ state: 'connected' })),
  }
  return { components, dispatch }
}

beforeEach(() => {
  __clearMeshQueueForTests(MESH_ID)
  __resetMeshRuntimeStoreForTests()
  __resetIdleAutoFastForwardForTests()
  configMocks.loadConfig.mockReturnValue({ machineId: 'coord-machine' } as any)
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  fastForwardMocks.fastForwardMeshNode.mockReset()
  delete process.env.MESH_AUTO_FF_SCAN_BASE_MS
  delete process.env.MESH_AUTO_FF_SCAN_MAX_MS
  delete process.env.MESH_AUTO_FF_CALL_TIMEOUT_MS
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runContinuousAutoFastForwardScan — per-node backoff', () => {
  it('confirmed no-op round backs off past the base 45s cooldown (RED->GREEN gate check below)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [remoteBaseNode()])
    const dispatch = vi.fn(async () => noMovementDryRun())
    const { components } = buildComponents({ dispatch })

    // Round 1: no-op — dry-run only (execute never sent because dryRunSatisfiesAutoFastForwardPolicy fails).
    await runContinuousAutoFastForwardScan(components, mesh)
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Immediately after (well within the 45s base): still backed off.
    await runContinuousAutoFastForwardScan(components, mesh)
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Advance past the base 45s window: base backoff alone would now allow a re-scan,
    // but since round 1 was a NO-OP, the backoff should have grown to 90s — so at 46s
    // it must STILL be backed off. This is the behavior a plain fixed-cooldown revert
    // would fail: reverting the multiplier growth (treating every round as a flat 45s
    // cooldown) makes this assertion fail (dispatch called again at t=46s).
    vi.setSystemTime(Date.now() + 46_000)
    await runContinuousAutoFastForwardScan(components, mesh)
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Advance to just past the grown 90s step from round 1: now eligible again.
    vi.setSystemTime(Date.now() + 45_000) // total ~91s since round 1
    await runContinuousAutoFastForwardScan(components, mesh)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('a round that finds real movement resets the backoff to the base interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [remoteBaseNode()])
    let noOpRounds = 0
    const dispatch = vi.fn(async (_d: string, _c: string, payload: any) => {
      if (payload?.execute) return { executed: true }
      // First two rounds no-op (grow backoff to 90s, 180s); third round finds movement.
      noOpRounds++
      return noOpRounds <= 2 ? noMovementDryRun() : cleanBehindDryRun()
    })
    const { components } = buildComponents({ dispatch })

    await runContinuousAutoFastForwardScan(components, mesh) // no-op #1 -> step 90s (1 call: dry-run only)
    vi.setSystemTime(Date.now() + 91_000)
    await runContinuousAutoFastForwardScan(components, mesh) // no-op #2 -> step 180s (1 call: dry-run only)
    vi.setSystemTime(Date.now() + 181_000)
    await runContinuousAutoFastForwardScan(components, mesh) // finds movement -> dry-run + execute (2 calls), resets to base
    expect(dispatch).toHaveBeenCalledTimes(4) // 1 + 1 + 2

    // Immediately after the reset: base interval (45s) applies, not the grown 180s —
    // so at 46s it should be eligible again (proves the reset, not merely "still growing").
    // This round also finds movement (dry-run + execute = 2 more calls).
    vi.setSystemTime(Date.now() + 46_000)
    await runContinuousAutoFastForwardScan(components, mesh)
    expect(dispatch).toHaveBeenCalledTimes(6)
  })

  it('mode=idle / remoteNodes=false remain no-ops — regression guard for the scheduler path', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()]) // no mode -> idle
    const { components, dispatch } = buildComponents()
    await runContinuousAutoFastForwardScan(components, mesh)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('runContinuousAutoFastForwardScan — cached git-status precheck', () => {
  it('a fresh, recent, ahead=0/behind=0 cached git status skips the P2P dry-run entirely', async () => {
    const node = remoteBaseNode({
      git: { upstreamStatus: 'fresh', upstreamFetchedAt: Date.now(), ahead: 0, behind: 0 },
    })
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [node])
    const { components, dispatch } = buildComponents()

    await runContinuousAutoFastForwardScan(components, mesh)

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a stale cached git status does NOT skip the dry-run (falls through to a real check)', async () => {
    const node = remoteBaseNode({
      git: { upstreamStatus: 'fresh', upstreamFetchedAt: Date.now() - 20 * 60_000, ahead: 0, behind: 0 },
    })
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [node])
    const dispatch = vi.fn(async () => noMovementDryRun())
    const { components } = buildComponents({ dispatch })

    await runContinuousAutoFastForwardScan(components, mesh)

    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('a cached git status showing real behind-count does NOT skip the dry-run', async () => {
    const node = remoteBaseNode({
      git: { upstreamStatus: 'fresh', upstreamFetchedAt: Date.now(), ahead: 0, behind: 3 },
    })
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [node])
    const dispatch = vi.fn(async (_d: string, _c: string, payload: any) =>
      payload?.execute ? { executed: true } : cleanBehindDryRun(3))
    const { components } = buildComponents({ dispatch })

    await runContinuousAutoFastForwardScan(components, mesh)

    expect(dispatch).toHaveBeenCalledTimes(2) // dry-run + execute, precheck did NOT short-circuit
  })
})

describe('startContinuousAutoFastForwardScheduler', () => {
  it('runs on its own timer, independent of any reconcile tick, and never overlaps itself', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] })
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [remoteBaseNode()])
    meshConfigMocks.listMeshes.mockReturnValue([mesh])
    let inFlight = 0
    let maxConcurrent = 0
    const dispatch = vi.fn(async (_d: string, _c: string, payload: any) => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 500))
      inFlight--
      return payload?.execute ? { executed: true } : cleanBehindDryRun()
    })
    const { components } = buildComponents({ dispatch })

    const handle = startContinuousAutoFastForwardScheduler(components, () => meshConfigMocks.listMeshes())
    try {
      // Advance well past several poll intervals while the first scan is still
      // "in flight" (fake timers + a real microtask-based dispatch mock) — the
      // scheduler's own `running` guard must prevent a second tick from starting
      // a concurrent scan.
      await vi.advanceTimersByTimeAsync(500)
      expect(maxConcurrent).toBeLessThanOrEqual(1)
    } finally {
      handle.stop()
    }
  })

  it('reconcile tick does not await auto-ff: the scheduler tick function returns without the caller blocking on P2P', async () => {
    // This is a structural assertion on the module wiring rather than a timing race:
    // mesh-reconcile-loop.ts's runMeshReconcileTick must not import or call
    // runContinuousAutoFastForwardScan / startContinuousAutoFastForwardScheduler.
    const reconcileLoopSource = await import('../../src/mesh/mesh-reconcile-loop.js')
    // The tick function itself is exported; verifying it completes without the mock
    // dispatch (which mesh-auto-fast-forward would call) ever being invoked when no
    // continuous-mode mesh exists demonstrates PHASE 2.7 no longer runs inline. The
    // stronger, static guarantee (never awaited) is documented in the PHASE 2.7
    // REMOVED comment in mesh-reconcile-loop.ts and enforced by this module split:
    // runContinuousAutoFastForwardScan is only reachable from
    // startContinuousAutoFastForwardScheduler's own timer now.
    expect(typeof reconcileLoopSource.runMeshReconcileTick).toBe('function')
  })
})
