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
 *
 * ★ (QUEUE-BUBBLE-LOOK) The owner's second correction was about how it LOOKS, not
 * where it sits: the card-per-row, the "Waiting to send — the agent is still
 * working" sentence and the Send now / Cancel pair read as a management panel on
 * a phone. Presentation changed; position did not. The two source-level guards
 * at the bottom of this file are the ones that pin the position, and they are
 * deliberately untouched — if a future change moves the strip into the tail, they
 * still fail.
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

    it('★ gives EACH entry its own cancel, addressed by that entry id', () => {
        // The multi-entry hazard: a control that acts on "whatever is current"
        // would cancel the wrong message. Cancel is destructive and irreversible
        // from the owner's side, so it must name its target.
        const onCancelQueued = vi.fn()
        render({ entries: [parked('a', 'first'), parked('b', 'second')], onCancelQueued })

        const cancels = container.querySelectorAll<HTMLButtonElement>('.chat-pending-queue-cancel')
        expect(cancels).toHaveLength(2)

        act(() => { cancels[1].click() })
        expect(onCancelQueued).toHaveBeenCalledWith('b')

        act(() => { cancels[0].click() })
        expect(onCancelQueued).toHaveBeenCalledWith('a')
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

    it('disables cancel while a round trip is open', () => {
        render({
            entries: [parked('a', 'body')],
            onCancelQueued: vi.fn(),
            isSendingNow: true,
        })
        const buttons = container.querySelectorAll<HTMLButtonElement>('button')
        expect(buttons.length).toBeGreaterThan(0)
        expect(Array.from(buttons).every(b => b.disabled)).toBe(true)
    })

    it('omits cancel when the surface did not wire it (read-only viewer)', () => {
        render({ entries: [parked('a', 'body')] })
        expect(container.querySelector('.chat-pending-queue-cancel')).toBeNull()
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

describe('PendingQueueStrip — a messenger bubble, not a panel (QUEUE-BUBBLE-LOOK)', () => {
    /** The stylesheet is the other half of this contract; jsdom applies none. */
    function readStylesheet(): string {
        return readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    }

    it('★ wears the transcript\'s own user-bubble skin', () => {
        // Reusing `.chat-bubble-user` rather than a bespoke queue colour is what
        // makes a waiting body recognisably the same object as the delivered one
        // it becomes, and keeps it following the active chat theme for free.
        render({ entries: [parked('a', 'hello')] })
        const bubble = container.querySelector('.chat-pending-queue-bubble')
        expect(bubble?.className).toContain('chat-bubble-user')
        expect(bubble?.className).toContain('chat-bubble')
    })

    it('★ marks waiting with a glyph, NOT the old sentence', () => {
        // The sentence repeated on every row is what made the queue read as a
        // form. It must not come back — but the meaning still has to reach a
        // screen reader, so the glyph carries it as an aria-label.
        render({ entries: [parked('a', 'hello')] })
        const clock = container.querySelector('.chat-pending-queue-clock')
        expect(clock).not.toBeNull()
        expect(clock?.getAttribute('aria-label')).toBeTruthy()
        expect(container.textContent).not.toMatch(/still working/i)
        expect(container.textContent).not.toMatch(/waiting to send/i)
    })

    it('★ offers NO Send now — automatic delivery is the path', () => {
        // Send now interrupted the running turn and discarded it. Wired or not,
        // the strip must not surface it.
        render({ entries: [parked('a', 'hello')], onSendNow: vi.fn(), onCancelQueued: vi.fn() })
        expect(container.querySelector('.chat-bubble-send-now')).toBeNull()
        expect(container.textContent).not.toMatch(/send now/i)
    })

    it('★ drops the card chrome — no per-row border, no strip fill', () => {
        // The visual complaint, asserted where it lives. A dashed box per row
        // plus a filled band behind them is the "management panel" look.
        const css = readStylesheet()
        const row = css.slice(css.indexOf('.chat-pending-queue-row {'))
            .slice(0, css.slice(css.indexOf('.chat-pending-queue-row {')).indexOf('}'))
        expect(row).not.toMatch(/border:/)
        expect(row).not.toMatch(/dashed/)
        // Right-alignment is the bubble's defining property here.
        expect(row).toMatch(/justify-content:\s*flex-end/)
    })

    it('★ cancel stays reachable on touch — not hover-gated in markup', () => {
        // A phone has no hover. The button is always in the DOM and always
        // enabled; only its resting opacity differs, and that is a
        // `@media (hover: hover)` rule, so touch never loses it.
        render({ entries: [parked('a', 'hello')], onCancelQueued: vi.fn() })
        const cancel = container.querySelector<HTMLButtonElement>('.chat-pending-queue-cancel')
        expect(cancel).not.toBeNull()
        expect(cancel?.disabled).toBe(false)
        expect(readStylesheet()).toMatch(/@media \(hover: hover\)/)
    })

    it('★ stacks several waiting bodies as separate bubbles', () => {
        render({ entries: [parked('a', 'one'), parked('b', 'two'), parked('c', 'three')] })
        expect(container.querySelectorAll('.chat-pending-queue-bubble')).toHaveLength(3)
        expect(rowBodies()).toEqual(['one', 'two', 'three'])
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
        const bubble = container.querySelector('.chat-pending-queue-bubble')
        // Clamping is CSS (-webkit-line-clamp); the title attribute is what
        // keeps the untruncated body available to the owner.
        expect(bubble?.getAttribute('title')).toBe(long)
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

/**
 * (QUEUED-SEND-STUCK-FOREVER) The strip must stop making a promise it cannot keep.
 *
 * "Waiting to send" asserts the agent WILL get this body. That is false once the
 * session has been torn down mid-queue — `FsmDriver.shutdown()` discards
 * `pendingSends` and notifies no surface, so no echo and no cancel confirmation
 * can ever arrive. The row previously sat here repeating that promise until a 24h
 * age-out, which is the owner's report: a message sent long ago, still pinned as
 * waiting, for an agent that was never going to receive it.
 */
describe('PendingQueueStrip — a body that waited too long stops claiming delivery', () => {
    /**
     * The marker's accessible name IS the claim (QUEUE-BUBBLE-LOOK replaced the
     * sentence with a glyph, so `aria-label` is where the meaning now lives).
     * Asserting on it rather than on the glyph character keeps this test about
     * what the row CLAIMS, not which pictograph was chosen for it.
     */
    function markerLabel(index = 0): string {
        return Array.from(container.querySelectorAll('.chat-pending-queue-clock'))[index]
            ?.getAttribute('aria-label') || ''
    }

    it('★ a stale row says NOT DELIVERED instead of "waiting to send"', () => {
        render({ entries: [{ ...parked('a', 'orphaned body'), stale: true }] })
        expect(markerLabel()).toMatch(/not delivered/i)
        expect(markerLabel()).not.toMatch(/waiting to send/i)
        expect(container.querySelector('[data-chat-queued-stale="true"]')).not.toBeNull()
    })

    it('a row still inside the window keeps saying "waiting to send"', () => {
        render({ entries: [parked('a', 'recent body')] })
        expect(markerLabel()).toMatch(/waiting to send/i)
        expect(container.querySelector('[data-chat-queued-stale="true"]')).toBeNull()
    })

    it('★ the stale marker is visually distinct, not only renamed', () => {
        // A screen reader gets the aria-label above; a sighted owner gets this.
        // Without the class the row would look identical to one still on its way.
        render({ entries: [{ ...parked('a', 'orphaned body'), stale: true }] })
        expect(container.querySelector('.chat-pending-queue-clock')?.className)
            .toContain('chat-pending-queue-stale')

        render({ entries: [parked('a', 'recent body')] })
        expect(container.querySelector('.chat-pending-queue-clock')?.className)
            .not.toContain('chat-pending-queue-stale')
    })

    it('★ a stale row KEEPS its text and its cancel — the owner will want to resend it', () => {
        // Marking, not deleting, is the whole point: a discarded body is one the
        // owner most likely wants back, and they cannot resend what they cannot see.
        const onCancelQueued = vi.fn()
        render({ entries: [{ ...parked('a', 'ghost body'), stale: true }], onCancelQueued })
        expect(rowBodies()).toEqual(['ghost body'])

        const cancel = container.querySelector<HTMLButtonElement>('.chat-pending-queue-cancel')
        expect(cancel).not.toBeNull()
        act(() => { cancel!.click() })
        expect(onCancelQueued).toHaveBeenCalledWith('a')
    })

    it('★ a stale row keeps the messenger bubble skin — it is still the owner\'s message', () => {
        // QUEUE-BUBBLE-LOOK must survive the stale state: going undelivered changes
        // the claim, not what kind of object this is.
        render({ entries: [{ ...parked('a', 'ghost body'), stale: true }] })
        const bubble = container.querySelector('.chat-pending-queue-bubble')
        expect(bubble?.className).toContain('chat-bubble-user')
        expect(bubble?.className).toContain('chat-bubble')
    })

    it('★ the region label stops saying "waiting" once nothing is', () => {
        // Otherwise a screen-reader user is told the exact thing the visible rows
        // have just stopped saying.
        render({ entries: [{ ...parked('a', 'orphaned'), stale: true }] })
        expect(strip()?.getAttribute('aria-label')).toMatch(/not delivered/i)
    })

    it('keeps the waiting region label while ANY row is still genuinely waiting', () => {
        render({
            entries: [{ ...parked('a', 'orphaned'), stale: true }, parked('b', 'still waiting')],
        })
        expect(strip()?.getAttribute('aria-label')).toMatch(/waiting to send/i)
    })

    it('★ the memo lets the marker flip when an entry goes stale in place', () => {
        // `stale` selects the marker, so a comparator that ignored it would leave
        // the strip claiming "waiting to send" forever while state said otherwise
        // — the defect surviving behind a green state-level test. This is the only
        // test that exercises the memo, because the flip happens with the entry at
        // the same index with the same id and the same content.
        const entry = parked('a', 'aging body')
        render({ entries: [entry] })
        expect(markerLabel()).toMatch(/waiting to send/i)

        render({ entries: [{ ...entry, stale: true }] })
        expect(markerLabel()).toMatch(/not delivered/i)
    })
})
