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
 * PROVIDER-PRIORITY-FROM-SLOTS write-path sync: when a node write states slots
 * and the daemon persists the slots-derived order into policy.providerPriority,
 * so the compatibility field cannot drift. An explicit providerPriority remains
 * meaningful only for slotless legacy nodes.
 */
describe('update_mesh_node / add_mesh_node providerPriority-from-slots sync', () => {
  it('update_mesh_node with slots and no providerPriority records the slots-derived order', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-update-pp-sync-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'PP Sync', repoIdentity: 'github.com/acme/pp-sync', defaultBranch: 'main' })
      const node = addNode(mesh.id, {
        workspace: '/tmp/pp-sync-workspace',
        repoRoot: '/tmp/pp-sync-workspace',
        policy: { providerPriority: ['kimi'], slots: [{ provider: 'kimi' }] },
      } as any)
      const nodeId = node!.id

      const { router } = createRouter()
      const result = await router.execute('update_mesh_node', {
        meshId: mesh.id,
        nodeId,
        policy: { slots: [{ provider: 'codex-cli' }, { provider: 'claude-cli' }] },
      }) as any

      expect(result.success).toBe(true)
      expect(result.node?.policy?.providerPriority).toEqual(['codex-cli', 'claude-cli'])

      // Persisted to meshes.json (getMesh reloads fresh from disk each call).
      const afterNode = getMesh(mesh.id)?.nodes?.find((n: any) => n.id === nodeId)
      expect(afterNode?.policy?.providerPriority).toEqual(['codex-cli', 'claude-cli'])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('slots win over an explicit providerPriority arg when both are supplied', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-update-pp-explicit-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'PP Explicit', repoIdentity: 'github.com/acme/pp-explicit', defaultBranch: 'main' })
      const node = addNode(mesh.id, { workspace: '/tmp/pp-explicit-workspace', repoRoot: '/tmp/pp-explicit-workspace' })
      const nodeId = node!.id

      const { router } = createRouter()
      const result = await router.execute('update_mesh_node', {
        meshId: mesh.id,
        nodeId,
        policy: { slots: [{ provider: 'codex-cli' }] },
        providerPriority: ['hermes-cli'],
      }) as any

      expect(result.success).toBe(true)
      expect(result.node?.policy?.providerPriority).toEqual(['codex-cli'])
      const afterNode = getMesh(mesh.id)?.nodes?.find((n: any) => n.id === nodeId)
      expect(afterNode?.policy?.providerPriority).toEqual(['codex-cli'])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('respects an explicit providerPriority arg for a slotless legacy node', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-update-pp-legacy-explicit-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'PP Legacy Explicit', repoIdentity: 'github.com/acme/pp-legacy-explicit', defaultBranch: 'main' })
      const node = addNode(mesh.id, { workspace: '/tmp/pp-legacy-explicit', repoRoot: '/tmp/pp-legacy-explicit' })

      const { router } = createRouter()
      const result = await router.execute('update_mesh_node', {
        meshId: mesh.id,
        nodeId: node!.id,
        providerPriority: ['hermes-cli'],
      }) as any

      expect(result.success).toBe(true)
      expect(result.node?.policy?.providerPriority).toEqual(['hermes-cli'])
      const afterNode = getMesh(mesh.id)?.nodes?.find((n: any) => n.id === node!.id)
      expect(afterNode?.policy?.providerPriority).toEqual(['hermes-cli'])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('a slotless update never invents or clears a stored providerPriority', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-update-pp-slotless-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'PP Slotless', repoIdentity: 'github.com/acme/pp-slotless', defaultBranch: 'main' })
      const node = addNode(mesh.id, {
        workspace: '/tmp/pp-slotless-workspace',
        repoRoot: '/tmp/pp-slotless-workspace',
        policy: { providerPriority: ['claude-cli'] },
      } as any)
      const nodeId = node!.id

      const { router } = createRouter()
      const result = await router.execute('update_mesh_node', {
        meshId: mesh.id,
        nodeId,
        systemPrompt: 'be brief',
      }) as any

      expect(result.success).toBe(true)
      const afterNode = getMesh(mesh.id)?.nodes?.find((n: any) => n.id === nodeId)
      expect(afterNode?.policy?.providerPriority).toEqual(['claude-cli'])
      expect(afterNode?.systemPrompt).toBe('be brief')
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('add_mesh_node derives providerPriority from slots even when a stale explicit value is supplied', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-add-pp-sync-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'PP Add', repoIdentity: 'github.com/acme/pp-add', defaultBranch: 'main' })

      const { router } = createRouter()
      const result = await router.execute('add_mesh_node', {
        meshId: mesh.id,
        workspace: '/tmp/pp-add-workspace',
        slots: [{ provider: 'gemini-cli' }, { provider: 'claude-cli' }],
        providerPriority: ['kimi'],
      }) as any

      expect(result.success).toBe(true)
      expect(result.node?.policy?.slots).toEqual([{ provider: 'gemini-cli' }, { provider: 'claude-cli' }])
      expect(result.node?.policy?.providerPriority).toEqual(['gemini-cli', 'claude-cli'])
      const afterNode = getMesh(mesh.id)?.nodes?.find((n: any) => n.workspace === '/tmp/pp-add-workspace')
      expect(afterNode?.policy?.providerPriority).toEqual(['gemini-cli', 'claude-cli'])
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
