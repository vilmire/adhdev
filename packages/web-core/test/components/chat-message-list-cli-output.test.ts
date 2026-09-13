import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import ChatMessageList from '../../src/components/ChatMessageList'

function renderMessages(messages: ChatMessage[], showActivityMessages = true): string {
  return renderToStaticMarkup(
    React.createElement(ChatMessageList, {
      messages,
      actionLogs: [],
      agentName: 'Hermes Agent',
      contextKey: 'test',
      isCliMode: true,
      showActivityMessages,
    }),
  )
}

describe('ChatMessageList CLI assistant rendering', () => {
  it('shows tool AND terminal rows together when activity is on, prose only when off', () => {
    // Tool and terminal are both activity-classified, so they share one switch.
    // The older expectation (tool visible WHILE terminal hidden) described the
    // interim design where tool was unconditionally chat-class; it is no longer
    // reachable, and asserting it would re-pin the toggle-defeating behaviour.
    const messages = [
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
    ]

    const on = renderMessages(messages, true)
    expect(on).toContain('chat-msg-tool')
    expect(on).toContain('⚡ mcp_adhdev_mesh_mesh_git_status (0.0s)')
    expect(on).toContain('Ran command')
    expect(on).toContain('최종 cleanup 요약입니다.')

    const off = renderMessages(messages, false)
    expect(off).not.toContain('chat-msg-tool')
    expect(off).not.toContain('⚡ mcp_adhdev_mesh_mesh_git_status (0.0s)')
    expect(off).not.toContain('Ran command')
    expect(off).toContain('최종 cleanup 요약입니다.')
  })

  it('allows explicit chat-visible tool messages for provider-authored UI content', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        kind: 'tool',
        content: 'Visible tool summary',
        meta: { transcriptVisibility: 'visible' },
      } as ChatMessage,
    ])

    expect(html).toContain('Visible tool summary')
  })

  it('keeps semantically internal runtime activity out of the prose transcript', () => {
    // Asserted with activity OFF, which is what "the prose transcript" means.
    // This row carries source:'runtime_activity', so it is activity-classified
    // even though it is also stamped internal — `explicitHidden` deliberately
    // routes activity-LIKE hidden rows to the activity surface rather than
    // burying them, so that opting into activity still shows what the agent
    // did. It must never appear in the conversation-only view.
    const html = renderMessages([
      {
        role: 'assistant',
        kind: 'standard',
        content: 'INTERNAL_RUNTIME_STATUS_SHOULD_NOT_RENDER',
        meta: { transcriptVisibility: 'internal', audience: 'debug', source: 'runtime_activity', isInternal: true },
      } as ChatMessage,
      {
        role: 'assistant',
        content: '사용자에게 보이는 최종 답변',
      } as ChatMessage,
    ], false)

    expect(html).not.toContain('INTERNAL_RUNTIME_STATUS_SHOULD_NOT_RENDER')
    expect(html).toContain('사용자에게 보이는 최종 답변')
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
