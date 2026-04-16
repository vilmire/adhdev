import { describe, expect, it, vi } from 'vitest'
import { ProviderStreamAdapter } from '../../src/agent-stream/provider-adapter.js'
import { forwardAgentStreamsToIdeInstance } from '../../src/agent-stream/forward.js'

describe('agent stream provider surfaces', () => {
  it('preserves explicit controlValues and summaryMetadata from readChat', async () => {
    const adapter = new ProviderStreamAdapter({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
      scripts: {
        readChat: () => '(() => "ignored")()',
      },
    } as any)

    const state = await adapter.readChat(async () => JSON.stringify({
      status: 'idle',
      messages: [],
      inputContent: '',
      controlValues: { model: 'sonnet', mode: 'plan' },
      summaryMetadata: {
        items: [
          { id: 'model', label: 'Model', value: 'Claude Sonnet 4', shortValue: 'sonnet', order: 10 },
          { id: 'mode', label: 'Mode', value: 'Plan Mode', shortValue: 'plan', order: 20 },
        ],
      },
    }))

    expect(state.controlValues).toEqual({ model: 'sonnet', mode: 'plan' })
    expect(state.summaryMetadata).toEqual({
      items: [
        { id: 'model', label: 'Model', value: 'Claude Sonnet 4', shortValue: 'sonnet', order: 10 },
        { id: 'mode', label: 'Mode', value: 'Plan Mode', shortValue: 'plan', order: 20 },
      ],
    })
  })

  it('normalizes richer message kinds from readChat payloads before forwarding stream state', async () => {
    const adapter = new ProviderStreamAdapter({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
      scripts: {
        readChat: () => '(() => "ignored")()',
      },
    } as any)

    const state = await adapter.readChat(async () => JSON.stringify({
      status: 'idle',
      providerSessionId: 'provider-1',
      messages: [
        { role: 'assistant', content: 'npm test', _sub: 'command', _turnKey: 'turn-1' },
        { role: 'assistant', content: 'Search files', _sub: 'tool', _turnKey: 'turn-2' },
      ],
      inputContent: '',
    }))

    expect(state.providerSessionId).toBe('provider-1')
    expect((state.messages as any[]).map((message) => ({ kind: message.kind, turnKey: message._turnKey }))).toEqual([
      { kind: 'terminal', turnKey: 'turn-1' },
      { kind: 'tool', turnKey: 'turn-2' },
    ])
  })

  it('forwards explicit controlValues and summaryMetadata to ide instances without legacy model/mode patch fields', () => {
    const onEvent = vi.fn()
    forwardAgentStreamsToIdeInstance(
      {
        getInstance: () => ({ onEvent, getExtensionTypes: () => ['cline'] }),
      },
      'cursor',
      [{
        agentType: 'cline',
        agentName: 'Cline',
        extensionId: 'cline.ext',
        status: 'idle',
        messages: [],
        inputContent: '',
        controlValues: { model: 'sonnet', mode: 'plan' },
        summaryMetadata: {
          items: [
            { id: 'model', value: 'Claude Sonnet 4', shortValue: 'sonnet', order: 10 },
          ],
        },
      }],
    )

    expect(onEvent).toHaveBeenCalledWith('stream_update', expect.objectContaining({
      extensionType: 'cline',
      controlValues: { model: 'sonnet', mode: 'plan' },
      summaryMetadata: {
        items: [
          { id: 'model', value: 'Claude Sonnet 4', shortValue: 'sonnet', order: 10 },
        ],
      },
    }))
    const payload = onEvent.mock.calls[0]?.[1]
    expect(payload).not.toHaveProperty('model')
    expect(payload).not.toHaveProperty('mode')
  })

  it('normalizes legacy openPanel success strings into a typed reveal result', async () => {
    const adapter = new ProviderStreamAdapter({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
      scripts: {
        openPanel: () => '(() => "visible")()',
      },
    } as any)

    await expect(adapter.openPanel!(async () => 'visible')).resolves.toEqual({
      opened: false,
      visible: true,
    })
    await expect(adapter.openPanel!(async () => JSON.stringify({ opened: true }))).resolves.toEqual({
      opened: true,
      visible: true,
    })
  })

  it('normalizes openPanel failures into a typed reveal result with explicit visibility=false', async () => {
    const adapter = new ProviderStreamAdapter({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
      scripts: {
        openPanel: () => '(() => "panel_hidden")()',
      },
    } as any)

    await expect(adapter.openPanel!(async () => 'panel_hidden')).resolves.toEqual({
      opened: false,
      visible: false,
    })
    await expect(adapter.openPanel!(async () => JSON.stringify({ opened: false, error: 'not found' }))).resolves.toEqual({
      opened: false,
      visible: false,
      error: 'not found',
    })
  })

  it('normalizes focusEditor results into an explicit typed focus result', async () => {
    const adapter = new ProviderStreamAdapter({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
      scripts: {
        focusEditor: () => '(() => "focused")()',
      },
    } as any)

    await expect(adapter.focusEditor!(async () => 'focused')).resolves.toEqual({ focused: true })
    await expect(adapter.focusEditor!(async () => JSON.stringify({ focused: false, error: 'input missing' }))).resolves.toEqual({
      focused: false,
      error: 'input missing',
    })
  })
})
