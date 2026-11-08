/**
 * Live 2026-11-08: a worker on a MEMBER daemon got `worker_credential_required` from driver_invoke although the
 * owner had activated the driver and granted screen/input. The attempt lives on the task owner, so the member asks
 * the owner to VERIFY the claim (`driver_worker_identity_forwarded`) and executes locally with the returned identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDriverWorkerIdentity, driverIdentityHandlers, DRIVER_IDENTITY_VERIFY_COMMAND, invalidateVerifiedDriverIdentities, VERIFIED_IDENTITY_TTL_MS } from '../../src/commands/med-family/driver-worker-identity'
import { driverSpecs } from '../../src/commands/med-family/drivers'
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store'
import { __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest, mintWorkerSessionBind, mintWorkerTaskToken } from '../../src/mesh/worker-mcp-isolation'
import { seedMeshAttempt } from '../helpers/turn-attempt-seed'

const WORKER_DAEMON = 'daemon_mach_worker_drv'
const OWNER_DAEMON = 'test-daemon'
let seq = 0
const ids = () => { seq += 1; return { meshId: `mesh_drv_${seq}`, taskId: `task_drv_${seq}`, sessionId: `session_drv_${seq}`, nodeId: `node_drv_${seq}` } }
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
const ownerAnswer = (i: Ids) => vi.fn(async (_d: string, cmd: string, args: Record<string, unknown>) => {
  seedOwnerLiveTask(i)
  return driverIdentityHandlers[cmd](ownerCtx(i), { ...args, _meshSenderDaemonId: WORKER_DAEMON })
})

beforeEach(() => { __resetWorkerTaskTokensForTest(); __resetWorkerSessionBindsForTest(); invalidateVerifiedDriverIdentities() })
afterEach(() => { __resetWorkerTaskTokensForTest(); __resetWorkerSessionBindsForTest(); invalidateVerifiedDriverIdentities() })

describe('driver worker identity on a member daemon', () => {
  it('gets a verified identity from the owner and caches it', async () => {
    const i = ids(); const attemptId = `mesh_direct:${i.taskId}`
    const bind = mintWorkerSessionBind({ meshId: i.meshId, sessionId: i.sessionId, nodeId: i.nodeId }).bind
    const relay = ownerAnswer(i)
    const ctx = memberCtx(i, attemptId, relay)
    const res: any = await resolveDriverWorkerIdentity(ctx, { bind })
    expect(res.identity).toMatchObject({ meshId: i.meshId, taskId: i.taskId, sessionId: i.sessionId, attemptId })
    expect(JSON.stringify(res)).not.toMatch(/wst_|wsb_/)
    const [d, cmd, args] = relay.mock.calls[0] as unknown as [string, string, Record<string, any>]
    expect([d, cmd]).toEqual([OWNER_DAEMON, DRIVER_IDENTITY_VERIFY_COMMAND])
    expect(JSON.stringify(args)).not.toContain(bind)
    __resetWorkerTaskTokensForTest()
    await resolveDriverWorkerIdentity(ctx, { bind })
    expect(relay).toHaveBeenCalledTimes(1)
    // member and owner share one in-process token registry; drop the owner's token so the member cannot resolve locally
    __resetWorkerTaskTokensForTest()
    await resolveDriverWorkerIdentity(ctx, { bind }, Date.now() + VERIFIED_IDENTITY_TTL_MS + 1)
    expect(relay).toHaveBeenCalledTimes(2)
  })

  it('carries the owner driver policy so a member without the mesh record can apply it', async () => {
    const i = ids(); const attemptId = `mesh_direct:${i.taskId}`
    const bind = mintWorkerSessionBind({ meshId: i.meshId, sessionId: i.sessionId, nodeId: i.nodeId }).bind
    const { ownerDriverPolicy } = await import('../../src/commands/med-family/driver-worker-identity.js')
    expect(ownerDriverPolicy(i.meshId)).toBeUndefined()
    const res: any = await resolveDriverWorkerIdentity(memberCtx(i, attemptId, ownerAnswer(i)), { bind })
    expect(res.identity).toBeTruthy()
    expect(ownerDriverPolicy(i.meshId)).toEqual({})
  })

  it('refuses a bad credential with no relay', async () => {
    const i = ids(); const relay = vi.fn()
    const res: any = await resolveDriverWorkerIdentity(memberCtx(i, `mesh_direct:${i.taskId}`, relay), { bind: 'wsb_forged' })
    expect(res).toMatchObject({ error: 'worker_credential_required' })
    expect(relay).not.toHaveBeenCalled()
  })

  it('refuses when the owner refuses (no live attempt)', async () => {
    const i = ids(); const bind = mintWorkerSessionBind({ meshId: i.meshId, sessionId: i.sessionId, nodeId: i.nodeId }).bind
    const relay = vi.fn(async (_d: string, cmd: string, args: Record<string, unknown>) => driverIdentityHandlers[cmd](ownerCtx(i), { ...args, _meshSenderDaemonId: WORKER_DAEMON }))
    expect(await resolveDriverWorkerIdentity(memberCtx(i, `mesh_direct:${i.taskId}`, relay), { bind })).toMatchObject({ error: 'worker_credential_required' })
  })

  it('owner refuses a non-owner sender and a missing stamp; command is mesh-only', async () => {
    const i = ids(); seedOwnerLiveTask(i)
    const claim = { meshId: i.meshId, sessionId: i.sessionId, taskId: i.taskId }
    expect(await driverIdentityHandlers[DRIVER_IDENTITY_VERIFY_COMMAND](ownerCtx(i), { ...claim, _meshSenderDaemonId: 'daemon_mach_intruder' })).toMatchObject({ success: false, code: 'unauthenticated' })
    expect(await driverIdentityHandlers[DRIVER_IDENTITY_VERIFY_COMMAND](ownerCtx(i), claim)).toMatchObject({ success: false, code: 'unauthenticated' })
    expect(await driverIdentityHandlers[DRIVER_IDENTITY_VERIFY_COMMAND](ownerCtx(i), { ...claim, extra: 1, _meshSenderDaemonId: WORKER_DAEMON })).toMatchObject({ success: false, code: 'invalid_input' })
    const spec: any = (driverSpecs as any[]).find(s => s.name === DRIVER_IDENTITY_VERIFY_COMMAND)
    expect(spec).toMatchObject({ sources: ['mesh'], meshSender: 'roster' })
  })

  it('a host-local worker resolves locally with no relay', async () => {
    const i = ids(); const attemptId = seedOwnerLiveTask(i)
    const token = mintWorkerTaskToken({ meshId: i.meshId, taskId: i.taskId, attemptId, sessionId: i.sessionId, nodeId: i.nodeId }).token
    const relay = vi.fn()
    expect(await resolveDriverWorkerIdentity(memberCtx(i, attemptId, relay), { token })).toMatchObject({ identity: { taskId: i.taskId } })
    expect(relay).not.toHaveBeenCalled()
  })
})
