import { describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

/**
 * MESH-IMAGE-DISPATCH — a mesh dispatch carrying an image must reach the worker.
 *
 * Before this change the mesh path ran `assertTextOnlyInput` on every non-ACP send and
 * then collapsed the envelope to `input.textFallback`, so an image dispatched from a
 * coordinator was rejected outright — while the SAME provider on the SAME daemon
 * happily accepted the same image from the dashboard (chat-commands-write.ts). These
 * tests pin the fixed behaviour: structured parts go to the provider INSTANCE (where
 * provider-specific attachment strategies run), text-only sends keep their exact prior
 * adapter path, and an unsupported provider fails LOUDLY rather than silently dropping
 * the attachment.
 */

const IMAGE_INPUT = {
  parts: [
    { type: 'text', text: 'what is in this screenshot?' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ],
}

function createManager(options: {
  /** Declared provider capabilities — defaults to an image-capable CLI provider. */
  capabilities?: unknown
  category?: string
  /**
   * What the provider instance's `send_message` resolves to. Mirrors the real
   * CliProviderInstance.onEvent contract, which ALWAYS returns a promise of a
   * ProviderSendMessageResult and never rejects — a delivery failure surfaces as
   * `{ success: false }`, which is exactly the case the dispatch path must catch.
   */
  sendOutcome?: unknown
} = {}) {
  const sendMessage = vi.fn(async () => {})
  const onEvent = vi.fn(async () => options.sendOutcome ?? { success: true, status: 'delivered' })
  const adapter = {
    cliType: 'claude-cli',
    cliName: 'Claude Code',
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
    getStatus: vi.fn(() => ({ status: 'idle', activeModal: null, messages: [] })),
    getScriptParsedStatus: vi.fn(() => ({ status: 'idle', activeModal: null, messages: [] })),
    getPartialResponse: vi.fn(() => ''),
    shutdown: vi.fn(),
    cancel: vi.fn(),
    isProcessing: vi.fn(() => false),
    isReady: vi.fn(() => true),
    setOnStatusChange: vi.fn(),
  }
  // The ack bubble — the transcript record for the owner's own turn. It must be
  // written ONLY after the send is acknowledged; a bubble with no delivery is the
  // phantom-bubble half of the send/record asymmetry.
  const recordAcknowledgedUserInput = vi.fn()
  const instance = { category: 'cli', type: 'claude-cli', onEvent, recordAcknowledgedUserInput }
  const provider = {
    type: 'claude-cli',
    category: options.category ?? 'cli',
    capabilities: options.capabilities ?? { input: { multipart: true, mediaTypes: ['text', 'image'] } },
  }
  const manager = new DaemonCliManager({
    getServerConn: () => null,
    getP2p: () => null,
    onStatusChange: vi.fn(),
    removeAgentTracking: vi.fn(),
    getInstanceManager: () => ({ getInstance: () => instance }),
  } as any, {
    resolve: vi.fn(() => provider),
    getMeta: vi.fn(() => provider),
  } as any)
  manager.adapters.set('session-1', adapter as any)
  return { manager, adapter, sendMessage, onEvent, recordAcknowledgedUserInput }
}

const BASE_ARGS = {
  targetSessionId: 'session-1',
  agentType: 'claude-cli',
  cliType: 'claude-cli',
  action: 'send_chat',
}

describe('cli-manager multipart mesh dispatch', () => {
  it('delivers image input to the provider instance instead of collapsing to text', async () => {
    const { manager, sendMessage, onEvent } = createManager()

    const result = await manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      message: 'what is in this screenshot?',
      input: IMAGE_INPUT,
    })

    expect(result).toMatchObject({ success: true })
    // The instance receives the STRUCTURED envelope — this is the whole point: the
    // image part must survive to the provider, not be flattened away.
    expect(onEvent).toHaveBeenCalledTimes(1)
    const [event, payload] = onEvent.mock.calls[0]!
    expect(event).toBe('send_message')
    const parts = (payload as any).input.parts
    expect(parts.some((p: any) => p.type === 'image' && p.data === 'iVBORw0KGgo=')).toBe(true)
    // And it must NOT also go down the text-only adapter path (that would double-send).
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('accepts an image-only dispatch with no accompanying text', async () => {
    const { manager, onEvent } = createManager()

    const result = await manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      input: { parts: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] },
    })

    // The old code threw 'message required for send_chat' here, because it judged the
    // request by its (empty) text fallback alone.
    expect(result).toMatchObject({ success: true })
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('leaves the text-only path byte-for-byte unchanged', async () => {
    const { manager, sendMessage, onEvent } = createManager()

    const result = await manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      message: 'plain text task',
    })

    expect(result).toMatchObject({ success: true })
    // No structured parts → the adapter path, exactly as before this change.
    expect(sendMessage).toHaveBeenCalledWith('plain text task')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('refuses an image for a text-only provider with a provider-named error', async () => {
    // opencode is the one CLI provider that declares text-only input; every ACP
    // provider is text-only too. The dispatch must FAIL rather than quietly sending a
    // prompt that refers to an image the agent never received.
    const { manager, onEvent } = createManager({
      capabilities: { input: { multipart: false, mediaTypes: ['text'] } },
    })

    await expect(manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      message: 'look at this',
      input: IMAGE_INPUT,
    })).rejects.toThrow(/image/i)

    // Nothing was delivered — no silent partial send.
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('fails explicitly when no provider instance can receive the attachment', async () => {
    const { manager } = createManager()
    // An adapter exists but the instance manager has no instance for it — the
    // structured path has nowhere to deliver, and must say so instead of falling back
    // to a text-only send that drops the image.
    ;(manager as any).deps.getInstanceManager = () => ({ getInstance: () => undefined })

    await expect(manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      message: 'look at this',
      input: IMAGE_INPUT,
    })).rejects.toThrow(/multipart input/i)
  })

  it('deduplicates repeated image dispatches of the same task by full envelope', async () => {
    const { manager, onEvent } = createManager()
    const meshContext = { meshId: 'mesh-1', nodeId: 'node-1', taskId: 'task-1' }

    await manager.handleCliCommand('agent_command', { ...BASE_ARGS, input: IMAGE_INPUT, meshContext })
    const second = await manager.handleCliCommand('agent_command', { ...BASE_ARGS, input: IMAGE_INPUT, meshContext })

    // PTY-SUBMIT-IDEMPOTENCY must cover multipart too — a redelivered dispatch of the
    // same task+content is suppressed rather than injected twice.
    expect(second).toMatchObject({ duplicateSuppressed: true })
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('does NOT suppress a different image within the same task', async () => {
    const { manager, onEvent } = createManager()
    const meshContext = { meshId: 'mesh-1', nodeId: 'node-1', taskId: 'task-1' }

    await manager.handleCliCommand('agent_command', { ...BASE_ARGS, input: IMAGE_INPUT, meshContext })
    const second = await manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      input: { parts: [{ type: 'image', mimeType: 'image/png', data: 'DIFFERENT_IMAGE_BYTES' }] },
      meshContext,
    })

    // Both dispatches carry an empty text fallback, so hashing `message` alone would
    // collide and silently swallow the second image. The guard hashes the full envelope.
    expect(second).not.toMatchObject({ duplicateSuppressed: true })
    expect(onEvent).toHaveBeenCalledTimes(2)
  })
})

