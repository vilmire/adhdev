import { describe, expect, it, vi } from 'vitest'
import { CliProviderInstance, getForcedNewSessionScriptName, waitForCliAdapterReady } from '../../src/providers/cli-provider-instance.js'

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

  it('does not adopt a probed hermes saved-history session id during a fresh launch', async () => {
    const instance = new CliProviderInstance({
      type: 'hermes-cli',
      name: 'Hermes Agent',
      category: 'cli',
      spawn: { command: 'hermes', args: [] },
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
