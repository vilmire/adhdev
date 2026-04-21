import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ChatInputBar, { shouldDisableChatSendButton } from '../../../src/components/dashboard/ChatInputBar'

describe('ChatInputBar send-state copy', () => {
  it('renders a slim vertical overflow toggle next to the input when controls are available', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInputBar, {
        contextKey: 'tab-1',
        panelLabel: 'Hermes Agent',
        isSending: false,
        isBusy: false,
        onSend: vi.fn(async () => true),
        isActive: true,
        showControlsToggle: true,
      }),
    )

    expect(html).toContain('title="Show controls"')
    expect(html).toContain('aria-label="Show controls"')
  })

  it('renders inline status copy without polluting the transcript area', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInputBar, {
        contextKey: 'tab-1',
        panelLabel: 'Hermes Agent',
        isSending: false,
        isBusy: true,
        statusMessage: 'Wait for the current reply to finish before sending another message.',
        onSend: vi.fn(async () => true),
        isActive: true,
      }),
    )

    expect(html).toContain('Wait for the current reply to finish before sending another message.')
    expect(html).toContain('placeholder="Wait for the current reply to finish before sending another message."')
    expect(html).not.toContain('Send failed')
  })

  it('does not disable the send button solely because a prior send request is still settling', () => {
    expect(shouldDisableChatSendButton({ hasDraft: true, isBusy: false })).toBe(false)
  })

  it('collapses the input surface and marks it aria-hidden when isActive is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInputBar, {
        contextKey: 'tab-1',
        panelLabel: 'Hermes Agent',
        isSending: false,
        isBusy: false,
        onSend: vi.fn(async () => true),
        isActive: false,
      }),
    )

    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('max-height:0')
    expect(html).toContain('opacity:0')
    expect(html).toContain('pointer-events:none')
    // When inactive, the row-level title tooltip is omitted so the collapsed bar
    // does not surface a hover hint while it is visually hidden.
    expect(html).not.toContain('title="Send message to Hermes Agent"')
  })

  it('keeps the input visible and interactive when isActive is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInputBar, {
        contextKey: 'tab-1',
        panelLabel: 'Hermes Agent',
        isSending: false,
        isBusy: false,
        onSend: vi.fn(async () => true),
        isActive: true,
      }),
    )

    expect(html).toContain('aria-hidden="false"')
    expect(html).toContain('max-height:72px')
    expect(html).toContain('opacity:1')
    expect(html).toContain('pointer-events:auto')
    expect(html).toContain('title="Send message to Hermes Agent"')
  })
})