/**
 * MESH-SEND-ACK-ASYMMETRY — the mesh funnel must not report a send it did not land.
 *
 * `agent_command` is the sibling of `handleSendChat`, and it did not receive the fix
 * b6c2444da applied to the dashboard funnel: it called the provider instance
 * fire-and-forget, so an asynchronous delivery failure still wrote the ack bubble and
 * returned `success: true`. That is the exact INVERSE of the defect b6c2444da fixed —
 * there the body was delivered but never recorded; here it is recorded but never
 * delivered, producing a phantom bubble and a false success.
 */
describe('cli-manager multipart dispatch — send/record symmetry', () => {
  it('does not record an ack bubble or report success when delivery fails', async () => {
    const { manager, onEvent, recordAcknowledgedUserInput } = createManager({
      // The real contract: a failed send RESOLVES with success:false. A
      // fire-and-forget caller cannot see this at all.
      sendOutcome: { success: false, error: 'pty is dead' },
    })

    await expect(manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      input: IMAGE_INPUT,
    })).rejects.toThrow(/pty is dead/)

    expect(onEvent).toHaveBeenCalledTimes(1)
    // The phantom bubble: recording a turn the agent never received.
    expect(recordAcknowledgedUserInput).not.toHaveBeenCalled()
  })

  it('releases the idempotency guard on failure so a redrive is not suppressed', async () => {
    // Fails once (dead PTY), then the session recovers — the shape of a real redrive.
    const { manager, onEvent } = createManager()
    const instance = (manager as any).deps.getInstanceManager().getInstance()
    instance.onEvent = onEvent
      .mockResolvedValueOnce({ success: false, error: 'pty is dead' })
      .mockResolvedValue({ success: true, status: 'delivered' })
    const meshContext = { meshId: 'mesh-1', nodeId: 'node-1', taskId: 'task-1' }

    await expect(manager.handleCliCommand('agent_command', {
      ...BASE_ARGS, input: IMAGE_INPUT, meshContext,
    })).rejects.toThrow(/pty is dead/)

    // A failed submit never landed, so the retry is a legitimate resend — it must
    // NOT be swallowed by PTY-SUBMIT-IDEMPOTENCY as a duplicate. Without the guard
    // release in the catch, this second dispatch returns duplicateSuppressed and
    // the body is lost for good.
    const retry = await manager.handleCliCommand('agent_command', {
      ...BASE_ARGS, input: IMAGE_INPUT, meshContext,
    })
    expect(retry).not.toMatchObject({ duplicateSuppressed: true })
    expect(retry).toMatchObject({ success: true })
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('reports a driver-parked body as queued, never as submitted', async () => {
    const { manager, recordAcknowledgedUserInput } = createManager({
      sendOutcome: { success: true, status: 'queued' },
    })

    const result = await manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      input: IMAGE_INPUT,
    })

    // A queued send is a real success — the body is accepted — but it sits in the
    // driver's in-memory FIFO and does not survive a restart. Reporting it as
    // submitted is the lie 6cca365b was retired for.
    expect(result).toMatchObject({ success: true, queued: true, submitted: false, sent: false })
    expect((result as any).queuedReason).toBe('driver_fifo_parked')
    // The bubble still renders for a queued send — matching the dashboard funnel,
    // where the ack is deliberately not deferred until the queue drains.
    expect(recordAcknowledgedUserInput).toHaveBeenCalledTimes(1)
  })

  it('reports a delivered send as submitted', async () => {
    const { manager, recordAcknowledgedUserInput } = createManager()

    const result = await manager.handleCliCommand('agent_command', {
      ...BASE_ARGS,
      input: IMAGE_INPUT,
    })

    expect(result).toMatchObject({ success: true })
    expect((result as any).submitted).not.toBe(false)
    expect((result as any).queuedReason).not.toBe('driver_fifo_parked')
    expect(recordAcknowledgedUserInput).toHaveBeenCalledTimes(1)
  })

  it('awaits the send rather than firing and forgetting it', async () => {
    // Pins the mechanism, not just the outcome: if the call is not awaited, the
    // dispatch returns BEFORE the instance resolves, and this ordering flips.
    let resolved = false
    const { manager } = createManager()
    const instance = (manager as any).deps.getInstanceManager().getInstance()
    instance.onEvent = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
      resolved = true
      return { success: true, status: 'delivered' }
    })

    await manager.handleCliCommand('agent_command', { ...BASE_ARGS, input: IMAGE_INPUT })

    expect(resolved).toBe(true)
  })
})
