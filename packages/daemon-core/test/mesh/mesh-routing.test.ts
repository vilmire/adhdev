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

// Isolate the ledger so delivery_unroutable diagnostics are inspectable without real file I/O.
const ledgerMocks = vi.hoisted(() => ({
  appendLedgerEntry: vi.fn((meshId: string, partial: any) => ({ id: 'x', meshId, timestamp: new Date(0).toISOString(), ...partial })),
  readLedgerEntries: vi.fn(() => [] as any[]),
}))
vi.mock('../../src/mesh/mesh-ledger.js', () => ({
  appendLedgerEntry: ledgerMocks.appendLedgerEntry,
  readLedgerEntries: ledgerMocks.readLedgerEntries,
}))

import {
  resolveWorkerDelegateRouting,
  recordUnroutableDelegateEvent,
  isUnroutableDelegateRejection,
  getRecentUnroutableDeliveries,
  UNROUTABLE_DIAGNOSTIC_STREAM,
  __resetUnroutableDiagnosticsForTests,
} from '../../src/mesh/mesh-routing.js'

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

  // P1: the stamped meshNodeId is the worker's own identity and must be the FIRST
  // authority for node resolution. Workspace lookup is only a fallback. Without this,
  // a worktree clone sharing the base node's workspace (or a clone not yet in
  // mesh.nodes) gets mis-resolved to the base node, and the completion event is stamped
  // with the wrong nodeId — failing post-hoc matching so the coordinator never sees it.
  describe('P1: stamped meshNodeId is the node-resolution authority', () => {
    it('splits a worktree clone from its base node when they share a workspace', () => {
      // Base + worktree clone both report the SAME workspace. A workspace-only .find()
      // would always return the base (node_base, listed first); the stamp must win.
      deps.getMeshById.mockReturnValueOnce({
        id: 'mesh_1',
        nodes: [
          { id: 'node_base', workspace: '/repo/shared' },
          { id: 'node_worktree', workspace: '/repo/shared' },
        ],
      })
      const r = resolveWorkerDelegateRouting(
        makeComponents({
          workspace: '/repo/shared',
          settings: { meshNodeFor: 'mesh_1', meshNodeId: 'node_worktree' },
        }),
        'session-1',
        deps,
      )
      expect(r.isDelegate).toBe(true)
      expect(r.nodeId).toBe('node_worktree')
      expect(r.nodeLabel).toBe("Node 'node_worktree'")
    })

    it('matches the stamped node via the nodeId / node_id serialization forms', () => {
      // The mesh node arrived in inline-cache (nodeId) and DB-column (node_id) forms,
      // not the config `id` form. meshNodeIdMatches must still find it by the stamp.
      deps.getMeshById.mockReturnValueOnce({
        id: 'mesh_1',
        nodes: [{ nodeId: 'node_inline', node_id: 'node_inline', workspace: '/repo/other' }],
      })
      const r = resolveWorkerDelegateRouting(
        makeComponents({
          workspace: '/repo/worktree-a',
          settings: { meshNodeFor: 'mesh_1', meshNodeId: 'node_inline' },
        }),
        'session-1',
        deps,
      )
      expect(r.isDelegate).toBe(true)
      expect(r.nodeId).toBe('node_inline')
      expect(r.nodeLabel).toBe("Node 'node_inline'")
    })

    it('still falls back to workspace lookup when no node stamp is present (no regression)', () => {
      const r = resolveWorkerDelegateRouting(
        makeComponents({ settings: { meshCoordinatorDaemonId: 'daemon_x' } }),
        'session-1',
        deps,
      )
      expect(r.isDelegate).toBe(true)
      // node_a is resolved purely off the workspace-matched mesh node.
      expect(r.nodeId).toBe('node_a')
      expect(r.nodeLabel).toBe("Node 'node_a'")
      expect(deps.getMeshByWorkspace).toHaveBeenCalledWith('/repo/worktree-a')
    })
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

    it('rejects when the envelope is present but no mesh can be resolved, carrying context', () => {
      deps.getMeshByWorkspace.mockReturnValueOnce(undefined)
      const r = resolveWorkerDelegateRouting(
        makeComponents({ settings: { launchedByCoordinator: true, meshCoordinatorDaemonId: 'daemon_x' } }),
        'session-1',
        deps,
      )
      // R4: rejection still carries workspace/sessionId/coordinatorDaemonId so the
      // delivery_unroutable diagnostic can name the dropped event's origin.
      expect(r).toMatchObject({
        isDelegate: false,
        rejectionReason: 'mesh_unresolved',
        workspace: '/repo/worktree-a',
        sessionId: 'session-1',
        coordinatorDaemonId: 'daemon_x',
      })
    })
  })
})

