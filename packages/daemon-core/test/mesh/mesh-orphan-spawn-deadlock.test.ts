import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// ORPHAN-SPAWN-DEADLOCK (mission 1b2f2bb6). An idle, unassigned session whose claims the idle
// drain refuses with `parallel_cap_reached` used to keep the auto-launch spawn gate
// (`node_has_live_session_pending_claim`) shut: the gate only asked "is a live, unassigned,
// provider-compatible session here?", never "can it actually claim?". Result, measured live:
// the task waited for a manual mesh_cleanup_sessions or the 30-min idle TTL reaper.
//
// The fix propagates the claim refusal into the spawn gate — WITHOUT loosening the cap: the
// launch path still refuses a spawn of the capped provider itself.

const testTmpDir = path.join(tmpdir(), `adhdev-orphan-spawn-deadlock-${randomUUID().slice(0, 8)}`)
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
const detectCliMocks = vi.hoisted(() => ({ detectCLI: vi.fn(async () => ({ path: '/usr/bin/agent' })) }))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))
vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: detectCliMocks.detectCLI }))
const notifyMocks = vi.hoisted(() => ({ messages: [] as Array<{ event: string; coordinatorMessage?: string }> }))
vi.mock('../../src/mesh/turn-ledger/deliver.js', async (importOriginal) => {
  const actual: any = await importOriginal()
  return {
    ...actual,
    notifyMeshCoordinator: (notice: any) => {
      notifyMocks.messages.push({ event: notice?.event, coordinatorMessage: notice?.coordinatorMessage })
      return actual.notifyMeshCoordinator(notice)
    },
  }
})

import { triggerMeshQueue } from '../../src/mesh/mesh-events.js'
import { __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue } from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { __resetAutoLaunchAwaitClaimBackoffForTests, __resetSessionClaimRefusalsForTests, awaitInFlightAutoLaunches } from '../../src/mesh/mesh-queue-assignment.js'
import {
  noteSessionClaimRefusal,
  readRecentSessionClaimRefusal,
  sessionClaimRefusalReleasesSpawnGate,
  SESSION_CLAIM_REFUSAL_FRESH_MS,
} from '../../src/mesh/mesh-claim-refusal.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'
import { __seedAutoLaunchOrphanFirstSeenForTests, describeOrphanReclaim, ORPHAN_NOTICE_REAP_CADENCE_MS } from '../../src/mesh/mesh-autolaunch-integrity.js'
import { IDLE_SESSION_REAP_INTERVAL_MS } from '../../src/mesh/mesh-housekeeping-tick.js'

const NODE_ID = 'node_main'

function liveSession(meshId: string, sessionId: string, status: string, providerType: string) {
  const state = {
    instanceId: sessionId,
    status,
    type: providerType,
    workspace: `/repo/${NODE_ID}`,
    activeChat: null,
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, launchedByCoordinator: true },
  }
  return { category: 'cli', getState: () => state }
}

function createComponents(cliInstances: any[]) {
  return withMeshRouter({
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
  } as any)
}

// codex-cli capped at 1 on this daemon; claude-cli uncapped (when `withClaude`).
function setMesh(meshId: string, withClaude: boolean) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Orphan Spawn Mesh',
    policy: {},
    nodes: [{
      id: NODE_ID,
      workspace: `/repo/${NODE_ID}`,
      repoRoot: `/repo/${NODE_ID}`,
      policy: {
        slots: [
          { provider: 'codex-cli', maxParallel: 1 },
          ...(withClaude ? [{ provider: 'claude-cli' }] : []),
        ],
      },
    }],
  })
}

/** A read-only codex task already running on the node — it consumes the codex cap of 1. */
function seedCapHolder(meshId: string) {
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: `holder-${randomUUID().slice(0, 6)}`, meshId, message: 'running diagnosis', status: 'assigned',
    taskMode: 'live_debug_readonly', assignedNodeId: NODE_ID, assignedSessionId: 'busy-codex',
    assignedProviderType: 'codex-cli', createdAt: now, updatedAt: now,
  } as any)
}

