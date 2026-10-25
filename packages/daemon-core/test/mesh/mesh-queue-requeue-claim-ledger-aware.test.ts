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
import { __drainTestTurnLedgersForTests, wipeTurnTablesForTests, confirmTestWriterQuiescence } from './helpers/mesh-turn-ledger-fixture.js'
import { dispatch, evd, ledgerOn, memDb, recordingHost, confirmFixtureWriterQuiescence } from '../turn-ledger/ledger-harness.js'
import { withQueueTerminalFence, applyTaskTerminalInTxn } from '../../src/mesh/mesh-task-terminal.js'
import { findInjectionClosedQueueAttempt } from '../../src/mesh/mesh-queue-attempt-guard.js'
import { meshStoreIpcHandlers } from '../../src/commands/low-family/mesh-store-ipc.js'
import { meshQueueHandlers } from '../../src/commands/med-family/mesh-queue.js'
import { TURN_IPC_PROTOCOL_VERSION } from '@adhdev/mesh-shared'
import { findWorkerTaskTokenForSession, exchangeWorkerSessionBind, mintWorkerSessionBind, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation.js'

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


/** The first request keeps the assigned writer exclusive; only its native proof
 * permits the explicit requeue retry to apply caller addressing/backoff options. */
async function requeueAfterCheckpoint(components: any, meshId: string, taskId: string, options: Parameters<typeof requeueTask>[2]) {
  const before = row(meshId, taskId)
  requeueTask(meshId, taskId, options)
  expect(row(meshId, taskId)).toMatchObject({ status: before.status, assignedSessionId: before.assignedSessionId, dispatchNonce: before.dispatchNonce })
  expect(attempts(meshId, taskId).at(-1)).toMatchObject({ state: 'stopping', terminal: null })
  await confirmTestWriterQuiescence(components.turnLedger)
  return requeueTask(meshId, taskId, options)
}

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

    const result = await requeueAfterCheckpoint(components, meshId, task.id, { reason: 'operator_retry', force: true })

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
    await requeueAfterCheckpoint(components, meshId, task.id, { reason: 'operator_retry', force: true })

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

  // ── review 24c9b2db probes ────────────────────────────────────────────────

  it('a real openClaimAttempt refusal (attempt closed after the gate read) rebinds the row to the running attempt', async () => {
    const task = enqueueTask(meshId, 'REFUSAL-RACE', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const running = await claimAndStart(components, meshId, task.id, 'sess-a')
    updateTaskStatus(meshId, task.id, 'pending')
    const nonce = row(meshId, task.id).dispatchNonce
    const turns = MeshRuntimeStore.getInstance().turnStore()
    // The gate's read sees no attempt; the attempt open that follows sees it generating.
    const read = vi.spyOn(turns, 'findLatestAttemptForTask').mockReturnValueOnce(null)
    try {
      expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-b', 'claude-cli')).toBe(false)
    } finally { read.mockRestore() }
    expect(row(meshId, task.id)).toMatchObject({ status: 'assigned', assignedSessionId: 'sess-a', attemptId: running.attemptId, dispatchNonce: nonce, claimRefusedCount: 1 })
    expect(Date.parse(row(meshId, task.id).notBefore!)).toBeGreaterThan(Date.now())
  })

  it('the terminal fence nests, survives a throw, and never blocks another task', () => {
    const a = enqueueTask(meshId, 'FENCE-A', { taskMode: 'live_debug_readonly', difficulty: 'medium' })
    const b = enqueueTask(meshId, 'FENCE-B', { taskMode: 'live_debug_readonly', difficulty: 'medium' })
    const terminal = (taskId: string) => applyTaskTerminalInTxn({ meshId, taskId, status: 'cancelled', occurredAtMs: Date.now() })
    withQueueTerminalFence(meshId, a.id, () => {
      expect(terminal(a.id).transitioned).toBe(false)
      try { withQueueTerminalFence(meshId, a.id, () => { throw new Error('probe') }) } catch { /* expected */ }
      expect(terminal(a.id).transitioned).toBe(false)
      expect(terminal(b.id).transitioned).toBe(true)
    })
    expect(terminal(a.id).transitioned).toBe(true)
  })

  it('a genuine operator cancel still terminalizes the row and cascades', async () => {
    setMesh(meshId, { onDependencyFailure: 'cancel' })
    const a = enqueueTask(meshId, 'REAL-CANCEL', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const b = enqueueTask(meshId, 'REAL-DEPENDENT', { dependsOn: [a.id], taskMode: 'code_change', difficulty: 'medium' })
    const attempt = await claimAndStart(components, meshId, a.id, 'sess-a')
    const ledger = components.turnLedger as TurnLedger
    expect(ledger.observe(evd('cancel', { reason: 'operator_cancel' }, {
      at: Date.now(), sessionId: 'sess-a', source: 'operator', observedBy: ledger.selfDaemonId,
      attemptRef: { attemptId: attempt.attemptId, generation: attempt.generation },
    })).verdict).toBe('applied')
    expect(row(meshId, a.id).status).toBe('assigned')
    expect(row(meshId, b.id).status).toBe('pending')
    await confirmTestWriterQuiescence(ledger)
    expect(row(meshId, a.id).status).toBe('cancelled')
    expect(row(meshId, b.id).status).toBe('cancelled')
  })

  it('the claim gate blocks only open attempts that consumed their prompt', () => {
    for (const state of ['accepted', 'delivered', 'consumed', 'generating', 'suspended', 'finalizing', 'completed', 'failed', 'cancelled']) {
      const terminal = ['completed', 'failed', 'cancelled'].includes(state) ? { outcome: state } : null
      const fake = { findLatestAttemptForTask: () => ({ scope: 'mesh_queue', state, terminal }) } as any
      expect(!!findInjectionClosedQueueAttempt(fake, meshId, 't'), state).toBe(['consumed', 'generating', 'suspended', 'finalizing'].includes(state))
    }
    expect(findInjectionClosedQueueAttempt({ findLatestAttemptForTask: () => null }, meshId, 't')).toBeNull()
  })

  it('refusal backoff caps at 60 s and a force requeue recovers to a fresh claim', async () => {
    const task = enqueueTask(meshId, 'CAP-RECOVERY', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const attempt = await claimAndStart(components, meshId, task.id, 'sess-a')
    const now = Date.now()
    for (let i = 0; i < 12; i++) {
      const rebound = rebindRefusedClaimToOpenAttempt(meshId, task.id, attempt, now)!
      expect(Date.parse(rebound.notBefore!) - now).toBe(Math.min(2000 * 2 ** i, 60000))
    }
    await requeueAfterCheckpoint(components, meshId, task.id, { force: true })
    expect(row(meshId, task.id).notBefore).toBeUndefined()
    expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-b', 'claude-cli')).toBe(true)
    await settle()
  })

  // F1 — the retired attempt's token must not win the same-session exchange.
  it('F1: a same-session retry after force requeue exchanges the FRESH attempt token and its report is provable', async () => {
    const task = enqueueTask(meshId, 'SAME-SESSION', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const old = await claimAndStart(components, meshId, task.id, 'sess-a')
    expect(findWorkerTaskTokenForSession(meshId, task.id, 'sess-a')?.attemptId).toBe(old.attemptId)
    await requeueAfterCheckpoint(components, meshId, task.id, { force: true })
    expect(tryAssignQueueTask(components, meshId, NODE_ID, 'sess-a', 'claude-cli')).toBe(true)
    await settle()
    const fresh = attempts(meshId, task.id).at(-1)!
    expect(fresh.attemptId).not.toBe(old.attemptId)
    const bind = mintWorkerSessionBind({ meshId, sessionId: 'sess-a', nodeId: NODE_ID })
    const exchange = exchangeWorkerSessionBind(bind.bind, () => ({ taskId: task.id, attemptId: fresh.attemptId }))!
    expect(exchange.attemptId).toBe(fresh.attemptId)
    expect(findWorkerTaskTokenForSession(meshId, task.id, 'sess-a')?.attemptId).toBe(fresh.attemptId)
    expect(fenceWorkerReportOnLedger(MeshRuntimeStore.getInstance(), { meshId, taskId: task.id, attemptId: exchange.attemptId, sessionId: 'sess-a' }, 'completed')).toBe('ok')
  })

  // F2 — a foreign-owned attempt is refused BEFORE any evidence is observed.
  it('F2: a foreign-owned attempt refuses the requeue without forwarding a cancel', async () => {
    const task = enqueueTask(meshId, 'FORWARDED-REFUSAL', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const attempt = await claimAndStart(components, meshId, task.id, 'sess-a')
    const store = MeshRuntimeStore.getInstance()
    store.turnStore().upsertAttempt({ ...attempt, ownerDaemonId: 'remote-owner' }, Date.now())
    const before = row(meshId, task.id)
    requeueTask(meshId, task.id, { force: true })
    expect(row(meshId, task.id)).toEqual(before)
    const sent = store.db.prepare("SELECT COUNT(*) AS n FROM turn_events WHERE attempt_id = ? AND kind = 'cancel'").get(attempt.attemptId) as { n: number }
    expect(sent.n).toBe(0)
    expect(store.turnStore().getAttempt(attempt.attemptId)!.terminal).toBeNull()
  })

  // F3 — retiring the attempt is not a task cancellation.
  it('F3: a force requeue sends no task-cancelled notice and no queue terminal effects', async () => {
    const task = enqueueTask(meshId, 'NOTICE-REQUEUE', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const attempt = await claimAndStart(components, meshId, task.id, 'sess-a')
    await requeueAfterCheckpoint(components, meshId, task.id, { force: true })
    await (components.turnLedger as TurnLedger).flushPublish()
    const notices = MeshRuntimeStore.getInstance().db.prepare("SELECT payload_json FROM turn_events WHERE attempt_id = ? AND kind = 'notify'").all(attempt.attemptId) as Array<{ payload_json: string }>
    expect(notices.map(n => JSON.parse(n.payload_json)).filter(n => n.notify === 'cancelled')).toHaveLength(0)
    expect(row(meshId, task.id).status).toBe('pending')
  })

  it('F3 (reducer): cancel/superseded retires only the attempt after quiescence; operator_cancel still commits the task', async () => {
    const effectsFor = async (reason: 'superseded' | 'operator_cancel') => {
      const db = memDb()
      const host = recordingHost()
      const ledger = ledgerOn(db, { selfDaemonId: 'dc', host })
      ledger.observe(dispatch({ attemptId: 'q1', session: 's1', scope: 'mesh_queue', taskId: 't1' }))
      const result = ledger.observe(evd('cancel', { reason }, { source: 'operator', sessionId: 's1', observedBy: 'dc', attemptRef: { attemptId: 'q1', generation: 0 } }))
      expect(result.verdict).toBe('applied')
      expect(result.attempt).toMatchObject({ state: 'stopping', terminal: null })
      expect(result.effects.map(e => e.kind)).not.toContain('task_terminal')
      await confirmFixtureWriterQuiescence(ledger)
      expect(host.calls).toEqual(reason === 'superseded' ? ['requeue:t1'] : ['terminal:t1:cancelled'])
      const effects = db.prepare("SELECT kind FROM turn_events WHERE attempt_id = 'q1'").all() as Array<{kind: string}>
      expect(ledger.getAttempt('q1')?.terminal).toMatchObject({ outcome: 'cancelled', reason })
      db.close()
      return effects.map(e => e.kind)
    }
    const retired = await effectsFor('superseded')
    expect(retired).toEqual(expect.arrayContaining(['cancel_dispatch', 'committed']))
    expect(retired).not.toContain('notify')
    expect(await effectsFor('operator_cancel')).toContain('notify')
  })

  // F4 — both requeue command surfaces answer a ledger refusal as a refusal.
  it('F4: lower queue_requeue IPC and med-family requeue answer success:false on a ledger refusal', async () => {
    const task = enqueueTask(meshId, 'NO-LEDGER', { targetNodeId: NODE_ID, taskMode: 'code_change', difficulty: 'medium' })
    const attempt = await claimAndStart(components, meshId, task.id, 'sess-a')
    setActiveTurnLedger(null)
    const lower = await meshStoreIpcHandlers.queue_requeue({} as any, { v: TURN_IPC_PROTOCOL_VERSION, meshId, taskId: task.id, options: { force: true } }) as any
    expect(lower).toMatchObject({ success: false, code: 'requeue_refused_attempt_open', refusalReason: 'no_ledger', attemptId: attempt.attemptId, attemptState: 'generating' })
    const med = await meshQueueHandlers.requeue_mesh_queue_task({ requireMeshHostMutationOwner: async () => null } as any, { meshId, taskId: task.id, force: true }) as any
    expect(med).toMatchObject({ success: false, code: 'requeue_refused_attempt_open', refusalReason: 'no_ledger', attemptId: attempt.attemptId })
    expect(row(meshId, task.id).status).toBe('assigned')

    // Non-force over a running attempt (ledger active again): refused on both surfaces too.
    setActiveTurnLedger(components.turnLedger)
    updateTaskStatus(meshId, task.id, 'pending')
    const lower2 = await meshStoreIpcHandlers.queue_requeue({} as any, { v: TURN_IPC_PROTOCOL_VERSION, meshId, taskId: task.id, options: {} }) as any
    expect(lower2).toMatchObject({ success: false, code: 'requeue_refused_attempt_open', refusalReason: 'attempt_open' })
    const med2 = await meshQueueHandlers.requeue_mesh_queue_task({ requireMeshHostMutationOwner: async () => null } as any, { meshId, taskId: task.id }) as any
    expect(med2).toMatchObject({ success: false, code: 'requeue_refused_attempt_open', refusalReason: 'attempt_open' })
  })

  it('F1 (defence): token lookup prefers the current attempt over an older token of the same session', () => {
    const older = mintWorkerTaskToken({ meshId, taskId: 'tok-task', attemptId: 'att-0', sessionId: 'sess-a' })
    const newer = mintWorkerTaskToken({ meshId, taskId: 'tok-task', attemptId: 'att-1', sessionId: 'sess-a' })
    expect(findWorkerTaskTokenForSession(meshId, 'tok-task', 'sess-a')?.token).toBe(older.token)
    expect(findWorkerTaskTokenForSession(meshId, 'tok-task', 'sess-a', 'att-1')?.token).toBe(newer.token)
    expect(findWorkerTaskTokenForSession(meshId, 'tok-task', 'sess-a', 'att-9')?.token).toBe(older.token)
    const bind = mintWorkerSessionBind({ meshId, sessionId: 'sess-a', nodeId: NODE_ID })
    expect(exchangeWorkerSessionBind(bind.bind, () => ({ taskId: 'tok-task', attemptId: 'att-1' }))?.attemptId).toBe('att-1')
  })

  it('F1 (fence): a fenced terminal skips the row transition but still expires the closed attempt\'s tokens', () => {
    const t = enqueueTask(meshId, 'FENCE-TOKENS', { taskMode: 'live_debug_readonly', difficulty: 'medium' })
    mintWorkerTaskToken({ meshId, taskId: t.id, attemptId: 'closed-att', sessionId: 'sess-a' })
    const keep = mintWorkerTaskToken({ meshId, taskId: t.id, attemptId: 'other-att', sessionId: 'sess-b' })
    withQueueTerminalFence(meshId, t.id, () => {
      expect(applyTaskTerminalInTxn({ meshId, taskId: t.id, status: 'cancelled', attemptId: 'closed-att', occurredAtMs: Date.now() }).transitioned).toBe(false)
    })
    expect(row(meshId, t.id).status).toBe('pending')
    expect(findWorkerTaskTokenForSession(meshId, t.id, 'sess-a')).toBeNull()
    expect(findWorkerTaskTokenForSession(meshId, t.id, 'sess-b')?.token).toBe(keep.token)
  })
})
