import { describe, expect, it } from 'vitest'
import { resolveProviderStateSurface } from '../../src/providers/provider-patch-state.js'

describe('resolveProviderStateSurface', () => {
  it('normalizes empty control values to undefined while preserving explicit summary metadata', () => {
    expect(resolveProviderStateSurface({
      controlValues: {},
      summaryMetadata: {
        items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
      },
    })).toEqual({
      controlValues: undefined,
      summaryMetadata: {
        items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
      },
    })
  })

  it('derives fallback summary metadata from control values with optional labels', () => {
    expect(resolveProviderStateSurface({
      controlValues: { model: 'sonnet', mode: 'plan' },
      modelLabel: 'Claude Sonnet 4',
      modeLabel: 'Plan Mode',
    })).toEqual({
      controlValues: { model: 'sonnet', mode: 'plan' },
      summaryMetadata: {
        items: [
          { id: 'model', label: 'Model', value: 'Claude Sonnet 4', shortValue: 'sonnet', order: 10 },
          { id: 'mode', label: 'Mode', value: 'Plan Mode', shortValue: 'plan', order: 20 },
        ],
      },
    })
  })
})
