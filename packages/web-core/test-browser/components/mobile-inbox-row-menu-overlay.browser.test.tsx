// RC28 regression: the mobile inbox row "…" menu (Mute/Unmute + Hide) was an
// inline `absolute` popup inside a rounded `overflow-hidden` row — on the LAST
// card of a bucket (and near the bottom nav / above Hidden tabs) the menu was
// clipped and Hide was unreachable. This mounts the PRODUCTION
// DashboardMobileChatInbox with the real index.css in real Chromium and pins,
// via elementFromPoint hit-testing, that every menu item's center point
// resolves to the item itself (not the next card/group), at every row
// position, for muted and unmuted rows, on phone-shaped and desktop
// viewports. All data is synthetic; no daemon, no owner state.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import { initI18n } from '../../src/i18n/config'
import DashboardMobileChatInbox from '../../src/components/dashboard/DashboardMobileChatInbox'
import type { MobileConversationListItem } from '../../src/components/dashboard/DashboardMobileChatShared'
import type { ActiveConversation } from '../../src/components/dashboard/types'

const EVIDENCE_DIR = '/tmp/adhdev-rc28-menu-overlay-evidence'

function makeConversation(overrides: Partial<ActiveConversation> & { tabKey: string }): ActiveConversation {
    return {
        mode: 'chat',
        agentName: 'Codex',
        agentType: 'codex-cli',
        transport: 'pty',
        status: 'idle',
        title: 'Synthetic chat',
        routeId: 'daemon-a',
        daemonId: 'daemon-a',
        sessionId: overrides.tabKey,
        messages: [],
        workspaceName: 'fixture',
        displayPrimary: 'Synthetic chat',
        displaySecondary: 'Codex · fixture',
        streamSource: 'native',
        connectionState: 'connected',
        ...overrides,
    }
}

function makeItem(conversation: ActiveConversation): MobileConversationListItem {
    return {
        conversation,
        timestamp: 1_000,
        preview: 'Synthetic preview text',
        unread: false,
        requiresAction: false,
        isWorking: false,
        inboxBucket: 'idle',
    }
}

function center(element: Element) {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, rect }
}

/** Real hit-test: what actually receives the pointer at the element's center? */
function hitTest(element: Element): Element | null {
    const { x, y } = center(element)
    return document.elementFromPoint(x, y)
}

function expectHitTestable(element: Element, context: string) {
    const hit = hitTest(element)
    const ok = hit != null && (hit === element || element.contains(hit))
    expect(ok, `${context}: center of ${(element as HTMLElement).className} must hit the item itself or its descendant, got ${hit ? (hit as HTMLElement).tagName + '.' + (hit as HTMLElement).className : 'null'}`).toBe(true)
}

