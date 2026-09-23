import { describe, expect, it, vi } from 'vitest'
import { handleSendChat } from '../../src/commands/chat-commands.js'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

let fixtureId = 0

function fixture(sendMessage = vi.fn(async (): Promise<any> => ({ status: 'delivered' }))) {
  // Exercise the real event handler and both real ledger append paths, without
  // spawning a CLI or touching evidence in the shared input-media directory.
  const sessionId = `image-ledger-${++fixtureId}`
  const instance = Object.create(CliProviderInstance.prototype) as any
  const provider = {
    type: 'hermes-cli', category: 'cli',
    capabilities: { input: { multipart: true, mediaTypes: ['text', 'image'] } },
  }
  const adapter = { cliType: 'hermes-cli', sendMessage, getScriptParsedStatus: () => null, getStatus: () => ({ status: 'idle' }) }
  Object.assign(instance, {
    category: 'cli', type: 'hermes-cli', provider, adapter,
    instanceId: sessionId, workingDir: '/tmp/image-ledger',
    runtimeMessages: [], recentUserInputAcks: new Map(),
    historyWriter: { appendNewMessages: vi.fn() },
  })
  const helpers = {
    getProvider: () => provider, getCliAdapter: () => adapter,
    currentSession: { sessionId, transport: 'pty', providerType: 'hermes-cli' },
    ctx: { adapters: new Map([[sessionId, adapter]]), instanceManager: { getInstance: (key: string) => (key === sessionId ? instance : null) } },
  } as any
  const input = {
    parts: [{ type: 'image', mimeType: 'image/png', uri: 'file:///tmp/ledger-screenshot.png' }],
    textFallback: '',
  }
  const send = () => handleSendChat(helpers, { targetSessionId: sessionId, input, messageId: `msg_${sessionId}` })
  return { instance, send, sendMessage }
}

describe('send_chat image ledger acknowledgement', () => {
  it('appends a delivered image to both ledgers', async () => {
    const { instance, send } = fixture()
    await send()
    expect(instance.runtimeMessages).toHaveLength(1)
    expect(instance.historyWriter.appendNewMessages).toHaveBeenCalledTimes(1)
  })

  it('waits for delivery before appending image-only input to runtime and history', async () => {
    let resolve!: (result: any) => void
    const pending = new Promise(resolveSend => { resolve = resolveSend })
    const { instance, send, sendMessage } = fixture(vi.fn(() => pending))
    let settled = false
    const result = send().then(value => { settled = true; return value })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    expect(instance.runtimeMessages).toEqual([])
    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
    resolve({ status: 'delivered' })
    await expect(result).resolves.toMatchObject({ success: true, sent: true, submitted: true })
    expect(instance.runtimeMessages).toHaveLength(1)
    expect(instance.runtimeMessages[0].message).toMatchObject({ role: 'user', content: '/tmp/ledger-screenshot.png' })
    expect(instance.historyWriter.appendNewMessages).toHaveBeenCalledWith(
      'hermes-cli', [expect.objectContaining({ role: 'user', content: '/tmp/ledger-screenshot.png' })],
      expect.any(String), instance.instanceId, undefined,
    )
  })

  it('returns asynchronous send failure without recording either ledger', async () => {
    const { instance, send } = fixture(vi.fn(async () => { throw new Error('PTY write failed') }))
    await expect(send()).resolves.toMatchObject({ success: false, sent: false, error: expect.stringContaining('PTY write failed') })
    expect(instance.runtimeMessages).toEqual([])
    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
  })

  it('records queue acceptance but does not claim PTY submission', async () => {
    const { instance, send } = fixture(vi.fn(async () => ({ status: 'queued' })))
    await expect(send()).resolves.toMatchObject({ success: true, sent: false, queued: true, submitted: false })
    expect(instance.runtimeMessages).toHaveLength(1)
    expect(instance.historyWriter.appendNewMessages).toHaveBeenCalledTimes(1)
  })

  it('stamps the ack with the messageId (meta.sourceMessageId) exactly once', async () => {
    const { instance, send } = fixture()
    await send()
    expect(instance.runtimeMessages).toHaveLength(1)
    expect(instance.runtimeMessages[0].message.meta).toMatchObject({ runtimeInputAck: true, sourceMessageId: `msg_${instance.instanceId}` })
    // A redelivery of the same messageId is a duplicate: no second write, no second ack.
    await expect(send()).resolves.toMatchObject({ success: true, deduplicated: true })
    expect(instance.runtimeMessages).toHaveLength(1)
  })
})
