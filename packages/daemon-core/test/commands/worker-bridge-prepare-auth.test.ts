import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setBridgePolicy } from '../../src/mesh/worker-bridge.js'
import { workerReportHandlers } from '../../src/commands/low-family/worker-report.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js'
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js'
import {
  findWorkerTaskTokenForSession,
  mintWorkerSessionBind,
  mintWorkerTaskToken,
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
} from '../../src/mesh/worker-mcp-isolation.js'
import { __setHandoffNoteSinkForTests } from '../../src/mesh/worker-report.js'
import { __setWorkerProgressNoticeSinkForTests } from '../../src/mesh/worker-report-progress.js'
import { WORKER_MCP_DAEMON_VERBS, isWorkerMcpDaemonVerb } from '../../src/standalone-mcp-auth.js'
import { turnLedgerIpcHandlers } from '../../src/commands/low-family/turn-ledger-ipc.js'
import { fakePublisher } from '../turn-ledger/ledger-harness.js'

// `worker_bridge_prepare` mints the delivery provenance a strict-protocol
// report is sent under, and it is reachable by a WORKER-scope MCP credential.
// These tests pin the authority that reachability implies: the verb must admit
// a worker that proves a live task identity and must refuse everything else.
// They own every byte of their state (temp dir + synthetic mesh) and never read
// the owner's config dir or a live daemon.

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
  setActiveTurnLedger(null)
  __resetWorkerSessionBindsForTest()
  __resetWorkerTaskTokensForTest()
  __setHandoffNoteSinkForTests(undefined)
  __setWorkerProgressNoticeSinkForTests(undefined)
  vi.restoreAllMocks()
})

const MESH = 'prepare_auth_mesh'
const TASK = 'prepare_auth_task'
const SESSION = 'prepare_auth_session'
const NODE = 'prepare_auth_node'
const ATTEMPT = `mesh_direct:${TASK}`
const OWNER_DAEMON = 'daemon_mach_prepare_auth_owner'

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'worker-prepare-auth-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = new MeshRuntimeStore(join(dir, 'owner.db'))
  cleanup.push(() => store.close())
  vi.spyOn(MeshRuntimeStore, 'getInstance').mockImplementation(() => store)

  const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: OWNER_DAEMON, publisher: fakePublisher() })
  setActiveTurnLedger(ledger)
  __setHandoffNoteSinkForTests(() => {})
  __setWorkerProgressNoticeSinkForTests(() => {})

  const iso = new Date().toISOString()
  store.insertQueueEntry({
    id: TASK, meshId: MESH, message: 'synthetic', status: 'assigned',
    assignedSessionId: SESSION, assignedNodeId: NODE, createdAt: iso, updatedAt: iso,
  })
  let seq = 0
  const observe = (body: any) => ledger.observe({
    eventId: `prepare-auth-${++seq}`, at: Date.now(), source: 'dispatch', observedBy: OWNER_DAEMON,
    sessionId: SESSION, attemptRef: { attemptId: ATTEMPT, generation: 0 }, ...body,
  })
  observe({ kind: 'dispatch_accepted', scope: 'mesh_direct', meshId: MESH, taskId: TASK, nodeId: NODE, messageId: 'm', providerType: 'claude-cli' })
  observe({ kind: 'delivered', messageId: 'm', outcome: 'delivered', via: 'p2p' })
  observe({ kind: 'turn_started', retro: false, source: 'fsm_edge' })
  observe({ kind: 'turn_end', strength: 'genuine', reportExpected: true, source: 'completion_flush_genuine' })

  // Strict bridge policy on: without it the handler answers protocol 0 /
  // legacy and never reaches the provenance gate we are pinning.
  setBridgePolicy(store.db, {
    meshId: MESH, rolloutId: 'prepare-auth-rollout', frozen: true,
    builds: [{ commit: 'b'.repeat(40), version: '1.0.82-bridge' }],
  })

  const token = mintWorkerTaskToken({ meshId: MESH, taskId: TASK, sessionId: SESSION, attemptId: ATTEMPT, nodeId: NODE }).token
  const bind = mintWorkerSessionBind({ meshId: MESH, sessionId: SESSION, nodeId: NODE }).bind

  const prepare = (args: any) => workerReportHandlers.worker_bridge_prepare(
    { deps: { statusInstanceId: OWNER_DAEMON, statusVersion: '1.0.82-bridge', instanceManager: { getInstance: () => undefined } } } as any,
    args,
  )
  return { store, token, bind, prepare, ledger }
}

