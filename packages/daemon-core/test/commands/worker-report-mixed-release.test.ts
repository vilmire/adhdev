import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { workerBridgeHandlers } from '../../src/commands/low-family/worker-bridge.js'
import { setBridgePolicy, bridgeCapability, sendBridgeDelivery, resumeBridgeDeliveries, BRIDGE_DELIVERY_COMMAND } from '../../src/mesh/worker-bridge.js'
vi.mock('../../src/build-info.js', () => ({ getDaemonBuildInfo: () => ({ commit: 'b'.repeat(40), commitShort: 'bbbbbbb', version: '1.0.82-bridge' }) }))
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
import { resumeBridgeProgressNotices, __resetProgressSurfaceForTest } from '../../src/mesh/worker-report-progress.js'
import { createCoordinatorNotifier } from '../../src/mesh/turn-ledger/deliver.js'
import { fakePublisher } from '../turn-ledger/ledger-harness.js'

// Opt-in artifact integration test. Extract package/dist/index.js from the exact
// rc12 npm tarball; never import/start an installed daemon or read live state.
// The hash pins executable bytes, not a hand-reimplemented legacy decoder.
const artifact = process.env.ADHDEV_RC12_TEST_BUNDLE
const current: any = { DaemonCommandRouter, DaemonCommandHandler, workerReportHandlers, MeshRpcEndpoint, workerBridgeHandlers, MeshRuntimeStore, createMeshRuntimeTurnLedger, setActiveTurnLedger, mintWorkerSessionBind, mintWorkerTaskToken, __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest, __setHandoffNoteSinkForTests, __setWorkerProgressNoticeSinkForTests }
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
  __resetProgressSurfaceForTest()
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

