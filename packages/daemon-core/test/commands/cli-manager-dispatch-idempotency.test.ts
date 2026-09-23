import { afterEach, describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

// PTY-SUBMIT-IDEMPOTENCY, wiring-unification D2: a mesh `agent_command` send_chat
// is submitted through SessionInputService under a messageId — the dispatcher's
// own, or, when it sent none, the turn ledger's dispatch identity
// `task:<taskId>:n<dispatchNonce>`. The ONE messageId dedupe suppresses a
// machine-driven redelivery of the SAME dispatch BEFORE the second PTY write,
// while never blocking a legitimate resend (new taskId, a reclaim's bumped nonce,
// a caller-supplied new messageId, post-window re-issue, retry after a failure).

function createManager(adapterStatus = 'idle') {
  const sendMessage = vi.fn(async (_text: string, _opts?: unknown) => (
    adapterStatus === 'idle' ? { status: 'delivered' as const } : { status: 'queued' as const, position: 1 }
  ))
  const fifo = new Set<string>()
  const adapter = {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir: '/repo',
    spawn: vi.fn(async () => {}),
    sendMessage,
    // SEND-NOW: `force` now routes through interrupt → busy→idle → ordinary
    // send. The mock flips the reported status to idle, which is what the
    // real FSM does once the stop key lands; without it the helper's idle
    // wait would (correctly) time out.
    interruptTurn: vi.fn(async () => {
      adapterStatus = 'idle'
      return { ok: true as const, keyName: 'Ctrl-C', bytes: 1, confidence: 'declared' as const }
    }),
    getStatus: vi.fn(() => ({ status: adapterStatus, activeModal: null, messages: [] })),
    hasQueuedSend: (id: string) => fifo.has(id),
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

function dispatch(manager: DaemonCliManager, opts: { message: string; taskId?: string; nonce?: number; force?: boolean; messageId?: string }) {
  return manager.agentCommand({
    targetSessionId: 'session-1',
    agentType: 'hermes-cli',
    cliType: 'hermes-cli',
    action: 'send_chat',
    message: opts.message,
    ...(opts.force ? { force: true } : {}),
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    ...(opts.taskId ? { meshContext: { meshId: 'mesh-1', taskId: opts.taskId, ...(opts.nonce !== undefined ? { dispatchNonce: opts.nonce } : {}) } } : {}),
  })
}

describe('DaemonCliManager PTY-submit idempotency (mesh dispatch)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('suppresses a redelivered dispatch (same taskId + nonce → same messageId) before the second PTY write', async () => {
    const { manager, sendMessage } = createManager()

    const first = await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    expect(first).toMatchObject({ success: true })
    // The redelivery (dispatch-confirm-timeout requeue / reconcile re-dispatch)
    // carries the SAME taskId and byte-identical prompt.
    const second = await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })

    expect(second).toMatchObject({ success: true, duplicateSuppressed: true, messageId: 'task:task-1:n0' })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ messageId: 'task:task-1:n0' })
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

  it('LEGITIMATE RESEND: a reclaim redispatch (same taskId, bumped nonce) is never blocked', async () => {
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1', nonce: 1 })
    const redispatch = await dispatch(manager, { message: 'do the thing', taskId: 'task-1', nonce: 2 })

    expect((redispatch as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('LEGITIMATE RESEND: a same-task follow-up under its OWN messageId is never blocked', async () => {
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    const delta = await dispatch(manager, { message: 'do the thing, but use pnpm', taskId: 'task-1', messageId: 'msg_follow_up' })

    expect((delta as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('LEGITIMATE RESEND: the identical dispatch is allowed again after the dedup window lapses', async () => {
    vi.useFakeTimers()
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    // Beyond DEDUPE_WINDOW_MS (300s) a same-id re-issue of a body that is no
    // longer parked is a genuinely new turn, not a redelivery.
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

  it('legacy force maps to policy interrupt — but it is still ONE message: the same dispatch identity is not re-sent', async () => {
    const { manager, adapter, sendMessage } = createManager()

    await dispatch(manager, { message: 'do the thing', taskId: 'task-1' })
    const forcedSame = await dispatch(manager, { message: 'do the thing', taskId: 'task-1', force: true })
    expect(forcedSame).toMatchObject({ success: true, duplicateSuppressed: true })
    expect(adapter.interruptTurn).not.toHaveBeenCalled()

    // Explicit operator intent is expressed with a NEW messageId.
    ;(adapter as any).getStatus.mockReturnValueOnce({ status: 'generating', activeModal: null, messages: [] })
    const forcedNew = await dispatch(manager, { message: 'do the thing', taskId: 'task-1', force: true, messageId: 'msg_operator' })
    expect(forcedNew).toMatchObject({ success: true, interrupted: true })
    expect(adapter.interruptTurn).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('ad-hoc chat without meshContext is never guarded (no taskId → no suppression)', async () => {
    const { manager, sendMessage } = createManager()

    await dispatch(manager, { message: 'continue' })
    const again = await dispatch(manager, { message: 'continue' })

    expect((again as any).duplicateSuppressed).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})
