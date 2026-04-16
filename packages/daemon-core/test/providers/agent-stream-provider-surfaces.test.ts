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
      messages: [
        { role: 'assistant', content: 'npm test', _sub: 'command' },
        { role: 'assistant', content: 'Search files', _sub: 'tool' },
      ],
      inputContent: '',
    }))

    expect((state.messages as any[]).map((message) => message.kind)).toEqual(['terminal', 'tool'])
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
})
