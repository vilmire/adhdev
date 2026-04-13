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
      agentName: 'Agent',
      contextKey: 'test',
    }),
  )
}

describe('ChatMessageList structured content rendering', () => {
  it('renders image, audio, video, and resource links from message parts', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'See attached media.' },
          { type: 'image', mimeType: 'image/png', uri: 'file:///tmp/example.png' },
          { type: 'audio', mimeType: 'audio/mpeg', uri: 'file:///tmp/example.mp3' },
          { type: 'video', mimeType: 'video/mp4', uri: 'file:///tmp/example.mp4', posterUri: 'file:///tmp/example.jpg' },
          { type: 'resource_link', uri: 'file:///tmp/spec.md', name: 'spec.md', mimeType: 'text/markdown' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('See attached media.')
    expect(html).toContain('<img')
    expect(html).toContain('file:///tmp/example.png')
    expect(html).toContain('<audio')
    expect(html).toContain('file:///tmp/example.mp3')
    expect(html).toContain('file:///tmp/example.mp4')
    expect(html).toContain('spec.md')
  })

  it('renders embedded text resources inline', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource', resource: { uri: 'file:///tmp/notes.txt', text: 'embedded notes' } },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('embedded notes')
    expect(html).toContain('notes.txt')
  })

  it('renders structured system messages instead of collapsing them to blank text', () => {
    const html = renderMessages([
      {
        role: 'system',
        kind: 'system',
        content: [
          { type: 'resource_link', uri: 'file:///tmp/review.md', name: 'review.md' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('review.md')
    expect(html).toContain('file:///tmp/review.md')
  })
})
