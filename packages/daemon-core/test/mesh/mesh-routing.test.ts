import { describe, expect, it, vi, beforeEach } from 'vitest'

// The resolver queries direct-dispatch state via mesh-work-queue / mesh-events-stale.
// Mock both so the unit test stays pure (no SQLite, no ledger files).
const dispatchMocks = vi.hoisted(() => ({
  getActiveDirectDispatches: vi.fn(() => [] as any[]),
  hasUnterminalDirectDispatchLedgerEntry: vi.fn(() => false),
}))

vi.mock('../../src/mesh/mesh-work-queue.js', () => ({
  getActiveDirectDispatches: dispatchMocks.getActiveDirectDispatches,
}))
vi.mock('../../src/mesh/mesh-events-stale.js', () => ({
  hasUnterminalDirectDispatchLedgerEntry: dispatchMocks.hasUnterminalDirectDispatchLedgerEntry,
}))

import { resolveWorkerDelegateRouting } from '../../src/mesh/mesh-routing.js'

const MESH = {
  id: 'mesh_1',
  nodes: [{ id: 'node_a', workspace: '/repo/worktree-a' }],
}

function makeComponents(opts: {
  category?: string
  workspace?: string
  settings?: Record<string, unknown>
} = {}) {
  const state = {
    instanceId: 'session-1',
    workspace: opts.workspace ?? '/repo/worktree-a',
    settings: opts.settings ?? {},
  }
  const instance = {
    category: opts.category ?? 'cli',
    getState: () => state,
  }
  return {
    instanceManager: {
      getInstance: (id: string) => (id === 'session-1' ? instance : undefined),
    },
  } as any
}

const deps = {
  getMeshById: vi.fn((id: string) => (id === 'mesh_1' ? MESH : undefined)),
  getMeshByWorkspace: vi.fn((ws: string) => (ws === '/repo/worktree-a' ? MESH : undefined)),
}

