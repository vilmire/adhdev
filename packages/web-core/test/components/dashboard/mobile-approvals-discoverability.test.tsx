// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { initI18n } from '../../../src/i18n/config'
import DashboardMobileChatInbox from '../../../src/components/dashboard/DashboardMobileChatInbox'
import Approvals from '../../../src/pages/Approvals'
import { TransportProvider } from '../../../src/context/TransportContext'
import PendingApprovalsInbox from '../../../src/components/MeshGraph/PendingApprovalsInbox'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/compat', () => ({
    useDaemons: () => ({
        ides: [],
        connectionStates: {},
        initialLoaded: true,
    }),
}))

describe('mobile approvals discoverability', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
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

    it('always shows the cloud approvals entry at zero pending without a count badge', () => {
        renderInbox({ pendingProviderApprovalCount: 0 })
        const entry = container.querySelector('[data-testid="mobile-approvals-entry"]')
        expect(entry).not.toBeNull()
        expect(entry!.textContent).toContain('Approval status')
        expect(entry!.querySelector('[aria-label]')).toBeNull()
    })

    it('shows roster-derived pending count when greater than zero', () => {
        renderInbox({ pendingProviderApprovalCount: 2 })
        const entry = container.querySelector('[data-testid="mobile-approvals-entry"]')
        expect(entry!.textContent).toContain('2')
    })

    it('calls onOpenApprovals when tapped', () => {
        const onOpenApprovals = vi.fn()
        renderInbox({ onOpenApprovals })
        const entry = container.querySelector('[data-testid="mobile-approvals-entry"]') as HTMLButtonElement
        act(() => { entry.click() })
        expect(onOpenApprovals).toHaveBeenCalledTimes(1)
    })

    it('omits the entry on standalone (no /approvals route)', () => {
        renderInbox({ isStandalone: true, onOpenApprovals: undefined })
        expect(container.querySelector('[data-testid="mobile-approvals-entry"]')).toBeNull()
    })

    it('renders the approvals page zero-pending empty copy', () => {
        act(() => root.render(
            <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <TransportProvider value={{ sendCommand: vi.fn() }}>
                    <Approvals />
                </TransportProvider>
            </MemoryRouter>,
        ))
        expect(container.textContent).toContain('Approvals')
        expect(container.textContent).toContain('No sessions are awaiting an approval decision')
    })

    it('keeps provider_setup rows non-actionable in PendingApprovalsInbox', () => {
        const html = renderToStaticMarkup(createElement(PendingApprovalsInbox, {
            approvals: [{
                nodeId: 'd', sessionId: 's', approvalType: 'provider_setup', actionable: false,
                runtimeDirectory: '/tmp/worktree', displayedDirectory: '/tmp/project',
            }],
            onResolve: () => {},
            hideWhenEmpty: false,
        }))
        expect(html).not.toContain('<button')
    })
})
