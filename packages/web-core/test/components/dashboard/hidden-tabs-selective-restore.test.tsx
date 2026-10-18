// @vitest-environment jsdom
import { useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DashboardHeader from '../../../src/components/dashboard/DashboardHeader'
import DashboardMobileChatInbox from '../../../src/components/dashboard/DashboardMobileChatInbox'
import { storedCliPanelsToDrop } from '../../../src/components/dashboard/dashboardDockviewHydration'
import { BaseDaemonProvider } from '../../../src/context/BaseDaemonContext'
import { useConversationPrefs } from '../../../src/hooks/useConversationPrefs'
import { useDashboardConversations } from '../../../src/hooks/useDashboardConversations'
import { buildLiveSessionInboxStateMap, type MobileConversationListItem } from '../../../src/components/dashboard/DashboardMobileChatShared'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'

function makeDaemonFixtures(hiddenBySession: Record<string, boolean>): DaemonData[] {
    return [
        {
            id: 'daemon-1',
            daemonId: 'daemon-1',
            type: 'adhdev-daemon',
            machineId: 'daemon-1',
            machineName: 'Mac Studio',
            hostname: 'mac-studio',
            status: 'idle',
            _sessionListAuthoritative: true,
        } as DaemonData,
        {
            id: 'daemon-1:cli:sess-visible',
            daemonId: 'daemon-1',
            sessionId: 'sess-visible',
            providerSessionId: 'prov-visible',
            type: 'claude-cli',
            name: 'Claude Code',
            machineName: 'Mac Studio',
            status: 'idle',
            workspace: '/repo/assistant',
            surfaceHidden: false,
            lastUpdated: 1000,
            activeChat: {
                id: 'prov-visible',
                title: 'Pinned Assistant',
                status: 'idle',
                messages: [],
            },
        } as DaemonData,
        {
            id: 'daemon-1:cli:sess-hidden-working',
            daemonId: 'daemon-1',
            sessionId: 'sess-hidden-working',
            providerSessionId: 'prov-hidden-working',
            type: 'codex-cli',
            name: 'Codex',
            machineName: 'Mac Studio',
            status: 'generating',
            workspace: '/repo/mesh-worker',
            surfaceHidden: hiddenBySession['sess-hidden-working'] ?? true,
            lastUpdated: 2000,
            settings: {
                meshId: 'mesh-1',
                meshRole: 'worker',
                meshCoordinatorDaemonId: 'daemon-coord',
            },
            activeChat: {
                id: 'prov-hidden-working',
                title: 'Fix flaky worker stream',
                status: 'generating',
                messages: [],
            },
        } as DaemonData,
        {
            id: 'daemon-1:cli:sess-hidden-idle',
            daemonId: 'daemon-1',
            sessionId: 'sess-hidden-idle',
            providerSessionId: 'prov-hidden-idle',
            type: 'gemini-cli',
            name: 'Gemini CLI',
            machineName: 'Mac Studio',
            status: 'idle',
            workspace: '/repo/i18n-audit',
            surfaceHidden: hiddenBySession['sess-hidden-idle'] ?? true,
            lastUpdated: 1500,
            activeChat: {
                id: 'prov-hidden-idle',
                title: 'Audit locale keys',
                status: 'idle',
                messages: [],
            },
        } as DaemonData,
    ]
}

function toMobileItem(conversation: ActiveConversation): MobileConversationListItem {
    return {
        conversation,
        timestamp: 1000,
        preview: conversation.title || 'Ready',
        unread: false,
        requiresAction: false,
        isWorking: conversation.status === 'generating',
        inboxBucket: conversation.status === 'generating' ? 'working' : 'idle',
    }
}

function SelectiveRestoreHarness({
    initialHiddenBySession,
    sendDaemonCommand,
    onOpenedConversation,
}: {
    initialHiddenBySession: Record<string, boolean>
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<unknown>
    onOpenedConversation: (conversation: ActiveConversation) => void
}) {
    const [ides] = useState<DaemonData[]>(() => makeDaemonFixtures(initialHiddenBySession))
    const liveSessionInboxState = buildLiveSessionInboxStateMap(ides)
    const conversationPrefs = useConversationPrefs(liveSessionInboxState, sendDaemonCommand)
    const { conversations, visibleConversations } = useDashboardConversations({
        ides,
        connectionStates: { 'daemon-1': 'connected' },
        clearedTabs: {},
        isConversationHidden: conversationPrefs.isHidden,
    })
    const hiddenConversations = conversations.filter(conversation => conversationPrefs.isHidden(conversation))

    return (
        <DashboardMobileChatInbox
            section="chats"
            attentionItems={[]}
            unreadItems={[]}
            workingItems={visibleConversations.filter(c => c.status === 'generating').map(toMobileItem)}
            completedItems={visibleConversations.filter(c => c.status !== 'generating').map(toMobileItem)}
            hiddenConversations={hiddenConversations}
            machineCards={[]}
            getAvatarText={text => text[0] || '?'}
            actionLogs={[]}
            sendDaemonCommand={sendDaemonCommand}
            onOpenConversation={onOpenedConversation}
            onRestoreHiddenConversation={conversation => conversationPrefs.setHidden(conversation, false)}
            onShowHiddenConversation={conversation => {
                conversationPrefs.setHidden(conversation, false)
                onOpenedConversation(conversation)
            }}
            onShowAllHidden={() => {
                for (const conversation of hiddenConversations) {
                    conversationPrefs.setHidden(conversation, false)
                }
            }}
            onOpenMachine={vi.fn()}
            onOpenSettings={vi.fn()}
            onSectionChange={vi.fn()}
            wsStatus="connected"
        />
    )
}

describe('hidden tabs selective per-chat restore & open (mobile + desktop)', () => {
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

    it('expands the mobile hidden-tabs card to show each hidden chat with title/provider, machine/workspace, status, and Restore/Open actions', () => {
        const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true })
        const onOpenedConversation = vi.fn()

        act(() => {
            root.render(
                <SelectiveRestoreHarness
                    initialHiddenBySession={{ 'sess-hidden-working': true, 'sess-hidden-idle': true }}
                    sendDaemonCommand={sendDaemonCommand}
                    onOpenedConversation={onOpenedConversation}
                />,
            )
        })

        const toggle = container.querySelector<HTMLButtonElement>('[data-testid="mobile-hidden-tabs-toggle"]')
        const restoreAllBtn = container.querySelector<HTMLButtonElement>('[data-testid="mobile-hidden-tabs-restore-all"]')
        expect(toggle).not.toBeNull()
        expect(toggle?.getAttribute('aria-expanded')).toBe('false')
        expect(restoreAllBtn).not.toBeNull()
        expect(container.querySelector('[data-testid="mobile-hidden-tabs-list"]')).toBeNull()

        act(() => {
            toggle!.click()
        })

        expect(toggle?.getAttribute('aria-expanded')).toBe('true')
        const list = container.querySelector('[data-testid="mobile-hidden-tabs-list"]')
        expect(list).not.toBeNull()

        const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
        expect(rows).toHaveLength(2)

        const workingRow = rows.find(row => row.getAttribute('data-session-id') === 'sess-hidden-working')!
        const idleRow = rows.find(row => row.getAttribute('data-session-id') === 'sess-hidden-idle')!
        expect(workingRow).toBeTruthy()
        expect(idleRow).toBeTruthy()

        // Title, provider, workspace, machine name, and status badge
        expect(workingRow.textContent).toContain('Fix flaky worker stream')
        expect(workingRow.textContent).toContain('Codex')
        expect(workingRow.textContent).toContain('mesh-worker')
        expect(workingRow.textContent).toContain('mac-studio')
        expect(workingRow.querySelector('[data-testid="hidden-conversation-status"]')?.getAttribute('data-status')).toBe('in_progress')

        expect(idleRow.textContent).toContain('Audit locale keys')
        expect(idleRow.textContent).toContain('Gemini')
        expect(idleRow.textContent).toContain('i18n-audit')
        expect(idleRow.textContent).toContain('mac-studio')
        expect(idleRow.querySelector('[data-testid="hidden-conversation-status"]')?.getAttribute('data-status')).toBe('collapsed')

        // Touch-sized Restore and Open buttons exist on each row
        const restoreBtn = workingRow.querySelector<HTMLButtonElement>('[data-testid="hidden-conversation-restore"]')
        const openBtn = workingRow.querySelector<HTMLButtonElement>('[data-testid="hidden-conversation-open"]')
        expect(restoreBtn).not.toBeNull()
        expect(openBtn).not.toBeNull()
        expect(restoreBtn?.className).toContain('min-h-9')
        expect(openBtn?.className).toContain('min-h-9')
    })

    it('restores ONE hidden chat while keeping the others hidden and persists across reload with the same daemon/session keys', () => {
        const persistedHiddenBySession: Record<string, boolean> = {
            'sess-hidden-working': true,
            'sess-hidden-idle': true,
        }
        const sendDaemonCommand = vi.fn(async (_daemonId: string, type: string, data?: Record<string, unknown>) => {
            if (type === 'set_conversation_prefs' && typeof data?.sessionId === 'string' && typeof data?.hidden === 'boolean') {
                persistedHiddenBySession[data.sessionId] = data.hidden
            }
            return { success: true }
        })
        const onOpenedConversation = vi.fn()

        act(() => {
            root.render(
                <SelectiveRestoreHarness
                    initialHiddenBySession={persistedHiddenBySession}
                    sendDaemonCommand={sendDaemonCommand}
                    onOpenedConversation={onOpenedConversation}
                />,
            )
        })

        // Expand hidden tabs card
        act(() => {
            container.querySelector<HTMLButtonElement>('[data-testid="mobile-hidden-tabs-toggle"]')!.click()
        })

        // Click Restore on the working hidden chat only
        const workingRow = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
            .find(row => row.getAttribute('data-session-id') === 'sess-hidden-working')!
        act(() => {
            workingRow.querySelector<HTMLButtonElement>('[data-testid="hidden-conversation-restore"]')!.click()
        })

        // Only that one session received set_conversation_prefs { hidden: false } with its coordinator routing hint
        expect(sendDaemonCommand).toHaveBeenCalledTimes(1)
        expect(sendDaemonCommand).toHaveBeenCalledWith('daemon-1', 'set_conversation_prefs', {
            sessionId: 'sess-hidden-working',
            hidden: false,
            meshCoordinatorDaemonId: 'daemon-coord',
        })
        // Restore does not navigate away from the inbox
        expect(onOpenedConversation).not.toHaveBeenCalled()

        // The restored chat is now visible in the inbox list, while the other hidden chat stays in the hidden list
        const remainingHiddenRows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
        expect(remainingHiddenRows).toHaveLength(1)
        expect(remainingHiddenRows[0].getAttribute('data-session-id')).toBe('sess-hidden-idle')
        expect(container.textContent).toContain('Fix flaky worker stream')

        // Simulate a full reload using the persisted daemon session state
        act(() => root.unmount())
        root = createRoot(container)
        act(() => {
            root.render(
                <SelectiveRestoreHarness
                    initialHiddenBySession={persistedHiddenBySession}
                    sendDaemonCommand={sendDaemonCommand}
                    onOpenedConversation={onOpenedConversation}
                />,
            )
        })

        // Expand after reload: only sess-hidden-idle remains hidden; sess-hidden-working is in the visible list
        act(() => {
            container.querySelector<HTMLButtonElement>('[data-testid="mobile-hidden-tabs-toggle"]')!.click()
        })
        const rowsAfterReload = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
        expect(rowsAfterReload).toHaveLength(1)
        expect(rowsAfterReload[0].getAttribute('data-session-id')).toBe('sess-hidden-idle')
    })

    it('supports Open on one hidden chat (restores that chat and opens it immediately without unhiding others) and keeps Restore All working', () => {
        const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true })
        const onOpenedConversation = vi.fn()

        act(() => {
            root.render(
                <SelectiveRestoreHarness
                    initialHiddenBySession={{ 'sess-hidden-working': true, 'sess-hidden-idle': true }}
                    sendDaemonCommand={sendDaemonCommand}
                    onOpenedConversation={onOpenedConversation}
                />,
            )
        })

        act(() => {
            container.querySelector<HTMLButtonElement>('[data-testid="mobile-hidden-tabs-toggle"]')!.click()
        })

        const idleRow = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
            .find(row => row.getAttribute('data-session-id') === 'sess-hidden-idle')!
        act(() => {
            idleRow.querySelector<HTMLButtonElement>('[data-testid="hidden-conversation-open"]')!.click()
        })

        expect(sendDaemonCommand).toHaveBeenCalledTimes(1)
        expect(sendDaemonCommand).toHaveBeenCalledWith('daemon-1', 'set_conversation_prefs', {
            sessionId: 'sess-hidden-idle',
            hidden: false,
        })
        expect(onOpenedConversation).toHaveBeenCalledTimes(1)
        expect(onOpenedConversation.mock.calls[0][0].sessionId).toBe('sess-hidden-idle')

        // The other hidden chat is still hidden until Restore All is clicked
        const remainingRows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
        expect(remainingRows).toHaveLength(1)
        expect(remainingRows[0].getAttribute('data-session-id')).toBe('sess-hidden-working')

        act(() => {
            container.querySelector<HTMLButtonElement>('[data-testid="mobile-hidden-tabs-restore-all"]')!.click()
        })

        expect(sendDaemonCommand).toHaveBeenCalledTimes(2)
        expect(sendDaemonCommand).toHaveBeenLastCalledWith('daemon-1', 'set_conversation_prefs', {
            sessionId: 'sess-hidden-working',
            hidden: false,
            meshCoordinatorDaemonId: 'daemon-coord',
        })
        expect(container.querySelector('[data-testid="mobile-hidden-tabs-card"]')).toBeNull()
    })

    it('reuses the same shared list in desktop DashboardHeader with separate Restore and Open actions and does not resurrect ended sessions', () => {
        const ides = makeDaemonFixtures({ 'sess-hidden-working': true, 'sess-hidden-idle': true })
        const onRestoreConversation = vi.fn()
        const onShowConversation = vi.fn()
        const onHiddenOpenChange = vi.fn()

        let capturedVisibleTabKeys: string[] = []

        function DesktopHarness() {
            const liveSessionInboxState = buildLiveSessionInboxStateMap(ides)
            const conversationPrefs = useConversationPrefs(liveSessionInboxState, vi.fn().mockResolvedValue({ success: true }))
            const { conversations, visibleConversations, visibleTabKeys } = useDashboardConversations({
                ides,
                connectionStates: { 'daemon-1': 'connected' },
                clearedTabs: {},
                isConversationHidden: conversationPrefs.isHidden,
            })
            capturedVisibleTabKeys = visibleTabKeys
            const hiddenConversations = conversations.filter(c => conversationPrefs.isHidden(c))
            return (
                <BaseDaemonProvider value={{ ides, sendDaemonCommand: vi.fn(), wsStatus: 'connected', isConnected: true }}>
                    <DashboardHeader
                        activeConv={visibleConversations[0]}
                        wsStatus="connected"
                        isConnected
                        conversations={visibleConversations}
                        hiddenConversations={hiddenConversations}
                        onOpenHistory={vi.fn()}
                        onRestoreConversation={conv => {
                            conversationPrefs.setHidden(conv, false)
                            onRestoreConversation(conv)
                        }}
                        onShowConversation={conv => {
                            conversationPrefs.setHidden(conv, false)
                            onShowConversation(conv)
                        }}
                        onShowAllHidden={vi.fn()}
                        inboxOpen={false}
                        onInboxOpenChange={vi.fn()}
                        hiddenOpen
                        onHiddenOpenChange={onHiddenOpenChange}
                        notifications={[]}
                        notificationUnreadCount={0}
                        onOpenNotification={vi.fn()}
                        onMarkNotificationRead={vi.fn()}
                        onMarkNotificationUnread={vi.fn()}
                        onDeleteNotification={vi.fn()}
                    />
                </BaseDaemonProvider>
            )
        }

        act(() => {
            root.render(<DesktopHarness />)
        })

        const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
        expect(rows).toHaveLength(2)
        expect(rows.map(r => r.getAttribute('data-session-id'))).toEqual(['sess-hidden-working', 'sess-hidden-idle'])

        // Clicking Restore unhides without closing the popover or switching active tab
        act(() => {
            rows[0].querySelector<HTMLButtonElement>('[data-testid="hidden-conversation-restore"]')!.click()
        })
        expect(onRestoreConversation).toHaveBeenCalledTimes(1)
        expect(onRestoreConversation.mock.calls[0][0].sessionId).toBe('sess-hidden-working')
        expect(onShowConversation).not.toHaveBeenCalled()
        expect(onHiddenOpenChange).not.toHaveBeenCalled()

        // Ghost-tab check: after restoring sess-hidden-working, an ended session ('sess-ended-ghost')
        // and the still-hidden session ('sess-hidden-idle') remain dropped by storedCliPanelsToDrop,
        // while the restored live session is no longer dropped.
        const droppedPanels = storedCliPanelsToDrop(
            [
                'daemon-1:cli:sess-visible',
                'daemon-1:cli:sess-hidden-working',
                'daemon-1:cli:sess-hidden-idle',
                'daemon-1:cli:sess-ended-ghost',
            ],
            capturedVisibleTabKeys,
            ides,
        )
        expect(droppedPanels.has('daemon-1:cli:sess-ended-ghost')).toBe(true)
        expect(droppedPanels.has('daemon-1:cli:sess-hidden-idle')).toBe(true)
        expect(droppedPanels.has('daemon-1:cli:sess-hidden-working')).toBe(false)

        // Clicking Open on the remaining hidden row unhides + opens and closes the popover
        const remainingRows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hidden-conversation-row"]'))
        expect(remainingRows).toHaveLength(1)
        act(() => {
            remainingRows[0].querySelector<HTMLButtonElement>('[data-testid="hidden-conversation-open"]')!.click()
        })
        expect(onShowConversation).toHaveBeenCalledTimes(1)
        expect(onShowConversation.mock.calls[0][0].sessionId).toBe('sess-hidden-idle')
        expect(onHiddenOpenChange).toHaveBeenCalledWith(false)
    })
})
