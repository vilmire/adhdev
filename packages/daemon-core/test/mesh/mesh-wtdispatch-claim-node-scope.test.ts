import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// WTDISPATCH — residual of WTCLAIM (4c5b30b1). The cross-node claim guard in
// tryAssignQueueTask only engaged for a session whose adapter sat in cliManager.adapters.
// A coordinator-auto-launched worker session can be observed ONLY via instanceManager (its
// session-host record shows no_node_binding), and the event-driven / remote-idle drain can
// pass a nodeId belonging to a SIBLING worktree node on the SAME daemon. Without a guard on
// that path, session A pulls node B's task and node A's task is left with no session to claim
// it — it never dispatches (no task_dispatched ledger entry → the live "task A 증발" symptom).
//
// These tests drive tryAssignQueueTask directly with sessions present ONLY in instanceManager
// (cliManager.adapters is empty), exercising the broadened resolution: workspace + stamped
// meshNodeId, fail-closed on either mismatch. The cliManager.adapters path is covered by
// mesh-wtclaim-claim-workspace-scope.test.ts.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-wtdispatch-test-${randomUUID().slice(0, 8)}`)
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

const NODE_A = 'node_adede'
const NODE_B = 'node_509d'
const BASE_NODE = 'node_base'
const WS_A = '/repo/wt-a'
const WS_B = '/repo/wt-b'
const WS_BASE = '/repo/main'

type Sess = { sessionId: string; workspace: string; meshNodeId?: string }

// Sessions live ONLY in instanceManager (NOT cliManager.adapters) — the path the
// adapter-only WTCLAIM check never reached.
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
      adapters: new Map<string, { workingDir: string }>(), // intentionally EMPTY
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
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'WTDISPATCH Mesh', policy: {}, nodes })
}

// No daemonId → tryAssignQueueTask takes the local stamp+dispatch branch (no P2P forward).
const node = (id: string, workspace?: string, overrides: any = {}) =>
  ({ id, ...(workspace !== undefined ? { workspace, repoRoot: workspace } : {}), policy: {}, ...overrides })

