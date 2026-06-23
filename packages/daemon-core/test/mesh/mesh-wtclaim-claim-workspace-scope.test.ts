import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// WTCLAIM (fix-B extended to the enqueue→claim path). A co-located worktree-clone session
// whose meshNodeId is empty/stale falls back to settings.nodeId = the BASE node id in
// triggerMeshQueue's candidate derivation, impersonating the base node and claiming a
// base-targeted queue task — which then runs in the wrong workspace. tryAssignQueueTask now
// cross-checks the claiming LOCAL session's actual workingDir against the target node's
// declared workspace and refuses a cross-workspace claim, so a base-targeted task can never
// land in a worktree session (and vice versa). These tests drive the LOCAL idle drain path
// (the remote drain is covered by mesh-claimstall-worktree-visibility.test.ts).

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-wtclaim-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
}))

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

const BASE_NODE_ID = 'node_base'
const WORKTREE_NODE_ID = 'node_worktree'
const BASE_WS = '/repo/main'
const WORKTREE_WS = '/repo/wt'

type LocalSession = {
  sessionId: string
  workingDir: string
  meshNodeId?: string
  nodeId?: string
  providerType?: string
  status?: string
}

function createComponents(meshId: string, sessions: LocalSession[]) {
  const adapters = new Map<string, { workingDir: string }>()
  const cliInstances = sessions.map((s) => {
    adapters.set(s.sessionId, { workingDir: s.workingDir })
    const settings: Record<string, unknown> = {
      meshNodeFor: meshId,
      providerType: s.providerType ?? 'claude-cli',
    }
    if (s.meshNodeId !== undefined) settings.meshNodeId = s.meshNodeId
    if (s.nodeId !== undefined) settings.nodeId = s.nodeId
    return {
      getState: () => ({
        settings,
        status: s.status ?? 'idle',
        instanceId: s.sessionId,
        type: s.providerType ?? 'claude-cli',
        workspace: s.workingDir,
      }),
      updateSettings: vi.fn(),
    }
  })
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
      getInstance: vi.fn((sid: string) => cliInstances.find((i) => i.getState().instanceId === sid)),
    },
    cliManager: {
      adapters,
      handleCliCommand: vi.fn(async () => ({ success: true })),
    },
    providerLoader: {
      resolveAlias: vi.fn((type: string) => type),
      isMachineProviderEnabled: vi.fn(() => true),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string, nodes: any[]) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'WTCLAIM Mesh', policy: {}, nodes })
}

const baseNode = (overrides: any = {}) => ({ id: BASE_NODE_ID, daemonId: 'daemon-local', workspace: BASE_WS, repoRoot: BASE_WS, policy: {}, ...overrides })
const worktreeNode = (overrides: any = {}) => ({ id: WORKTREE_NODE_ID, daemonId: 'daemon-local', workspace: WORKTREE_WS, repoRoot: WORKTREE_WS, policy: {}, isLocalWorktree: true, clonedFromNodeId: BASE_NODE_ID, ...overrides })

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('WTCLAIM — enqueue→claim workspace cross-check (local idle drain)', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('REFUSES a base-targeted task for a worktree session impersonating the base node (no meshNodeId → nodeId fallback)', async () => {
    const meshId = `mesh_wtclaim_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [baseNode(), worktreeNode()])
      // Worktree session: meshNodeId MISSING, so candidate derivation falls back to
      // settings.nodeId = BASE_NODE_ID — impersonating the base node — while its real
      // workingDir is the worktree clone.
      const components = createComponents(meshId, [
        { sessionId: 'sess-wt', workingDir: WORKTREE_WS, nodeId: BASE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do base work', { targetNodeId: BASE_NODE_ID, taskMode: 'code_change' })

      const result = await triggerMeshQueue(components, meshId)

      // The candidate was checked but the cross-workspace claim was refused.
      expect(result.localIdleSessionsChecked).toBe(1)
      expect(result.claimed).toBe(false)
      expect(result.newlyAssignedTasks).toEqual([])
      // Task stays pending for the correctly-scoped base session/node to pull.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })

  it('ALLOWS a worktree-targeted task for the matching worktree session (rc.361 worktree path preserved)', async () => {
    const meshId = `mesh_wtclaim_ok_wt_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [baseNode(), worktreeNode()])
      const components = createComponents(meshId, [
        { sessionId: 'sess-wt2', workingDir: WORKTREE_WS, meshNodeId: WORKTREE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: WORKTREE_NODE_ID, taskMode: 'code_change' })

      const result = await triggerMeshQueue(components, meshId)

      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: WORKTREE_NODE_ID, sessionId: 'sess-wt2' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })

  it('ALLOWS a base-targeted task for the matching base session (base path unchanged)', async () => {
    const meshId = `mesh_wtclaim_ok_base_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [baseNode(), worktreeNode()])
      const components = createComponents(meshId, [
        { sessionId: 'sess-base', workingDir: BASE_WS, meshNodeId: BASE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do base work', { targetNodeId: BASE_NODE_ID, taskMode: 'code_change' })

      const result = await triggerMeshQueue(components, meshId)

      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: BASE_NODE_ID, sessionId: 'sess-base' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })

  it('is CONSERVATIVE: when the node declares no workspace, the claim is NOT refused (no legitimate claim starved)', async () => {
    const meshId = `mesh_wtclaim_nows_${randomUUID().slice(0, 8)}`
    try {
      // Base node with NO declared workspace — the cross-check cannot verify, so it must
      // fall through to the prior behavior and still claim.
      setMesh(meshId, [baseNode({ workspace: undefined, repoRoot: undefined })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-x', workingDir: WORKTREE_WS, meshNodeId: BASE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do work', { targetNodeId: BASE_NODE_ID, taskMode: 'code_change' })

      const result = await triggerMeshQueue(components, meshId)

      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: BASE_NODE_ID, sessionId: 'sess-x' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })

  it('matches workspaces up to separator/case/trailing-slash normalization (no false refusal)', async () => {
    const meshId = `mesh_wtclaim_norm_${randomUUID().slice(0, 8)}`
    try {
      // Node declares a Windows-style, trailing-slash, mixed-case path; the adapter holds the
      // POSIX-ish lowercased form. normalizeMeshWorkspaceForCompare must treat them as equal.
      setMesh(meshId, [baseNode({ workspace: 'C:\\Repo\\Main\\', repoRoot: 'C:\\Repo\\Main\\' })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-norm', workingDir: 'c:/repo/main', meshNodeId: BASE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do work', { targetNodeId: BASE_NODE_ID, taskMode: 'code_change' })

      const result = await triggerMeshQueue(components, meshId)

      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: BASE_NODE_ID, sessionId: 'sess-norm' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })
})
