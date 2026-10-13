import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { DaemonCommandRouter } from '../../src/commands/router.js'
import { DaemonCommandHandler } from '../../src/commands/handler.js'
import { workerReportHandlers } from '../../src/commands/low-family/worker-report.js'
import { MeshRpcEndpoint } from '../../src/mesh/transport/mesh-rpc-endpoint.js'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js'
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js'
import { mintWorkerSessionBind, mintWorkerTaskToken, __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest } from '../../src/mesh/worker-mcp-isolation.js'
import { __setHandoffNoteSinkForTests } from '../../src/mesh/worker-report.js'
import { __setWorkerProgressNoticeSinkForTests } from '../../src/mesh/worker-report-progress.js'
import { WorkerReportDelivery } from '../../../mcp-server/src/tools/worker-report-outbox.js'
import { fakePublisher } from '../turn-ledger/ledger-harness.js'

// Opt-in artifact integration test. Extract package/dist/index.js from the exact
// rc12 npm tarball; never import/start an installed daemon or read live state.
// The hash pins executable bytes, not a hand-reimplemented legacy decoder.
const artifact = process.env.ADHDEV_RC12_TEST_BUNDLE
const current: any = { DaemonCommandRouter, DaemonCommandHandler, workerReportHandlers, MeshRpcEndpoint, MeshRuntimeStore, createMeshRuntimeTurnLedger, setActiveTurnLedger, mintWorkerSessionBind, mintWorkerTaskToken, __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest, __setHandoffNoteSinkForTests, __setWorkerProgressNoticeSinkForTests }
let legacy: any
function rc12() {
  if (legacy) return legacy
  const filename = resolve(artifact!)
  const bytes = readFileSync(filename)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('fed191d5b0e09a9851b0fc8e8c8068da566f0b2e64e972d27be9e24a3132e291')
  const code = bytes.toString()
  const boundary = code.indexOf('// src/index.ts\nvar index_exports')
  expect(boundary).toBeGreaterThan(0)
  // Expose packaged internals for tests, leaving their implementations intact.
  // Exclude the public entrypoint; initialize only the tested modules. Dependencies
  // resolve from this workspace, including its Node22-compatible SQLite binding.
  const mod: any = new Module(filename)
  mod.filename = filename
  mod.paths = (Module as any)._nodeModulePaths(resolve('.'))
  mod.require = createRequire(resolve('package.json'))
  mod._compile(code.slice(0, boundary) + `
    init_router(); init_cloud_command_transports(); init_runtime_ledger();
    module.exports = { DaemonCommandRouter, DaemonCommandHandler, CloudCommandTransports,
      workerReportHandlers, MeshRpcEndpoint, MeshRuntimeStore, createMeshRuntimeTurnLedger,
      setActiveTurnLedger, mintWorkerSessionBind, mintWorkerTaskToken,
      __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest,
      __setHandoffNoteSinkForTests, __setWorkerProgressNoticeSinkForTests };
  `, filename)
  return legacy = mod.exports
}

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
  for (const runtime of [current, legacy].filter(Boolean)) {
    runtime.setActiveTurnLedger(null)
    runtime.__resetWorkerSessionBindsForTest()
    runtime.__resetWorkerTaskTokensForTest()
    runtime.__setHandoffNoteSinkForTests(undefined)
    runtime.__setWorkerProgressNoticeSinkForTests(undefined)
  }
  vi.restoreAllMocks()
})

// The only synthetic transport is the open channel: actual RPC request/ack/result
// serialization, sender stamping, registry dispatch, strict receiver and ledger run.
function link(memberRuntime: any, ownerRuntime: any, receive: any) {
  function endpoint(runtime: any, callback?: any) {
    class TestEndpoint extends runtime.MeshRpcEndpoint {
      constructor() { super(); this.commandCallback = callback }
      failure(message: string) { return new Error(message) }
      noteRequestTimeout() {}
      emitPeerOpen() {}
      flushConnectQueue() {}
    }
    return new TestEndpoint() as any
  }
  const member = endpoint(memberRuntime), owner = endpoint(ownerRuntime, receive)
  const packets: any[] = [], responses: any[] = []
  let seq = 0
  const memberPeer: any = { daemonId: 'daemon_mach_test_owner', inflight: new Map(), attempt: 1 }
  const ownerPeer: any = { daemonId: 'daemon_mach_test_member', inflight: new Map(), attempt: 1 }
  memberPeer.dc = { isOpen: () => true, sendMessage: (json: string) => {
    const req = JSON.parse(json); packets.push(req)
    queueMicrotask(() => owner.handleIncomingRequest(ownerPeer, req))
  } }
  ownerPeer.dc = { isOpen: () => true, sendMessage: (json: string) => {
    const res = JSON.parse(json)
    responses.push(res)
    queueMicrotask(() => res.kind === 'rpc_ack' ? member.handleIncomingAck(memberPeer, res) : member.handleIncomingResponse(memberPeer, res))
  } }
  const dispatch = (_id: string, command: string, args: any) => new Promise((resolve, reject) => {
    member.writeRequest(memberPeer, { id: `test-rpc-${++seq}`, command, args, resolve, reject, queuedAt: new Date().toISOString(), resultTimeoutMs: 1000 })
  })
  return { dispatch, packets, responses }
}

