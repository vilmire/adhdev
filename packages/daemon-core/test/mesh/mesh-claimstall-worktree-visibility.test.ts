import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all mesh file I/O (queue JSON, MeshRuntimeStore db, ledger) to a per-run
// temp dir so the production ~/.adhdev state is never touched.
const testTmpDir = path.join(tmpdir(), `adhdev-mesh-claimstall-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
}))

// getMesh is the LOCAL-CONFIG view. The whole point of the CLAIMSTALL bug is that a
// cloned worktree node never reaches local config (it lives only in the router's
// inline cache), so getMesh returns a base-only mesh. The fix unions that with the
// inline cache; this mock lets each test control the config view precisely.
const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'

const BASE_NODE_ID = 'node_base'
const WORKTREE_NODE_ID = 'node_worktree'

/**
 * Build the minimal DaemonComponents surface triggerMeshQueue / tryAssignQueueTask
 * exercise during a remote-idle drain. `getCachedInlineMesh` is the inline-cache
 * view (send_task's authoritative source); pass undefined to model a coordinator
 * with no warmed inline cache.
 */
function createComponents(opts: {
  cachedInlineMesh?: any
  dispatchMeshCommand?: any
}) {
  const dispatchMeshCommand = opts.dispatchMeshCommand ?? vi.fn(async () => ({ success: true }))
  return {
    instanceManager: {
      // No local CLI sessions — the bug and fix are about the REMOTE idle drain,
      // which is the path gated on mesh.nodes membership visibility.
      getByCategory: vi.fn((category: string) => (category === 'cli' ? [] : [])),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async () => ({ success: true })),
    },
    providerLoader: {
      resolveAlias: vi.fn((type: string) => type),
      isMachineProviderEnabled: vi.fn(() => true),
    },
    router: opts.cachedInlineMesh !== undefined
      ? { getCachedInlineMesh: vi.fn((_meshId: string) => opts.cachedInlineMesh) }
      : undefined,
    dispatchMeshCommand,
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('CLAIMSTALL — worktree node claim-time membership visibility', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('claims a target-pinned task on an inline-cache-only worktree node during the remote-idle drain', async () => {
    const meshId = `mesh_claimstall_${randomUUID().slice(0, 8)}`
    try {
      const baseNode = { id: BASE_NODE_ID, daemonId: 'daemon-local', workspace: '/repo/main', repoRoot: '/repo/main', policy: {} }
      // Worktree node: UNIQUE nodeId, shares the base daemonId (same machine — daemonId
      // is environment, not the match key). Lives ONLY in the inline cache, exactly as
      // clone_mesh_node's meshRecord.inline branch registers it (updateInlineMeshNode,
      // not addNode → never written to meshes.json).
      const worktreeNode = {
        id: WORKTREE_NODE_ID,
        nodeId: WORKTREE_NODE_ID,
        daemonId: 'daemon-local',
        workspace: '/repo/wt-claimstall',
        repoRoot: '/repo/wt-claimstall',
        policy: {},
        isLocalWorktree: true,
        clonedFromNodeId: BASE_NODE_ID,
      }

      // LOCAL-CONFIG view: base node only — the worktree node is absent (the precondition
      // that made the config-first claim view blind to it).
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'Claimstall Mesh', policy: {}, nodes: [baseNode] })
      // INLINE-CACHE view: base + worktree (what send_task already sees).
      const cachedInlineMesh = { id: meshId, name: 'Claimstall Mesh', policy: {}, nodes: [baseNode, worktreeNode] }
      const components = createComponents({ cachedInlineMesh })

      // A queue task pinned to the worktree node, and an idle remote session on it.
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: WORKTREE_NODE_ID, taskMode: 'code_change' })
      MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, WORKTREE_NODE_ID, 'sess-wt-1', 'claude-cli', Date.now() + 60_000)

      const result = await triggerMeshQueue(components, meshId)

      // The merged claim view now sees the worktree node, so its idle session is a drain
      // candidate (pre-fix: mesh.nodes.find missed it → checked 0 → stranded pending).
      expect(result.remoteIdleSessionsChecked).toBe(1)
      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: WORKTREE_NODE_ID, sessionId: 'sess-wt-1' }),
      ])

      const claimed = getQueue(meshId).find(t => t.id === task.id)
      expect(claimed?.status).toBe('assigned')
      expect(claimed?.assignedNodeId).toBe(WORKTREE_NODE_ID)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: a base node present in local config still claims with no inline cache (base path unchanged)', async () => {
    const meshId = `mesh_claimstall_base_${randomUUID().slice(0, 8)}`
    try {
      const baseNode = { id: BASE_NODE_ID, daemonId: 'daemon-remote', workspace: '/repo/main', repoRoot: '/repo/main', policy: {} }
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'Base Mesh', policy: {}, nodes: [baseNode] })
      // No inline cache at all (router undefined) — getMeshWithCache must return the
      // local-config mesh verbatim, byte-for-byte the pre-fix behavior.
      const components = createComponents({ cachedInlineMesh: undefined })

      const task = enqueueTask(meshId, 'do base work', { targetNodeId: BASE_NODE_ID, taskMode: 'code_change' })
      MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, BASE_NODE_ID, 'sess-base-1', 'claude-cli', Date.now() + 60_000)

      const result = await triggerMeshQueue(components, meshId)

      expect(result.remoteIdleSessionsChecked).toBe(1)
      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: BASE_NODE_ID, sessionId: 'sess-base-1' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })

  it('negative control: the merge adds only genuine cache nodes — an idle session for a node in neither view is not claimed', async () => {
    const meshId = `mesh_claimstall_ghost_${randomUUID().slice(0, 8)}`
    try {
      const baseNode = { id: BASE_NODE_ID, daemonId: 'daemon-local', workspace: '/repo/main', repoRoot: '/repo/main', policy: {} }
      meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'Ghost Mesh', policy: {}, nodes: [baseNode] })
      // Inline cache also has ONLY the base node — no worktree node exists anywhere.
      const components = createComponents({ cachedInlineMesh: { id: meshId, name: 'Ghost Mesh', policy: {}, nodes: [baseNode] } })

      enqueueTask(meshId, 'do ghost work', { targetNodeId: 'node_ghost', taskMode: 'code_change' })
      // Idle session reported for a node that is in neither the config nor the cache view.
      MeshRuntimeStore.getInstance().setRemoteIdleSession(meshId, 'node_ghost', 'sess-ghost-1', 'claude-cli', Date.now() + 60_000)

      const result = await triggerMeshQueue(components, meshId)

      // The merge must NOT fabricate the ghost node, so its idle session is correctly
      // excluded from the drain pool — proving visibility is sourced from real membership.
      expect(result.remoteIdleSessionsChecked).toBe(0)
      expect(result.claimed).toBe(false)
    } finally {
      cleanup(meshId)
    }
  })
})
