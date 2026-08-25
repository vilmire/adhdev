import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * meshes.json → inline-cache policy resync: an out-of-band (hand) edit of a
 * mesh policy flag on disk must reach the daemon's in-memory inline mesh cache
 * without a restart. Live evidence 2026-08-25: requireApprovalForPush flipped
 * to false on disk 92 min after daemon boot; the daemon kept reporting true.
 *
 * Each test warms the inline cache the way bootstrap/cloud launch does, lets
 * the first read record the file baseline, then hand-edits meshes.json and
 * re-reads after the sync throttle window.
 */
describe('meshes.json policy resync into the inline mesh cache', () => {
  it('a hand-edited policy flag reaches memory on the next read, policy-only (node truth preserved)', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-policy-resync-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, addNode, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Resync', repoIdentity: 'github.com/acme/resync', defaultBranch: 'main' })
      expect(mesh.policy.requireApprovalForPush).toBe(true)
      addNode(mesh.id, { workspace: '/tmp/resync-workspace', repoRoot: '/tmp/resync-workspace' })

      const { router } = createRouter()
      // Warm the inline cache from the on-disk mesh, as bootstrap would.
      router.getCachedInlineMesh(mesh.id, getMesh(mesh.id))
      // First command read records the meshes.json baseline (no apply yet).
      const baseline = await router.getMeshForCommand(mesh.id)
      expect(baseline?.mesh?.policy?.requireApprovalForPush).toBe(true)
      // Marker proving the resync touches ONLY the policy block: in-memory node
      // truth the disk copy does not have must survive the reload.
      baseline.mesh.nodes[0].liveTruthMarker = 'keep-me'
      // A held aggregate snapshot must be busted by the policy change.
      router.aggregateMeshStatusCache.set(mesh.id, {
        builtAt: Date.now(),
        snapshot: { success: true, nodes: [] },
        queueRevision: 'rev-test',
      })

      // Operator hand-edit: flip the flag on disk (and change a second field so
      // the file size provably differs even within one mtime tick).
      const configPath = join(configDir, 'meshes.json')
      const onDisk = JSON.parse(await readFile(configPath, 'utf-8'))
      onDisk.meshes[0].policy.requireApprovalForPush = false
      onDisk.meshes[0].policy.maxTaskRetries = 3
      await writeFile(configPath, JSON.stringify(onDisk, null, 2))

      await sleep(300) // > MESH_POLICY_DISK_SYNC_THROTTLE_MS
      const after = await router.getMeshForCommand(mesh.id)
      expect(after?.mesh?.policy?.requireApprovalForPush).toBe(false)
      expect(after?.mesh?.policy?.maxTaskRetries).toBe(3)
      // Policy-only reload: the in-memory node truth was NOT overwritten by the
      // disk copy (the daemon's in-flight writes live on the node entries).
      expect(after?.mesh?.nodes?.[0]?.liveTruthMarker).toBe('keep-me')
      // The stale aggregate snapshot was invalidated.
      expect(router.aggregateMeshStatusCache.has(mesh.id)).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })

  it('an unparseable (mid-edit) meshes.json keeps the in-memory policy; a repaired file resyncs', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'mesh-policy-resync-broken-'))
    const previousConfigDir = process.env.ADHDEV_CONFIG_DIR

    try {
      process.env.ADHDEV_CONFIG_DIR = configDir
      const { createMesh, getMesh } = await import('../../src/config/mesh-config.js')

      const mesh = createMesh({ name: 'Resync Broken', repoIdentity: 'github.com/acme/resync-broken', defaultBranch: 'main' })

      const { router } = createRouter()
      router.getCachedInlineMesh(mesh.id, getMesh(mesh.id))
      const baseline = await router.getMeshForCommand(mesh.id)
      expect(baseline?.mesh?.policy?.requireApprovalForPush).toBe(true)

      // Torn write: the file changed but is not valid JSON.
      const configPath = join(configDir, 'meshes.json')
      await writeFile(configPath, '{ "meshes": [ { "id": ')

      await sleep(300)
      const duringBroken = await router.getMeshForCommand(mesh.id)
      // Safe direction: the in-memory (restrictive) policy is kept, not dropped
      // to defaults.
      expect(duringBroken?.mesh?.policy?.requireApprovalForPush).toBe(true)

      // Repaired file with the edited flag: resync resumes. (getMesh now reads
      // the broken file, so rebuild the document from the cached mesh.)
      const cached = router.getCachedInlineMesh(mesh.id)
      const repairedMesh = JSON.parse(JSON.stringify(cached))
      repairedMesh.policy = { ...repairedMesh.policy, requireApprovalForPush: false }
      await writeFile(configPath, JSON.stringify({ meshes: [repairedMesh] }, null, 2))

      await sleep(300)
      const afterRepair = await router.getMeshForCommand(mesh.id)
      expect(afterRepair?.mesh?.policy?.requireApprovalForPush).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
      else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
      await cleanupTempDir(configDir)
    }
  })
})
