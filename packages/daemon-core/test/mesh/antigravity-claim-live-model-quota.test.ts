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
import { tryAssignQueueTask } from '../../src/mesh/mesh-queue-assignment.js'
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
      instanceId: s.sessionId,
      settings,
      getState: vi.fn(() => ({
        settings,
        status: s.status ?? 'idle',
        instanceId: s.sessionId,
        type: s.providerType ?? 'claude-cli',
        workspace: s.workingDir,
        controlValues: s.model ? { model: s.model } : undefined,
      })),
      updateSettings: vi.fn(),
    }
  })
  return withMeshRouter({
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
      getInstance: vi.fn((sid: string) => cliInstances.find((i) => i.instanceId === sid)),
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


describe('queue projection operation counts', () => {
  it.each([
    ['Claude Opus 4.6 (Thinking)', true],
    ['Gemini 4 Argon (Medium)', false],
  ] as const)('projects the missing-slot-model quota/lineage claim once: %s', (model, accepted) => {
    const meshId = `mesh_claim_once_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({ 'antigravity-cli': agyQuota() })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-once', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'antigravity-cli', model },
      ])
      const inst = components.instanceManager.getInstance('sess-once')
      const task = enqueueTask(meshId, 'live model quota', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-once', 'antigravity-cli')).toBe(accepted)
      expect(inst.getState).toHaveBeenCalledTimes(1)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe(accepted ? 'assigned' : 'pending')
    } finally { cleanup(meshId) }
  })

  it('skips running and foreign sessions without projection, then claims on a fresh idle edge', async () => {
    const meshId = `mesh_hot_edge_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode(undefined)])
      const session = { sessionId: 'sess-hot', workingDir: NODE_WS, meshNodeId: NODE_ID, status: 'generating' }
      const components = createComponents(meshId, [session])
      const inst = components.instanceManager.getInstance(session.sessionId)
      inst.lastStatus = 'generating'
      inst.getHotChatSessionState = vi.fn(() => ({ id: session.sessionId, status: session.status }))
      const foreign = { instanceId: 'foreign', settings: { meshNodeFor: 'another-mesh' }, getState: vi.fn(() => { throw new Error('foreign projection') }) }
      components.instanceManager.getByCategory.mockReturnValue([foreign, inst])
      for (let i = 0; i < 3; i++) await triggerMeshQueue(components, meshId)
      expect(inst.getState).not.toHaveBeenCalled()
      expect(foreign.getState).not.toHaveBeenCalled()
      session.status = 'idle'
      inst.lastStatus = 'idle'
      const task = enqueueTask(meshId, 'idle edge work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      expect((await triggerMeshQueue(components, meshId)).claimed).toBe(true)
      expect(getQueue(meshId).find(t => t.id === task.id)?.assignedSessionId).toBe(session.sessionId)
      expect(foreign.getState).not.toHaveBeenCalled()
    } finally { cleanup(meshId) }
  })

  it.each(['idle', 'generating'])('does not starve full idle behind hot generating when FSM is %s', async lastStatus => {
    const meshId = `mesh_hot_stale_${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      setMesh(meshId, [quotaNode(undefined)])
      const components = createComponents(meshId, [{ sessionId: 'sess-stale', workingDir: NODE_WS, meshNodeId: NODE_ID }])
      const inst = components.instanceManager.getInstance('sess-stale')
      inst.lastStatus = lastStatus
      inst.getHotChatSessionState = vi.fn(() => ({ id: 'sess-stale', status: 'generating' }))
      await triggerMeshQueue(components, meshId)
      if (lastStatus === 'generating') {
        expect(inst.getState).not.toHaveBeenCalled()
        clock.mockReturnValue(now + 20_000)
      }
      const task = enqueueTask(meshId, 'fallback work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      expect((await triggerMeshQueue(components, meshId)).claimed).toBe(true)
      expect(getQueue(meshId).find(t => t.id === task.id)?.assignedSessionId).toBe('sess-stale')
    } finally { clock.mockRestore(); cleanup(meshId) }
  })
})


describe('queue projection safety fallbacks', () => {
  it('keeps the lineage fence before claim while using one state', () => {
    const meshId = `mesh_lineage_once_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode(undefined)])
      const components = createComponents(meshId, [{ sessionId: 'wrong-node', workingDir: NODE_WS, meshNodeId: 'another-node' }])
      const inst = components.instanceManager.getInstance('wrong-node')
      const task = enqueueTask(meshId, 'bound work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      expect(tryAssignQueueTask(components, meshId, NODE_ID, 'wrong-node', 'claude-cli')).toBe(false)
      expect(inst.getState).toHaveBeenCalledTimes(1)
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally { cleanup(meshId) }
  })

  it.each(['missing', 'throw', 'unknown'])('projects idle when the hot view is %s', async kind => {
    const meshId = `mesh_hot_fallback_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode(undefined)])
      const components = createComponents(meshId, [{ sessionId: 'fallback', workingDir: NODE_WS, meshNodeId: NODE_ID }])
      const inst = components.instanceManager.getInstance('fallback')
      inst.lastStatus = 'generating'
      if (kind !== 'missing') inst.getHotChatSessionState = () => {
        if (kind === 'throw') throw new Error('unavailable')
        return { id: 'fallback', status: 'unknown' }
      }
      enqueueTask(meshId, 'fallback work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
      expect((await triggerMeshQueue(components, meshId)).claimed).toBe(true)
      expect(inst.getState).toHaveBeenCalled()
    } finally { cleanup(meshId) }
  })
})
