// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { initI18n } from '../../../src/i18n/config'
import DashboardMobileChatMode from '../../../src/components/dashboard/DashboardMobileChatMode'
import { TransportProvider } from '../../../src/context/TransportContext'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/components/dashboard/session-chat-controller', () => ({
    useSessionChatController: (conversation: ActiveConversation) => ({
        liveMessages: conversation.messages,
        hasLiveSnapshot: true,
        historyMessages: [],
        hasMoreHistory: false,
        historyError: null,
        loadHistoryPage: async () => {},
    }),
    getSessionChatSnapshotForConversation: () => null,
    useWarmSessionChatSnapshotVersion: () => 0,
}))

vi.mock('../../../src/hooks/useInteractivePrompt', () => ({
    useInteractivePrompt: () => ({
        promptSession: null,
        hasActivePrompt: false,
        isSubmitting: false,
        responseError: null,
        submit: async () => {},
        cancel: () => {},
        reopen: () => {},
    }),
}))

function makeConversation(
    overrides: Partial<ActiveConversation> & { tabKey: string; routeId: string },
): ActiveConversation {
    return {
        mode: 'chat',
        agentName: 'Codex',
        agentType: 'codex-cli',
        transport: 'pty',
        status: 'idle',
        title: 'Conversation',
        messages: [],
        displayPrimary: 'Conversation',
        displaySecondary: 'Codex',
        streamSource: 'native',
        connectionState: 'connected',
        ...overrides,
    }
}

function makeApprovalIde(
    overrides: Partial<DaemonData> & { id: string; daemonId: string; sessionId: string },
    approvalOverrides: Record<string, unknown> | null = {},
): DaemonData {
    const providerApproval = approvalOverrides === null
        ? null
        : {
            source: 'provider_modal',
            type: 'tool_permission',
            evidence: 'live',
            lifecycle: 'pending',
            modalKey: 'modal:worker-1',
            createdAt: 5_000,
            resolvedAt: null,
            actionable: true,
            sessionId: overrides.sessionId,
            providerType: 'codex-cli',
            description: '',
            buttons: ['Yes, proceed', 'No'],
            attemptId: 'attempt-1',
            generation: 2,
            ...approvalOverrides,
        }
    return {
        machineId: overrides.daemonId,
        type: 'codex-cli',
        transport: 'pty',
        status: 'waiting_approval',
        surfaceHidden: true,
        muted: true,
        activeChat: {
            id: `chat-${overrides.sessionId}`,
            status: 'waiting_approval',
            title: 'Worker',
            messages: [],
            activeModal: providerApproval && Array.isArray((providerApproval as any).buttons)
                ? { message: 'Tool permission request', buttons: (providerApproval as any).buttons }
                : undefined,
            providerApproval: providerApproval as any,
        },
        ...overrides,
    } as DaemonData
}