describe('MobileInboxRowMenu overlay (RC28 clipping fix)', () => {
    let host: HTMLDivElement
    let root: Root
    const mutedKeys = new Set<string>()
    const onHideConversation = vi.fn()
    const onToggleMuteConversation = vi.fn()
    const onOpenConversation = vi.fn()

    const earlierItems = Array.from({ length: 6 }, (_, index) =>
        makeItem(makeConversation({ tabKey: `daemon-a:earlier-${index}`, displayPrimary: `Earlier chat ${index}` })),
    )
    const hiddenConversations = [0, 1].map(index =>
        makeConversation({ tabKey: `daemon-a:hidden-${index}`, displayPrimary: `Hidden chat ${index}` }),
    )

    beforeEach(async () => {
        localStorage.setItem('lang', 'en')
        initI18n()
        ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
        host = document.createElement('div')
        host.style.cssText = 'height:100dvh;display:flex;flex-direction:column'
        document.body.append(host)
        root = createRoot(host)
        mutedKeys.clear()
        mutedKeys.add('daemon-a:earlier-5') // the LAST card is the muted variant
        onHideConversation.mockClear()
        onToggleMuteConversation.mockClear()
        onOpenConversation.mockClear()
        await page.viewport(390, 844)
        await act(async () => root.render(
            <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <DashboardMobileChatInbox
                    section="chats"
                    attentionItems={[]}
                    unreadItems={[]}
                    workingItems={[]}
                    completedItems={earlierItems}
                    hiddenConversations={hiddenConversations}
                    machineCards={[]}
                    getAvatarText={(text) => text[0] || '?'}
                    actionLogs={[]}
                    sendDaemonCommand={vi.fn()}
                    onOpenConversation={onOpenConversation}
                    onShowAllHidden={vi.fn()}
                    onHideConversation={onHideConversation}
                    onOpenMachine={vi.fn()}
                    onOpenSettings={vi.fn()}
                    onSectionChange={vi.fn()}
                    wsStatus="connected"
                    isConversationMuted={(conversation) => mutedKeys.has(conversation.tabKey)}
                    onToggleMuteConversation={(conversation) => onToggleMuteConversation(conversation)}
                />
            </MemoryRouter>,
        ))
    })

    afterEach(async () => {
        await act(async () => root.unmount())
        host.remove()
    })

    const scroller = () => host.querySelector<HTMLDivElement>('.overflow-y-auto')!
    const triggers = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.mobile-inbox-row-menu-button'))
    const openMenu = () => document.body.querySelector<HTMLDivElement>('[role="menu"]')
    const menuItems = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    const hideButton = () => document.body.querySelector<HTMLButtonElement>('.mobile-inbox-hide-button')
    const muteButton = () => document.body.querySelector<HTMLButtonElement>('.mobile-inbox-mute-button')

    async function openRowMenu(index: number) {
        const trigger = triggers()[index]
        await act(async () => trigger.click())
        expect(openMenu(), `menu for row ${index} should be open`).not.toBeNull()
        return trigger
    }

    it('last EARLIER card: Mute and Hide are fully painted and hit-testable above Hidden tabs / bottom nav, actions fire once without opening the chat', async () => {
        // Reproduce the owner screenshot: scroll the list so the last card sits
        // just above the Hidden tabs card / bottom nav.
        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        const lastIndex = triggers().length - 1
        const trigger = await openRowMenu(lastIndex)
        const row = trigger.closest('.group')!
        const menu = openMenu()!

        await page.screenshot({ path: `${EVIDENCE_DIR}/menu-open-last-card-390x844.png` })

        // The overlay must escape the clipping ancestors, not live inside the row.
        expect(row.contains(menu), 'menu must be portaled out of the overflow-hidden row').toBe(false)
        // Whole menu inside the viewport.
        const menuRect = menu.getBoundingClientRect()
        expect(menuRect.top).toBeGreaterThanOrEqual(0)
        expect(menuRect.left).toBeGreaterThanOrEqual(0)
        expect(menuRect.bottom).toBeLessThanOrEqual(window.innerHeight)
        expect(menuRect.right).toBeLessThanOrEqual(window.innerWidth)

        // Muted last card → Unmute wording, both items hit-testable.
        expect(muteButton()!.textContent).toContain('Unmute this chat')
        expectHitTestable(muteButton()!, 'last-card Unmute')
        expectHitTestable(hideButton()!, 'last-card Hide')
        // Both items keep a >= 44px touch target.
        for (const item of menuItems()) {
            expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
        }

        // Real pointer click on Hide: exactly one hide, no accidental card open.
        await userEvent.click(hideButton()!)
        expect(onHideConversation).toHaveBeenCalledTimes(1)
        expect(onHideConversation).toHaveBeenCalledWith(earlierItems[lastIndex].conversation)
        expect(onOpenConversation).not.toHaveBeenCalled()
        expect(openMenu(), 'menu closes after the action').toBeNull()
    })

    it('first, middle and last cards all keep both actions hit-testable', async () => {
        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        for (const index of [0, 2, triggers().length - 1]) {
            const trigger = triggers()[index]
            await act(async () => trigger.scrollIntoView({ block: 'center' }))
            await openRowMenu(index)
            expect(menuItems().length).toBe(2)
            expectHitTestable(muteButton()!, `row ${index} mute`)
            expectHitTestable(hideButton()!, `row ${index} hide`)
            const menuRect = openMenu()!.getBoundingClientRect()
            expect(menuRect.bottom).toBeLessThanOrEqual(window.innerHeight)
            expect(menuRect.top).toBeGreaterThanOrEqual(0)
            await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
            expect(openMenu()).toBeNull()
        }
    })

    it('unmuted row offers "Mute this chat"; muted row offers "Unmute this chat"; toggle fires exactly once', async () => {
        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        // Unmuted row 0.
        await act(async () => triggers()[0].scrollIntoView({ block: 'center' }))
        await openRowMenu(0)
        expect(muteButton()!.textContent).toContain('Mute this chat')
        await userEvent.click(muteButton()!)
        expect(onToggleMuteConversation).toHaveBeenCalledTimes(1)
        expect(onToggleMuteConversation).toHaveBeenCalledWith(earlierItems[0].conversation)
        expect(onOpenConversation).not.toHaveBeenCalled()
        // Muted LAST row near the bottom nav.
        const lastIndex = triggers().length - 1
        await act(async () => triggers()[lastIndex].scrollIntoView({ block: 'center' }))
        await openRowMenu(lastIndex)
        expect(muteButton()!.textContent).toContain('Unmute this chat')
        await userEvent.click(muteButton()!)
        expect(onToggleMuteConversation).toHaveBeenCalledTimes(2)
        expect(onOpenConversation).not.toHaveBeenCalled()
    })

    it('menu flips above the trigger when the card is near the bottom nav', async () => {
        // Render enough rows (without the Hidden tabs footer in between) so the
        // last card sits directly above the docked bottom nav when scrolled down.
        const eightItems = Array.from({ length: 8 }, (_, index) =>
            makeItem(makeConversation({ tabKey: `daemon-a:nav-${index}`, displayPrimary: `Bottom nav chat ${index}` })),
        )
        await act(async () => root.render(
            <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <DashboardMobileChatInbox
                    section="chats"
                    attentionItems={[]}
                    unreadItems={[]}
                    workingItems={[]}
                    completedItems={eightItems}
                    hiddenConversations={[]}
                    machineCards={[]}
                    getAvatarText={(text) => text[0] || '?'}
                    actionLogs={[]}
                    sendDaemonCommand={vi.fn()}
                    onOpenConversation={onOpenConversation}
                    onShowAllHidden={vi.fn()}
                    onHideConversation={onHideConversation}
                    onOpenMachine={vi.fn()}
                    onOpenSettings={vi.fn()}
                    onSectionChange={vi.fn()}
                    wsStatus="connected"
                    isConversationMuted={(conversation) => mutedKeys.has(conversation.tabKey)}
                    onToggleMuteConversation={(conversation) => onToggleMuteConversation(conversation)}
                />
            </MemoryRouter>,
        ))
        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        const lastIndex = triggers().length - 1
        const trigger = await openRowMenu(lastIndex)
        const menuRect = openMenu()!.getBoundingClientRect()
        const triggerRect = trigger.getBoundingClientRect()
        // Not enough room below (before the bottom nav) → the menu must sit above the trigger, not clip.
        expect(menuRect.bottom).toBeLessThanOrEqual(triggerRect.top + 1)
        expect(menuRect.top).toBeGreaterThanOrEqual(0)
        expectHitTestable(muteButton()!, 'near-bottom-nav mute')
        expectHitTestable(hideButton()!, 'near-bottom-nav hide')
        await page.screenshot({ path: `${EVIDENCE_DIR}/menu-open-near-bottom-nav-390x844.png` })
    })

    it('Escape closes the menu and returns focus to the trigger; arrows navigate items; outside pointer closes', async () => {
        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        const lastIndex = triggers().length - 1
        const trigger = await openRowMenu(lastIndex)
        // Keyboard focus lands inside the menu and arrows cycle it.
        const items = menuItems()
        expect(items.length).toBe(2)
        expect(items.some(item => item === document.activeElement), 'focus moves into the open menu').toBe(true)
        await userEvent.keyboard('{ArrowDown}')
        expect(document.activeElement).toBe(items[1])
        await userEvent.keyboard('{ArrowUp}')
        expect(document.activeElement).toBe(items[0])
        await userEvent.keyboard('{Escape}')
        expect(openMenu()).toBeNull()
        expect(document.activeElement, 'Escape restores focus to the trigger').toBe(trigger)

        // Outside pointerdown closes without activating anything.
        await openRowMenu(lastIndex)
        const outside = host.querySelector('[data-testid="mobile-hidden-tabs-card"]')!
        await userEvent.click(outside.querySelector('[data-testid="mobile-hidden-tabs-toggle"]')!)
        expect(openMenu()).toBeNull()
    })

    it('viewport resize and >6px list scroll close the menu, while <=6px scroll jitter repositions it', async () => {
        const trigger = await openRowMenu(0)
        expect(openMenu()).not.toBeNull()
        // <=6px scroll jitter keeps the menu open.
        await act(async () => {
            scroller().scrollTop = 4
            scroller().dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        expect(openMenu()).not.toBeNull()
        // >6px user scroll closes the menu.
        await act(async () => {
            scroller().scrollTop = 48
            scroller().dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        expect(openMenu()).toBeNull()

        // Reopen and verify viewport resize closes the menu.
        await act(async () => { scroller().scrollTop = 0 })
        await openRowMenu(0)
        expect(openMenu()).not.toBeNull()
        await page.viewport(500, 700)
        await act(async () => { window.dispatchEvent(new Event('resize')) })
        expect(openMenu()).toBeNull()
        // Reopening at the new size still works and stays on screen.
        await act(async () => trigger.click())
        const menuRect = openMenu()!.getBoundingClientRect()
        expect(menuRect.right).toBeLessThanOrEqual(window.innerWidth)
        expect(menuRect.bottom).toBeLessThanOrEqual(window.innerHeight)
    })

    it('desktop viewport 1280 and standalone iPhone PWA mode: same overlay, same hit-testing, clean unmount', async () => {
        await page.viewport(1280, 844)
        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        const lastIndex = triggers().length - 1
        await openRowMenu(lastIndex)
        expectHitTestable(muteButton()!, 'desktop mute')
        expectHitTestable(hideButton()!, 'desktop hide')
        await page.screenshot({ path: `${EVIDENCE_DIR}/menu-open-last-card-1280x844.png` })
        await userEvent.keyboard('{Escape}')
        expect(openMenu()).toBeNull()

        // Re-render in standalone PWA mode at 390x844 and verify last card menu & anchor unmount cleanup.
        await page.viewport(390, 844)
        await act(async () => root.render(
            <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <DashboardMobileChatInbox
                    section="chats"
                    isStandalone={true}
                    attentionItems={[]}
                    unreadItems={[]}
                    workingItems={[]}
                    completedItems={earlierItems}
                    hiddenConversations={hiddenConversations}
                    machineCards={[]}
                    getAvatarText={(text) => text[0] || '?'}
                    actionLogs={[]}
                    sendDaemonCommand={vi.fn()}
                    onOpenConversation={onOpenConversation}
                    onShowAllHidden={vi.fn()}
                    onHideConversation={onHideConversation}
                    onOpenMachine={vi.fn()}
                    onOpenSettings={vi.fn()}
                    onSectionChange={vi.fn()}
                    wsStatus="connected"
                    isConversationMuted={(conversation) => mutedKeys.has(conversation.tabKey)}
                    onToggleMuteConversation={(conversation) => onToggleMuteConversation(conversation)}
                />
            </MemoryRouter>,
        ))
        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        await openRowMenu(lastIndex)
        expectHitTestable(muteButton()!, 'standalone pwa mute')
        expectHitTestable(hideButton()!, 'standalone pwa hide')

        // Anchor unmount removes the portaled menu from document.body.
        await act(async () => root.render(
            <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <DashboardMobileChatInbox
                    section="chats"
                    isStandalone={true}
                    attentionItems={[]}
                    unreadItems={[]}
                    workingItems={[]}
                    completedItems={earlierItems.slice(0, -1)}
                    hiddenConversations={hiddenConversations}
                    machineCards={[]}
                    getAvatarText={(text) => text[0] || '?'}
                    actionLogs={[]}
                    sendDaemonCommand={vi.fn()}
                    onOpenConversation={onOpenConversation}
                    onShowAllHidden={vi.fn()}
                    onHideConversation={onHideConversation}
                    onOpenMachine={vi.fn()}
                    onOpenSettings={vi.fn()}
                    onSectionChange={vi.fn()}
                    wsStatus="connected"
                    isConversationMuted={(conversation) => mutedKeys.has(conversation.tabKey)}
                    onToggleMuteConversation={(conversation) => onToggleMuteConversation(conversation)}
                />
            </MemoryRouter>,
        ))
        expect(openMenu(), 'unmounting the anchored row removes its portaled menu').toBeNull()
    })

    it('expectHitTestable guard rejects body/null/ancestor/other-row/hidden-tabs/wrong-item and accepts genuine child span/SVG; last card above expanded Hidden tabs stays hit-testable', async () => {
        // Expand Hidden tabs first so the hidden conversations list is rendered directly below the last EARLIER card.
        const hiddenToggle = host.querySelector<HTMLButtonElement>('[data-testid="mobile-hidden-tabs-toggle"]')!
        await act(async () => hiddenToggle.click())
        expect(hiddenToggle.getAttribute('aria-expanded')).toBe('true')

        await act(async () => { scroller().scrollTop = scroller().scrollHeight })
        const lastIndex = triggers().length - 1
        await openRowMenu(lastIndex)

        const menu = openMenu()!
        const mute = muteButton()!
        const hide = hideButton()!
        const otherRow = triggers()[0].closest('.group')!

        // Both items must be genuinely hit-testable above the expanded Hidden tabs list.
        expectHitTestable(mute, 'last-card above expanded Hidden tabs mute')
        expectHitTestable(hide, 'last-card above expanded Hidden tabs hide')
        // Verify canonical --z-popover (1100) stacking on the portaled menu.
        expect(getComputedStyle(menu).zIndex).toBe('1100')

        // Exercise the ACTUAL expectHitTestable helper against positive descendant hits and negative non-target hits.
        const childSvg = hide.querySelector('svg')!
        const childSvgGraphic = childSvg.firstElementChild as Element
        const tempSpan = document.createElement('span')
        tempSpan.textContent = 'Hide label child'
        hide.appendChild(tempSpan)

        const elementFromPointSpy = vi.spyOn(document, 'elementFromPoint')
        try {
            // Positive controls: target menuitem itself, genuine child <span>, genuine child <svg> and nested SVG child.
            for (const positiveTarget of [hide, tempSpan, childSvg, childSvgGraphic]) {
                elementFromPointSpy.mockReturnValueOnce(positiveTarget)
                expect(() => expectHitTestable(hide, 'positive control')).not.toThrow()
            }

            // Negative controls: document.body, null, ancestor [role="menu"], other row, Hidden tabs button, wrong sibling menuitem.
            for (const [label, negativeTarget] of [
                ['document.body', document.body],
                ['null', null],
                ['ancestor menu container', menu],
                ['other row card', otherRow],
                ['Hidden tabs toggle', hiddenToggle],
                ['wrong sibling menuitem', mute],
            ] as const) {
                elementFromPointSpy.mockReturnValueOnce(negativeTarget)
                expect(() => expectHitTestable(hide, `negative ${label}`)).toThrow(/must hit the item itself or its descendant/)
            }
        } finally {
            elementFromPointSpy.mockRestore()
            tempSpan.remove()
        }
    })
})
