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
  mintWorkerSessionBind,
  mintWorkerTaskToken,
  __resetWorkerSessionBindsForTest,
  __resetWorkerTaskTokensForTest,
} from '../../src/mesh/worker-mcp-isolation.js'
import { __setHandoffNoteSinkForTests } from '../../src/mesh/worker-report.js'
import { __setWorkerProgressNoticeSinkForTests } from '../../src/mesh/worker-report-progress.js'
import { WORKER_MCP_DAEMON_VERBS, isWorkerMcpDaemonVerb } from '../../src/standalone-mcp-auth.js'
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
