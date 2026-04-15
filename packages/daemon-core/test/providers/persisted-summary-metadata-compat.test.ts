import { describe, expect, it } from 'vitest'
import { normalizePersistedSummaryMetadata } from '../../src/providers/summary-metadata.js'

describe('normalizePersistedSummaryMetadata', () => {
  it('prefers explicit summary metadata and ignores legacy currentModel fallback', () => {
    expect(normalizePersistedSummaryMetadata({
      summaryMetadata: {
        items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
      },
      legacyModel: 'gpt-5.4',
    })).toEqual({
      items: [{ id: 'profile', label: 'Profile', value: 'reasoning', order: 5 }],
    })
  })

  it('does not upgrade legacy currentModel when explicit summary is absent', () => {
    expect(normalizePersistedSummaryMetadata({ legacyModel: 'gpt-5.4' })).toBeUndefined()
  })
})
