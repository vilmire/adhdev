import { describe, expect, it } from 'vitest'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import {
  getDashboardActiveTabHref,
  getDashboardActiveTabKeyForConversation,
  resolveDashboardSessionTargetFromEntry,
} from '../../src/utils/dashboard-route-paths'

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
    title: 'Repo',
    messages: [],
    hostIdeType: 'cursor',
    workspaceName: 'repo',
    displayPrimary: 'Repo',
    displaySecondary: 'Cursor · Codex',
    streamSource: 'native',
    tabKey: 'tab-1',
    ...overrides,
  }
}

describe('dashboard route paths', () => {
  it('builds a dashboard activeTab href instead of pointing at the landing page root', () => {
    expect(getDashboardActiveTabHref('fcf8c522-e914-44fd-bad1-51aadf403a01')).toBe(
      '/dashboard?activeTab=fcf8c522-e914-44fd-bad1-51aadf403a01',
    )
  })

  it('encodes activeTab values safely for URLs', () => {
    expect(getDashboardActiveTabHref('session with spaces/and?symbols')).toBe(
      '/dashboard?activeTab=session%20with%20spaces%2Fand%3Fsymbols',
    )
  })

  it('prefers providerSessionId when building dashboard activeTab keys from conversations', () => {
    expect(getDashboardActiveTabKeyForConversation(createConversation())).toBe('provider-1')
    expect(getDashboardActiveTabKeyForConversation(createConversation({ providerSessionId: undefined }))).toBe('runtime-1')
  })

  it('resolves route-only launch entries through the preferred dashboard conversation', () => {
    const nativeConversation = createConversation({
      sessionId: 'native-1',
      providerSessionId: undefined,
      streamSource: 'native',
      tabKey: 'native-tab',
    })
    const preferredConversation = createConversation({
      sessionId: 'agent-1',
      providerSessionId: 'provider-agent',
      streamSource: 'agent-stream',
      tabKey: 'agent-tab',
    })
    const siblingConversation = createConversation({
      sessionId: 'agent-2',
      providerSessionId: 'provider-sibling',
      streamSource: 'agent-stream',
      tabKey: 'sibling-tab',
    })

    expect(resolveDashboardSessionTargetFromEntry({
      entryRouteId: 'machine-1:ide:cursor-1',
      conversations: [nativeConversation, preferredConversation, siblingConversation],
    })).toBe('native-1')
  })
})