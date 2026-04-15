import { describe, expect, it } from 'vitest'
import { mergeProviderPatchState, resolveProviderStateSurface } from '../../src/providers/provider-patch-state.js'

describe('provider patch compat inputs', () => {
  it('still accepts legacy model/mode patch inputs even though the public contract prefers controlValues', () => {
    const patched = mergeProviderPatchState({
      data: { model: 'sonnet', mode: 'plan' },
    })

    expect(resolveProviderStateSurface({
      controlValues: patched.controlValues,
      summaryMetadata: patched.summaryMetadata,
    })).toEqual({
      controlValues: { model: 'sonnet', mode: 'plan' },
      summaryMetadata: {
        items: [
          { id: 'model', label: 'Model', value: 'sonnet', shortValue: 'sonnet', order: 10 },
          { id: 'mode', label: 'Mode', value: 'plan', shortValue: 'plan', order: 20 },
        ],
      },
    })
  })
})
