import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { DaemonCommandRouter } from '../../src/commands/router'

afterEach(resetMeshRuntimeStore)

/**
 * REMOTE-CLONE-CACHE-SEED regression — call-site coverage for the REMOTE forward branch of
 * clone_mesh_node.
 *
 * mesh-clone-node-registration.test.ts covers the LOCAL clone branch (source node on this
 * machine). The remote-forward branch — source node on ANOTHER machine, so the clone is
 * dispatched to that daemon — had no coverage, which is how this shipped: the coordinator
 * forwarded the clone, returned the reply, and never wrote the resulting node into its own
 * inline cache. Read tools still showed the node (they actively refresh / fan out over P2P),
 * but the queue scheduler is a passive cache reader, so the node was permanently unschedulable
 * (`target_node_id_unmatched` / `no_node_satisfies_required_tags`). Reflection depended solely
 * on a one-shot `worktree_bootstrap_complete` push with no retry or periodic resync.
 */
describe('clone_mesh_node — remote forward seeds the coordinator inline cache', () => {
  async function setup() {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-clone-remote-forward-config-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = configDir

    const meshId = 'mesh_remote_forward'
    const remoteNodeId = 'node_remote_worktree'
    // The reply a REMOTE daemon returns: the full node it registered, carrying the
    // scheduling identity the coordinator cannot reconstruct on its own.
    const remoteReplyNode = {
      id: remoteNodeId,
      workspace: '/remote/wt/feature-x',
      repoRoot: '/remote/wt/feature-x',
      daemonId: 'daemon-remote',
      machineId: 'machine-remote',
      userOverrides: {},
      policy: { providerPriority: ['claude'] },
      isLocalWorktree: true,
      worktreeBranch: 'feature-x',
      clonedFromNodeId: 'node_base',
      worktreeBootstrap: { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
    }

    const dispatchMeshCommand = vi.fn(async () => ({
      success: true,
      async: true,
      status: 'accepted',
      node: remoteReplyNode,
      worktreePath: remoteReplyNode.workspace,
      branch: 'feature-x',
      worktreeBootstrap: remoteReplyNode.worktreeBootstrap,
    }))

    const router: any = new DaemonCommandRouter({
      commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
      cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
      cdpManagers: new Map(),
      providerLoader: {} as any,
      instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
      detectedIdes: { value: [] },
      sessionRegistry: {} as any,
      sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
      // This coordinator is NOT the source node's machine → clone must forward.
      statusInstanceId: 'daemon-coordinator',
      dispatchMeshCommand,
    })

    // Coordinator's authoritative inline mesh: base node lives on the REMOTE machine.
    const inlineMesh = {
      id: meshId,
      name: 'remote-mesh',
      nodes: [{
        id: 'node_base',
        workspace: '/remote/main',
        repoRoot: '/remote/main',
        daemonId: 'daemon-remote',
        machineId: 'machine-remote',
        // transient node truth → the inline snapshot is treated as authoritative
        health: 'healthy',
        cachedStatus: { health: 'healthy' },
        policy: { providerPriority: ['claude'] },
      }],
      policy: {},
    }

    const restore = () => {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
    }
    return { router, meshId, remoteNodeId, inlineMesh, dispatchMeshCommand, restore }
  }

  it('registers the remotely-cloned node (with full scheduling identity) in the local inline cache', async () => {
    const { router, meshId, remoteNodeId, inlineMesh, dispatchMeshCommand, restore } = await setup()
    try {
      const result = await router.execute('clone_mesh_node', {
        meshId,
        sourceNodeId: 'node_base',
        branch: 'feature-x',
        inlineMesh,
      })

      expect(result?.success).toBe(true)
      // The clone was genuinely forwarded to the remote daemon.
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
      expect(dispatchMeshCommand.mock.calls[0][0]).toBe('daemon-remote')

      // ...and the coordinator now holds the node itself — no bootstrap event required.
      const cached = router.getCachedInlineMesh(meshId)
      const seeded = (cached?.nodes || []).find(
        (n: any) => n.id === remoteNodeId || n.nodeId === remoteNodeId,
      )
      expect(seeded).toBeTruthy()
      // Fields the passive scheduler needs. daemonId/machineId especially: with NEITHER,
      // isLocalAutoLaunchNode treats the node as LOCAL and the coordinator would try to
      // auto-launch a remote worktree session on its own machine.
      expect(seeded.daemonId).toBe('daemon-remote')
      expect(seeded.machineId).toBe('machine-remote')
      expect(seeded.workspace).toBe('/remote/wt/feature-x')
      expect(seeded.worktreeBranch).toBe('feature-x')
      expect(seeded.isLocalWorktree).toBe(true)
      expect(seeded.policy?.providerPriority).toEqual(['claude'])

      // The base node is untouched.
      expect((cached?.nodes || []).find((n: any) => n.id === 'node_base')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('the seeded node survives a later bootstrap-complete event and ends up gate-open', async () => {
    const { router, meshId, remoteNodeId, inlineMesh, restore } = await setup()
    try {
      await router.execute('clone_mesh_node', {
        meshId,
        sourceNodeId: 'node_base',
        branch: 'feature-x',
        inlineMesh,
      })

      // worktree_bootstrap_complete arrives afterwards from the remote machine.
      router.markWorktreeBootstrapTerminalState(meshId, remoteNodeId, 'complete', {
        workspace: '/remote/wt/feature-x',
      })

      const cached = router.getCachedInlineMesh(meshId)
      const node = (cached?.nodes || []).find(
        (n: any) => n.id === remoteNodeId || n.nodeId === remoteNodeId,
      )
      // Gate open (shouldDeferDispatchForBootstrap no longer defers)...
      expect(node.worktreeBootstrap?.status).toBe('complete')
      // ...with the scheduling identity intact (the event's hydrate shell did not replace it).
      expect(node.daemonId).toBe('daemon-remote')
      expect(node.policy?.providerPriority).toEqual(['claude'])
      // No duplicate entry.
      expect((cached?.nodes || []).filter(
        (n: any) => n.id === remoteNodeId || n.nodeId === remoteNodeId,
      ).length).toBe(1)
    } finally {
      restore()
    }
  })
})
