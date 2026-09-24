import { describe, expect, it, beforeEach, vi } from 'vitest'
import { ProviderInstanceManager } from '../../src/providers/provider-instance-manager.js'
import { DaemonCliManager } from '../../src/commands/cli-manager.js'
import {
  SessionBusyWithTaskError,
  SESSION_BUSY_WITH_TASK_CODE,
  classifySessionBusyWithTask,
} from '../../src/mesh/mesh-session-busy-dispatch.js'

// SESSION-BUSY stamp guard (preview rc.37). A worker session that is still working task A
// must not be re-stamped with task B: the stamp is the only record of which task/attempt the
// running turn's evidence and reports belong to. Before the guard the second dispatch
// overwrote meshActiveTaskId/attempt 8 s into task A's turn and queued B's body behind it.

const MESH_ID = 'mesh_busy_test'

function fakeInstance(opts: { status?: string; chatStatus?: string; settings?: Record<string, any> } = {}) {
  let settings: Record<string, any> = { ...(opts.settings ?? {}) }
  let status = opts.status ?? 'idle'
  const activeChat = opts.chatStatus ? { status: opts.chatStatus } : null
  return {
    type: 'codex-cli',
    init: async () => { /* noop */ },
    dispose: () => { /* noop */ },
    getState: () => ({ category: 'cli', instanceId: 'x', status, activeChat, settings }),
    attachMeshAssignment: (a: { meshId: string; taskId?: string; attemptId?: string }) => {
      settings = {
        ...settings,
        meshNodeFor: a.meshId,
        ...(a.taskId ? { meshActiveTaskId: a.taskId } : {}),
        ...(a.attemptId ? { meshActiveAttemptId: a.attemptId } : {}),
      }
    },
    setStatus(s: string) { status = s },
    get settings() { return settings },
  } as any
}

describe('SESSION-BUSY — attachMeshAssignmentToInstance refuses a different task on a busy instance', () => {
  let mgr: ProviderInstanceManager
  beforeEach(() => { mgr = new ProviderInstanceManager() })

  it('busy (generating) + DIFFERENT task → refused, stamp unchanged, current task/attempt reported', async () => {
    const inst = fakeInstance({ status: 'generating', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: 'task_A', meshActiveAttemptId: 'att_A' } })
    await mgr.addInstance('S', inst, {} as any)

    const result = mgr.attachMeshAssignmentToInstance('S', { meshId: MESH_ID, taskId: 'task_B', attemptId: 'att_B' })

    expect(result).toEqual({ stamped: false, reason: 'session_busy_with_task', currentTaskId: 'task_A', currentAttemptId: 'att_A' })
    expect(inst.settings.meshActiveTaskId).toBe('task_A')
    expect(inst.settings.meshActiveAttemptId).toBe('att_A')
  })

  it('busy via activeChat (waiting_approval) + different task → refused', async () => {
    const inst = fakeInstance({ status: 'idle', chatStatus: 'waiting_approval', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: 'task_A' } })
    await mgr.addInstance('S', inst, {} as any)

    const result = mgr.attachMeshAssignmentToInstance('S', { meshId: MESH_ID, taskId: 'task_B' })

    expect(result.stamped).toBe(false)
    expect(result.reason).toBe('session_busy_with_task')
    expect(result.currentAttemptId).toBeUndefined()
    expect(inst.settings.meshActiveTaskId).toBe('task_A')
  })

  it('busy + SAME task (redelivery / nonce bump) → accepted', async () => {
    const inst = fakeInstance({ status: 'generating', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: 'task_A', meshActiveAttemptId: 'att_A' } })
    await mgr.addInstance('S', inst, {} as any)

    const result = mgr.attachMeshAssignmentToInstance('S', { meshId: MESH_ID, taskId: 'task_A', attemptId: 'att_A2' })

    expect(result).toEqual({ stamped: true })
    expect(inst.settings.meshActiveAttemptId).toBe('att_A2')
  })

  it('idle + different task (stale stamp from a missed detach) → accepted', async () => {
    const inst = fakeInstance({ status: 'idle', settings: { meshNodeFor: MESH_ID, meshActiveTaskId: 'task_A' } })
    await mgr.addInstance('S', inst, {} as any)

    const result = mgr.attachMeshAssignmentToInstance('S', { meshId: MESH_ID, taskId: 'task_B' })

    expect(result).toEqual({ stamped: true })
    expect(inst.settings.meshActiveTaskId).toBe('task_B')
  })

  it('busy but no current task stamp (ad-hoc dashboard turn) → accepted (nothing to overwrite)', async () => {
    const inst = fakeInstance({ status: 'generating', settings: { meshNodeFor: MESH_ID } })
    await mgr.addInstance('S', inst, {} as any)

    expect(mgr.attachMeshAssignmentToInstance('S', { meshId: MESH_ID, taskId: 'task_B' })).toEqual({ stamped: true })
  })
})

