import { describe, expect, it, vi, beforeEach } from 'vitest'

// Auto fast-forward → remote nodes (opt-in, default OFF). Covers the delegation path
// (maybeAutoFastForwardIdleNode for a remote node + runContinuousAutoFastForwardScan)
// and the regression guards (remoteNodes=false and mode=idle preserve the historical
// self-only / idle-edge behavior). Scoped to these two entry points so the run stays
// fast — no full daemon-core suite.

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ machineId: 'coord-machine' } as any)),
}))
const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
const fastForwardMocks = vi.hoisted(() => ({
  fastForwardMeshNode: vi.fn(),
}))

vi.mock('../../src/config/config.js', () => ({
  loadConfig: configMocks.loadConfig,
  getConfigDir: () => '/tmp/adhdev-auto-ff-remote-test',
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({
  fastForwardMeshNode: fastForwardMocks.fastForwardMeshNode,
}))

import {
  maybeAutoFastForwardIdleNode,
  runContinuousAutoFastForwardScan,
  __resetIdleAutoFastForwardForTests,
} from '../../src/mesh/mesh-queue-assignment.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'

const MESH_ID = 'mesh_ff_remote'
const REMOTE_DAEMON = 'daemon_mach_remote1'

// A dry-run result that passes every gate: fast_forward_available, allowed, behind>0,
// within maxBehind, clean submodules.
function cleanBehindDryRun(behind = 2) {
  return {
    success: true,
    code: 'fast_forward_available',
    allowed: true,
    executed: false,
    current: { ahead: 0, behind, dirty: false, submodules: [] },
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

// A components stub. instanceManager has no CLI sessions (node is idle / no active work),
// getMeshPeerConnectionStatus reports connected, dispatchMeshCommand is spied.
function buildComponents(opts?: {
  connected?: boolean
  dispatch?: ReturnType<typeof vi.fn>
  peerGetterWired?: boolean
}) {
  const connected = opts?.connected !== false
  const dispatch = opts?.dispatch ?? vi.fn(async () => cleanBehindDryRun())
  const components: any = {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? [] : [])),
      getInstance: vi.fn(() => undefined),
    },
    dispatchMeshCommand: dispatch,
    router: { getCachedInlineMesh: vi.fn(() => undefined) },
  }
  if (opts?.peerGetterWired !== false) {
    components.getMeshPeerConnectionStatus = vi.fn(() => (connected ? { state: 'connected' } : { state: 'disconnected' }))
  }
  return { components, dispatch }
}

beforeEach(() => {
  __clearMeshQueueForTests(MESH_ID)
  __resetMeshRuntimeStoreForTests()
  __resetIdleAutoFastForwardForTests()
  configMocks.loadConfig.mockReturnValue({ machineId: 'coord-machine' } as any)
  meshConfigMocks.getMesh.mockReset()
  meshConfigMocks.listMeshes.mockReset()
  meshConfigMocks.listMeshes.mockReturnValue([])
  fastForwardMocks.fastForwardMeshNode.mockReset()
})

describe('maybeAutoFastForwardIdleNode — remote delegation', () => {
  it('remoteNodes=true: online/clean/behind remote node → delegates ff to owning daemon (dry-run then execute)', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const dispatch = vi.fn(async (_daemon: string, _cmd: string, payload: any) =>
      payload?.execute ? { ...cleanBehindDryRun(), executed: true, code: 'fast_forwarded' } : cleanBehindDryRun())
    const { components } = buildComponents({ dispatch })

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    // Two dispatches: fresh remote dry-run, then execute.
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0][0]).toBe(REMOTE_DAEMON)
    expect(dispatch.mock.calls[0][1]).toBe('fast_forward_mesh_node')
    expect(dispatch.mock.calls[0][2]).toMatchObject({ execute: false, dryRun: true, meshId: MESH_ID, nodeId: 'node_remote_1' })
    expect(dispatch.mock.calls[1][2]).toMatchObject({ execute: true, dryRun: false })
    // The local ff path must NOT run for a remote node.
    expect(fastForwardMocks.fastForwardMeshNode).not.toHaveBeenCalled()
  })

  it('remoteNodes=false (default): remote node is NOT fast-forwarded — regression guard', async () => {
    const mesh = buildMesh({ enabled: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const { components, dispatch } = buildComponents()

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).not.toHaveBeenCalled()
    expect(fastForwardMocks.fastForwardMeshNode).not.toHaveBeenCalled()
  })

  it('remote node offline (peer not connected) → skipped, no delegation', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const { components, dispatch } = buildComponents({ connected: false })

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('TOCTOU: fresh remote dry-run no longer clean/available → execute is NOT sent', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    // Fresh dry-run comes back dirty/blocked (state changed since the scan).
    const dispatch = vi.fn(async () => ({ success: true, code: 'branch_dirty', allowed: false, current: { ahead: 0, behind: 2 } }))
    const { components } = buildComponents({ dispatch })

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).toHaveBeenCalledTimes(1) // dry-run only; execute suppressed
    expect(dispatch.mock.calls[0][2]).toMatchObject({ execute: false })
  })

  it('maxBehind exceeded on fresh dry-run → execute is NOT sent', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true, maxBehind: 1 }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const dispatch = vi.fn(async () => cleanBehindDryRun(5)) // behind 5 > maxBehind 1
    const { components } = buildComponents({ dispatch })

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('dirty submodules on fresh dry-run with requireCleanSubmodules → execute is NOT sent', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const dispatch = vi.fn(async () => ({
      ...cleanBehindDryRun(),
      current: { ahead: 0, behind: 2, submodules: [{ path: 'oss', dirty: true }] },
    }))
    const { components } = buildComponents({ dispatch })

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // Regression for the gitlink-drift self-block bug (mission b6556fc4): a submodule that
  // is merely out-of-sync (checked-out commit differs from the gitlink, but its own
  // working tree is clean) must NOT be treated the same as a dirty submodule — it is
  // exactly the drift that updateSubmodules:true resolves in the same ff cycle. Before
  // the fix, this test fails: dryRunSatisfiesAutoFastForwardPolicy's requireCleanSubmodules
  // gate lumped outOfSync in with dirty/error, so execute was never sent and drift
  // (and behind-count) would only ever accumulate.
  it('pure gitlink drift (outOfSync, not dirty) on fresh dry-run → execute IS sent, with updateSubmodules:true', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const dispatch = vi.fn(async (_daemon: string, _cmd: string, payload: any) =>
      payload?.execute
        ? { executed: true, code: 'fast_forward_applied' }
        : { ...cleanBehindDryRun(), current: { ahead: 0, behind: 2, submodules: [{ path: 'oss', dirty: false, outOfSync: true }] } })
    const { components } = buildComponents({ dispatch })

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0][2]).toMatchObject({ execute: false, updateSubmodules: true })
    expect(dispatch.mock.calls[1][2]).toMatchObject({ execute: true, updateSubmodules: true })
  })

  // Companion regression: a submodule reported both outOfSync AND dirty (real edit sitting
  // on top of drift) must still hard-block — the relaxation is for pure drift only.
  it('outOfSync AND dirty submodule on fresh dry-run → execute is still NOT sent', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const dispatch = vi.fn(async () => ({
      ...cleanBehindDryRun(),
      current: { ahead: 0, behind: 2, submodules: [{ path: 'oss', dirty: true, outOfSync: true }] },
    }))
    const { components } = buildComponents({ dispatch })

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('busy node (active generating session) → skipped even with remoteNodes=true', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const { components, dispatch } = buildComponents()
    // A CLI session bound to this node that is generating → nodeHasActiveMeshWork true.
    components.instanceManager.getByCategory = vi.fn((category: string) =>
      category === 'cli'
        ? [{
            getState: () => ({
              instanceId: 'busy-sess',
              status: 'generating',
              settings: { meshNodeFor: MESH_ID, meshNodeId: 'node_remote_1' },
            }),
          }]
        : [])

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('local node (coordinator workspace): still uses the local ff path, never delegation — regression guard', async () => {
    // A node whose daemonId matches the local machine is LOCAL: isLocalAutoLaunchNode
    // true → historical self-only path (fastForwardMeshNode), never dispatchMeshCommand.
    // Use process.cwd() so the existsSync gate passes without touching a fixed path.
    const localNode = remoteBaseNode({
      id: 'node_local',
      daemonId: 'daemon_coord-machine',
      machineId: 'coord-machine',
      workspace: process.cwd(),
      connection: undefined,
    })
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [localNode])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    fastForwardMocks.fastForwardMeshNode.mockImplementation(async (a: any) =>
      a.execute ? { executed: true, code: 'fast_forwarded' } : cleanBehindDryRun())
    const { components, dispatch } = buildComponents()

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_local' })

    // Local path: fastForwardMeshNode dry-run + execute; delegation never used.
    expect(fastForwardMocks.fastForwardMeshNode).toHaveBeenCalledTimes(2)
    // Regression (mission b6556fc4): local auto-ff must also opt into updateSubmodules
    // so a gitlink-moving ff can't leave the submodule checkout drifted.
    expect(fastForwardMocks.fastForwardMeshNode.mock.calls[0][0]).toMatchObject({ execute: false, updateSubmodules: true })
    expect(fastForwardMocks.fastForwardMeshNode.mock.calls[1][0]).toMatchObject({ execute: true, updateSubmodules: true })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('enabled=false → no delegation regardless of remoteNodes', async () => {
    const mesh = buildMesh({ enabled: false, remoteNodes: true }, [remoteBaseNode()])
    meshConfigMocks.getMesh.mockReturnValue(mesh)
    const { components, dispatch } = buildComponents()

    await maybeAutoFastForwardIdleNode(components, { meshId: MESH_ID, nodeId: 'node_remote_1' })

    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('runContinuousAutoFastForwardScan', () => {
  it('mode=continuous + remoteNodes=true: scans connected base node and delegates ff', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [remoteBaseNode()])
    const dispatch = vi.fn(async (_d: string, _c: string, payload: any) =>
      payload?.execute ? { executed: true } : cleanBehindDryRun())
    const { components } = buildComponents({ dispatch })

    await runContinuousAutoFastForwardScan(components, mesh)

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0][2]).toMatchObject({ trigger: 'reconcile_auto', execute: false })
  })

  it('mode=idle (default): continuous scan is a no-op — regression guard', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true }, [remoteBaseNode()]) // no mode → idle
    const { components, dispatch } = buildComponents()

    await runContinuousAutoFastForwardScan(components, mesh)

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('mode=continuous but remoteNodes=false: no-op — regression guard', async () => {
    const mesh = buildMesh({ enabled: true, mode: 'continuous' }, [remoteBaseNode()])
    const { components, dispatch } = buildComponents()

    await runContinuousAutoFastForwardScan(components, mesh)

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('continuous excludes ephemeral worktree nodes', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [
      remoteBaseNode({ id: 'node_wt', isLocalWorktree: true, workspace: '/remote/wt' }),
    ])
    const { components, dispatch } = buildComponents()

    await runContinuousAutoFastForwardScan(components, mesh)

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('continuous per-node cooldown: a second immediate scan does not re-delegate', async () => {
    const mesh = buildMesh({ enabled: true, remoteNodes: true, mode: 'continuous' }, [remoteBaseNode()])
    const dispatch = vi.fn(async (_d: string, _c: string, payload: any) =>
      payload?.execute ? { executed: true } : cleanBehindDryRun())
    const { components } = buildComponents({ dispatch })

    await runContinuousAutoFastForwardScan(components, mesh)
    const firstCount = dispatch.mock.calls.length
    await runContinuousAutoFastForwardScan(components, mesh) // within cooldown window
    expect(dispatch.mock.calls.length).toBe(firstCount)
  })
})
