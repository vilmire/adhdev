import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fakePublisher } from '../turn-ledger/ledger-harness.js'

// Manifest is a durable byte pin, not a request to download or boot anything.
// Tests expose private packaged definitions but exclude BOTH public entrypoints.
const manifestPath = process.env.ADHDEV_WORKER_PACKAGED_MANIFEST
const manifest: any = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
const pinned = JSON.parse(readFileSync(new URL('./worker-report-packaged-pins.json', import.meta.url), 'utf8'))
const caches = new Map<string, any>()
type Flavor = 'rc12' | 'B' | 'F'
const BRIDGE_DELIVERY_COMMAND = 'worker_bridge_delivery'
function compile(path: string, digest: string, boundary: string, suffix: string) {
  const bytes = readFileSync(path)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest)
  const code = bytes.toString(), cut = code.lastIndexOf(boundary)
  expect(cut).toBeGreaterThan(0)
  const mod: any = new Module(path); mod.filename = path
  mod.paths = (Module as any)._nodeModulePaths(resolve('.')); mod.require = createRequire(resolve('package.json'))
  mod._compile(code.slice(0, cut) + suffix, path)
  return mod.exports
}
function packaged(flavor: Flavor): any {
  if (caches.has(flavor)) return caches.get(flavor)
  const pin = manifest[flavor]
  for (const [key, expected] of Object.entries(pinned[flavor])) expect(pin[key]).toBe(expected)
  expect(createHash('sha256').update(readFileSync(pin.tarPath)).digest('hex')).toBe(pin.tarSha256)
  const runtime = compile(pin.daemonPath, pin.daemonSha256, '// src/index.ts\nvar index_exports', `
    init_router(); init_cloud_command_transports(); init_runtime_ledger();
    module.exports = { DaemonCommandRouter, DaemonCommandHandler, CloudCommandTransports,
      workerReportHandlers, MeshRpcEndpoint, MeshRuntimeStore, createMeshRuntimeTurnLedger,
      setActiveTurnLedger, mintWorkerSessionBind, mintWorkerTaskToken,
      __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest,
      __setHandoffNoteSinkForTests, __setWorkerProgressNoticeSinkForTests,
      getDaemonBuildInfo, createCoordinatorNotifier ${flavor === 'rc12' ? '' : ',setBridgePolicy,sendBridgeDelivery,resumeBridgeDeliveries,__resetProgressSurfaceForTest' + (flavor === 'F' ? ',resumeBridgeProgressNotices' : '')} };
  `)
  runtime.build = runtime.getDaemonBuildInfo()
  expect(runtime.build.commit).toBe(pin.commit); expect(runtime.build.version).toBe(pin.version)
  runtime.WorkerReportDelivery = compile(pin.outboxPath, pin.outboxSha256, '// src/index.ts\nfunction parseMcpCliArgsOrExit()', '\nmodule.exports = { WorkerReportDelivery };').WorkerReportDelivery
  caches.set(flavor, runtime); return runtime
}
const cleanup: Array<() => void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) fn()
  for (const runtime of caches.values()) {
    runtime.setActiveTurnLedger(null); runtime.__resetWorkerSessionBindsForTest(); runtime.__resetWorkerTaskTokensForTest()
    runtime.__setHandoffNoteSinkForTests(undefined); runtime.__setWorkerProgressNoticeSinkForTests(undefined)
    runtime.__resetProgressSurfaceForTest?.()
  }
  vi.restoreAllMocks()
})
// The only synthetic transport is the open channel: actual RPC request/ack/result
// serialization, sender stamping, registry dispatch, strict receiver and ledger run.
function link(memberRuntime: any, ownerRuntime: any, receive: any, reverse = false) {
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
  const memberPeer: any = { daemonId: reverse ? 'daemon_mach_test_member' : 'daemon_mach_test_owner', inflight: new Map(), attempt: 1 }
  const ownerPeer: any = { daemonId: reverse ? 'daemon_mach_test_owner' : 'daemon_mach_test_member', inflight: new Map(), attempt: 1 }
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
  return { dispatch, packets, responses, ownerPeer }
}

