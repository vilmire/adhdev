import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// DISPATCH-BOOT-RACE. Live 2026-08-17: a task dispatched to a mesh node right after
// auto-launch hit the session before its CLI adapter had finished booting.
// cliManager.handleCliCommand('agent_command', ...) threw 'CLI agent not running:
// claude-cli' (findAdapter/findMeshNodeAdapter found nothing yet). The failure was
// booked retryable:true, but the retry budget was requeueCount/maxTaskRetries — the SAME
// shared counter every other requeue reason spends, defaulting to 1 — and requeueTask
// re-flipped the row straight back to 'pending' with NO delay. The very next claim (a
// few ms/seconds later, well inside the session's boot window) hit the identical
// not-yet-running adapter, failed identically, and requeueCount (now 1) met maxRetries
// (1): the task auto-failed as max_retries_exceeded in under 3 seconds — before the
// session had any realistic chance to finish booting. The worker never even saw the task.
//
// The fix: a dispatch failure (the worker never started the task) now spends its OWN
// budget — dispatchFailureCount / MAX_DISPATCH_FAILURES (mesh-work-queue.ts) — instead of
// requeueCount, and carries an escalating backoff (notBefore) so a re-dispatch lands after
// the session plausibly finished booting instead of racing the identical window again.
//
// This test pins the exact incident shape: two immediate 'CLI agent not running' dispatch
// failures on a LOCAL (cliManager.handleCliCommand) transport, then a successful dispatch
// once the adapter is "up". Reverting the fix (dispatchFailure routed through the ordinary
// requeueCount/maxRetries budget, immediately re-claimable) turns this red: the task
// auto-fails as max_retries_exceeded after exactly 2 attempts, never reaching the session
// that came up on the 3rd.

const testTmpDir = path.join(tmpdir(), `adhdev-dispatch-boot-race-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

const LOCAL_MACHINE_ID = 'mach_1111111111111111111111111111aaaa'

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: LOCAL_MACHINE_ID } as any),
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

// A LOCAL node (no daemonId): dispatch goes through cliManager.handleCliCommand, the
// exact path that threw 'CLI agent not running: claude-cli' in the live incident.
const NODE_ID = 'node_localboot0000000000000000000000000'
const WS = '/repo/boot-race'

function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Boot Race Mesh',
    policy: {},
    nodes: [{ id: NODE_ID, workspace: WS, repoRoot: WS, policy: {} }],
  })
}

function createComponents(meshId: string, handleCliCommand: (...args: any[]) => Promise<unknown>) {
  const state = {
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, providerType: 'claude-cli' },
    status: 'idle',
    instanceId: 'sess-booting',
    type: 'claude-cli',
    workspace: WS,
  }
  const instance = { getState: () => state, updateSettings: vi.fn() }
  return {
    instanceManager: {
      getInstance: vi.fn(() => instance),
      getByCategory: vi.fn((c: string) => (c === 'cli' ? [instance] : [])),
      attachMeshAssignmentToInstance: vi.fn(() => ({ stamped: true })),
    },
    // No daemonId on the node and no dispatchMeshCommand wiring needed — this forces
    // tryAssignQueueTask down the LOCAL branch (cliManager.handleCliCommand), matching
    // the live incident's transport.
    cliManager: { adapters: new Map(), handleCliCommand: vi.fn(handleCliCommand) },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      getMeta: vi.fn(() => undefined),
      setCliDetectionResults: vi.fn(),
    },
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any
}

function cleanup(meshId: string) {
  __clearMeshQueueForTests(meshId)
  __resetMeshRuntimeStoreForTests()
  meshConfigMocks.getMesh.mockReset()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

/** Let deliverTaskToSession's fire-and-forget .then/.catch handlers settle. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }

/**
 * Drive the real dispatch loop, advancing fake timers between ticks so a backoff-gated
 * requeue (notBefore) becomes claimable again — mirroring the reconcile tick / next
 * agent:ready event that would drive this in production.
 */
async function runDispatchLoop(components: any, meshId: string, taskId: string, maxTicks: number): Promise<number> {
  let ticks = 0
  for (let i = 0; i < maxTicks; i += 1) {
    const row = getQueue(meshId).find(t => t.id === taskId)
    if (!row || row.status === 'failed' || row.status === 'cancelled' || row.status === 'completed') break
    if (row.status !== 'pending') break
    ticks += 1
    tryAssignQueueTask(components, meshId, NODE_ID, 'sess-booting', 'claude-cli')
    await settle()
    vi.advanceTimersByTime(31_000)
  }
  return ticks
}

describe('DISPATCH-BOOT-RACE — a session still booting must not exhaust the retry budget', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('survives two immediate "CLI agent not running" dispatch failures and lands the task once the session boots', async () => {
    const meshId = `mesh_boot_race_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // Exactly the live shape: the adapter is not yet registered on the first two
      // dispatch attempts (session still booting its CLI process), then comes up.
      let call = 0
      const components = createComponents(meshId, async () => {
        call += 1
        if (call <= 2) throw new Error('CLI agent not running: claude-cli')
        return { success: true }
      })
      const task = enqueueTask(meshId, 'READ-ONLY-DIAGNOSIS-DURING-BOOT', {
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        difficulty: 'medium',
      })

      const attempts = await runDispatchLoop(components, meshId, task.id, 10)

      const after = getQueue(meshId).find(t => t.id === task.id)!
      // THE ASSERTION: the task survives past the old maxTaskRetries:1 ceiling — it is
      // NOT failed, and the third (post-boot) dispatch landed it as assigned/in-flight.
      expect(after.status).toBe('assigned')
      expect(after.cancelReason).toBeUndefined()
      expect(attempts).toBe(3)
      expect(components.cliManager.handleCliCommand).toHaveBeenCalledTimes(3)
    } finally {
      cleanup(meshId)
    }
  })

  it('does not immediately re-dispatch after a boot-race failure — the retry is backed off, not instant', async () => {
    const meshId = `mesh_boot_race_backoff_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents(meshId, async () => {
        throw new Error('CLI agent not running: claude-cli')
      })
      const task = enqueueTask(meshId, 'DELTA-BOOT-BACKOFF', {
        targetNodeId: NODE_ID,
        taskMode: 'code_change',
        difficulty: 'medium',
      })

      tryAssignQueueTask(components, meshId, NODE_ID, 'sess-booting', 'claude-cli')
      await settle()

      // Immediately after the failure (no fake-timer advance): the row must still be
      // pending (requeued) but NOT yet re-claimable — a second claim attempt right now
      // must find nothing, exactly as the pre-fix 27ms-later re-dispatch should NOT have.
      const claimedImmediately = tryAssignQueueTask(components, meshId, NODE_ID, 'sess-booting', 'claude-cli')
      expect(claimedImmediately).toBe(false)
      expect(components.cliManager.handleCliCommand).toHaveBeenCalledTimes(1)

      const row = getQueue(meshId).find(t => t.id === task.id)!
      expect(row.status).toBe('pending')
      expect(row.notBefore).toBeDefined()
      expect(Date.parse(row.notBefore!)).toBeGreaterThan(Date.now())
    } finally {
      cleanup(meshId)
    }
  })
})
