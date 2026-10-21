import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// QUEUE-LEDGER-DRIFT (mission 47075446 items ③④, live rc.25 c362e481). The queue
// row and the task's turn attempt must agree on whether the task is running:
//
//  ③ requeueTask(force) put the row back to `pending` beside an attempt still
//    `generating` — the next claim was refused and the worker's report found no
//    provable attempt. Now the open attempt is cancelled (superseded) on the ledger
//    first, under the queue terminal fence, and a non-force requeue of a running
//    attempt is refused.
//  ④ claimNextQueueTask bumped the nonce and flipped the row `assigned` before the
//    ledger refused the dispatch, and the refusal wrote it back to `pending` — every
//    4 s drain tick, forever. Now the claim skips such a row before any write, and a
//    refusal rebinds the row to the running attempt with a backoff.

const testTmpDir = path.join(tmpdir(), `adhdev-requeue-ledger-aware-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
const LOCAL_MACHINE_ID = 'mach_3333333333333333333333333333cccc'

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: LOCAL_MACHINE_ID } as any),
  getMachineId: () => LOCAL_MACHINE_ID,
  getMachineNickname: () => null,
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
import {
  __clearMeshQueueForTests, __resetMeshRuntimeStoreForTests, enqueueTask, getQueue, requeueTask, updateTaskStatus,
} from '../../src/mesh/mesh-work-queue.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js'
import { rebindRefusedClaimToOpenAttempt } from '../../src/mesh/mesh-queue-attempt-guard.js'
import { fenceWorkerReportOnLedger } from '../../src/mesh/worker-report.js'
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js'
import { withMeshRouter } from './helpers/mesh-router-stub.js'
import { __drainTestTurnLedgersForTests, wipeTurnTablesForTests } from './helpers/mesh-turn-ledger-fixture.js'
import { evd } from '../turn-ledger/ledger-harness.js'

const NODE_ID = 'node_requeue_ledger_local000000000000000'
const WS = '/repo/requeue-ledger-aware'

function setMesh(meshId: string, policy: Record<string, unknown> = {}) {
  meshConfigMocks.getMesh.mockReturnValue({
    id: meshId, name: 'Requeue Ledger Mesh', policy,
    nodes: [{ id: NODE_ID, workspace: WS, repoRoot: WS, policy: {} }],
  })
}

function createComponents(meshId: string, sessionIds: string[]) {
  const instances = new Map(sessionIds.map((sessionId) => {
    const state = {
      settings: { meshNodeFor: meshId, meshNodeId: NODE_ID, providerType: 'claude-cli' },
      status: 'idle', instanceId: sessionId, type: 'claude-cli', workspace: WS,
    }
    return [sessionId, { getState: () => state, updateSettings: vi.fn() }] as const
  }))
  return withMeshRouter({
    instanceManager: {
      getInstance: vi.fn((id: string) => instances.get(id)),
      getByCategory: vi.fn((c: string) => (c === 'cli' ? [...instances.values()] : [])),
      attachMeshAssignmentToInstance: vi.fn(() => ({ stamped: true })),
    },
    cliManager: { adapters: new Map(), handleCliCommand: vi.fn(async () => ({ success: true })) },
    providerLoader: {
      resolveAlias: vi.fn((t: string) => t),
      isMachineProviderEnabled: vi.fn(() => true),
      getMeta: vi.fn(() => undefined),
      setCliDetectionResults: vi.fn(),
    },
    statusInstanceId: 'daemon-local',
    onStatusChange: vi.fn(),
  } as any)
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

const row = (meshId: string, taskId: string) => getQueue(meshId).find(t => t.id === taskId)!
const attempts = (meshId: string, taskId: string) => MeshRuntimeStore.getInstance().turnStore().listAttemptsForTask(meshId, taskId)

/** Claim `taskId` into `sessionId` and drive its attempt to `generating` (delivered + turn_started). */
async function claimAndStart(components: any, meshId: string, taskId: string, sessionId: string) {
  expect(tryAssignQueueTask(components, meshId, NODE_ID, sessionId, 'claude-cli')).toBe(true)
  await settle()
  const attempt = attempts(meshId, taskId).at(-1)!
  const ledger = components.turnLedger as TurnLedger
  ledger.observe(evd('turn_started', { retro: false }, {
    at: Date.now(), source: 'fsm_edge', sessionId, observedBy: ledger.selfDaemonId,
    attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
  }))
  const after = attempts(meshId, taskId).at(-1)!
  expect(after.state).toBe('generating')
  return after
}

describe('QUEUE-LEDGER-DRIFT: requeue and claim consult the turn ledger', () => {
  let meshId = ''
  let components: any
  beforeEach(() => {
    meshId = `mesh_requeue_ledger_${randomUUID().slice(0, 8)}`
    setMesh(meshId)
    components = createComponents(meshId, ['sess-a', 'sess-b'])
    setActiveTurnLedger(components.turnLedger)
  })
  afterEach(async () => {
    setActiveTurnLedger(null)
    await __drainTestTurnLedgersForTests()
    __clearMeshQueueForTests(meshId)
    wipeTurnTablesForTests()
    __resetMeshRuntimeStoreForTests()
    meshConfigMocks.getMesh.mockReset()
    vi.clearAllMocks()
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  // (c) — the c362e481 loop: a pending row beside a generating attempt, idle sessions.
  it('(c) a pending row beside a generating attempt is never claimed: 10 drain ticks leave the nonce unchanged', async () => {
    const task = enqueueTask(meshId, 'LOOP-CANARY', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    await claimAndStart(components, meshId, task.id, 'sess-a')
    // The stuck shape the pre-fix force requeue left behind.
    updateTaskStatus(meshId, task.id, 'pending')
    const nonce = row(meshId, task.id).dispatchNonce

    for (let tick = 0; tick < 10; tick += 1) {
      tryAssignQueueTask(components, meshId, NODE_ID, 'sess-b', 'claude-cli')
      await settle()
    }

    expect(row(meshId, task.id).dispatchNonce).toBe(nonce)
    expect(row(meshId, task.id).status).toBe('pending')
    expect(row(meshId, task.id).hold?.reason).toBe('attempt_injection_closed')
    expect(attempts(meshId, task.id)).toHaveLength(1)
    expect(attempts(meshId, task.id)[0]!.state).toBe('generating')
  })

  // (d) — force requeue of a freshly claimed (running) task closes its attempt.
  it('(d) force requeue cancels the open attempt; the row goes pending (not cancelled) with a new nonce, dependents untouched', async () => {
    // `cancel` dependency policy: an unfenced cancel commit would cascade onto the dependent.
    setMesh(meshId, { onDependencyFailure: 'cancel' })
    const task = enqueueTask(meshId, 'FORCE-REQUEUE', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const dependent = enqueueTask(meshId, 'DEPENDENT', { dependsOn: [task.id], taskMode: 'code_change', difficulty: 'medium' })
    const running = await claimAndStart(components, meshId, task.id, 'sess-a')
    const nonce = row(meshId, task.id).dispatchNonce!

    const result = requeueTask(meshId, task.id, { reason: 'operator_retry', force: true })

    expect(result?.status).toBe('pending')
    const after = row(meshId, task.id)
    expect(after.status).toBe('pending')
    expect(after.attemptId).toBeUndefined()
    expect(after.dispatchNonce).toBe(nonce + 1)
    const closed = MeshRuntimeStore.getInstance().turnStore().getAttempt(running.attemptId)!
    expect(closed.terminal?.outcome).toBe('cancelled')
    // The fence kept the cancel commit from terminalizing the row: no phantom
    // `cancelled` output version, no dependency cascade.
    expect(MeshRuntimeStore.getInstance().getLatestTaskOutput(task.id)).toBeNull()
    expect(row(meshId, dependent.id).status).toBe('pending')
  })

  it('(d) non-force requeue of a running attempt is refused and changes nothing', async () => {
    const task = enqueueTask(meshId, 'NONFORCE-REQUEUE', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const running = await claimAndStart(components, meshId, task.id, 'sess-a')
    // Restart-shaped: no in-flight mark, a stale pending row — only the ledger knows.
    updateTaskStatus(meshId, task.id, 'pending')
    const before = row(meshId, task.id)

    requeueTask(meshId, task.id, { reason: 'retry' })

    const after = row(meshId, task.id)
    expect(after.dispatchNonce).toBe(before.dispatchNonce)
    expect(after.requeueCount ?? 0).toBe(before.requeueCount ?? 0)
    expect(MeshRuntimeStore.getInstance().turnStore().getAttempt(running.attemptId)!.state).toBe('generating')
  })

  // (e) — the report from the re-dispatched worker lands.
  it('(e) after a force requeue the re-claimed worker gets a fresh attempt and its report is provable', async () => {
    const task = enqueueTask(meshId, 'REPORT-AFTER-REQUEUE', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    await claimAndStart(components, meshId, task.id, 'sess-a')
    requeueTask(meshId, task.id, { reason: 'operator_retry', force: true })

    expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-b', 'claude-cli')).toBe(true)
    await settle()
    const fresh = attempts(meshId, task.id).at(-1)!
    expect(fresh.attemptNo).toBe(1)
    expect(fresh.sessionId).toBe('sess-b')
    expect(row(meshId, task.id).attemptId).toBe(fresh.attemptId)

    const store = MeshRuntimeStore.getInstance()
    expect(fenceWorkerReportOnLedger(store, { meshId, taskId: task.id, attemptId: fresh.attemptId, sessionId: 'sess-b' }, 'completed')).toBe('ok')
    const ledger = components.turnLedger as TurnLedger
    const report = ledger.observe(evd('worker_report', { outcome: 'completed', hasHandoffNotes: false }, {
      at: Date.now(), source: 'worker_tool', sessionId: 'sess-b', observedBy: ledger.selfDaemonId,
      attemptRef: { attemptId: fresh.attemptId, generation: fresh.generation },
    }))
    expect(report.verdict).not.toBe('rejected')
    // The superseded generation's report is fenced off, not misattributed.
    const stale = attempts(meshId, task.id)[0]!
    expect(fenceWorkerReportOnLedger(store, { meshId, taskId: task.id, attemptId: stale.attemptId, sessionId: 'sess-a' }, 'completed')).toBe('stale_attempt')
  })

  it('a refused claim rebinds the row to the running attempt (nonce bump undone) and backs off', async () => {
    const task = enqueueTask(meshId, 'REBIND', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const running = await claimAndStart(components, meshId, task.id, 'sess-a')
    // The claim's own write, as claimNextQueueTask leaves it for a different session.
    const entry = row(meshId, task.id)
    const nonce = entry.dispatchNonce!
    entry.assignedSessionId = 'sess-b'
    entry.dispatchNonce = nonce + 1
    MeshRuntimeStore.getInstance().updateQueueEntry(entry)

    const t0 = Date.now()
    const first = rebindRefusedClaimToOpenAttempt(meshId, task.id, running, t0)!
    expect(first).toMatchObject({ status: 'assigned', assignedSessionId: 'sess-a', attemptId: running.attemptId, dispatchNonce: nonce, claimRefusedCount: 1 })
    expect(Date.parse(first.notBefore!)).toBe(t0 + 2_000)

    first.dispatchNonce = nonce + 1
    MeshRuntimeStore.getInstance().updateQueueEntry(first)
    const second = rebindRefusedClaimToOpenAttempt(meshId, task.id, running, t0)!
    expect(second.claimRefusedCount).toBe(2)
    expect(Date.parse(second.notBefore!)).toBe(t0 + 4_000)
  })
})
