import { describe, expect, it, vi } from 'vitest'
import { CliProviderInstance, getForcedNewSessionScriptName, waitForCliAdapterReady } from '../../src/providers/cli-provider-instance.js'

function providerNativeHistoryScripts(readMessages: () => Array<Record<string, unknown>> | null) {
  return {
    readNativeHistory: () => {
      const messages = readMessages()
      if (!messages) return null
      return {
        messages,
        sourcePath: '/provider/native/session.jsonl',
        sourceMtimeMs: 1_800_000_000_000,
        providerSessionId: '3d991780-74a1-4e97-8c2e-c38719794b9d',
        nativeHistoryCoverage: 'full',
      }
    },
  }
}

describe('getForcedNewSessionScriptName', () => {
  it('uses a provider new-session action when launch mode is new and no explicit new-session args exist', () => {
    const provider = {
      resume: {
        supported: true,
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'new')).toBe('newSession')
  })

  it('skips forced new-session scripts when provider already supports explicit new-session args', () => {
    const provider = {
      resume: {
        supported: true,
        newSessionArgs: ['--session-id', '{{id}}'],
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'new')).toBeNull()
  })

  it('never forces a new-session script for resume launches', () => {
    const provider = {
      resume: {
        supported: true,
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'resume')).toBeNull()
  })

  it('skips confirm-gated manual new-session actions for launch-time forcing', () => {
    const provider = {
      type: 'hermes-cli',
      resume: {
        supported: true,
        resumeSessionArgs: ['--resume', '{{id}}'],
      },
      controls: [
        {
          id: 'new_session',
          type: 'action',
          invokeScript: 'newSession',
          confirmTitle: 'Start a new Hermes session?',
        },
      ],
    } as any

    expect(getForcedNewSessionScriptName(provider, 'new')).toBeNull()
  })
})

describe('waitForCliAdapterReady', () => {
  it('waits until the adapter reports ready', async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 20)

    await expect(waitForCliAdapterReady({
      isReady: () => ready,
      getStatus: () => ({ status: ready ? 'idle' : 'starting' }),
    }, {
      timeoutMs: 300,
      pollMs: 5,
    })).resolves.toBeUndefined()
  })

  it('fails early when the adapter stops before becoming ready', async () => {
    await expect(waitForCliAdapterReady({
      isReady: () => false,
      getStatus: () => ({ status: 'stopped' }),
    }, {
      timeoutMs: 300,
      pollMs: 5,
    })).rejects.toThrow(/stopped before it became ready/i)
  })
})

