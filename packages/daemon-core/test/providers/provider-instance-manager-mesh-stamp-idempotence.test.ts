import { describe, expect, it, beforeEach } from 'vitest'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'

// DOUBLE-DISPATCH Layer (b): attachMeshAssignmentToInstance must be idempotence-guarded.
// When the SAME (meshId, taskId) is already held by a DIFFERENT, still-live and actively
// working instance, a second stamp is refused (no-op) so two sessions can never both carry
// one taskId and double-execute the work. A stale / dead / idle prior holder is NOT a
// conflict — a legitimate re-dispatch must still be allowed to stamp.

const MESH_ID = 'mesh_stamp_test'
const TASK_ID = 'task_T1'

// Minimal ProviderInstance double: only the surface the manager touches
// (type, init, getState, attachMeshAssignment, dispose). attachMeshAssignment mutates the
// instance's own settings so we can assert whether a stamp actually landed.
function fakeInstance(opts: { status?: string; chatStatus?: string; settings?: Record<string, any> } = {}) {
  let settings: Record<string, any> = { ...(opts.settings ?? {}) }
  const activeChat = opts.chatStatus ? { status: opts.chatStatus } : null
  return {
    type: 'codex-cli',
    init: async () => { /* noop */ },
    dispose: () => { /* noop */ },
    getState: () => ({
      category: 'cli',
      instanceId: 'x',
      status: opts.status ?? 'idle',
      activeChat,
      settings,
    }),
    attachMeshAssignment: (a: { meshId: string; taskId?: string }) => {
      settings = { ...settings, meshNodeFor: a.meshId, ...(a.taskId ? { meshActiveTaskId: a.taskId } : {}) }
    },
    get settings() { return settings },
  } as any
}

async function withInstances(mgr: ProviderInstanceManager, instances: Record<string, any>) {
  for (const [id, inst] of Object.entries(instances)) {
    await mgr.addInstance(id, inst, {} as any)
  }
}

describe('DOUBLE-DISPATCH Layer (b) — attachMeshAssignmentToInstance stamp idempotence guard', () => {
  let mgr: ProviderInstanceManager
  beforeEach(() => { mgr = new ProviderInstanceManager() })

  it('refuses the second stamp when the task is already held by a live, generating instance', async () => {
    const holder = fakeInstance({ status: 'generating', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: TASK_ID } })
    const target = fakeInstance({ status: 'idle', settings: {} })
    await withInstances(mgr, { A: holder, B: target })

    const result = mgr.attachMeshAssignmentToInstance('B', { meshId: MESH_ID, taskId: TASK_ID })

    // DUP-CLAIM-REBIND: the refusal also names the live holder, so the coordinator can
    // rebind its turn-ledger attempt onto the session that is really doing the work
    // instead of cancelling the attempt (which lost the holder's real completion).
    expect(result).toEqual({ stamped: false, reason: 'task_already_stamped_on_live_instance', holderSessionId: 'A' })
    expect(target.settings.meshActiveTaskId).toBeUndefined() // B never got the duplicate stamp
  })

  it('also refuses when the live holder is mid-approval (waiting_approval), via activeChat status too', async () => {
    const holder = fakeInstance({ status: 'idle', chatStatus: 'waiting_approval', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: TASK_ID } })
    const target = fakeInstance({ status: 'idle', settings: {} })
    await withInstances(mgr, { A: holder, B: target })

    const result = mgr.attachMeshAssignmentToInstance('B', { meshId: MESH_ID, taskId: TASK_ID })

    expect(result.stamped).toBe(false)
    expect(result.reason).toBe('task_already_stamped_on_live_instance')
  })

  it('ALLOWS the stamp when the prior holder of the same task is idle (stale → re-dispatch)', async () => {
    const stale = fakeInstance({ status: 'idle', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: TASK_ID } })
    const target = fakeInstance({ status: 'idle', settings: {} })
    await withInstances(mgr, { A: stale, B: target })

    const result = mgr.attachMeshAssignmentToInstance('B', { meshId: MESH_ID, taskId: TASK_ID })

    expect(result).toEqual({ stamped: true })
    expect(target.settings.meshActiveTaskId).toBe(TASK_ID)
  })

  it('ALLOWS the stamp when the prior holder is terminal (stopped / dead → re-dispatch)', async () => {
    const dead = fakeInstance({ status: 'stopped', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: TASK_ID } })
    const target = fakeInstance({ status: 'idle', settings: {} })
    await withInstances(mgr, { A: dead, B: target })

    const result = mgr.attachMeshAssignmentToInstance('B', { meshId: MESH_ID, taskId: TASK_ID })

    expect(result.stamped).toBe(true)
    expect(target.settings.meshActiveTaskId).toBe(TASK_ID)
  })

  it('re-stamping the SAME instance is idempotent (not treated as a conflict with itself)', async () => {
    const inst = fakeInstance({ status: 'generating', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: TASK_ID } })
    await withInstances(mgr, { A: inst })

    const result = mgr.attachMeshAssignmentToInstance('A', { meshId: MESH_ID, taskId: TASK_ID })

    expect(result.stamped).toBe(true)
  })

  it('does not conflate a different task on a live instance (only the same taskId blocks)', async () => {
    const otherTask = fakeInstance({ status: 'generating', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: 'task_OTHER' } })
    const target = fakeInstance({ status: 'idle', settings: {} })
    await withInstances(mgr, { A: otherTask, B: target })

    const result = mgr.attachMeshAssignmentToInstance('B', { meshId: MESH_ID, taskId: TASK_ID })

    expect(result.stamped).toBe(true)
    expect(target.settings.meshActiveTaskId).toBe(TASK_ID)
  })

  it('returns instance_not_found when the target instance does not exist', () => {
    const result = mgr.attachMeshAssignmentToInstance('missing', { meshId: MESH_ID, taskId: TASK_ID })
    expect(result).toEqual({ stamped: false, reason: 'instance_not_found' })
  })
})
