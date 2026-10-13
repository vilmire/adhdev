import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js'
import { workerReportHandlers, WORKER_REFUSAL_FORWARD_COMMAND } from '../../src/commands/low-family/worker-report.js'
import { mintWorkerSessionBind, mintWorkerTaskToken, __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest } from '../../src/mesh/worker-mcp-isolation.js'
import { createMeshRuntimeTurnLedger } from '../../src/mesh/turn-ledger/runtime-ledger.js'
import { setActiveTurnLedger } from '../../src/mesh/turn-ledger/active-ledger.js'
import { __setHandoffNoteSinkForTests, WORKER_REPORT_REFUSED_EVENT_KIND } from '../../src/mesh/worker-report.js'
import { fakePublisher } from '../turn-ledger/ledger-harness.js'
import { reportCompletion } from '../../../mcp-server/src/tools/worker-tools.js'
import { WorkerReportDelivery } from '../../../mcp-server/src/tools/worker-report-outbox.js'

const stores: MeshRuntimeStore[] = []
afterEach(() => {
  setActiveTurnLedger(null)
  vi.restoreAllMocks()
  __resetWorkerSessionBindsForTest()
  __resetWorkerTaskTokensForTest()
  __setHandoffNoteSinkForTests(undefined)
  for (const store of stores.splice(0)) store.close()
})

// Separate real SQLite runtimes model the member and owner. Only the transport
// switches which daemon's runtime singleton the production handler can see.
function rig() {
  const owner: MeshRuntimeStore = new (MeshRuntimeStore as any)(':memory:')
  const member: MeshRuntimeStore = new (MeshRuntimeStore as any)(':memory:')
  stores.push(owner, member)
  let current = owner
  vi.spyOn(MeshRuntimeStore, 'getInstance').mockImplementation(() => current)
  const meshId = 'refusal_remote_mesh', taskId = 'refusal_remote_task', sessionId = 'refusal_remote_session', nodeId = 'refusal_remote_node'
  const attemptId = `mesh_direct:${taskId}`
  const ledger = createMeshRuntimeTurnLedger({ selfDaemonId: 'owner', publisher: fakePublisher() })
  setActiveTurnLedger(ledger)
  __setHandoffNoteSinkForTests(() => {})
  const iso = new Date().toISOString()
  owner.insertQueueEntry({ id: taskId, meshId, message: 'synthetic', status: 'assigned', assignedSessionId: sessionId, assignedNodeId: nodeId, createdAt: iso, updatedAt: iso } as any)
  let seq = 0
  const observe = (body: any, extra: any = {}) => ledger.observe({ eventId: `remote-${++seq}`, at: Date.now(), source: 'dispatch', observedBy: 'owner', sessionId, attemptRef: { attemptId, generation: 0 }, ...extra, ...body })
  observe({ kind: 'dispatch_accepted', scope: 'mesh_direct', meshId, taskId, nodeId, messageId: 'remote-message', providerType: 'claude-cli' }, { taskId })
  observe({ kind: 'delivered', messageId: 'remote-message', outcome: 'delivered', via: 'p2p' })
  observe({ kind: 'turn_started', retro: false }, { source: 'fsm_edge' })
  observe({ kind: 'turn_end', strength: 'genuine', reportExpected: true }, { source: 'completion_flush_genuine' })
  mintWorkerTaskToken({ meshId, taskId, sessionId, attemptId, nodeId })
  current = member
  const bind = mintWorkerSessionBind({ meshId, sessionId, nodeId }).bind
  const ownerCtx: any = { deps: { statusInstanceId: 'owner', instanceManager: { getInstance: () => undefined } }, getMeshForCommand: async () => ({ mesh: { id: meshId, nodes: [{ id: nodeId, daemonId: 'member' }] } }) }
  const packets: Array<{ command: string; args: any }> = []
  const memberCtx: any = { deps: { statusInstanceId: 'member', instanceManager: { getInstance: () => ({ getState: () => ({ settings: { meshNodeFor: meshId, meshNodeId: nodeId, meshActiveTaskId: taskId, meshActiveAttemptId: attemptId, meshActiveAttemptGeneration: 0, meshCoordinatorDaemonId: 'owner' } }) }) }, dispatchMeshCommand: async (_id: string, command: string, args: any) => {
    packets.push({ command, args })
    current = owner
    try { return await workerReportHandlers[command](ownerCtx, { ...args, _meshSenderDaemonId: 'member' }) }
    finally { current = member }
  } } }
  const transport: any = { command: (name: string, args: any) => workerReportHandlers[name](memberCtx, args) }
  const delivery = new WorkerReportDelivery({ transport, credentials: { bind }, dir: null, autoSchedule: false, inlineAttempts: 1, sleep: async () => {}, log: () => {} })
  const report = (summary: string) => reportCompletion(transport, { bind }, { outcome: 'completed', summary, touched_files: [] }, delivery)
  const ownerCall = async (args: any, sender = 'member') => {
    current = owner
    try { return await workerReportHandlers[WORKER_REFUSAL_FORWARD_COMMAND](ownerCtx, { ...args, _meshSenderDaemonId: sender }) }
    finally { current = member }
  }
  return { owner, member, ledger, meshId, taskId, attemptId, bind, delivery, packets, report, ownerCall }
}

