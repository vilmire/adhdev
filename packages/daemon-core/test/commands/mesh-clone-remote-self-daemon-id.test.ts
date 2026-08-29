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

function createRouter(statusInstanceId: string) {
  return new DaemonCommandRouter({
    commandHandler: { handle: vi.fn(async () => ({ success: false })) } as any,
    cliManager: { restoreHostedSessions: vi.fn(async () => {}) } as any,
    cdpManagers: new Map(),
    providerLoader: {} as any,
    instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
    detectedIdes: { value: [] },
    sessionRegistry: {} as any,
    sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
    statusInstanceId,
  })
}

afterEach(resetMeshRuntimeStore)

/**
 * REMOTE-CLONE-SELF-IDENTITY regression (M-MESH-INFRA-0829 defect 5, evidence 1).
 *
 * A machine's own self/base node routinely carries NO `daemonId` — the standard
 * onboarding `add_mesh_node` step (mesh-onboarding-plan.ts addStep) never passes one,
 * since a node has no reason to address itself. This is harmless for a SAME-machine
 * clone (the coordinator never needs to reach a local node remotely), but
 * clone_mesh_node's LOCAL branch (mesh-crud.ts) used to copy `sourceNode.daemonId`
 * VERBATIM with no fallback — unlike buildMemberJoinNode (router.ts), which already
 * falls back to the executing daemon's own statusInstanceId when the source record
 * lacks one.
 *
 * When a REMOTE coordinator clones a worktree off this machine's base node,
 * clone_mesh_node forwards with `_meshDirectDispatch: true` and this SAME local
 * branch runs on the receiving (worker) daemon — with sourceNode being ITS OWN
 * daemonId-less self node. The clone reply shipped daemonId: undefined back to the
 * coordinator, which — via seedRemoteClonedWorktreeNode — could never probe the new
 * node over P2P again: buildMeshNodeCapabilityTags fell back to the COORDINATOR's own
 * process.platform/arch (mislabeling the node's real OS), and PHASE 1's remote event
 * pull silently skipped it (empty daemonId short-circuits pullPendingEventsFromNode).
 */
describe('clone_mesh_node — self/base node with no stored daemonId', () => {
  it('stamps the clone with the executing daemon\'s own statusInstanceId when sourceNode has no daemonId', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-clone-remote-self-id-config-'))
    const { dir, repoRoot } = await createTempGitRepo('mesh-clone-remote-self-id-repo-')
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode } = await import('../../src/config/mesh-config.js')

      // The self/base node, registered the way onboarding actually does it: NO daemonId.
      const mesh = createMesh({ name: 'Remote Self Mesh', repoIdentity: 'github.com/acme/remote-self-mesh', defaultBranch: 'main' })
      const sourceNode = addNode(mesh.id, { workspace: repoRoot, repoRoot })
      expect(sourceNode?.id).toBeTruthy()
      expect(sourceNode?.daemonId).toBeUndefined()

      // This router IS the worker daemon (e.g. "Jupiter") receiving a forwarded clone
      // request from a different coordinator machine.
      const router = createRouter('daemon-worktree-remote')

      const clone = await router.execute('clone_mesh_node', {
        meshId: mesh.id,
        sourceNodeId: sourceNode!.id,
        branch: 'feature/remote-self-id',
        setupWaitMs: 14000,
        // Marks this as the receiving end of a forward — the coordinator already
        // decided sourceDaemonId differs from its own id and dispatched here.
        _meshDirectDispatch: true,
      }) as any

      expect(clone.success).toBe(true)
      // The reply the coordinator seeds into its cache via seedRemoteClonedWorktreeNode
      // must carry a resolvable daemonId — never undefined — so the coordinator can
      // reach this node over P2P for status probes and pending-event pulls.
      expect(clone.node?.daemonId).toBe('daemon-worktree-remote')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
      await cleanupTempDir(dir)
    }
  })
})
