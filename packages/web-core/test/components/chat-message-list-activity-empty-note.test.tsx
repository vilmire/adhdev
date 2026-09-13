import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import ChatMessageList from '../../src/components/ChatMessageList'

/**
 * Activity supply wiring, lane ④ — the empty-state note is REMOVED.
 *
 * The note ("no activity to show") once disambiguated a toggle-ON transcript
 * with zero activity rows from a broken toggle. That reading stopped holding
 * when `kind:'tool'` moved from the activity class to the chat class: tool rows
 * now render as ordinary chat bubbles, so `activityMessageCount` is zero for
 * almost every CLI session and the note became permanent furniture at the
 * bottom of the pane rather than a signal. Owner called it UX noise; the note
 * was removed rather than re-scoped.
 *
 * This file now guards the removal — a re-introduced note would be a
 * regression, not a fix. The toggle's real behaviour (activity rows appear ON,
 * are filtered OFF) is asserted alongside it, so deleting the note cannot
 * quietly take the toggle's coverage with it.
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
  { role: 'assistant', kind: 'thought', content: 'pondering the next step' } as ChatMessage,
]

describe('ChatMessageList — activity empty-state note (removed)', () => {
  it('renders NO note when the toggle is ON and the transcript has no activity rows', () => {
    // The case that made the note permanent furniture: toggle ON, zero
    // activity rows — now the overwhelmingly common one, since tool bubbles
    // are chat-class.
    const html = render(PROSE_ONLY, true)
    expect(html).not.toContain('data-testid="chat-activity-empty-note"')
    // The transcript itself must still render — removing the note must not
    // take the prose with it.
    expect(html).toContain('world')
  })

  it('renders no note when activity rows exist, and shows those rows', () => {
    const html = render(WITH_ACTIVITY, true)
    expect(html).not.toContain('data-testid="chat-activity-empty-note"')
    expect(html).toContain('pondering the next step')
  })

  it('renders no note when the toggle is OFF, and filters activity rows out', () => {
    const offHtml = render(WITH_ACTIVITY, false)
    expect(offHtml).not.toContain('data-testid="chat-activity-empty-note"')
    expect(offHtml).not.toContain('pondering the next step')
  })

  it('renders no note over the global empty state (no messages at all)', () => {
    const html = render([], true)
    expect(html).not.toContain('data-testid="chat-activity-empty-note"')
  })
})
