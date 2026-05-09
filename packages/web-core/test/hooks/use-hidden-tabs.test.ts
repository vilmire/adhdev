import { describe, expect, it } from 'vitest'
import {
  getAutoHiddenConversationTargets,
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

  it('selects mesh-spawned hidden policy sessions for one-time auto-hide without re-hiding manually shown sessions', () => {
    const hiddenMeshConversation = {
      providerSessionId: 'provider-hidden',
      sessionId: 'runtime-hidden',
      tabKey: 'tab-hidden',
      routeId: 'machine-1:runtime-hidden',
      settings: {
        launchedByCoordinator: true,
        meshNodeFor: 'mesh-1',
        spawnedSessionVisibility: 'hidden',
      },
    }
    const visibleMeshConversation = {
      providerSessionId: 'provider-visible',
      sessionId: 'runtime-visible',
      tabKey: 'tab-visible',
      routeId: 'machine-1:runtime-visible',
      settings: {
        launchedByCoordinator: true,
        meshNodeFor: 'mesh-1',
        spawnedSessionVisibility: 'visible',
      },
    }

    expect(getAutoHiddenConversationTargets([
      hiddenMeshConversation,
      visibleMeshConversation,
    ], new Set())).toEqual([hiddenMeshConversation])
    expect(getAutoHiddenConversationTargets([hiddenMeshConversation], new Set(['provider:provider-hidden']))).toEqual([])
    expect(getAutoHiddenConversationTargets([hiddenMeshConversation], new Set(), new Set(['provider:provider-hidden']))).toEqual([])
  })
})
