import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Review follow-up (finding 2): idle-drain / agent:ready claims carry no routing decision, so the
// claim gate must judge an Antigravity session by its LIVE model's pool. Original header:
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

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-agy-claim-model-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => ({ machineId: 'test-machine' } as any).machineId,
  getMachineNickname: () => ({ machineId: 'test-machine' } as any).machineNickname ?? null,
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
import { withMeshRouter } from './helpers/mesh-router-stub.js'

const NODE_ID = 'node_quota'
const NODE_WS = '/repo/quota'
const MIN = 60 * 1000

type LocalSession = {
  sessionId: string
  workingDir: string
  meshNodeId?: string
  providerType?: string
  status?: string
  model?: string
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
        controlValues: s.model ? { model: s.model } : undefined,
      }),
      updateSettings: vi.fn(),
    }
  })
  return withMeshRouter({
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
  } as any)
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

const MINUTE = 60 * 1000
const agyBucket = (group: string, name: string, usedPercent: number, windowMinutes: number) => ({
  name, group, usedPercent, windowMinutes,
  resetsAt: Date.now() + (windowMinutes === 10080 ? 2000 : 60) * MINUTE,
})
// Owner shape: Gemini weekly 0% left (5h disabled); Claude/GPT weekly 55.65% left, 5h 100% left.
const agyQuota = () => ({
  provider: 'antigravity-cli',
  status: 'ok',
  session: { usedPercent: 0, windowMinutes: 300, resetsAt: Date.now() + 60 * MINUTE },
  weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + 2000 * MINUTE },
  buckets: [
    agyBucket('gemini', 'Gemini Models · Weekly Limit Remaining', 100, 10080),
    agyBucket('claude-gpt', 'Claude and GPT models · Weekly Limit Remaining', 44.35, 10080),
    agyBucket('claude-gpt', 'Claude and GPT models · Five Hour Limit Remaining', 0, 300),
  ],
  updatedAt: Date.now(),
  error: null,
})

describe('QUOTA GATE (claim path, no routing decision) — judged by the live model of the claiming session', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('a Claude/GPT AGY session claims despite the 100%-used blended weekly', async () => {
    const meshId = `mesh_agy_claim_claude_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({ 'antigravity-cli': agyQuota() })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-agy', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'antigravity-cli', model: 'Claude Opus 4.6 (Thinking)' },
      ])
      enqueueTask(meshId, 'claude pool work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      const result = await triggerMeshQueue(components, meshId)
      expect(result.claimed).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  it('a Gemini AGY session is refused by its own exhausted pool', async () => {
    const meshId = `mesh_agy_claim_gemini_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({ 'antigravity-cli': agyQuota() })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-agy', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'antigravity-cli', model: 'Gemini 4 Argon (Medium)' },
      ])
      const task = enqueueTask(meshId, 'gemini pool work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      const result = await triggerMeshQueue(components, meshId)
      expect(result.claimed).toBe(false)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })
})
