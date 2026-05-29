import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: mocks.readProviderChatHistory,
  isNativeSourceCanonicalHistory: (canonicalHistory: any) => {
    if (!canonicalHistory) return false
    return canonicalHistory.mode !== 'disabled' && canonicalHistory.mode !== 'materialized-mirror'
  },
}))

import { handleReadChat } from '../../src/commands/chat-commands.js'

function createHermesAdapter(overrides: Record<string, unknown> = {}) {
  return {
    cliType: 'hermes-cli',
    cliName: 'Hermes Agent',
    workingDir: '/workspaces/adhdev',
    getStatus: vi.fn(() => ({
      status: 'idle',
      activeModal: null,
      messages: [{ role: 'assistant', content: 'pty assistant', receivedAt: 2_000 }],
    })),
    getScriptParsedStatus: vi.fn(() => ({
      status: 'idle',
      providerSessionId: '20260529_134606_f4c8b1',
      title: 'Hermes Agent',
      messages: [
        { role: 'user', content: 'HERMES_SMOKE_OK\n/workspaces/adhdev', receivedAt: 1_000 },
        { role: 'user', content: 'HERMES_SMOKE_OK\n/workspaces/adhdev', receivedAt: 1_001 },
        { role: 'assistant', content: 'Yes, I can read this prompt and respond normally. No previous workspace chat history was visible in this fresh session tra\nnscript.', receivedAt: 2_000 },
      ],
    })),
    getDebugSnapshot: vi.fn(() => ({ terminalScreenText: 'hermes terminal status' })),
    getPartialResponse: vi.fn(() => ''),
    isProcessing: () => false,
    isReady: () => true,
    ...overrides,
  }
}

function createHelpers(adapter: any = createHermesAdapter(), overrides: Record<string, any> = {}) {
  const provider = {
    type: 'hermes-cli',
    name: 'Hermes Agent',
    category: 'cli',
    canonicalHistory: {
      format: 'hermes-provider-native',
      mode: 'native-source',
      watchPath: '~/.hermes/sessions/session_{{sessionId}}.json',
      scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
    },
    scripts: { readNativeHistory: () => null },
  }
  return {
    getCdp: () => null,
    getProvider: () => provider,
    getProviderScript: () => null,
    evaluateProviderScript: vi.fn(),
    getCliAdapter: () => adapter,
    currentManagerKey: undefined,
    currentIdeType: undefined,
    currentProviderType: 'hermes-cli',
    currentSession: {
      sessionId: 'runtime-session',
      providerType: 'hermes-cli',
      providerName: 'Hermes Agent',
      providerSessionId: '20260529_134606_f4c8b1',
      transport: 'pty',
      adapterKey: 'runtime-session',
      workspace: '/workspaces/adhdev',
    },
    agentStream: null,
    ctx: {
      sessionRegistry: { get: () => ({ sessionId: 'runtime-session', instanceKey: 'runtime-session' }) },
      instanceManager: { getInstance: () => null },
    },
    historyWriter: { appendNewMessages: () => {} },
    ...overrides,
  }
}

describe('Hermes CLI read_chat native transcript provenance', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('prefers Hermes provider-native session JSON and labels native message identity', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.hermes/sessions/session_20260529_134606_f4c8b1.json',
      sourceMtimeMs: Date.now(),
      providerSessionId: '20260529_134606_f4c8b1',
      nativeHistoryCoverage: 'full',
      hasMore: false,
      messages: [
        { role: 'system', kind: 'session_start', content: '/workspaces/adhdev', receivedAt: 900, historySessionId: '20260529_134606_f4c8b1', workspace: '/workspaces/adhdev' },
        { role: 'user', kind: 'standard', content: 'HERMES_SMOKE_OK\n/workspaces/adhdev', receivedAt: 1_000, historySessionId: '20260529_134606_f4c8b1', workspace: '/workspaces/adhdev' },
        { role: 'assistant', kind: 'standard', content: 'Yes, I can read this prompt and respond normally.\nNo previous workspace chat history was visible in this fresh session transcript.', receivedAt: 2_000, historySessionId: '20260529_134606_f4c8b1', workspace: '/workspaces/adhdev' },
      ],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: '20260529_134606_f4c8b1',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual([
      'HERMES_SMOKE_OK\n/workspaces/adhdev',
      'Yes, I can read this prompt and respond normally.\nNo previous workspace chat history was visible in this fresh session transcript.',
    ])
    expect(result.providerSessionId).toBe('20260529_134606_f4c8b1')
    expect(result.transcriptAuthority).toBe('provider')
    expect(result.coverage).toBe('full')
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'hermes-cli',
      nativeHandle: '20260529_134606_f4c8b1',
      nativeSource: 'provider-native',
      nativeHistoryCoverage: 'full',
    })
    for (const message of result.messages as any[]) {
      expect(message.providerUnitKey).toContain('hermes-cli:native:20260529_134606_f4c8b1:')
      expect(message._turnKey).toContain('hermes-cli:native-turn:20260529_134606_f4c8b1:')
    }
  })

  it('uses workspace-scoped Hermes native history for fresh sessions without replaying prior PTY duplicates', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      lookup: 'workspace',
      source: 'provider-native',
      sourcePath: '/Users/test/.hermes/sessions/session_20260529_140000_fresh.json',
      sourceMtimeMs: Date.now(),
      providerSessionId: '20260529_140000_fresh',
      nativeHistoryCoverage: 'full',
      hasMore: false,
      messages: [
        { role: 'system', kind: 'session_start', content: '/workspaces/adhdev', receivedAt: 900, historySessionId: '20260529_140000_fresh', workspace: '/workspaces/adhdev' },
        { role: 'user', kind: 'standard', content: 'fresh prompt only', receivedAt: 1_000, historySessionId: '20260529_140000_fresh', workspace: '/workspaces/adhdev' },
        { role: 'assistant', kind: 'standard', content: 'fresh answer only', receivedAt: 2_000, historySessionId: '20260529_140000_fresh', workspace: '/workspaces/adhdev' },
      ],
    })
    const adapter = createHermesAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        providerSessionId: '20260529_140000_fresh',
        title: 'Hermes Agent',
        messages: [
          { role: 'user', content: 'stale prior prompt', receivedAt: 500 },
          { role: 'user', content: 'fresh prompt only', receivedAt: 1_000 },
          { role: 'assistant', content: 'fresh answer only', receivedAt: 2_000 },
        ],
      })),
    })
    const helpers = createHelpers(adapter, {
      currentSession: {
        sessionId: 'runtime-session',
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        transport: 'pty',
        adapterKey: 'runtime-session',
        workspace: '/workspaces/adhdev',
      },
    })

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      targetSessionId: 'runtime-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: '20260529_140000_fresh',
      workspace: '/workspaces/adhdev',
    }))
    expect((result.messages as any[]).map(message => message.content)).toEqual([
      'fresh prompt only',
      'fresh answer only',
    ])
    expect(result.providerSessionId).toBe('20260529_140000_fresh')
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      nativeHandle: '20260529_140000_fresh',
    })
  })
})
