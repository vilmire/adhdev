import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import { initI18n } from '../../src/i18n/config'
import DashboardMobileChatInbox from '../../src/components/dashboard/DashboardMobileChatInbox'

function rect(element: Element) {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
}

it('keeps the mobile approvals entry at least 44px tall at iPhone widths', async () => {
    localStorage.setItem('lang', 'en')
    initI18n()
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    host.style.cssText = 'height:100dvh;display:flex;flex-direction:column'
    document.body.append(host)
    const root = createRoot(host)
    const onOpenApprovals = vi.fn()
    async function render(width: number) {
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
                    pendingProviderApprovalCount={0}
                    onOpenApprovals={onOpenApprovals}
                />
            </MemoryRouter>,
        ))
    }
    try {
        for (const width of [375, 390, 1280]) {
            await render(width)
            const entry = host.querySelector('[data-testid="mobile-approvals-entry"]')
            expect(entry).not.toBeNull()
            const box = rect(entry!)
            expect(box.height).toBeGreaterThanOrEqual(44)
            expect(box.width).toBeGreaterThan(200)
            if (width <= 390) {
                expect(entry!.textContent).toContain('Approval status')
            }
        }
        await render(375)
        const entry = host.querySelector('[data-testid="mobile-approvals-entry"]') as HTMLButtonElement
        await act(async () => { entry.click() })
        expect(onOpenApprovals).toHaveBeenCalled()
    } finally {
        await act(async () => root.unmount())
        host.remove()
    }
})
