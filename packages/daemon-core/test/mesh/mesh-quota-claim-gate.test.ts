import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// QUOTA GATE (claim path). The auto-launch loop already gated SPAWNING a session on a
// quota-exhausted (node, provider), but an already-IDLE session on that node claimed the
// pending task anyway — tryAssignQueueTask never looked at quota. The same
// evaluateProviderQuotaGate now gates the claim funnel: a fresh 'ok' snapshot showing the
// session/weekly window below threshold leaves the task pending (WAIT semantics — the window
// resets), and the drain moves on to the next candidate. Missing/stale/non-'ok' snapshots
// fail OPEN, and a session reset within sessionResetImminentMs waives the session block.
//
// These tests drive the LOCAL idle drain path (triggerMeshQueue), the very path that pulled
// tasks onto exhausted nodes in production — mirroring mesh-worktree-claim-gate-bypass.test.ts,
// the sibling claim-funnel gate.

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-quota-claim-test-${randomUUID().slice(0, 8)}`)
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

const NODE_ID = 'node_quota'
const NODE_WS = '/repo/quota'
const MIN = 60 * 1000

type LocalSession = {
  sessionId: string
  workingDir: string
  meshNodeId?: string
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
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'QUOTA-CLAIM Mesh', policy: {}, nodes })
}

// Fresh quota bundle stamped on the local clock (the claim path evaluates with Date.now()).
const quotaNode = (quota: Record<string, any> | undefined, overrides: any = {}) => ({
  id: NODE_ID,
  daemonId: 'daemon-local',
  workspace: NODE_WS,
  repoRoot: NODE_WS,
  policy: {},
  nodeFacts: {
    schemaVersion: 1,
    reportedAt: Date.now(),
    ...(quota ? { quota } : {}),
  },
  ...overrides,
})

const claudeQuota = (over: Record<string, any> = {}) => ({
  provider: 'claude-cli',
  status: 'ok',
  session: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
  weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
  updatedAt: Date.now(),
  error: null,
  ...over,
})

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('QUOTA GATE (claim path) — idle session on an exhausted node cannot claim', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('REFUSES the claim when the session window is below threshold — task stays pending', async () => {
    const meshId = `mesh_quota_claim_block_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ session: { usedPercent: 95, windowMinutes: 300, resetsAt: null } }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const result = await triggerMeshQueue(components, meshId)

      // The candidate was observed but the quota gate refused the claim.
      expect(result.localIdleSessionsChecked).toBe(1)
      expect(result.claimed).toBe(false)
      expect(result.newlyAssignedTasks).toEqual([])
      // WAIT semantics: the task is left PENDING (not failed/cancelled) so the claim
      // re-fires once the window resets.
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      // No dispatch ever happened onto the exhausted node.
      expect(components.cliManager.handleCliCommand).not.toHaveBeenCalled()
    } finally {
      cleanup(meshId)
    }
  })

  it('ALLOWS the claim once the reported quota recovers (refire passes)', async () => {
    const meshId = `mesh_quota_claim_recover_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ session: { usedPercent: 95, windowMinutes: 300, resetsAt: null } }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const first = await triggerMeshQueue(components, meshId)
      expect(first.claimed).toBe(false)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')

      // The window reset and the node reported fresh headroom; the refired drain claims.
      setMesh(meshId, [quotaNode({ 'claude-cli': claudeQuota() })])
      const second = await triggerMeshQueue(components, meshId)

      expect(second.claimed).toBe(true)
      expect(second.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: NODE_ID, sessionId: 'sess-quota' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })

  it('ALLOWS the claim when the session reset is imminent (< sessionResetImminentMs)', async () => {
    const meshId = `mesh_quota_claim_reset_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({
          session: { usedPercent: 95, windowMinutes: 300, resetsAt: Date.now() + 2 * MIN },
        }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const result = await triggerMeshQueue(components, meshId)

      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: NODE_ID, sessionId: 'sess-quota' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })

  it('fails OPEN when the reported quota is unusable (error status / stale / absent)', async () => {
    const meshId = `mesh_quota_claim_failopen_${randomUUID().slice(0, 8)}`
    try {
      // 'error' status with an exhausted-looking window: looked-and-could-not-tell is
      // not a routing signal, so the claim proceeds exactly as before quota routing.
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({
          status: 'error',
          session: { usedPercent: 99, windowMinutes: 300, resetsAt: null },
        }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      const task = enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const result = await triggerMeshQueue(components, meshId)

      expect(result.claimed).toBe(true)
      expect(result.newlyAssignedTasks).toEqual([
        expect.objectContaining({ id: task.id, nodeId: NODE_ID, sessionId: 'sess-quota' }),
      ])
    } finally {
      cleanup(meshId)
    }
  })
})