describe('CliProviderInstance provider session recovery', () => {
  it('preserves runtime mesh metadata when provider settings are refreshed', () => {
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
    } as any, '/tmp/project', [], 'runtime-session-mesh-settings') as any
    instance.settings = {
      enabled: true,
      autoApprove: false,
      meshNodeFor: 'mesh-runtime',
      meshNodeId: 'node-runtime',
      meshCoordinatorDaemonId: 'daemon-coordinator',
      meshCoordinatorNodeId: 'node-coordinator',
      spawnedSessionVisibility: 'visible',
      launchedByCoordinator: true,
    }
    instance.adapter = { updateRuntimeSettings: vi.fn() }
    instance.monitor = { updateConfig: vi.fn() }

    instance.updateSettings({ enabled: true, autoApprove: true, longGeneratingThresholdSec: 240 })

    expect(instance.settings).toMatchObject({
      enabled: true,
      autoApprove: true,
      longGeneratingThresholdSec: 240,
      meshNodeFor: 'mesh-runtime',
      meshNodeId: 'node-runtime',
      meshCoordinatorDaemonId: 'daemon-coordinator',
      meshCoordinatorNodeId: 'node-coordinator',
      spawnedSessionVisibility: 'visible',
      launchedByCoordinator: true,
    })
    expect(instance.adapter.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
      meshNodeFor: 'mesh-runtime',
      meshCoordinatorDaemonId: 'daemon-coordinator',
    }))
  })

  it('uses provider autoApprove defaults when runtime settings omit the field', () => {
    const disabledByDefault = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
      settings: {
        autoApprove: {
          type: 'boolean',
          default: false,
          public: true,
          label: 'Auto Approve',
        },
      },
    } as any, '/tmp/project') as any
    disabledByDefault.settings = {}

    const enabledByDefault = new CliProviderInstance({
      type: 'test-cli',
      name: 'Test CLI',
      category: 'cli',
      spawn: { command: 'test', args: [] },
      settings: {
        autoApprove: {
          type: 'boolean',
          default: true,
          public: true,
          label: 'Auto Approve',
        },
      },
    } as any, '/tmp/project') as any
    enabledByDefault.settings = {}

    expect(disabledByDefault.shouldAutoApprove()).toBe(false)
    expect(enabledByDefault.shouldAutoApprove()).toBe(true)

    disabledByDefault.settings = { autoApprove: true }
    enabledByDefault.settings = { autoApprove: false }
    expect(disabledByDefault.shouldAutoApprove()).toBe(true)
    expect(enabledByDefault.shouldAutoApprove()).toBe(false)
  })

  it('allows lightweight approval parsing for session modal subscriptions', () => {
    const instance = new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
    } as any, '/workspaces/repo', [], 'runtime-session-1')
    const getStatus = vi.fn(() => ({
      status: 'waiting_approval',
      messages: [],
      activeModal: {
        message: 'This command requires approval',
        buttons: ['Yes, allow once', 'No, cancel'],
      },
    }))
    instance.adapter = {
      getStatus,
    } as any

    expect(instance.getSessionModalState('runtime-session-1')).toEqual({
      id: 'runtime-session-1',
      status: 'waiting_approval',
      title: 'repo',
      activeModal: {
        message: 'This command requires approval',
        buttons: ['Yes, allow once', 'No, cancel'],
      },
    })
    expect(getStatus).toHaveBeenCalledWith({ allowParse: true })
  })

  it('auto-approves a changed Claude approval modal even inside the prior approval busy window', () => {
    vi.useFakeTimers()
    try {
      const instance = new CliProviderInstance({
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        spawn: { command: 'claude', args: [] },
      } as any, '/tmp/project') as any
      const resolveModal = vi.fn()
      instance.settings = { autoApprove: true }
      instance.adapter = { resolveModal }

      expect(instance.maybeAutoApproveStatus({
        status: 'waiting_approval',
        activeModal: { message: 'Run first command?', buttons: ['Yes', 'No'] },
      })).toBe(true)
      expect(instance.maybeAutoApproveStatus({
        status: 'waiting_approval',
        activeModal: { message: 'Run first command?', buttons: ['Yes', 'No'] },
      })).toBe(true)
      expect(instance.maybeAutoApproveStatus({
        status: 'waiting_approval',
        activeModal: { message: 'Run second command?', buttons: ['Yes', 'No'] },
      })).toBe(true)

      vi.runOnlyPendingTimers()
      expect(resolveModal).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not adopt a probed hermes saved-history session id during a fresh launch', async () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
      resume: {
        supported: true,
        skipProbeOnNewSession: true,
      },
      sessionProbe: {
        dbPath: '~/.hermes/sessions.db',
        query: 'select id from sessions where cwd in ({dirs}) order by updated_at desc limit 1',
        timestampFormat: 'unix_ms',
      },
    } as any, '/tmp/project') as any

    instance.probeSessionIdFromConfig = () => '20260420_015500_deadbeef'

    await instance.onTick()

    expect(instance.getState().providerSessionId).toBeUndefined()
  })

  it('does not expose idle parser replay from a previous workspace conversation during a fresh launch', () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
      resume: { supported: true },
    } as any, '/tmp/project', [], 'runtime-fresh', undefined, { launchMode: 'new' }) as any

    instance.historyWriter = {
      appendNewMessages: vi.fn(),
      promoteHistorySession: vi.fn(),
      writeSessionStart: vi.fn(),
      seedSessionHistory: vi.fn(),
      compactHistorySession: vi.fn(),
    }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        providerSessionId: 'previous-workspace-session',
        title: 'Hermes Agent',
        messages: [
          { role: 'user', content: 'old workspace prompt' },
          { role: 'assistant', content: 'old workspace answer' },
        ],
      }),
      getRuntimeMetadata: () => ({ runtimeId: 'runtime-fresh' }),
      updateRuntimeMeta: vi.fn(),
    }

    const state = instance.getState()

    expect(state.providerSessionId).toBeUndefined()
    expect(state.activeChat?.id).toBe('runtime-fresh')
    expect(state.activeChat?.messages).toEqual([])
    expect(instance.historyWriter.appendNewMessages).not.toHaveBeenCalled()
    expect(instance.historyWriter.promoteHistorySession).not.toHaveBeenCalled()
  })

  it('keeps explicit resume history visible for resumed launches', () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
      resume: { supported: true },
    } as any, '/tmp/project', [], 'runtime-resume', undefined, {
      providerSessionId: 'saved-session-1',
      launchMode: 'resume',
    }) as any

    instance.historyWriter = { appendNewMessages: vi.fn() }
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        providerSessionId: 'saved-session-1',
        title: 'Hermes Agent',
        messages: [
          { role: 'user', content: 'saved prompt' },
          { role: 'assistant', content: 'saved answer' },
        ],
      }),
      getRuntimeMetadata: () => ({ runtimeId: 'runtime-resume' }),
    }

    const state = instance.getState()

    expect(state.providerSessionId).toBe('saved-session-1')
    expect(state.activeChat?.id).toBe('saved-session-1')
    expect(state.activeChat?.messages.map((message: any) => message.content)).toEqual([
      'saved prompt',
      'saved answer',
    ])
  })
})

