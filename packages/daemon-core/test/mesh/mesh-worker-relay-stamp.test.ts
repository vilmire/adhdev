import { describe, expect, it, vi } from 'vitest'

// The routing resolver queries direct-dispatch state via mesh-work-queue / mesh-events-stale.
// Mock both so this stays a pure unit test (no SQLite, no ledger files).
vi.mock('../../src/mesh/mesh-work-queue.js', () => ({
  getActiveDirectDispatches: vi.fn(() => [] as any[]),
}))
vi.mock('../../src/mesh/mesh-events-stale.js', () => ({
  hasUnterminalDirectDispatchLedgerEntry: vi.fn(() => false),
}))
vi.mock('../../src/mesh/mesh-ledger.js', () => ({
  appendLedgerEntry: vi.fn(),
  readLedgerEntries: vi.fn(() => [] as any[]),
}))

import { buildMeshWorkerRelayStamp } from '../../src/mesh/mesh-events-utils.js'
import { resolveWorkerDelegateRouting } from '../../src/mesh/mesh-routing.js'

const MESH = {
  id: 'mesh_remote',
  nodes: [{ id: 'node_worker', workspace: '/repo/worktree-worker' }],
}

const deps = {
  getMeshById: (id: string) => (id === 'mesh_remote' ? MESH : undefined),
  getMeshByWorkspace: (ws: string) => (ws === '/repo/worktree-worker' ? MESH : undefined),
}

function componentsForSettings(settings: Record<string, unknown>) {
  const state = {
    instanceId: 'worker-session',
    workspace: '/repo/worktree-worker',
    settings,
  }
  return {
    instanceManager: {
      getInstance: (id: string) => (id === 'worker-session' ? { category: 'cli', getState: () => state } : undefined),
    },
  } as any
}

describe('buildMeshWorkerRelayStamp', () => {
  it('stamps meshNodeFor + meshNodeId + meshCoordinatorDaemonId from a remote dispatch meshContext', () => {
    const stamp = buildMeshWorkerRelayStamp(
      {},
      { meshId: 'mesh_remote', nodeId: 'node_worker', coordinatorDaemonId: 'daemon_mach_coordinator' },
    )
    expect(stamp).toEqual({
      meshNodeFor: 'mesh_remote',
      meshNodeId: 'node_worker',
      meshCoordinatorDaemonId: 'daemon_mach_coordinator',
      launchedByCoordinator: true,
    })
  })

  it('only fills the coordinator anchor when the session already carries node identity', () => {
    const stamp = buildMeshWorkerRelayStamp(
      { meshNodeFor: 'mesh_remote', meshNodeId: 'node_worker', launchedByCoordinator: true },
      { meshId: 'mesh_remote', nodeId: 'node_worker', coordinatorDaemonId: 'daemon_mach_coordinator' },
    )
    // The relay-safety gap was a missing coordinator anchor — stamp only that.
    expect(stamp).toEqual({ meshCoordinatorDaemonId: 'daemon_mach_coordinator' })
  })

  it('returns undefined (no-op) when the session is already fully relay-safe', () => {
    const stamp = buildMeshWorkerRelayStamp(
      {
        meshNodeFor: 'mesh_remote',
        meshNodeId: 'node_worker',
        meshCoordinatorDaemonId: 'daemon_mach_coordinator',
        launchedByCoordinator: true,
      },
      { meshId: 'mesh_remote', nodeId: 'node_worker', coordinatorDaemonId: 'daemon_mach_coordinator' },
    )
    expect(stamp).toBeUndefined()
  })

  it('returns undefined when there is no meshContext to stamp from', () => {
    expect(buildMeshWorkerRelayStamp({}, undefined)).toBeUndefined()
  })

  it('does not overwrite an existing coordinator anchor with a different value', () => {
    const stamp = buildMeshWorkerRelayStamp(
      { meshCoordinatorDaemonId: 'daemon_existing' },
      { coordinatorDaemonId: 'daemon_other' },
    )
    // launchedByCoordinator is added (proof of delegation) but the anchor is preserved.
    expect(stamp).toEqual({ launchedByCoordinator: true })
  })
})

describe('relay-safe stamp → forwarder picks a remote coordinator target', () => {
  it('a session stamped from a remote dispatch resolves a coordinatorDaemonId routing anchor', () => {
    // Simulate the worker daemon applying the stamp at dispatch time, then a completion
    // event running through the single routing authority the forwarder consumes.
    const stamp = buildMeshWorkerRelayStamp(
      {},
      { meshId: 'mesh_remote', nodeId: 'node_worker', coordinatorDaemonId: 'daemon_mach_coordinator' },
    )!
    const routing = resolveWorkerDelegateRouting(
      componentsForSettings({ ...stamp }),
      'worker-session',
      deps,
    )
    expect(routing.isDelegate).toBe(true)
    expect(routing.meshId).toBe('mesh_remote')
    expect(routing.nodeId).toBe('node_worker')
    // This is the anchor injectMeshSystemMessage keys on to forward to the REMOTE
    // coordinator daemon proactively (instead of dropping the event into the pending
    // queue until a read_chat reconcile).
    expect(routing.coordinatorDaemonId).toBe('daemon_mach_coordinator')
  })

  it('without the coordinator anchor the resolver yields no routing target (the pre-fix state)', () => {
    const routing = resolveWorkerDelegateRouting(
      // meshNodeFor present (delegate) but NO meshCoordinatorDaemonId — the relay-unsafe case.
      componentsForSettings({ meshNodeFor: 'mesh_remote', meshNodeId: 'node_worker', launchedByCoordinator: true }),
      'worker-session',
      deps,
    )
    expect(routing.isDelegate).toBe(true)
    // No anchor → injectMeshSystemMessage cannot pick a remote coordinator target and
    // falls back to the pending queue (drained only on reconcile). The fix ensures the
    // anchor is present so this branch is not taken for remote workers.
    expect(routing.coordinatorDaemonId).toBe('')
  })
})
