// @vitest-environment jsdom
/**
 * (QUEUE-PINNED-COMPOSER) The strip that holds waiting bodies above the composer.
 *
 * ★ The owner's correction, after using the first version: "유저가 보낸 메세지는
 * 실제로 해당 부분에 들어간게 아니니까 최하단에 계속 떠있는게 맞을 것 같음. 여타 다른
 * 메신저들처럼." Appending the bubbles to the transcript tail pinned them only
 * until the agent said anything else — after that they scrolled away, taking the
 * Send now / Cancel controls with them, and the owner had to hunt upward to
 * withdraw their own message.
 *
 * So these assert the two properties that make it a fix rather than a restyle:
 * every waiting body is present with its own controls, and the strip is NOT part
 * of the scrolling message list.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import PendingQueueStrip from '../../../src/components/dashboard/PendingQueueStrip'
import type { PendingLocalMessage } from '../../../src/components/dashboard/conversation-message-snapshot'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const NOW = 10_000_000

function parked(id: string, content: string, queued = true): PendingLocalMessage {
    return { id, content, sentAt: NOW, queued }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
})

function render(props: Partial<Parameters<typeof PendingQueueStrip>[0]> = {}) {
    act(() => {
        root.render(createElement(PendingQueueStrip, {
            entries: [],
            ...props,
        } as any))
    })
}

function strip(): HTMLElement | null {
    return container.querySelector('[data-testid="pending-queue-strip"]')
}

/** `process.cwd()` is the package root under vitest; jsdom gives no file: URL. */
function readChatPaneSource(): string {
    return readFileSync(resolve(process.cwd(), 'src/components/dashboard/ChatPane.tsx'), 'utf8')
}

function rowBodies(): string[] {
    return Array.from(container.querySelectorAll('.chat-pending-queue-body'))
        .map(el => el.textContent || '')
}

describe('PendingQueueStrip — every waiting body, with its own controls', () => {
    it('★ renders ALL parked entries in FIFO order', () => {
        render({ entries: [parked('a', 'first'), parked('b', 'second'), parked('c', 'third')] })
        expect(rowBodies()).toEqual(['first', 'second', 'third'])
        expect(strip()?.getAttribute('data-pending-queue-count')).toBe('3')
    })

    it('★ gives EACH entry its own Send now / Cancel, addressed by that entry id', () => {
        // The multi-entry hazard: controls that act on "whatever is current"
        // would cancel the wrong message. Cancel is destructive and irreversible
        // from the owner's side, so it must name its target.
        const onCancelQueued = vi.fn()
        const onSendNow = vi.fn()
        render({ entries: [parked('a', 'first'), parked('b', 'second')], onCancelQueued, onSendNow })

        const cancels = container.querySelectorAll<HTMLButtonElement>('.chat-bubble-cancel-queued')
        const sends = container.querySelectorAll<HTMLButtonElement>('.chat-bubble-send-now')
        expect(cancels).toHaveLength(2)
        expect(sends).toHaveLength(2)

        act(() => { cancels[1].click() })
        expect(onCancelQueued).toHaveBeenCalledWith('b')

        act(() => { sends[0].click() })
        expect(onSendNow).toHaveBeenCalledWith('a')
    })

    it('★ renders nothing at all when no body is parked', () => {
        // An empty strip must not leave a border/background band sitting above
        // the composer for a queue that does not exist.
        render({ entries: [] })
        expect(strip()).toBeNull()
    })

    it('★ ignores entries that are NOT parked', () => {
        // An unconfirmed send still lives in the transcript as an optimistic
        // bubble; showing it here too would double-render it.
        render({ entries: [parked('a', 'parked'), parked('b', 'still sending', false)] })
        expect(rowBodies()).toEqual(['parked'])
    })

    it('skips a parked entry that has no id rather than rendering unusable controls', () => {
        render({
            entries: [{ content: 'legacy entry', sentAt: NOW, queued: true }],
            onCancelQueued: vi.fn(),
        })
        expect(strip()).toBeNull()
    })

    it('disables both controls while a round trip is open', () => {
        render({
            entries: [parked('a', 'body')],
            onCancelQueued: vi.fn(),
            onSendNow: vi.fn(),
            isSendingNow: true,
        })
        const buttons = container.querySelectorAll<HTMLButtonElement>('button')
        expect(buttons.length).toBeGreaterThan(0)
        expect(Array.from(buttons).every(b => b.disabled)).toBe(true)
    })

    it('omits a control the surface did not wire (read-only viewer)', () => {
        render({ entries: [parked('a', 'body')] })
        expect(container.querySelector('.chat-bubble-cancel-queued')).toBeNull()
        expect(container.querySelector('.chat-bubble-send-now')).toBeNull()
        // The body itself is still shown — the owner must see what is waiting.
        expect(rowBodies()).toEqual(['body'])
    })

    it('★ one entry disappearing leaves the rest in place', () => {
        render({ entries: [parked('a', 'first'), parked('b', 'second')] })
        expect(rowBodies()).toEqual(['first', 'second'])

        // 'a' was sent or cancelled; 'b' is still waiting.
        render({ entries: [parked('b', 'second')] })
        expect(rowBodies()).toEqual(['second'])
    })
})

describe('PendingQueueStrip — pinned, not part of the transcript', () => {
    it('★ bounds its height and scrolls internally instead of growing without limit', () => {
        // A deep queue must not eat the transcript above it or push the composer
        // off screen. Asserted on the class contract the stylesheet implements
        // (jsdom applies no external CSS), so a rename cannot silently drop it.
        render({ entries: Array.from({ length: 12 }, (_, i) => parked(`id-${i}`, `body ${i}`)) })
        expect(rowBodies()).toHaveLength(12)
        expect(strip()?.className).toContain('chat-pending-queue-strip')
    })

    it('★ long bodies stay clamped, with the full text still reachable', () => {
        const long = 'x'.repeat(2_000)
        render({ entries: [parked('a', long)] })
        const body = container.querySelector('.chat-pending-queue-body')
        // Clamping is CSS (-webkit-line-clamp); the title attribute is what
        // keeps the untruncated body available to the owner.
        expect(body?.getAttribute('title')).toBe(long)
    })

    it('★ ChatPane mounts the strip AFTER the message list and BEFORE the composer', () => {
        // The whole point of the change, and the one property a unit render of
        // this component cannot observe: the scroll container lives entirely
        // inside ChatMessageList (`[data-chat-scroll]`), so a strip mounted as a
        // later sibling is structurally outside it and cannot scroll away. If
        // this ever moved inside the list, the owner's original complaint would
        // silently return with every test still green.
        //
        // Read from source because mounting ChatPane drags in the whole dashboard
        // context graph; the ordering is a static fact about the JSX.
        const pane = readChatPaneSource()
        const list = pane.indexOf('<ChatMessageList')
        const strip = pane.indexOf('<PendingQueueStrip')
        const input = pane.indexOf('<ChatInputBar')
        expect(list).toBeGreaterThan(-1)
        expect(strip).toBeGreaterThan(-1)
        expect(input).toBeGreaterThan(-1)
        expect(strip).toBeGreaterThan(list)
        expect(strip).toBeLessThan(input)
    })

    it('★ ChatPane keeps parked bodies OUT of the transcript it renders', () => {
        // The other half: without `excludeQueued` the same body would render
        // twice, once in the tail and once in the strip.
        expect(readChatPaneSource()).toMatch(/excludeQueued:\s*true/)
    })
})
