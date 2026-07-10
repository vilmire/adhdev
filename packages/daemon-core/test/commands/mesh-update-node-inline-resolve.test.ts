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
 * Regression: NODE-SLOTS-REMOTE-WRITE.
 *
 * update_mesh_node's write applied ONLY through updateNode(), which reads this
 * daemon's local meshes.json. When the command is forwarded to a node's
 * home-daemon that has NO local config entry for a coordinator-owned mesh (a
 * remote member daemon, or a cloud coordinator that holds the mesh solely in its
 * inline cache), updateNode returned undefined and the write failed with
 * "Mesh node not found" — even though the coordinator attached the mesh snapshot
 * as inlineMesh, and the read paths (get_mesh / mesh_node_slots dry-run / list)
 * resolve that same node fine via getMeshForCommand's inline-cache fallback.
 *
 * Fix: when updateNode misses, resolve the mesh through the inline cache (exactly
 * as the read paths do) and apply the same field semantics to the inline node.
 * A config-backed local node keeps taking the updateNode path unchanged.
 */
describe('update_mesh_node inline-cache node resolution', () => {
  it('writes policy.slots to an inline-only remote node via the inlineMesh fallback', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-update-inline-only-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { getMesh } = await import('../../src/config/mesh-config.js')
      const { router } = createRouter()

      // Inline-only mesh: NEVER created in meshes.json (mirrors a remote member
      // daemon that only ever received the coordinator's inline snapshot). The node
      // carries a foreign daemonId + cachedStatus so the inline cache is warmed as
      // AUTHORITATIVE (coordinator_inline_mesh_cache), the exact source the write
      // path failed to resolve before the fix.
      const meshId = 'mesh_inline_slots_1'
      const nodeId = 'node_inline_remote'
      const inlineMesh = {
        id: meshId,
        name: 'Inline Slots',
        repoIdentity: 'github.com/acme/inline-slots',
        defaultBranch: 'main',
        policy: {},
        nodes: [
          { id: nodeId, daemonId: 'daemon-remote', workspace: '/tmp/inline-remote', repoRoot: '/tmp/inline-remote', policy: {}, cachedStatus: { health: 'online' } },
        ],
      }

      // Warm the inline cache and confirm membership resolves inline (not local config).
      await router.execute('get_mesh', { meshId, inlineMesh })
      const warmed = await router.execute('get_mesh', { meshId, inlineMesh }) as any
      expect(warmed.sourceOfTruth.membership).toBe('coordinator_inline_mesh_cache')

      // Precondition: this mesh is genuinely absent from local config.
      expect(getMesh(meshId)).toBeUndefined()

      const proposedSlots = [
        { provider: 'claude-cli', model: 'opus', thinking: 'high' },
        { provider: 'codex-cli', model: 'gpt-5' },
      ]

      // The failing case: a remote-node policy write. Before the fix this returned
      // { success:false, error:'Mesh node not found' }.
      const result = await router.execute('update_mesh_node', {
        meshId,
        nodeId,
        policy: { slots: proposedSlots },
        inlineMesh,
      }) as any

      expect(result.success).toBe(true)
      expect(result.node?.policy?.slots).toEqual(proposedSlots)

      // The write must persist into the inline cache so a subsequent read (and the
      // coordinator's slot-fitness routing off the same view) sees the new slots.
      const afterRead = await router.execute('get_mesh', { meshId, inlineMesh: undefined }) as any
      expect(afterRead.success).toBe(true)
      const afterNode = afterRead.mesh?.nodes?.find((n: any) => n.id === nodeId)
      expect(afterNode?.policy?.slots).toEqual(proposedSlots)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('still writes a config-backed local node through updateNode (no regression)', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-update-local-config-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Local Slots', repoIdentity: 'github.com/acme/local-slots', defaultBranch: 'main' })
      const node = addNode(mesh.id, { workspace: '/tmp/local-slots-workspace', repoRoot: '/tmp/local-slots-workspace', daemonId: 'daemon-remote' })
      expect(node?.id).toBeTruthy()
      const nodeId = node!.id

      const { router } = createRouter()

      const proposedSlots = [{ provider: 'claude-cli', model: 'sonnet' }]

      // No inlineMesh: the local-config node must resolve + persist through updateNode.
      const result = await router.execute('update_mesh_node', {
        meshId: mesh.id,
        nodeId,
        policy: { slots: proposedSlots },
      }) as any

      expect(result.success).toBe(true)
      expect(result.node?.policy?.slots).toEqual(proposedSlots)

      // Must be persisted to meshes.json (getMesh reloads fresh from disk each call).
      const afterMesh = getMesh(mesh.id)
      const afterNode = afterMesh?.nodes?.find((n: any) => n.id === nodeId)
      expect(afterNode?.policy?.slots).toEqual(proposedSlots)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
