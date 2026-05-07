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
  it('hides internal coordinator tool and terminal activity from the visible chat transcript', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        kind: 'tool',
        content: '⚡ mcp_adhdev_mesh_mesh_git_status (0.0s)',
      } as ChatMessage,
      {
        role: 'assistant',
        kind: 'terminal',
        content: 'mcp_adhdev_mesh_mesh_git_status output',
        meta: { label: 'Ran command' },
      } as ChatMessage,
      {
        role: 'assistant',
        content: '최종 cleanup 요약입니다.',
      } as ChatMessage,
    ])

    expect(html).not.toContain('mcp_adhdev_mesh_mesh_git_status')
    expect(html).not.toContain('Ran command')
    expect(html).toContain('최종 cleanup 요약입니다.')
  })

  it('allows explicit chat-visible tool messages for provider-authored UI content', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        kind: 'tool',
        content: 'Visible tool summary',
        meta: { visibility: 'chat' },
      } as ChatMessage,
    ])

    expect(html).toContain('Visible tool summary')
  })

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

  it('renders numeric ranges with single tildes literally instead of strikethrough', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: '- daemon CPU 4~11%, session-host 0~2%',
      } as ChatMessage,
    ])

    expect(html).toContain('4~11%')
    expect(html).toContain('0~2%')
    expect(html).not.toContain('<del>')
  })
})
