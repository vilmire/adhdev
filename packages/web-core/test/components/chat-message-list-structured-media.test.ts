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
      userName: 'Operator',
      contextKey: 'structured-media-test',
    }),
  )
}

describe('ChatMessageList structured media rendering', () => {
  it('renders image and audio parts visibly with fallbacks/transcripts', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', alt: 'Architecture diagram' },
          { type: 'audio', mimeType: 'audio/mpeg', uri: 'file:///tmp/briefing.mp3', transcript: 'Audio transcript text' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('<img')
    expect(html).toContain('alt="Architecture diagram"')
    expect(html).toContain('<audio')
    expect(html).toContain('controls=""')
    expect(html).toContain('briefing.mp3')
    expect(html).toContain('Audio transcript text')
  })

  it('renders video controls when a source exists and visible description text', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'video', mimeType: 'video/mp4', uri: 'file:///tmp/demo.mp4', transcript: 'Video walkthrough transcript' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('<video')
    expect(html).toContain('controls=""')
    expect(html).toContain('demo.mp4')
    expect(html).toContain('Video walkthrough transcript')
  })

  it('renders a visible video placeholder when no video source exists', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'video', mimeType: 'video/mp4', transcript: 'No-source transcript' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('Video')
    expect(html).toContain('video')
    expect(html).toContain('No-source transcript')
    expect(html).not.toContain('<video')
  })

  it('renders resource links as non-blank clickable/downloadable labels with details', () => {
    const html = renderMessages([
      {
        role: 'user',
        content: [
          {
            type: 'resource_link',
            uri: 'file:///tmp/spec.md',
            name: 'spec.md',
            title: 'Project spec',
            description: 'Design document',
            mimeType: 'text/markdown',
          },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('<a')
    expect(html).toContain('href="file:///tmp/spec.md"')
    expect(html).toContain('download=""')
    expect(html).toContain('Project spec')
    expect(html).toContain('Design document')
    expect(html).toContain('text/markdown')
  })

  it('renders structured system/user/assistant media messages visibly and never blank', () => {
    const html = renderMessages([
      {
        role: 'system',
        kind: 'system',
        content: [
          { type: 'resource_link', name: 'Untitled artifact', description: 'System-visible artifact without URI' },
        ],
      } as ChatMessage,
      {
        role: 'user',
        content: [
          { type: 'image', mimeType: 'image/png', alt: 'Clipboard screenshot' },
        ],
      } as ChatMessage,
      {
        role: 'assistant',
        content: [
          { type: 'audio', mimeType: 'audio/wav', transcript: 'Assistant audio summary' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('Untitled artifact')
    expect(html).toContain('System-visible artifact without URI')
    expect(html).toContain('Clipboard screenshot')
    expect(html).toContain('Assistant audio summary')
    expect(html).toContain('chat-msg-system')
    expect(html).toContain('chat-message-row-user')
    expect(html).toContain('chat-message-row-assistant')
  })
})
