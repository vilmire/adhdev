import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import ChatMessageList from '../../src/components/ChatMessageList'

/**
 * Activity supply wiring, lane ④ — empty-state feedback.
 *
 * With the toggle ON and zero activity rows in the transcript, the pane used
 * to render exactly what toggle-OFF rendered, which the owner read as "the
 * toggle is broken". The note ("no activity to show") is the disambiguation:
 * data arrived, there is just nothing in the activity class.
 */
function render(messages: ChatMessage[], showActivityMessages: boolean): string {
  return renderToStaticMarkup(
    React.createElement(ChatMessageList, {
      messages,
      actionLogs: [],
      agentName: 'Hermes Agent',
      contextKey: 'test',
      showActivityMessages,
    }),
  )
}

const PROSE_ONLY: ChatMessage[] = [
  { role: 'user', kind: 'standard', content: 'hello' } as ChatMessage,
  { role: 'assistant', kind: 'standard', content: 'world' } as ChatMessage,
]

const WITH_ACTIVITY: ChatMessage[] = [
  ...PROSE_ONLY,
  { role: 'assistant', kind: 'tool', content: 'Read(file.ts)' } as ChatMessage,
]

describe('ChatMessageList — activity empty-state note', () => {
  it('shows the note when the toggle is ON and the transcript has no activity rows', () => {
    const html = render(PROSE_ONLY, true)
    expect(html).toContain('data-testid="chat-activity-empty-note"')
  })

  it('does not show the note when activity rows exist (they render instead)', () => {
    const html = render(WITH_ACTIVITY, true)
    expect(html).not.toContain('data-testid="chat-activity-empty-note"')
    expect(html).toContain('Read(file.ts)')
  })

  it('does not show the note when the toggle is OFF (activity rows are filtered, no note either)', () => {
    const offHtml = render(WITH_ACTIVITY, false)
    expect(offHtml).not.toContain('data-testid="chat-activity-empty-note"')
    expect(offHtml).not.toContain('Read(file.ts)')
  })

  it('does not show the note over the global empty state (no messages at all)', () => {
    const html = render([], true)
    expect(html).not.toContain('data-testid="chat-activity-empty-note"')
  })
})
