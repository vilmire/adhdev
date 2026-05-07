import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import ChatMessageList from '../../src/components/ChatMessageList'

function renderMessages(messages: ChatMessage[]): string {
  return renderToStaticMarkup(
    React.createElement(ChatMessageList, {
      messages,
      actionLogs: [],
      agentName: 'Hermes Agent',
      userName: 'Operator',
      contextKey: 'test',
    }),
  )
}

describe('ChatMessageList message polish structure', () => {
  it('keeps distinct role row classes for standard assistant and user bubbles', () => {
    const html = renderMessages([
      { role: 'assistant', content: 'Readable assistant response.' } as ChatMessage,
      { role: 'user', content: 'Follow-up from the user.' } as ChatMessage,
    ])

    expect(html).toContain('chat-message-row-assistant')
    expect(html).toContain('chat-message-row-user')
    expect(html).toContain('Hermes Agent')
    expect(html).toContain('Operator')
  })

  it('adds a stable tool label without changing explicit chat-visible tool content', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        kind: 'tool',
        content: 'Fetched workspace status.',
        meta: { visibility: 'chat' },
      } as ChatMessage,
    ])

    expect(html).toContain('chat-msg-tool-meta')
    expect(html).toContain('Tool')
    expect(html).toContain('Fetched workspace status.')
  })
})
