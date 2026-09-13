import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import ChatMessageList, { buildChatMessageStableKeys } from '../../src/components/ChatMessageList'
import { readChatActivityVisiblePreference } from '../../src/components/dashboard/chat-activity-visibility'

/**
 * kind:'tool' rows must produce a tool bubble whenever activity is shown.
 *
 * Live claude-cli native-turn messages reach ChatMessageList.props.messages
 * with kind:'tool', plaintext content, a shared `_turnKey`, and a per-message
 * `sequence` — and no visibility stamp. Tool rows are ACTIVITY-classified and
 * ride the Activity toggle, which DEFAULTS ON
 * (`readChatActivityVisiblePreference`), so the user still sees them without
 * opting in. These tests pass the flag explicitly because the prop default
 * stays `false` for read-only hosts that have no toggle (SessionShare).
 *
 * Injection: allowing only kind==='standard' into ChatMessageRow, or dropping
 * tool from the activity merge, empties every assertion below.
 */
function renderMessages(messages: ChatMessage[], showActivityMessages = true): string {
  return renderToStaticMarkup(
    React.createElement(ChatMessageList, {
      messages,
      actionLogs: [],
      agentName: 'Claude',
      userName: 'You',
      contextKey: 'test',
      showActivityMessages,
    }),
  )
}

const TURN_KEY = 'claude-cli:native-turn:019e71fb-3cd1-76f1-9500-a7977eb2b374:0'

function liveShapeMessages(): ChatMessage[] {
  return [
    {
      role: 'user',
      kind: 'standard',
      content: 'open the page',
      receivedAt: 1,
      bubbleState: 'final',
      _turnKey: TURN_KEY,
      sequence: 0,
    },
    {
      role: 'assistant',
      kind: 'tool',
      content: '↘ Navigated to http://localhost:8975/gh.html Tab Context',
      receivedAt: 2,
      bubbleState: 'final',
      _turnKey: TURN_KEY,
      sequence: 1,
    },
    {
      role: 'assistant',
      kind: 'tool',
      content: '↘ Read src/index.ts',
      receivedAt: 3,
      bubbleState: 'final',
      _turnKey: TURN_KEY,
      sequence: 2,
    },
    {
      role: 'assistant',
      kind: 'standard',
      content: 'The page is open.',
      receivedAt: 4,
      bubbleState: 'final',
      _turnKey: TURN_KEY,
      sequence: 3,
    },
  ] as ChatMessage[]
}

describe('ChatMessageList — kind:tool default-transcript render', () => {
  it('creates a tool bubble DOM node for kind:tool with no visibility stamp', () => {
    const html = renderMessages(liveShapeMessages())

    const toolBubbles = html.split('aria-label="Tool message"').length - 1
    const userRows = html.split('chat-message-row-user').length - 1
    const assistantRows = html.split('chat-message-row-assistant').length - 1

    expect(toolBubbles, 'kind:tool rows must mount as .chat-msg-tool bubbles').toBe(2)
    expect(userRows + assistantRows, 'standard user+assistant rows still mount as .chat-message-row').toBe(2)
    expect(html).toContain('Navigated to http://localhost:8975/gh.html')
    expect(html).toContain('Read src/index.ts')
    expect(html).toContain('The page is open.')
    expect(html).toContain('open the page')
  })

  it('keys shared native-turn _turnKey siblings by _turnKey+sequence, not _turnKey alone', () => {
    const messages = liveShapeMessages()
    const keys = buildChatMessageStableKeys(messages)

    expect(new Set(keys).size).toBe(messages.length)
    expect(keys).toEqual([
      `turn:${TURN_KEY}|seq:0`,
      `turn:${TURN_KEY}|seq:1`,
      `turn:${TURN_KEY}|seq:2`,
      `turn:${TURN_KEY}|seq:3`,
    ])
  })

  it('folds a long plaintext tool body and offers the existing expand control', () => {
    const longBody = `↘ ${'Tab Context line\n'.repeat(80)}TAIL_MARKER`
    expect(longBody.length).toBeGreaterThan(600)

    const html = renderMessages([
      {
        role: 'assistant',
        kind: 'tool',
        content: longBody,
        bubbleState: 'final',
        _turnKey: TURN_KEY,
        sequence: 7,
      } as ChatMessage,
    ])

    expect(html).toContain('chat-msg-tool')
    expect(html).toContain('Show full output')
    expect(html).not.toContain('TAIL_MARKER')
  })

  /**
   * The pair of invariants the toggle realignment has to hold, asserted
   * together because either one alone can be satisfied by the wrong design:
   * "tool always visible" passes #1 but breaks #2 (the toggle does nothing),
   * and "tool behind a default-OFF toggle" passes #2 but breaks #1 (the live
   * regression — tool rows hidden from everyone by default).
   */
  it('renders tool bubbles at the DEFAULT preference, and hides them only on explicit opt-out', () => {
    const messages = [
      { role: 'user', kind: 'standard', content: 'do the thing', receivedAt: 1, sequence: 0 } as ChatMessage,
      { role: 'assistant', kind: 'tool', content: '↘ ran the thing', receivedAt: 2, sequence: 1 } as ChatMessage,
    ]

    // #1 — the unset preference is what a new user gets. Read it through the
    // real accessor rather than hardcoding `true`, so a flipped default fails
    // here instead of silently passing a literal.
    const defaultPreference = readChatActivityVisiblePreference({ getItem: () => null })
    expect(defaultPreference).toBe(true)
    const shownByDefault = renderMessages(messages, defaultPreference)
    expect(shownByDefault).toContain('chat-msg-tool')
    expect(shownByDefault).toContain('ran the thing')

    // #2 — turning it off yields a pure conversation view.
    const optedOut = renderMessages(messages, readChatActivityVisiblePreference({ getItem: () => '0' }))
    expect(optedOut).not.toContain('chat-msg-tool')
    expect(optedOut).not.toContain('ran the thing')
    expect(optedOut).toContain('do the thing')
  })
})
