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

function session(overrides?: {
  promptId?: string
  questionId?: string
  question?: string
  allowFreeform?: boolean
}): InteractivePromptSession {
  return {
    daemonId: 'daemon-1',
    sessionId: 'session-1',
    routeId: 'daemon-1:cli:session-1',
    providerType: 'claude-cli',
    title: 'Choose an option',
    prompt: {
      promptId: overrides?.promptId ?? 'prompt-1',
      origin: 'cli',
      providerType: 'claude-cli',
      createdAt: 123,
      questions: [
        {
          questionId: overrides?.questionId ?? 'q1',
          question: overrides?.question ?? 'Pick one',
          multiSelect: false,
          allowFreeform: overrides?.allowFreeform,
          options: [
            { label: 'Option A' },
            { label: 'Option B' },
          ],
        },
      ],
    },
  } as InteractivePromptSession
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

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

  it('keeps Other textarea focus when promptSession is replaced with the same promptId', () => {
    // P2P status polling rebuilds the session wrapper every few seconds with a
    // new object identity but the same promptId. The focus-trap must not
    // re-run `.focus()` onto the header Close button, or the mobile IME
    // collapses while the user is typing in Other.
    const first = session({ allowFreeform: true })
    act(() => {
      root.render(
        <InteractivePromptModal promptSession={first} onSubmit={() => {}} onCancel={() => {}} />,
      )
    })

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    textarea.focus()
    expect(document.activeElement).toBe(textarea)

    const second = session({ allowFreeform: true })
    expect(second).not.toBe(first)
    expect(second.prompt.promptId).toBe(first.prompt.promptId)

    act(() => {
      root.render(
        <InteractivePromptModal promptSession={second} onSubmit={() => {}} onCancel={() => {}} />,
      )
    })

    expect(document.activeElement).toBe(textarea)
    const close = document.body.querySelector('[aria-label="Cancel interactive prompt"]')
    expect(document.activeElement).not.toBe(close)
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
  })

  it('moves initial focus into the dialog when a new promptId appears', () => {
    act(() => {
      root.render(
        <InteractivePromptModal
          promptSession={session({ allowFreeform: true })}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      )
    })

    const firstTextarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    firstTextarea.focus()
    expect(document.activeElement).toBe(firstTextarea)

    // A genuinely new question (new promptId + new questionId so the old
    // textarea unmounts). Initial focus must land on the first focusable —
    // currently the header Close button — not stay on Other.
    act(() => {
      root.render(
        <InteractivePromptModal
          promptSession={session({
            promptId: 'prompt-2',
            questionId: 'q2',
            question: 'Pick another',
            allowFreeform: true,
          })}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      )
    })

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    expect(focusable.length).toBeGreaterThan(0)
    expect(document.activeElement).toBe(focusable[0])
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA')
  })
})
