import { describe, expect, it } from 'vitest'
import {
  buildPersistedProviderEffectMessage,
  extractProviderControlValues,
  normalizeControlInvokeResult,
  normalizeControlListResult,
  normalizeControlSetResult,
  normalizeProviderEffects,
} from '../../src/providers/control-effects.js'

describe('control result normalization', () => {
  it('passes through typed list results', () => {
    expect(normalizeControlListResult({
      options: [
        { value: 'gpt-4.1', label: 'GPT-4.1' },
        { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      ],
      currentValue: 'gpt-4.1',
    })).toEqual({
      options: [
        { value: 'gpt-4.1', label: 'GPT-4.1' },
        { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      ],
      currentValue: 'gpt-4.1',
    })
  })

  it('rejects legacy list result shapes', () => {
    expect(() => normalizeControlListResult({ models: ['opus', 'sonnet'], current: 'opus' }))
      .toThrow('Provider control list results must use the typed shape')

    expect(() => normalizeControlListResult({ modes: [{ value: 'plan', name: 'Plan' }] }))
      .toThrow('Provider control list results must use the typed shape')
  })

  it('does not inject implicit model/mode control values without schema mapping', () => {
    expect(extractProviderControlValues([], { model: 'opus', mode: 'plan' })).toBeUndefined()

    expect(extractProviderControlValues([
      { id: 'model', type: 'select', label: 'Model', placement: 'bar', readFrom: 'model' },
      { id: 'mode', type: 'select', label: 'Mode', placement: 'bar', readFrom: 'mode' },
    ], { model: 'opus', mode: 'plan' })).toEqual({
      model: 'opus',
      mode: 'plan',
    })
  })

  it('requires typed set results', () => {
    expect(normalizeControlSetResult({ ok: true, currentValue: 'opus' })).toEqual({
      ok: true,
      currentValue: 'opus',
    })

    expect(() => normalizeControlSetResult({ success: true }))
      .toThrow('Provider control set results must use the typed shape')
  })

  it('requires typed invoke results', () => {
    expect(normalizeControlInvokeResult({ ok: true })).toEqual({ ok: true })
    expect(() => normalizeControlInvokeResult({ success: true, value: 'done' }))
      .toThrow('Provider control invoke results must use the typed shape')
  })

  it('normalizes provider effects into persisted richer chat messages without dropping semantic kinds', () => {
    const effects = normalizeProviderEffects({
      effects: [
        {
          type: 'message',
          message: {
            role: 'assistant',
            kind: 'terminal',
            senderName: 'Terminal',
            content: 'npm test',
          },
        },
        {
          type: 'notification',
          notification: {
            body: 'Tool finished',
            bubbleContent: 'create_file wrote README.md',
            bubbleKind: 'tool',
            bubbleRole: 'assistant',
            bubbleSenderName: 'Tool runner',
          },
        },
      ],
    })

    expect(buildPersistedProviderEffectMessage(effects[0] as any)).toMatchObject({
      role: 'assistant',
      kind: 'terminal',
      senderName: 'Terminal',
      content: 'npm test',
    })

    expect(buildPersistedProviderEffectMessage(effects[1] as any)).toMatchObject({
      role: 'assistant',
      kind: 'tool',
      senderName: 'Tool runner',
      content: 'create_file wrote README.md',
    })
  })

  it('defaults notification bubble persistence to a system chat message when semantic bubble metadata is omitted', () => {
    const effects = normalizeProviderEffects({
      effects: [{
        type: 'notification',
        notification: {
          title: 'Undo sent',
          body: 'Hermes undo was requested.',
          bubbleContent: 'Undo requested in Hermes.',
        },
      }],
    })

    expect(buildPersistedProviderEffectMessage(effects[0] as any)).toMatchObject({
      role: 'system',
      kind: 'system',
      senderName: 'System',
      content: 'Undo requested in Hermes.',
    })
  })
})
