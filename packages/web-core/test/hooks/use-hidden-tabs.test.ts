import { describe, expect, it } from 'vitest'
import {
  getHiddenConversationStorageKey,
  isConversationHidden,
} from '../../src/hooks/useHiddenTabs'

describe('useHiddenTabs helpers', () => {
  it('prefers stable provider session identity over runtime tab identity for storage', () => {
    expect(getHiddenConversationStorageKey({
      providerSessionId: 'provider-1',
      sessionId: 'runtime-a',
      tabKey: 'tab-a',
      routeId: 'machine-1:ide:cursor-1',
    })).toBe('provider:provider-1')
  })

  it('keeps a conversation hidden after runtime session and tab churn when provider identity is stable', () => {
    const hiddenKeys = new Set(['provider:provider-1'])

    expect(isConversationHidden(hiddenKeys, {
      providerSessionId: 'provider-1',
      sessionId: 'runtime-b',
      tabKey: 'tab-b',
      routeId: 'machine-1:ide:cursor-1',
    })).toBe(true)
  })
})
