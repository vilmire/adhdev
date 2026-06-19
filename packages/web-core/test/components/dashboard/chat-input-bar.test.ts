import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
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
        statusMessage: 'Message queued and will send after the current reply finishes.',
        onSend: vi.fn(async () => true),
        isActive: true,
      }),
    )

    expect(html).toContain('Message queued and will send after the current reply finishes.')
    expect(html).toContain('placeholder="Message queued and will send after the current reply finishes."')
    expect(html).not.toContain('Send failed')
  })

  it('does not disable the send button solely because a prior send request is still settling', () => {
    expect(shouldDisableChatSendButton({ hasDraft: true, isBusy: false })).toBe(false)
  })

  it('renders an explicit force-send control when generation is busy but force is supported', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInputBar, {
        contextKey: 'tab-1',
        panelLabel: 'Codex CLI',
        isSending: false,
        isBusy: false,
        statusMessage: 'Agent is generating.',
        onSend: vi.fn(async () => true),
        onForceSend: vi.fn(async () => true),
        canForceSend: true,
        isActive: true,
      }),
    )

    expect(html).toContain('Agent is generating.')
    expect(html).toContain('aria-label="Force send message now"')
    expect(html).toContain('title="Force send message now"')
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
    // Active input reserves enough vertical room for optional image attachment previews.
    expect(html).toContain('max-height:200px')
    expect(html).toContain('opacity:1')
    expect(html).toContain('pointer-events:auto')
    expect(html).toContain('title="Send message to Hermes Agent"')
  })

  it('can disable visibility animation for measured terminal view transitions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatInputBar, {
        contextKey: 'tab-1',
        panelLabel: 'Hermes Agent',
        isSending: false,
        isBusy: false,
        onSend: vi.fn(async () => true),
        isActive: true,
        animateVisibility: false,
      }),
    )
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../../src/components/dashboard/ChatInputBar.tsx'), 'utf8')

    expect(html).toContain('class="dashboard-input-area bg-[var(--surface-primary)] shrink-0 overflow-hidden"')
    expect(html).not.toContain('class="dashboard-input-area bg-[var(--surface-primary)] shrink-0 overflow-hidden transition-all duration-200 ease-out"')
    expect(source).toContain('focus({ preventScroll: true })')
  })
})
