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
})
