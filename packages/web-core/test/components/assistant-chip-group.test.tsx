// @vitest-environment jsdom
/**
 * Assistant one-tap chips (starter requests + answer buttons): one send at a
 * time, the composer draft is never touched, a pending send can be cancelled,
 * and the group is keyboard operable.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AssistantChipGroup from '../../src/components/AssistantChipGroup'
import ChatInputBar from '../../src/components/dashboard/ChatInputBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const chips = ['Status', 'What is blocked?', 'Decisions'].map(label => ({ id: label, label }))

describe('AssistantChipGroup', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
        vi.unstubAllGlobals()
    })

    const chipButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-chip-id]'))
    const cancelButton = () => container.querySelector<HTMLButtonElement>('[data-testid="assistant-chip-cancel"]')
    const key = (target: Element, k: string) => act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    })

    it('renders each chip with its label as the accessible text and an empty left slot', () => {
        act(() => root.render(<AssistantChipGroup chips={chips} onChoose={vi.fn()} chipClassName="chat-reply-choice" />))
        expect(chipButtons().map(b => b.textContent)).toEqual(['Status', 'What is blocked?', 'Decisions'])
        expect(chipButtons()[0].className).toContain('chat-reply-choice')
        expect(chipButtons()[0].className).toContain('assistant-chip')
        expect(cancelButton()).toBeNull()
    })

    it('single-flights a send: spinner on the tapped chip, others disabled, repeat taps dropped, released on settle', async () => {
        let resolveSend!: (sent: boolean) => void
        const onChoose = vi.fn(() => new Promise<boolean>(resolve => { resolveSend = resolve }))
        act(() => root.render(<AssistantChipGroup chips={chips} onChoose={onChoose} />))

        act(() => chipButtons()[1].click())
        expect(onChoose).toHaveBeenCalledWith('What is blocked?', expect.any(AbortSignal))
        const [a, b] = chipButtons()
        expect(b.getAttribute('aria-busy')).toBe('true')
        expect(b.querySelector('[data-testid="assistant-chip-spinner"]')).not.toBeNull()
        expect(a.getAttribute('aria-disabled')).toBe('true')

        act(() => a.click())
        act(() => b.click())
        expect(onChoose).toHaveBeenCalledTimes(1)
        expect(cancelButton()).not.toBeNull()

        await act(async () => { resolveSend(true) })
        expect(chipButtons()[1].getAttribute('aria-busy')).toBeNull()
        expect(cancelButton()).toBeNull()
        act(() => chipButtons()[0].click())
        expect(onChoose).toHaveBeenCalledTimes(2)
    })

    it('Cancel and Escape both abort the pending send and free the chips', () => {
        const signals: AbortSignal[] = []
        const onChoose = vi.fn((_label: string, signal: AbortSignal) => {
            signals.push(signal)
            return new Promise<boolean>(() => undefined)
        })
        act(() => root.render(<AssistantChipGroup chips={chips} onChoose={onChoose} />))

        act(() => chipButtons()[0].click())
        act(() => cancelButton()!.click())
        expect(signals[0].aborted).toBe(true)
        expect(chipButtons()[1].getAttribute('aria-disabled')).toBeNull()

        act(() => chipButtons()[2].click())
        key(chipButtons()[2], 'Escape')
        expect(signals[1].aborted).toBe(true)
        expect(cancelButton()).toBeNull()
    })

    it('arrow keys, Home and End move focus across chips', () => {
        act(() => root.render(<AssistantChipGroup chips={chips} onChoose={vi.fn()} />))
        const [a, b, c] = chipButtons()
        a.focus()
        key(a, 'ArrowRight')
        expect(document.activeElement).toBe(b)
        key(b, 'ArrowDown')
        expect(document.activeElement).toBe(c)
        key(c, 'ArrowRight')
        expect(document.activeElement).toBe(a)
        key(a, 'ArrowLeft')
        expect(document.activeElement).toBe(c)
        key(c, 'Home')
        expect(document.activeElement).toBe(a)
        key(a, 'End')
        expect(document.activeElement).toBe(c)
    })

    it('a chip tap leaves the typed composer draft in place and never submits it', async () => {
        const onSend = vi.fn(async () => true)
        const onChoose = vi.fn(async () => true)
        act(() => root.render(
            <>
                <AssistantChipGroup chips={chips} onChoose={onChoose} />
                <ChatInputBar contextKey="tab-a" panelLabel="Assistant" isSending={false} onSend={onSend} />
            </>,
        ))
        const textarea = container.querySelector('textarea')!
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        act(() => {
            setValue.call(textarea, 'half-written question')
            textarea.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(textarea.value).toBe('half-written question')

        await act(async () => { chipButtons()[0].click() })
        expect(onChoose).toHaveBeenCalledWith('Status', expect.any(AbortSignal))
        expect(onSend).not.toHaveBeenCalled()
        expect(container.querySelector('textarea')!.value).toBe('half-written question')
    })
})