describe('worker_bridge_prepare is reachable by a worker credential and gates on proven identity', () => {
  it('is admitted by the worker-scope gate, because the worker toolset must call it to report', () => {
    // The outbox calls this verb before every strict-protocol send; a worker
    // credential that cannot reach it gets its report quarantined as
    // `provenance_unavailable_at_creation` and silently never delivered.
    expect(isWorkerMcpDaemonVerb('worker_bridge_prepare')).toBe(true)
    expect(WORKER_MCP_DAEMON_VERBS).toContain('worker_bridge_prepare')
  })

  it('admits a worker proving a live task token and returns the exact bound identity', async () => {
    const r = rig()
    const reportedAtMs = Date.now()
    const answer: any = await r.prepare({ token: r.token, deliveryId: 'token-happy', reportedAtMs })
    expect(answer).toMatchObject({ success: true, protocol: 1 })
    // The claim is the daemon's own resolution, not caller-supplied data.
    expect(answer.prepared).toMatchObject({
      meshId: MESH, taskId: TASK, attemptId: ATTEMPT, sessionId: SESSION,
      nodeId: NODE, ownerDaemonId: OWNER_DAEMON, deliveryId: 'token-happy', reportedAtMs,
    })
  })

  it('admits a worker proving a live session bind', async () => {
    const r = rig()
    const answer: any = await r.prepare({ bind: r.bind, deliveryId: 'bind-happy', reportedAtMs: Date.now() })
    expect(answer).toMatchObject({ success: true, protocol: 1 })
    expect(answer.prepared).toMatchObject({ meshId: MESH, taskId: TASK, attemptId: ATTEMPT, sessionId: SESSION, nodeId: NODE })
  })

  it('refuses a caller presenting no credential at all', async () => {
    const r = rig()
    expect(await r.prepare({ deliveryId: 'no-credential', reportedAtMs: Date.now() }))
      .toMatchObject({ success: false, error: 'worker_protocol_provenance_required' })
  })

  it.each([
    ['a forged task token', (r: ReturnType<typeof rig>) => ({ token: `${r.token}tampered` })],
    ['a forged session bind', (r: ReturnType<typeof rig>) => ({ bind: `${r.bind}tampered` })],
    ['a bind this daemon never minted', () => ({ bind: 'wsb_0000000000000000000000000000000000000000000000000000000000000000' })],
    ['a non-string credential', () => ({ token: { nested: 'object' } as any })],
  ])('refuses %s', async (_label, credential) => {
    const r = rig()
    expect(await r.prepare({ ...credential(r), deliveryId: 'forged', reportedAtMs: Date.now() }))
      .toMatchObject({ success: false, error: 'worker_protocol_provenance_required' })
  })

  it('refuses a credential whose session holds no assigned task', async () => {
    const r = rig()
    // A bind for a DIFFERENT session: live mint, but nothing is assigned to it,
    // so it cannot borrow this task's provenance.
    const foreign = mintWorkerSessionBind({ meshId: MESH, sessionId: 'unrelated_session', nodeId: NODE }).bind
    expect(await r.prepare({ bind: foreign, deliveryId: 'foreign-session', reportedAtMs: Date.now() }))
      .toMatchObject({ success: false, error: 'worker_protocol_provenance_required' })
  })

  it.each([
    ['a far-future timestamp', () => Date.now() + 600_000],
    ['a stale timestamp', () => Date.now() - 600_000],
    ['a non-integer timestamp', () => 1.5 as number],
  ])('refuses %s even with a valid credential', async (_label, at) => {
    const r = rig()
    expect(await r.prepare({ token: r.token, deliveryId: 'bad-clock', reportedAtMs: at() }))
      .toMatchObject({ success: false, error: 'worker_protocol_provenance_required' })
  })

  it('cannot read or overwrite another credential\'s prepared delivery', async () => {
    const r = rig()
    const reportedAtMs = Date.now()
    const mine: any = await r.prepare({ token: r.token, deliveryId: 'shared-id', reportedAtMs })
    expect(mine).toMatchObject({ success: true, protocol: 1 })

    // The store is keyed by a hash of the caller's OWN credential, so a second
    // worker reusing the same deliveryId neither sees nor clobbers the first
    // row — it is resolved on its own merits.
    const other: any = await r.prepare({ bind: r.bind, deliveryId: 'shared-id', reportedAtMs })
    expect(other).toMatchObject({ success: true, protocol: 1 })

    // Re-reading with the original credential still yields the original claim.
    const reread: any = await r.prepare({ token: r.token, deliveryId: 'shared-id', reportedAtMs })
    expect(reread.prepared).toEqual(mine.prepared)
  })

  it('refuses a replay that reuses a deliveryId under a new timestamp', async () => {
    const r = rig()
    expect(await r.prepare({ token: r.token, deliveryId: 'replayed', reportedAtMs: Date.now() }))
      .toMatchObject({ success: true, protocol: 1 })
    expect(await r.prepare({ token: r.token, deliveryId: 'replayed', reportedAtMs: Date.now() + 1 }))
      .toMatchObject({ success: false, error: 'worker_delivery_identity_conflict' })
  })

  it('refuses a resume for a delivery it never prepared, rather than inventing provenance', async () => {
    const r = rig()
    expect(await r.prepare({ token: r.token, deliveryId: 'never-prepared', reportedAtMs: Date.now(), resume: true }))
      .toMatchObject({ success: false, error: 'worker_protocol_provenance_unconfirmed' })
  })
})