function rig(memberVersion: Flavor, ownerVersion: Flavor, bridge = true) {
  const memberRuntime = packaged(memberVersion), ownerRuntime = packaged(ownerVersion)
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
  const receiver = new ownerRuntime.CloudCommandTransports({ getHost: () => router })
  const memberHandler = new memberRuntime.DaemonCommandHandler({ cdpManagers: new Map(), adapters: new Map(), ideType: 'test' })
  const memberRouter = new memberRuntime.DaemonCommandRouter({ commandHandler: memberHandler, statusInstanceId: 'daemon_mach_test_member', statusVersion: memberRuntime.build.version, instanceManager: { getInstance: () => ({ getState: () => ({ settings }) }) } })
  memberRouter.inlineMeshCache.set(meshId, { id: meshId, nodes: [{ id: nodeId, daemonId: 'daemon_mach_test_member' }, { id: 'synthetic_owner_node', daemonId: 'daemon_mach_test_owner' }] })
  cleanup.push(() => { memberRouter.meshNodeStatePusher.stop(); memberRouter.localMeshNodeGitWatch.stop() })
  const memberReceiver = new memberRuntime.CloudCommandTransports({ getHost: () => memberRouter })
  const builds = ['B','F'].map((v) => packaged(v as Flavor).build).map(({ commit, version }: any) => ({ commit, version }))
  const policy = { meshId, rolloutId: 'offline-packaged-rollout', frozen: true, builds }
  if (memberVersion !== 'rc12') memberRuntime.setBridgePolicy(member.db, policy)
  if (ownerVersion !== 'rc12') ownerRuntime.setBridgePolicy(owner.db, policy)
  router.deps.statusVersion = ownerRuntime.build.version
  const reverse = link(ownerRuntime, memberRuntime, async (sender: string, command: string, args: any) => {
    const previous = location; location = 'member'
    try { return await memberReceiver.handleMeshCommand(sender, command, args) }
    finally { location = previous }
  }, true)
  router.deps.dispatchMeshCommand = reverse.dispatch
  const wire = link(memberRuntime, ownerRuntime, async (sender: string, command: string, args: any) => {
    location = 'owner'
    try { return await receiver.handleMeshCommand(sender, command, args) }
    finally { location = 'member' }
  })
  let offline = false
  const settings = { meshNodeFor: meshId, meshNodeId: nodeId, meshActiveTaskId: taskId, meshActiveAttemptId: attemptId, meshActiveAttemptGeneration: 0, meshCoordinatorDaemonId: 'daemon_mach_test_owner' }
  const ctx: any = { deps: { statusInstanceId: 'daemon_mach_test_member', statusVersion: memberRuntime.build.version, instanceManager: { getInstance: () => ({ getState: () => ({ settings }) }) }, dispatchMeshCommand: (...args: any[]) => {
    if (offline) throw new Error('synthetic connection closed')
    return (wire.dispatch as any)(...args)
  } } }
  memberRouter.deps.dispatchMeshCommand = ctx.deps.dispatchMeshCommand
  const transport: any = { command: (name: string, args: any) => memberRouter.execute(name, args, 'ipc') }
  let delivery = new memberRuntime.WorkerReportDelivery({ transport, credentials: { bind }, strictProtocol: memberVersion !== 'rc12', dir: bridge ? join(dir, 'outbox') : null, autoSchedule: false, inlineAttempts: 1 })
  const reopenOutbox = () => { delivery.dispose(); delivery = new memberRuntime.WorkerReportDelivery({ transport, credentials: { bind }, strictProtocol: memberVersion !== 'rc12', dir: join(dir, 'outbox'), autoSchedule:false, inlineAttempts:1 }) }
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
  const pump = () => memberRuntime.resumeBridgeDeliveries(wire.dispatch)
  return { memberRuntime, ownerRuntime, reverse, get owner() { return owner }, get member() { return member }, get ledger() { return ledger }, reboot, pump, taskId, meshId, attemptId, bind, localToken, settings, wire, transport, get delivery() { return delivery }, reopenOutbox, report, offline: (value: boolean) => { offline = value } }
}


