import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import ApprovalBanner from '../../../src/components/dashboard/ApprovalBanner'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function makeConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
  return {
    routeId: 'daemon-1:cli:session-1',
    sessionId: 'session-1',
    daemonId: 'daemon-1',
    transport: 'pty',
    mode: 'terminal',
    agentName: 'Claude Code',
    agentType: 'claude-cli',
    status: 'waiting_approval',
    title: 'Claude Code',
    messages: [],
    workspaceName: 'adhdev',
    displayPrimary: 'Claude Code',
    displaySecondary: 'Claude Code',
    streamSource: 'native',
    tabKey: 'daemon-1:cli:session-1',
    modalMessage: 'Do you want to proceed?',
    modalButtons: ['Yes', 'No'],
    ...overrides,
  } as ActiveConversation
}

describe('ApprovalBanner', () => {
  it('renders approval actions from the active session modal state', () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalBanner, { activeConv: makeConversation(), onModalButton: () => {} }),
    )

    expect(html).toContain('ACTION REQUIRED')
    expect(html).toContain('Do you want to proceed?')
    expect(html).toContain('Yes')
    expect(html).toContain('No')
  })

  it('does not render without modal buttons even when status is waiting_approval', () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalBanner, {
        activeConv: makeConversation({ modalButtons: undefined }),
        onModalButton: () => {},
      }),
    )

    expect(html).toBe('')
  })
})
