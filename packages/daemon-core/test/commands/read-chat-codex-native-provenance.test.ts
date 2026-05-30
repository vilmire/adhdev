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

import { handleGetChatDebugBundle, handleReadChat } from '../../src/commands/chat-commands.js'

function createCodexAdapter(overrides: Record<string, unknown> = {}) {
  return {
    cliType: 'codex-cli',
    cliName: 'Codex CLI',
    workingDir: '/workspaces/adhdev',
    getStatus: vi.fn(() => ({
      status: 'idle',
      activeModal: null,
      messages: [{ role: 'assistant', content: 'pty assistant', receivedAt: 2_000 }],
    })),
    getScriptParsedStatus: vi.fn(() => ({
      status: 'idle',
      providerSessionId: 'native-session',
      title: 'Codex CLI',
      messages: [
        { role: 'user', content: 'pty user', receivedAt: 1_000 },
        { role: 'assistant', content: 'pty assistant', receivedAt: 2_000 },
      ],
    })),
    getDebugSnapshot: vi.fn(() => ({ terminalScreenText: 'codex terminal status' })),
    getPartialResponse: vi.fn(() => ''),
    isProcessing: () => false,
    isReady: () => true,
    ...overrides,
  }
}

function createHelpers(adapter = createCodexAdapter()) {
  const provider = {
    type: 'codex-cli',
    name: 'Codex CLI',
    category: 'cli',
    canonicalHistory: {
      format: 'codex-provider-native',
      mode: 'native-source',
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
    currentProviderType: 'codex-cli',
    currentSession: {
      sessionId: 'runtime-session',
      providerType: 'codex-cli',
      providerName: 'Codex CLI',
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
  }
}

describe('Codex CLI read_chat native transcript provenance', () => {
  beforeEach(() => {
    mocks.readProviderChatHistory.mockReset()
  })

  it('suppresses PTY message bodies when native-history is selected even when PTY and native counts match (regression: safeMapping must not imply PTY is safe chat material)', async () => {
    // Reproduces the debug bundle scenario:
    //   providerType=codex-cli, transport=pty, native-history selected,
    //   ptyStatusApprovalOnly=true, but coverage showed nativeCount==ptyCount==returnedCount
    //   with safeMapping=true — falsely implying PTY messages were safe chat material.
    const ptyMessages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `pty message ${i}`,
      receivedAt: (i + 1) * 1_000,
    }))
    const nativeMessages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `native message ${i}`,
      receivedAt: (i + 1) * 2_000,
      historySessionId: 'native-session',
    }))
    const adapter = createCodexAdapter({
      getStatus: vi.fn(() => ({ status: 'generating', activeModal: null, messages: [] })),
      getScriptParsedStatus: vi.fn(() => ({
        status: 'generating',
        providerSessionId: 'native-session',
        messages: ptyMessages,
      })),
    })
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: nativeMessages,
    })

    const result = await handleReadChat(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    // Returned messages must come from native history only — no PTY body content
    expect((result.messages as any[]).map((m) => m.content)).toEqual(
      nativeMessages.map((m) => m.content),
    )
    expect((result.messages as any[]).map((m) => m.content)).not.toContain('pty message 0')
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      ptyStatusApprovalOnly: true,
      coverage: {
        nativeMessageCount: 6,
        ptyMessageCount: 6,
        returnedMessageCount: 6,
        safeMapping: true,
        // KEY: even when counts are equal, ptyMessagesSuppressed must be true so that
        // safeMapping cannot be misread as "PTY messages are safe chat material".
        ptyMessagesSuppressed: true,
      },
    })
    // PTY contributes status evidence but not chat content
    expect(result.status).toBe('generating')
  })

  it('marks ptyMessagesSuppressed false when PTY parser is the selected source', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'native-unavailable',
      hasMore: false,
      messages: [],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      coverage: {
        ptyMessagesSuppressed: false,
      },
    })
  })

  it('selects fresh safely mapped native Codex history while keeping PTY for status and approval', async () => {
    const adapter = createCodexAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'waiting_approval',
        providerSessionId: 'native-session',
        activeModal: { message: 'Approve command?', buttons: ['Yes', 'No'] },
        messages: [{ role: 'assistant', content: 'pty approval screen', receivedAt: 2_000 }],
      })),
    })
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'user', content: 'native user', receivedAt: 3_000, historySessionId: 'native-session' },
        { role: 'assistant', content: 'native assistant', receivedAt: 4_000, historySessionId: 'native-session' },
      ],
    })

    const result = await handleReadChat(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('waiting_approval')
    expect(result.activeModal).toMatchObject({ buttons: ['Yes', 'No'] })
    expect((result.messages as any[]).map(message => message.content)).toEqual(['native user', 'native assistant'])
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'codex-cli',
      nativeHandle: 'native-session',
      ptyStatusApprovalOnly: true,
      coverage: {
        nativeMessageCount: 2,
        ptyMessageCount: 1,
        returnedMessageCount: 2,
        safeMapping: true,
        ptyMessagesSuppressed: true,
      },
    })
    expect(result.debugReadChat).toMatchObject({
      selectedMessageSource: 'native-history',
      shouldPreferAdapterMessages: false,
    })
  })

  it('does not retry Codex native history by workspace when PTY runtime id is not the Codex JSONL session id', async () => {
    const runtimeId = '0eae4e76-4980-4d99-b54c-9c6a1cfce5dd'
    const adapter = createCodexAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        title: 'Codex CLI',
        messages: [
          { role: 'user', content: 'native prompt', receivedAt: 1_000 },
          { role: 'assistant', content: 'parser-level artifact', receivedAt: 2_000 },
        ],
      })),
    })
    mocks.readProviderChatHistory
      .mockReturnValueOnce({
        source: 'native-unavailable',
        hasMore: false,
        messages: [],
      })

    const result = await handleReadChat(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: runtimeId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(mocks.readProviderChatHistory).toHaveBeenNthCalledWith(1, 'codex-cli', expect.objectContaining({
      historySessionId: runtimeId,
      workspace: '/workspaces/adhdev',
    }))
    expect(mocks.readProviderChatHistory).toHaveBeenCalledTimes(1)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['native prompt', 'parser-level artifact'])
    expect(result.providerSessionId).toBeUndefined()
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      provider: 'codex-cli',
      nativeHandle: runtimeId,
      nativeSource: 'native-unavailable',
      fallbackReason: 'native_history_unavailable',
      ptyStatusApprovalOnly: false,
      coverage: {
        nativeMessageCount: 0,
        ptyMessageCount: 2,
        returnedMessageCount: 2,
        safeMapping: false,
      },
    })
    expect(result.debugReadChat).toMatchObject({
      selectedMessageSource: 'pty-parser',
      fullMsgCount: 2,
      visibleMsgCount: 2,
      hiddenMsgCount: 0,
      returnedMsgCount: 2,
    })
  })

  it('does not route a same-workspace Codex worker read_chat to an unrelated workspace-native transcript', async () => {
    const runtimeId = 'worker-runtime-session'
    const coordinatorHistoryId = 'coordinator-native-session'
    const adapter = createCodexAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        title: 'Codex CLI',
        messages: [
          { role: 'user', content: 'worker-specific prompt', receivedAt: 1_000 },
          { role: 'assistant', content: 'worker-specific pty answer', receivedAt: 2_000 },
        ],
      })),
    })
    mocks.readProviderChatHistory
      .mockReturnValueOnce({
        source: 'native-unavailable',
        hasMore: false,
        messages: [],
      })
      .mockReturnValueOnce({
        source: 'provider-native',
        sourcePath: `/Users/test/.codex/sessions/${coordinatorHistoryId}.jsonl`,
        sourceMtimeMs: Date.now(),
        hasMore: false,
        messages: [
          { role: 'user', content: 'coordinator prompt', receivedAt: 3_000, historySessionId: coordinatorHistoryId, workspace: '/workspaces/adhdev' },
          { role: 'assistant', content: 'coordinator answer', receivedAt: 4_000, historySessionId: coordinatorHistoryId, workspace: '/workspaces/adhdev' },
        ],
      })

    const result = await handleReadChat(createHelpers(adapter) as any, {
      agentType: 'codex-cli',
      targetSessionId: runtimeId,
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual([
      'worker-specific prompt',
      'worker-specific pty answer',
    ])
    expect(result.providerSessionId).toBeUndefined()
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_unavailable',
      coverage: {
        nativeMessageCount: 0,
        ptyMessageCount: 2,
        returnedMessageCount: 2,
        safeMapping: false,
      },
    })
  })

  it('falls back to PTY parser messages with an explicit stale native-history reason', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: 1,
      hasMore: false,
      messages: [
        { role: 'user', content: 'stale native user', receivedAt: 500, historySessionId: 'native-session' },
      ],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect((result.messages as any[]).map(message => message.content)).toEqual(['pty user', 'pty assistant'])
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_stale',
      ptyStatusApprovalOnly: false,
      staleness: { freshEnough: false },
    })
    expect(result.debugReadChat).toMatchObject({
      selectedMessageSource: 'pty-parser',
      shouldPreferAdapterMessages: true,
    })
  })

  it('fails closed for inactive Codex sessions when provider-native history is not safely mapped', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/other-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'assistant', content: 'wrong native assistant', receivedAt: 4_000, historySessionId: 'other-session' },
      ],
    })

    const result = await handleReadChat(createHelpers(null) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('native_history_not_safely_available')
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_not_safely_mapped',
    })
    expect((result as any).messages).toBeUndefined()
  })

  it('fails closed when native messages have no historySessionId but workspace matches another session', async () => {
    // Regression: same-workspace Codex sessions must not be aliased when native messages
    // don't carry historySessionId. Previously the code fell through to workspace-only
    // matching which silently accepted the wrong session's history.
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/other-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        // No historySessionId field — these messages belong to a different session in the same workspace
        { role: 'user', content: 'other session user', receivedAt: 3_000, workspace: '/workspaces/adhdev' },
        { role: 'assistant', content: 'other session assistant', receivedAt: 4_000, workspace: '/workspaces/adhdev' },
      ],
    })

    const result = await handleReadChat(createHelpers(null) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('native_history_not_safely_available')
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_not_safely_mapped',
      coverage: { safeMapping: false },
    })
    expect((result as any).messages).toBeUndefined()
  })

  it('fails closed for inactive session when native messages have no historySessionId and workspace matches', async () => {
    // Regression: inactive session (no adapter) must not accept same-workspace native history
    // that lacks historySessionId. Workspace-only matching must not override explicit session identity.
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/coordinator-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        // No historySessionId — coordinator session transcript from same workspace, no session tag
        { role: 'user', content: 'coordinator user', receivedAt: 1_000, workspace: '/workspaces/adhdev' },
        { role: 'assistant', content: 'coordinator assistant', receivedAt: 2_000, workspace: '/workspaces/adhdev' },
      ],
    })

    const result = await handleReadChat(createHelpers(null) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'worker-runtime-id',
      providerSessionId: 'worker-native-session',
      tailLimit: 20,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('native_history_not_safely_available')
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_not_safely_mapped',
    })
  })

  it('same workspace + distinct providerSessionIds produce distinct safe mapping results', async () => {
    // Regression: two Codex sessions sharing a workspace must only pass safe mapping when the
    // historySessionId in the returned messages exactly matches the requested providerSessionId.
    mocks.readProviderChatHistory
      .mockReturnValueOnce({
        source: 'provider-native',
        sourcePath: '/Users/test/.codex/sessions/session-A.jsonl',
        sourceMtimeMs: Date.now(),
        hasMore: false,
        messages: [
          { role: 'user', content: 'session A user', receivedAt: 1_000, historySessionId: 'session-A', workspace: '/workspaces/adhdev' },
          { role: 'assistant', content: 'session A assistant', receivedAt: 2_000, historySessionId: 'session-A', workspace: '/workspaces/adhdev' },
        ],
      })
      .mockReturnValueOnce({
        source: 'provider-native',
        sourcePath: '/Users/test/.codex/sessions/session-A.jsonl',
        sourceMtimeMs: Date.now(),
        hasMore: false,
        messages: [
          { role: 'user', content: 'session A user', receivedAt: 1_000, historySessionId: 'session-A', workspace: '/workspaces/adhdev' },
          { role: 'assistant', content: 'session A assistant', receivedAt: 2_000, historySessionId: 'session-A', workspace: '/workspaces/adhdev' },
        ],
      })

    // Session A requesting its own history: safe mapping must pass
    const resultA = await handleReadChat(createHelpers(null) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-A',
      providerSessionId: 'session-A',
      tailLimit: 20,
    })
    expect(resultA.success).toBe(true)
    expect((resultA.messages as any[]).map((m) => m.content)).toEqual(['session A user', 'session A assistant'])
    expect(resultA.messageSource).toMatchObject({ selected: 'native-history', coverage: { safeMapping: true } })

    // Session B requesting session-A's file with session-B identity: safe mapping must fail
    const resultB = await handleReadChat(createHelpers(null) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-B',
      providerSessionId: 'session-B',
      tailLimit: 20,
    })
    expect(resultB.success).toBe(false)
    expect(resultB.code).toBe('native_history_not_safely_available')
    expect(resultB.messageSource).toMatchObject({
      selected: 'pty-parser',
      fallbackReason: 'native_history_not_safely_mapped',
    })
  })

  it('falls back to PTY with identityStatus=transcript_unmapped when providerSessionId is empty and runtime uuid has no matching native file', async () => {
    // Regression: exact reproduction of debug bundle
    //   chat-debug-20260530T101044444Z-18bb4c98-4ff0-4641-ad3f-25ff49ad9efd-239138b9.json
    // The runtime session ID (18bb4c98-...) was passed as historySessionId to native lookup,
    // but Codex JSONL files use their own v7 UUIDs. With no providerSessionId emitted from
    // the PTY parser (because SESSION_ID_RE excluded v7 UUIDs), the native lookup always
    // failed → selectedMessageSource='pty-parser', identityStatus='transcript_unmapped',
    // nativeMessageCount=0, ptyMessageCount=17.
    const RUNTIME_SESSION_ID = '18bb4c98-4ff0-4641-ad3f-25ff49ad9efd'
    const PTY_MESSAGES = Array.from({ length: 17 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `pty message ${i}`,
      receivedAt: (i + 1) * 1_000,
    }))
    const adapter = createCodexAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        title: 'Codex CLI',
        // No providerSessionId — parser didn't extract one (simulates v7 UUID regex miss)
        messages: PTY_MESSAGES,
      })),
    })

    // Native history unavailable: no Codex JSONL file for the ADHDev runtime UUID
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'native-unavailable',
      hasMore: false,
      messages: [],
      unavailableReason: 'native_history_workspace_only_lookup_unsafe',
    })

    const helpers = {
      ...createHelpers(adapter),
      currentSession: {
        sessionId: RUNTIME_SESSION_ID,
        providerType: 'codex-cli',
        providerName: 'Codex CLI',
        transport: 'pty',
        adapterKey: RUNTIME_SESSION_ID,
        workspace: '/Users/vilmire/Work/adhdev',
      },
    }

    const result = await handleReadChat(helpers as any, {
      agentType: 'codex-cli',
      targetSessionId: RUNTIME_SESSION_ID,
      tailLimit: 40,
    })

    // Current (pre-fix) behavior: falls back to PTY with transcript_unmapped
    // Expected (post-fix): when providerSessionId is correctly extracted from
    // the TUI (now possible for v7 UUIDs after SESSION_ID_RE fix), native history
    // is used; this test documents the fallback path that still triggers when
    // the TUI has not yet rendered the session id line.
    expect(result.success).toBe(true)
    expect(result.messageSource).toMatchObject({
      selected: 'pty-parser',
      provider: 'codex-cli',
      nativeHandle: RUNTIME_SESSION_ID,
      nativeSource: 'native-unavailable',
      identityStatus: 'transcript_unmapped',
      ptyStatusApprovalOnly: false,
      coverage: {
        nativeMessageCount: 0,
        ptyMessageCount: 17,
        safeMapping: false,
        ptyMessagesSuppressed: false,
      },
    })
    expect((result.messages as any[]).length).toBe(17)
    // fallbackReason must start with native_history_unavailable (may carry a sub-code)
    expect((result.messageSource as any).fallbackReason).toMatch(/^native_history_unavailable/)
    // identityStatus must distinguish unmapped from ambiguous
    expect((result.messageSource as any).identityStatus).toBe('transcript_unmapped')
  })

  it('selects native history when providerSessionId is the Codex v7 native UUID (not the ADHDev runtime UUID)', async () => {
    // Post-fix scenario: after SESSION_ID_RE is broadened to match v7 UUIDs,
    // the PTY parser returns the Codex-native v7 UUID as providerSessionId.
    // read_chat must then use that UUID for the native lookup, not the runtime session UUID.
    const RUNTIME_SESSION_ID = '18bb4c98-4ff0-4641-ad3f-25ff49ad9efd'
    const CODEX_NATIVE_UUID = '019dfd67-cb1a-7b72-9c0f-690a1ccef0aa' // v7 UUID from Codex file
    const NATIVE_MESSAGES = [
      { role: 'user', content: '메시상태확인, 정리필요한게 있는지 확인', receivedAt: 1_780_135_819_000, historySessionId: CODEX_NATIVE_UUID },
      { role: 'assistant', content: 'Called adhdev-mesh.mesh_status(...)', receivedAt: 1_780_135_820_000, historySessionId: CODEX_NATIVE_UUID },
    ]
    const adapter = createCodexAdapter({
      getScriptParsedStatus: vi.fn(() => ({
        status: 'idle',
        title: 'Codex CLI',
        // providerSessionId now set to the Codex v7 UUID (what SESSION_ID_RE returns after fix)
        providerSessionId: CODEX_NATIVE_UUID,
        messages: [
          { role: 'user', content: 'pty user', receivedAt: 1_780_135_819_000 },
          { role: 'assistant', content: 'pty assistant', receivedAt: 1_780_135_820_000 },
        ],
      })),
    })

    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: `/Users/vilmire/.codex/sessions/2026/05/30/rollout-2026-05-30T10-09-00-${CODEX_NATIVE_UUID}.jsonl`,
      sourceMtimeMs: Date.now(),
      hasMore: false,
      providerSessionId: CODEX_NATIVE_UUID,
      workspace: '/Users/vilmire/Work/adhdev',
      messages: NATIVE_MESSAGES,
    })

    const helpers = {
      ...createHelpers(adapter),
      currentSession: {
        sessionId: RUNTIME_SESSION_ID,
        providerType: 'codex-cli',
        providerName: 'Codex CLI',
        transport: 'pty',
        adapterKey: RUNTIME_SESSION_ID,
        workspace: '/Users/vilmire/Work/adhdev',
      },
    }

    const result = await handleReadChat(helpers as any, {
      agentType: 'codex-cli',
      targetSessionId: RUNTIME_SESSION_ID,
      tailLimit: 40,
    })

    expect(result.success).toBe(true)
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'codex-cli',
      nativeHandle: CODEX_NATIVE_UUID,
      ptyStatusApprovalOnly: true,
      coverage: {
        nativeMessageCount: 2,
        ptyMessageCount: 2,
        safeMapping: true,
        ptyMessagesSuppressed: true,
      },
    })
    // Native messages must be used, not PTY
    expect((result.messages as any[]).map((m: any) => m.content)).toEqual(
      NATIVE_MESSAGES.map((m) => m.content),
    )
    // Native lookup called with Codex v7 UUID, not the ADHDev runtime UUID
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      historySessionId: CODEX_NATIVE_UUID,
    }))
  })

  it('includes selected transcript provenance in chat debug bundles', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      messages: [
        { role: 'user', content: 'native debug user', receivedAt: 3_000, historySessionId: 'native-session' },
        { role: 'assistant', content: 'native debug assistant', receivedAt: 4_000, historySessionId: 'native-session' },
      ],
    })

    const result = await handleGetChatDebugBundle(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
    })

    expect(result.success).toBe(true)
    expect((result.bundle as any).readChat.messageSource).toMatchObject({
      selected: 'native-history',
      provider: 'codex-cli',
      nativeHandle: 'native-session',
      ptyStatusApprovalOnly: true,
    })
    expect((result.bundle as any).readChat.debugReadChat.messageSource).toMatchObject({
      selected: 'native-history',
      coverage: {
        nativeMessageCount: 2,
        ptyMessageCount: 2,
        returnedMessageCount: 2,
        safeMapping: true,
        ptyMessagesSuppressed: true,
      },
    })
  })

  it('keeps session workspace separate from intended mesh target workspace', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/native-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      providerSessionId: 'native-session',
      workspace: '/workspaces/adhdev',
      messages: [
        { role: 'user', content: 'root session user', receivedAt: 3_000, historySessionId: 'native-session', workspace: '/workspaces/adhdev' },
        { role: 'assistant', content: 'root session assistant', receivedAt: 4_000, historySessionId: 'native-session', workspace: '/workspaces/adhdev' },
      ],
    })

    const result = await handleReadChat(createHelpers() as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      workspace: '/workspaces/adhdev/.adhdev-worktrees/worktree-a',
      tailLimit: 20,
    })

    expect(result.success).toBe(true)
    expect(result.messageSource).toMatchObject({
      selected: 'native-history',
      sessionWorkspace: '/workspaces/adhdev',
      intendedWorkspace: '/workspaces/adhdev/.adhdev-worktrees/worktree-a',
      transcriptWorkspace: '/workspaces/adhdev',
    })
    expect(mocks.readProviderChatHistory).toHaveBeenCalledWith('codex-cli', expect.objectContaining({
      historySessionId: 'native-session',
      workspace: '/workspaces/adhdev',
    }))
  })

  it('debug bundle surfaces unsafe identity state clearly without synthetic bubbles', async () => {
    mocks.readProviderChatHistory.mockReturnValue({
      source: 'provider-native',
      sourcePath: '/Users/test/.codex/sessions/other-session.jsonl',
      sourceMtimeMs: Date.now(),
      hasMore: false,
      providerSessionId: 'other-session',
      messages: [
        { role: 'assistant', content: 'wrong native assistant', receivedAt: 4_000, historySessionId: 'other-session' },
      ],
    })

    const result = await handleGetChatDebugBundle(createHelpers(null) as any, {
      agentType: 'codex-cli',
      targetSessionId: 'runtime-session',
      providerSessionId: 'native-session',
      delivery: 'inline',
    })

    expect(result.success).toBe(true)
    expect((result.bundle as any).readChat).toMatchObject({
      success: false,
      error: 'Provider-native history was not safely available for the requested CLI session.',
      messageSource: {
        selected: 'pty-parser',
        identityStatus: 'ambiguous_session_identity',
        fallbackReason: 'native_history_not_safely_mapped',
      },
    })
    expect((result.bundle as any).readChat.messagesTail).toBeUndefined()
  })
})
