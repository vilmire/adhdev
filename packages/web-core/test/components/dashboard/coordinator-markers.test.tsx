// @vitest-environment jsdom
//
// Owner feedback (2026-09-27):
//  1. Mesh graph is a visible, dedicated button for coordinator conversations
//     again (opened often; the cue that "this is a coordinator") — not a "…"
//     menu item.
//  2. Coordinator/worker conversations are recognisable at a glance on every
//     surface via the mesh icon (MeshRoleIcon) alone — neutral colour, no
//     visible text label and no chip. The role/mesh name live in the icon's
//     accessible name (aria-label) and native tooltip (title) only.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DashboardHeader from '../../../src/components/dashboard/DashboardHeader'
import DashboardMobileChatInbox from '../../../src/components/dashboard/DashboardMobileChatInbox'
import ConversationMetaChips from '../../../src/components/dashboard/ConversationMetaChips'
import ConversationMeshGraphButton from '../../../src/components/dashboard/ConversationMeshGraphButton'
import { DashboardDockviewContext, DashboardDockviewTab, type DashboardDockviewContextValue } from '../../../src/components/dashboard/dockviewWorkspaceContext'
import { BaseDaemonProvider } from '../../../src/context/BaseDaemonContext'
import { TransportProvider } from '../../../src/context/TransportContext'
import { rememberMeshNames, resetMeshNameRegistry } from '../../../src/utils/mesh-name-registry'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { MobileConversationListItem } from '../../../src/components/dashboard/DashboardMobileChatShared'
import { MemoryRouter } from 'react-router-dom'

function conversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1',
        daemonId: 'machine-1',
        sessionId: 'session-1',
        transport: 'pty',
        mode: 'chat',
        agentName: 'Claude Code',
        agentType: 'claude-cli',
        status: 'idle',
        title: 'adhdev',
        messages: [],
        workspaceName: 'adhdev',
        workspacePath: '/work/adhdev',
        displayPrimary: 'adhdev',
        displaySecondary: 'Claude Code',
        streamSource: 'native',
        tabKey: 'tab-1',
        machineName: 'vilmire-MacBookAir',
        connectionState: 'connected',
        ...overrides,
    }
}

const coordinator = (overrides: Partial<ActiveConversation> = {}) => conversation({
    coordinator: { meshId: 'mesh-1', role: 'coordinator' },
    settings: { meshCoordinatorFor: 'mesh-1' },
    ...overrides,
})
const worker = (overrides: Partial<ActiveConversation> = {}) => conversation({
    tabKey: 'tab-w', sessionId: 'session-w', title: 'worker task', displayPrimary: 'worker task',
    settings: { meshNodeFor: 'mesh-1', launchedByCoordinator: true },
    ...overrides,
})

