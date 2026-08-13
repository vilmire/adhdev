import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// WORKTREE-CLAIM-GATE-BYPASS. A freshly cloned worktree node emits agent:ready as soon as its
// CLI reaches the idle prompt — BEFORE the worktree bootstrap (npm install + native-addon repair)
// finishes. The agent:ready handler defers its own claim while worktreeBootstrap.status==='running',
// but it first calls setRemoteIdleSession, registering the session as a claim candidate; a
// concurrent triggerMeshQueue drain then pulled that candidate and claimed through
// tryAssignQueueTask, bypassing the event-handler-local defer and dispatching into a half-built
// worktree → empty session.
//
// Fix: tryAssignQueueTask (the SINGLE claim funnel for every path) now gates the claim on the
// target node's worktreeBootstrap.status. A 'running' worktree node is refused and the task stays
// pending; once bootstrap reaches a terminal state the refired claim passes. These tests drive the
// LOCAL idle drain path (triggerMeshQueue), the very path that bypassed the defer in production.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-wtgate-test-${randomUUID().slice(0, 8)}`)
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

const WORKTREE_NODE_ID = 'node_worktree'
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
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'WTGATE Mesh', policy: {}, nodes })
}

// Worktree node whose bootstrap state is parameterized. workspace matches the claiming
// session's workingDir so the WTCLAIM workspace cross-check never refuses — isolating the
// bootstrap gate as the only variable under test.
const worktreeNode = (bootstrapStatus?: string, overrides: any = {}) => ({
  id: WORKTREE_NODE_ID,
  daemonId: 'daemon-local',
  workspace: WORKTREE_WS,
  repoRoot: WORKTREE_WS,
  policy: {},
  isLocalWorktree: true,
  ...(bootstrapStatus !== undefined ? { worktreeBootstrap: { status: bootstrapStatus } } : {}),
  ...overrides,
})

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('WORKTREE-CLAIM-GATE-BYPASS — bootstrap gate in the single claim funnel', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('REFUSES a claim for a worktree node whose bootstrap is still running — task stays pending', async () => {
    const meshId = `mesh_wtgate_running_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [worktreeNode('running')])
      const components = createComponents(meshId, [
        { sessionId: 'sess-wt', workingDir: WORKTREE_WS, meshNodeId: WORKTREE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: WORKTREE_NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const result = await triggerMeshQueue(components, meshId)

      // The candidate was observed but the bootstrap gate refused the claim.
      expect(result.localIdleSessionsChecked).toBe(1)
      expect(result.claimed).toBe(false)
      expect(result.newlyAssignedTasks).toEqual([])
      // Task is left PENDING (not failed/cancelled) so the bootstrap_complete refire re-claims it.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      // No dispatch ever happened into the half-built worktree.
      expect(components.cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  it('ALLOWS the claim once the same node\'s bootstrap transitions running→complete (refire passes)', async () => {
    const meshId = `mesh_wtgate_complete_${randomUUID().slice(0, 8)}`
    try {
      // First pass: bootstrap running → refused, task pending.
      setMesh(meshId, [worktreeNode('running')])
      const components = createComponents(meshId, [
        { sessionId: 'sess-wt', workingDir: WORKTREE_WS, meshNodeId: WORKTREE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: WORKTREE_NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const first = await triggerMeshQueue(components, meshId)
      expect(first.claimed).toBe(false)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')

      // Bootstrap completes; the refired drain must now pass the gate and claim the SAME task.
      setMesh(meshId, [worktreeNode('complete')])
      const second = await triggerMeshQueue(components, meshId)

      expect(second.claimed).toBe(true)
      expect(second.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: WORKTREE_NODE_ID, sessionId: 'sess-wt' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })

  it('is CONSERVATIVE: a worktree node with NO worktreeBootstrap field is NOT gated (prior behavior)', async () => {
    const meshId = `mesh_wtgate_nofield_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [worktreeNode(undefined)])
      const components = createComponents(meshId, [
        { sessionId: 'sess-wt', workingDir: WORKTREE_WS, meshNodeId: WORKTREE_NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do worktree work', { targetNodeId: WORKTREE_NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const result = await triggerMeshQueue(components, meshId)

      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: WORKTREE_NODE_ID, sessionId: 'sess-wt' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })
})
