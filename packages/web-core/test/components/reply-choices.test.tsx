// @vitest-environment jsdom
/**
 * Answer buttons for an assistant question (2026-10-18 review: the assistant
 * asked "bring DesktopA online, or stop?" and the owner had to type the answer).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import ChatMessageList from '../../src/components/ChatMessageList'
import { extractReplyChoices } from '../../src/components/ChatMessageList/reply-choices'
import { resolveChatRow } from '../../src/components/ChatMessageList/chat-row-model'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose props for render helpers
type Loose = ComponentType<any>
const question = 'batrp is blocked on DesktopA.\n\nWhat should I do?\n[[choices: Bring DesktopA online | Stop the migration]]'

describe('extractReplyChoices', () => {
    it('takes the options from the last line and strips it', () => {
        expect(extractReplyChoices(question)).toEqual({ text: 'batrp is blocked on DesktopA.\n\nWhat should I do?', choices: ['Bring DesktopA online', 'Stop the migration'] })
    })
    it('ignores a choices line that is not last, and plain text', () => {
        expect(extractReplyChoices('[[choices: a | b]]\nmore text').choices).toEqual([])
        expect(extractReplyChoices('no options here').choices).toEqual([])
    })
    it('caps the number and length of options', () => {
        expect(extractReplyChoices(`q\n[[choices: 1|2|3|4|5|6|${'x'.repeat(90)}]]`).choices).toEqual(['1', '2', '3', '4', '5'])
    })
    it('the row model hides the line from the assistant bubble', () => {
        const row = resolveChatRow({ role: 'assistant', content: question } as never)
        expect(row.replyChoices).toEqual(['Bring DesktopA online', 'Stop the migration'])
        expect('text' in row.body && row.body.text).not.toContain('[[choices')
    })
})

describe('ChatMessageList answer buttons', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
    afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
    const render = (messages: unknown[], props: Record<string, unknown> = {}) => act(() => root.render(createElement(ChatMessageList as Loose, { messages, isCliMode: true, ...props })))
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.chat-reply-choice')]

    it('shows the options under the latest assistant question and sends the tapped one', () => {
        const onChooseReply = vi.fn()
        render([{ role: 'user', content: 'status?' }, { role: 'assistant', content: question }], { onChooseReply })
        expect(buttons().map(b => b.textContent)).toEqual(['Bring DesktopA online', 'Stop the migration'])
        expect(container.textContent).not.toContain('[[choices')
        act(() => buttons()[1]!.click())
        expect(onChooseReply).toHaveBeenCalledWith('Stop the migration')
    })
    it('no buttons once the owner replied, while working, or on a read-only host', () => {
        render([{ role: 'assistant', content: question }, { role: 'user', content: 'Stop the migration' }], { onChooseReply: vi.fn() })
        expect(buttons()).toHaveLength(0)
        render([{ role: 'assistant', content: question }], { onChooseReply: vi.fn(), isWorking: true })
        expect(buttons()).toHaveLength(0)
        render([{ role: 'assistant', content: question }])
        expect(buttons()).toHaveLength(0)
    })
})