describe('direct-dispatch creation and report provenance through actual IPC', () => {
  const ctx: any = { deps: { statusInstanceId: OWNER_DAEMON, statusVersion: '1.0.82-bridge', instanceManager: { getInstance: () => undefined } } }
  async function open(r: ReturnType<typeof rig>, suffix: string) {
    const taskId = `direct-${suffix}`, sessionId = `direct-session-${suffix}`
    // mesh_send_task pre-records its assigned queue row before the IPC open.
    const iso = new Date().toISOString()
    r.store.insertQueueEntry({ id: taskId, meshId: MESH, message: 'synthetic direct dispatch', status: 'assigned',
      assignedSessionId: sessionId, assignedNodeId: NODE, createdAt: iso, updatedAt: iso })
    const evidence: any = { eventId: taskId, at: Date.now(), source: 'dispatch', observedBy: OWNER_DAEMON,
      sessionId, taskId, kind: 'dispatch_accepted', scope: 'mesh_direct', meshId: MESH, nodeId: NODE, messageId: taskId }
    const answer: any = await turnLedgerIpcHandlers.turn_observe(ctx, { v: 1, evidence })
    return { taskId, sessionId, evidence, answer }
  }

  it('atomically records exact creation evidence; storage failure and retry never leave a phantom attempt or token', async () => {
    const r = rig()
    r.store.db.exec("CREATE TRIGGER refuse_direct_creation BEFORE INSERT ON turn_events WHEN NEW.event_id='direct-crash' BEGIN SELECT RAISE(ABORT, 'synthetic creation failure'); END")
    const first = await open(r, 'crash')
    expect(first.answer.success).toBe(false)
    expect(r.ledger.store.getAttempt('mesh_direct:direct-crash')).toBeNull()
    expect(findWorkerTaskTokenForSession(MESH, first.taskId, first.sessionId)).toBeNull()
    r.store.db.exec('DROP TRIGGER refuse_direct_creation')
    const retried: any = await turnLedgerIpcHandlers.turn_observe(ctx, { v: 1, evidence: first.evidence })
    expect(retried).toMatchObject({ success: true, verdict: 'applied' })
    const token = findWorkerTaskTokenForSession(MESH, first.taskId, first.sessionId)
    expect(token?.attemptId).toBe(retried.attemptRef.attemptId)
    const event = r.ledger.store.getEvent(first.taskId)!
    expect(event.payload.evidence).toMatchObject(first.evidence)
    expect(event.attemptId).toBe(retried.attemptRef.attemptId)
    expect(event.generation).toBe(0)
    expect(event.verdict).toBe('applied')
    expect(r.ledger.getAttempt(retried.attemptRef.attemptId)).toMatchObject({ ownerDaemonId: OWNER_DAEMON, acceptedAt: first.evidence.at })
    const duplicate: any = await turnLedgerIpcHandlers.turn_observe(ctx, { v: 1, evidence: first.evidence })
    expect(duplicate, JSON.stringify(duplicate)).toMatchObject({ success: true, verdict: 'recorded', attemptRef: retried.attemptRef })
    for (const field of ['taskId', 'sessionId', 'nodeId', 'meshId'] as const) {
      expect(await turnLedgerIpcHandlers.turn_observe(ctx, { v: 1, evidence: { ...first.evidence, [field]: 'wrong-identity' } })).toMatchObject({ success: false })
    }
    expect(findWorkerTaskTokenForSession(MESH, first.taskId, first.sessionId)?.token).toBe(token?.token)
  })

  it.each([false, true])('retains exact report provenance after idle expiry (report-only=%s), accepts once and refuses tampering', async reportOnly => {
    const r = rig(), d = await open(r, `delivery-${reportOnly}`)
    expect(d.answer.success).toBe(true)
    const attemptId = d.answer.attemptRef.attemptId
    const token = findWorkerTaskTokenForSession(MESH, d.taskId, d.sessionId, attemptId)!.token
    const observe = (body: any) => r.ledger.observe({ eventId: `${d.taskId}:${body.kind}`, at: Date.now(), source: 'fsm_edge',
      sessionId: d.sessionId, observedBy: OWNER_DAEMON, attemptRef: { attemptId, generation: 0 }, ...body })
    if (!reportOnly) {
      observe({ kind: 'delivered', messageId: d.taskId, outcome: 'delivered', via: 'local' })
      observe({ kind: 'turn_started', retro: false })
      observe({ kind: 'turn_end', strength: 'genuine', reportExpected: true })
      const hold = r.ledger.store.activeHolds(attemptId).find(h => h.reason === 'await_report')!
      const clock = vi.spyOn(Date, 'now').mockReturnValue(hold.until! + 1)
      observe({ kind: 'liveness', result: 'alive', probeStartedAtMs: Date.now() })
      const expiry = observe({ kind: 'hold_expired', holdId: hold.holdId, reason: 'await_report', source: 'scheduler' })
      expect(expiry.attempt?.terminal).toBeNull()
      expect(r.ledger.store.getAttempt(attemptId)?.state).toBe('finalizing')
      clock.mockRestore()
    }
    const reportedAtMs = Date.now(), deliveryId = `direct-report-${reportOnly}`
    const prepared: any = await r.prepare({ token, deliveryId, reportedAtMs })
    expect(prepared).toMatchObject({ success: true, protocol: 1, prepared: { attemptId, generation: 0, sessionId: d.sessionId, taskId: d.taskId, nodeId: NODE, ownerDaemonId: OWNER_DAEMON } })
    // A lost preparation acknowledgement can resume only this stored claim.
    expect(await r.prepare({ token, deliveryId, reportedAtMs, resume: true })).toEqual(prepared)
    const args = { token, deliveryId, reportedAtMs, prepared: prepared.prepared,
      report: { outcome: 'completed', summary: 'Synthetic direct report.', touchedFiles: [] } }
    for (const field of ['ownerDaemonId', 'attemptId', 'sessionId', 'nodeId', 'generation'] as const) {
      const forged = { ...prepared.prepared, [field]: field === 'generation' ? 1 : 'wrong-identity' }
      expect(await workerReportHandlers.worker_report_completion(ctx, { ...args, prepared: forged })).toMatchObject({ success: false, error: 'worker_protocol_provenance_required' })
    }
    const accepted = await workerReportHandlers.worker_report_completion(ctx, args)
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ success: true })
    expect(r.ledger.store.getAttempt(attemptId)?.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report', reason: 'worker_reported' })
    expect(await workerReportHandlers.worker_report_completion(ctx, args)).toEqual(accepted)
    expect(await r.prepare({ token, deliveryId: 'uncaptured-resume', reportedAtMs, resume: true })).toMatchObject({ success: false, error: 'worker_protocol_provenance_unconfirmed' })
  })

  it.each(['generation', 'ownerDaemonId', 'meshId', 'taskId', 'nodeId', 'sessionId'] as const)('a saved creation/preparation never authorizes a changed %s', async field => {
    const r = rig(), d = await open(r, 'generation-fence')
    const attemptId = d.answer.attemptRef.attemptId
    const token = findWorkerTaskTokenForSession(MESH, d.taskId, d.sessionId, attemptId)!.token
    const reportedAtMs = Date.now(), deliveryId = 'direct-generation-report'
    const prepared: any = await r.prepare({ token, reportedAtMs, deliveryId })
    expect(prepared.success).toBe(true)
    const original = r.ledger.getAttempt(attemptId)!
    // Simulate the persisted cut that a successor daemon loads after a crash.
    r.ledger.store.upsertAttempt({ ...original, [field]: field === 'generation' ? 1 : 'successor-owner' }, Date.now())
    expect(await turnLedgerIpcHandlers.turn_observe(ctx, { v: 1, evidence: d.evidence })).toMatchObject({ success: false })
    expect(await r.prepare({ token, reportedAtMs, deliveryId, resume: true })).toEqual(prepared)
    expect(await workerReportHandlers.worker_report_completion(ctx, {
      token, reportedAtMs, deliveryId, prepared: prepared.prepared,
      report: { outcome: 'completed', summary: 'Synthetic stale generation.', touchedFiles: [] },
    })).toMatchObject({ success: false })
    expect(r.ledger.getAttempt(attemptId)?.terminal).toBeNull()
    expect(findWorkerTaskTokenForSession(MESH, d.taskId, d.sessionId, attemptId)?.token).toBe(token)
  })

})
