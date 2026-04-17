import { describe, expect, it } from 'vitest'
import {
  buildConversationIdentity,
  buildConversationLookupKeys,
  buildConversationTargetKey,
  conversationMatchesTarget,
  getConversationHistorySessionId,
  getConversationHistoryLookupIds,
} from '../../../src/components/dashboard/conversation-identity'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'machine-1:ide:cursor-1',
    sessionId: 'runtime-1',
    providerSessionId: 'provider-1',
    nativeSessionId: 'runtime-1',
    transport: 'cdp-page',
    daemonId: 'machine-1',
    agentName: 'Codex',
    agentType: 'codex',
    status: 'idle',
    title: '',
    messages: [],
    hostIdeType: 'cursor',
    workspaceName: 'repo',
    displayPrimary: 'repo',
    displaySecondary: 'Cursor · Codex',
    streamSource: 'native',
    tabKey: 'tab-1',
    machineName: 'Studio Mac',
    connectionState: 'connected',
    ...overrides,
  }
}

describe('conversation identity contract sketch', () => {
  it('prefers provider session ids for canonical and history identity', () => {
    const identity = buildConversationIdentity(createConversation())

    expect(identity.canonicalKey).toBe('provider:provider-1')
    expect(identity.historySessionId).toBe('provider-1')
    expect(identity.runtimeSessionId).toBe('runtime-1')
    expect(identity.targetKey).toBe('provider:provider-1')
    expect(identity.allKeys).toEqual([
      'provider:provider-1',
      'session:runtime-1',
      'tab:tab-1',
      'route:machine-1:ide:cursor-1',
    ])
  })

  it('falls back from provider session to runtime session to tab key to route id', () => {
    expect(buildConversationIdentity(createConversation({ providerSessionId: undefined })).canonicalKey).toBe('session:runtime-1')
    expect(buildConversationIdentity(createConversation({ providerSessionId: undefined, sessionId: undefined })).canonicalKey).toBe('tab:tab-1')
    expect(buildConversationIdentity(createConversation({ providerSessionId: undefined, sessionId: undefined, tabKey: '' })).canonicalKey).toBe('route:machine-1:ide:cursor-1')
  })

  it('builds stable target keys from notification/open-target payloads', () => {
    expect(buildConversationTargetKey({ providerSessionId: 'provider-1', sessionId: 'runtime-1', tabKey: 'tab-1' })).toBe('provider:provider-1')
    expect(buildConversationTargetKey({ sessionId: 'runtime-1', tabKey: 'tab-1' })).toBe('session:runtime-1')
    expect(buildConversationTargetKey({ tabKey: 'tab-1' })).toBe('tab:tab-1')
  })

  it('matches resumed conversations by provider session id even when runtime ids change', () => {
    const resumed = createConversation({ sessionId: 'runtime-2', providerSessionId: 'provider-1', tabKey: 'tab-2' })

    expect(conversationMatchesTarget(resumed, { providerSessionId: 'provider-1' })).toBe(true)
    expect(conversationMatchesTarget(resumed, { sessionId: 'runtime-1' })).toBe(false)
    expect(conversationMatchesTarget(resumed, { tabKey: 'tab-2' })).toBe(true)
  })

  it('reuses the same history session rule directly', () => {
    expect(getConversationHistorySessionId(createConversation())).toBe('provider-1')
    expect(getConversationHistorySessionId(createConversation({ providerSessionId: undefined }))).toBe('runtime-1')
  })

  it('builds raw and prefixed lookup aliases for conversation targeting', () => {
    expect(buildConversationLookupKeys(createConversation())).toEqual([
      'provider:provider-1',
      'provider-1',
      'session:runtime-1',
      'runtime-1',
      'tab:tab-1',
      'tab-1',
      'route:machine-1:ide:cursor-1',
      'machine-1:ide:cursor-1',
    ])
  })

  it('keeps both provider and runtime ids for history-style matching', () => {
    expect(getConversationHistoryLookupIds(createConversation())).toEqual(['provider-1', 'runtime-1'])
    expect(getConversationHistoryLookupIds(createConversation({ providerSessionId: undefined }))).toEqual(['runtime-1'])
  })

  it('matches raw route id targets through the same helper contract', () => {
    expect(conversationMatchesTarget(createConversation(), { routeId: 'machine-1:ide:cursor-1' })).toBe(true)
  })
})