describe('SESSION-BUSY — agent_command send_chat surfaces the refusal as a typed failure and submits nothing', () => {
  function build(status: string, settings: Record<string, any>) {
    const mgr = new ProviderInstanceManager()
    const inst = fakeInstance({ status, settings })
    const sendMessage = vi.fn(async () => {})
    const adapter = {
      cliType: 'codex-cli', cliName: 'Codex', workingDir: '/repo',
      spawn: vi.fn(async () => {}), sendMessage,
      getStatus: vi.fn(() => ({ status, activeModal: null, messages: [] })),
      getScriptParsedStatus: vi.fn(() => ({ status, activeModal: null, messages: [] })),
      getPartialResponse: vi.fn(() => ''),
      shutdown: vi.fn(), cancel: vi.fn(),
      isProcessing: vi.fn(() => status !== 'idle'), isReady: vi.fn(() => true),
      setOnStatusChange: vi.fn(),
    }
    const manager = new DaemonCliManager({
      getServerConn: () => null,
      getP2p: () => null,
      onStatusChange: vi.fn(),
      removeAgentTracking: vi.fn(),
      getInstanceManager: () => mgr as any,
    }, {
      resolve: vi.fn(() => ({ type: 'codex-cli', category: 'cli' })),
      getMeta: vi.fn(() => ({ type: 'codex-cli', category: 'cli' })),
    } as any)
    manager.adapters.set('S', adapter as any)
    return { mgr, inst, manager, sendMessage }
  }

  it('busy + different task → throws SessionBusyWithTaskError (typed), stamp unchanged, no submit', async () => {
    const { mgr, inst, manager, sendMessage } = build('generating', { meshNodeFor: MESH_ID, meshActiveTaskId: 'task_A', meshActiveAttemptId: 'att_A' })
    await mgr.addInstance('S', inst, {} as any)

    let caught: unknown
    try {
      await manager.agentCommand({
        targetSessionId: 'S', agentType: 'codex-cli', cliType: 'codex-cli', action: 'send_chat',
        message: 'task B body', policy: { mode: 'queue' },
        meshContext: { meshId: MESH_ID, nodeId: 'n1', taskId: 'task_B', attemptId: 'att_B', attemptGeneration: 0 },
      } as any)
    } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(SessionBusyWithTaskError)
    expect((caught as any).code).toBe(SESSION_BUSY_WITH_TASK_CODE)
    // The wire only keeps the message across P2P + IPC — the token must survive there.
    expect(classifySessionBusyWithTask({ message: (caught as Error).message })).toEqual({ currentTaskId: 'task_A', currentAttemptId: 'att_A' })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(inst.settings.meshActiveTaskId).toBe('task_A')
    expect(inst.settings.meshActiveAttemptId).toBe('att_A')
  })

  it('idle + different task → submits and stamps the new task with its attempt', async () => {
    const { mgr, inst, manager, sendMessage } = build('idle', { meshNodeFor: MESH_ID, meshActiveTaskId: 'task_A' })
    await mgr.addInstance('S', inst, {} as any)

    const result = await manager.agentCommand({
      targetSessionId: 'S', agentType: 'codex-cli', cliType: 'codex-cli', action: 'send_chat',
      message: 'task B body', policy: { mode: 'queue' },
      meshContext: { meshId: MESH_ID, nodeId: 'n1', taskId: 'task_B', attemptId: 'att_B', attemptGeneration: 0 },
    } as any)

    expect(result).toMatchObject({ success: true })
    expect(sendMessage).toHaveBeenCalled()
    expect(inst.settings.meshActiveTaskId).toBe('task_B')
    expect(inst.settings.meshActiveAttemptId).toBe('att_B')
  })
})
