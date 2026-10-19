import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom'
import '../../src/index.css'
import { initI18n } from '../../src/i18n/config'
import DashboardMobileChatInbox from '../../src/components/dashboard/DashboardMobileChatInbox'
import DashboardMobileChatMode from '../../src/components/dashboard/DashboardMobileChatMode'
import { DialogShell } from '../../src/components/ui/Dialog'
import LaunchConfirmDialog from '../../src/components/machine/LaunchConfirmDialog'
import { useDashboardActiveTabRequests } from '../../src/hooks/useDashboardActiveTabRequests'
import { useDashboardConversations } from '../../src/hooks/useDashboardConversations'
import { TransportProvider } from '../../src/context/TransportContext'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { DaemonData } from '../../src/types'

vi.mock('../../src/components/dashboard/session-chat-controller', () => ({
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

vi.mock('../../src/hooks/useInteractivePrompt', () => ({
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

const EVIDENCE_DIR = '/tmp/adhdev-rc24-mobile-followup-evidence'

function rect(element: Element) {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
}

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
        messages: [
            { id: 'm1', role: 'assistant', content: 'Ready for review in isolated fixture.', timestamp: 1_000 },
        ],
        displayPrimary: 'Conversation',
        displaySecondary: 'Codex',
        streamSource: 'native',
        connectionState: 'connected',
        ...overrides,
    }
}

it('hides the mobile approvals entry when zero/invalid and handles inline sheet open/dismiss and exact hidden-session navigation at 390x844', async () => {
    localStorage.setItem('lang', 'en')
    initI18n()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    host.style.cssText = 'height:100dvh;display:flex;flex-direction:column'
    document.body.append(host)
    const root = createRoot(host)
    const onOpenApprovals = vi.fn()

    async function renderInbox(width: number, pendingProviderApprovalCount: number) {
        await page.viewport(width, 844)
        await act(async () => root.render(
            <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <DashboardMobileChatInbox
                    section="chats"
                    attentionItems={[]}
                    unreadItems={[]}
                    workingItems={[]}
                    completedItems={[]}
                    hiddenConversations={[]}
                    machineCards={[]}
                    getAvatarText={(text) => text[0] || '?'}
                    actionLogs={[]}
                    sendDaemonCommand={vi.fn()}
                    onOpenConversation={vi.fn()}
                    onShowAllHidden={vi.fn()}
                    onOpenMachine={vi.fn()}
                    onOpenSettings={vi.fn()}
                    onSectionChange={vi.fn()}
                    wsStatus="connected"
                    isStandalone={false}
                    pendingProviderApprovalCount={pendingProviderApprovalCount}
                    onOpenApprovals={onOpenApprovals}
                />
            </MemoryRouter>,
        ))
    }

    try {
        // 1. Zero / invalid counts hide the warning card completely.
        for (const invalidCount of [0, -1, Number.NaN]) {
            await renderInbox(390, invalidCount)
            expect(host.querySelector('[data-testid="mobile-approvals-entry"]')).toBeNull()
        }
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/after-zero-pending-clean-inbox-390x844.png` })
        })

        // 2. Positive pending counts keep the entry >= 44px tall across mobile/desktop widths.
        for (const width of [375, 390, 1280]) {
            await renderInbox(width, 2)
            const entry = host.querySelector('[data-testid="mobile-approvals-entry"]')
            expect(entry).not.toBeNull()
            const box = rect(entry!)
            expect(box.height).toBeGreaterThanOrEqual(44)
            expect(box.width).toBeGreaterThan(200)
            if (width <= 390) {
                expect(entry!.textContent).toContain('Approval status')
                expect(entry!.textContent).toContain('2')
            }
        }

        // 3. Full mobile dashboard flow at 390x844: open/dismiss preserves inbox, scroll, and hidden list; Open session reaches exact hidden worker.
        await page.viewport(390, 844)
        const visibleConversations = Array.from({ length: 8 }, (_, idx) => makeConversation({
            tabKey: `daemon-a:chat-${idx}`,
            routeId: `daemon-a:chat-${idx}`,
            daemonId: 'daemon-a',
            sessionId: idx === 0 ? 'shared-sess' : `chat-${idx}`,
            displayPrimary: idx === 0 ? 'Unrelated First Visible Chat' : `Workspace Chat ${idx}`,
            lastUpdated: 10_000 - idx * 100,
        }))
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
        const ides: DaemonData[] = [
            {
                id: 'daemon-b:shared-sess',
                daemonId: 'daemon-b',
                machineId: 'daemon-b',
                hostname: 'Worker Node B',
                sessionId: 'shared-sess',
                type: 'codex-cli',
                transport: 'pty',
                status: 'waiting_approval',
                surfaceHidden: true,
                muted: true,
                activeChat: {
                    id: 'chat-shared',
                    status: 'waiting_approval',
                    title: 'Worker',
                    messages: [],
                    activeModal: { message: 'Synthetic permission check', buttons: ['Yes, proceed', 'No'] },
                    providerApproval: {
                        source: 'provider_modal',
                        type: 'tool_permission',
                        evidence: 'live',
                        lifecycle: 'pending',
                        modalKey: 'modal:worker-b',
                        createdAt: Date.now() - 45_000,
                        resolvedAt: null,
                        actionable: true,
                        sessionId: 'shared-sess',
                        providerType: 'codex-cli',
                        description: '',
                        buttons: ['Yes, proceed', 'No'],
                        attemptId: 'attempt-b',
                        generation: 1,
                    },
                },
            } as DaemonData,
            {
                id: 'daemon-a:setup-only',
                daemonId: 'daemon-a',
                machineId: 'daemon-a',
                hostname: 'Primary Node A',
                sessionId: 'setup-only',
                type: 'claude-cli',
                transport: 'pty',
                status: 'waiting_approval',
                surfaceHidden: true,
                activeChat: {
                    id: 'chat-setup',
                    status: 'waiting_approval',
                    title: 'Setup',
                    messages: [],
                    providerApproval: {
                        source: 'provider_modal',
                        type: 'provider_setup',
                        evidence: 'live',
                        lifecycle: 'pending',
                        modalKey: 'modal:setup-a',
                        createdAt: Date.now() - 120_000,
                        resolvedAt: null,
                        actionable: false,
                        sessionId: 'setup-only',
                        providerType: 'claude-cli',
                        description: '',
                        buttons: [],
                        attemptId: null,
                        generation: null,
                        runtimeDirectory: '/tmp/worktree-b',
                        displayedDirectory: '/tmp/project-a',
                    },
                },
            } as DaemonData,
        ]
        const sendDaemonCommand = vi.fn(async () => ({ ok: true }))
        const onRestoreHiddenConversation = vi.fn()
        const onShowAllHiddenConversations = vi.fn()
        let currentRoute = ''
        function RouteObserver() {
            const loc = useLocation()
            currentRoute = `${loc.pathname}${loc.search}`
            return null
        }

        await act(async () => root.render(
            <MemoryRouter key="dashboard-mode" initialEntries={['/dashboard']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <TransportProvider value={{ sendCommand: sendDaemonCommand }}>
                    <RouteObserver />
                    <DashboardMobileChatMode
                        conversations={visibleConversations}
                        hiddenConversations={[hiddenTarget, hiddenOther]}
                        ides={ides}
                        actionLogs={[]}
                        sendDaemonCommand={sendDaemonCommand}
                        setActionLogs={vi.fn()}
                        setCliViewModeOverrides={vi.fn()}
                        isStandalone={false}
                        requestedMobileSection="chats"
                        onOpenHistory={vi.fn()}
                        onOpenRemote={vi.fn()}
                        onShowAllHiddenConversations={onShowAllHiddenConversations}
                        onRestoreHiddenConversation={onRestoreHiddenConversation}
                        liveSessionInboxState={new Map()}
                        connectionStates={{ 'daemon-a': 'connected', 'daemon-b': 'connected' }}
                    />
                </TransportProvider>
            </MemoryRouter>,
        ))
        sendDaemonCommand.mockClear()

        const hiddenToggle = host.querySelector('[data-testid="mobile-hidden-tabs-toggle"]') as HTMLButtonElement
        expect(hiddenToggle).not.toBeNull()
        await act(async () => { hiddenToggle.click() })
        expect(hiddenToggle.getAttribute('aria-expanded')).toBe('true')

        const scrollContainer = host.querySelector('.overflow-y-auto') as HTMLDivElement
        expect(scrollContainer).not.toBeNull()
        scrollContainer.scrollTop = 96

        const entry = host.querySelector('[data-testid="mobile-approvals-entry"]') as HTMLButtonElement
        expect(entry).not.toBeNull()
        expect(rect(entry).height).toBeGreaterThanOrEqual(44)
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/after-positive-pending-entry-390x844.png` })
        })

        // Focus entry before opening sheet (as keyboard or tap activation does) with inbox scrolled to 96.
        entry.focus()
        scrollContainer.scrollTop = 96
        expect(document.activeElement).toBe(entry)
        expect(scrollContainer.scrollTop).toBe(96)

        // Open sheet inline in DashboardMobileChatMode.
        await act(async () => { entry.click() })
        expect(currentRoute).toBe('/dashboard')
        const sheet = document.body.querySelector('[data-testid="mobile-approvals-sheet"]') as HTMLElement
        expect(sheet).not.toBeNull()
        expect(sheet.textContent).toContain('2 waiting · 1 actionable')

        // Initial focus moves into the sheet and the covered inbox is made inert.
        expect(sheet.contains(document.activeElement)).toBe(true)
        expect(entry.closest('[inert]')).not.toBeNull()

        // Real keyboard Tab / Shift+Tab navigation stays trapped inside the sheet and never scrolls the covered inbox.
        for (let i = 0; i < 6; i += 1) {
            await userEvent.tab()
            expect(sheet.contains(document.activeElement)).toBe(true)
            expect(scrollContainer.scrollTop).toBe(96)
        }
        await userEvent.tab({ shift: true })
        expect(sheet.contains(document.activeElement)).toBe(true)
        expect(scrollContainer.scrollTop).toBe(96)

        // Machine-scoped href is present on the Open session link for modified/middle-click/new-tab navigation.
        const initialOpenSessionLink = sheet.querySelector('a[href*="shared-sess"]') as HTMLAnchorElement
        expect(initialOpenSessionLink).not.toBeNull()
        expect(initialOpenSessionLink.getAttribute('href')).toBe('/dashboard?activeTab=session%3Adaemon-b%3Ashared-sess')

        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/after-open-approvals-sheet-390x844.png` })
        })

        // Dismiss via Escape first: focus returns to entry and scrollTop stays 96.
        await act(async () => {
            await userEvent.keyboard('{Escape}')
        })
        expect(document.body.querySelector('[data-testid="mobile-approvals-sheet"]')).toBeNull()
        expect(entry.closest('[inert]')).toBeNull()
        expect(document.activeElement).toBe(entry)
        expect(scrollContainer.scrollTop).toBe(96)

        // Re-open and dismiss via Close button: verify inbox state, focus restoration, scroll, and expanded hidden list remain intact without marking read.
        await act(async () => { entry.click() })
        const closeBtn = document.body.querySelector('[data-testid="mobile-approvals-close"]') as HTMLButtonElement
        expect(closeBtn).not.toBeNull()
        expect(rect(closeBtn).height).toBeGreaterThanOrEqual(44)
        await act(async () => { closeBtn.click() })
        expect(document.body.querySelector('[data-testid="mobile-approvals-sheet"]')).toBeNull()
        expect(document.activeElement).toBe(entry)
        expect(currentRoute).toBe('/dashboard')
        expect(scrollContainer.scrollTop).toBe(96)
        expect(hiddenToggle.getAttribute('aria-expanded')).toBe('true')
        expect(sendDaemonCommand).not.toHaveBeenCalledWith(expect.anything(), 'mark_session_seen', expect.anything())
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/after-dismiss-sheet-preserved-inbox-390x844.png` })
        })

        // Re-open sheet and tap Open session on the hidden worker -> restores only hiddenTarget and opens it in chat room.
        await act(async () => { entry.click() })
        const reopenedSheet = document.body.querySelector('[data-testid="mobile-approvals-sheet"]') as HTMLElement
        const openSessionLink = reopenedSheet.querySelector('a[href*="shared-sess"]') as HTMLAnchorElement
        expect(openSessionLink).not.toBeNull()
        expect(openSessionLink.getAttribute('href')).toBe('/dashboard?activeTab=session%3Adaemon-b%3Ashared-sess')
        await act(async () => {
            openSessionLink.click()
        })

        expect(document.body.querySelector('[data-testid="mobile-approvals-sheet"]')).toBeNull()
        expect(onRestoreHiddenConversation).toHaveBeenCalledTimes(1)
        expect(onRestoreHiddenConversation).toHaveBeenCalledWith(hiddenTarget)
        expect(onShowAllHiddenConversations).not.toHaveBeenCalled()
        expect(host.textContent).toContain('Target Hidden Worker Chat')
        expect(host.textContent).not.toContain('Unrelated First Visible Chat')
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/after-open-exact-hidden-session-390x844.png` })
        })
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})

it('verifies full URL->canonical CLI tabKey handoff, CSS-hidden first button, simultaneous nested DialogShells, and bare portaled LaunchConfirmDialog at 390x844', async () => {
    await page.viewport(390, 844)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.setItem('lang', 'en')
    initI18n()

    const host = document.createElement('div')
    host.className = 'app-layout'
    document.body.appendChild(host)
    const root = createRoot(host)

    try {
        // 1. Full URL -> useDashboardConversations -> useDashboardActiveTabRequests -> DashboardMobileChatMode handoff with production daemon:cli:session tabKeys.
        const ideVisibleA: DaemonData = {
            id: 'daemon-a:cli:shared-sess',
            daemonId: 'daemon-a',
            machineId: 'daemon-a',
            hostname: 'Node A',
            sessionId: 'shared-sess',
            type: 'codex-cli',
            transport: 'pty',
            mode: 'chat',
            status: 'idle',
            activeChat: {
                id: 'chat-a',
                title: 'Visible Node A Chat',
                status: 'idle',
                messages: [{ id: 'm1', role: 'assistant', content: 'A', index: 0, timestamp: 1 }],
            },
        } as DaemonData
        const ideHiddenB: DaemonData = {
            id: 'daemon-b:cli:shared-sess',
            daemonId: 'daemon-b',
            machineId: 'daemon-b',
            hostname: 'Node B',
            sessionId: 'shared-sess',
            type: 'codex-cli',
            transport: 'pty',
            mode: 'chat',
            status: 'waiting_approval',
            surfaceHidden: true,
            activeChat: {
                id: 'chat-b',
                title: 'Hidden Node B Worker Chat',
                status: 'waiting_approval',
                messages: [{ id: 'm2', role: 'assistant', content: 'B', index: 0, timestamp: 2 }],
            },
        } as DaemonData
        const sendDaemonCommand = vi.fn(async () => ({ ok: true }))
        const onRestoreHiddenConversation = vi.fn()

        function FullUrlHandoffHarness() {
            const [searchParams, setSearchParams] = useSearchParams()
            const { conversations, visibleConversations, resolveConversationBySessionId } = useDashboardConversations({
                ides: [ideVisibleA, ideHiddenB],
                connectionStates: { 'daemon-a': 'connected', 'daemon-b': 'connected' },
                clearedTabs: {},
                isConversationHidden: conv => conv.daemonId === 'daemon-b',
            })
            const hiddenList = conversations.filter(
                conv => !visibleConversations.some(vis => vis.tabKey === conv.tabKey),
            )
            const { requestedMobileTabKey, consumeRequestedActiveTab } = useDashboardActiveTabRequests({
                isMobile: true,
                urlActiveTab: searchParams.get('activeTab'),
                resolveConversationBySessionId,
                setSearchParams,
            })
            return (
                <DashboardMobileChatMode
                    conversations={visibleConversations}
                    hiddenConversations={hiddenList}
                    ides={[ideVisibleA, ideHiddenB]}
                    actionLogs={[]}
                    sendDaemonCommand={sendDaemonCommand}
                    setActionLogs={vi.fn()}
                    setCliViewModeOverrides={vi.fn()}
                    isStandalone={false}
                    requestedActiveTabKey={requestedMobileTabKey}
                    onRequestedActiveTabConsumed={consumeRequestedActiveTab}
                    onOpenHistory={vi.fn()}
                    onOpenRemote={vi.fn()}
                    onShowAllHiddenConversations={vi.fn()}
                    onRestoreHiddenConversation={onRestoreHiddenConversation}
                    liveSessionInboxState={new Map()}
                    connectionStates={{ 'daemon-a': 'connected', 'daemon-b': 'connected' }}
                />
            )
        }

        await act(async () => root.render(
            <MemoryRouter key="full-url-handoff" initialEntries={['/dashboard?activeTab=session%3Adaemon-b%3Ashared-sess']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <TransportProvider value={{ sendCommand: sendDaemonCommand }}>
                    <FullUrlHandoffHarness />
                </TransportProvider>
            </MemoryRouter>,
        ))

        expect(onRestoreHiddenConversation).toHaveBeenCalledTimes(1)
        expect(onRestoreHiddenConversation.mock.calls[0]?.[0]?.tabKey).toBe('daemon-b:cli:shared-sess')
        expect(host.textContent).toContain('Hidden Node B Worker Chat')
        expect(host.textContent).not.toContain('Visible Node A Chat')
        expect(sendDaemonCommand).toHaveBeenCalledTimes(1)
        expect(sendDaemonCommand).toHaveBeenCalledWith(
            'daemon-b',
            'mark_session_seen',
            expect.objectContaining({ sessionId: 'shared-sess' }),
        )
        await act(async () => {
            await page.screenshot({ path: `${EVIDENCE_DIR}/after-full-url-canonical-cli-tab-handoff-390x844.png` })
        })

        // Also verify full URL handoff for a visible CLI session (daemon-a:cli:shared-sess) without restoring hidden sessions.
        sendDaemonCommand.mockClear()
        onRestoreHiddenConversation.mockClear()
        await act(async () => root.render(
            <MemoryRouter key="full-url-handoff-visible" initialEntries={['/dashboard?activeTab=session%3Adaemon-a%3Ashared-sess']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <TransportProvider value={{ sendCommand: sendDaemonCommand }}>
                    <FullUrlHandoffHarness />
                </TransportProvider>
            </MemoryRouter>,
        ))
        expect(onRestoreHiddenConversation).not.toHaveBeenCalled()
        expect(host.textContent).toContain('Visible Node A Chat')
        expect(sendDaemonCommand).toHaveBeenCalledTimes(1)
        expect(sendDaemonCommand).toHaveBeenCalledWith(
            'daemon-a',
            'mark_session_seen',
            expect.objectContaining({ sessionId: 'shared-sess' }),
        )

        // 2. CSS-hidden first button inside DialogShell is skipped on initial focus and Tab.
        await act(async () => root.render(
            <DialogShell ariaLabel="hidden-controls-probe" onClose={() => {}}>
                <div style={{ display: 'none' }}>
                    <button data-review-hidden>Hidden</button>
                </div>
                <button data-review-visible>Visible</button>
            </DialogShell>,
        ))
        const visibleBtn = document.body.querySelector('[data-review-visible]') as HTMLButtonElement
        expect(document.activeElement).toBe(visibleBtn)
        await userEvent.tab()
        expect(document.activeElement).toBe(visibleBtn)

        // 3. Nested DialogShells mounted together keep the inner shell topmost and focused.
        await act(async () => root.render(
            <DialogShell ariaLabel="review-outer" onClose={() => {}}>
                <button>Outer</button>
                <DialogShell ariaLabel="review-inner" onClose={() => {}}>
                    <button data-review-inner>Inner</button>
                </DialogShell>
            </DialogShell>,
        ))
        const innerShell = document.body.querySelector('[aria-label="review-inner"]') as HTMLElement
        const outerShell = document.body.querySelector('[aria-label="review-outer"]') as HTMLElement
        expect(innerShell.closest('[inert]')).toBeNull()
        expect(outerShell.closest('[inert]')).not.toBeNull()
        expect(innerShell.contains(document.activeElement)).toBe(true)

        // 4. Bare portaled LaunchConfirmDialog above DialogShell traps Tab/Shift+Tab, marks covered parent inert, and restores on close.
        const parentCloseSpy = vi.fn()
        function PortalFixture() {
            const [child, setChild] = useState(false)
            return (
                <>
                    <DialogShell ariaLabel="launch-parent" onClose={parentCloseSpy}>
                        <button data-review-launch-trigger onClick={() => setChild(true)}>
                            Open nested confirmation
                        </button>
                    </DialogShell>
                    {child && (
                        <LaunchConfirmDialog
                            title="Review confirmation"
                            description="Disposable fixture"
                            details={[]}
                            onConfirm={() => {}}
                            onCancel={() => setChild(false)}
                        />
                    )}
                </>
            )
        }
        await act(async () => root.render(<PortalFixture />))
        const launchParent = document.body.querySelector('[aria-label="launch-parent"]') as HTMLElement
        const launchTrigger = document.body.querySelector('[data-review-launch-trigger]') as HTMLButtonElement
        expect(launchParent.closest('[inert]')).toBeNull()
        expect(document.activeElement).toBe(launchTrigger)

        await act(async () => {
            launchTrigger.click()
        })
        const launchDialog = document.body.querySelector('[role="dialog"][aria-labelledby="launch-confirm-title"]') as HTMLElement
        expect(launchDialog).not.toBeNull()
        expect(launchDialog.closest('[inert]')).toBeNull()
        expect(launchParent.closest('[inert]')).not.toBeNull()
        const launchBtn = launchDialog.querySelector('button') as HTMLButtonElement
        launchBtn.focus()
        expect(launchDialog.contains(document.activeElement)).toBe(true)

        for (let step = 0; step < 6; step += 1) {
            await userEvent.tab()
            expect(launchDialog.contains(document.activeElement)).toBe(true)
            expect(launchParent.contains(document.activeElement)).toBe(false)
            expect(document.activeElement).not.toBe(document.body)
        }
        for (let step = 0; step < 4; step += 1) {
            await userEvent.tab({ shift: true })
            expect(launchDialog.contains(document.activeElement)).toBe(true)
            expect(launchParent.contains(document.activeElement)).toBe(false)
            expect(document.activeElement).not.toBe(document.body)
        }

        await act(async () => {
            await userEvent.keyboard('{Escape}')
        })
        expect(parentCloseSpy).not.toHaveBeenCalled()
        expect(document.body.querySelector('[role="dialog"][aria-labelledby="launch-confirm-title"]')).not.toBeNull()

        await act(async () => {
            launchBtn.click()
        })
        expect(document.body.querySelector('[role="dialog"][aria-labelledby="launch-confirm-title"]')).toBeNull()
        expect(launchParent.closest('[inert]')).toBeNull()
        expect(document.activeElement).toBe(launchTrigger)
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})
