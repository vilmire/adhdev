// (G8-7) resource_link / resource URIs must be scheme-validated before being
// rendered as an anchor `href`. Untrusted agent/tool output could otherwise
// smuggle a `javascript:` URI that executes on click. This is an allow-list
// (http/https/mailto), never a deny-list — asserted both directions: unsafe
// schemes must be rejected (no anchor at all), safe ones must still render.
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
      contextKey: 'resource-link-scheme-test',
    }),
  )
}

describe('resource_link URI scheme validation', () => {
  it('rejects a javascript: URI on a resource_link part — no anchor is rendered', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource_link', uri: "javascript:alert(document.cookie)", title: 'Malicious link' },
        ],
      } as ChatMessage,
    ])

    expect(html).not.toContain('javascript:')
    expect(html).not.toMatch(/<a\s[^>]*href/)
  })

  it('rejects a javascript: URI on a resource part with a uri (no text) — no anchor is rendered', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource', resource: { uri: "javascript:alert(1)" } },
        ],
      } as ChatMessage,
    ])

    expect(html).not.toContain('javascript:')
    expect(html).not.toMatch(/<a\s[^>]*href/)
  })

  it('allows an https: URI on a resource_link part — anchor renders with the href intact', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource_link', uri: 'https://example.com/report.pdf', title: 'Report' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('href="https://example.com/report.pdf"')
  })

  it('allows an http: URI on a resource part with a uri — anchor renders', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource', resource: { uri: 'http://example.com/notes.txt' } },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('href="http://example.com/notes.txt"')
  })

  it('allows a file: URI on a resource_link part (legitimate local workspace file reference)', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource_link', uri: 'file:///tmp/spec.md', title: 'Spec' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('href="file:///tmp/spec.md"')
  })

  it('allows a mailto: URI on a resource_link part', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource_link', uri: 'mailto:someone@example.com', title: 'Contact' },
        ],
      } as ChatMessage,
    ])

    expect(html).toContain('href="mailto:someone@example.com"')
  })

  it('rejects a data: URI on a resource_link part', () => {
    const html = renderMessages([
      {
        role: 'assistant',
        content: [
          { type: 'resource_link', uri: 'data:text/html,<script>alert(1)</script>', title: 'Data URI' },
        ],
      } as ChatMessage,
    ])

    expect(html).not.toContain('data:text/html')
    expect(html).not.toMatch(/<a\s[^>]*href/)
  })
})
