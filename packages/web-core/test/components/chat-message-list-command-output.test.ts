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
    }),
  )
}

describe('ChatMessageList command output rendering', () => {
  it('does not collapse tool messages to the first 80 characters of the first line', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        kind: 'tool',
        content: ['tool first line', 'command second line', 'TAIL_COMMAND_MARKER_VISIBLE'].join('\n'),
      } as ChatMessage,
    ])

    expect(html).toContain('tool first line')
    expect(html).toContain('TAIL_COMMAND_MARKER_VISIBLE')
  })
})
