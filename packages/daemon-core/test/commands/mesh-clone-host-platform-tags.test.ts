import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { cleanupTempDir, resetMeshRuntimeStore } from '../helpers/temp-cleanup.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DaemonCommandRouter } from '../../src/commands/router'
import { buildMeshNodeCapabilityTags } from '../../src/mesh/mesh-node-capability-tags'
import { projectMemberWorktreeNode } from '../../src/mesh/mesh-remote-worktree-membership'

const execFileAsync = promisify(execFile)

/**
 * NODE-TAGS-CLONE-HOST: a cloned worktree node is stamped with the HOSTING daemon's
 * platform/arch/nickname at creation and does not inherit the source node's
 * platform/arch overrides. Before the fix the clone copied sourceNode.userOverrides
 * verbatim and carried no reportedPlatform/reportedArch, so a coordinator derived
 * os=/arch= from its own process until the first git_status probe arrived — and an
 * inherited override would have outranked the probe forever.
 */

const FOREIGN_PLATFORM = process.platform === 'win32' ? 'darwin' : 'win32'
const FOREIGN_ARCH = process.arch === 'x64' ? 'arm64' : 'x64'

async function createTempGitRepo(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const repoRoot = join(dir, 'repo')
  await execFileAsync('git', ['init', repoRoot], { windowsHide: true })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, windowsHide: true })
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, windowsHide: true })
  await writeFile(join(repoRoot, 'README.md'), '# test\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot, windowsHide: true })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot, windowsHide: true })
  return { dir, repoRoot }
}

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

describe('clone_mesh_node stamps the hosting daemon platform/arch/nickname', () => {
  for (const variant of ['config', 'inline'] as const) {
    it(`${variant} mesh: clone carries this daemon's os/arch and drops the source's platform/arch overrides`, async () => {
      const configDir = await mkdtemp(join(tmpdir(), `mesh-clone-tags-${variant}-config-`))
      const { dir, repoRoot } = await createTempGitRepo(`mesh-clone-tags-${variant}-repo-`)
      const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
      try {
        process.env.ADHDEV_CONFIG_DIR = configDir
        const { saveConfig, loadConfig, invalidateConfigFieldMemos } = await import('../../src/config/config.js')
        saveConfig({ ...loadConfig(), machineNickname: 'clone-host-box' })
        invalidateConfigFieldMemos()
        const { createMesh, addNode, updateMesh, getMesh } = await import('../../src/config/mesh-config.js')
        const mesh = createMesh({ name: 'Tag Mesh', repoIdentity: 'github.com/acme/tag-mesh', defaultBranch: 'main' })
        updateMesh(mesh.id, { policy: { ...(mesh.policy || {}), worktreeBaseDir: join(dir, 'worktrees') } } as any)
        const sourceNode = addNode(mesh.id, {
          workspace: repoRoot,
          repoRoot,
          daemonId: 'daemon-local',
          userOverrides: { platform: FOREIGN_PLATFORM, arch: FOREIGN_ARCH, shell: 'zsh' } as any,
        })
        expect(sourceNode?.id).toBeTruthy()
        const router = createRouter()

        const inlineMesh = variant === 'inline'
          ? {
              id: mesh.id,
              name: mesh.name,
              repoIdentity: mesh.repoIdentity,
              defaultBranch: 'main',
              policy: { worktreeBaseDir: join(dir, 'worktrees') },
              nodes: [{
                id: sourceNode!.id, daemonId: 'daemon-local', workspace: repoRoot, repoRoot, policy: {},
                userOverrides: { platform: FOREIGN_PLATFORM, arch: FOREIGN_ARCH, shell: 'zsh' },
                cachedStatus: { health: 'online' },
              }],
            }
          : undefined
        if (inlineMesh) {
          await router.execute('get_mesh', { meshId: mesh.id, inlineMesh })
          await router.execute('get_mesh', { meshId: mesh.id, inlineMesh })
        }

        const clone = await router.execute('clone_mesh_node', {
          meshId: mesh.id,
          sourceNodeId: sourceNode!.id,
          branch: `feature/clone-tags-${variant}`,
          ...(inlineMesh ? { inlineMesh } : {}),
          setupWaitMs: 14000,
        }) as any
        expect(clone.success).toBe(true)
        const node = clone.node
        expect(node.reportedPlatform).toBe(process.platform)
        expect(node.reportedArch).toBe(process.arch)
        expect(node.machineNickname).toBe('clone-host-box')
        expect(node.userOverrides?.platform).toBeUndefined()
        expect(node.userOverrides?.arch).toBeUndefined()
        expect(node.userOverrides?.shell).toBe('zsh')
        const tags = buildMeshNodeCapabilityTags(node)
        expect(tags).toContain(`os=${process.platform}`)
        expect(tags).toContain(`arch=${process.arch}`)

        // The durable config twin carries the same stamp (survives restart).
        const persisted = getMesh(mesh.id)!.nodes.find(n => n.id === node.id) as any
        expect(persisted).toBeTruthy()
        expect(persisted.reportedPlatform).toBe(process.platform)
        expect(persisted.reportedArch).toBe(process.arch)
        expect(persisted.machineNickname).toBe('clone-host-box')
        expect(persisted.userOverrides?.platform).toBeUndefined()
      } finally {
        if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
        await cleanupTempDir(configDir)
        await cleanupTempDir(dir)
      }
    })
  }
})

describe('forwarded clone record keeps the hosting daemon platform/arch', () => {
  const record = {
    id: 'node_remote1',
    workspace: '/remote/wt',
    daemonId: 'daemon-remote',
    machineNickname: 'remote-box',
    reportedPlatform: FOREIGN_PLATFORM,
    reportedArch: FOREIGN_ARCH,
    isLocalWorktree: true,
  }

  it('projectMemberWorktreeNode carries reportedPlatform/reportedArch', () => {
    const projected = projectMemberWorktreeNode(record)
    expect(projected).toEqual(expect.objectContaining({ reportedPlatform: FOREIGN_PLATFORM, reportedArch: FOREIGN_ARCH, machineNickname: 'remote-box' }))
  })

  it('persistRemoteClonedWorktreeNode writes them into the coordinator config twin', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-clone-tags-remote-config-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, getMesh } = await import('../../src/config/mesh-config.js')
      const mesh = createMesh({ name: 'Remote Tag Mesh', repoIdentity: 'github.com/acme/remote-tag', defaultBranch: 'main' })
      const router = createRouter()
      const outcome = await router.persistRemoteClonedWorktreeNode(mesh.id, record)
      expect(outcome).toBe('persisted')
      const persisted = getMesh(mesh.id)!.nodes.find(n => n.id === 'node_remote1') as any
      expect(persisted.reportedPlatform).toBe(FOREIGN_PLATFORM)
      expect(persisted.reportedArch).toBe(FOREIGN_ARCH)
      expect(persisted.machineNickname).toBe('remote-box')
      // The coordinator derives the REMOTE os, not its own.
      expect(buildMeshNodeCapabilityTags(persisted)).toContain(`os=${FOREIGN_PLATFORM}`)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
