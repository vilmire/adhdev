import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// QUOTA-CLAIM-GATE-LEDGER: the quota claim gate (tryAssignQueueTask → evaluateProviderQuotaGate)
// previously only logged a block (LOG.info) with no ledger trace at all. This matters
// specifically for MAGI: a kind-panel replica is pinned to ONE (node, provider) via
// requiredTags, so a quota-exhausted pinned provider has no fallback candidate to escape to —
// the replica just parks pending indefinitely with nothing in the ledger to diagnose why.
//
// These tests drive the same LOCAL idle drain path (triggerMeshQueue) as
// mesh-quota-claim-gate.test.ts and assert on the ledger side effect: a 'quota_claim_gate'
// entry appears on the transition INTO a block, a 'quota_claim_gate' cleared entry appears
// when the block resolves, and — critically — repeated unchanged-block reconcile ticks do
// NOT append a new entry each time (the same transition-dedup discipline as the existing
// log-line fingerprinting).

const testTmpDir = path.join(tmpdir(), `adhdev-mesh-quota-claim-ledger-test-${randomUUID().slice(0, 8)}`)
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
import { evaluateQuotaClaimGateForAssignment } from '../../src/mesh/mesh-queue-claim-gate.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { __clearMeshLedgerForTests, readLedgerEntries } from '../../src/mesh/mesh-ledger.js'

const NODE_ID = 'node_quota_ledger'
const NODE_WS = '/repo/quota-ledger'

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
  meshConfigMocks.getMesh.mockReturnValue({ id: meshId, name: 'QUOTA-CLAIM-LEDGER Mesh', policy: quotaRouting ? { quotaRouting } : {}, nodes })
}

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

const codexQuota = (over: Record<string, any> = {}) => ({
  provider: 'codex-cli',
  status: 'ok',
  session: { usedPercent: 50, windowMinutes: 300, resetsAt: null },
  weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
  updatedAt: Date.now(),
  error: null,
  ...over,
})