describe('remote refusal: real member → authenticated owner → exact ledger', () => {
  it('forwards only safe metadata, records the owner receipt once, and accepts a valid correction', async () => {
    const r = rig()
    const marker = 'DO-NOT-FORWARD-REJECTED-CONTENT'
    const result = await r.report(marker + 'x'.repeat(8001))
    expect(result.isError).toBe(true)
    expect(result.text).toContain(`attempt ${r.attemptId}, generation 0`)
    expect(result.text).toMatch(/Delivery wr_/)
    expect(result.text).not.toMatch(/queued|NOT lost/)
    expect(r.delivery.pendingCount()).toBe(0)
    expect(r.packets).toHaveLength(1)
    expect(r.packets[0].command).toBe(WORKER_REFUSAL_FORWARD_COMMAND)
    const packet = r.packets[0].args
    expect(Object.keys(packet).sort()).toEqual(['attemptId', 'deliveryId', 'fields', 'generation', 'meshId', 'nodeId', 'reportedAtMs', 'sessionId', 'summaryLength', 'taskId'].sort())
    expect(JSON.stringify(packet)).not.toContain(marker)
    expect(JSON.stringify(packet)).not.toContain(r.bind)
    const rows = () => r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, WORKER_REPORT_REFUSED_EVENT_KIND)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ attemptId: r.attemptId, generation: 0, payload: { deliveryId: packet.deliveryId, summaryLength: marker.length + 8001 } })
    expect(r.member.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, WORKER_REPORT_REFUSED_EVENT_KIND)).toEqual([])
    const deadline = r.ledger.getAttempt(r.attemptId)!.data.reportCorrection!.until
    expect((await r.ownerCall(packet) as any).receipt.recorded).toBe(true)
    expect(rows()).toHaveLength(1)
    expect(r.ledger.getAttempt(r.attemptId)!.data.reportCorrection!.until).toBe(deadline)
    const corrected = await r.report('Corrected remote report.')
    expect(corrected.isError).toBeFalsy()
    expect(r.ledger.getAttempt(r.attemptId)!.terminal).toMatchObject({ outcome: 'completed', strength: 'tool_report' })
    expect(r.owner.findQueueEntryById(r.meshId, r.taskId)!.status).toBe('completed')
    await r.ledger.flushPublish()
  })

  it('refuses forged sender, stale generation/time and unsafe metadata without recording another row', async () => {
    const r = rig()
    await r.report('x'.repeat(8001))
    const packet = r.packets[0].args
    expect(await r.ownerCall(packet, 'impostor')).toMatchObject({ success: false, error: 'unauthenticated' })
    expect(await r.ownerCall({ ...packet, generation: 1 })).toMatchObject({ success: false, error: 'unauthenticated' })
    expect(await r.ownerCall({ ...packet, reportedAtMs: Date.now() - 3 * 60 * 60 * 1000 })).toMatchObject({ success: false, error: 'invalid_refusal_envelope' })
    expect(await r.ownerCall({ ...packet, fields: ['private-body'] })).toMatchObject({ success: false, error: 'invalid_refusal_envelope' })
    expect(await r.ownerCall({ ...packet, report: { summary: 'raw rejected body' } })).toMatchObject({ success: false, error: 'invalid_refusal_envelope' })
    expect(r.owner.turnStore().listWorkerEventsForTask(r.meshId, r.taskId, WORKER_REPORT_REFUSED_EVENT_KIND)).toHaveLength(1)
    expect(r.ledger.getAttempt(r.attemptId)!.terminal).toBeNull()
    await r.ledger.flushPublish()
  })
})
