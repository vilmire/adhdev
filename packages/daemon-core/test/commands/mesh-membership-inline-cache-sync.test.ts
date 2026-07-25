import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonCommandRouter } from '../../src/commands/router'

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

afterEach(resetMeshRuntimeStore)

/**
 * Regression: MESH-MEMBERSHIP-INLINE-CACHE-SYNC.
 *
 * A node added to a mesh (e.g. via the dashboard's "Add Node" P2P command)
 * was persisted to meshes.json by add_mesh_node, but never pushed into the
 * router's in-memory inlineMeshCache. Once ANYTHING warms that cache for a
 * meshId (a cloud coordinator launch with inlineMesh is the common trigger),
 * getMeshForCommand's inline-cache-preferred read serves ONLY the cache —
 * so the newly added node stayed invisible to get_mesh/mesh_status until the
 * daemon restarted and the cache was re-populated fresh from disk.
 */
describe('add_mesh_node / remove_mesh_node keep the inline-mesh cache in sync', () => {
  it('a node added after the cache is warmed is immediately visible via get_mesh (no restart)', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-add-inline-sync-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Add Sync Mesh', repoIdentity: 'github.com/acme/add-sync-mesh', defaultBranch: 'main' })
      const baseNode = addNode(mesh.id, { workspace: '/tmp/add-sync-base', repoRoot: '/tmp/add-sync-base', daemonId: 'daemon-local' })
      expect(baseNode?.id).toBeTruthy()

      const { router } = createRouter()

      // Warm the inline cache for this mesh the same way a cloud coordinator
      // launch does (mesh-coordinator-launch.ts sets it via inlineMesh), so
      // subsequent get_mesh/mesh_status reads resolve from the cache instead
      // of falling back to local_config.
      const inlineMesh = {
        id: mesh.id,
        name: mesh.name,
        repoIdentity: mesh.repoIdentity,
        defaultBranch: 'main',
        policy: {},
        nodes: [
          // cachedStatus is transient node truth — required for getMeshForCommand
          // to treat this inlineMesh as authoritative and warm the cache (see
          // inlineMeshCarriesTransientNodeTruth).
          { id: baseNode!.id, daemonId: 'daemon-local', workspace: '/tmp/add-sync-base', repoRoot: '/tmp/add-sync-base', policy: {}, cachedStatus: { health: 'online' } },
        ],
      }
      await router.execute('get_mesh', { meshId: mesh.id, inlineMesh })
      const warmed = await router.execute('get_mesh', { meshId: mesh.id, inlineMesh }) as any
      expect(warmed.success).toBe(true)
      expect(warmed.sourceOfTruth.membership).toBe('coordinator_inline_mesh_cache')

      // Add a second node WITHOUT re-echoing an inlineMesh payload — this is
      // the dashboard "Add Node" P2P command, which calls add_mesh_node
      // directly against this same coordinator daemon.
      const added = await router.execute('add_mesh_node', {
        meshId: mesh.id,
        workspace: '/tmp/add-sync-new-node',
        daemonId: 'daemon-remote-new',
      }) as any
      expect(added.success).toBe(true)
      const newNodeId = added.node.id
      expect(newNodeId).toBeTruthy()

      // The core assertion: a read immediately after add (same process, no
      // restart) must see the new node. Before the fix this returned only the
      // stale cached snapshot (base node only).
      const after = await router.execute('get_mesh', { meshId: mesh.id }) as any
      expect(after.success).toBe(true)
      const nodeIds = (after.mesh?.nodes ?? []).map((n: any) => n.id ?? n.nodeId)
      expect(nodeIds).toContain(baseNode!.id)
      expect(nodeIds).toContain(newNodeId)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('a node removed while resolved via local_config (not yet inline-cached) is spliced from a cache warmed afterward', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-remove-inline-sync-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Remove Sync Mesh', repoIdentity: 'github.com/acme/remove-sync-mesh', defaultBranch: 'main' })
      const baseNode = addNode(mesh.id, { workspace: '/tmp/remove-sync-base', repoRoot: '/tmp/remove-sync-base', daemonId: 'daemon-local' })
      const extraNode = addNode(mesh.id, { workspace: '/tmp/remove-sync-extra', repoRoot: '/tmp/remove-sync-extra', daemonId: 'daemon-remote' })
      expect(baseNode?.id).toBeTruthy()
      expect(extraNode?.id).toBeTruthy()

      const { router } = createRouter()

      // No inlineMesh yet: resolves purely from local_config. remove_mesh_node
      // must delete via removeNode() AND (the fix) splice the node out of any
      // inline cache entry, in case one gets warmed afterward from a stale
      // pre-removal snapshot (e.g. a dashboard echo still in flight).
      const removed = await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId: extraNode!.id,
        daemonId: 'daemon-remote',
        force: true,
      }) as any
      expect(removed.success).toBe(true)
      expect(removed.removed).toBe(true)
      expect(getMesh(mesh.id)?.nodes?.some((n: any) => n.id === extraNode!.id)).toBe(false)

      // Now warm the cache from a stale snapshot that still carries the
      // removed node (simulating a dashboard echo built before the removal
      // landed). The tombstone recorded by removeInlineMeshNode must keep it
      // out even though the incoming payload re-asserts it.
      const staleInlineMesh = {
        id: mesh.id,
        name: mesh.name,
        repoIdentity: mesh.repoIdentity,
        defaultBranch: 'main',
        policy: {},
        nodes: [
          { id: baseNode!.id, daemonId: 'daemon-local', workspace: '/tmp/remove-sync-base', repoRoot: '/tmp/remove-sync-base', policy: {} },
          { id: extraNode!.id, daemonId: 'daemon-remote', workspace: '/tmp/remove-sync-extra', repoRoot: '/tmp/remove-sync-extra', policy: {} },
        ],
      }
      const afterEcho = await router.execute('get_mesh', { meshId: mesh.id, inlineMesh: staleInlineMesh }) as any
      expect(afterEcho.success).toBe(true)
      const echoedIds = (afterEcho.mesh?.nodes ?? []).map((n: any) => n.id ?? n.nodeId)
      expect(echoedIds).toContain(baseNode!.id)
      expect(echoedIds).not.toContain(extraNode!.id)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
