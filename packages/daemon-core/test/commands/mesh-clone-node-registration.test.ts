import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
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

// Close the process-wide mesh runtime sqlite store after each test so an open
// handle can't EBUSY the next test's temp-dir removal on win32, and no stale
// singleton leaks across tests.
afterEach(resetMeshRuntimeStore)

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
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
    }
  })
})

/**
 * Regression: mesh_refine_node "Node '<id>' not found in mesh" for clone nodes.
 *
 * Same membership-divergence class as the clone-registration fix above, but on
 * the REFINE read path. clone_mesh_node / get_mesh / requireMeshHostMutationOwner
 * all resolve membership with preferInline: true (authoritative inline cache).
 * startMeshRefineJob / executeMeshRefineNodeSynchronously / plan_mesh_refine_node
 * previously resolved WITHOUT preferInline, took the config-first branch, and so
 * never saw the cloned worktree node — which lives ONLY in the inline cache, not
 * meshes.json. Net effect: mesh_list_nodes showed the clone, but mesh_refine_node
 * hard-failed with "Node '<id>' not found in mesh".
 *
 * Fix: refine/plan resolve with preferInline so the same membership authority as
 * clone/get_mesh is used.
 */
describe('mesh_refine_node membership <-> inline-cache-only clone node', () => {
  it('resolves an inline-cache-only clone node for refine/plan instead of "not found in mesh"', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-refine-lookup-config-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-refine-lookup-repo-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      // Config-backed mesh + source node persisted to meshes.json.
      const mesh = createMesh({ name: 'Refine Mesh', repoIdentity: 'github.com/acme/refine-mesh', defaultBranch: 'main' })
      const sourceNode = addNode(mesh.id, { workspace: repoRoot, repoRoot, daemonId: 'daemon-local' })
      expect(sourceNode?.id).toBeTruthy()

      const { router } = createRouter()

      // Coordinator inline snapshot carrying transient node truth → authoritative inline cache.
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

      // Clone a worktree node — registered into the inline cache only.
      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode!.id,
        branch: 'feature/refine-lookup',
        inlineMesh,
        setupWaitMs: 14000,
      }) as any
      expect(clone.success).toBe(true)
      const clonedNodeId = clone.node?.id as string
      expect(clonedNodeId).toBeTruthy()

      // Sanity: the cloned node is NOT in config (meshes.json) — it exists only in
      // the inline cache. This is the precondition that broke the config-first read.
      const configMesh = getMesh(mesh.id)
      expect(configMesh?.nodes?.some((n: any) => n.id === clonedNodeId)).toBe(false)

      // It IS visible through the inline-cache read path (mesh_list_nodes parity).
      const cacheRead = await router.execute('get_mesh', { meshId: mesh.id }) as any
      expect(cacheRead.mesh.nodes.map((n: any) => n.id)).toContain(clonedNodeId)

      // plan_mesh_refine_node (synchronous dry-run sibling of refine) must resolve
      // the clone node, NOT return "workspace not found"/"not found in mesh".
      const plan = await router.execute('plan_mesh_refine_node', {
        meshId: mesh.id,
        nodeId: clonedNodeId,
        inlineMesh,
      }) as any
      expect(plan.success).toBe(true)
      expect(plan.dryRun).toBe(true)
      expect(plan.workspace).toBeTruthy()

      // refine_mesh_node must get PAST the membership lookup — it returns a job
      // handle (refine:accepted), never the "not found in mesh" failure.
      const refine = await router.execute('refine_mesh_node', {
        meshId: mesh.id,
        nodeId: clonedNodeId,
        inlineMesh,
      }) as any
      expect(refine.error).not.toBe(`Node '${clonedNodeId}' not found in mesh`)
      expect(refine.success).not.toBe(false)

      // Clean up the in-flight refine job so the async tail does not leak.
      await router.execute('remove_mesh_node', {
        meshId: mesh.id,
        nodeId: clonedNodeId,
        inlineMesh,
        force: true,
      }).catch(() => {})
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
    }
  })
})