const antigravityQuota = () => ({
  provider: 'antigravity-cli',
  status: 'ok',
  session: { usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() + 4 * 60 * 60_000 },
  weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + 3 * 24 * 60 * 60_000 },
  buckets: [
    { name: 'Gemini Models · Five Hour Limit Remaining', usedPercent: 8, windowMinutes: 300, resetsAt: Date.now() + 4 * 60 * 60_000 },
    { name: 'Gemini Models · Weekly Limit Remaining', usedPercent: 8, windowMinutes: 10080, resetsAt: Date.now() + 3 * 24 * 60 * 60_000 },
    { name: 'Claude/GPT · Five Hour Limit Remaining', usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() + 4 * 60 * 60_000 },
    { name: 'Claude/GPT · Weekly Limit Remaining', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + 3 * 24 * 60 * 60_000 },
  ],
  updatedAt: Date.now(),
  error: null,
})

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __clearMeshLedgerForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('QUOTA-CLAIM-GATE-LEDGER — quota claim gate transitions are recorded in the ledger', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('uses the selected slot model for the post-launch claim gate', () => {
    const meshId = `mesh_quota_ledger_model_${randomUUID().slice(0, 8)}`
    try {
      const node = quotaNode({ 'antigravity-cli': antigravityQuota() })
      setMesh(meshId, [node])
      const components = createComponents(meshId, [])
      const base = {
        meshId,
        nodeId: NODE_ID,
        providerType: 'antigravity-cli',
        trigger: 'auto_launch',
        node,
        mesh: meshConfigMocks.getMesh(),
        providerLoader: components.providerLoader,
      }

      expect(evaluateQuotaClaimGateForAssignment({
        ...base,
        sessionId: 'sess-gemini',
        model: 'Gemini 3.1 Pro (High)',
      })).toBe(false)
      expect(evaluateQuotaClaimGateForAssignment({
        ...base,
        sessionId: 'sess-claude',
        model: 'Claude Sonnet 4.6 (Thinking)',
      })).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  it('records a quota_claim_gate "blocked" entry the first time the gate refuses a claim', async () => {
    const meshId = `mesh_quota_ledger_block_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ session: { usedPercent: 95, windowMinutes: 300, resetsAt: null } }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      await triggerMeshQueue(components, meshId)

      const entries = readLedgerEntries(meshId, { kind: ['quota_claim_gate'] })
      expect(entries).toHaveLength(1)
      expect(entries[0].payload).toMatchObject({
        phase: 'blocked',
        nodeId: NODE_ID,
        sessionId: 'sess-quota',
        providerType: 'claude-cli',
        reason: expect.any(String),
        trigger: 'idle_claim_scan',
        previouslyBlocked: false,
      })
      expect((entries[0].payload as any).pinOverride).toBeUndefined()
      expect((entries[0].payload as any).candidateTaskId).toBeUndefined()
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT append a new entry on repeated reconcile ticks while the block is unchanged (no flood)', async () => {
    const meshId = `mesh_quota_ledger_noflood_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ session: { usedPercent: 95, windowMinutes: 300, resetsAt: null } }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      // Five reconcile ticks with the identical quota snapshot — mirrors the ~4s reconcile
      // loop hammering an unresolved block for minutes/hours in production.
      for (let i = 0; i < 5; i += 1) {
        await triggerMeshQueue(components, meshId)
      }

      const entries = readLedgerEntries(meshId, { kind: ['quota_claim_gate'] })
      expect(entries).toHaveLength(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('records a NEW "blocked" entry when the block reason/window changes while still blocked', async () => {
    const meshId = `mesh_quota_ledger_reblock_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ session: { usedPercent: 95, windowMinutes: 300, resetsAt: null } }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      await triggerMeshQueue(components, meshId)
      // Still blocked, but a DIFFERENT window/remaining% — a genuine transition, not noise.
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: null } }),
      })], { weeklyMinRemainingPercent: 50 })
      await triggerMeshQueue(components, meshId)

      const entries = readLedgerEntries(meshId, { kind: ['quota_claim_gate'] })
      expect(entries.length).toBeGreaterThanOrEqual(2)
      expect(entries.every(e => (e.payload as any).phase === 'blocked')).toBe(true)
      expect(entries.every(e => (e.payload as any).trigger === 'idle_claim_scan')).toBe(true)
    } finally {
      cleanup(meshId)
    }
  })

  it('records a "cleared" entry once the quota recovers and the claim succeeds', async () => {
    const meshId = `mesh_quota_ledger_clear_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({
        'claude-cli': claudeQuota({ session: { usedPercent: 95, windowMinutes: 300, resetsAt: null } }),
      })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      enqueueTask(meshId, 'do quota-gated work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      await triggerMeshQueue(components, meshId)
      expect(getQueue(meshId).find(t => t.status === 'pending')).toBeTruthy()

      // Window resets, node reports fresh headroom.
      setMesh(meshId, [quotaNode({ 'claude-cli': claudeQuota() })])
      const second = await triggerMeshQueue(components, meshId)
      expect(second.claimed).toBe(true)

      const entries = readLedgerEntries(meshId, { kind: ['quota_claim_gate'] })
      const phases = entries.map(e => (e.payload as any).phase)
      expect(phases).toEqual(['blocked', 'cleared'])
    } finally {
      cleanup(meshId)
    }
  })

  it('never records a "cleared" entry for a (node,session,provider) that was never blocked (no per-claim noise)', async () => {
    const meshId = `mesh_quota_ledger_never_blocked_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({ 'claude-cli': claudeQuota() })])
      const components = createComponents(meshId, [
        { sessionId: 'sess-quota', workingDir: NODE_WS, meshNodeId: NODE_ID },
      ])
      enqueueTask(meshId, 'ordinary work', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })

      const result = await triggerMeshQueue(components, meshId)
      expect(result.claimed).toBe(true)

      const entries = readLedgerEntries(meshId, { kind: ['quota_claim_gate'] })
      expect(entries).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('records "overridden_by_pin" (not "blocked") when a provider-pinned task is claimed through a low quota gate', async () => {
    const meshId = `mesh_quota_ledger_pin_override_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, [quotaNode({ 'codex-cli': codexQuota({ weekly: { usedPercent: 86, windowMinutes: 10080, resetsAt: null } }) })], { weeklyMinRemainingPercent: 25 })
      const components = createComponents(meshId, [
        { sessionId: 'sess-codex', workingDir: NODE_WS, meshNodeId: NODE_ID, providerType: 'codex-cli' },
      ])
      const pinnedTaskId = `task-pin-${randomUUID().slice(0, 8)}`
      enqueueTask(meshId, 'pinned codex work', {
        id: pinnedTaskId,
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        difficulty: 'medium',
        requiredTags: ['provider=codex-cli'],
      })

      const result = await triggerMeshQueue(components, meshId)
      expect(result.claimed).toBe(true)

      const entries = readLedgerEntries(meshId, { kind: ['quota_claim_gate'] })
      expect(entries).toHaveLength(1)
      expect(entries[0].payload).toMatchObject({
        phase: 'overridden_by_pin',
        nodeId: NODE_ID,
        sessionId: 'sess-codex',
        providerType: 'codex-cli',
        reason: 'provider_quota_weekly_low',
        window: 'weekly',
        remainingPercent: 14,
        thresholdPercent: 25,
        trigger: 'idle_claim_scan',
        pinOverride: true,
        candidateTaskId: pinnedTaskId,
      })
    } finally {
      cleanup(meshId)
    }
  })
})
