// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DashboardHiddenConversationsList from '../../../src/components/dashboard/DashboardHiddenConversationsList'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function conv(id: string, title: string, status: 'idle' | 'generating' = 'idle'): ActiveConversation {
    return {
        tabKey: `daemon-1:cli:${id}`,
        routeId: `daemon-1:cli:${id}`,
        daemonId: 'daemon-1',
        sessionId: id,
        title,
        agentName: 'Claude Code',
        agentType: 'claude-cli',
        status,
        transport: 'pty',
        connectionState: 'connected',
        messages: [],
    } as unknown as ActiveConversation
}

const conversations = [conv('s1', 'Alpha'), conv('s2', 'Bravo', 'generating'), conv('s3', 'Charlie')]

describe('DashboardHiddenConversationsList interaction', () => {
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

    const rowButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="hidden-conversation-open"]'))
    const key = (target: Element, k: string) => act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    })

    it('moves focus between rows with the arrow keys, Home and End (wrapping)', () => {
        act(() => root.render(<DashboardHiddenConversationsList conversations={conversations} onOpenConversation={vi.fn()} />))
        const [a, b, c] = rowButtons()
        a.focus()
        key(a, 'ArrowDown')
        expect(document.activeElement).toBe(b)
        key(b, 'End')
        expect(document.activeElement).toBe(c)
        key(c, 'ArrowDown')
        expect(document.activeElement).toBe(a)
        key(a, 'ArrowUp')
        expect(document.activeElement).toBe(c)
        key(c, 'Home')
        expect(document.activeElement).toBe(a)
    })

    it('a synchronous open runs on every tap (no stuck latch)', () => {
        const onOpen = vi.fn()
        act(() => root.render(<DashboardHiddenConversationsList conversations={conversations} onOpenConversation={onOpen} />))
        act(() => rowButtons()[0].click())
        act(() => rowButtons()[2].click())
        expect(onOpen.mock.calls.map(call => call[0].sessionId)).toEqual(['s1', 's3'])
    })

    it('single-flights an async open: left spinner + aria-busy on the tapped row, other taps dropped, Escape cancels', async () => {
        let resolveOpen!: () => void
        let signal: AbortSignal | undefined
        const onOpen = vi.fn((_c: ActiveConversation, s?: AbortSignal) => {
            signal = s
            return new Promise<void>(resolve => { resolveOpen = resolve })
        })
        act(() => root.render(<DashboardHiddenConversationsList conversations={conversations} onOpenConversation={onOpen} />))

        act(() => rowButtons()[0].click())
        const [a, b] = rowButtons()
        expect(a.getAttribute('aria-busy')).toBe('true')
        expect(a.querySelector('[data-testid="hidden-conversation-leading"]')?.children.length).toBe(1)
        expect(b.getAttribute('aria-disabled')).toBe('true')

        act(() => b.click())
        expect(onOpen).toHaveBeenCalledTimes(1)

        key(a, 'Escape')
        expect(signal?.aborted).toBe(true)
        expect(rowButtons()[0].getAttribute('aria-busy')).toBeNull()
        expect(rowButtons()[1].getAttribute('aria-disabled')).toBeNull()

        act(() => rowButtons()[2].click())
        expect(onOpen).toHaveBeenCalledTimes(2)
        expect(onOpen.mock.calls[1][0].sessionId).toBe('s3')
        await act(async () => { resolveOpen() })
        expect(rowButtons()[2].getAttribute('aria-busy')).toBeNull()
    })

    it('Escape with nothing in flight is left to the surrounding popover', () => {
        const outer = vi.fn()
        container.addEventListener('keydown', outer)
        act(() => root.render(<DashboardHiddenConversationsList conversations={conversations} onOpenConversation={vi.fn()} />))
        key(rowButtons()[0], 'Escape')
        expect(outer).toHaveBeenCalledTimes(1)
        expect((outer.mock.calls[0][0] as KeyboardEvent).defaultPrevented).toBe(false)
    })
})