function rig(memberVersion: 'rc12' | 'rc13', ownerVersion: 'rc12' | 'rc13') {
  const old = rc12(), memberRuntime = memberVersion === 'rc12' ? old : current, ownerRuntime = ownerVersion === 'rc12' ? old : current
  const owner = new ownerRuntime.MeshRuntimeStore(':memory:'), member = new memberRuntime.MeshRuntimeStore(':memory:')
  cleanup.push(() => owner.close(), () => member.close())
  let location: 'owner' | 'member' = 'owner'
  for (const runtime of new Set([ownerRuntime, memberRuntime])) {
    vi.spyOn(runtime.MeshRuntimeStore, 'getInstance').mockImplementation(() => location === 'owner' ? owner : member)
  }
  const meshId = 'synthetic_release_mesh', taskId = 'synthetic_release_task', sessionId = 'synthetic_release_session', nodeId = 'synthetic_release_node'
  const attemptId = `mesh_direct:${taskId}`
  const ledger = ownerRuntime.createMeshRuntimeTurnLedger({ selfDaemonId: 'daemon_mach_test_owner', publisher: fakePublisher() })
  ownerRuntime.setActiveTurnLedger(ledger)
  ownerRuntime.__setHandoffNoteSinkForTests(() => {})
  ownerRuntime.__setWorkerProgressNoticeSinkForTests(() => {})
  const iso = new Date().toISOString()
  owner.insertQueueEntry({ id: taskId, meshId, message: 'synthetic', status: 'assigned', assignedSessionId: sessionId, assignedNodeId: nodeId, createdAt: iso, updatedAt: iso })
  let seq = 0
  const observe = (body: any) => ledger.observe({ eventId: `release-${++seq}`, at: Date.now(), source: 'dispatch', observedBy: 'daemon_mach_test_owner', sessionId, attemptRef: { attemptId, generation: 0 }, ...body })
  observe({ kind: 'dispatch_accepted', scope: 'mesh_direct', meshId, taskId, nodeId, messageId: 'test-message', providerType: 'claude-cli' })
  observe({ kind: 'delivered', messageId: 'test-message', outcome: 'delivered', via: 'p2p' })
  observe({ kind: 'turn_started', retro: false, source: 'fsm_edge' })
  observe({ kind: 'turn_end', strength: 'genuine', reportExpected: true, source: 'completion_flush_genuine' })
  ownerRuntime.mintWorkerTaskToken({ meshId, taskId, sessionId, attemptId, nodeId })
  location = 'member'
  const bind = memberRuntime.mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
  const handler = new ownerRuntime.DaemonCommandHandler({ cdpManagers: new Map(), adapters: new Map(), ideType: 'test' })
  const router = new ownerRuntime.DaemonCommandRouter({ commandHandler: handler, statusInstanceId: 'daemon_mach_test_owner', instanceManager: { getInstance: () => undefined } })
  router.inlineMeshCache.set(meshId, { id: meshId, nodes: [{ id: nodeId, daemonId: 'daemon_mach_test_member' }] })
  cleanup.push(() => { router.meshNodeStatePusher.stop(); router.localMeshNodeGitWatch.stop() })
  const receiver = new old.CloudCommandTransports({ getHost: () => router })
  const wire = link(memberRuntime, ownerRuntime, async (sender: string, command: string, args: any) => {
    location = 'owner'
    try { return await receiver.handleMeshCommand(sender, command, args) }
    finally { location = 'member' }
  })
  let offline = false
  const settings = { meshNodeFor: meshId, meshNodeId: nodeId, meshActiveTaskId: taskId, meshActiveAttemptId: attemptId, meshActiveAttemptGeneration: 0, meshCoordinatorDaemonId: 'daemon_mach_test_owner' }
  const ctx: any = { deps: { statusInstanceId: 'daemon_mach_test_member', instanceManager: { getInstance: () => ({ getState: () => ({ settings }) }) }, dispatchMeshCommand: (...args: any[]) => {
    if (offline) throw new Error('synthetic connection closed')
    return (wire.dispatch as any)(...args)
  } } }
  const transport: any = { command: (name: string, args: any) => memberRuntime.workerReportHandlers[name](ctx, args) }
  const delivery = new WorkerReportDelivery({ transport, credentials: { bind }, dir: null, autoSchedule: false, inlineAttempts: 1 })
  cleanup.push(() => delivery.dispose())
  const report = { outcome: 'completed', summary: 'Synthetic accepted report.', touchedFiles: [] }
  return { owner, ledger, taskId, meshId, attemptId, bind, settings, wire, transport, delivery, report, offline: (value: boolean) => { offline = value } }
}

