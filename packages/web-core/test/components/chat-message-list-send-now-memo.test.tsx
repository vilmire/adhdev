// @vitest-environment jsdom
/**
 * G8-6: `MemoizedChatMessageList`'s top-level React.memo comparator
 * (ChatMessageList.tsx) was missing `onSendNow`/`isSendingNow` — a flip of
 * either prop compared `===` equal on every OTHER field and the memo
 * suppressed the re-render entirely. Two concrete symptoms: (1) the "Send
 * now" button never flips to "Sending…", so a user unsure whether their
 * click registered could press it again mid-flight — stale closures make
 * that a real double-interrupt, not just a cosmetic miss; (2) a fresh
 * `onSendNow` handler (new identity each parent render) never reaches the
 * row, so a click after a re-render could fire a closure over stale state.
 *
 * This renders the REAL memoized component (not just the comparator in
 * isolation) so the test fails the way production would: the button visibly
 * does not update.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MemoizedChatMessageList from '../../src/components/ChatMessageList'
import { withPendingLocalMessage } from '../../src/components/dashboard/conversation-message-snapshot'

const SENT_AT = 1_700_000_000_000

function queuedMessages() {
    const [msg] = withPendingLocalMessage([], { content: 'urgent: stop', sentAt: SENT_AT, queued: true }, SENT_AT + 10)
    return [msg] as any[]
}

describe('MemoizedChatMessageList memo comparator includes onSendNow/isSendingNow (G8-6)', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        // ChatMessageList observes its scroll container for jump-button state;
        // jsdom has no ResizeObserver implementation.
        vi.stubGlobal('ResizeObserver', class {
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
        vi.unstubAllGlobals()
    })

    it('re-renders the Send now button as Sending… when ONLY isSendingNow flips (all other props identical)', () => {
        const messages = queuedMessages()
        const onSendNow = vi.fn()
        const baseProps = { messages, onSendNow }

        act(() => {
            root.render(createElement(MemoizedChatMessageList as any, { ...baseProps, isSendingNow: false }))
        })
        expect(container.textContent).toContain('Send now')
        expect(container.textContent).not.toContain('Sending…')

        // Same `messages` array reference, same `onSendNow` reference — every
        // prop is `===` identical except isSendingNow. Before the fix, the
        // list-level memo comparator did not read this field at all, so this
        // second render was suppressed and the DOM never updated.
        act(() => {
            root.render(createElement(MemoizedChatMessageList as any, { ...baseProps, isSendingNow: true }))
        })
        expect(container.textContent).toContain('Sending…')
        expect(container.textContent).not.toContain('Send now')
    })

    it('re-renders when ONLY the onSendNow identity changes (stale-closure guard)', () => {
        const messages = queuedMessages()
        const firstHandler = vi.fn()
        const secondHandler = vi.fn()

        act(() => {
            root.render(createElement(MemoizedChatMessageList as any, { messages, onSendNow: firstHandler, isSendingNow: false }))
        })
        const button = container.querySelector('.chat-bubble-send-now') as HTMLButtonElement
        expect(button).toBeTruthy()
        button.click()
        expect(firstHandler).toHaveBeenCalledTimes(1)
        expect(secondHandler).toHaveBeenCalledTimes(0)

        act(() => {
            root.render(createElement(MemoizedChatMessageList as any, { messages, onSendNow: secondHandler, isSendingNow: false }))
        })
        const buttonAfter = container.querySelector('.chat-bubble-send-now') as HTMLButtonElement
        buttonAfter.click()
        // If the memo suppressed the re-render, this click would still invoke
        // `firstHandler` (the stale closure) instead of `secondHandler`.
        expect(secondHandler).toHaveBeenCalledTimes(1)
        expect(firstHandler).toHaveBeenCalledTimes(1)
    })
})