function rig(memberVersion: 'rc12' | 'rc13', ownerVersion: 'rc12' | 'rc13', bridge = false) {
  const old = rc12(), memberRuntime = memberVersion === 'rc12' ? old : current, ownerRuntime = ownerVersion === 'rc12' ? old : current
  const dir = mkdtempSync(join(tmpdir(), 'worker-bridge-runtime-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let owner = new ownerRuntime.MeshRuntimeStore(join(dir, 'owner.db')), member = new memberRuntime.MeshRuntimeStore(join(dir, 'member.db'))
  cleanup.push(() => owner.close(), () => member.close())
  let location: 'owner' | 'member' = 'owner'
  for (const runtime of new Set([ownerRuntime, memberRuntime])) {
    vi.spyOn(runtime.MeshRuntimeStore, 'getInstance').mockImplementation(() => location === 'owner' ? owner : member)
  }
  const meshId = 'synthetic_release_mesh', taskId = 'synthetic_release_task', sessionId = 'synthetic_release_session', nodeId = 'synthetic_release_node'
  const attemptId = `mesh_direct:${taskId}`
  let ledger = ownerRuntime.createMeshRuntimeTurnLedger({ selfDaemonId: 'daemon_mach_test_owner', publisher: fakePublisher() })
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
  const localToken = ownerRuntime.mintWorkerTaskToken({ meshId, taskId, sessionId, attemptId, nodeId }).token
  location = 'member'
  const bind = memberRuntime.mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
  const handler = new ownerRuntime.DaemonCommandHandler({ cdpManagers: new Map(), adapters: new Map(), ideType: 'test' })
  const router = new ownerRuntime.DaemonCommandRouter({ commandHandler: handler, statusInstanceId: 'daemon_mach_test_owner', instanceManager: { getInstance: () => undefined } })
  router.inlineMeshCache.set(meshId, { id: meshId, nodes: [{ id: nodeId, daemonId: 'daemon_mach_test_member' }] })
  cleanup.push(() => { router.meshNodeStatePusher.stop(); router.localMeshNodeGitWatch.stop() })
  const receiver = new old.CloudCommandTransports({ getHost: () => router })
  if (bridge) {
    const policy = { meshId, rolloutId: 'offline-rollout', frozen: true, builds: [{ commit: 'b'.repeat(40), version: '1.0.82-bridge' }] }
    setBridgePolicy(owner.db, policy); setBridgePolicy(member.db, policy)
    router.deps.statusVersion = '1.0.82-bridge'
    router.deps.dispatchMeshCommand = async (_id: string, name: string, args: any) => {
      const previous = location; location = 'member'
      try { return await workerBridgeHandlers[name]({ deps: { statusInstanceId: 'daemon_mach_test_member', statusVersion: '1.0.82-bridge' } } as any, args) }
      finally { location = previous }
    }
  }
  const wire = link(memberRuntime, ownerRuntime, async (sender: string, command: string, args: any) => {
    location = 'owner'
    try { return await receiver.handleMeshCommand(sender, command, args) }
    finally { location = 'member' }
  })
  let offline = false
  const settings = { meshNodeFor: meshId, meshNodeId: nodeId, meshActiveTaskId: taskId, meshActiveAttemptId: attemptId, meshActiveAttemptGeneration: 0, meshCoordinatorDaemonId: 'daemon_mach_test_owner' }
  const ctx: any = { deps: { statusInstanceId: 'daemon_mach_test_member', statusVersion: '1.0.82-bridge', instanceManager: { getInstance: () => ({ getState: () => ({ settings }) }) }, dispatchMeshCommand: (...args: any[]) => {
    if (offline) throw new Error('synthetic connection closed')
    return (wire.dispatch as any)(...args)
  } } }
  const transport: any = { command: (name: string, args: any) => memberRuntime.workerReportHandlers[name](ctx, args) }
  const delivery = new WorkerReportDelivery({ transport, credentials: { bind }, strictProtocol: bridge, dir: bridge ? join(dir, 'outbox') : null, autoSchedule: false, inlineAttempts: 1 })
  cleanup.push(() => delivery.dispose())
  const report = { outcome: 'completed', summary: 'Synthetic accepted report.', touchedFiles: [] }
  const reboot = (side: 'owner' | 'member') => {
    const previous = location; location = side
    if (side === 'owner') {
      owner.close(); owner = new ownerRuntime.MeshRuntimeStore(join(dir, 'owner.db'))
      ledger = ownerRuntime.createMeshRuntimeTurnLedger({ selfDaemonId: 'daemon_mach_test_owner', publisher: fakePublisher() })
      ownerRuntime.setActiveTurnLedger(ledger)
    } else { member.close(); member = new memberRuntime.MeshRuntimeStore(join(dir, 'member.db')) }
    location = previous
  }
  const localCommand = async (name: string, args: any) => {
    const previous = location; location = 'owner'
    try { return await ownerRuntime.workerReportHandlers[name]({ deps: { statusInstanceId: 'daemon_mach_test_owner', statusVersion: '1.0.82-bridge', instanceManager: { getInstance: () => undefined } } }, args) }
    finally { location = previous }
  }
  const pump = () => resumeBridgeDeliveries(wire.dispatch)
  return { get owner() { return owner }, get member() { return member }, get ledger() { return ledger }, reboot, pump, taskId, meshId, attemptId, bind, localToken, localCommand, settings, wire, transport, delivery, report, offline: (value: boolean) => { offline = value } }
}

describe.skipIf(!artifact)('exact packaged rc12 ↔ candidate rc13 worker protocol', () => {
  it('rc13 → rc12: unsupported report/progress stay in the outbox', async () => {
    const r = rig('rc13', 'rc12')
    for (const [kind, payload, command] of [['progress', { note: 'Synthetic progress.' }, 'worker_progress_forwarded'], ['report', { report: r.report }, 'worker_report_forwarded']] as const) {
      const result = await r.delivery.submit(kind, payload)
      expect(result).toMatchObject({ status: 'queued' })
      expect(r.delivery.pendingCount()).toBeGreaterThan(0)
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

  it('rc13 → rc12: reconnecting retains unsupported entries for review', async () => {
    const r = rig('rc13', 'rc12')
    r.offline(true)
    expect(await r.delivery.submit('report', { report: r.report })).toMatchObject({ status: 'queued' })
    expect(r.delivery.pendingCount()).toBe(1)
    r.offline(false)
    await r.delivery.flush()
    expect(r.delivery.pendingCount()).toBe(1)
    expect(r.delivery.takeNotices()).toEqual([])
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.delivery.flush()
    expect(r.wire.packets).toHaveLength(2)
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


describe.skipIf(!artifact)('strict B delivery and restart recovery', () => {
  it('new member cannot bypass the rc12 capability admission; its outbox stays pending', async () => {
    const r = rig('rc13', 'rc12', true)
    expect(await r.delivery.submit('report', { report: r.report })).toMatchObject({ status: 'queued' })
    expect(r.delivery.pendingCount()).toBe(1)
    expect(r.wire.packets.every((packet) => packet.command === 'worker_bridge_capabilities')).toBe(true)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  it('old member cannot send provenance-free reports to an armed B owner', async () => {
    const r = rig('rc12', 'rc13', true)
    const result: any = await r.transport.command('worker_report_completion', { bind: r.bind, report: r.report })
    expect(result).toMatchObject({ success: false, error: 'worker_protocol_provenance_required' })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  it('receipts survive both daemon restarts and duplicate progress/report calls', async () => {
    const r = rig('rc13', 'rc13', true)
    expect(await r.delivery.submit('progress', { note: 'Durable synthetic progress.' })).toMatchObject({ status: 'answered', result: { success: true } })
    const progress = r.wire.packets.find((p) => p.command === BRIDGE_DELIVERY_COMMAND).args.envelope
    r.reboot('owner'); r.reboot('member')
    expect(await sendBridgeDelivery(r.member.db, progress, r.wire.dispatch)).toMatchObject({ success: true })
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_progress_update')).toHaveLength(1)
    expect(await r.delivery.submit('report', { report: r.report })).toMatchObject({ status: 'answered', result: { success: true } })
    const report = r.wire.packets.filter((p) => p.command === BRIDGE_DELIVERY_COMMAND).at(-1).args.envelope
    r.reboot('owner'); r.reboot('member')
    expect(await sendBridgeDelivery(r.member.db, report, r.wire.dispatch)).toMatchObject({ success: true })
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_tool_report')).toHaveLength(1)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ strength: 'tool_report' })
    await r.ledger.flushPublish()
  })
  it('lost final ACK recovers the exact owner receipt after both daemons restart', async () => {
    const r = rig('rc13', 'rc13', true)
    r.offline(true)
    await r.delivery.submit('report', { report: r.report })
    const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope = JSON.parse(saved.envelope_json)
    r.offline(false)
    const loseAck = async (peer: string, command: string, args: any) => {
      const reply = await r.wire.dispatch(peer, command, args)
      if (command === BRIDGE_DELIVERY_COMMAND) throw new Error('synthetic lost final ACK')
      return reply
    }
    expect(await sendBridgeDelivery(r.member.db, envelope, loseAck)).toMatchObject({ success: false, error: 'forward_failed' })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ strength: 'tool_report' })
    r.reboot('owner'); r.reboot('member')
    expect(await sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)).toMatchObject({ success: true })
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_tool_report')).toHaveLength(1)
    await r.ledger.flushPublish()
  })
  it('receipt write failure rolls back report authority and recovers on unchanged retry', async () => {
    const r = rig('rc13', 'rc13', true)
    r.offline(true)
    await r.delivery.submit('report', { report: r.report })
    const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope = JSON.parse(saved.envelope_json)
    r.owner.db.exec(`CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE OF receipt_json ON worker_bridge_delivery
      WHEN NEW.side='owner' BEGIN SELECT RAISE(ABORT, 'synthetic receipt disk failure'); END`)
    r.offline(false)
    expect(await sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)).toMatchObject({ success: false })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_tool_report')).toHaveLength(0)
    expect(r.owner.findQueueEntryById(r.meshId, r.taskId).status).toBe('assigned')
    r.owner.db.exec('DROP TRIGGER synthetic_receipt_failure')
    r.reboot('owner'); r.reboot('member')
    expect(await sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)).toMatchObject({ success: true })
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ strength: 'tool_report' })
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_tool_report')).toHaveLength(1)
    await r.ledger.flushPublish()
  })
  it('prepared local progress cannot first record against a terminal attempt', async () => {
    const r = rig('rc13','rc13',true)
    const progressArgs = { token:r.localToken,deliveryId:'prepared-before-terminal',reportedAtMs:Date.now() }
    const progress = await r.localCommand('worker_bridge_prepare',progressArgs)
    const reportArgs = {...progressArgs,deliveryId:'accepted-terminal-report'}
    const report = await r.localCommand('worker_bridge_prepare',reportArgs)
    expect(await r.localCommand('worker_report_completion',{...reportArgs,prepared:report.prepared,report:r.report})).toMatchObject({success:true})
    expect(await r.localCommand('worker_progress_update',{...progressArgs,prepared:progress.prepared,note:'Synthetic old progress must not first record after task completion.'})).toMatchObject({success:false,error:'stale_report'})
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId,r.taskId,'worker_progress_update')).toHaveLength(0)
    await r.ledger.flushPublish()
  })
  it.each(['progress', 'refusal'] as const)('local %s retains exact prepared identity through storage failure and credential-map restart', async (kind) => {
    const r = rig('rc13', 'rc13', true)
    const args = { token: r.localToken, deliveryId: `local-${kind}`, reportedAtMs: Date.now() }
    const preparation = await r.localCommand('worker_bridge_prepare', args)
    expect(preparation).toMatchObject({ success: true, protocol: 1 })
    const command = kind === 'progress' ? 'worker_progress_update' : 'worker_report_completion'
    const payload = kind === 'progress' ? { note: 'Synthetic durable local progress retained across restart.' } : { report: { ...r.report, summary: 'x'.repeat(8001) } }
    r.owner.db.exec(`CREATE TRIGGER local_receipt_failure BEFORE UPDATE OF receipt_json ON worker_bridge_delivery WHEN NEW.side='local' BEGIN SELECT RAISE(ABORT, 'local receipt storage failure'); END`)
    expect(await r.localCommand(command, { ...args, ...payload, prepared: preparation.prepared })).toMatchObject({ success: false, error: 'storage_failed' })
    const eventKind = kind === 'progress' ? 'worker_progress_update' : 'worker_report_refused'
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, eventKind)).toHaveLength(0)
    r.owner.db.exec('DROP TRIGGER local_receipt_failure')
    r.reboot('owner')
    current.__resetWorkerTaskTokensForTest()
    const answer = await r.localCommand(command, { ...args, ...payload, prepared: preparation.prepared })
    expect(answer).toMatchObject(kind === 'progress' ? { success: true } : { success: false, error: 'invalid_report', receipt: { recorded: true } })
    expect(await r.localCommand(command, { ...args, ...payload, prepared: preparation.prepared })).toEqual(answer)
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, eventKind)).toHaveLength(1)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  it.each(['progress', 'refusal'] as const)('%s receipt write failure rolls back real evidence and side effects before restart retry', async (kind) => {
    const r = rig('rc13', 'rc13', true)
    const notifier = () => createCoordinatorNotifier({ ledger: r.ledger, selfDaemonIds: () => ['daemon_mach_test_owner'] })
    current.__setWorkerProgressNoticeSinkForTests((notice: any) => {
      notifier().notify({ eventId: notice.eventId, event: 'mesh:worker_progress', meshId: notice.meshId, coordinatorMessage: notice.coordinatorMessage, metadataEvent: { taskId: notice.taskId, note: notice.note, terminal: false } })
      return true
    })
    r.offline(true)
    const payload = kind === 'progress' ? { note: 'Synthetic durable progress sufficient to notify the real coordinator consumer.' } : { report: { ...r.report, summary: 'PRIVATE-REJECTED-BODY' + 'x'.repeat(8001) } }
    await r.delivery.submit(kind === 'progress' ? 'progress' : 'report', payload)
    const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope = JSON.parse(saved.envelope_json)
    r.owner.db.exec(`CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE OF receipt_json ON worker_bridge_delivery
      WHEN NEW.side='owner' BEGIN SELECT RAISE(ABORT, 'synthetic receipt disk failure'); END`)
    r.offline(false)
    expect(await sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)).toMatchObject({ success: false })
    const eventKind = kind === 'progress' ? 'worker_progress_update' : 'worker_report_refused'
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, eventKind)).toHaveLength(0)
    expect(r.ledger.getAttempt(r.attemptId).data.reportCorrection).toBeUndefined()
    expect(r.owner.db.prepare("SELECT * FROM turn_events WHERE kind='notify'").all()).toHaveLength(0)
    r.owner.db.exec('DROP TRIGGER synthetic_receipt_failure')
    r.reboot('owner'); r.reboot('member')
    await sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)
    const deadline = r.ledger.getAttempt(r.attemptId).data.reportCorrection?.until
    await r.ledger.flushPublish()
    r.reboot('owner'); r.reboot('member')
    await sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, eventKind)).toHaveLength(1)
    expect(r.ledger.getAttempt(r.attemptId).data.reportCorrection?.until).toBe(deadline)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    if (kind === 'progress') expect(r.owner.db.prepare("SELECT * FROM turn_events WHERE kind='notify'").all()).toHaveLength(1)
    else expect(JSON.stringify(r.wire.packets)).not.toContain('PRIVATE-REJECTED-BODY')
    await r.ledger.flushPublish()
  })
  it('progress consumer failure survives receipt, restart and lost notification acknowledgement with stable id', async () => {
    const r = rig('rc13', 'rc13', true)
    current.__setWorkerProgressNoticeSinkForTests(() => { throw new Error('synthetic consumer storage failure') })
    expect(await r.delivery.submit('progress', { note: 'Synthetic durable progress sufficient to notify the real coordinator consumer.' })).toMatchObject({ status: 'answered', result: { success: true } })
    expect(r.owner.db.prepare("SELECT * FROM worker_bridge_progress_notice WHERE state='pending'").all()).toHaveLength(1)
    r.reboot('owner')
    const notifier = () => createCoordinatorNotifier({ ledger: r.ledger, selfDaemonIds: () => ['daemon_mach_test_owner'] })
    current.__setWorkerProgressNoticeSinkForTests((notice: any) => {
      notifier().notify({ eventId: notice.eventId, event: 'mesh:worker_progress', meshId: notice.meshId, coordinatorMessage: notice.coordinatorMessage, metadataEvent: { taskId: notice.taskId, note: notice.note, terminal: false } })
      return true
    })
    r.owner.db.exec(`CREATE TRIGGER synthetic_notice_ack_failure BEFORE UPDATE OF state ON worker_bridge_progress_notice BEGIN SELECT RAISE(ABORT, 'notice ack lost'); END`)
    resumeBridgeProgressNotices(r.owner.db)
    expect(r.owner.db.prepare("SELECT * FROM worker_bridge_progress_notice WHERE state='pending'").all()).toHaveLength(1)
    r.owner.db.exec('DROP TRIGGER synthetic_notice_ack_failure')
    await r.ledger.flushPublish()
    r.reboot('owner')
    resumeBridgeProgressNotices(r.owner.db)
    expect(r.owner.db.prepare("SELECT * FROM turn_events WHERE kind='notify'").all()).toHaveLength(1)
    expect(r.owner.db.prepare("SELECT * FROM worker_bridge_progress_notice WHERE state='pending'").all()).toHaveLength(0)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  it('refusals remain content-free with durable exact receipts and immutable deadlines after restart', async () => {
    const r = rig('rc13', 'rc13', true)
    const invalid = { ...r.report, summary: 'PRIVATE-BODY' + 'x'.repeat(8001) }
    const result = await r.delivery.submit('report', { report: invalid })
    expect(result).toMatchObject({ status: 'answered', result: { success: false, error: 'invalid_report', receipt: { recorded: true } } })
    const envelope = r.wire.packets.find((p) => p.command === BRIDGE_DELIVERY_COMMAND).args.envelope
    expect(envelope.kind).toBe('refusal')
    expect(JSON.stringify(r.wire.packets)).not.toContain('PRIVATE-BODY')
    expect(JSON.stringify(r.wire.packets)).not.toContain(r.bind)
    const deadline = r.ledger.getAttempt(r.attemptId).data.reportCorrection.until
    r.reboot('owner'); r.reboot('member')
    await sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)
    expect(r.ledger.getAttempt(r.attemptId).data.reportCorrection.until).toBe(deadline)
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, 'worker_report_refused')).toHaveLength(1)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  it.each(['senderDaemonId','ownerDaemonId','meshId','nodeId','taskId','sessionId','attemptId','generation','reportedAtMs'])(
    'refuses changed %s without false completion', async (field) => {
      const r = rig('rc13', 'rc13', true)
      r.offline(true)
      await r.delivery.submit('report', { report: r.report })
      const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
      const envelope = JSON.parse(saved.envelope_json)
      envelope.deliveryId += '-negative'
      envelope[field] = field === 'generation' ? 1 : field === 'reportedAtMs' ? Date.now() - 3 * 60 * 60 * 1000 : 'impostor'
      r.offline(false)
      const result = await r.wire.dispatch('daemon_mach_test_owner', BRIDGE_DELIVERY_COMMAND, { meshId: envelope.meshId, envelope })
      expect(result.success).toBe(false)
      expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
      await r.ledger.flushPublish()
    })
  it('build mismatch requires an exact stored-envelope capability attestation', async () => {
    const r = rig('rc13','rc13',true)
    const policy = { meshId:r.meshId,rolloutId:'offline-rollout',frozen:true,builds:[{commit:'b'.repeat(40),version:'1.0.82-bridge'},{commit:'c'.repeat(40),version:'1.0.82-bridge'}] }
    setBridgePolicy(r.owner.db,policy); setBridgePolicy(r.member.db,policy)
    r.offline(true); await r.delivery.submit('report',{report:r.report})
    const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const original = JSON.parse(saved.envelope_json)
    const historical = {...original,deliveryId:original.deliveryId+'-historical',senderCommit:'c'.repeat(40)}
    r.offline(false)
    expect(await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:r.meshId,envelope:historical})).toMatchObject({success:false})
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    // Retry journals the historical ORIGINAL claim before the reverse challenge;
    // the new build attests that exact digest without stripping the old stamp.
    expect(await sendBridgeDelivery(r.member.db,historical,r.wire.dispatch)).toMatchObject({success:true})
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({strength:'tool_report'})
    await r.ledger.flushPublish()
  })
  it('does not retarget a prepared report after member assignment generation changes', async () => {
    const r = rig('rc13', 'rc13', true)
    r.offline(true)
    await r.delivery.submit('report', { report: r.report })
    r.settings.meshActiveAttemptGeneration = 1
    r.reboot('member')
    r.offline(false)
    await r.delivery.flush()
    const envelope = r.wire.packets.find((p) => p.command === BRIDGE_DELIVERY_COMMAND).args.envelope
    expect(envelope.generation).toBe(0)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ strength: 'tool_report' })
    await r.ledger.flushPublish()
  })
})
