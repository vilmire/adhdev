// @vitest-environment jsdom
//
// A typed-but-unsent message must never silently vanish: switching conversation context parks the
// draft and restores it on return, and the inactive duplicate composer (pty layout mounts one per
// pane) is disabled so it cannot take focus or Enter.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatInputBar from '../../src/components/dashboard/ChatInputBar'

describe('ChatInputBar draft safety', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const ta = () => container.querySelector('textarea') as HTMLTextAreaElement
  function typeInto(text: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta(), text)
    ta().dispatchEvent(new Event('input', { bubbles: true }))
  }
  const bar = (contextKey: string, isActive = true, onSend = vi.fn().mockResolvedValue(true)) => (
    <ChatInputBar contextKey={contextKey} panelLabel="x" isSending={false} onSend={onSend} isActive={isActive} />
  )

  it('parks the draft on a context switch and restores it when coming back', () => {
    act(() => root.render(bar('draft-A')))
    act(() => typeInto('unsent thought'))
    expect(ta().value).toBe('unsent thought')
    act(() => root.render(bar('draft-B')))
    expect(ta().value).toBe('')
    act(() => root.render(bar('draft-A')))
    expect(ta().value).toBe('unsent thought')
  })

  it('disables the textarea while the bar is inactive so a hidden duplicate cannot take input', () => {
    act(() => root.render(bar('dup-1', false)))
    expect(ta().disabled).toBe(true)
    act(() => root.render(bar('dup-1', true)))
    expect(ta().disabled).toBe(false)
  })
})
