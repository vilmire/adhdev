// @vitest-environment jsdom
//
// (G8-13) macOS Safari IME: the Enter keystroke that confirms a composition
// fires a keydown with isComposing already false (and keyCode 229) — the
// isComposing guard alone lets that Enter fall through to "submit", ending
// the sentence early. We simulate the exact event sequence Safari produces
// (compositionend, then keydown Enter with isComposing:false, keyCode:229)
// and assert submit is NOT triggered; a plain, non-IME Enter still submits.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatInputBar from '../../src/components/dashboard/ChatInputBar'

describe('ChatInputBar IME submit guard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function getTextarea(): HTMLTextAreaElement {
    return container.querySelector('textarea') as HTMLTextAreaElement
  }

  // ChatInputBar's textarea is a React-controlled input (value={draftInput}).
  // Assigning `.value` directly bypasses React's tracked value and its
  // onChange never fires, so submitDraft still sees the old (empty) state.
  // Using the native value setter + dispatching 'input' is the standard way
  // to simulate real typing against a controlled input without a testing
  // library's fireEvent helper.
  function typeInto(textarea: HTMLTextAreaElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('does not submit on the confirming Enter right after compositionend (Safari keyCode 229 case)', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    act(() => {
      root.render(
        <ChatInputBar
          contextKey="ctx-1"
          panelLabel="Test"
          isSending={false}
          onSend={onSend}
        />,
      )
    })

    const textarea = getTextarea()
    act(() => {
      typeInto(textarea, '日本語')
    })

    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true, data: '日本語' }))
    })

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      } as KeyboardEventInit)
      // isComposing is read-only via nativeEvent in real browsers; jsdom's
      // KeyboardEvent doesn't set it from the constructor, so it defaults to
      // false here too — reproducing exactly the Safari edge case where
      // isComposing has already flipped false but keyCode is still 229.
      textarea.dispatchEvent(event)
    })
    await act(async () => { await Promise.resolve() })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('still submits on a plain, non-IME Enter', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    act(() => {
      root.render(
        <ChatInputBar
          contextKey="ctx-2"
          panelLabel="Test"
          isSending={false}
          onSend={onSend}
        />,
      )
    })

    const textarea = getTextarea()
    act(() => {
      typeInto(textarea, 'hello world')
    })

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
      textarea.dispatchEvent(event)
    })
    await act(async () => { await Promise.resolve() })

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('hello world', undefined)
  })

  it('submits again once safely past the post-composition guard window', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    act(() => {
      root.render(
        <ChatInputBar
          contextKey="ctx-3"
          panelLabel="Test"
          isSending={false}
          onSend={onSend}
        />,
      )
    })

    const textarea = getTextarea()
    act(() => {
      typeInto(textarea, '日本語')
    })
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true, data: '日本語' }))
    })

    // Wait past the guard window, then a fresh Enter (a real, separate
    // keystroke, not the IME confirm) must still submit.
    await new Promise((resolve) => setTimeout(resolve, 60))

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      textarea.dispatchEvent(event)
    })

    expect(onSend).toHaveBeenCalledTimes(1)
  })
})
