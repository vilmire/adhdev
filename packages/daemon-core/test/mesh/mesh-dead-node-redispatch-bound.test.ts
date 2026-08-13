import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// DEAD-DISPATCH-BOUND. A task whose dispatch target can never answer must reach a terminal
// state in a BOUNDED number of attempts, instead of being re-claimed and re-failed forever.
//
// Live 2026-08-11: queue task 25994f43 was pinned to node_d4bc9f12c89c4296b583381ed3eafb35 —
// a node absent from the live mesh — and re-dispatched every ~4s (the reconcile tick,
// DEFAULT_RECONCILE_INTERVAL_MS). 17 dispatches in 64s, dispatchNonce climbing to 23, ending
// only when an operator ran mesh_queue_cancel. The row had been re-activated by a
// `reclaim_after_unknown_grace` requeue after sitting inert for 45 minutes.
//
// Root cause: deliverTaskToSession's failure path returned the row to 'pending' with a bare
// `updateTaskStatus(meshId, taskId, 'pending')` — touching NO counter. requeueCount was never
// incremented, so the retry cap that bounds every other requeue path was never consumed, and
// a target that fails EVERY time cycled without limit. `isRetryableDispatchFailure` existed
// but was computed only for the ledger payload; it gated nothing.
//
// The fix routes that failure through requeueTask (spending the retry budget, auto-failing at
// the cap) and fails a transport-classified non-recoverable failure immediately.
//
// The DISCRIMINATION these tests pin — the whole point of the fix — is between:
//   - a target that is ABSENT (dispatch rejects every time)      → must terminate, and
//   - a live session that is merely BUSY right now (transient)    → must keep its retries.
// A guard that bounded both would break legitimate retry against a temporarily busy worker.

