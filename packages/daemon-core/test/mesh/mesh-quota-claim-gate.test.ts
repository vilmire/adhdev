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
import { LOG } from '../../src/logging/logger.js'

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

function setMesh(meshId: string, nodes: any[], quotaRouting?: Record<string, unknown>) {
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'QUOTA-CLAIM Mesh', policy: quotaRouting ? { quotaRouting } : {}, nodes })
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

  it('makes the measured claude block → codex claim fallback observable exactly once', async () => {
    const meshId = `mesh_quota_claim_fallback_${randomUUID().slice(0, 8)}`
    const info = vi.spyOn(LOG, 'info').mockImplementation(() => undefined as any)
    try {
      setMesh(meshId, [quotaNode({
        kimi: claudeQuota({
          provider: 'kimi',
          status: 'error',
          weekly: null,
          error: 'token expired',
          metadata: { source: 'oauth', failureKind: 'expired-token' },
        }),
        'claude-cli': claudeQuota({ weekly: { usedPercent: 32, windowMinutes: 10080, resetsAt: null } }),
        'codex-cli': claudeQuota({ provider: 'codex-cli', weekly: { usedPercent: 18, windowMinutes: 10080, resetsAt: null } }),
      }, {
        policy: {
          slots: [
            { provider: 'kimi', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'claude-cli', difficulty: ['difficult'], maxParallel: 1 },
            { provider: 'codex-cli', difficulty: ['difficult'], maxParallel: 1 },
          ],
        },
      })], { weeklyMinRemainingPercent: 80 })
      const components = createComponents(meshId, [
        { sessionId: 'sess-claude', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'claude-cli' },
        { sessionId: 'sess-codex', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'codex-cli' },
      ])
      const task = enqueueTask(meshId, 'today\'s difficult fallback', {
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        difficulty: 'difficult',
      })

      const first = await triggerMeshQueue(components, meshId)
      const second = await triggerMeshQueue(components, meshId)

      expect(first.claimed).toBe(true)
      expect(second.claimed).toBe(false)
      expect(getQueue(meshId).find(t => t.id === task.id)).toMatchObject({
        status: 'assigned',
        assignedProviderType: 'codex-cli',
      })
      const messages = info.mock.calls.map(([, message]) => String(message))
      expect(messages.filter(message => message.includes('deferring queue claim') && message.includes("provider 'claude-cli'") && message.includes('68.0%'))).toHaveLength(1)
      const fallback = messages.filter(message => message.includes('queue claim fallback succeeded'))
      expect(fallback).toHaveLength(1)
      expect(fallback[0]).toContain(`task ${task.id}`)
      expect(fallback[0]).toContain("provider 'claude-cli' had 68.0% weekly quota remaining")
      expect(fallback[0]).toContain("provider 'codex-cli' claimed")
    } finally {
      info.mockRestore()
      cleanup(meshId)
    }
  })

  it('logs an all-candidates-gated conclusion once and never labels it fallback success', async () => {
    const meshId = `mesh_quota_claim_all_gated_${randomUUID().slice(0, 8)}`
    const info = vi.spyOn(LOG, 'info').mockImplementation(() => undefined as any)
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ weekly: { usedPercent: 32, windowMinutes: 10080, resetsAt: null } }),
        'codex-cli': claudeQuota({ provider: 'codex-cli', weekly: { usedPercent: 19, windowMinutes: 10080, resetsAt: null } }),
      })], { weeklyMinRemainingPercent: 82 })
      const components = createComponents(meshId, [
        { sessionId: 'sess-claude-gated', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'claude-cli' },
        { sessionId: 'sess-codex-gated', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'codex-cli' },
      ])
      const task = enqueueTask(meshId, 'all gated', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'difficult' })

      await triggerMeshQueue(components, meshId)
      await triggerMeshQueue(components, meshId)

      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
      const messages = info.mock.calls.map(([, message]) => String(message))
      expect(messages.filter(message => message.includes('every idle provider candidate was quota-gated'))).toHaveLength(1)
      expect(messages.some(message => message.includes('fallback succeeded'))).toBe(false)
      expect(messages.filter(message => message.includes('deferring queue claim'))).toHaveLength(2)
    } finally {
      info.mockRestore()
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
