// @vitest-environment jsdom
//
// (G8-4) InteractivePromptModal accessibility: role="dialog"/aria-modal,
// a focus trap that cycles Tab/Shift+Tab within the surface, and Escape
// invoking onCancel. Asserted against real DOM focus/keyboard behavior, not
// just markup presence.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import InteractivePromptModal from '../../src/components/interactive-prompt/InteractivePromptModal'
import type { InteractivePromptSession } from '../../src/interactive-prompt/interactive-prompt-utils'

function session(): InteractivePromptSession {
  return {
    daemonId: 'daemon-1',
    sessionId: 'session-1',
    routeId: 'daemon-1:cli:session-1',
    providerType: 'claude-cli',
    title: 'Choose an option',
    prompt: {
      promptId: 'prompt-1',
      origin: 'cli',
      providerType: 'claude-cli',
      createdAt: 123,
      questions: [
        {
          questionId: 'q1',
          question: 'Pick one',
          multiSelect: false,
          options: [
            { label: 'Option A' },
            { label: 'Option B' },
          ],
        },
      ],
    },
  } as InteractivePromptSession
}

describe('InteractivePromptModal accessibility', () => {
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
    vi.useRealTimers()
  })

  it('exposes role="dialog", aria-modal, and aria-labelledby pointing at the title', () => {
    act(() => {
      root.render(
        <InteractivePromptModal promptSession={session()} onSubmit={() => {}} onCancel={() => {}} />,
      )
    })

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    const titleEl = document.getElementById(labelledBy!)
    expect(titleEl).not.toBeNull()
    expect(titleEl!.textContent).toBe('Choose an option')
  })

  it('traps Tab focus within the dialog surface', () => {
    act(() => {
      root.render(
        <InteractivePromptModal promptSession={session()} onSubmit={() => {}} onCancel={() => {}} />,
      )
    })

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    expect(focusable.length).toBeGreaterThan(1)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    // Shift+Tab from the first focusable element should wrap to the last.
    first.focus()
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      Object.defineProperty(event, 'target', { value: first })
      dialog.dispatchEvent(event)
    })
    expect(document.activeElement).toBe(last)

    // Plain Tab from the last focusable element should wrap back to the first.
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      Object.defineProperty(event, 'target', { value: last })
      dialog.dispatchEvent(event)
    })
    expect(document.activeElement).toBe(first)
  })

  it('invokes onCancel on Escape', () => {
    const onCancel = vi.fn()
    act(() => {
      root.render(
        <InteractivePromptModal promptSession={session()} onSubmit={() => {}} onCancel={onCancel} />,
      )
    })

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('moves initial focus into the dialog surface', () => {
    act(() => {
      root.render(
        <InteractivePromptModal promptSession={session()} onSubmit={() => {}} onCancel={() => {}} />,
      )
    })

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})
