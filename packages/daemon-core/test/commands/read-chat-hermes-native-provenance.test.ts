import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readProviderChatHistory: vi.fn(),
  readChatHistory: vi.fn(() => ({ messages: [], total: 0 })),
}))

vi.mock('../../src/config/chat-history.js', () => ({
  readProviderChatHistory: mocks.readProviderChatHistory,
  readChatHistory: mocks.readChatHistory,
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

  it('relabels stale Hermes parser identities when native history is selected', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.hermes/sessions/session_20260529_143433_31e43f.json',
      sourceMtimeMs: Date.now(),
      providerSessionId: '20260529_143433_31e43f',
      nativeHistoryCoverage: 'full',
      hasMore: false,
      messages: [
        { role: 'system', kind: 'session_start', content: '/Users/vilmire/Work/adhdev', receivedAt: 900, historySessionId: '20260529_143433_31e43f', workspace: '/Users/vilmire/Work/adhdev' },
        {
          role: 'user',
          kind: 'standard',
          content: 'HERMES_NATIVE_SMOKE_OK\n/Users/vilmire/Work/adhdev',
          receivedAt: 1_000,
          historySessionId: '20260529_143433_31e43f',
          workspace: '/Users/vilmire/Work/adhdev',
          providerUnitKey: 'hermes-cli:turn_1_fkw2sq:user:fkw2sq',
          _turnKey: 'turn_1_fkw2sq',
          bubbleId: 'hermes_hfw2yr',
        },
        {
          role: 'assistant',
          kind: 'standard',
          content: '예, 프롬프트를 정상적으로 읽고 응답할 수 있습니다.\n아니요, 이 새 세션의 이전 대화 기록은 보이지 않았습니다.',
          receivedAt: 2_000,
          historySessionId: '20260529_143433_31e43f',
          workspace: '/Users/vilmire/Work/adhdev',
          providerUnitKey: 'hermes-cli:turn_1_fkw2sq:assistant:standard:0',
          _turnKey: 'turn_1_fkw2sq',
          bubbleId: 'hermes_stale',
        },
      ],
    })
    const adapter = createHermesAdapter({
      workingDir: '/Users/vilmire/Work/adhdev',
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        providerSessionId: '20260529_143433_31e43f',
        title: 'Hermes Agent',
        messages: [
          {
            role: 'user',
            content: 'HERMES_NATIVE_SMOKE_OK\n/Users/vilmire/Work/adhdev',
            providerUnitKey: 'hermes-cli:turn_1_fkw2sq:user:fkw2sq',
            _turnKey: 'turn_1_fkw2sq',
            bubbleId: 'hermes_hfw2yr',
            receivedAt: 1_000,
          },
          { role: 'assistant', content: '예, 프롬프트를 정상적으로 읽고 응답할 수 있습니다.', receivedAt: 2_000 },
        ],
      })),
    })
    const helpers = createHelpers(adapter, {
      currentSession: {
        sessionId: '05dd786e-1560-4691-af63-b10c4b58152f',
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        providerSessionId: '20260529_143433_31e43f',
        transport: 'pty',
        adapterKey: '05dd786e-1560-4691-af63-b10c4b58152f',
        workspace: '/Users/vilmire/Work/adhdev',
      },
    })

    const readArgs = {
      agentType: 'hermes-cli',
      targetSessionId: '05dd786e-1560-4691-af63-b10c4b58152f',
      providerSessionId: '20260529_143433_31e43f',
      tailLimit: 20,
    }
    const first = await handleReadChat(helpers as any, readArgs)
    const second = await handleReadChat(helpers as any, readArgs)

    expect(first.success).toBe(true)
    expect(first.messageSource).toMatchObject({ selected: 'native-history', nativeHandle: '20260529_143433_31e43f' })
    expect((first.messages as any[]).map(message => message.role)).toEqual(['user', 'assistant'])
    expect((first.messages as any[]).filter(message => message.role === 'user')).toHaveLength(1)
    for (const message of first.messages as any[]) {
      expect(message.providerUnitKey).toContain('hermes-cli:native:20260529_143433_31e43f:')
      expect(message.providerUnitKey).not.toContain('hermes-cli:turn_')
      expect(message._turnKey).toContain('hermes-cli:native-turn:20260529_143433_31e43f:')
      expect(message._turnKey).not.toMatch(/^turn_/)
      expect(message.bubbleId).toBe(`bubble:${message.providerUnitKey}`)
    }
    expect((second.messages as any[]).map(message => message.providerUnitKey)).toEqual((first.messages as any[]).map(message => message.providerUnitKey))
    expect((second.messages as any[]).map(message => message._turnKey)).toEqual((first.messages as any[]).map(message => message._turnKey))
    expect((second.messages as any[]).map(message => message.bubbleId)).toEqual((first.messages as any[]).map(message => message.bubbleId))
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

  it('keeps two Codex sessions in the same workspace on independent provider transcripts', async () => {
    mocks.readProviderChatHistory.mockImplementation((_agent: string, options: any) => {
      const id = options.historySessionId
      return {
        source: 'provider-native',
        sourcePath: `/Users/test/.codex/sessions/${id}.jsonl`,
        sourceMtimeMs: Date.now(),
        providerSessionId: id,
        nativeHistoryCoverage: 'full',
        hasMore: false,
        messages: [
          { role: 'system', kind: 'session_start', content: '/workspaces/adhdev', receivedAt: 900, historySessionId: id, workspace: '/workspaces/adhdev' },
          { role: 'user', kind: 'standard', content: `prompt ${id}`, receivedAt: 1_000, historySessionId: id, workspace: '/workspaces/adhdev' },
          { role: 'assistant', kind: 'standard', content: `answer ${id}`, receivedAt: 2_000, historySessionId: id, workspace: '/workspaces/adhdev' },
        ],
      }
    })
    const makeHarness = (runtimeSessionId: string, providerSessionId: string) => {
      const adapter = createHermesAdapter({
        cliType: 'codex-cli',
        workingDir: '/workspaces/adhdev',
        getScriptParsedStatus: vi.fn(() => ({
          status: 'idle',
          providerSessionId,
          messages: [
            { role: 'user', content: `prompt ${providerSessionId}`, receivedAt: 1_000 },
            { role: 'assistant', content: `answer ${providerSessionId}`, receivedAt: 2_000 },
          ],
        })),
      })
      return createHelpers(adapter, {
        getProvider: () => ({
          type: 'codex-cli',
          name: 'Codex',
          category: 'cli',
          canonicalHistory: { format: 'codex-jsonl', mode: 'native-source', scripts: { readSession: 'readNativeHistory' } },
          scripts: { readNativeHistory: () => null },
        }),
        currentProviderType: 'codex-cli',
        currentSession: {
          sessionId: runtimeSessionId,
          providerType: 'codex-cli',
          providerName: 'Codex',
          providerSessionId,
          transport: 'pty',
          adapterKey: runtimeSessionId,
          workspace: '/workspaces/adhdev',
        },
        ctx: {
          sessionRegistry: { get: () => ({ sessionId: runtimeSessionId, instanceKey: runtimeSessionId, providerSessionId }) },
          instanceManager: { getInstance: () => null },
        },
      })
    }

    const first = await handleReadChat(makeHarness('runtime-a', 'codex-a') as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-a',
      tailLimit: 20,
    })
    const second = await handleReadChat(makeHarness('runtime-b', 'codex-b') as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-b',
      tailLimit: 20,
    })

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect((first.messages as any[]).map(message => message.content)).toEqual(['prompt codex-a', 'answer codex-a'])
    expect((second.messages as any[]).map(message => message.content)).toEqual(['prompt codex-b', 'answer codex-b'])
    expect(mocks.readProviderChatHistory).toHaveBeenNthCalledWith(1, 'codex-cli', expect.objectContaining({ historySessionId: 'codex-a', workspace: '/workspaces/adhdev' }))
    expect(mocks.readProviderChatHistory).toHaveBeenNthCalledWith(2, 'codex-cli', expect.objectContaining({ historySessionId: 'codex-b', workspace: '/workspaces/adhdev' }))
  })

  it('does not hydrate provider-native history from workspace-only lookup', async () => {
    const helpers = createHelpers(null, {
      currentSession: {
        sessionId: 'runtime-no-native-id',
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        transport: 'pty',
        adapterKey: 'runtime-no-native-id',
        workspace: '/workspaces/adhdev',
      },
      ctx: {
        sessionRegistry: { get: () => ({ sessionId: 'runtime-no-native-id', instanceKey: 'runtime-no-native-id' }) },
        instanceManager: { getInstance: () => null },
      },
    })

    const result = await handleReadChat(helpers as any, {
      agentType: 'hermes-cli',
      workspace: '/workspaces/adhdev',
      tailLimit: 20,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('native_history_not_safely_available')
    expect(mocks.readProviderChatHistory).not.toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: undefined,
      workspace: '/workspaces/adhdev',
    }))
    expect((result as any).messageSource).toMatchObject({
      fallbackReason: expect.stringContaining('native_history_workspace_only_lookup_unsafe'),
    })
  })

  it('does not show a coordinator native transcript for a worker session in the same workspace', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/coordinator.jsonl',
      sourceMtimeMs: Date.now(),
      providerSessionId: 'coordinator-native',
      nativeHistoryCoverage: 'full',
      hasMore: false,
      messages: [
        { role: 'system', kind: 'session_start', content: '/workspaces/adhdev', receivedAt: 900, historySessionId: 'coordinator-native', workspace: '/workspaces/adhdev' },
        { role: 'user', kind: 'standard', content: 'mesh_status then mesh_send_task', receivedAt: 1_000, historySessionId: 'coordinator-native', workspace: '/workspaces/adhdev' },
        { role: 'assistant', kind: 'standard', content: 'coordinator answer', receivedAt: 2_000, historySessionId: 'coordinator-native', workspace: '/workspaces/adhdev' },
      ],
    })
    const adapter = createHermesAdapter({
      cliType: 'codex-cli',
      workingDir: '/workspaces/adhdev',
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        providerSessionId: 'worker-native',
        messages: [
          { role: 'user', content: 'worker prompt', receivedAt: 1_000 },
          { role: 'assistant', content: 'worker answer', receivedAt: 2_000 },
        ],
      })),
      getRuntimeMetadata: vi.fn(() => ({ runtimeId: 'worker-runtime', surfaceKind: 'live' })),
    })
    const helpers = createHelpers(adapter, {
      getProvider: () => ({
        type: 'codex-cli',
        name: 'Codex',
        category: 'cli',
        canonicalHistory: { format: 'codex-jsonl', mode: 'native-source', scripts: { readSession: 'readNativeHistory' } },
        scripts: { readNativeHistory: () => null },
      }),
      currentProviderType: 'codex-cli',
      currentSession: {
        sessionId: 'worker-runtime',
        providerType: 'codex-cli',
        providerName: 'Codex',
        providerSessionId: 'worker-native',
        transport: 'pty',
        adapterKey: 'worker-runtime',
        workspace: '/workspaces/adhdev',
      },
      ctx: {
        sessionRegistry: { get: () => ({ sessionId: 'worker-runtime', instanceKey: 'worker-runtime', providerSessionId: 'worker-native' }) },
        instanceManager: { getInstance: () => null },
      },
    })

    const result = await handleReadChat(helpers as any, {
      agentType: 'codex-cli',
      targetSessionId: 'worker-runtime',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.providerSessionId).toBe('worker-native')
    expect((result.messages as any[]).map(message => message.content)).toEqual(['worker prompt', 'worker answer'])
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: expect.stringContaining('not_safely_mapped'),
    })
  })

  it('still allows explicit resume to hydrate the selected provider conversation', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/selected-resume.jsonl',
      sourceMtimeMs: Date.now(),
      providerSessionId: 'selected-resume',
      nativeHistoryCoverage: 'full',
      hasMore: false,
      messages: [
        { role: 'system', kind: 'session_start', content: '/workspaces/adhdev', receivedAt: 900, historySessionId: 'selected-resume', workspace: '/workspaces/adhdev' },
        { role: 'user', kind: 'standard', content: 'resume prompt', receivedAt: 1_000, historySessionId: 'selected-resume', workspace: '/workspaces/adhdev' },
        { role: 'assistant', kind: 'standard', content: 'resume answer', receivedAt: 2_000, historySessionId: 'selected-resume', workspace: '/workspaces/adhdev' },
      ],
    })

    const result = await handleReadChat(createHelpers(null, {
      currentSession: {
        sessionId: 'runtime-resume',
        providerType: 'hermes-cli',
        providerName: 'Hermes Agent',
        transport: 'pty',
        adapterKey: 'runtime-resume',
        workspace: '/workspaces/adhdev',
      },
    }) as any, {
      agentType: 'hermes-cli',
      providerSessionId: 'selected-resume',
      workspace: '/workspaces/adhdev',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.providerSessionId).toBe('selected-resume')
    expect((result.messages as any[]).map(message => message.content)).toEqual(['resume prompt', 'resume answer'])
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('hermes-cli', expect.objectContaining({
      historySessionId: 'selected-resume',
      workspace: '/workspaces/adhdev',
    }))
  })
})