describe('resolveWorkerDelegateRouting', () => {
  beforeEach(() => {
    dispatchMocks.getActiveDirectDispatches.mockReturnValue([])
    dispatchMocks.hasUnterminalDirectDispatchLedgerEntry.mockReturnValue(false)
    deps.getMeshById.mockClear()
    deps.getMeshByWorkspace.mockClear()
  })

  it('resolves a fully stamped worker (meshNodeFor + meshNodeId)', () => {
    const r = resolveWorkerDelegateRouting(
      makeComponents({ settings: { meshNodeFor: 'mesh_1', meshNodeId: 'node_a' } }),
      'session-1',
      deps,
    )
    expect(r.isDelegate).toBe(true)
    expect(r.meshId).toBe('mesh_1')
    expect(r.nodeId).toBe('node_a')
    expect(r.nodeLabel).toBe("Node 'node_a'")
    expect(r.coordinatorDaemonId).toBe('')
    expect(deps.getMeshById).toHaveBeenCalledWith('mesh_1')
    expect(deps.getMeshByWorkspace).not.toHaveBeenCalled()
  })

  it('recovers mesh by workspace when only meshCoordinatorDaemonId survives (no meshNodeFor)', () => {
    const r = resolveWorkerDelegateRouting(
      makeComponents({ settings: { meshCoordinatorDaemonId: 'daemon_mach_x' } }),
      'session-1',
      deps,
    )
    expect(r.isDelegate).toBe(true)
    expect(r.meshId).toBe('mesh_1')
    // node resolved off the workspace-matched mesh node, not a runtime stamp
    expect(r.nodeId).toBe('node_a')
    expect(r.coordinatorDaemonId).toBe('daemon_mach_x')
    expect(deps.getMeshByWorkspace).toHaveBeenCalledWith('/repo/worktree-a')
    expect(deps.getMeshById).not.toHaveBeenCalled()
  })

  it('treats launchedByCoordinator alone as proof of delegation', () => {
    const r = resolveWorkerDelegateRouting(
      makeComponents({ settings: { launchedByCoordinator: true } }),
      'session-1',
      deps,
    )
    expect(r.isDelegate).toBe(true)
    expect(r.meshId).toBe('mesh_1')
  })

  it('treats meshCoordinatorNodeId alone as proof of delegation', () => {
    const r = resolveWorkerDelegateRouting(
      makeComponents({ settings: { meshCoordinatorNodeId: 'node_a' } }),
      'session-1',
      deps,
    )
    expect(r.isDelegate).toBe(true)
    expect(r.meshId).toBe('mesh_1')
  })

  it('falls back to the runtime meshNodeId label when the mesh has no workspace-matched node', () => {
    deps.getMeshById.mockReturnValueOnce({ id: 'mesh_1', nodes: [] })
    const r = resolveWorkerDelegateRouting(
      makeComponents({ settings: { meshNodeFor: 'mesh_1', meshNodeId: 'node_runtime' } }),
      'session-1',
      deps,
    )
    expect(r.isDelegate).toBe(true)
    expect(r.nodeId).toBe('node_runtime')
    expect(r.nodeLabel).toBe("Node 'node_runtime'")
  })

  it('labels by workspace when neither a node match nor a runtime node id is available', () => {
    deps.getMeshByWorkspace.mockReturnValueOnce({ id: 'mesh_1', nodes: [] })
    const r = resolveWorkerDelegateRouting(
      makeComponents({ settings: { launchedByCoordinator: true } }),
      'session-1',
      deps,
    )
    expect(r.isDelegate).toBe(true)
    expect(r.nodeId).toBe('')
    expect(r.nodeLabel).toBe('Agent at /repo/worktree-a')
  })

  describe('direct-dispatch coordinator handling', () => {
    it('rejects a coordinator session that is NOT a dispatch target', () => {
      const r = resolveWorkerDelegateRouting(
        makeComponents({ settings: { meshCoordinatorFor: 'mesh_1' } }),
        'session-1',
        deps,
      )
      expect(r.isDelegate).toBe(false)
      expect(r.rejectionReason).toBe('coordinator_not_dispatch_target')
    })

    it('routes a coordinator session that IS an active dispatch target, recovering mesh from the dispatch', () => {
      dispatchMocks.getActiveDirectDispatches.mockReturnValue([{ sessionId: 'session-1' }] as any)
      const r = resolveWorkerDelegateRouting(
        makeComponents({ settings: { meshCoordinatorFor: 'mesh_1' } }),
        'session-1',
        deps,
      )
      expect(r.isDelegate).toBe(true)
      expect(r.meshId).toBe('mesh_1')
    })

    it('also accepts an unterminal direct-dispatch ledger entry as the dispatch signal', () => {
      dispatchMocks.hasUnterminalDirectDispatchLedgerEntry.mockReturnValue(true)
      const r = resolveWorkerDelegateRouting(
        makeComponents({ settings: { meshCoordinatorFor: 'mesh_1' } }),
        'session-1',
        deps,
      )
      expect(r.isDelegate).toBe(true)
    })
  })

  describe('rejections', () => {
    it('rejects a non-cli source', () => {
      const r = resolveWorkerDelegateRouting(makeComponents({ category: 'ide' }), 'session-1', deps)
      expect(r).toMatchObject({ isDelegate: false, rejectionReason: 'not_cli' })
    })

    it('rejects a missing instance', () => {
      const r = resolveWorkerDelegateRouting(makeComponents(), 'ghost', deps)
      expect(r).toMatchObject({ isDelegate: false, rejectionReason: 'not_cli' })
    })

    it('rejects a session without a workspace', () => {
      const r = resolveWorkerDelegateRouting(
        makeComponents({ workspace: '', settings: { meshNodeFor: 'mesh_1' } }),
        'session-1',
        deps,
      )
      expect(r).toMatchObject({ isDelegate: false, rejectionReason: 'no_workspace' })
    })

    it('rejects a plain session carrying no worker envelope', () => {
      const r = resolveWorkerDelegateRouting(makeComponents({ settings: {} }), 'session-1', deps)
      expect(r).toMatchObject({ isDelegate: false, rejectionReason: 'no_worker_envelope' })
    })

    it('rejects when the envelope is present but no mesh can be resolved', () => {
      deps.getMeshByWorkspace.mockReturnValueOnce(undefined)
      const r = resolveWorkerDelegateRouting(
        makeComponents({ settings: { launchedByCoordinator: true } }),
        'session-1',
        deps,
      )
      expect(r).toMatchObject({ isDelegate: false, rejectionReason: 'mesh_unresolved' })
    })
  })
})
