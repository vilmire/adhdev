import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'

const execFileAsync = promisify(execFile)

async function createTempGitRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(dir, 'repo')
  await execFileAsync('git', ['init', repoRoot])
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  return { dir, repoRoot }
}

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

/**
 * Regression: clone_node-registration event ordering / membership divergence.
 *
 * A coordinator owns its mesh as an inline mesh. Its inline snapshot carries
 * transient node truth (health/git/cachedStatus), so the daemon warms an inline
 * cache and treats it as authoritative — get_mesh resolves with preferInline:
 * true and returns `coordinator_inline_mesh_cache`. clone_mesh_node previously
 *   (a) resolved WITHOUT preferInline, took the local-config branch, and wrote
 *       the new node only to meshes.json — never into the authoritative inline
 *       cache that get_mesh reads back; and
 *   (b) even once written, reconcileInlineMeshCache dropped cache-only nodes
 *       when an older snapshot was re-sent, because it iterated only the
 *       incoming node list and never re-added cached-only membership.
 * Net effect: the cloned worktree node was invisible in live mesh membership
 * (mesh_list_nodes / mesh_status / get_mesh) and every membership-resolving op
 * (mesh_launch_session, mesh_git_status, mesh_remove_node) hard-failed with
 * "is not a member of mesh" — even though worktree_bootstrap_complete fired.
 *
 * Fix: clone_mesh_node resolves with preferInline (matching the read path) and
 * reconciles the node into any warmed inline cache; reconcileInlineMeshCache
 * preserves cache-only membership when the cache is authoritative.
 */
describe('clone_mesh_node registration <-> membership consistency', () => {
  it('keeps a cloned worktree node visible in live membership when the coordinator owns an authoritative inline cache', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-clone-registration-config-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-clone-registration-repo-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')

      // Config-backed mesh + source node persisted to meshes.json — this is what
      // made the pre-fix clone take the local-config branch.
      const mesh = createMesh({ name: 'Clone Mesh', repoIdentity: 'github.com/acme/clone-mesh', defaultBranch: 'main' })
      const sourceNode = addNode(mesh.id, { workspace: repoRoot, repoRoot, daemonId: 'daemon-local' })
      expect(sourceNode?.id).toBeTruthy()

      const { router } = createRouter()

      // Coordinator inline snapshot. cachedStatus marks transient node truth, so
      // the daemon warms an authoritative inline cache (source: inline cache).
      const inlineMesh = {
        id: mesh.id,
        name: mesh.name,
        repoIdentity: mesh.repoIdentity,
        defaultBranch: 'main',
        policy: {},
        nodes: [
          { id: sourceNode!.id, daemonId: 'daemon-local', workspace: repoRoot, repoRoot, policy: {}, cachedStatus: { health: 'online' } },
        ],
      }
      // First read warms the cache (inline_bootstrap_snapshot); the important
      // invariant is that membership resolves to an INLINE source, not
      // local_mesh_config — that is the condition that drove the divergence.
      const warmed = await router.execute('get_mesh', { meshId: mesh.id, inlineMesh }) as any
      expect(warmed.success).toBe(true)
      expect(warmed.sourceOfTruth.membership).not.toBe('local_mesh_config')
      // Second read confirms the cache is now authoritative.
      const warmedAgain = await router.execute('get_mesh', { meshId: mesh.id, inlineMesh }) as any
      expect(warmedAgain.sourceOfTruth.membership).toBe('coordinator_inline_mesh_cache')

      // Clone a worktree node off the source node (wait synchronously).
      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode!.id,
        branch: 'feature/clone-registration',
        inlineMesh,
        setupWaitMs: 14000,
      }) as any

      expect(clone.success).toBe(true)
      const clonedNodeId = clone.node?.id
      expect(clonedNodeId).toBeTruthy()
      expect(clonedNodeId).not.toBe(sourceNode!.id)

      // Membership read that does NOT re-send a snapshot (refreshMeshFromDaemon
      // path) must include the cloned node.
      const cacheRead = await router.execute('get_mesh', { meshId: mesh.id }) as any
      expect(cacheRead.success).toBe(true)
      expect(cacheRead.mesh.nodes.map((n: any) => n.id)).toContain(clonedNodeId)

      // Membership read that re-sends the ORIGINAL (now-stale) coordinator
      // snapshot must still include the cloned node — reconcileInlineMeshCache
      // must preserve cache-only membership instead of dropping it.
      const reconciledRead = await router.execute('get_mesh', { meshId: mesh.id, inlineMesh }) as any
      expect(reconciledRead.success).toBe(true)
      const memberIds = reconciledRead.mesh.nodes.map((n: any) => n.id)
      expect(memberIds).toContain(clonedNodeId)
      const clonedMember = reconciledRead.mesh.nodes.find((n: any) => n.id === clonedNodeId)
      expect(clonedMember).toEqual(expect.objectContaining({
        isLocalWorktree: true,
        clonedFromNodeId: sourceNode!.id,
      }))

      // The in-between node must be removable through mesh tools (it was not before).
      const removed = await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId: clonedNodeId,
        inlineMesh,
        force: true,
      }) as any
      expect(removed.success).toBe(true)
      expect(removed.removed).not.toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
      await rm(dir, { recursive: true, force: true })
    }
  })
})
