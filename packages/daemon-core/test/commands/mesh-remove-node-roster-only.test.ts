import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonCommandRouter } from '../../src/commands/router'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'

function createRouter() {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    statusInstanceId: 'daemon-local',
  })
}

afterEach(resetMeshRuntimeStore)

describe('remove_mesh_node rosterOnly preserves worktrees and sessions', () => {
  it('drops membership and does not report a worktree cleanup', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-remove-roster-only-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({ name: 'Roster Only', repoIdentity: 'github.com/acme/roster-only', defaultBranch: 'main' })
      addNode(mesh.id, { workspace: '/tmp/roster-base', repoRoot: '/tmp/roster-base', daemonId: 'daemon-local' })
      const worktree = addNode(mesh.id, {
        workspace: '/tmp/roster-worktree-must-remain',
        repoRoot: '/tmp/roster-base',
        daemonId: 'daemon-remote',
        isLocalWorktree: true,
      })
      const router = createRouter()
      const result = await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId: worktree!.id,
        rosterOnly: true,
        sessionCleanupMode: 'preserve',
      }) as any
      expect(result.success).toBe(true)
      expect(result.removed).toBe(true)
      expect(result.rosterOnly).toBe(true)
      expect(result.worktreePreserved).toBe(true)
      expect(result.worktreeCleanup).toBeUndefined()
      expect(result.sessionCleanup).toBeUndefined()
      expect(getMesh(mesh.id)?.nodes.some(node => node.id === worktree!.id)).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
