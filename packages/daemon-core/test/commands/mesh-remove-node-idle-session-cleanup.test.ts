import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonCommandRouter } from '../../src/commands/router'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

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

/**
 * CLAIM-RETRY-LOOP-LIFECYCLE regression (M-MESH-INFRA-0829 defect 5, evidence 4).
 *
 * deleteRemoteIdleSession only ever fires on a SUCCESSFUL claim
 * (mesh-queue-assignment.ts assignIdleCandidate) — a node removed while its
 * registered remote-idle session was never actually claimed (e.g. its worktree
 * bootstrap never reached a terminal state) left that row behind forever. The
 * ~4s auto-launch drain (getRemoteIdleSessions) kept matching it against a node
 * that no longer exists in the mesh and re-running the claim gate for it. This
 * pins remove_mesh_node purging any remote_idle_sessions rows for the removed node.
 */
describe('remove_mesh_node purges remote_idle_sessions for the removed node', () => {
  it('deletes the node\'s remote idle session row on successful removal', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-remove-idle-cleanup-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Remove Idle Cleanup Mesh', repoIdentity: 'github.com/acme/remove-idle-cleanup', defaultBranch: 'main' })
      addNode(mesh.id, { workspace: '/tmp/ric-base', repoRoot: '/tmp/ric-base', daemonId: 'daemon-local' })
      // A plain (non-worktree) node owned by a different machine — removable
      // without force and without touching real git worktrees.
      const otherNode = addNode(mesh.id, { workspace: '/tmp/ric-other', repoRoot: '/tmp/ric-other', daemonId: 'daemon-other' })
      expect(otherNode?.id).toBeTruthy()

      const store = MeshRuntimeStore.getInstance()
      store.setRemoteIdleSession(mesh.id, otherNode!.id, 'sess-stuck', 'claude-cli', Date.now() + 60_000)
      expect(store.getRemoteIdleSessions(mesh.id).map(s => s.sessionId)).toEqual(['sess-stuck'])

      const router = createRouter()
      const result = await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId: otherNode!.id,
      }) as any

      expect(result.success).toBe(true)
      expect(result.removed).not.toBe(false)
      // The stuck remote-idle-session row must not survive node removal — a live
      // auto-launch drain tick must never match it against the now-gone node.
      expect(store.getRemoteIdleSessions(mesh.id)).toEqual([])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