describe('coordinator / worker markers across dashboard surfaces', () => {
    let container: HTMLDivElement
    let root: Root
    const sendCommand = vi.fn(async () => ({ success: true }))

    beforeEach(() => {
        resetMeshNameRegistry()
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
        resetMeshNameRegistry()
    })

    function render(node: React.ReactNode) {
        act(() => root.render(
            <MemoryRouter>
                <TransportProvider value={{ sendCommand }}>
                    <BaseDaemonProvider>{node}</BaseDaemonProvider>
                </TransportProvider>
            </MemoryRouter>,
        ))
    }

    function renderHeader(activeConv: ActiveConversation, extra: Record<string, unknown> = {}) {
        const onOpenMeshGraph = vi.fn()
        render(
            <DashboardHeader
                activeConv={activeConv}
                wsStatus="connected"
                isConnected
                conversations={[activeConv]}
                onOpenHistory={() => {}}
                onStopCli={() => {}}
                onOpenMeshGraph={onOpenMeshGraph}
                inboxOpen={false}
                onInboxOpenChange={() => {}}
                hiddenOpen={false}
                onHiddenOpenChange={() => {}}
                notifications={[]}
                notificationUnreadCount={0}
                onOpenNotification={() => {}}
                onMarkNotificationRead={() => {}}
                onMarkNotificationUnread={() => {}}
                onDeleteNotification={() => {}}
                {...extra}
            />,
        )
        return onOpenMeshGraph
    }

    const meshButton = () => container.querySelector<HTMLButtonElement>('[data-testid="conversation-mesh-graph-button"]')

    it('header: a coordinator gets a dedicated Mesh graph button (named for its mesh) that opens the graph', () => {
        rememberMeshNames([{ id: 'mesh-1', name: 'adhdev mesh' }])
        const conv = coordinator()
        const onOpenMeshGraph = renderHeader(conv)
        const button = meshButton()
        expect(button).not.toBeNull()
        expect(button!.getAttribute('aria-label')).toBe('Open mesh graph · Coordinator for adhdev mesh')
        expect(button!.textContent).toContain('Mesh graph')
        act(() => button!.click())
        expect(onOpenMeshGraph).toHaveBeenCalledWith(conv)
        // Single place: the "…" menu no longer lists it.
        act(() => container.querySelector<HTMLButtonElement>('[data-testid="conversation-actions-menu"]')!.click())
        const keys = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(item => item.dataset.menuItem)
        expect(keys).not.toContain('mesh')
        expect(keys.length).toBeGreaterThan(0)
        // Mobile title area carries the coordinator icon.
        expect(container.querySelector('.header-title-mobile-role.is-coordinator')?.getAttribute('aria-label')).toBe('Coordinator for adhdev mesh')
    })

    it('header: no Mesh graph button for a worker or a plain chat', () => {
        renderHeader(worker())
        expect(meshButton()).toBeNull()
        expect(container.querySelector('.header-title-mobile-role.is-worker')).not.toBeNull()
        renderHeader(conversation())
        expect(meshButton()).toBeNull()
        expect(container.querySelector('.mesh-role-icon')).toBeNull()
    })

    it('header hidden list: hidden coordinator / worker rows carry their markers', () => {
        renderHeader(conversation(), {
            hiddenOpen: true,
            hiddenConversations: [coordinator({ tabKey: 'tab-c' }), worker()],
        })
        const rows = Array.from(container.querySelectorAll('.dashboard-header-hidden-list .dashboard-header-inbox-item'))
        expect(rows).toHaveLength(2)
        const coordinatorIcon = rows[0].querySelector('.mesh-role-icon.is-coordinator')
        expect(coordinatorIcon).not.toBeNull()
        expect(coordinatorIcon?.getAttribute('aria-label')).toBe('Coordinator for mesh-1')
        expect(rows[0].querySelector('.mesh-role-label')).toBeNull()
        const workerIcon = rows[1].querySelector('.mesh-role-icon.is-worker')
        expect(workerIcon).not.toBeNull()
        expect(workerIcon?.getAttribute('aria-label')).toBe('Worker for mesh-1')
        expect(rows[1].querySelector('.mesh-role-label')).toBeNull()
    })

    function renderDockviewTab(conv: ActiveConversation) {
        const ctx = {
            conversationsByTabKey: new Map([[conv.tabKey, conv]]),
            liveSessionInboxState: new Map(),
            tabShortcuts: {},
            openTabContextMenu: () => {},
        } as unknown as DashboardDockviewContextValue
        const disposable = () => ({ dispose() {} })
        const api = {
            id: conv.tabKey,
            title: conv.title,
            isGroupActive: true,
            group: { activePanel: { id: conv.tabKey } },
            setActive: () => {},
            onDidActiveGroupChange: disposable,
            onDidTitleChange: disposable,
            onDidGroupChange: disposable,
        }
        const props = { api, containerApi: { onDidActivePanelChange: disposable }, params: { kind: 'conversation', tabKey: conv.tabKey } }
        render(
            <DashboardDockviewContext.Provider value={ctx}>
                <DashboardDockviewTab {...(props as any)} />
            </DashboardDockviewContext.Provider>,
        )
        return container.querySelector<HTMLElement>('.adhdev-dockview-tab')!
    }

    it('dockview tab: coordinator → icon before the title (no visible subtitle text), and a descriptive tooltip', () => {
        const tab = renderDockviewTab(coordinator())
        const icon = tab.querySelector('.mesh-role-icon.is-coordinator')!
        expect(icon).not.toBeNull()
        expect(icon.getAttribute('role')).toBe('img')
        expect(icon.getAttribute('aria-label')).toBe('Coordinator for mesh-1')
        // status → icon → copy (icon survives narrow tabs: it is outside the truncating copy)
        const children = Array.from(tab.children).map(el => el.className)
        expect(children.findIndex(c => c.includes('mesh-role-icon'))).toBeGreaterThan(children.findIndex(c => c.includes('adhdev-dockview-tab-status')))
        expect(children.findIndex(c => c.includes('mesh-role-icon'))).toBeLessThan(children.findIndex(c => c.includes('adhdev-dockview-tab-copy')))
        // No visible "Coordinator · <mesh>" text anywhere in the tab — the icon alone carries the role.
        expect(tab.querySelector('.mesh-role-label')).toBeNull()
        expect(tab.textContent).not.toContain('Coordinator ·')
        expect(tab.getAttribute('title')).toBe('adhdev · Coordinator for mesh-1')
    })

    it('dockview tab: shows the mesh name once any surface learns it, in the icon title/aria-label (no request of its own)', () => {
        const tab = renderDockviewTab(coordinator())
        const icon = () => container.querySelector('.mesh-role-icon.is-coordinator')
        expect(icon()?.getAttribute('aria-label')).toBe('Coordinator for mesh-1')
        expect(icon()?.getAttribute('title')).toBe('Coordinator for mesh-1')
        expect(tab.getAttribute('title')).toBe('adhdev · Coordinator for mesh-1')
        act(() => rememberMeshNames([{ id: 'mesh-1', name: 'adhdev mesh' }]))
        expect(icon()?.getAttribute('aria-label')).toBe('Coordinator for adhdev mesh')
        expect(icon()?.getAttribute('title')).toBe('Coordinator for adhdev mesh')
        expect(container.querySelector('.adhdev-dockview-tab')?.getAttribute('title')).toBe('adhdev · Coordinator for adhdev mesh')
        expect(sendCommand).not.toHaveBeenCalled()
    })

    it('dockview tab: worker gets the subtler worker marker; plain chats get none', () => {
        const workerTab = renderDockviewTab(worker())
        expect(workerTab.querySelector('.mesh-role-icon.is-worker')?.getAttribute('aria-label')).toBe('Worker for mesh-1')
        expect(workerTab.querySelector('.is-coordinator')).toBeNull()
        const plainTab = renderDockviewTab(conversation())
        expect(plainTab.querySelector('.mesh-role-icon')).toBeNull()
        expect(plainTab.querySelector('.mesh-role-label')).toBeNull()
        expect(plainTab.getAttribute('title')).toBe('adhdev')
    })

    it('mobile inbox rows: coordinator row has the icon (no subtitle label) and the mesh graph button', () => {
        const item = (conv: ActiveConversation): MobileConversationListItem => ({
            conversation: conv, timestamp: Date.now(), preview: 'preview', unread: false,
            requiresAction: false, isWorking: false, inboxBucket: 'idle',
        } as MobileConversationListItem)
        render(
            <DashboardMobileChatInbox
                {...({
                    section: 'chats', attentionItems: [], unreadItems: [], workingItems: [],
                    completedItems: [item(coordinator()), item(worker())],
                    hiddenConversations: [], machineCards: [], getAvatarText: () => 'A', actionLogs: [],
                    sendDaemonCommand: vi.fn(), onOpenConversation: vi.fn(), onShowAllHidden: vi.fn(),
                    onHideConversation: vi.fn(), onOpenMachine: vi.fn(), onOpenSettings: vi.fn(),
                    onSectionChange: vi.fn(), wsStatus: 'connected', onOpenMeshGraph: vi.fn(),
                } as any)}
            />,
        )
        expect(container.querySelectorAll('.mesh-role-icon.is-coordinator')).toHaveLength(1)
        expect(container.querySelectorAll('.mesh-role-icon.is-worker')).toHaveLength(1)
        expect(container.querySelectorAll('.mobile-inbox-mesh-button')).toHaveLength(1)
        expect(container.querySelectorAll('.mesh-role-label')).toHaveLength(0)
    })

    it('mobile chat header chips: no role chip renders (the mesh icon carries the role instead)', () => {
        render(<ConversationMetaChips conversation={coordinator()} interactive={false} />)
        expect(container.querySelector('.mesh-role-chip')).toBeNull()
        expect(container.textContent).not.toContain('Coordinator · mesh-1')
        render(<ConversationMetaChips conversation={worker()} interactive={false} />)
        expect(container.querySelector('.mesh-role-chip')).toBeNull()
        expect(container.textContent).not.toContain('Worker · mesh-1')
        expect(container.textContent).not.toContain('Mesh Node')
    })

    it('mesh graph button renders only for a coordinator bound to a daemon with a handler', () => {
        render(<ConversationMeshGraphButton conversation={coordinator()} onOpenMeshGraph={() => {}} />)
        expect(meshButton()).not.toBeNull()
        render(<ConversationMeshGraphButton conversation={coordinator()} />)
        expect(meshButton()).toBeNull()
        render(<ConversationMeshGraphButton conversation={coordinator({ daemonId: undefined })} onOpenMeshGraph={() => {}} />)
        expect(meshButton()).toBeNull()
        render(<ConversationMeshGraphButton conversation={worker()} onOpenMeshGraph={() => {}} />)
        expect(meshButton()).toBeNull()
    })
})
