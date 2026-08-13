import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// WTDISPATCH-FANOUT — residual of WTCLAIM/WTDISPATCH (claim node scope).
//
// The prior guards stop a SIBLING worktree session from claiming ANOTHER node's task
// (cross-node leak) by workspace/stamp scope. They do NOT stop the distinct failure the
// live repro hit: a base-only `convergence` task (merge → push → cleanup onto base) being
// claimable by EVERY worktree-clone session co-located on one daemon. An untargeted
// convergence task carries no targetNodeId and no required tags, so claimNextQueueTask's
// untargeted candidate query matched it for every idle worktree session that genuinely
// owns its own workspace/stamp — and each one passed the scope guard for its OWN node.
// Result: N sibling worktree sessions each claim the same convergence intent and race a
// multi-worktree push + production-deploy (the "4중 fan-out" the ff-guard luckily caught).
//
// These tests drive tryAssignQueueTask directly: every worktree session is correctly
// scoped to its own node (so the WTCLAIM/WTDISPATCH guard passes), proving the NEW
// convergence base-only gate (claimNextQueueTask nodeIsWorktree) is what blocks the
// fan-out — not the prior cross-node scope check.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-wtfanout-test-${randomUUID().slice(0, 8)}`)
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

import { tryAssignQueueTask } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'

const WT_A = 'node_wta'
const WT_B = 'node_wtb'
const BASE_NODE = 'node_base'
const WS_A = '/repo/wt-a'
const WS_B = '/repo/wt-b'
const WS_BASE = '/repo/main'

type Sess = { sessionId: string; workspace: string; meshNodeId?: string }

function createComponents(meshId: string, sessions: Sess[]) {
  const instances = sessions.map((s) => {
    const settings: Record<string, unknown> = { meshNodeFor: meshId, providerType: 'claude-cli' }
    if (s.meshNodeId !== undefined) settings.meshNodeId = s.meshNodeId
    return {
      getState: () => ({ settings, status: 'idle', instanceId: s.sessionId, type: 'claude-cli', workspace: s.workspace }),
      updateSettings: vi.fn(),
    }
  })
  return {
    instanceManager: {
      getInstance: vi.fn((sid: string) => instances.find((i) => i.getState().instanceId === sid)),
      getByCategory: vi.fn((category: string) => (category === 'cli' ? instances : [])),
    },
    cliManager: {
      adapters: new Map<string, { workingDir: string }>(),
      handleCliCommand: vi.fn(async () => ({ success: true })),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
    },
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string, nodes: any[]) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'WTFANOUT Mesh', policy: {}, nodes })
}

const node = (id: string, workspace: string, overrides: any = {}) =>
  ({ id, workspace, repoRoot: workspace, policy: {}, ...overrides })

function statusOf(meshId: string, taskId: string) {
  return getQueue(meshId).find((t) => t.id === taskId)
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('WTDISPATCH-FANOUT — convergence task is base-only (worktree claim refused)', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('(i) ZERO fan-out: every sibling worktree session refuses an untargeted convergence task; base claims it', () => {
    const meshId = `mesh_wtf_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [
        node(WT_A, WS_A, { isLocalWorktree: true }),
        node(WT_B, WS_B, { isLocalWorktree: true }),
        node(BASE_NODE, WS_BASE),
      ])
      // Each worktree session is CORRECTLY bound to its own node — so the prior
      // cross-node/workspace scope guard passes; only the new convergence gate can refuse.
      const components = createComponents(meshId, [
        { sessionId: 'sess-A', workspace: WS_A, meshNodeId: WT_A },
        { sessionId: 'sess-B', workspace: WS_B, meshNodeId: WT_B },
        { sessionId: 'sess-base', workspace: WS_BASE, meshNodeId: BASE_NODE },
      ])
      const task = enqueueTask(meshId, 'MERGE+PUSH+DEPLOY', { taskMode: 'convergence',
    difficulty: 'medium',
})

      // Both worktree sessions, each driven toward its OWN node, MUST be refused — the
      // fan-out that put one convergence intent into 4 sibling worktree sessions.
      expect(tryAssignQueueTask(components, meshId, WT_A, 'sess-A', 'claude-cli')).toBe(false)
      expect(tryAssignQueueTask(components, meshId, WT_B, 'sess-B', 'claude-cli')).toBe(false)
      expect(statusOf(meshId, task.id)?.status).toBe('pending')

      // The base node claims it — convergence lands on base.
      expect(tryAssignQueueTask(components, meshId, BASE_NODE, 'sess-base', 'claude-cli')).toBe(true)
      expect(statusOf(meshId, task.id)?.assignedSessionId).toBe('sess-base')
      expect(statusOf(meshId, task.id)?.assignedNodeId).toBe(BASE_NODE)
    } finally {
      cleanup(meshId)
    }
  })

  it('(ii) target-pinned convergence to base is NOT claimable by a worktree session even when node-scoped correctly', () => {
    const meshId = `mesh_wtf_pin_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [
        node(WT_A, WS_A, { isLocalWorktree: true }),
        node(BASE_NODE, WS_BASE),
      ])
      const components = createComponents(meshId, [
        { sessionId: 'sess-A', workspace: WS_A, meshNodeId: WT_A },
        { sessionId: 'sess-base', workspace: WS_BASE, meshNodeId: BASE_NODE },
      ])
      const task = enqueueTask(meshId, 'converge', { taskMode: 'convergence', targetNodeId: BASE_NODE,
    difficulty: 'medium',
})

      // Worktree session can never claim a base-pinned convergence task.
      expect(tryAssignQueueTask(components, meshId, WT_A, 'sess-A', 'claude-cli')).toBe(false)
      expect(statusOf(meshId, task.id)?.status).toBe('pending')

      expect(tryAssignQueueTask(components, meshId, BASE_NODE, 'sess-base', 'claude-cli')).toBe(true)
      expect(statusOf(meshId, task.id)?.assignedSessionId).toBe('sess-base')
    } finally {
      cleanup(meshId)
    }
  })

  it('(iii) regression: a code_change task on a worktree node still claims normally', () => {
    const meshId = `mesh_wtf_cc_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(WT_A, WS_A, { isLocalWorktree: true })])
      const components = createComponents(meshId, [{ sessionId: 'sess-A', workspace: WS_A, meshNodeId: WT_A }])
      const task = enqueueTask(meshId, 'do work', { taskMode: 'code_change', targetNodeId: WT_A,
    difficulty: 'medium',
})

      expect(tryAssignQueueTask(components, meshId, WT_A, 'sess-A', 'claude-cli')).toBe(true)
      expect(statusOf(meshId, task.id)?.assignedSessionId).toBe('sess-A')
    } finally {
      cleanup(meshId)
    }
  })

  it('(iv) regression: convergence task on a single base node (no worktrees) claims fine', () => {
    const meshId = `mesh_wtf_base_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(BASE_NODE, WS_BASE)])
      const components = createComponents(meshId, [{ sessionId: 'sess-base', workspace: WS_BASE, meshNodeId: BASE_NODE }])
      const task = enqueueTask(meshId, 'land it', { taskMode: 'convergence', targetNodeId: BASE_NODE,
    difficulty: 'medium',
})

      expect(tryAssignQueueTask(components, meshId, BASE_NODE, 'sess-base', 'claude-cli')).toBe(true)
      expect(statusOf(meshId, task.id)?.assignedSessionId).toBe('sess-base')
    } finally {
      cleanup(meshId)
    }
  })
})
