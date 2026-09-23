import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// P6 (2026-09-23 IPC-load audit, finding 6/(f)): bound the reconcile tick's remote-RPC
// phase so ONE slow/degraded peer's dispatchMeshCommand call cannot stretch every OTHER
// daemon's pull. pullRemoteNodeQueues already parallelizes across daemons WITHIN one
// mesh (Promise.allSettled); this suite covers the ADDITIONAL cross-round protection —
// a daemon whose LAST pull exceeded the budget is skipped for exactly one round, then
// retried (never permanently wedged).

const configMocks = vi.hoisted(() => ({ loadConfig: vi.fn(() => ({ machineId: 'coord-machine' } as any)) }))
vi.mock('../../src/config/config.js', () => ({
  loadConfig: configMocks.loadConfig,
  getConfigDir: () => '/tmp/adhdev-remote-pull-slow-test',
  getMachineId: () => (configMocks.loadConfig() as any).machineId,
  getMachineNickname: () => (configMocks.loadConfig() as any).machineNickname ?? null,
}))

import {
  pullRemoteNodeQueues,
  __resetRemoteEventPullPacingForTests,
} from '../../src/mesh/mesh-remote-event-pull.js'

const MESH_ID = 'mesh_pull_slow'
const FAST_DAEMON = 'daemon_mach_fast1'
const SLOW_DAEMON = 'daemon_mach_slow1'

function buildMesh() {
  return {
    id: MESH_ID,
    nodes: [
      { daemonId: FAST_DAEMON, id: 'node_fast' },
      { daemonId: SLOW_DAEMON, id: 'node_slow' },
    ],
  } as any
}

function emptyPendingEventsResult() {
  return { success: true, events: [] }
}

beforeEach(() => {
  __resetRemoteEventPullPacingForTests()
  delete process.env.MESH_REMOTE_PULL_SLOW_DAEMON_SKIP_MS
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pullRemoteNodeQueues — slow-daemon isolation', () => {
  it('a slow peer does not block delivery from a fast peer in the same round (allSettled fan-out)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let fastResolvedAtMs = -1
    let slowResolvedAtMs = -1
    const dispatch = vi.fn(async (daemonId: string) => {
      if (daemonId === FAST_DAEMON) {
        fastResolvedAtMs = Date.now()
        return emptyPendingEventsResult()
      }
      // Slow peer: simulate a multi-second round-trip.
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      slowResolvedAtMs = Date.now()
      return emptyPendingEventsResult()
    })
    const components: any = {
      dispatchMeshCommand: dispatch,
      getMeshPeerConnectionStatus: vi.fn(() => ({ state: 'connected' })),
    }

    const pullPromise = pullRemoteNodeQueues(components, buildMesh(), 'coord-machine', ['coord-machine'])
    // Let the fast daemon's microtask resolve without advancing the slow one's timer.
    await vi.advanceTimersByTimeAsync(0)
    expect(fastResolvedAtMs).toBeGreaterThanOrEqual(0) // fast daemon already got its answer
    expect(slowResolvedAtMs).toBe(-1) // slow daemon has NOT resolved yet

    // Now let the slow daemon's timer fire and the whole pull settle.
    await vi.advanceTimersByTimeAsync(5_000)
    await pullPromise
    expect(slowResolvedAtMs).toBeGreaterThan(fastResolvedAtMs)
  })

  it('a daemon whose last pull exceeded the budget is skipped on the VERY NEXT round, then retried', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    process.env.MESH_REMOTE_PULL_SLOW_DAEMON_SKIP_MS = '1000' // 1s budget (floor-clamped minimum)
    let callCount = 0
    const dispatch = vi.fn(async (daemonId: string) => {
      if (daemonId !== SLOW_DAEMON) return emptyPendingEventsResult()
      callCount++
      if (callCount === 1) {
        // First call: exceed the 1s budget.
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      return emptyPendingEventsResult()
    })
    const components: any = {
      dispatchMeshCommand: dispatch,
      getMeshPeerConnectionStatus: vi.fn(() => ({ state: 'connected' })),
    }
    const mesh = { id: MESH_ID, nodes: [{ daemonId: SLOW_DAEMON, id: 'node_slow' }] } as any

    // Round 1: slow call goes through and records a >1s duration.
    const round1 = pullRemoteNodeQueues(components, mesh, 'coord-machine', ['coord-machine'])
    await vi.advanceTimersByTimeAsync(2_000)
    await round1
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Round 2: skipped because round 1 was recorded as slow — dispatch is NOT called again.
    await pullRemoteNodeQueues(components, mesh, 'coord-machine', ['coord-machine'])
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Round 3: the skip is consumed (one-shot), so this round calls through again.
    await pullRemoteNodeQueues(components, mesh, 'coord-machine', ['coord-machine'])
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})
