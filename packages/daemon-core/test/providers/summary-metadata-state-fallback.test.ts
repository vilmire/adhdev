import { describe, expect, it } from 'vitest'
import { resolveProviderStateSummaryMetadata } from '../../src/providers/summary-metadata.js'

describe('resolveProviderStateSummaryMetadata', () => {
  it('prefers explicit summary metadata when present', () => {
    expect(resolveProviderStateSummaryMetadata({
      summaryMetadata: {
        items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
      },
      controlValues: { model: 'sonnet', mode: 'plan' },
    })).toEqual({
      items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
    })
  })

  it('falls back to legacy model/mode summary from control values', () => {
    expect(resolveProviderStateSummaryMetadata({
      controlValues: { model: 'sonnet', mode: 'plan' },
    })).toEqual({
      items: [
        { id: 'model', label: 'Model', value: 'sonnet', shortValue: 'sonnet', order: 10 },
        { id: 'mode', label: 'Mode', value: 'plan', shortValue: 'plan', order: 20 },
      ],
    })
  })
})
