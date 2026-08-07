import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonCommandRouter } from '../../src/commands/router'

function createRouter(dispatchMeshCommand: any) {
  return new DaemonCommandRouter({
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
    dispatchMeshCommand,
  } as any)
}

afterEach(resetMeshRuntimeStore)

/**
 * Regression: MESH-REMOTE-REMOVE-MEMBERSHIP-DESYNC.
 *
 * remove_mesh_node on a worktree node owned by ANOTHER daemon forwards the
 * removal to that daemon and used to `return` the forwarded response directly.
 * That early return skipped the shared membership block — removeNode /
 * removeInlineMeshNode, the ledger append, and invalidateAggregateMeshStatus.
 *
 * The remote daemon correctly fixed ITS OWN meshes.json, but the coordinator's
 * independent membership copy was never touched, so the node reappeared on the
 * very next mesh_status read. Any in-memory splice a caller applied on top
 * (mcp-server's optimistic one in mesh-tools-git.ts) was silently undone by the
 * next read from the untouched persistent layer.
 *
 * These tests pin BOTH directions: a successful forward must reconcile the
 * coordinator's membership, and a FAILED forward must leave it strictly alone
 * (the node is still alive on the owning machine; hiding it would strand it).
 */
describe('remove_mesh_node reconciles coordinator membership after a remote-forwarded removal', () => {
  it('splices the node from the coordinator meshes.json when the owning daemon reports success', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-remote-remove-sync-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Remote Remove Mesh', repoIdentity: 'github.com/acme/remote-remove', defaultBranch: 'main' })
      addNode(mesh.id, { workspace: '/tmp/rr-base', repoRoot: '/tmp/rr-base', daemonId: 'daemon-local' })

      // The worktree node is owned by a DIFFERENT daemon, so removal forwards.
      const remoteNode = addNode(mesh.id, {
        workspace: '/tmp/rr-worktree',
        repoRoot: '/tmp/rr-base',
        daemonId: 'daemon-remote',
        isLocalWorktree: true,
        worktreeBranch: 'feat/remote',
      } as any)
      expect(remoteNode?.id).toBeTruthy()

      // The owning daemon runs this same handler and reports a clean removal.
      const dispatchMeshCommand = vi.fn(async () => ({
        success: true,
        removed: true,
        worktreeCleanup: { success: true },
      }))

      const router = createRouter(dispatchMeshCommand)
      const result = await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId: remoteNode!.id,
      }) as any

      // It really did forward rather than removing the remote worktree locally.
      expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
      expect(dispatchMeshCommand.mock.calls[0][0]).toBe('daemon-remote')
      expect(dispatchMeshCommand.mock.calls[0][1]).toBe('remove_mesh_node')
      // Guard against an infinite forward loop between the two daemons.
      expect((dispatchMeshCommand.mock.calls[0][2] as any)._meshDirectDispatch).toBe(true)

      expect(result.success).toBe(true)
      expect(result.removed).toBe(true)

      // THE ASSERTION THAT FAILS WITHOUT THE FIX: the coordinator's own
      // persisted membership no longer lists the node. Before the fix the early
      // return left this record intact and the node resurrected on next read.
      const persisted = getMesh(mesh.id)
      const stillPresent = (persisted?.nodes ?? []).some((n: any) => n.id === remoteNode!.id)
      expect(stillPresent).toBe(false)
      expect((persisted?.nodes ?? []).length).toBe(1)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('does NOT splice the node when the owning daemon reports failure', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-remote-remove-fail-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Remote Remove Fail Mesh', repoIdentity: 'github.com/acme/remote-remove-fail', defaultBranch: 'main' })
      addNode(mesh.id, { workspace: '/tmp/rrf-base', repoRoot: '/tmp/rrf-base', daemonId: 'daemon-local' })

      const remoteNode = addNode(mesh.id, {
        workspace: '/tmp/rrf-worktree',
        repoRoot: '/tmp/rrf-base',
        daemonId: 'daemon-remote',
        isLocalWorktree: true,
        worktreeBranch: 'feat/remote-fail',
      } as any)

      // The owning daemon refuses — e.g. the worktree has uncommitted changes.
      // The node is still alive over there, so the coordinator must keep it.
      const dispatchMeshCommand = vi.fn(async () => ({
        success: false,
        removed: false,
        code: 'worktree_dirty',
        error: 'Worktree has uncommitted changes',
      }))

      const router = createRouter(dispatchMeshCommand)
      const result = await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId: remoteNode!.id,
      }) as any

      expect(result.success).toBe(false)
      expect(result.code).toBe('worktree_dirty')

      // Membership is untouched: hiding a node that still exists remotely would
      // strand it, since the operator loses the handle needed to retry.
      const persisted = getMesh(mesh.id)
      const stillPresent = (persisted?.nodes ?? []).some((n: any) => n.id === remoteNode!.id)
      expect(stillPresent).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