function statusOf(meshId: string, taskId: string) {
  return getQueue(meshId).find((t) => t.id === taskId)
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('WTDISPATCH — sibling-worktree claim node scope (instanceManager-resolved path)', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('(i) ZERO cross-leak: sibling worktree sessions each claim only their own node task; no task vanishes', () => {
    const meshId = `mesh_wtd_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(NODE_A, WS_A, { isLocalWorktree: true }), node(NODE_B, WS_B, { isLocalWorktree: true })])
      // Both worker sessions came up WITHOUT a meshNodeId binding (no_node_binding) — the live symptom.
      const components = createComponents(meshId, [
        { sessionId: 'sess-A', workspace: WS_A },
        { sessionId: 'sess-B', workspace: WS_B },
      ])
      const taskA = enqueueTask(meshId, 'MARKER-ALPHA', { targetNodeId: NODE_A, taskMode: 'code_change',
    difficulty: 'medium',
})
      const taskB = enqueueTask(meshId, 'MARKER-BRAVO', { targetNodeId: NODE_B, taskMode: 'code_change',
    difficulty: 'medium',
})

      // Session A (real workspace WS_A) is driven toward node B — the cross-claim that leaked B
      // onto A in the live repro. It MUST be refused, and B MUST stay pending for B's own session.
      expect(tryAssignQueueTask(components, meshId, NODE_B, 'sess-A', 'claude-cli')).toBe(false)
      expect(statusOf(meshId, taskB.id)?.status).toBe('pending')

      // Each session claims exactly its own node's task.
      expect(tryAssignQueueTask(components, meshId, NODE_A, 'sess-A', 'claude-cli')).toBe(true)
      expect(tryAssignQueueTask(components, meshId, NODE_B, 'sess-B', 'claude-cli')).toBe(true)

      expect(statusOf(meshId, taskA.id)?.assignedSessionId).toBe('sess-A')
      expect(statusOf(meshId, taskB.id)?.assignedSessionId).toBe('sess-B')
    } finally {
      cleanup(meshId)
    }
  })

  it('(i-stamp) fail-closed on a stamped node identity mismatch even when workspaces are undeclared', () => {
    const meshId = `mesh_wtd_stamp_${randomUUID().slice(0, 8)}`
    try {
      // Neither node declares a workspace — only the session's stamped meshNodeId can tell them apart.
      setMesh(meshId, [node(NODE_A), node(NODE_B)])
      const components = createComponents(meshId, [
        { sessionId: 'sess-A', workspace: WS_A, meshNodeId: NODE_A },
      ])
      const taskB = enqueueTask(meshId, 'MARKER-BRAVO', { targetNodeId: NODE_B, taskMode: 'code_change',
    difficulty: 'medium',
})

      // Session A is bound (stamped) to node A; a claim for node B is a cross-node leak.
      expect(tryAssignQueueTask(components, meshId, NODE_B, 'sess-A', 'claude-cli')).toBe(false)
      expect(statusOf(meshId, taskB.id)?.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })

  it('(ii) target-node session absent: the task stays pending (not stolen, not vanished)', () => {
    const meshId = `mesh_wtd_pending_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(NODE_A, WS_A, { isLocalWorktree: true }), node(NODE_B, WS_B, { isLocalWorktree: true })])
      // Only node B's session exists; node A's target task has no correctly-scoped session.
      const components = createComponents(meshId, [{ sessionId: 'sess-B', workspace: WS_B }])
      const taskA = enqueueTask(meshId, 'MARKER-ALPHA', { targetNodeId: NODE_A, taskMode: 'code_change',
    difficulty: 'medium',
})
      const taskB = enqueueTask(meshId, 'MARKER-BRAVO', { targetNodeId: NODE_B, taskMode: 'code_change',
    difficulty: 'medium',
})

      // Node B's session must NOT absorb node A's task; A waits for its own node.
      expect(tryAssignQueueTask(components, meshId, NODE_A, 'sess-B', 'claude-cli')).toBe(false)
      expect(statusOf(meshId, taskA.id)?.status).toBe('pending')

      // It still claims its own task normally.
      expect(tryAssignQueueTask(components, meshId, NODE_B, 'sess-B', 'claude-cli')).toBe(true)
      expect(statusOf(meshId, taskB.id)?.assignedSessionId).toBe('sess-B')
    } finally {
      cleanup(meshId)
    }
  })

  it('(iii) regression: single base node — a matching session claims its fresh-enqueued task', () => {
    const meshId = `mesh_wtd_base_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(BASE_NODE, WS_BASE)])
      const components = createComponents(meshId, [{ sessionId: 'sess-base', workspace: WS_BASE, meshNodeId: BASE_NODE }])
      const task = enqueueTask(meshId, 'do base work', { targetNodeId: BASE_NODE, taskMode: 'code_change',
    difficulty: 'medium',
})

      expect(tryAssignQueueTask(components, meshId, BASE_NODE, 'sess-base', 'claude-cli')).toBe(true)
      expect(statusOf(meshId, task.id)?.assignedSessionId).toBe('sess-base')
    } finally {
      cleanup(meshId)
    }
  })

  it('(iv) conservative: node declares no workspace and session carries no stamp → claim is NOT starved', () => {
    const meshId = `mesh_wtd_cons_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [node(BASE_NODE)]) // no workspace declared
      const components = createComponents(meshId, [{ sessionId: 'sess-x', workspace: WS_A }]) // no meshNodeId stamp
      const task = enqueueTask(meshId, 'do work', { targetNodeId: BASE_NODE, taskMode: 'code_change',
    difficulty: 'medium',
})

      // Neither the node workspace nor a stamp is resolvable → fall through to prior behavior.
      expect(tryAssignQueueTask(components, meshId, BASE_NODE, 'sess-x', 'claude-cli')).toBe(true)
      expect(statusOf(meshId, task.id)?.assignedSessionId).toBe('sess-x')
    } finally {
      cleanup(meshId)
    }
  })
})
