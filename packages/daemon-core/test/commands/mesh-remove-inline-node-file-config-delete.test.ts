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

// Close the process-wide mesh runtime sqlite store after each test so an open
// handle can't EBUSY the next test's temp-dir removal on win32.
afterEach(resetMeshRuntimeStore)

/**
 * Regression: MESH-INLINE-NODE-RESURRECTION.
 *
 * remove_mesh_node's inline-cache branch calls removeInlineMeshNode, which only
 * mutates the in-memory inlineMeshCache + tombstones — it never touched the
 * file-backed mesh config (meshes.json). When the SAME node lives in BOTH the
 * inline cache AND meshes.json (a worktree/base node that was persisted to the
 * file config, then resolved through the inline cache on removal), the file
 * record survived. On daemon restart the in-memory tombstone was lost, getMesh
 * fell back to the file config, and mesh-status rendered the dead node again —
 * the removed node "resurrected" on every restart.
 *
 * Fix: the inline branch also splices+saves the matching node from the file
 * config, so a node present in both is removed from both. Pure-inline meshes
 * (no matching file mesh/node) are untouched.
 */
describe('remove_mesh_node inline branch <-> file-backed config deletion', () => {
  it('deletes the node from meshes.json when it exists in BOTH the inline cache and the file config', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-remove-inline-file-config-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      // Config-backed mesh + a node persisted to meshes.json. Give the node a
      // daemonId that is NOT this coordinator so the base-node guard doesn't fire
      // (and pass force:true below for good measure). Not a worktree node, so the
      // removal skips the worktree-cleanup path.
      const mesh = createMesh({ name: 'Remove Mesh', repoIdentity: 'github.com/acme/remove-mesh', defaultBranch: 'main' })
      const node = addNode(mesh.id, { workspace: '/tmp/remove-mesh-workspace', repoRoot: '/tmp/remove-mesh-workspace', daemonId: 'daemon-remote' })
      expect(node?.id).toBeTruthy()
      const nodeId = node!.id

      // Precondition: the node IS in the file config.
      expect(getMesh(mesh.id)?.nodes?.some((n: any) => n.id === nodeId)).toBe(true)

      const { router } = createRouter()

      // Inline snapshot carrying transient node truth (cachedStatus) so the daemon
      // warms an AUTHORITATIVE inline cache — this is what forces remove_mesh_node
      // to take the inline-cache branch instead of the local-config branch. The
      // node id matches the file-config node exactly, so it lives in BOTH stores.
      const inlineMesh = {
        id: mesh.id,
        name: mesh.name,
        repoIdentity: mesh.repoIdentity,
        defaultBranch: 'main',
        policy: {},
        nodes: [
          { id: nodeId, daemonId: 'daemon-remote', workspace: '/tmp/remove-mesh-workspace', repoRoot: '/tmp/remove-mesh-workspace', policy: {}, cachedStatus: { health: 'online' } },
        ],
      }

      // Warm the inline cache and confirm membership resolves to an inline source
      // (not local_mesh_config) — the precondition that drove the resurrection bug.
      const warmed = await router.execute('get_mesh', { meshId: mesh.id, inlineMesh }) as any
      expect(warmed.success).toBe(true)
      const warmedAgain = await router.execute('get_mesh', { meshId: mesh.id, inlineMesh }) as any
      expect(warmedAgain.sourceOfTruth.membership).toBe('coordinator_inline_mesh_cache')

      // Remove through the inline-cache branch.
      const removed = await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId,
        inlineMesh,
        force: true,
      }) as any
      expect(removed.success).toBe(true)
      expect(removed.removed).not.toBe(false)

      // The core assertion: the node must be GONE from the file-backed config.
      // Re-read meshes.json from disk (getMesh loads fresh from disk each call) —
      // this simulates the post-restart read that previously resurrected the node.
      const afterMesh = getMesh(mesh.id)
      expect(afterMesh).toBeTruthy()
      expect(afterMesh?.nodes?.some((n: any) => n.id === nodeId)).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('does not throw for a pure-inline mesh with no matching file config', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-remove-inline-only-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { router } = createRouter()

      // Inline-only mesh: never created in meshes.json. cachedStatus makes it
      // authoritative inline. A second node stays so the mesh still exists after
      // the removal (removing the last node is fine too, but this keeps it simple).
      const meshId = 'mesh_inline_only_1'
      const inlineMesh = {
        id: meshId,
        name: 'Inline Only',
        repoIdentity: 'github.com/acme/inline-only',
        defaultBranch: 'main',
        policy: {},
        nodes: [
          { id: 'node_inline_a', daemonId: 'daemon-remote', workspace: '/tmp/inline-a', repoRoot: '/tmp/inline-a', policy: {}, cachedStatus: { health: 'online' } },
          { id: 'node_inline_b', daemonId: 'daemon-remote', workspace: '/tmp/inline-b', repoRoot: '/tmp/inline-b', policy: {}, cachedStatus: { health: 'online' } },
        ],
      }

      // Warm the inline cache.
      await router.execute('get_mesh', { meshId, inlineMesh })
      const warmedAgain = await router.execute('get_mesh', { meshId, inlineMesh }) as any
      expect(warmedAgain.sourceOfTruth.membership).toBe('coordinator_inline_mesh_cache')

      // Remove a pure-inline node — the file-config delete must be a no-op (getMesh
      // returns undefined), not a throw.
      const removed = await router.execute('remove_mesh_node', {
        meshId,
        nodeId: 'node_inline_a',
        inlineMesh,
        force: true,
      }) as any
      expect(removed.success).toBe(true)
      expect(removed.removed).not.toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
