import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@adhdev/daemon-core'
import ChatMessageList, { buildChatMessageStableKeys } from '../../src/components/ChatMessageList'

/**
 * kind:'tool' rows must produce a tool bubble in the DEFAULT transcript
 * (Activity toggle off). Live claude-cli native-turn messages reach
 * ChatMessageList.props.messages with kind:'tool', plaintext content, a shared
 * `_turnKey`, and a per-message `sequence` — and no visibility stamp.
 *
 * Injection: classifying those rows as activity (or allowing only
 * kind==='standard' into ChatMessageRow) drops every tool bubble from DOM.
 */
function renderMessages(messages: ChatMessage[]): string {
  return renderToStaticMarkup(
    React.createElement(ChatMessageList, {
      messages,
      actionLogs: [],
      agentName: 'Claude',
      userName: 'You',
      contextKey: 'test',
      // Default: activity opt-in OFF. Tools must still render.
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
})
