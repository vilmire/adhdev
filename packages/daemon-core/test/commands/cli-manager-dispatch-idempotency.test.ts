import { afterEach, describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

// PTY-SUBMIT-IDEMPOTENCY: the guard in DaemonCliManager.handleCliCommand
// ('agent_command' → send_chat) must suppress a machine-driven redelivery of the
// SAME mesh task (same session + taskId + identical content) BEFORE the second
// PTY write, while never blocking a legitimate resend (new taskId, same-task
// follow-up delta, post-window re-issue, retry after a failed submit, forceSend).

function createManager(adapterStatus = 'idle') {
  const sendMessage = vi.fn(async () => {})
  const adapter = {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir: '/repo',
    spawn: vi.fn(async () => {}),
    sendMessage,
    forceSendMessage: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ status: adapterStatus, activeModal: null, messages: [] })),
    getScriptParsedStatus: vi.fn(() => ({ status: adapterStatus, activeModal: null, messages: [] })),
    getPartialResponse: vi.fn(() => ''),
    shutdown: vi.fn(),
    cancel: vi.fn(),
    isProcessing: vi.fn(() => adapterStatus !== 'idle'),
    isReady: vi.fn(() => adapterStatus === 'idle'),
    setOnStatusChange: vi.fn(),
  }
  const manager = new DaemonCliManager({
    getServerConn: () => null,
    getP2p: () => null,
    onStatusChange: vi.fn(),
    removeAgentTracking: vi.fn(),
    getInstanceManager: () => null,
  }, {
    resolve: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
    getMeta: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
  } as any)
  manager.adapters.set('session-1', adapter as any)
  return { manager, adapter, sendMessage }
}

function dispatch(manager: DaemonCliManager, opts: { message: string; taskId?: string; force?: boolean }) {
  return manager.handleCliCommand('agent_command', {
    targetSessionId: 'session-1',
    agentType: 'hermes-cli',
    cliType: 'hermes-cli',
    action: 'send_chat',
    message: opts.message,
    ...(opts.force ? { force: true } : {}),
    ...(opts.taskId ? { meshContext: { meshId: 'mesh-1', taskId: opts.taskId } } : {}),
  })
}

describe('DaemonCliManager PTY-submit idempotency (mesh dispatch)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('suppresses a redelivered dispatch (same session + taskId + content) before the second PTY write', async () => {
    const { manager, sendMessage } = createManager()

    const first = await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    expect(first).toMatchObject({ success: true })
    // The redelivery (dispatch-confirm-timeout requeue / reconcile re-dispatch)
    // carries the SAME taskId and byte-identical prompt.
    const second = await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })

    expect(second).toMatchObject({ success: true, duplicateSuppressed: true })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('suppresses the redelivery while the first submission is still buffered (busy adapter)', async () => {
    const { manager, sendMessage } = createManager('generating')

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    const second = await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })

    expect(second).toMatchObject({ success: true, duplicateSuppressed: true })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('LEGITIMATE RESEND: a deliberate resend under a NEW taskId (handoff/retry mints a fresh task) is never blocked', async () => {
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    const resend = await dispatch(manager, { message: 'do the thing', taskId: 'task-2' })

    expect(resend).toMatchObject({ success: true })
    expect((resend as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('LEGITIMATE RESEND: a same-task follow-up delta (same taskId, different content) is never blocked', async () => {
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    const delta = await dispatch(manager, { message: 'do the thing, but use pnpm', taskId: 'task-1' })

    expect((delta as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('LEGITIMATE RESEND: the identical dispatch is allowed again after the dedup window lapses', async () => {
    vi.useFakeTimers()
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    // Beyond MESH_DISPATCH_SUBMIT_DEDUP_WINDOW_MS (300s) a same-text re-issue is a
    // genuinely new turn, not a redelivery.
    vi.setSystemTime(Date.now() + 301_000)
    const late = await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })

    expect((late as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('LEGITIMATE RESEND: a retry after the first submission FAILED is never blocked', async () => {
    const { manager, sendMessage } = createManager()
    sendMessage.mockRejectedValueOnce(new Error('transport blew up'))

    await expect(dispatch(manager, { message: 'do the thing', taskId: 'task-1' })).rejects.toThrow('transport blew up')
    const retry = await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })

    expect(retry).toMatchObject({ success: true })
    expect((retry as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('LEGITIMATE RESEND: forceSend bypasses the guard (explicit operator intent)', async () => {
    const { manager, adapter } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    const forced = await dispatch(manager, { message: 'do the thing', taskId: 'task-1', force: true })

    expect(forced).toMatchObject({ success: true, forceSent: true })
    expect(adapter.forceSendMessage).toHaveBeenCalledTimes(1)
  })

  it('ad-hoc chat without meshContext is never guarded (no taskId → no suppression)', async () => {
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'continue' })
    const again = await dispatch(manager, { message: 'continue' })

    expect((again as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})
