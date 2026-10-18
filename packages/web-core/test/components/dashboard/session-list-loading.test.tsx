// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { initI18n } from '../../../src/i18n/config'
import { BaseDaemonProvider, useBaseDaemonActions, useBaseDaemons } from '../../../src/context/BaseDaemonContext'
import DashboardMobileChatInbox from '../../../src/components/dashboard/DashboardMobileChatInbox'
import { areConversationsLoaded, buildMobileMachineCards } from '../../../src/components/dashboard/dashboard-mobile-chat-mode-helpers'
import type { DaemonData } from '../../../src/types'

beforeEach(() => { localStorage.setItem('lang', 'en'); initI18n() })

const machine = (id: string, loaded = false): DaemonData => ({
    id, type: 'adhdev-daemon', status: 'online', hostname: id, _sessionListAuthoritative: loaded,
} as DaemonData)

function inbox(machines: DaemonData[], connectionStates: Record<string, string>) {
    const options = { isStandalone: false, connectionStates }
    const container = document.createElement('div')
    const root = createRoot(container)
    try { act(() => root.render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <DashboardMobileChatInbox
                section="chats" attentionItems={[]} unreadItems={[]} workingItems={[]} completedItems={[]}
                hiddenConversations={[]} machineCards={buildMobileMachineCards(machines, [], [], options)}
                getAvatarText={text => text[0] || '?'} actionLogs={[]} sendDaemonCommand={vi.fn()}
                onOpenConversation={vi.fn()} onShowAllHidden={vi.fn()} onOpenMachine={vi.fn()}
                onOpenSettings={vi.fn()} onSectionChange={vi.fn()} wsStatus="connected" isStandalone={false}
                initialDataLoaded conversationsLoaded={areConversationsLoaded(machines, true, options)}
            />
        </MemoryRouter>,
    )); return container.innerHTML } finally { act(() => root.unmount()) }
}

it('zero connected cloud peers show loading rows rather than an empty inbox', () => {
    const html = inbox([machine('Pending Mac')], {})
    expect(html).toContain('mobile-inbox-connecting-machines')
    expect(html).toContain('Pending Mac')
    expect(html).not.toContain('No conversations')
})

it('one empty daemon plus one connected-but-unloaded daemon keeps its loading row', () => {
    const html = inbox([machine('Ready Mac', true), machine('Loading Mac')], { 'Ready Mac': 'connected', 'Loading Mac': 'connected' })
    expect(html).toContain('mobile-inbox-connecting-machines')
    expect(html).toContain('Loading Mac')
    expect(html).not.toContain('No conversations')
})

it('all authoritative empty lists show the real empty state', () => {
    const html = inbox([machine('Ready Mac', true)], { 'Ready Mac': 'connected' })
    expect(html).toContain('No conversations')
    expect(html).not.toContain('mobile-inbox-connecting-machines')
})

it('a new transport invalidates cached authority until its fresh session list arrives', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    let actions: ReturnType<typeof useBaseDaemonActions>
    let entries: DaemonData[] = []
    function Probe() { actions = useBaseDaemonActions(); entries = useBaseDaemons().ides; return null }
    try {
        act(() => root.render(<BaseDaemonProvider><Probe /></BaseDaemonProvider>))
        act(() => actions.injectEntries([machine('daemon', true)]))
        expect(entries[0]._sessionListAuthoritative).toBe(true)
        act(() => actions.invalidateSessionList('daemon'))
        expect(entries[0]._sessionListAuthoritative).toBe(false)
        expect(areConversationsLoaded(entries, true, { isStandalone: false, connectionStates: { daemon: 'connected' } })).toBe(false)
        act(() => actions.injectEntries([machine('daemon', true)]))
        expect(entries[0]._sessionListAuthoritative).toBe(true)
    } finally { act(() => root.unmount()) }
})