const testTmpDir = path.join(tmpdir(), `adhdev-dead-node-bound-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

const LOCAL_MACHINE_ID = 'mach_1111111111111111111111111111aaaa'
const REMOTE_DAEMON_ID = 'daemon_mach_2222222222222222222222222222bbbb'

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

const NODE_ID = 'node_d4bc9f12c89c4296b583381ed3eafb35' // the live offender's id
const WS = '/repo/dead-node'

/**
 * A mesh node on a REMOTE daemon, so dispatch goes through dispatchMeshCommand (the P2P
 * path the live failure took) rather than the local cliManager.
 */
function setMesh(meshId: string) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId,
    name: 'Dead Node Mesh',
    policy: {},
    nodes: [{ id: NODE_ID, workspace: WS, repoRoot: WS, policy: {}, daemonId: REMOTE_DAEMON_ID }],
  })
}

function createComponents(meshId: string, dispatch: () => Promise<unknown>) {
  const state = {
    settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, providerType: 'claude-cli' },
    status: 'idle',
    instanceId: 'sess-dead',
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
    cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
    dispatchMeshCommand: vi.fn(dispatch),
    getMeshPeerConnectionStatus: vi.fn(() => ({ state: 'connected' })),
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
 * Drive the real dispatch loop: claim → dispatch → (async) failure → requeue → repeat,
 * exactly as the 4s reconcile tick does, until the row goes terminal or we hit `maxTicks`.
 * Returns the number of dispatch attempts actually made.
 */
async function runDispatchLoop(components: any, meshId: string, taskId: string, maxTicks: number): Promise<number> {
  let ticks = 0
  for (let i = 0; i < maxTicks; i += 1) {
    const row = getQueue(meshId).find(t => t.id === taskId)
    if (!row || row.status === 'failed' || row.status === 'cancelled' || row.status === 'completed') break
    if (row.status !== 'pending') break
    ticks += 1
    tryAssignQueueTask(components, meshId, NODE_ID, 'sess-dead', 'claude-cli')
    await settle()
  }
  return ticks
}

describe('DEAD-DISPATCH-BOUND — an undeliverable dispatch target must not re-dispatch forever', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('terminates a task whose node is absent instead of re-dispatching without limit', async () => {
    const meshId = `mesh_dead_bound_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // The node is in mesh config but its daemon never answers — every dial rejects, which
      // is exactly what a dispatch to a node absent from the live mesh does.
      const components = createComponents(meshId, async () => {
        throw new Error('peer not connected: no route to daemon')
      })
      const task = enqueueTask(meshId, 'DELTA-FOR-DEAD-NODE', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      // 40 ticks stands in for "forever": before the fix the row returned to 'pending' on
      // every tick and this consumed all 40 without ever going terminal.
      const attempts = await runDispatchLoop(components, meshId, task.id, 40)

      const after = getQueue(meshId).find(t => t.id === task.id)!
      // THE ASSERTION: the loop CONVERGED — the row is terminal and the attempts were few.
      expect(after.status).toBe('failed')
      expect(after.cancelReason).toMatch(/max_retries_exceeded/)
      expect(attempts).toBeLessThan(10)
      // And the dispatch transport was not hammered.
      expect(components.dispatchMeshCommand.mock.calls.length).toBeLessThan(10)
    } finally {
      cleanup(meshId)
    }
  })

  it('fails immediately — without spending retries — when the transport says the failure is non-recoverable', async () => {
    const meshId = `mesh_dead_selfdial_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // The self-dial shape: a retry re-runs an identical decision on identical inputs, so
      // the transport marks it unrecoverable. Retrying is provably pointless.
      const components = createComponents(meshId, async () => {
        const err: any = new Error('Refusing to send mesh command to this daemon\'s own id')
        err.retryRecommended = false
        throw err
      })
      const task = enqueueTask(meshId, 'DELTA-SELFDIAL', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      const attempts = await runDispatchLoop(components, meshId, task.id, 40)

      const after = getQueue(meshId).find(t => t.id === task.id)!
      expect(after.status).toBe('failed')
      // ONE attempt — a non-recoverable failure must not consume the retry budget one tick
      // at a time; it terminates on the spot.
      expect(attempts).toBe(1)
      expect(components.dispatchMeshCommand).toHaveBeenCalledTimes(1)
    } finally {
      cleanup(meshId)
    }
  })

  it('does NOT terminate on a transient failure — a retryable dispatch still gets re-dispatched', async () => {
    const meshId = `mesh_dead_transient_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      // THE DISCRIMINATION: the target is alive and merely busy/refusing right now. The
      // FIRST dispatch fails, the second succeeds — the fix must let that second one happen.
      // A guard that bounded "node absent" and "busy right now" alike would break this.
      let call = 0
      const components = createComponents(meshId, async () => {
        call += 1
        if (call === 1) throw new Error('adapter busy, try again')
        return { success: true }
      })
      const task = enqueueTask(meshId, 'DELTA-TRANSIENT', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      await runDispatchLoop(components, meshId, task.id, 40)

      const after = getQueue(meshId).find(t => t.id === task.id)!
      // The retry landed: the row is assigned (in flight), NOT failed. The transient failure
      // spent one retry and the next dispatch succeeded.
      expect(after.status).toBe('assigned')
      expect(components.dispatchMeshCommand).toHaveBeenCalledTimes(2)
    } finally {
      cleanup(meshId)
    }
  })

  it('a successful dispatch is untouched by the guard (no retry budget spent)', async () => {
    const meshId = `mesh_dead_ok_${randomUUID().slice(0, 8)}`
    try {
      setMesh(meshId)
      const components = createComponents(meshId, async () => ({ success: true }))
      const task = enqueueTask(meshId, 'DELTA-OK', { targetNodeId: NODE_ID, taskMode: 'code_change',
    difficulty: 'medium',
})

      expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-dead', 'claude-cli')).toBe(true)
      await settle()

      const after = getQueue(meshId).find(t => t.id === task.id)!
      expect(after.status).toBe('assigned')
      expect(after.requeueCount ?? 0).toBe(0)
    } finally {
      cleanup(meshId)
    }
  })
})
