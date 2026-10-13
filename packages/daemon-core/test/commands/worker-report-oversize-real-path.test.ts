/**
 * Real-path regression: an over-limit (> 8000 chars) `report_completion`, end to end.
 *
 * 2026-10-13 incident shape: a worker's report summary exceeded the 8000-char cap.
 * The mcp-server's durable outbox wrote it ahead and told the worker it was "queued —
 * NOT lost"; the daemon refused it as `invalid_report` BEFORE resolving the worker's
 * identity (no log, no attempt-owned trace); the worker then died, the owner's probe
 * answered `unknown`, and the await_report timer committed `task_completed` /
 * `weak_end_confirmed` for a worker that never reported and was no longer there.
 *
 * This drives the production pieces together — mcp-server `reportCompletion` +
 * `WorkerReportDelivery` → the daemon's `worker_report_completion` handler →
 * identity (bind + task token) → the exact attempt/generation → the real turn
 * ledger over MeshRuntimeStore — and asserts:
 *   - the over-limit report is refused (never truncated), never queued, and the
 *     refusal is filed content-free against the exact attempt + generation with a
 *     receipt the worker sees;
 *   - a corrected report is accepted as tool_report on that same attempt;
 *   - if the worker dies instead (liveness unknown), the report-await expiry
 *     re-probes once and then FAILS the attempt — never completed — and the
 *     refusal row survives with its generation.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TurnEvidence } from '@adhdev/mesh-shared'
import { reportCompletion } from '../../../mcp-server/src/tools/worker-tools.js'
import { WorkerReportDelivery } from '../../../mcp-server/src/tools/worker-report-outbox.js'
import { workerReportHandlers } from '../../src/commands/low-family/worker-report.js'
import {
  __resetReportedSummariesForTest,
  __setHandoffNoteSinkForTests,
  WORKER_REPORT_EVENT_KIND,
  WORKER_REPORT_REFUSED_EVENT_KIND,
} from '../../src/mesh/worker-report.js'
import { __resetWorkerDeliveryReplayForTests } from '../../src/mesh/worker-report-idempotency.js'
import { __setWorkerLateReportNoticeSinkForTests } from '../../src/mesh/worker-report-late.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import {
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
} from '../../src/mesh/worker-mcp-isolation.js'
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js'
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js'
import { DEFAULT_TURN_POLICY, unknownLivenessGraceMs } from '../../src/mesh/turn-ledger/policy.js'
import type { TurnLedger } from '../../src/mesh/turn-ledger/ledger.js'
import { fakePublisher } from '../turn-ledger/ledger-harness.js'

const OWNER_DAEMON = 'test-daemon'
const ctx: any = { deps: { statusInstanceId: OWNER_DAEMON, instanceManager: { getInstance: () => undefined } } }
const P = DEFAULT_TURN_POLICY
const MARKER = 'REJECTED-BODY-MARKER'
const OVERSIZE = `${MARKER} ${'x'.repeat(8_001)}`

let ledger: TurnLedger | null = null
let evSeq = 0

beforeEach(() => {
  __resetReportedSummariesForTest()
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
  __resetWorkerDeliveryReplayForTests()
  __setHandoffNoteSinkForTests(() => {})
  __setWorkerLateReportNoticeSinkForTests(() => {})
})
afterEach(async () => {
  setActiveTurnLedger(null)
  if (ledger) await ledger.flushPublish().catch(() => {})
  ledger = null
  __setHandoffNoteSinkForTests(undefined)
  __setWorkerLateReportNoticeSinkForTests(undefined)
  __resetWorkerTaskTokensForTest()
  __resetWorkerSessionBindsForTest()
  __resetWorkerDeliveryReplayForTests()
})

/** A dispatched mesh task whose worker went idle with a live worker-MCP bind → R9r await_report. */
function rig() {
  const tag = randomUUID().slice(0, 8)
  const meshId = `mesh_ovr_${tag}`
  const taskId = `${meshId}_task`
  const sessionId = `session_ovr_${tag}`
  const nodeId = `node_ovr_${tag}`
  const attemptId = `mesh_direct:${taskId}`
  const t0 = Date.now()
  ledger = createMeshRuntimeTurnLedger({ selfDaemonId: OWNER_DAEMON, publisher: fakePublisher(), policy: P })
  setActiveTurnLedger(ledger)
  const iso = new Date(t0).toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({
    id: taskId, meshId, message: 'work', status: 'assigned',
    assignedSessionId: sessionId, assignedNodeId: nodeId, createdAt: iso, updatedAt: iso,
  } as any)
  const env = (over: Partial<TurnEvidence> = {}) => {
    evSeq += 1
    return { eventId: `ovr-${tag}-${evSeq}`, at: Date.now(), source: 'fsm_edge', sessionId, observedBy: OWNER_DAEMON, attemptRef: { attemptId, generation: 0 }, ...over }
  }
  const observe = (body: Record<string, unknown>, over: Partial<TurnEvidence> = {}) => ledger!.observe({ ...env(over), ...body } as TurnEvidence)

  expect(observe({
    kind: 'dispatch_accepted', scope: 'mesh_direct', messageId: `msg-${tag}`, meshId, nodeId, providerType: 'claude-cli',
    coordinator: { daemonId: 'dc', coordinatorRunId: 'run1', sessionId: 'coord' },
  }, { source: 'dispatch', taskId } as any).rule).toBe('R1')
  expect(observe({ kind: 'delivered', messageId: `msg-${tag}`, outcome: 'delivered', via: 'p2p' }, { source: 'dispatch' }).rule).toBe('R2')
  expect(observe({ kind: 'turn_started', retro: false }).rule).toBe('R4')
  expect(observe({ kind: 'turn_end', strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine' } as any).rule).toBe('R9r')

  mintWorkerTaskToken({ meshId, taskId, attemptId, sessionId, nodeId })
  const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
  const sent: string[] = []
  const transport: any = {
    async command(name: string, args: any) {
      sent.push(name)
      return (workerReportHandlers as any)[name](ctx, args)
    },
  }
  const delivery = new WorkerReportDelivery({
    transport, credentials: { bind }, dir: null, autoSchedule: false, inlineAttempts: 1, sleep: async () => {}, log: () => {},
  })
  const turns = () => MeshRuntimeStore.getInstance().turnStore()
  return {
    meshId, taskId, sessionId, attemptId, bind, transport, delivery, sent, observe,
    attempt: () => ledger!.getAttempt(attemptId),
    refusedRows: () => turns().listWorkerEventsForTask(meshId, taskId, WORKER_REPORT_REFUSED_EVENT_KIND),
    reportRows: () => turns().listWorkerEventsForTask(meshId, taskId, WORKER_REPORT_EVENT_KIND),
    queueStatus: () => MeshRuntimeStore.getInstance().findQueueEntryById(meshId, taskId)?.status,
    report: (summary: string) => reportCompletion(transport, { bind }, { outcome: 'completed', summary, touched_files: [] }, delivery),
  }
}

type Rig = ReturnType<typeof rig>

async function refuseOversize(r: Rig) {
  const refused = await r.report(OVERSIZE)
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('report_completion rejected')
  expect(refused.text).toContain('summary')
  expect(refused.text).toContain(`attempt ${r.attemptId}, generation 0`)
  expect(refused.text).not.toMatch(/queued|NOT lost/i)
  // Never queued for re-delivery, never committed, never filed as a report.
  expect(r.delivery.pendingCount()).toBe(0)
  expect(r.reportRows()).toHaveLength(0)
  expect(r.attempt()).toMatchObject({ state: 'finalizing', terminal: null, generation: 0 })
  expect(r.queueStatus()).toBe('assigned')
  // Exact-attempt, content-free provenance.
  const rows = r.refusedRows()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ attemptId: r.attemptId, generation: 0, kind: WORKER_REPORT_REFUSED_EVENT_KIND })
  expect(rows[0]!.payload).toMatchObject({ refusal: 'invalid_report', fields: ['summary'], summaryLength: OVERSIZE.length, outcome: 'completed' })
  expect(String(rows[0]!.payload.deliveryId)).toMatch(/^wr_[0-9a-f]{16}_[0-9a-f]{12}$/)
  expect(JSON.stringify(rows[0])).not.toContain(MARKER)
  expect(JSON.stringify(rows[0])).not.toContain('xxxxxxxxxx')
  return rows[0]!
}

describe('over-limit report_completion — real path (mcp outbox → daemon → exact attempt → ledger)', () => {
  it('is refused with an exact-attempt receipt, never queued; a corrected report is accepted as tool_report on the same attempt', async () => {
    const r = rig()
    await refuseOversize(r)

    const corrected = await r.report('Shortened summary: findings are in handoff notes.')
    expect(corrected.isError).toBeFalsy()
    expect(r.delivery.pendingCount()).toBe(0)
    expect(r.reportRows()).toHaveLength(1)
    expect(r.reportRows()[0]).toMatchObject({ attemptId: r.attemptId, generation: 0 })
    expect(r.attempt()?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' })
    expect(r.queueStatus()).toBe('completed')
    // The refusal row is kept as provenance next to the accepted report.
    expect(r.refusedRows()).toHaveLength(1)
  })

  it('daemon unreachable: answered locally as a field error — nothing recorded, nothing queued', async () => {
    const r = rig()
    const dead: any = { async command() { throw new Error('IPC timeout') } }
    const out = await reportCompletion(dead, { bind: r.bind }, { outcome: 'completed', summary: OVERSIZE }, r.delivery)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('over the 8000 limit')
    expect(out.text).toContain('Nothing was recorded or queued')
    expect(out.text).not.toContain(MARKER)
    expect(r.delivery.pendingCount()).toBe(0)
    expect(r.refusedRows()).toHaveLength(0)
    expect(r.attempt()?.terminal).toBeNull()
  })

  it('worker dies after the refusal (liveness unknown): the await_report expiry re-probes, then FAILS — never task_completed; refusal row survives', async () => {
    const r = rig()
    await refuseOversize(r)

    expect(r.observe({ kind: 'liveness', result: 'unknown' }, { source: 'coordinator_probe' }).rule).toBe('R32u')
    const firstExpiry = Date.now() + P.awaitReportMs + 1
    const deferred = ledger!.sweepExpiredHolds(firstExpiry)
    expect(deferred.map((x) => x.rule)).toContain('R13u')
    expect(r.attempt()).toMatchObject({ state: 'finalizing', terminal: null })
    expect(r.queueStatus()).toBe('assigned')

    expect(r.observe({ kind: 'liveness', result: 'unknown' }, { source: 'coordinator_probe', at: firstExpiry + 1 }).rule).toBe('R32u')
    const failed = ledger!.sweepExpiredHolds(firstExpiry + unknownLivenessGraceMs(P) + 1)
    expect(failed.map((x) => x.rule)).toContain('R13x')
    expect(r.attempt()?.terminal).toMatchObject({ outcome: 'failed', strength: 'weak', reason: 'weak_end_liveness_unconfirmed' })
    expect(r.queueStatus()).toBe('failed')
    expect(r.reportRows()).toHaveLength(0)
    const rows = r.refusedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ attemptId: r.attemptId, generation: 0 })
  })

  it('worker confirmed dead after the refusal: reclaimed (R31), not completed; refusal row keeps its generation', async () => {
    const r = rig()
    await refuseOversize(r)
    const dead = r.observe({ kind: 'liveness', result: 'dead' }, { source: 'coordinator_probe' })
    expect(dead.rule).toBe('R31')
    expect(r.attempt()?.terminal?.outcome).not.toBe('completed')
    expect(r.queueStatus()).not.toBe('completed')
    expect(r.refusedRows()[0]).toMatchObject({ attemptId: r.attemptId, generation: 0 })
  })

  it('a worker that stays alive keeps today\'s behaviour: confirmed alive → the expiry commits weak (R13r)', async () => {
    const r = rig()
    await refuseOversize(r)
    expect(r.observe({ kind: 'liveness', result: 'alive' }, { source: 'coordinator_probe' }).rule).toBe('R32')
    const done = ledger!.sweepExpiredHolds(Date.now() + P.awaitReportMs + 1)
    expect(done.map((x) => x.rule)).toContain('R13r')
    expect(r.attempt()?.terminal).toMatchObject({ outcome: 'completed', strength: 'weak', reason: 'weak_end_confirmed' })
  })
})