describe('CliProviderInstance lightweight hot chat state', () => {
  it('does not run the rich script parser when projecting hot chat metadata', () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
    } as any, '/tmp/project', [], 'runtime-1') as any

    const getScriptParsedStatus = vi.fn(() => {
      throw new Error('rich parser should not run')
    })
    instance.adapter = {
      getStatus: () => ({ status: 'generating', activeModal: null, messages: [] }),
      getScriptParsedStatus,
      getRuntimeMetadata: () => ({
        runtimeId: 'runtime-1',
        lifecycle: 'running',
        surfaceKind: 'live_runtime',
        restoredFromStorage: false,
        recoveryState: null,
      }),
    }

    expect(instance.getHotChatSessionState()).toEqual(expect.objectContaining({
      id: 'runtime-1',
      status: 'generating',
      runtimeLifecycle: 'running',
      runtimeSurfaceKind: 'live_runtime',
    }))
    expect(getScriptParsedStatus).not.toHaveBeenCalled()
  })

  it('does not run the rich script parser while handling status transitions', () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
    } as any, '/tmp/project') as any
    const getStatus = vi.fn(() => ({ status: 'generating', activeModal: null, messages: [] }))
    const getScriptParsedStatus = vi.fn(() => {
      throw new Error('rich parser should not run from status transitions')
    })
    instance.adapter = {
      getStatus,
      getScriptParsedStatus,
      getPartialResponse: () => '',
      getRuntimeMetadata: () => null,
    }
    instance.historyWriter = { appendNewMessages: vi.fn() }
    instance.lastStatus = 'idle'

    expect(() => instance.detectStatusTransition()).not.toThrow()
    expect(getStatus).toHaveBeenCalledWith({ allowParse: false })
    expect(getScriptParsedStatus).not.toHaveBeenCalled()
  })

  it('auto-approves modals discovered only by parsed getStatus snapshots', () => {
    vi.useFakeTimers()
    try {
      const instance = new CliProviderInstance({
        type: 'hermes-cli',
        name: 'Hermes Agent',
        category: 'cli',
        spawn: { command: 'hermes', args: [] },
        settings: {
          autoApprove: {
            type: 'boolean',
            default: true,
            public: true,
            label: 'Auto Approve',
          },
        },
      } as any, '/tmp/project') as any
      const resolveModal = vi.fn()
      instance.adapter = {
        getStatus: vi.fn(() => ({
          status: 'waiting_approval',
          activeModal: {
            title: 'Approve command?',
            buttons: ['Allow once', 'Reject'],
          },
          messages: [],
        })),
        getScriptParsedStatus: () => ({
          status: 'waiting_approval',
          title: 'Hermes Agent',
          messages: [],
          activeModal: {
            title: 'Approve command?',
            buttons: ['Allow once', 'Reject'],
          },
        }),
        resolveModal,
        getRuntimeMetadata: () => null,
      }
      instance.historyWriter = { appendNewMessages: vi.fn() }

      const state = instance.getState()
      vi.runOnlyPendingTimers()

      expect(state.status).toBe('generating')
      expect(state.activeModal ?? null).toBeNull()
      expect(resolveModal).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a pending completion when generation resumes before the debounce callback observes it', () => {
    vi.useFakeTimers()
    try {
      const instance = new CliProviderInstance({
        type: 'hermes-cli',
        name: 'Hermes Agent',
        category: 'cli',
        spawn: { command: 'hermes', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({ status, title: 'Hermes Agent', messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event) => event.event)).toContain('agent:generating_started')

      status = 'idle'
      instance.detectStatusTransition()
      status = 'generating'
      vi.advanceTimersByTime(3000)

      expect(events.map((event) => event.event)).not.toContain('agent:generating_completed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for read_chat-finalized assistant transcript before emitting completion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'hermes-cli',
        name: 'Hermes Agent',
        category: 'cli',
        spawn: { command: 'hermes', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      let parsed = {
        status: 'generating',
        title: 'Hermes Agent',
        messages: [
          { role: 'assistant', content: 'previous reply', kind: 'standard' },
          { role: 'user', content: 'current prompt', kind: 'standard' },
        ],
      }
      const getScriptParsedStatus = vi.fn(() => parsed)
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        isProcessing: () => parsed.status === 'generating',
        getScriptParsedStatus,
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event) => event.event)).toContain('agent:generating_started')

      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)

      expect(events.map((event) => event.event)).not.toContain('agent:generating_completed')

      parsed = {
        status: 'idle',
        title: 'Hermes Agent',
        messages: [
          { role: 'assistant', content: 'previous reply', kind: 'standard' },
          { role: 'user', content: 'current prompt', kind: 'standard' },
          { role: 'assistant', content: 'final summary', kind: 'standard' },
        ],
      }
      vi.advanceTimersByTime(1000)

      expect(events.map((event) => event.event)).toContain('agent:generating_completed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit short completion for providers that require final assistant evidence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex', args: [] },
        requiresFinalAssistantBeforeIdle: true,
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({
          status,
          title: 'Codex CLI',
          messages: [],
        }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      status = 'idle'
      instance.detectStatusTransition()

      expect(events.map((event) => event.event)).not.toContain('agent:generating_completed')
      expect(instance.lastStatus).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit short completion for claude external-native startup transcript without assistant output', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T00:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        spawn: { command: 'claude', args: [] },
        nativeHistory: {
          format: 'claude-jsonl',
          watchPath: '~/.claude/projects/**/*.jsonl',
          mode: 'native-source',
          scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
        },
        scripts: providerNativeHistoryScripts(() => [
          { role: 'user', kind: 'standard', content: 'AskUserQuestion prompt', receivedAt: 1_800_000_001_000 },
        ]),
      } as any, '/tmp/project', [], 'runtime-claude', undefined, {
        providerSessionId: '3d991780-74a1-4e97-8c2e-c38719794b9d',
        launchMode: 'new',
      }) as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      instance.adapter = {
        chatMessagesOwnedExternally: true,
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({ status: 'idle', title: 'Claude Code', messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      status = 'idle'
      instance.detectStatusTransition()

      expect(events.map((event) => event.event)).not.toContain('agent:generating_completed')
      expect(instance.lastStatus).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for claude external-native assistant evidence before completing a fresh turn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T00:05:00Z'))
    try {
      let nativeMessages: Array<Record<string, unknown>> = [
        { role: 'user', kind: 'standard', content: 'AskUserQuestion prompt', receivedAt: 1_800_000_001_000 },
      ]
      const instance = new CliProviderInstance({
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        spawn: { command: 'claude', args: [] },
        nativeHistory: {
          format: 'claude-jsonl',
          watchPath: '~/.claude/projects/**/*.jsonl',
          mode: 'native-source',
          scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
        },
        scripts: providerNativeHistoryScripts(() => nativeMessages),
      } as any, '/tmp/project', [], 'runtime-claude', undefined, {
        providerSessionId: '3d991780-74a1-4e97-8c2e-c38719794b9d',
        launchMode: 'new',
      }) as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      instance.adapter = {
        chatMessagesOwnedExternally: true,
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({ status: 'idle', title: 'Claude Code', messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event) => event.event)).toContain('agent:generating_started')

      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(35_000)

      expect(events.map((event) => event.event)).not.toContain('agent:generating_completed')

      nativeMessages = [
        ...nativeMessages,
        { role: 'assistant', kind: 'standard', content: 'I choose rock. You win.', receivedAt: 1_800_000_002_000 },
      ]
      vi.advanceTimersByTime(1000)

      const completed = events.find((event) => event.event === 'agent:generating_completed')
      expect(completed).toMatchObject({
        finalSummary: 'I choose rock. You win.',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // State is decided by the FSM/adapter, not by native-transcript shape. The native
  // history is only the *message* source: once the adapter reports idle, completion
  // fires and finalSummary is pulled from the native transcript. While the adapter
  // stays generating, no completion is emitted — even if the transcript already shows
  // a final assistant message. (The old external-native-final override that forced
  // generating→idle from transcript shape was removed: it fired task_completed tens of
  // seconds early during post-approval busy flaps.)
  it('emits completion at FSM idle and pulls finalSummary from native history; never overrides a generating adapter', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-15T08:00:00Z'))
    try {
      let nativeMessages: Array<Record<string, unknown>> = [
        { role: 'user', kind: 'standard', content: 'Update README', receivedAt: Date.now() },
      ]
      const instance = new CliProviderInstance({
        type: 'antigravity-cli',
        name: 'Antigravity',
        category: 'cli',
        spawn: { command: 'agy', args: [] },
        nativeHistory: {
          format: 'antigravity-jsonl',
          watchPath: '~/.gemini/antigravity-cli',
          mode: 'native-source',
          scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
        },
        scripts: providerNativeHistoryScripts(() => nativeMessages),
      } as any, '/tmp/project', [], 'runtime-antigravity', undefined, {
        providerSessionId: '3d991780-74a1-4e97-8c2e-c38719794b9d',
        launchMode: 'new',
      }) as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      let parsedStatus = 'generating'
      instance.adapter = {
        chatMessagesOwnedExternally: true,
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        isProcessing: () => status === 'generating',
        getScriptParsedStatus: () => ({ status: parsedStatus, title: 'Antigravity', messages: nativeMessages }),
        getPartialResponse: () => (status === 'generating' ? '⣾ Working...' : ''),
        getRuntimeMetadata: () => null,
      }
      instance.recordAcknowledgedUserInput('Update README')

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event) => event.event)).toContain('agent:generating_started')

      // The transcript already shows a final assistant message, but the adapter is
      // still generating. No completion may fire — FSM is authoritative.
      nativeMessages = [
        ...nativeMessages,
        { role: 'assistant', kind: 'standard', content: 'README updated.', receivedAt: Date.now() + 1_000 },
      ]
      vi.advanceTimersByTime(1000)
      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.find((event) => event.event === 'agent:generating_completed')).toBeUndefined()
      expect(instance.getState().status).toBe('generating')

      // Now the FSM settles idle — completion fires, finalSummary comes from the
      // native transcript's final assistant message.
      status = 'idle'
      parsedStatus = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)

      const completed = events.find((event) => event.event === 'agent:generating_completed')
      expect(completed).toBeDefined()
      expect(completed.finalSummary).toBe('README updated.')
      expect(instance.getState().status).toBe('idle')
      expect(instance.getState().activeChat.status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits mesh completion with diagnostics when external-native final assistant never arrives', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T00:10:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex', args: [] },
        nativeHistory: {
          format: 'codex-jsonl',
          watchPath: '~/.codex/sessions/**/*.jsonl',
          mode: 'native-source',
          scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
        },
        scripts: providerNativeHistoryScripts(() => [
          { role: 'user', kind: 'standard', content: 'Do the assigned task', receivedAt: 1_800_000_601_000 },
        ]),
      } as any, '/tmp/project', [], 'runtime-codex', undefined, {
        providerSessionId: '019ea42e-f1f8-7cb1-82fe-0b3b3f2ccc46',
        launchMode: 'new',
      }) as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'
      instance.settings = {
        meshNodeFor: 'mesh-test',
        meshNodeId: 'node-test',
        meshActiveTaskId: 'task-test',
      }

      let status = 'generating'
      instance.adapter = {
        chatMessagesOwnedExternally: true,
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({ status: 'idle', title: 'Codex CLI', messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event) => event.event)).toContain('agent:generating_started')

      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(35_000)

      const completed = events.find((event) => event.event === 'agent:generating_completed')
      expect(completed).toMatchObject({
        completionDiagnostic: {
          emittedAfterFinalizationTimeout: true,
          blockReason: 'missing_final_assistant',
          providerSessionId: '019ea42e-f1f8-7cb1-82fe-0b3b3f2ccc46',
          finalAssistantPresent: false,
          finalAssistantEvidenceSource: 'external-native',
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits completion with timeout diagnostics if idle parser never exposes a final assistant turn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'hermes-cli',
        name: 'Hermes Agent',
        category: 'cli',
        spawn: { command: 'hermes', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'
      instance.providerSessionId = 'provider-history-1'

      let status = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({
          status: 'idle',
          title: 'Hermes Agent',
          messages: [
            { role: 'assistant', content: 'previous reply', kind: 'standard' },
            { role: 'user', content: 'same-session continuation', kind: 'standard' },
          ],
        }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event) => event.event)).toContain('agent:generating_started')

      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(30_000)

      const completed = events.find((event) => event.event === 'agent:generating_completed')
      expect(completed).toMatchObject({
        completionDiagnostic: {
          emittedAfterFinalizationTimeout: true,
          blockReason: 'missing_final_assistant',
          providerSessionId: 'provider-history-1',
          parsedStatus: 'idle',
          finalAssistantPresent: false,
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit completion while the parser still says generating', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'hermes-cli',
        name: 'Hermes Agent',
        category: 'cli',
        spawn: { command: 'hermes', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      let parsedStatus = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        isProcessing: () => parsedStatus === 'generating',
        getScriptParsedStatus: () => ({
          status: parsedStatus,
          title: 'Hermes Agent',
          messages: [
            { role: 'user', content: 'current prompt', kind: 'standard' },
            { role: 'assistant', content: 'I am still working through the task.', kind: 'standard' },
          ],
        }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event) => event.event)).toContain('agent:generating_started')

      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(30_000)

      expect(events.filter((event) => event.event === 'agent:generating_completed')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits completion after parser-generating evidence settles to idle', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      let parsedStatus = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        isProcessing: () => parsedStatus === 'generating',
        getScriptParsedStatus: () => ({
          status: parsedStatus,
          title: 'Codex CLI',
          messages: [
            { role: 'user', content: 'current prompt', kind: 'standard' },
            { role: 'assistant', content: 'final answer', kind: 'standard' },
          ],
        }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(30_000)
      expect(events.filter((event) => event.event === 'agent:generating_completed')).toHaveLength(0)

      parsedStatus = 'idle'
      vi.advanceTimersByTime(1000)

      expect(events.filter((event) => event.event === 'agent:generating_completed')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes approval-resolved idle once, dedupes modal redraws, and preserves mesh metadata', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T01:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex', args: [] },
      } as any, '/tmp/project', [], 'runtime-session-approval') as any
      const events: any[] = []
      const meshSettings = {
        meshNodeFor: 'mesh-approval',
        meshNodeId: 'node-approval',
        launchedByCoordinator: true,
      }
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'
      instance.settings = meshSettings

      let status = 'generating'
      let parsedStatus = 'generating'
      let activeModal: any = null
      const adapter: any = {
        currentTurnScope: { responseEpoch: 1 },
        isWaitingForResponse: true,
        chatMessagesOwnedExternally: true,
        getStatus: () => ({ status, activeModal, messages: [] }),
        getScriptParsedStatus: () => ({ status: parsedStatus, activeModal, messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
        getScreenText: () => '',
      }
      instance.adapter = adapter

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)

      const approval = {
        message: 'Allow git commit?',
        buttons: ['Allow once', 'Reject'],
      }
      status = 'waiting_approval'
      parsedStatus = 'waiting_approval'
      activeModal = approval
      instance.detectStatusTransition()

      status = 'idle'
      parsedStatus = 'idle'
      activeModal = null
      instance.detectStatusTransition()

      status = 'waiting_approval'
      parsedStatus = 'waiting_approval'
      activeModal = approval
      instance.detectStatusTransition()

      status = 'idle'
      parsedStatus = 'idle'
      activeModal = null
      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)

      expect(events.filter((event) => event.event === 'agent:waiting_approval')).toHaveLength(1)
      expect(events.filter((event) => event.event === 'agent:generating_completed')).toHaveLength(1)
      expect(instance.getState().settings).toEqual(meshSettings)
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes after approval returns to generating and then settles idle', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T01:05:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      instance.lastStatus = 'idle'

      let status = 'generating'
      let parsedStatus = 'generating'
      let activeModal: any = null
      const adapter: any = {
        currentTurnScope: { responseEpoch: 1 },
        isWaitingForResponse: true,
        chatMessagesOwnedExternally: true,
        getStatus: () => ({ status, activeModal, messages: [] }),
        getScriptParsedStatus: () => ({ status: parsedStatus, activeModal, messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
        getScreenText: () => '',
      }
      instance.adapter = adapter

      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)

      status = 'waiting_approval'
      parsedStatus = 'waiting_approval'
      activeModal = { message: 'Allow command?', buttons: ['Allow', 'Reject'] }
      instance.detectStatusTransition()

      status = 'generating'
      parsedStatus = 'generating'
      activeModal = null
      instance.detectStatusTransition()

      adapter.currentTurnScope = null
      adapter.isWaitingForResponse = false
      status = 'idle'
      parsedStatus = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)

      expect(events.filter((event) => event.event === 'agent:waiting_approval')).toHaveLength(1)
      expect(events.filter((event) => event.event === 'agent:generating_completed')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CliProviderInstance incremental history persistence', () => {
  it('persists only the new transcript suffix when repeated getState snapshots replay the full transcript with fresh fallback timestamps', () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
    } as any, '/tmp/project') as any

    const appendNewMessages = vi.fn()
    instance.historyWriter = { appendNewMessages } as any
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Hermes Agent',
        messages: [
          { role: 'user', content: 'same prompt', kind: 'standard', receivedAt: 1_000 },
          { role: 'assistant', content: 'same reply', kind: 'tool', senderName: 'Tool', receivedAt: 2_000 },
        ],
      }),
      getRuntimeMetadata: () => null,
    }

    instance.getState()
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Hermes Agent',
        messages: [
          { role: 'user', content: 'same prompt', kind: 'standard', receivedAt: 9_000 },
          { role: 'assistant', content: 'same reply', kind: 'tool', senderName: 'Tool', receivedAt: 10_000 },
          { role: 'assistant', content: 'new tail', kind: 'standard', receivedAt: 11_000 },
        ],
      }),
      getRuntimeMetadata: () => null,
    }

    instance.getState()
    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({
        status: 'idle',
        title: 'Hermes Agent',
        messages: [
          { role: 'user', content: 'same prompt', kind: 'standard', receivedAt: 12_000 },
          { role: 'assistant', content: 'same reply', kind: 'tool', senderName: 'Tool', receivedAt: 13_000 },
          { role: 'assistant', content: 'new tail', kind: 'standard', receivedAt: 14_000 },
        ],
      }),
      getRuntimeMetadata: () => null,
    }

    instance.getState()

    expect(appendNewMessages).toHaveBeenCalledTimes(2)

    expect(appendNewMessages).toHaveBeenNthCalledWith(
      1,
      'hermes-cli',
      [
        { role: 'user', content: 'same prompt', kind: 'standard', receivedAt: 1_000 },
        { role: 'assistant', content: 'same reply', kind: 'tool', senderName: 'Tool', receivedAt: 2_000 },
      ],
      'Hermes Agent',
      instance.instanceId,
      undefined,
    )
    expect(appendNewMessages).toHaveBeenNthCalledWith(
      2,
      'hermes-cli',
      [
        { role: 'assistant', content: 'new tail', kind: 'standard', receivedAt: 11_000 },
      ],
      'Hermes Agent',
      instance.instanceId,
      undefined,
    )
  })
})

