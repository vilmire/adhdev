// @vitest-environment jsdom
//
// Mobile inbox row actions (UI simplification 2026-09-27): Mute / Hide / Stop
// live in one "…" row menu; Hide acts immediately — no confirm dialog — and
// offers Undo in a toast, which restores exactly that conversation.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DashboardMobileChatInbox from '../../../src/components/dashboard/DashboardMobileChatInbox'
import { eventManager, type ToastConfig } from '../../../src/managers/EventManager'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { MobileConversationListItem } from '../../../src/components/dashboard/DashboardMobileChatShared'

function conversation(): ActiveConversation {
    return {
        routeId: 'daemon-1',
        sessionId: 'session-1',
        daemonId: 'daemon-1',
        agentName: 'Codex',
        agentType: 'codex',
        status: 'idle',
        title: 'Refactor mobile inbox',
        messages: [],
        workspaceName: 'adhdev',
        displayPrimary: 'Refactor mobile inbox',
        displaySecondary: 'Codex · adhdev',
        streamSource: 'native',
        tabKey: 'daemon-1:session-1',
    } as ActiveConversation
}

function item(conv: ActiveConversation): MobileConversationListItem {
    return { conversation: conv, timestamp: Date.now(), preview: 'preview', unread: false, requiresAction: false, isWorking: false, inboxBucket: 'idle' } as MobileConversationListItem
}

describe('mobile inbox — "…" row menu, hide with Undo', () => {
    let container: HTMLDivElement
    let root: Root
    let toasts: ToastConfig[]
    let unsubscribe: () => void

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        toasts = []
        unsubscribe = eventManager.onToast(toast => { toasts.push(toast) })
    })

    afterEach(() => {
        unsubscribe()
        act(() => root.unmount())
        container.remove()
    })

    function render(props: Record<string, unknown>) {
        const conv = conversation()
        act(() => root.render(
            <DashboardMobileChatInbox
                section="chats"
                attentionItems={[]}
                unreadItems={[]}
                workingItems={[]}
                completedItems={[item(conv)]}
                hiddenConversations={[]}
                machineCards={[]}
                getAvatarText={() => 'C'}
                actionLogs={[]}
                sendDaemonCommand={vi.fn()}
                onOpenConversation={vi.fn()}
                onShowAllHidden={vi.fn()}
                onOpenMachine={vi.fn()}
                onOpenSettings={vi.fn()}
                onSectionChange={vi.fn()}
                wsStatus="connected"
                {...props}
            />,
        ))
        return conv
    }

    const menuButton = () => container.querySelector<HTMLButtonElement>('.mobile-inbox-row-menu-button')!
    const menuItem = (cls: string) => container.querySelector<HTMLButtonElement>(`[role="menu"] .${cls}`)

    it('one "…" per row; Mute, Hide and Stop appear only inside the opened menu', () => {
        render({ onHideConversation: vi.fn(), onStopCli: vi.fn(), onToggleMuteConversation: vi.fn(), isConversationMuted: () => false })
        expect(container.querySelectorAll('.mobile-inbox-row-menu-button')).toHaveLength(1)
        expect(menuItem('mobile-inbox-hide-button')).toBeNull()
        act(() => menuButton().click())
        expect(menuItem('mobile-inbox-mute-button')).not.toBeNull()
        expect(menuItem('mobile-inbox-hide-button')).not.toBeNull()
        expect(menuItem('mobile-inbox-stop-button')).not.toBeNull()
    })

    it('Hide acts at once (no confirm dialog) and its toast Undo restores that conversation', () => {
        const onHideConversation = vi.fn()
        const onShowHiddenConversation = vi.fn()
        const onShowAllHidden = vi.fn()
        const conv = render({ onHideConversation, onShowHiddenConversation, onShowAllHidden })
        act(() => menuButton().click())
        act(() => menuItem('mobile-inbox-hide-button')!.click())

        expect(onHideConversation).toHaveBeenCalledTimes(1)
        expect(onHideConversation.mock.calls[0][0].tabKey).toBe(conv.tabKey)
        expect(document.body.querySelector('[role="dialog"]')).toBeNull()

        expect(toasts).toHaveLength(1)
        expect(toasts[0].message).toBe('Hid Refactor mobile inbox')
        const undo = toasts[0].actions?.find(action => action.label === 'Undo')
        expect(undo).toBeTruthy()
        undo!.onClick()
        expect(onShowHiddenConversation).toHaveBeenCalledTimes(1)
        expect(onShowHiddenConversation.mock.calls[0][0].tabKey).toBe(conv.tabKey)
        expect(onShowAllHidden).not.toHaveBeenCalled()
    })

    it('Stop keeps its own flow (the host confirms) — the menu only forwards it', () => {
        const onStopCli = vi.fn()
        render({ onStopCli })
        act(() => menuButton().click())
        act(() => menuItem('mobile-inbox-stop-button')!.click())
        expect(onStopCli).toHaveBeenCalledTimes(1)
        expect(toasts).toHaveLength(0)
    })
})
