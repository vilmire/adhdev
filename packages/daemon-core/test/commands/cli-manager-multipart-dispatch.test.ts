import { describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

/**
 * MESH-IMAGE-DISPATCH — a mesh dispatch carrying an image must reach the worker.
 *
 * Wiring-unification D2: the mesh `agent_command` and the dashboard `send_chat`
 * share ONE funnel (SessionInputService). The structured envelope is checked
 * against the provider's DECLARED input support, its images are materialized,
 * and ONE built body (path + text, bracketed-paste flagged) is written through
 * the adapter under the dispatch's messageId — exactly the body the dashboard
 * would write. A text-only dispatch keeps its plain adapter write, and an
 * unsupported provider fails LOUDLY rather than silently dropping the image.
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
  /** What the adapter's (driver's) disposition is. */
  sendResult?: 'delivered' | 'queued'
  withInstance?: boolean
} = {}) {
  const sendMessage = vi.fn(async (_text: string, _opts?: Record<string, unknown>): Promise<unknown> => (
    options.sendResult === 'queued' ? { status: 'queued', position: 1 } : { status: 'delivered' }
  ))
  const adapter = {
    cliType: 'claude-cli',
    cliName: 'Claude Code',
    workingDir: '/repo',
    spawn: vi.fn(async () => {}),
    sendMessage,
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
  const instance = { category: 'cli', type: 'claude-cli', recordAcknowledgedUserInput }
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
    getInstanceManager: () => ({ getInstance: () => (options.withInstance === false ? undefined : instance) }),
  } as any, {
    resolve: vi.fn(() => provider),
    getMeta: vi.fn(() => provider),
  } as any)
  manager.adapters.set('session-1', adapter as any)
  return { manager, adapter, sendMessage, recordAcknowledgedUserInput }
}

const BASE_ARGS = {
  targetSessionId: 'session-1',
  agentType: 'claude-cli',
  cliType: 'claude-cli',
  action: 'send_chat',
}

const MATERIALIZED_IMAGE_BODY = /adhdev-input-media[\\/].+\.png\nwhat is in this screenshot\?$/

