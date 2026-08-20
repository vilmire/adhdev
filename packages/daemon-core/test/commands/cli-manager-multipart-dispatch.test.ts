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
} = {}) {
  const sendMessage = vi.fn(async () => {})
  const onEvent = vi.fn()
  const adapter = {
    cliType: 'claude-cli',
    cliName: 'Claude Code',
    workingDir: '/repo',
    spawn: vi.fn(async () => {}),
    sendMessage,
    forceSendMessage: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ status: 'idle', activeModal: null, messages: [] })),
    getScriptParsedStatus: vi.fn(() => ({ status: 'idle', activeModal: null, messages: [] })),
    getPartialResponse: vi.fn(() => ''),
    shutdown: vi.fn(),
    cancel: vi.fn(),
    isProcessing: vi.fn(() => false),
    isReady: vi.fn(() => true),
    setOnStatusChange: vi.fn(),
  }
  const instance = { category: 'cli', type: 'claude-cli', onEvent }
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
  return { manager, adapter, sendMessage, onEvent }
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
