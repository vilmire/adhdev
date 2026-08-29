import { describe, expect, it, vi } from 'vitest'
import { DaemonCommandRouter } from '../../src/commands/router.js'

function createRouter() {
  const router = new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: {
      collectAllStates: () => [],
      listInstanceIds: () => [],
      getInstance: () => null,
    } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    statusInstanceId: 'daemon-local',
  })
  return { router }
}

// M-MESH-INFRA-0829 defect 5-b [C]: mesh_remove_node tombstones a removed node id
// (tombstoneRemovedInlineMeshNode) so a stale/replayed inline-mesh echo can't resurrect it.
// Every OTHER inline-cache write path already honors that tombstone (warmInlineMeshCache via
// applyInlineMeshNodeTombstones, getMeshForCommand's reconcile branch) — but updateInlineMeshNode,
// the direct single-node writer used by markWorktreeBootstrapTerminalState's hydrate-on-miss shell
// and seedRemoteClonedWorktreeNode's clone-reply merge, did not. A late/duplicate/replayed
// worktree_bootstrap_complete event or clone-reply for an already-removed remote node's id
// therefore silently reinstated it — the observed "removed node reappears as
// degraded/worktree_path_missing" symptom. These tests pin that both hydrate-on-miss callers now
// respect the tombstone.
describe('M-MESH-INFRA-0829 [C] — updateInlineMeshNode honors removal tombstones', () => {
  const REMOTE_WORKSPACE = '/nonexistent/remote/machine/path/worktree-ghost'

  function seedRemovedRemoteNode(router: DaemonCommandRouter, meshId: string, nodeId: string) {
    const remoteNode = {
      id: nodeId,
      daemonId: 'daemon-remote-owner',
      workspace: REMOTE_WORKSPACE,
      isLocalWorktree: true,
      worktreeBranch: 'feature-x',
      worktreeBootstrap: { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const mesh = { id: meshId, nodes: [remoteNode], updatedAt: new Date().toISOString() }
    const cached = router.getCachedInlineMesh(meshId, mesh)
    expect(cached.nodes.some((n: any) => n.id === nodeId)).toBe(true)
    const removed = router.removeInlineMeshNode(meshId, cached, nodeId)
    expect(removed).toBe(true)
    const afterRemove = router.getCachedInlineMesh(meshId)
    expect(afterRemove.nodes.some((n: any) => n.id === nodeId)).toBe(false)
  }

  it('a late clone-reply (seedRemoteClonedWorktreeNode) cannot resurrect an already-removed node', () => {
    const { router } = createRouter()
    const meshId = 'mesh_ghost_seed'
    const nodeId = 'node_ghost_1'
    seedRemovedRemoteNode(router, meshId, nodeId)

    // Simulate the late/replayed clone-reply arriving AFTER removal.
    router.seedRemoteClonedWorktreeNode(meshId, {
      id: nodeId,
      daemonId: 'daemon-remote-owner',
      workspace: REMOTE_WORKSPACE,
      isLocalWorktree: true,
      worktreeBranch: 'feature-x',
    })

    const afterReplay = router.getCachedInlineMesh(meshId)
    expect(afterReplay.nodes.some((n: any) => n.id === nodeId)).toBe(false)
  })

  it('a late worktree_bootstrap_complete event (hydrate-on-miss) cannot resurrect an already-removed node', () => {
    const { router } = createRouter()
    const meshId = 'mesh_ghost_hydrate'
    const nodeId = 'node_ghost_2'
    seedRemovedRemoteNode(router, meshId, nodeId)

    // Simulate the late/replayed terminal-bootstrap event arriving AFTER removal — this is the
    // hydrate-on-miss branch (the node id is genuinely absent from the cache post-removal).
    router.markWorktreeBootstrapTerminalState(meshId, nodeId, 'complete', { workspace: REMOTE_WORKSPACE })

    const afterReplay = router.getCachedInlineMesh(meshId)
    expect(afterReplay.nodes.some((n: any) => n.id === nodeId)).toBe(false)
  })

  it('a genuine re-registration (workspace really exists again) still clears the tombstone and merges', () => {
    const { router } = createRouter()
    const meshId = 'mesh_ghost_genuine'
    const nodeId = 'node_ghost_3'
    // Use a workspace that DOES exist locally (the coordinator's own tmp/cwd) so the
    // clearing branch fires — mirrors the LOCAL re-registration case the tombstone
    // design already accommodates.
    const localWorkspace = process.cwd()
    const localNode = {
      id: nodeId,
      daemonId: 'daemon-local',
      workspace: localWorkspace,
      isLocalWorktree: true,
    }
    const mesh = { id: meshId, nodes: [localNode], updatedAt: new Date().toISOString() }
    const cached = router.getCachedInlineMesh(meshId, mesh)
    expect(router.removeInlineMeshNode(meshId, cached, nodeId)).toBe(true)

    router.seedRemoteClonedWorktreeNode(meshId, { ...localNode })

    const afterReplay = router.getCachedInlineMesh(meshId)
    expect(afterReplay.nodes.some((n: any) => n.id === nodeId)).toBe(true)
  })
})
