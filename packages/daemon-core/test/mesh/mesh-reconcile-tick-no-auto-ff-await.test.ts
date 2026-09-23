import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// P6 (2026-09-23 IPC-load audit, finding 6): the reconcile tick must NEVER await
// continuous auto-fast-forward — that scan now runs on its own scheduler (see
// mesh-auto-fast-forward.ts's startContinuousAutoFastForwardScheduler and
// mesh-reconcile-loop.ts's "PHASE 2.7 REMOVED" comment). This is a lightweight,
// self-contained regression guard: a single hosted continuous-mode mesh, with
// dispatchMeshCommand spied, and the tick run directly (not through
// setupMeshReconcileLoop, so the scheduler's own timer is never started) — if the
// tick still called the continuous scan inline, dispatchMeshCommand would receive a
// fast_forward_mesh_node dry-run within this single await; it must not.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-reconcile-noff-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' }),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
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
import { __resetMeshRuntimeStoreForTests, __clearMeshQueueForTests } from '../../src/mesh/mesh-work-queue.js'
import { __resetIdleAutoFastForwardForTests } from '../../src/mesh/mesh-auto-fast-forward.js'

const MESH_ID = 'mesh_tick_noff'
const REMOTE_DAEMON = 'daemon_mach_remote_noff'

function buildContinuousMesh() {
  return {
    id: MESH_ID,
    defaultBranch: 'main',
    policy: { autoFastForward: { enabled: true, remoteNodes: true, mode: 'continuous' } },
    nodes: [
      {
        id: 'node_remote_1',
        daemonId: REMOTE_DAEMON,
        machineId: 'mach_remote_noff',
        workspace: '/remote/repo',
        isLocalWorktree: false,
        status: 'online',
        connection: { state: 'connected' },
        host: { daemonId: 'test-machine' }, // this daemon "hosts" the mesh for PHASE gating
      },
    ],
  }
}

beforeEach(() => {
  __clearMeshQueueForTests(MESH_ID)
  __resetMeshRuntimeStoreForTests()
  __resetIdleAutoFastForwardForTests()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.getMesh.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runMeshReconcileTick — does not await continuous auto-fast-forward', () => {
  it('a hosted continuous-mode mesh with a stale remote node never triggers fast_forward_mesh_node from the tick itself', async () => {
    const mesh = buildContinuousMesh()
    meshConfigMocks.listMeshes.mockReturnValue([mesh])
    meshConfigMocks.getMesh.mockImplementation((id: string) => (id === MESH_ID ? mesh : undefined))

    const dispatchMeshCommand = vi.fn(async (_daemonId: string, command: string) => {
      if (command === 'fast_forward_mesh_node') {
        throw new Error('REGRESSION: reconcile tick must not call fast_forward_mesh_node inline')
      }
      // Any other command (get_pending_mesh_events, get_status_metadata, …) is
      // answered with an empty/benign result so the other phases no-op quickly.
      return { success: true, events: [] }
    })
    const components: any = {
      dispatchMeshCommand,
      instanceManager: {
        getByCategory: () => [],
        getInstance: () => undefined,
      },
      getMeshPeerConnectionStatus: vi.fn(() => ({ state: 'connected' })),
      router: { getCachedInlineMesh: vi.fn(() => undefined) },
      statusInstanceId: 'test-machine',
    }

    await runMeshReconcileTick(components)

    const fastForwardCalls = dispatchMeshCommand.mock.calls.filter(([, command]) => command === 'fast_forward_mesh_node')
    expect(fastForwardCalls).toHaveLength(0)
  })
})