describe.skipIf(!manifest)('hash-pinned packaged rc12 / checkpoint B / fixed F real command matrix', () => {
  for (const member of ['rc12','B','F'] as Flavor[]) for (const owner of ['rc12','B','F'] as Flavor[]) {
    it(`${member} member -> ${owner} owner: strict support and no false task success`, async () => {
      const r = rig(member, owner)
      const supported = member === 'rc12' && owner === 'rc12' || member !== 'rc12' && owner !== 'rc12'
      for (const [kind, payload] of [['progress',{ note: 'Synthetic packaged progress note.' }],['report',{ report: r.report }]] as const) {
        const result = await r.delivery.submit(kind, payload)
        if (supported) expect(result).toMatchObject({ status: 'answered', result: { success: true } })
        else {
          expect(result).toMatchObject(member === 'rc12' ? { status:'answered', result:{success:false} } : { status:'queued' })
          // Exact rc12 bytes DROP a definitive provenance refusal. This is an
          // unsafe legacy negative control, never a supported active mixed state.
          expect(r.delivery.pendingCount()).toBe(member === 'rc12' ? 0 : kind === 'progress' ? 1 : 2)
          expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
        }
        if (kind === 'progress') expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
      }
      if (supported) expect(r.ledger.getAttempt(r.attemptId).terminal).toMatchObject({ strength: 'tool_report' })
      await r.ledger.flushPublish()
    })
  }
  for (const member of ['B','F'] as Flavor[]) for (const owner of ['B','F'] as Flavor[]) {
    it(`${member} -> ${owner}: progress/refusal/report receipts survive lost ACK and store restart`, async () => {
      const r = rig(member, owner)
      for (const [kind, payload] of [['progress',{ note: 'Synthetic packaged progress.' }],['refusal',{ report: { ...r.report, summary: 'PRIVATE-REJECTED' + 'x'.repeat(8001) } }],['report',{ report: r.report }]] as const) {
        r.offline(true)
        await r.delivery.submit(kind === 'progress' ? 'progress' : 'report', payload)
        const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member' AND state!='receipted' ORDER BY rowid DESC LIMIT 1").get()
        const envelope = JSON.parse(saved.envelope_json)
        r.offline(false)
        const loseAck = async (peer: string, command: string, args: any) => {
          const reply = await r.wire.dispatch(peer, command, args)
          if (command === BRIDGE_DELIVERY_COMMAND) throw new Error('lost final ACK')
          return reply
        }
        expect(await r.memberRuntime.sendBridgeDelivery(r.member.db, envelope, loseAck)).toMatchObject({ success: false, error: 'forward_failed' })
        const deadline = r.ledger.getAttempt(r.attemptId).data.reportCorrection?.until
        await r.ledger.flushPublish(); r.reboot('owner'); r.reboot('member'); r.reopenOutbox()
        const retry = await r.memberRuntime.sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)
        expect(retry.deliveryReceipt).toMatchObject({ deliveryId: envelope.deliveryId, generation: 0, sessionId: envelope.sessionId })
        expect(await r.memberRuntime.sendBridgeDelivery(r.member.db, envelope, r.wire.dispatch)).toEqual(retry)
        if (kind !== 'report') expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
        if (kind === 'refusal') expect(r.ledger.getAttempt(r.attemptId).data.reportCorrection?.until).toBe(deadline)
      }
      for (const kind of ['worker_progress_update','worker_report_refused','worker_tool_report']) expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId,r.taskId,kind)).toHaveLength(1)
      expect(JSON.stringify(r.wire.packets)).not.toContain('PRIVATE-REJECTED')
      expect(r.reverse.packets.some((p: any) => p.command === 'worker_bridge_capabilities')).toBe(true)
      await r.ledger.flushPublish()
    })
  }
  for (const owner of ['B','F'] as Flavor[]) for (const field of ['senderDaemonId','ownerDaemonId','senderCommit','senderVersion','meshId','nodeId','taskId','sessionId','attemptId','generation','reportedAtMs']) {
    it(`F -> ${owner} rejects changed ${field} without task authority`, async () => {
      const r = rig('F',owner); r.offline(true)
      await r.delivery.submit('report',{ report:r.report })
      const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
      const envelope = JSON.parse(saved.envelope_json); envelope.deliveryId += '-negative'
      envelope[field] = field === 'generation' ? 1 : field === 'reportedAtMs' ? Date.now()-3*60*60*1000 : 'impostor'
      r.offline(false)
      expect(await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:envelope.meshId,envelope})).toMatchObject({success:false})
      expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
      await r.ledger.flushPublish()
    })
  }
  for (const kind of ['progress','refusal','report'] as const) {
    it(`F packaged ${kind} receipt failure rolls back evidence before exact restart retry`, async () => {
      const r = rig('F','F')
      const notices: any[] = []
      r.ownerRuntime.__setWorkerProgressNoticeSinkForTests((n: any) => { notices.push(n); return true })
      r.offline(true)
      const payload = kind === 'progress' ? { note:'Synthetic durable packaged progress sufficient to notify a coordinator consumer.' } : { report: kind === 'report' ? r.report : { ...r.report,summary:'PRIVATE-BODY'+ 'x'.repeat(8001) } }
      await r.delivery.submit(kind === 'progress' ? 'progress' : 'report',payload)
      const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
      const envelope = JSON.parse(saved.envelope_json)
      r.owner.db.exec(`CREATE TRIGGER packaged_receipt_failure BEFORE UPDATE OF receipt_json ON worker_bridge_delivery WHEN NEW.side='owner' BEGIN SELECT RAISE(ABORT, 'receipt disk failure'); END`)
      r.offline(false)
      expect(await r.memberRuntime.sendBridgeDelivery(r.member.db,envelope,r.wire.dispatch)).toMatchObject({success:false})
      expect(notices).toHaveLength(0)
      const eventKind = kind === 'progress' ? 'worker_progress_update' : kind === 'refusal' ? 'worker_report_refused' : 'worker_tool_report'
      expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId,r.taskId,eventKind)).toHaveLength(0)
      expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
      expect(r.ledger.getAttempt(r.attemptId).data.reportCorrection).toBeUndefined()
      r.owner.db.exec('DROP TRIGGER packaged_receipt_failure')
      r.reboot('owner'); r.reboot('member'); r.reopenOutbox()
      await r.delivery.flush()
      expect(r.delivery.pendingCount()).toBe(0)
      expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId,r.taskId,eventKind)).toHaveLength(1)
      expect(notices).toHaveLength(kind === 'progress' ? 1 : 0)
      expect(JSON.stringify(r.wire.packets)).not.toContain('PRIVATE-BODY')
      await r.ledger.flushPublish()
    })
  }
  it('checkpoint B negative control leaks a progress sink effect on receipt rollback; B bytes are not a release bridge', async () => {
    const r = rig('F','B'), notices: any[] = []
    r.ownerRuntime.__setWorkerProgressNoticeSinkForTests((n: any) => { notices.push(n) })
    r.owner.db.exec(`CREATE TRIGGER packaged_receipt_failure BEFORE UPDATE OF receipt_json ON worker_bridge_delivery WHEN NEW.side='owner' BEGIN SELECT RAISE(ABORT, 'receipt disk failure'); END`)
    await r.delivery.submit('progress',{note:'Synthetic checkpoint B progress demonstrating pre-commit consumer leakage.'})
    expect(notices).toHaveLength(1)
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId,r.taskId,'worker_progress_update')).toHaveLength(0)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    expect(r.delivery.pendingCount()).toBe(1)
    await r.ledger.flushPublish()
  })
  it('authenticated channel sender mismatch refuses unchanged payload without authority', async () => {
    const r = rig('F','F'); r.offline(true)
    await r.delivery.submit('report',{report:r.report})
    const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope = JSON.parse(saved.envelope_json)
    r.wire.ownerPeer.daemonId = 'daemon_impostor'
    r.offline(false)
    expect(await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:r.meshId,envelope})).toMatchObject({success:false})
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  it('future time and delivery-id content reuse fail without false success', async () => {
    const r = rig('F','F'); r.offline(true)
    await r.delivery.submit('progress',{note:'Original synthetic note.'})
    const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope = JSON.parse(saved.envelope_json); r.offline(false)
    const future = { ...envelope, deliveryId: envelope.deliveryId+'-future', reportedAtMs:Date.now()+300_000 }
    expect(await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:r.meshId,envelope:future})).toMatchObject({success:false})
    await r.memberRuntime.sendBridgeDelivery(r.member.db,envelope,r.wire.dispatch)
    const changed = { ...envelope, payload:{note:'Replaced note on same id.'} }
    expect(await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:r.meshId,envelope:changed})).toMatchObject({success:false})
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  it('F member retains expired unsupported report bytes across outbox and daemon-store restart', async () => {
    const r = rig('F','rc12'); r.offline(true)
    await r.delivery.submit('report',{report:r.report})
    const saved: any = r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope = JSON.parse(saved.envelope_json)
    r.reboot('member'); r.reopenOutbox(); r.offline(false)
    expect(await r.memberRuntime.sendBridgeDelivery(r.member.db,envelope,r.wire.dispatch,envelope.reportedAtMs+3*60*60*1000)).toMatchObject({success:false,quarantined:true})
    const retained: any = r.member.db.prepare("SELECT envelope_json,state FROM worker_bridge_delivery WHERE side='member'").get()
    expect(retained.envelope_json).toBe(saved.envelope_json)
    expect(retained.state).toBe('quarantined'); expect(r.delivery.pendingCount()).toBe(1)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })

  for (const member of ['B','F'] as Flavor[]) it(`${member} -> rc12 keeps unsupported content-free refusal pending`, async () => {
    const r = rig(member,'rc12')
    const answer = await r.delivery.submit('report',{report:{...r.report,summary:'REJECTED-BODY-MARKER'+'x'.repeat(8001)}})
    expect(answer).toMatchObject({status:'answered',result:{success:false,error:'invalid_report',receiptPending:true}})
    expect(r.delivery.pendingCount()).toBe(1)
    expect(JSON.stringify(r.wire.packets)).not.toContain('REJECTED-BODY-MARKER')
    expect(r.wire.packets.some((p: any) => p.command === BRIDGE_DELIVERY_COMMAND)).toBe(false)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
    await r.ledger.flushPublish()
  })
  for (const owner of ['B','F'] as Flavor[]) for (const field of ['generation','reportedAtMs','deliveryId']) it(`${owner} refuses missing ${field} without defaulting provenance`, async () => {
    const r=rig('F',owner);r.offline(true);await r.delivery.submit('report',{report:r.report})
    const saved:any=r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope=JSON.parse(saved.envelope_json);delete envelope[field];r.offline(false)
    expect(await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:r.meshId,envelope})).toMatchObject({success:false})
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull();await r.ledger.flushPublish()
  })
  it('F rejects an admitted but unstored borrowed build claim; checkpoint B is a negative control', async () => {
    for (const owner of ['B','F'] as Flavor[]) {
      const r=rig('F',owner);r.offline(true);await r.delivery.submit('progress',{note:'Synthetic progress.'})
      const saved:any=r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
      const envelope={...JSON.parse(saved.envelope_json),deliveryId:'borrowed-build',senderCommit:packaged('B').build.commit,senderVersion:packaged('B').build.version}
      r.offline(false)
      const reply:any=await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:r.meshId,envelope})
      expect(reply.success).toBe(owner==='B') // Exact old B fails strict build attribution.
      expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull()
      await r.ledger.flushPublish()
    }
  })
  it('F replays an immutable historical B envelope only with exact durable digest attestation', async () => {
    const r=rig('F','F');r.offline(true);await r.delivery.submit('progress',{note:'Synthetic original historical progress.'})
    const saved:any=r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member'").get()
    const envelope={...JSON.parse(saved.envelope_json),deliveryId:'historical-build',senderCommit:packaged('B').build.commit,senderVersion:packaged('B').build.version}
    r.offline(false)
    expect(await r.wire.dispatch('daemon_mach_test_owner',BRIDGE_DELIVERY_COMMAND,{meshId:r.meshId,envelope})).toMatchObject({success:false})
    const stopped=async()=>{throw new Error('synthetic offline before upgrade')}
    await r.memberRuntime.sendBridgeDelivery(r.member.db,envelope,stopped)
    r.reboot('member')
    expect(await r.memberRuntime.sendBridgeDelivery(r.member.db,envelope,r.wire.dispatch)).toMatchObject({success:true})
    const persisted:any=r.member.db.prepare("SELECT envelope_json FROM worker_bridge_delivery WHERE side='member' AND delivery_id='historical-build'").get()
    expect(JSON.parse(persisted.envelope_json)).toEqual(envelope)
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId,r.taskId,'worker_progress_update')).toHaveLength(1)
    expect(r.ledger.getAttempt(r.attemptId).terminal).toBeNull();await r.ledger.flushPublish()
  })

})
