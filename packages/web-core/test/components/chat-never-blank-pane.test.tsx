import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ChatMessageList from '../../src/components/ChatMessageList'
import { buildVisibleConversationMessages } from '../../src/components/dashboard/conversation-message-snapshot'
import { buildEmptySnapshot } from '../../src/components/dashboard/session-chat-controller'

// Live defect (2026-10-29): Antigravity chat blank until "load earlier". Two causes.
describe('never a blank chat pane', () => {
  it('an empty snapshot does not claim more history, and the list renders the placeholder even if history may exist', () => {
    expect(buildEmptySnapshot().hasMoreHistory).toBe(false)
    const html = renderToStaticMarkup(React.createElement(ChatMessageList, {
      messages: [], actionLogs: [], hasMoreHistory: true,
      emptyState: React.createElement('div', { 'data-chat-pane-state': 'awaiting-first-view' }, 'loading'),
    } as any))
    expect(html).toContain('awaiting-first-view')
  })

  it('a tail of tool rows + an empty assistant row still yields a real bubble', () => {
    const live: any[] = [
      { role: 'user', kind: 'standard', content: 'please do it', receivedAt: 1 },
      { role: 'assistant', kind: 'standard', content: 'the real answer', receivedAt: 2 },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', kind: 'tool', content: `tool ${i}`, receivedAt: 3 + i })),
      { role: 'assistant', kind: 'standard', content: '', receivedAt: 20 },
    ]
    const visible = buildVisibleConversationMessages({ historyMessages: [], liveMessages: live, visibleLiveCount: 7 })
    expect(visible.some((m: any) => m.content === 'the real answer')).toBe(true)
  })

  it('with only a user prompt hidden above tool rows, the prompt is pulled into the window', () => {
    const live: any[] = [
      { role: 'user', kind: 'standard', content: 'prompt', receivedAt: 1 },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', kind: 'tool', content: `t${i}`, receivedAt: 2 + i })),
    ]
    const visible = buildVisibleConversationMessages({ historyMessages: [], liveMessages: live, visibleLiveCount: 4 })
    expect(visible.some((m: any) => m.content === 'prompt')).toBe(true)
  })
})