function launchCalls(components: any): any[] {
  return components.cliManager.handleCliCommand.mock.calls.filter((c: any[]) => c[0] === 'launch_cli')
}

function autoLaunchReason(meshId: string, taskId: string): string | undefined {
  return getQueue(meshId).find(t => t.id === taskId)?.autoLaunch?.reason
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  __resetAutoLaunchAwaitClaimBackoffForTests()
  __resetSessionClaimRefusalsForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('ORPHAN-SPAWN-DEADLOCK — a cap-refused idle session no longer shuts the spawn gate', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('an idle codex session refused parallel_cap_reached lets an uncapped provider launch for the task (no TTL wait)', async () => {
    const meshId = `mesh_orphan_cap_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, true)
      seedCapHolder(meshId)
      const components = createComponents([
        liveSession(meshId, 'busy-codex', 'generating', 'codex-cli'),
        liveSession(meshId, 'orphan-codex', 'idle', 'codex-cli'),
      ])
      const task = enqueueTask(meshId, 'second diagnosis', { taskMode: 'live_debug_readonly', difficulty: 'freeform' } as any)

      await triggerMeshQueue(components, meshId)
      await awaitInFlightAutoLaunches(meshId)

      // The drain refused the orphan for the cap, and that verdict reached the gate.
      expect(readRecentSessionClaimRefusal(meshId, 'orphan-codex')?.reason).toBe('parallel_cap_reached')
      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      const launches = launchCalls(components)
      expect(launches).toHaveLength(1)
      // …and the launch went to the UNCAPPED provider — the codex cap is untouched.
      expect(JSON.stringify(launches[0][1])).toContain('claude-cli')
      expect(JSON.stringify(launches[0][1])).not.toContain('codex-cli')
    } finally {
      cleanup(meshId)
    }
  })

  it('the cap still holds: with only the capped provider on the node nothing launches', async () => {
    const meshId = `mesh_orphan_caponly_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, false)
      seedCapHolder(meshId)
      const components = createComponents([
        liveSession(meshId, 'busy-codex', 'generating', 'codex-cli'),
        liveSession(meshId, 'orphan-codex', 'idle', 'codex-cli'),
      ])
      const task = enqueueTask(meshId, 'second diagnosis', { taskMode: 'live_debug_readonly', difficulty: 'freeform' } as any)

      await triggerMeshQueue(components, meshId)
      await awaitInFlightAutoLaunches(meshId)

      expect(launchCalls(components)).toHaveLength(0)
      // Refused by the launch-side cap / slot guard, not by the (now released) pending-claim gate.
      expect(autoLaunchReason(meshId, task.id)).not.toBe('node_has_live_session_pending_claim')
      expect(getQueue(meshId).find(t => t.id === task.id)?.status).toBe('pending')
    } finally {
      cleanup(meshId)
    }
  })

  it('regression: an idle session that is NOT being refused still suppresses a duplicate launch', async () => {
    const meshId = `mesh_orphan_plain_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId, true)
      // No cap holder: the idle codex session claims the task itself on the drain.
      const components = createComponents([liveSession(meshId, 'idle-codex', 'generating', 'codex-cli')])
      const task = enqueueTask(meshId, 'work', { taskMode: 'live_debug_readonly', difficulty: 'freeform' } as any)

      await triggerMeshQueue(components, meshId)
      await awaitInFlightAutoLaunches(meshId)

      expect(autoLaunchReason(meshId, task.id)).toBe('node_has_live_session_pending_claim')
      expect(launchCalls(components)).toHaveLength(0)
    } finally {
      cleanup(meshId)
    }
  })
})

describe('session claim-refusal memory', () => {
  afterEach(() => { __resetSessionClaimRefusalsForTests() })

  it('only a FRESH parallel_cap_reached refusal releases the gate', () => {
    const now = 1_000_000
    noteSessionClaimRefusal('m', 's1', { reason: 'parallel_cap_reached', taskId: 't', atMs: now })
    expect(sessionClaimRefusalReleasesSpawnGate('m', 's1', now + 1_000)).toBe(true)
    // Stale evidence (the drain stopped refreshing it) no longer releases the gate.
    expect(sessionClaimRefusalReleasesSpawnGate('m', 's1', now + SESSION_CLAIM_REFUSAL_FRESH_MS + 1)).toBe(false)

    noteSessionClaimRefusal('m', 's2', { reason: 'dirty_workspace', atMs: now })
    expect(sessionClaimRefusalReleasesSpawnGate('m', 's2', now + 1)).toBe(false)
  })

  it('a successful claim or an empty queue clears the record', () => {
    noteSessionClaimRefusal('m', 's1', { reason: 'parallel_cap_reached' })
    noteSessionClaimRefusal('m', 's1', null)
    expect(sessionClaimRefusalReleasesSpawnGate('m', 's1')).toBe(false)

    noteSessionClaimRefusal('m', 's1', { reason: 'parallel_cap_reached' })
    noteSessionClaimRefusal('m', 's1', { reason: 'no_pending_candidates' })
    expect(readRecentSessionClaimRefusal('m', 's1')).toBeNull()
  })
})

// The orphan notice used to end "nothing reclaims it on its own" — false: the idle delegated-
// session reaper stops a coordinator-launched session idle past the mesh TTL. The overstatement
// sent the coordinator into three needless manual cleanups (mission 1b2f2bb6).
describe('orphan notice states when the idle reaper reclaims the session', () => {
  afterEach(() => { vi.clearAllMocks(); notifyMocks.messages.length = 0 })

  it('the sentence names the TTL and cadence, or says plainly that reaping is disabled', () => {
    expect(ORPHAN_NOTICE_REAP_CADENCE_MS).toBe(IDLE_SESSION_REAP_INTERVAL_MS)
    expect(describeOrphanReclaim(undefined)).toMatch(/idle for 30 min \(checked every 5 min, so up to ~35 min\)/)
    expect(describeOrphanReclaim(45)).toMatch(/idle for 45 min/)
    expect(describeOrphanReclaim(0)).toMatch(/reaper is disabled/)
  })

  it('the coordinator message carries the mesh TTL and no longer claims nothing reclaims it', async () => {
    const meshId = `mesh_orphan_notice_${randomUUID().slice(0, 8)}`
    try {
      meshConfigMocks.getMesh.mockReturnValue({
        id: meshId, name: 'Orphan Notice Mesh', policy: { delegatedSessionIdleTtlMinutes: 20 },
        nodes: [{ id: NODE_ID, workspace: `/repo/${NODE_ID}`, repoRoot: `/repo/${NODE_ID}`, policy: { providerPriority: ['codex-cli'] } }],
      })
      const task = enqueueTask(meshId, 'raced work', { taskMode: 'code_change', difficulty: 'medium' })
      MeshRuntimeStore.getInstance().updateQueueEntry({
        ...task, status: 'assigned', assignedNodeId: 'node_other', assignedSessionId: 'winner-session',
        updatedAt: new Date().toISOString(),
      } as any)
      const orphanState = {
        instanceId: 'orphan-session', status: 'idle', workspace: `/repo/${NODE_ID}`, activeChat: null,
        settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, autoLaunchedForQueueTaskId: task.id },
      }
      const components = createComponents([{ category: 'cli', getState: () => orphanState }])

      await triggerMeshQueue(components, meshId)
      __seedAutoLaunchOrphanFirstSeenForTests(meshId, 'orphan-session', Date.now() - 60_000)
      await triggerMeshQueue(components, meshId)
      await awaitInFlightAutoLaunches(meshId)

      const notice = notifyMocks.messages.find(m => m.event === 'mesh:dispatch_blocked' && m.coordinatorMessage?.includes('orphan-session'))
      expect(notice?.coordinatorMessage).toBeDefined()
      expect(notice!.coordinatorMessage).not.toMatch(/nothing reclaims it on its own/)
      expect(notice!.coordinatorMessage).toMatch(/idle-session reaper stops it once it has been idle for 20 min/)
    } finally {
      cleanup(meshId)
    }
  })
})
