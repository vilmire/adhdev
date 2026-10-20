// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { initI18n } from '../../../src/i18n/config'
import DashboardMobileApprovalsLink from '../../../src/components/dashboard/DashboardMobileApprovalsLink'
import DashboardMobileChatInbox from '../../../src/components/dashboard/DashboardMobileChatInbox'
import Approvals from '../../../src/pages/Approvals'
import { TransportProvider } from '../../../src/context/TransportContext'
import PendingApprovalsInbox from '../../../src/components/MeshGraph/PendingApprovalsInbox'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const daemonState = vi.hoisted(() => ({
    ides: [] as any[],
    connectionStates: {} as Record<string, string>,
    initialLoaded: true,
}))

vi.mock('../../../src/compat', () => ({
    useDaemons: () => daemonState,
}))

describe('mobile approvals discoverability', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        daemonState.ides = []
        daemonState.connectionStates = {}
        daemonState.initialLoaded = true
        localStorage.setItem('lang', 'en')
        initI18n()
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    function renderInbox(overrides: Record<string, unknown> = {}) {
        act(() => root.render(
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
                    pendingProviderApprovalCount={0}
                    onOpenApprovals={vi.fn()}
                    {...overrides}
                />
            </MemoryRouter>,
        ))
    }

    it('omits the cloud approvals entry for zero, negative, non-finite, or invalid counts', () => {
        for (const invalidCount of [0, -1, -99, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined as unknown as number]) {
            renderInbox({ pendingProviderApprovalCount: invalidCount })
            expect(container.querySelector('[data-testid="mobile-approvals-entry"]')).toBeNull()
            const linkHtml = renderToStaticMarkup(createElement(DashboardMobileApprovalsLink, {
                pendingCount: invalidCount,
                onOpen: () => {},
            }))
            expect(linkHtml).toBe('')
        }
    })

    it('shows roster-derived pending count when greater than zero and disappears when resolved to zero', () => {
        renderInbox({ pendingProviderApprovalCount: 2 })
        const entry = container.querySelector('[data-testid="mobile-approvals-entry"]')
        expect(entry).not.toBeNull()
        expect(entry!.textContent).toContain('Approval status')
        expect(entry!.textContent).toContain('2')

        renderInbox({ pendingProviderApprovalCount: 0 })
        expect(container.querySelector('[data-testid="mobile-approvals-entry"]')).toBeNull()
    })

    it('calls onOpenApprovals when tapped with positive pending count', () => {
        const onOpenApprovals = vi.fn()
        renderInbox({ pendingProviderApprovalCount: 1, onOpenApprovals })
        const entry = container.querySelector('[data-testid="mobile-approvals-entry"]') as HTMLButtonElement
        expect(entry).not.toBeNull()
        act(() => { entry.click() })
        expect(onOpenApprovals).toHaveBeenCalledTimes(1)
    })

    it('omits the entry on standalone (no /approvals route)', () => {
        renderInbox({ isStandalone: true, pendingProviderApprovalCount: 3, onOpenApprovals: undefined })
        expect(container.querySelector('[data-testid="mobile-approvals-entry"]')).toBeNull()
    })

    it('renders the approvals page zero-pending empty copy and navigates in-app on Open session', () => {
        let currentLocation = ''
        function LocationProbe() {
            const location = useLocation()
            currentLocation = `${location.pathname}${location.search}`
            return null
        }

        act(() => root.render(
            <MemoryRouter initialEntries={['/approvals']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <TransportProvider value={{ sendCommand: vi.fn() }}>
                    <LocationProbe />
                    <Approvals />
                </TransportProvider>
            </MemoryRouter>,
        ))
        expect(container.textContent).toContain('Approvals')
        expect(container.textContent).toContain('No sessions are awaiting an approval decision')

        daemonState.ides = [{
            id: 'node-b:sess-hidden',
            daemonId: 'node-b',
            machineId: 'node-b',
            sessionId: 'sess-hidden',
            type: 'codex-cli',
            transport: 'pty',
            status: 'waiting_approval',
            surfaceHidden: true,
            activeChat: {
                id: 'chat-1',
                status: 'waiting_approval',
                title: 'Worker',
                messages: [],
                activeModal: { message: 'Run tool', buttons: ['Approve', 'Reject'] },
                providerApproval: {
                    source: 'provider_modal',
                    type: 'tool_permission',
                    evidence: 'live',
                    lifecycle: 'pending',
                    modalKey: 'modal:1',
                    createdAt: 1000,
                    resolvedAt: null,
                    actionable: true,
                    sessionId: 'sess-hidden',
                    providerType: 'codex-cli',
                    description: '',
                    buttons: ['Approve', 'Reject'],
                    attemptId: 'att-1',
                    generation: 1,
                },
            },
        }]
        daemonState.connectionStates = { 'node-b': 'connected' }

        act(() => root.render(
            <MemoryRouter initialEntries={['/approvals']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <TransportProvider value={{ sendCommand: vi.fn() }}>
                    <LocationProbe />
                    <Approvals />
                </TransportProvider>
            </MemoryRouter>,
        ))

        const openLink = container.querySelector('a[href*="/dashboard?activeTab="]') as HTMLAnchorElement
        expect(openLink).not.toBeNull()
        expect(openLink.getAttribute('href')).toBe('/dashboard?activeTab=session%3Anode-b%3Asess-hidden')
        act(() => {
            openLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        })
        expect(currentLocation).toBe('/dashboard?activeTab=session%3Anode-b%3Asess-hidden')
    })

    it('keeps provider_setup rows non-actionable in PendingApprovalsInbox and scopes Open session href by nodeId', () => {
        const html = renderToStaticMarkup(createElement(PendingApprovalsInbox, {
            approvals: [{
                nodeId: 'd', sessionId: 's', approvalType: 'provider_setup', actionable: false,
                runtimeDirectory: '/tmp/worktree', displayedDirectory: '/tmp/project',
            }],
            onResolve: () => {},
            hideWhenEmpty: false,
        }))
        expect(html).not.toContain('<button')
        expect(html).toContain('/dashboard?activeTab=session%3Ad%3As')
    })
})