describe.skipIf(!artifact)('exact packaged rc12 ↔ candidate rc13 worker protocol', () => {
  it('rc13 → rc12: valid report/progress are refused and removed from the outbox', async () => {
    const r = rig('rc13', 'rc12')
    for (const [kind, payload, command] of [['progress', { note: 'Synthetic progress.' }, 'worker_progress_forwarded'], ['report', { report: r.report }, 'worker_report_forwarded']] as const) {
      const result = await r.delivery.submit(kind, payload)
      expect(result).toMatchObject({ status: 'answered', result: { success: false, error: `${command}: request failed decode (bad shape)` } })
      expect(r.delivery.pendingCount()).toBe(0)
      expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
      expect(r.owner.findQueueEntryById(r.meshId, r.taskId).status).toBe('assigned')
    }
    expect(r.wire.packets[0].args.generation).toBe(0)
    expect(r.wire.packets[1].args).toMatchObject({ generation: 0, deliveryId: expect.any(String), reportedAtMs: expect.any(Number) })
    await r.ledger.flushPublish()
  })

  it('rc13 → rc12: content-free refusal relay is unknown and has no owner receipt', async () => {
    const r = rig('rc13', 'rc12')
    const result: any = await r.transport.command('worker_report_completion', { bind: r.bind, report: { ...r.report, summary: 'PRIVATE-MARKER' + 'x'.repeat(8001) }, deliveryId: 'test-refusal', reportedAtMs: Date.now() })
    expect(result).toMatchObject({ success: false, error: 'invalid_report' })
    expect(result.receipt).toBeUndefined()
    expect(r.wire.packets[0].command).toBe('worker_report_refusal_forwarded')
    expect(r.wire.responses.find((res) => res.kind === 'rpc_res').result).toMatchObject({ success: false, error: 'Unknown command: worker_report_refusal_forwarded' })
    expect(JSON.stringify(r.wire.packets)).not.toContain('PRIVATE-MARKER')
    expect(JSON.stringify(r.wire.packets)).not.toContain(r.bind)
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_report_refused')).toEqual([])
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })

  it.each([['rc12', 'rc12'], ['rc12', 'rc13'], ['rc13', 'rc13']] as const)('%s → %s: progress stays nonterminal and exact report completes once', async (member, owner) => {
    const r = rig(member, owner)
    expect(await r.delivery.submit('progress', { note: 'Synthetic progress.' })).toMatchObject({ status: 'answered', result: { success: true } })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    expect(await r.delivery.submit('report', { report: r.report })).toMatchObject({ status: 'answered', result: { success: true } })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' })
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_tool_report')).toHaveLength(1)
    await r.ledger.flushPublish()
  })

  it('rc13 → rc13: transient relay failure recovers with identical delivery/time/generation', async () => {
    const r = rig('rc13', 'rc13')
    r.offline(true)
    expect(await r.delivery.submit('report', { report: r.report })).toMatchObject({ status: 'queued' })
    expect(r.delivery.pendingCount()).toBe(1)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    r.offline(false)
    await r.delivery.flush()
    expect(r.delivery.pendingCount()).toBe(0)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ strength: 'tool_report' })
    const packet = r.wire.packets[0].args
    expect(await r.transport.command('worker_report_completion', { bind: r.bind, report: r.report, deliveryId: packet.deliveryId, reportedAtMs: packet.reportedAtMs })).toMatchObject({ success: true, duplicate: true })
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_tool_report')).toHaveLength(1)
    await r.ledger.flushPublish()
  })

  it('rc13 → rc13: stale generation is refused without task completion', async () => {
    const r = rig('rc13', 'rc13')
    r.settings.meshActiveAttemptGeneration = 1
    expect(await r.delivery.submit('report', { report: r.report })).toMatchObject({ status: 'answered', result: { success: false, error: 'unauthenticated' } })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })

  it('rc13 → rc12: reconnecting does not recover a report after the decode refusal', async () => {
    const r = rig('rc13', 'rc12')
    r.offline(true)
    expect(await r.delivery.submit('report', { report: r.report })).toMatchObject({ status: 'queued' })
    expect(r.delivery.pendingCount()).toBe(1)
    r.offline(false)
    await r.delivery.flush()
    expect(r.delivery.pendingCount()).toBe(0)
    expect(r.delivery.takeNotices().join('\n')).toContain('request failed decode')
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.delivery.flush()
    expect(r.wire.packets).toHaveLength(1)
    await r.ledger.flushPublish()
  })

  it('stripping rc13 fences lets rc12 accept a report from the wrong generation', async () => {
    const r = rig('rc13', 'rc12')
    r.settings.meshActiveAttemptGeneration = 1
    await r.delivery.submit('report', { report: r.report })
    const { generation, deliveryId, reportedAtMs, ...downgraded } = r.wire.packets[0].args
    expect(generation).toBe(1)
    expect(deliveryId).toBeTypeOf('string')
    expect(reportedAtMs).toBeTypeOf('number')
    expect(r.ledger.getAttempt(r.attemptId).generation).toBe(0)
    // Negative control only: this is precisely the unsafe fallback we must not ship.
    expect(await r.wire.dispatch('daemon_mach_test_owner', 'worker_report_forwarded', downgraded)).toMatchObject({ success: true })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' })
    await r.ledger.flushPublish()
  })
})
