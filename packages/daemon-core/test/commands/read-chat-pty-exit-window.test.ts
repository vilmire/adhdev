/**
 * PTY-exit window (wiring-unification B4, coordinator decision).
 *
 * `port.exited` removes a CLI session from the registry the moment its PTY
 * dies; cli-manager keeps the adapter until auto-clean (~5 s). A history-capable
 * read (`read_chat`) inside that window must still resolve the session — through
 * the adapter, which supplies provider type and workspace — so the dashboard and
 * the transcript projection's final internal pull (which passes ONLY
 * targetSessionId) still get the transcript. After auto-clean the ordinary
 * history fallback applies (it needs a provider type from the caller).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readProviderChatHistory: vi.fn() }))
vi.mock('../../src/config/chat-history.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  ChatHistoryWriter: class { appendNewMessages() {} },
  readProviderChatHistory: mocks.readProviderChatHistory,
  isNativeSourceCanonicalHistory: (h: any) => !!h && h.mode !== 'disabled' && h.mode !== 'materialized-mirror',
}))

import { DaemonCommandHandler } from '../../src/commands/handler.js'
import { __resetProviderSessionPinsForTest } from '../../src/commands/chat-commands.js'
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js'
import { SessionRegistry } from '../../src/sessions/registry.js'

const SESSION = 'hermes-exited-1'
const HERMES = { type: 'hermes-cli', name: 'Hermes', category: 'cli', historyBehavior: { transcriptAuthority: 'provider' } }

function fakeAdapter() {
  return {
    cliType: 'hermes-cli',
    cliName: 'Hermes',
    workingDir: '/tmp/adhdev-hermes',
    getStatus: () => ({ status: 'stopped' }),
    // The adapter still holds the session's last parsed transcript until auto-clean.
    getScriptParsedStatus: () => ({
      status: 'stopped',
      messages: [
        { role: 'user', content: 'final prompt', receivedAt: 1 },
        { role: 'assistant', content: 'final answer before the crash', receivedAt: 2 },
      ],
    }),
    getRuntimeMetadata: () => ({ runtimeId: SESSION, runtimeKey: SESSION, spawnedAtMs: 0, spawnedEnv: {} }),
    getPartialResponse: () => '',
    isProcessing: () => false,
    isReady: () => false,
  }
}

function setup() {
  const registry = new SessionRegistry(createSessionLifecycleBus())
  const adapters = new Map<string, any>([[SESSION, fakeAdapter()]])
  const handler = new DaemonCommandHandler({
    cdpManagers: new Map(),
    ideType: 'standalone',
    adapters,
    sessionRegistry: registry,
    providerLoader: { resolve: (t: string) => (t === 'hermes-cli' ? HERMES : undefined), getMeta: (t: string) => (t === 'hermes-cli' ? HERMES : undefined) } as any,
    instanceManager: { getInstance: () => undefined, getByCategory: () => [], listInstanceIds: () => [] } as any,
  })
  registry.register({ sessionId: SESSION, parentSessionId: null, providerType: 'hermes-cli', transport: 'pty', adapterKey: SESSION, instanceKey: SESSION, workspace: '/tmp/adhdev-hermes' }, 'launch')
  return { registry, adapters, handler }
}

describe('read_chat inside the PTY-exit → auto-clean window', () => {
  beforeEach(() => {
    __resetProviderSessionPinsForTest()
    mocks.readProviderChatHistory.mockReset()
    mocks.readProviderChatHistory.mockReturnValue({
      messages: [
        { role: 'user', content: 'final prompt', receivedAt: 1 },
        { role: 'assistant', content: 'final answer before the crash', receivedAt: 2 },
      ],
      hasMore: false,
      providerSessionId: 'hermes-history-1',
    })
  })

  it('after pty_exit (registry entry gone, adapter still held) an id-only read returns the transcript', async () => {
    const { registry, handler } = setup()
    registry.terminate(SESSION, 'pty_exit')
    expect(registry.get(SESSION)).toBeUndefined()

    // Exactly what the transcript projection's internal pull sends.
    const result: any = await handler.handle('read_chat', { targetSessionId: SESSION })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect((result.messages as any[]).map(m => m.content)).toContain('final answer before the crash')
    // Provider type came from the adapter.
    expect(mocks.readProviderChatHistory.mock.calls.every(c => c[0] === 'hermes-cli')).toBe(true)
  })

  it('after auto-clean (adapter gone too) an id-only read fails closed, and a typed read falls back to history', async () => {
    const { registry, adapters, handler } = setup()
    registry.terminate(SESSION, 'pty_exit')
    adapters.delete(SESSION)

    const bare: any = await handler.handle('read_chat', { targetSessionId: SESSION })
    expect(bare.success).toBe(false)
    expect(bare.error).toBe(`Live session not found for targetSessionId: ${SESSION}`)

    const typed: any = await handler.handle('read_chat', { targetSessionId: SESSION, agentType: 'hermes-cli' })
    expect(typed.success).toBe(true)
    expect((typed.messages as any[]).map(m => m.content)).toContain('final answer before the crash')
  })

  it('a non-history command does NOT resolve a dead session through its adapter', async () => {
    const { registry, handler } = setup()
    registry.terminate(SESSION, 'pty_exit')
    const result: any = await handler.handle('send_chat', { targetSessionId: SESSION, message: 'hi' })
    expect(result.success).toBe(false)
    expect(result.error).toBe(`Live session not found for targetSessionId: ${SESSION}`)
  })
})