describe('DashboardMobileChatMode approvals flow', () => {
    let container: HTMLDivElement
    let root: Root
    let currentPath = ''

    function LocationTracker() {
        const location = useLocation()
        currentPath = `${location.pathname}${location.search}`
        return null
    }

    beforeEach(() => {
        ;(globalThis as any).ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
        localStorage.setItem('lang', 'en')
        initI18n()
        currentPath = ''
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    function renderMobileMode(props: Partial<React.ComponentProps<typeof DashboardMobileChatMode>> = {}) {
        const sendDaemonCommand = props.sendDaemonCommand ?? vi.fn(async () => ({ ok: true }))
        act(() => {
            root.render(
                <MemoryRouter initialEntries={['/dashboard']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                    <TransportProvider value={{ sendCommand: sendDaemonCommand }}>
                        <LocationTracker />
                        <DashboardMobileChatMode
                            conversations={[]}
                            hiddenConversations={[]}
                            ides={[]}
                            actionLogs={[]}
                            sendDaemonCommand={sendDaemonCommand}
                            setActionLogs={vi.fn()}
                            setCliViewModeOverrides={vi.fn()}
                            isStandalone={false}
                            onOpenHistory={vi.fn()}
                            onOpenRemote={vi.fn()}
                            onShowAllHiddenConversations={vi.fn()}
                            liveSessionInboxState={new Map()}
                            connectionStates={{ 'daemon-a': 'connected', 'daemon-b': 'connected' }}
                            {...props}
                        />
                    </TransportProvider>
                </MemoryRouter>,
            )
        })
        return { sendDaemonCommand }
    }

    it('hides the approvals entry when zero pending or only staged/resolved/question state exists', () => {
        const stagedOnlyIde = makeApprovalIde(
            { id: 'daemon-a:s1', daemonId: 'daemon-a', sessionId: 's1' },
            { source: 'owner_staged_proposal' },
        )
        const resolvedIde = makeApprovalIde(
            { id: 'daemon-a:s2', daemonId: 'daemon-a', sessionId: 's2' },
            { lifecycle: 'resolved', resolvedAt: 9_000 },
        )
        renderMobileMode({ ides: [stagedOnlyIde, resolvedIde] })

        expect(container.querySelector('[data-testid="mobile-approvals-entry"]')).toBeNull()
        expect(document.body.querySelector('[data-testid="mobile-approvals-sheet"]')).toBeNull()
    })

    it('opens PendingApprovalsInbox inline in a mobile sheet, preserves inbox/scroll/hidden-list state on dismiss, and avoids marking conversations read', async () => {
        const visibleConv = makeConversation({
            tabKey: 'daemon-a:visible-1',
            routeId: 'daemon-a:visible-1',
            daemonId: 'daemon-a',
            sessionId: 'visible-1',
            displayPrimary: 'Visible First Chat',
        })
        const hiddenWorkerConv = makeConversation({
            tabKey: 'daemon-b:hidden-worker',
            routeId: 'daemon-b:hidden-worker',
            daemonId: 'daemon-b',
            sessionId: 'hidden-worker',
            displayPrimary: 'Hidden Worker Chat',
        })
        const actionableHiddenIde = makeApprovalIde({
            id: 'daemon-b:hidden-worker',
            daemonId: 'daemon-b',
            sessionId: 'hidden-worker',
        })
        const setupAttentionIde = makeApprovalIde(
            {
                id: 'daemon-a:setup-only',
                daemonId: 'daemon-a',
                sessionId: 'setup-only',
            },
            {
                type: 'provider_setup',
                actionable: false,
                buttons: [],
                attemptId: null,
                generation: null,
                runtimeDirectory: '/tmp/worktree',
                displayedDirectory: '/tmp/project',
            },
        )
        const sendDaemonCommand = vi.fn(async () => ({ ok: true }))

        renderMobileMode({
            conversations: [visibleConv],
            hiddenConversations: [hiddenWorkerConv],
            ides: [actionableHiddenIde, setupAttentionIde],
            sendDaemonCommand,
            requestedMobileSection: 'chats',
        })

        // Switch to inbox view via requestedMobileSection, then clear initial command history.
        sendDaemonCommand.mockClear()

        const entry = container.querySelector('[data-testid="mobile-approvals-entry"]') as HTMLButtonElement
        expect(entry).not.toBeNull()
        expect(entry.textContent).toContain('2')

        // Expand hidden conversations and set scroll position on the inbox scroll container.
        const hiddenToggle = container.querySelector('[data-testid="mobile-hidden-tabs-toggle"]') as HTMLButtonElement
        expect(hiddenToggle).not.toBeNull()
        act(() => { hiddenToggle.click() })
        expect(hiddenToggle.getAttribute('aria-expanded')).toBe('true')
        expect(container.textContent).toContain('Hidden Worker Chat')

        const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
        expect(scrollContainer).not.toBeNull()
        scrollContainer.scrollTop = 180

        // Focus trigger before opening sheet (simulating keyboard activation).
        entry.focus()
        expect(document.activeElement).toBe(entry)

        // Open approvals sheet in-place.
        act(() => { entry.click() })

        expect(currentPath).toBe('/dashboard')
        const sheet = document.body.querySelector('[data-testid="mobile-approvals-sheet"]') as HTMLElement
        expect(sheet).not.toBeNull()
        expect(sheet.textContent).toContain('2 waiting · 1 actionable')
        expect(sheet.textContent).toContain('Provider setup decision')
        expect(sheet.textContent).toContain('/tmp/worktree')

        // Focus moves into the sheet and the covered inbox container is made inert.
        expect(sheet.contains(document.activeElement)).toBe(true)
        expect(entry.closest('[inert]')).not.toBeNull()

        // Tabbing at the boundaries wraps within the sheet rather than escaping to the covered inbox.
        const closeBtn = document.body.querySelector('[data-testid="mobile-approvals-close"]') as HTMLButtonElement
        expect(closeBtn).not.toBeNull()
        closeBtn.focus()
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
        })
        expect(sheet.contains(document.activeElement)).toBe(true)
        expect(document.activeElement).not.toBe(closeBtn)

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true, cancelable: true }))
        })
        expect(document.activeElement).toBe(closeBtn)

        // Dismiss sheet and verify focus returns to entry while inbox screen, scroll position, and expanded hidden list stay intact without marking any chat read.
        act(() => { closeBtn.click() })

        expect(document.body.querySelector('[data-testid="mobile-approvals-sheet"]')).toBeNull()
        expect(entry.closest('[inert]')).toBeNull()
        expect(document.activeElement).toBe(entry)
        expect(currentPath).toBe('/dashboard')
        expect(scrollContainer.scrollTop).toBe(180)
        expect(container.textContent).toContain('Hidden Worker Chat')
        expect(sendDaemonCommand).not.toHaveBeenCalledWith(
            expect.anything(),
            'mark_session_seen',
            expect.anything(),
        )

        // Re-open sheet, resolve the actionable decision with exact target+button, then resolve the remaining item and verify clean disappearance.
        act(() => { entry.click() })
        const sheetReopened = document.body.querySelector('[data-testid="mobile-approvals-sheet"]') as HTMLElement
        const proceedBtn = Array.from(sheetReopened.querySelectorAll('button')).find(
            button => button.textContent?.includes('Yes, proceed'),
        ) as HTMLButtonElement
        expect(proceedBtn).not.toBeUndefined()

        await act(async () => { proceedBtn.click() })
        expect(sendDaemonCommand).toHaveBeenCalledWith('daemon-b', 'resolve_action', {
            action: 'approve',
            sessionId: 'hidden-worker',
            approvalTarget: {
                modalKey: 'modal:worker-1',
                attemptId: 'attempt-1',
                generation: 2,
            },
            button: 'Yes, proceed',
            buttonIndex: 0,
        })

        // When the last pending decision resolves, both the sheet and the entry card disappear cleanly.
        renderMobileMode({
            conversations: [visibleConv],
            hiddenConversations: [hiddenWorkerConv],
            ides: [],
            sendDaemonCommand,
        })
        expect(document.body.querySelector('[data-testid="mobile-approvals-sheet"]')).toBeNull()
        expect(container.querySelector('[data-testid="mobile-approvals-entry"]')).toBeNull()
    })

    it('opens the exact hidden session from PendingApprovalsInbox without unhiding all hidden tabs or falling back to conversations[0]', () => {
        const visibleFirst = makeConversation({
            tabKey: 'daemon-a:shared-sess',
            routeId: 'daemon-a:shared-sess',
            daemonId: 'daemon-a',
            sessionId: 'shared-sess',
            displayPrimary: 'Unrelated First Visible Chat',
        })
        const hiddenTarget = makeConversation({
            tabKey: 'daemon-b:shared-sess',
            routeId: 'daemon-b:shared-sess',
            daemonId: 'daemon-b',
            sessionId: 'shared-sess',
            displayPrimary: 'Target Hidden Worker Chat',
        })
        const hiddenOther = makeConversation({
            tabKey: 'daemon-b:other-hidden',
            routeId: 'daemon-b:other-hidden',
            daemonId: 'daemon-b',
            sessionId: 'other-hidden',
            displayPrimary: 'Other Hidden Worker Chat',
        })
        const hiddenTargetIde = makeApprovalIde({
            id: 'daemon-b:shared-sess',
            daemonId: 'daemon-b',
            sessionId: 'shared-sess',
        })
        const sendDaemonCommand = vi.fn(async () => ({ ok: true }))
        const onRestoreHiddenConversation = vi.fn()
        const onShowAllHiddenConversations = vi.fn()

        renderMobileMode({
            conversations: [visibleFirst],
            hiddenConversations: [hiddenTarget, hiddenOther],
            ides: [hiddenTargetIde],
            sendDaemonCommand,
            onRestoreHiddenConversation,
            onShowAllHiddenConversations,
            requestedMobileSection: 'chats',
        })
        sendDaemonCommand.mockClear()

        const entry = container.querySelector('[data-testid="mobile-approvals-entry"]') as HTMLButtonElement
        act(() => { entry.click() })

        const sheet = document.body.querySelector('[data-testid="mobile-approvals-sheet"]') as HTMLElement
        const openSessionLink = sheet.querySelector('a[href*="/dashboard?activeTab="]') as HTMLAnchorElement
        expect(openSessionLink).not.toBeNull()
        expect(openSessionLink.getAttribute('href')).toBe('/dashboard?activeTab=session%3Adaemon-b%3Ashared-sess')

        // Modified click (Ctrl/Cmd-click) does not trigger in-app callback and leaves the machine-scoped href for browser navigation.
        let preventedByComponent = true
        const recordBubble = (event: MouseEvent) => {
            preventedByComponent = event.defaultPrevented
            event.preventDefault()
        }
        document.body.addEventListener('click', recordBubble, { once: true })
        const ctrlClickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
        act(() => {
            openSessionLink.dispatchEvent(ctrlClickEvent)
        })
        expect(preventedByComponent).toBe(false)
        expect(onRestoreHiddenConversation).not.toHaveBeenCalled()

        act(() => {
            openSessionLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        })

        // Sheet closes, only hiddenTarget is restored, and Target Hidden Worker Chat opens in chat room.
        expect(document.body.querySelector('[data-testid="mobile-approvals-sheet"]')).toBeNull()
        expect(onRestoreHiddenConversation).toHaveBeenCalledTimes(1)
        expect(onRestoreHiddenConversation).toHaveBeenCalledWith(hiddenTarget)
        expect(onShowAllHiddenConversations).not.toHaveBeenCalled()
        expect(container.textContent).toContain('Target Hidden Worker Chat')
        expect(container.textContent).not.toContain('Unrelated First Visible Chat')
        expect(sendDaemonCommand).toHaveBeenCalledTimes(1)
        expect(sendDaemonCommand).toHaveBeenCalledWith(
            'daemon-b',
            'mark_session_seen',
            expect.objectContaining({ sessionId: 'shared-sess' }),
        )
    })

    it('does not fall back to conversations[0] or mark it read when requestedActiveTabKey targets a missing, unknown-owner, or replaced runtime session', () => {
        const visibleFirst = makeConversation({
            tabKey: 'daemon-a:first',
            routeId: 'daemon-a:first',
            daemonId: 'daemon-a',
            sessionId: 'first',
            displayPrimary: 'First Visible Chat',
        })
        const unknownOwner = makeConversation({
            tabKey: 'unscoped-tab',
            routeId: 'unscoped-route',
            sessionId: 'shared-sess',
            displayPrimary: 'Unknown Owner Chat',
        })
        const replacedSession = makeConversation({
            tabKey: 'daemon-b:old-sess',
            routeId: 'daemon-b:old-sess',
            daemonId: 'daemon-b',
            sessionId: 'replacement-sess',
            displayPrimary: 'Replaced Runtime Chat',
        })
        const sendDaemonCommand = vi.fn(async () => ({ ok: true }))

        for (const requestedActiveTabKey of [
            'session:non-existent-session',
            'session:daemon-b:shared-sess',
            'session:daemon-b:old-sess',
        ]) {
            renderMobileMode({
                conversations: [visibleFirst, unknownOwner, replacedSession],
                hiddenConversations: [],
                ides: [],
                sendDaemonCommand,
                requestedActiveTabKey,
            })

            // Should stay on the inbox screen rather than opening an unrelated or replaced chat in the chat room.
            expect(container.querySelector('button[aria-label="Back"]')).toBeNull()
            expect(sendDaemonCommand).not.toHaveBeenCalledWith(
                expect.anything(),
                'mark_session_seen',
                expect.anything(),
            )
        }
    })
})
