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
 * A mesh this daemon holds in meshes.json can ALSO have a snapshot in the inline
 * cache (a coordinator pushes one with every inlineMesh-carrying command), and
 * get_mesh / the launch path read that cache first. update_mesh_node wrote only
 * meshes.json, so mesh_node_slots set reported success while the very next
 * mesh_launch_session — resolved through get_mesh — still saw the old slots and
 * refused the new provider (2026-10-05 provider matrix: claude→kimi/grok/agy).
 */
describe('update_mesh_node keeps the inline cache coherent with meshes.json', () => {
  it('a slots write is visible to the next get_mesh membership read', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-update-inline-coherence-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({ name: 'Coherence', repoIdentity: 'github.com/acme/coherence', defaultBranch: 'main' })
      const node = addNode(mesh.id, {
        workspace: '/tmp/coherence-ws',
        repoRoot: '/tmp/coherence-ws',
        policy: { slots: [{ provider: 'claude-cli' }] },
      } as any)
      const nodeId = node!.id
      const { router } = createRouter()

      // A coordinator command carried the mesh snapshot → it now sits in the inline cache.
      const snapshot: any = JSON.parse(JSON.stringify(getMesh(mesh.id)))
      for (const n of snapshot.nodes) n.cachedStatus = { health: 'online' }
      await router.execute('get_mesh', { meshId: mesh.id, inlineMesh: snapshot })
      const warmed = await router.execute('get_mesh', { meshId: mesh.id, membershipOnly: true }) as any
      expect(warmed.mesh.nodes.find((n: any) => n.id === nodeId)?.policy?.slots?.length).toBe(1)

      const write = await router.execute('update_mesh_node', {
        meshId: mesh.id,
        nodeId,
        policy: { slots: [{ provider: 'claude-cli' }, { provider: 'kimi' }] },
      }) as any
      expect(write.success).toBe(true)

      const read = await router.execute('get_mesh', { meshId: mesh.id, membershipOnly: true }) as any
      const slots = read.mesh.nodes.find((n: any) => n.id === nodeId)?.policy?.slots ?? []
      expect(slots.map((s: any) => s.provider)).toEqual(['claude-cli', 'kimi'])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