describe('CliProviderInstance — startup-phase spurious completion suppression', () => {
  it('does not emit generating_completed when starting→generating→idle fires without a real task dispatch', () => {
    // Regression: session enters 'starting' state on spawn, then PTY startup output
    // briefly triggers the provider script to report 'generating', then settles to 'idle'.
    // Because idle→generating handler is the only code path that sets generatingStartedAt
    // and generatingDebouncePending, both being absent signals a startup blip that must not
    // fire agent:generating_completed.
    vi.useFakeTimers()
    try {
      const instance = new CliProviderInstance({
        type: 'antigravity-cli',
        name: 'Antigravity CLI',
        category: 'cli',
        spawn: { command: 'agy', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      // lastStatus starts at 'starting' — matching real spawn lifecycle
      expect(instance.lastStatus).toBe('starting')

      let status = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({ status, title: 'Antigravity CLI', messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      // PTY startup noise: starting → generating (no task dispatched)
      instance.detectStatusTransition()
      expect(instance.lastStatus).toBe('generating')

      // PTY quiet period: generating → idle (startup settling)
      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(30_000)

      expect(events.map((event: any) => event.event)).not.toContain('agent:generating_completed')
      expect(instance.lastStatus).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit generating_completed for codex-cli starting→generating→idle startup blip', () => {
    vi.useFakeTimers()
    try {
      const instance = new CliProviderInstance({
        type: 'codex-cli',
        name: 'Codex CLI',
        category: 'cli',
        spawn: { command: 'codex', args: [] },
        requiresFinalAssistantBeforeIdle: true,
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      expect(instance.lastStatus).toBe('starting')

      let status = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({ status, title: 'Codex CLI', messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(30_000)

      expect(events.map((event: any) => event.event)).not.toContain('agent:generating_completed')
      expect(instance.lastStatus).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit generating_completed for hermes-cli starting→generating→idle startup blip', () => {
    vi.useFakeTimers()
    try {
      const instance = new CliProviderInstance({
        type: 'hermes-cli',
        name: 'Hermes Agent',
        category: 'cli',
        spawn: { command: 'hermes', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      expect(instance.lastStatus).toBe('starting')

      let status = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({ status, title: 'Hermes Agent', messages: [] }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      instance.detectStatusTransition()
      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(30_000)

      expect(events.map((event: any) => event.event)).not.toContain('agent:generating_completed')
      expect(instance.lastStatus).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still emits agent:ready when starting→idle fires directly (no generating blip)', () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
    } as any, '/tmp/project') as any
    const events: any[] = []
    instance.pushEvent = (event: any) => events.push(event)
    instance.historyWriter = { appendNewMessages: vi.fn() }
    expect(instance.lastStatus).toBe('starting')

    instance.adapter = {
      getStatus: () => ({ status: 'idle', activeModal: null, messages: [] }),
      getScriptParsedStatus: () => ({ status: 'idle', title: 'Hermes Agent', messages: [] }),
      getPartialResponse: () => '',
      getRuntimeMetadata: () => null,
    }

    instance.detectStatusTransition()

    expect(events.map((event: any) => event.event)).toContain('agent:ready')
    expect(events.map((event: any) => event.event)).not.toContain('agent:generating_completed')
    expect(instance.lastStatus).toBe('idle')
  })

  it('emits generating_completed normally after a real idle→generating→idle task turn', () => {
    // Confirm the fix does not regress normal task completion.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T00:00:00Z'))
    try {
      const instance = new CliProviderInstance({
        type: 'hermes-cli',
        name: 'Hermes Agent',
        category: 'cli',
        spawn: { command: 'hermes', args: [] },
      } as any, '/tmp/project') as any
      const events: any[] = []
      instance.pushEvent = (event: any) => events.push(event)
      instance.historyWriter = { appendNewMessages: vi.fn() }
      // Manually advance to idle (past startup)
      instance.lastStatus = 'idle'

      let status = 'generating'
      instance.adapter = {
        getStatus: () => ({ status, activeModal: null, messages: [] }),
        getScriptParsedStatus: () => ({
          status,
          title: 'Hermes Agent',
          messages: [
            { role: 'user', content: 'do a task', kind: 'standard' },
            { role: 'assistant', content: 'task done', kind: 'standard' },
          ],
        }),
        getPartialResponse: () => '',
        getRuntimeMetadata: () => null,
      }

      // Real task: idle → generating
      instance.detectStatusTransition()
      vi.advanceTimersByTime(3000)
      expect(events.map((event: any) => event.event)).toContain('agent:generating_started')

      // Task finishes: generating → idle
      status = 'idle'
      instance.detectStatusTransition()
      vi.advanceTimersByTime(5000)

      expect(events.map((event: any) => event.event)).toContain('agent:generating_completed')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CliProviderInstance — stale parsed busy status suppression (Bug 2: false completion from non-empty responseBuffer)', () => {
  function makeInstance() {
    return new CliProviderInstance({
      type: 'claude-cli',
      name: 'Claude Code',
      category: 'cli',
      spawn: { command: 'claude', args: [] },
    } as any, '/tmp/project') as any
  }

  it('does not suppress finalization block when adapter responseBuffer is non-empty (even with isWaitingForResponse=false)', () => {
    const instance = makeInstance()
    // Simulate the Bug 2 scenario: adapter marked itself idle and cleared isWaitingForResponse,
    // but responseBuffer still has content (native parser is still processing).
    instance.adapter = {
      isWaitingForResponse: false,
      responseBuffer: 'partial response content still being parsed',
      currentTurnScope: null,
      isProcessing: () => false,
      getPartialResponse: () => '',  // gated on isWaitingForResponse, returns empty
      getStatus: () => ({ status: 'idle' }),
      getScriptParsedStatus: () => ({ status: 'generating', messages: [] }),
    }

    const parsedStatus = { status: 'generating', messages: [], activeModal: null, modal: null }
    const adapterStatus = { status: 'idle' }
    // Before fix: shouldSuppressStaleParsedBusyStatus returned true (suppressing the block),
    // causing the completion event to emit prematurely.
    // After fix: returns false because responseBuffer is non-empty.
    expect(instance.shouldSuppressStaleParsedBusyStatus(parsedStatus, adapterStatus)).toBe(false)
  })

  it('suppresses finalization block when adapter responseBuffer is empty and isWaitingForResponse=false', () => {
    const instance = makeInstance()
    // Genuine stale parsed status: adapter truly finished, responseBuffer empty, but parser lags.
    instance.adapter = {
      isWaitingForResponse: false,
      responseBuffer: '',
      currentTurnScope: null,
      isProcessing: () => false,
      getPartialResponse: () => '',
      getStatus: () => ({ status: 'idle' }),
      getScriptParsedStatus: () => ({ status: 'generating', messages: [] }),
    }

    const parsedStatus = { status: 'generating', messages: [], activeModal: null, modal: null }
    const adapterStatus = { status: 'idle' }
    // Adapter truly done (empty buffer) — suppress the stale generating block so completion can proceed.
    expect(instance.shouldSuppressStaleParsedBusyStatus(parsedStatus, adapterStatus)).toBe(true)
  })

  it('does not suppress when parsedStatus is idle (suppression only applies to generating-like parsed statuses)', () => {
    const instance = makeInstance()
    instance.adapter = {
      isWaitingForResponse: false,
      responseBuffer: '',
      currentTurnScope: null,
      isProcessing: () => false,
      getPartialResponse: () => '',
    }

    const parsedStatus = { status: 'idle', messages: [], activeModal: null, modal: null }
    const adapterStatus = { status: 'idle' }
    expect(instance.shouldSuppressStaleParsedBusyStatus(parsedStatus, adapterStatus)).toBe(false)
  })
})