describe('cli-manager multipart mesh dispatch', () => {
  it('writes ONE built image body (materialized path + text, bracketed paste) instead of collapsing to text', async () => {
    const { manager, sendMessage } = createManager()

    const result = await manager.agentCommand({
      ...BASE_ARGS,
      message: 'what is in this screenshot?',
      input: IMAGE_INPUT,
    })

    expect(result).toMatchObject({ success: true, submitted: true })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [body, opts] = sendMessage.mock.calls[0]!
    expect(body).toMatch(MATERIALIZED_IMAGE_BODY)
    expect(opts).toMatchObject({ bracketedPaste: true, messageId: expect.any(String) })
  })

  it('accepts an image-only dispatch with no accompanying text', async () => {
    const { manager, sendMessage } = createManager()

    const result = await manager.agentCommand({
      ...BASE_ARGS,
      input: { parts: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] },
    })

    expect(result).toMatchObject({ success: true })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]![0]).toMatch(/adhdev-input-media[\\/].+\.png/)
  })

  it('leaves the text-only body byte-for-byte unchanged (no paste flag)', async () => {
    const { manager, sendMessage } = createManager()

    const result = await manager.agentCommand({
      ...BASE_ARGS,
      message: 'plain text task',
    })

    expect(result).toMatchObject({ success: true })
    expect(sendMessage).toHaveBeenCalledWith('plain text task', { messageId: expect.stringMatching(/^legacy:msg_/) })
  })

  it('refuses an image for a text-only provider with a provider-named error', async () => {
    const { manager, sendMessage } = createManager({
      capabilities: { input: { multipart: false, mediaTypes: ['text'] } },
    })

    await expect(manager.agentCommand({
      ...BASE_ARGS,
      message: 'look at this',
      input: IMAGE_INPUT,
    })).rejects.toThrow(/image/i)

    // Nothing was delivered — no silent partial send.
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('without a provider instance the body still lands; only the (best-effort) ack is skipped', async () => {
    const { manager, sendMessage, recordAcknowledgedUserInput } = createManager({ withInstance: false })

    const result = await manager.agentCommand({ ...BASE_ARGS, message: 'look at this', input: IMAGE_INPUT })

    expect(result).toMatchObject({ success: true })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(recordAcknowledgedUserInput).not.toHaveBeenCalled()
  })

  it('deduplicates a redelivered image dispatch of the same task (same dispatch messageId)', async () => {
    const { manager, sendMessage } = createManager()
    const meshContext = { meshId: 'mesh-1', nodeId: 'node-1', taskId: 'task-1' }

    await manager.agentCommand({ ...BASE_ARGS, input: IMAGE_INPUT, meshContext })
    const second = await manager.agentCommand({ ...BASE_ARGS, input: IMAGE_INPUT, meshContext })

    expect(second).toMatchObject({ duplicateSuppressed: true, messageId: 'task:task-1:n0' })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('does NOT suppress a different image sent under its own messageId within the same task', async () => {
    const { manager, sendMessage } = createManager()
    const meshContext = { meshId: 'mesh-1', nodeId: 'node-1', taskId: 'task-1' }

    await manager.agentCommand({ ...BASE_ARGS, input: IMAGE_INPUT, meshContext })
    const second = await manager.agentCommand({
      ...BASE_ARGS,
      messageId: 'msg_second_image',
      input: { parts: [{ type: 'image', mimeType: 'image/png', data: 'RElGRkVSRU5U' }] },
      meshContext,
    })

    expect(second).not.toMatchObject({ duplicateSuppressed: true })
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})

/**
 * MESH-SEND-ACK-ASYMMETRY — the mesh funnel must not report a send it did not land.
 */
describe('cli-manager multipart dispatch — send/record symmetry', () => {
  it('does not record an ack bubble or report success when delivery fails', async () => {
    const { manager, sendMessage, recordAcknowledgedUserInput } = createManager()
    sendMessage.mockRejectedValueOnce(new Error('pty is dead'))

    await expect(manager.agentCommand({
      ...BASE_ARGS,
      input: IMAGE_INPUT,
    })).rejects.toThrow(/pty is dead/)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(recordAcknowledgedUserInput).not.toHaveBeenCalled()
  })

  it('a failed submit is not remembered, so a redrive of the same dispatch is not suppressed', async () => {
    const { manager, sendMessage } = createManager()
    sendMessage.mockRejectedValueOnce(new Error('pty is dead'))
    const meshContext = { meshId: 'mesh-1', nodeId: 'node-1', taskId: 'task-1' }

    await expect(manager.agentCommand({
      ...BASE_ARGS, input: IMAGE_INPUT, meshContext,
    })).rejects.toThrow(/pty is dead/)

    const retry = await manager.agentCommand({
      ...BASE_ARGS, input: IMAGE_INPUT, meshContext,
    })
    expect(retry).not.toMatchObject({ duplicateSuppressed: true })
    expect(retry).toMatchObject({ success: true })
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('reports a driver-parked body as queued, never as submitted', async () => {
    const { manager, recordAcknowledgedUserInput } = createManager({ sendResult: 'queued' })

    const result = await manager.agentCommand({
      ...BASE_ARGS,
      input: IMAGE_INPUT,
    })

    expect(result).toMatchObject({ success: true, status: 'queued', queued: true, submitted: false, sent: false, position: 1 })
    expect((result as any).queuedReason).toBe('driver_fifo_parked')
    // The bubble still renders for a queued send — matching the dashboard funnel.
    expect(recordAcknowledgedUserInput).toHaveBeenCalledTimes(1)
  })

  it('reports a delivered send as submitted, and acks once with the messageId', async () => {
    const { manager, recordAcknowledgedUserInput } = createManager()

    const result = await manager.agentCommand({
      ...BASE_ARGS,
      messageId: 'msg_delivered',
      input: IMAGE_INPUT,
    })

    expect(result).toMatchObject({ success: true, submitted: true })
    expect((result as any).queuedReason).toBeUndefined()
    expect(recordAcknowledgedUserInput).toHaveBeenCalledTimes(1)
    expect(recordAcknowledgedUserInput.mock.calls[0]![1]).toBe('msg_delivered')
  })

  it('awaits the send rather than firing and forgetting it', async () => {
    let resolved = false
    const { manager, sendMessage } = createManager()
    sendMessage.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 10))
      resolved = true
      return { status: 'delivered' }
    })

    await manager.agentCommand({ ...BASE_ARGS, input: IMAGE_INPUT })

    expect(resolved).toBe(true)
  })
})
