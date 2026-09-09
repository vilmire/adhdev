import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// SESSION-CAP DEFAULT (P5, 2026-09-08 runaway follow-up): RepoMeshNodePolicy
// .maxConcurrentSessions had NO default — an unset cap made the auto-launch gate compare
// liveSessionCountForNode against Number(undefined) = NaN, every comparison false, gate
// silently skipped, unlimited spawns (23 live sessions piled onto one daemon until EMFILE
// killed it). resolveNodeMaxConcurrentSessions now supplies
// DEFAULT_NODE_MAX_CONCURRENT_SESSIONS (12) for a missing/invalid value while an explicit
// finite value >= 0 always wins.

const testTmpDir = path.join(tmpdir(), `adhdev-session-cap-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(),
  listMeshes: vi.fn(() => [] as any[]),
}))
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn(async () => ({ path: '/usr/bin/codex' })) }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests } from '../../src/mesh/mesh-queue-assignment.js'
import {
  DEFAULT_NODE_MAX_CONCURRENT_SESSIONS,
  resolveNodeMaxConcurrentSessions,
} from '../../src/repo-mesh-types.js'

const NODE_ID = 'node_main'

// A live BUSY worker session: holds its own assigned queue task, so it is excluded from
// the nodeHasLiveSessionPendingClaim gate and counts only toward liveSessionCountForNode.
function liveSession(meshId: string, sessionId: string, status = 'generating') {
  const state = {
    instanceId: sessionId,
    status,
    type: 'codex-cli',
    workspace: `/repo/${NODE_ID}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID },
  }
  return { category: 'cli', getState: () => state }
}

function createComponents(cliInstances: any[] = []) {
  return {
    instanceManager: {
      getByCategory: vi.fn((category: string) => (category === 'cli' ? cliInstances : [])),
      getInstance: vi.fn(() => undefined),
    },
    cliManager: {
      adapters: new Map(),
      handleCliCommand: vi.fn(async (command: string) =>
        command === 'launch_cli' ? { success: true, sessionId: `spawned-${randomUUID().slice(0, 6)}` } : { success: true }),
    },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      setCliDetectionResults: vi.fn(),
      getMeta: vi.fn(() => undefined),
    },
    dispatchMeshCommand: vi.fn(async () => ({ success: true })),
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function setMesh(meshId: string, nodePolicy: Record<string, unknown> = {}) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Session Cap Mesh',
    policy: {},
    nodes: [{ id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'], ...nodePolicy } }],
  })
}

// N busy sessions: each live instance holds one assigned queue task so the earlier
// pending-claim / write-isolation gates don't fire first and the run reaches the
// session-cap gate. The probe task itself is READ-ONLY for the same reason
// (nodeHasActiveAssignment applies to write tasks only).
function seedBusySessions(meshId: string, count: number): any[] {
  const instances: any[] = []
  for (let i = 0; i < count; i += 1) {
    const sessionId = `busy-sess-${i}`
    const t = enqueueTask(meshId, `occupied work ${i}`, { taskMode: 'code_change', difficulty: 'medium' })
    MeshRuntimeStore.getInstance().updateQueueEntry({
      ...t, status: 'assigned', assignedNodeId: NODE_ID, assignedSessionId: sessionId,
      updatedAt: new Date().toISOString(),
    } as any)
    instances.push(liveSession(meshId, sessionId))
  }
  return instances
}

function enqueueReadonlyProbe(meshId: string) {
  return enqueueTask(meshId, 'diagnose something', { taskMode: 'live_debug_readonly', difficulty: 'medium' })
}

function autoLaunchReason(meshId: string, taskId: string): string | undefined {
  return getQueue(meshId).find(t => t.id === taskId)?.autoLaunch?.reason
}

function launchCliCalls(components: any): number {
  return components.cliManager.handleCliCommand.mock.calls.filter((c: any[]) => c[0] === 'launch_cli').length
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('resolveNodeMaxConcurrentSessions', () => {
  it('falls back to the default for unset/invalid values and floors explicit ones', () => {
    expect(resolveNodeMaxConcurrentSessions(undefined)).toBe(DEFAULT_NODE_MAX_CONCURRENT_SESSIONS)
    // JSON null is "unset", not Number(null) = 0 ("block everything").
    expect(resolveNodeMaxConcurrentSessions(null)).toBe(DEFAULT_NODE_MAX_CONCURRENT_SESSIONS)
    expect(resolveNodeMaxConcurrentSessions(Number.NaN)).toBe(DEFAULT_NODE_MAX_CONCURRENT_SESSIONS)
    expect(resolveNodeMaxConcurrentSessions('garbage')).toBe(DEFAULT_NODE_MAX_CONCURRENT_SESSIONS)
    expect(resolveNodeMaxConcurrentSessions(-1)).toBe(DEFAULT_NODE_MAX_CONCURRENT_SESSIONS)
    // Explicit finite >= 0 always wins — 0 (block all) and low/high overrides included.
    expect(resolveNodeMaxConcurrentSessions(0)).toBe(0)
    expect(resolveNodeMaxConcurrentSessions(2)).toBe(2)
    expect(resolveNodeMaxConcurrentSessions(64.9)).toBe(64)
  })
})

describe('SESSION-CAP DEFAULT — auto-launch gate fires without an explicit maxConcurrentSessions', () => {
  afterEach(() => { vi.clearAllMocks() })

  it(`caps an unconfigured node at the default (${DEFAULT_NODE_MAX_CONCURRENT_SESSIONS}): at-cap live sessions → skip, no spawn`, async () => {
    const meshId = `mesh_cap_default_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId) // NO maxConcurrentSessions — the runaway configuration
      const busy = seedBusySessions(meshId, DEFAULT_NODE_MAX_CONCURRENT_SESSIONS)
      const components = createComponents(busy)
      const probe = enqueueReadonlyProbe(meshId)

      await triggerMeshQueue(components, meshId)

      // Pre-fix: Number(undefined) = NaN skipped this gate entirely and the launch proceeded.
      expect(autoLaunchReason(meshId, probe.id)).toBe('max_concurrent_sessions_reached')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })

  it('control: below the default cap the launch still proceeds (gate does not overfire)', async () => {
    const meshId = `mesh_cap_below_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const busy = seedBusySessions(meshId, DEFAULT_NODE_MAX_CONCURRENT_SESSIONS - 1)
      const components = createComponents(busy)
      const probe = enqueueReadonlyProbe(meshId)

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, probe.id)).not.toBe('max_concurrent_sessions_reached')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('control: an explicit HIGHER cap beats the default (default must not clobber overrides)', async () => {
    const meshId = `mesh_cap_high_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, { maxConcurrentSessions: DEFAULT_NODE_MAX_CONCURRENT_SESSIONS + 8 })
      const busy = seedBusySessions(meshId, DEFAULT_NODE_MAX_CONCURRENT_SESSIONS) // at default, below override
      const components = createComponents(busy)
      const probe = enqueueReadonlyProbe(meshId)

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, probe.id)).not.toBe('max_concurrent_sessions_reached')
      expect(launchCliCalls(components)).toBe(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: an explicit LOWER cap still enforces (pre-existing behavior preserved)', async () => {
    const meshId = `mesh_cap_low_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, { maxConcurrentSessions: 2 })
      const busy = seedBusySessions(meshId, 2)
      const components = createComponents(busy)
      const probe = enqueueReadonlyProbe(meshId)

      await triggerMeshQueue(components, meshId)

      expect(autoLaunchReason(meshId, probe.id)).toBe('max_concurrent_sessions_reached')
      expect(launchCliCalls(components)).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })
})
