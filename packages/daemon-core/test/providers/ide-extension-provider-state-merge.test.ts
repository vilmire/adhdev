import { describe, expect, it } from 'vitest'
import { ExtensionProviderInstance } from '../../src/providers/extension-provider-instance.js'
import { IdeProviderInstance } from '../../src/providers/ide-provider-instance.js'

describe('IDE/Extension provider state merge', () => {
  it('keeps prior extension control values across partial stream updates', () => {
    const instance = new ExtensionProviderInstance({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
    } as any)

    instance.onEvent('stream_update', {
      controlValues: { model: 'sonnet' },
    })
    instance.onEvent('stream_update', {
      controlValues: { mode: 'plan' },
    })

    const state = instance.getState() as any
    expect(state.controlValues).toEqual({
      model: 'sonnet',
      mode: 'plan',
    })
    expect(state.summaryMetadata).toEqual({
      items: [
        { id: 'model', label: 'Model', value: 'sonnet', shortValue: 'sonnet', order: 10 },
        { id: 'mode', label: 'Mode', value: 'plan', shortValue: 'plan', order: 20 },
      ],
    })
  })

  it('merges ide provider-state summary metadata patches even without control values', () => {
    const instance = new IdeProviderInstance({
      type: 'cursor',
      name: 'Cursor',
      category: 'ide',
    } as any) as any

    instance.cachedChat = {
      id: 'chat-1',
      title: 'Cursor',
      status: 'idle',
      messages: [],
      controlValues: { model: 'sonnet' },
    }

    instance.onEvent('provider_state_patch', {
      summaryMetadata: {
        items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
      },
    })

    const state = instance.getState() as any
    expect(state.controlValues).toEqual({ model: 'sonnet' })
    expect(state.summaryMetadata).toEqual({
      items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
    })
  })

  it('filters inferred tool messages from readChat when showToolCalls is disabled', async () => {
    const instance = new IdeProviderInstance({
      type: 'cursor',
      name: 'Cursor',
      category: 'ide',
      scripts: {
        readChat: () => '(() => "ignored")()',
      },
    } as any) as any

    instance.context = {
      cdp: {
        isConnected: true,
        evaluate: async () => ({
          id: 'chat-1',
          status: 'idle',
          title: 'Cursor',
          messages: [
            { role: 'assistant', content: 'Search files', _sub: 'tool' },
            { role: 'assistant', content: 'Final answer' },
          ],
          inputContent: '',
        }),
      },
    }
    instance.settings = { showToolCalls: false }

    await instance.readChat()

    expect(instance.getState().activeChat.messages).toEqual([
      expect.objectContaining({ kind: 'standard', content: 'Final answer' }),
    ])
  })

  it('surfaces providerSessionId from extension stream updates', () => {
    const instance = new ExtensionProviderInstance({
      type: 'codex',
      name: 'Codex',
      category: 'extension',
    } as any)

    instance.onEvent('stream_update', {
      providerSessionId: 'provider-session-1',
      title: 'Codex',
      status: 'idle',
      messages: [{ role: 'assistant', content: 'done' }],
    })

    const state = instance.getState() as any
    expect(state.providerSessionId).toBe('provider-session-1')
    expect(state.activeChat?.id).toBe('provider-session-1')
  })
})
