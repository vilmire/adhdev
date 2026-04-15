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
      contextKey: 'test',
      isCliMode: true,
    }),
  )
}

describe('ChatMessageList CLI assistant rendering', () => {
  it('does not truncate standard assistant bubbles just because they are long', () => {
    const longMessage = `Intro\n${'x'.repeat(5200)}\nTAIL_MARKER_VISIBLE`

    const html = renderMessages([
      {
        role: 'assistant',
        content: longMessage,
      } as ChatMessage,
    ])

    expect(html).toContain('Intro')
    expect(html).toContain('TAIL_MARKER_VISIBLE')
    expect(html).not.toContain('Show more')
  })
})
