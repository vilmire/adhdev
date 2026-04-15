import { describe, expect, it } from 'vitest'
import { normalizeProviderStateControlValues } from '../../src/providers/provider-patch-state.js'

describe('normalizeProviderStateControlValues', () => {
  it('returns undefined for empty control maps', () => {
    expect(normalizeProviderStateControlValues({})).toBeUndefined()
  })

  it('preserves populated control maps', () => {
    expect(normalizeProviderStateControlValues({ model: 'sonnet', mode: 'plan' })).toEqual({
      model: 'sonnet',
      mode: 'plan',
    })
  })
})
