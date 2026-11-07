/**
 * Live 2026-11-07: `contract_current` on a worker running on a MEMBER daemon was refused `unauthenticated`.
 * The attempt and the contract state live on the owner/host, so the member relays the call to the owner
 * (`worker_contract_forwarded`), exactly as a remote worker's report travels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contractCommandHandlers, contractCommandSpecs, WORKER_CONTRACT_FORWARD_COMMAND } from '../../src/commands/low-family/contract-commands'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { createContractCtx, MemoryContractAuthorityFence } from '../../src/mesh/contract/contract-store'
import { __setContractCtxForTests } from '../../src/mesh/contract-runtime'
import { __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest, mintWorkerSessionBind, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed'
import { FakeSourceReader } from '../mesh/contract/contract-test-helpers'

const WORKER_DAEMON = 'daemon_mach_worker_wc'
const OWNER_DAEMON = 'test-daemon'
let seq = 0
const ids = () => { seq += 1; return { meshId: `mesh_wc_${seq}`, taskId: `task_wc_${seq}`, sessionId: `session_wc_${seq}`, nodeId: `node_wc_${seq}` } }
type Ids = ReturnType<typeof ids>

function memberCtx(i: Ids, attemptId: string, dispatch?: (d: string, c: string, a: Record<string, unknown>) => Promise<unknown>): any {
  const settings = { meshNodeFor: i.meshId, meshNodeId: i.nodeId, meshActiveTaskId: i.taskId, meshActiveAttemptId: attemptId, meshActiveAttemptGeneration: 0, meshCoordinatorDaemonId: OWNER_DAEMON }
  return { deps: { statusInstanceId: WORKER_DAEMON, instanceManager: { getInstance: (id: string) => (id === i.sessionId ? { getState: () => ({ settings }) } : undefined) }, ...(dispatch ? { dispatchMeshCommand: dispatch } : {}) } }
}
function ownerCtx(i: Ids): any {
  return { deps: { statusInstanceId: OWNER_DAEMON, instanceManager: { getInstance: () => undefined } },
    getMeshForCommand: async () => ({ mesh: { id: i.meshId, nodes: [{ id: i.nodeId, daemonId: WORKER_DAEMON }] }, inline: true, source: 'inline_cache' }) }
}
function seedOwnerLiveTask(i: Ids): string {
  const now = new Date().toISOString()
  MeshRuntimeStore.getInstance().insertQueueEntry({ id: i.taskId, meshId: i.meshId, message: 'x', status: 'assigned', assignedSessionId: i.sessionId, assignedNodeId: i.nodeId, createdAt: now, updatedAt: now } as any)
  const a = seedMeshAttempt({ meshId: i.meshId, taskId: i.taskId, sessionId: i.sessionId, nodeId: i.nodeId, scope: 'mesh_direct', stage: 'consumed', attemptId: `mesh_direct:${i.taskId}` })
  mintWorkerTaskToken({ meshId: i.meshId, taskId: i.taskId, attemptId: a.attemptId, sessionId: i.sessionId, nodeId: i.nodeId })
  return a.attemptId
}

beforeEach(() => {
  __resetWorkerTaskTokensForTest(); __resetWorkerSessionBindsForTest()
  __setContractCtxForTests(createContractCtx({ db: MeshRuntimeStore.getInstance().db, localDaemonId: OWNER_DAEMON, fence: new MemoryContractAuthorityFence(), sourceReader: new FakeSourceReader() }))
})
afterEach(() => { __setContractCtxForTests(undefined as any); __resetWorkerTaskTokensForTest(); __resetWorkerSessionBindsForTest() })

describe('worker contract tools on a member daemon', () => {
  it('forwards contract_current to the owner and returns its answer', async () => {
    // The owner's state appears only when the call reaches it (member and owner share one store in-process).
    const i = ids(); const attemptId = `mesh_direct:${i.taskId}`
    const bind = mintWorkerSessionBind({ meshId: i.meshId, sessionId: i.sessionId, nodeId: i.nodeId }).bind
    const relay = vi.fn(async (_d: string, cmd: string, args: Record<string, unknown>) => {
      seedOwnerLiveTask(i)
      return contractCommandHandlers[cmd](ownerCtx(i), { ...args, _meshSenderDaemonId: WORKER_DAEMON })
    })
    const res: any = await contractCommandHandlers.worker_contract_current(memberCtx(i, attemptId, relay), { bind })
    expect(res).toMatchObject({ success: true, scoped: false })
    const [d, cmd, args] = relay.mock.calls[0] as unknown as [string, string, Record<string, any>]
    expect([d, cmd]).toEqual([OWNER_DAEMON, WORKER_CONTRACT_FORWARD_COMMAND])
    expect(args.op).toBe('current')
    expect(JSON.stringify(args)).not.toContain(bind)
  })

  it('still refuses a bad credential (no stamp, no relay)', async () => {
    const i = ids(); const attemptId = `mesh_direct:${i.taskId}`
    const relay = vi.fn()
    const res: any = await contractCommandHandlers.worker_contract_current(memberCtx(i, attemptId, relay), { bind: 'wsb_forged' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/unauthenticated|bind_unknown_after_restart/)
    expect(relay).not.toHaveBeenCalled()
  })

  it('owner refuses a relay from a daemon that does not own the task node, and an unknown op', async () => {
    const i = ids(); seedOwnerLiveTask(i)
    const claim = { meshId: i.meshId, sessionId: i.sessionId, taskId: i.taskId }
    const other: any = await contractCommandHandlers[WORKER_CONTRACT_FORWARD_COMMAND](ownerCtx(i), { ...claim, op: 'current', params: {}, _meshSenderDaemonId: 'daemon_mach_intruder' })
    expect(other).toMatchObject({ success: false, error: 'unauthenticated' })
    const bad: any = await contractCommandHandlers[WORKER_CONTRACT_FORWARD_COMMAND](ownerCtx(i), { ...claim, op: 'propose', params: {}, _meshSenderDaemonId: WORKER_DAEMON })
    expect(bad).toMatchObject({ success: false, error: 'invalid_input' })
    const none: any = await contractCommandHandlers[WORKER_CONTRACT_FORWARD_COMMAND](ownerCtx(i), { ...claim, op: 'current', params: {} })
    expect(none).toMatchObject({ success: false, error: 'unauthenticated' })
  })

  it('local host-side behaviour is unchanged and the forward command is mesh-only', async () => {
    const i = ids(); const attemptId = seedOwnerLiveTask(i)
    const token = mintWorkerTaskToken({ meshId: i.meshId, taskId: i.taskId, attemptId, sessionId: i.sessionId, nodeId: i.nodeId }).token
    const relay = vi.fn()
    const res: any = await contractCommandHandlers.worker_contract_current(memberCtx(i, attemptId, relay), { token })
    expect(res).toMatchObject({ success: true, scoped: false })
    expect(relay).not.toHaveBeenCalled()
    const spec: any = (contractCommandSpecs as any[]).find((s: any) => s.name === WORKER_CONTRACT_FORWARD_COMMAND)
    expect(spec?.sources).toEqual(['mesh'])
  })
})
