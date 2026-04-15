import { describe, expect, it } from 'vitest'
import { ExtensionProviderInstance } from '../../src/providers/extension-provider-instance.js'

describe('ExtensionProviderInstance summary metadata', () => {
  it('derives legacy summary metadata from model/mode updates without private duplicate state', () => {
    const instance = new ExtensionProviderInstance({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
    } as any)

    instance.onEvent('stream_update', {
      model: 'sonnet',
      mode: 'plan',
    })

    const state = instance.getState() as any
    expect(state.controlValues).toEqual({ model: 'sonnet', mode: 'plan' })
    expect(state.summaryMetadata).toEqual({
      items: [
        { id: 'model', label: 'Model', value: 'sonnet', shortValue: 'sonnet', order: 10 },
        { id: 'mode', label: 'Mode', value: 'plan', shortValue: 'plan', order: 20 },
      ],
    })
  })

  it('prefers explicit summary metadata over legacy model/mode fallback', () => {
    const instance = new ExtensionProviderInstance({
      type: 'cline',
      name: 'Cline',
      category: 'extension',
    } as any)

    instance.onEvent('provider_state_patch', {
      controlValues: { model: 'sonnet', mode: 'plan' },
      summaryMetadata: {
        items: [
          { id: 'profile', value: 'reasoning', label: 'Profile', order: 5 },
        ],
      },
    })

    const state = instance.getState() as any
    expect(state.controlValues).toEqual({ model: 'sonnet', mode: 'plan' })
    expect(state.summaryMetadata).toEqual({
      items: [
        { id: 'profile', value: 'reasoning', label: 'Profile', order: 5 },
      ],
    })
  })
})