describe('R4 fail-loud routing diagnostics', () => {
  beforeEach(() => {
    ledgerMocks.appendLedgerEntry.mockClear()
    ledgerMocks.readLedgerEntries.mockReset()
    ledgerMocks.readLedgerEntries.mockReturnValue([])
    __resetUnroutableDiagnosticsForTests()
  })

  const unresolved = (sessionId = 'session-1'): any => ({
    isDelegate: false,
    rejectionReason: 'mesh_unresolved',
    meshId: '',
    nodeId: '',
    nodeLabel: '',
    coordinatorDaemonId: 'daemon_x',
    workspace: '/repo/worktree-a',
    sessionId,
  })

  it('isUnroutableDelegateRejection is true only for mesh_unresolved', () => {
    expect(isUnroutableDelegateRejection(unresolved())).toBe(true)
    for (const reason of ['not_cli', 'no_workspace', 'no_worker_envelope', 'coordinator_not_dispatch_target']) {
      expect(isUnroutableDelegateRejection({ ...unresolved(), rejectionReason: reason } as any)).toBe(false)
    }
    expect(isUnroutableDelegateRejection({ ...unresolved(), isDelegate: true, rejectionReason: undefined } as any)).toBe(false)
  })

  it('writes a delivery_unroutable ledger entry for an enveloped-but-unresolved drop', () => {
    const wrote = recordUnroutableDelegateEvent(unresolved(), 'agent:generating_completed')
    expect(wrote).toBe(true)
    expect(ledgerMocks.appendLedgerEntry).toHaveBeenCalledTimes(1)
    const [meshId, partial] = ledgerMocks.appendLedgerEntry.mock.calls[0]
    expect(meshId).toBe(UNROUTABLE_DIAGNOSTIC_STREAM)
    expect(partial.kind).toBe('delivery_unroutable')
    expect(partial.sessionId).toBe('session-1')
    expect(partial.payload).toMatchObject({
      event: 'agent:generating_completed',
      reason: 'mesh_unresolved',
      workspace: '/repo/worktree-a',
      coordinatorDaemonId: 'daemon_x',
    })
  })

  it('is a no-op for benign (non-diagnostic) rejections', () => {
    for (const reason of ['not_cli', 'no_workspace', 'no_worker_envelope', 'coordinator_not_dispatch_target']) {
      expect(recordUnroutableDelegateEvent({ ...unresolved(), rejectionReason: reason } as any, 'agent:generating_completed')).toBe(false)
    }
    expect(ledgerMocks.appendLedgerEntry).not.toHaveBeenCalled()
  })

  it('dedups repeated drops from the same session+event within the window', () => {
    expect(recordUnroutableDelegateEvent(unresolved(), 'agent:generating_completed')).toBe(true)
    expect(recordUnroutableDelegateEvent(unresolved(), 'agent:generating_completed')).toBe(false)
    // A different event from the same session is NOT deduped.
    expect(recordUnroutableDelegateEvent(unresolved(), 'agent:waiting_approval')).toBe(true)
    expect(ledgerMocks.appendLedgerEntry).toHaveBeenCalledTimes(2)
  })

  it('getRecentUnroutableDeliveries reads the diagnostic stream newest-first', () => {
    const now = Date.now()
    ledgerMocks.readLedgerEntries.mockReturnValue([
      { id: '1', meshId: UNROUTABLE_DIAGNOSTIC_STREAM, kind: 'delivery_unroutable', timestamp: new Date(now - 1000).toISOString(), sessionId: 'sess-a', payload: { event: 'agent:generating_completed', workspace: '/w/a' } },
      { id: '2', meshId: UNROUTABLE_DIAGNOSTIC_STREAM, kind: 'delivery_unroutable', timestamp: new Date(now - 500).toISOString(), sessionId: 'sess-b', payload: { event: 'agent:waiting_approval', workspace: '/w/b', coordinatorDaemonId: 'daemon_y' } },
    ] as any)
    const recent = getRecentUnroutableDeliveries()
    expect(recent).toHaveLength(2)
    expect(recent[0]).toMatchObject({ sessionId: 'sess-b', event: 'agent:waiting_approval', workspace: '/w/b', coordinatorDaemonId: 'daemon_y' })
    expect(recent[1]).toMatchObject({ sessionId: 'sess-a', event: 'agent:generating_completed', workspace: '/w/a' })
  })

  it('getRecentUnroutableDeliveries excludes entries older than the window', () => {
    const now = Date.now()
    ledgerMocks.readLedgerEntries.mockReturnValue([
      { id: '1', meshId: UNROUTABLE_DIAGNOSTIC_STREAM, kind: 'delivery_unroutable', timestamp: new Date(now - 2 * 60 * 60 * 1000).toISOString(), sessionId: 'old', payload: { event: 'agent:generating_completed' } },
    ] as any)
    expect(getRecentUnroutableDeliveries({ sinceMs: 60 * 60 * 1000 })).toHaveLength(0)
  })
})
