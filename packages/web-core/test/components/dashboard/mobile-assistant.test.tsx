// @vitest-environment jsdom
//
// The assistant on the MOBILE dashboard (mirrors desktop, design
// 2026-10-07-assistant-layer.md §4.6–§4.7, §4.10.2):
//   - pinned above every inbox bucket, with the assistant icon + label;
//   - a pinned "Start assistant" entry while none exists, reusing the desktop
//     split button (same `useStartAssistant` state: default target + picker);
//   - the room renders through the shared PaneGroupContent/ChatPane (relay
//     cards, review chips, tool steps hidden by default — all ChatPane's), with
//     the "N pending" staged-writes pill moved into the room header.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const paneGroupContentProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../../../src/components/dashboard/PaneGroupContent', () => ({
    default: (props: Record<string, unknown>) => {
        paneGroupContentProps.push(props)
        return <div data-testid="pane-group-content" />
    },
}))
const stagedState = vi.hoisted(() => ({ items: [] as unknown[] }))
vi.mock('../../../src/hooks/useAssistantStagedWrites', () => ({
    useAssistantStagedWrites: () => ({
        items: stagedState.items,
        outcomes: {},
        busyIds: new Set(),
        refresh: async () => {},
        resolve: async () => {},
    }),
}))

import DashboardMobileChatInbox from '../../../src/components/dashboard/DashboardMobileChatInbox'
import DashboardMobileChatRoom from '../../../src/components/dashboard/DashboardMobileChatRoom'
import { TransportProvider } from '../../../src/context/TransportContext'
import { groupMobileInboxItems, getMobileInboxRowType } from '../../../src/components/dashboard/dashboard-mobile-chat-mode-helpers'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { MobileConversationListItem } from '../../../src/components/dashboard/DashboardMobileChatShared'
import type { StartAssistantState } from '../../../src/hooks/useStartAssistant'
import type { DashboardConversationCommands } from '../../../src/hooks/useDashboardConversationCommands'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
        displayPrimary: 'adhdev',
        displaySecondary: 'Claude Code',
        streamSource: 'native',
        tabKey: 'tab-1',
        connectionState: 'connected',
        ...overrides,
    } as ActiveConversation
}

const assistantConv = () => conversation({
    sessionId: 'assistant-1',
    tabKey: 'tab-assistant',
    displayPrimary: 'Assistant',
    title: 'Assistant',
    assistant: true,
})

function item(conv: ActiveConversation, flags: Partial<MobileConversationListItem> = {}): MobileConversationListItem {
    return {
        conversation: conv,
        timestamp: 1,
        preview: 'preview',
        unread: false,
        requiresAction: false,
        isWorking: false,
        inboxBucket: 'idle',
        ...flags,
    } as MobileConversationListItem
}

function startState(overrides: Partial<StartAssistantState> = {}): StartAssistantState {
    return {
        visible: true,
        pending: false,
        error: null,
        defaultTarget: { machineId: 'machine-1', cliType: 'claude-cli' },
        machines: [{
            machineId: 'machine-1',
            label: 'mbp',
            hostedProjects: 0,
            clis: [{ cliType: 'claude-cli', label: 'Claude Code', supported: true, promptOnly: false, modelOptions: [], thinkingLevelOptions: [] }],
        }],
        start: vi.fn(async () => {}),
        ...overrides,
    }
}

describe('groupMobileInboxItems — the assistant is pinned out of its bucket', () => {
    it('lifts the assistant out of every status bucket into assistantItems', () => {
        const worker = item(conversation({ tabKey: 'tab-w' }), { unread: true, timestamp: 9 })
        const pinned = item(assistantConv(), { unread: true, timestamp: 1 })
        const buckets = groupMobileInboxItems([worker, pinned])
        expect(buckets.assistantItems.map(i => i.conversation.tabKey)).toEqual(['tab-assistant'])
        expect(buckets.unreadItems.map(i => i.conversation.tabKey)).toEqual(['tab-w'])
        expect([...buckets.attentionItems, ...buckets.workingItems, ...buckets.completedItems]).toHaveLength(0)
    })

    it('row type keeps the status the bucket would have shown', () => {
        expect(getMobileInboxRowType({ requiresAction: true, unread: true, isWorking: true })).toBe('needs_attention')
        expect(getMobileInboxRowType({ requiresAction: false, unread: true, isWorking: false })).toBe('task_complete')
        expect(getMobileInboxRowType({ requiresAction: false, unread: false, isWorking: true })).toBe('working')
        expect(getMobileInboxRowType({ requiresAction: false, unread: false, isWorking: false })).toBe('earlier')
    })
})

describe('mobile inbox — pinned assistant and Start assistant', () => {
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

    function render(props: Record<string, unknown>) {
        act(() => root.render(
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
                {...props}
            />,
        ))
    }

    it('renders the assistant first, above Needs attention, with its icon and label', () => {
        const onOpenConversation = vi.fn()
        render({
            assistantItems: [item(assistantConv())],
            attentionItems: [item(conversation({ tabKey: 'tab-a', displayPrimary: 'Fix build', title: 'Fix build' }), { requiresAction: true })],
            onOpenConversation,
        })
        const pinned = container.querySelector('[data-testid="mobile-inbox-pinned"]')!
        expect(pinned).not.toBeNull()
        const sections = Array.from(container.querySelectorAll('section'))
        expect(sections[0]).toBe(pinned)
        expect(pinned.textContent).toContain('Pinned')
        expect(pinned.textContent).toContain('Assistant')
        expect(pinned.querySelector('[data-assistant-role="assistant"]')).not.toBeNull()
        expect(pinned.textContent).not.toContain('Fix build')
        const open = Array.from(pinned.querySelectorAll('button')).find(b => b.textContent?.includes('Assistant'))!
        act(() => open.click())
        expect(onOpenConversation).toHaveBeenCalledTimes(1)
        expect(onOpenConversation.mock.calls[0][0].tabKey).toBe('tab-assistant')
    })

    it('counts an unread pinned assistant in the header badge', () => {
        render({ assistantItems: [item(assistantConv(), { unread: true })] })
        expect(container.textContent).toMatch(/^Chats1/)
    })

    it('offers a pinned Start assistant entry while none exists, launching the shared default target', () => {
        const startAssistant = startState()
        render({ startAssistant })
        const entry = container.querySelector('[data-testid="mobile-inbox-start-assistant"]')!
        expect(entry).not.toBeNull()
        expect(container.querySelector('[data-testid="mobile-inbox-pinned"]')!.contains(entry)).toBe(true)
        act(() => entry.querySelector<HTMLButtonElement>('[data-testid="dashboard-start-assistant"]')!.click())
        expect(startAssistant.start).toHaveBeenCalledWith()
    })

    it('the entry carries the CLI / machine picker and launches the picked target', () => {
        const startAssistant = startState()
        render({ startAssistant })
        act(() => container.querySelector<HTMLButtonElement>('[data-testid="dashboard-start-assistant-menu"]')!.click())
        act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="assistant-launch-start"]')!.click())
        expect(startAssistant.start).toHaveBeenCalledWith({ machineId: 'machine-1', cliType: 'claude-cli' })
    })

    it('shows the launch error under the entry', () => {
        render({ startAssistant: startState({ error: 'no_cli' }) })
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('no_cli')
    })

    it('no Start entry once the assistant exists, nor while it is not on offer', () => {
        render({ startAssistant: startState(), assistantItems: [item(assistantConv())] })
        expect(container.querySelector('[data-testid="mobile-inbox-start-assistant"]')).toBeNull()
        render({ startAssistant: startState({ visible: false }) })
        expect(container.querySelector('[data-testid="mobile-inbox-start-assistant"]')).toBeNull()
        expect(container.querySelector('[data-testid="mobile-inbox-pinned"]')).toBeNull()
    })
})

describe('mobile chat room — assistant', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        paneGroupContentProps.length = 0
        stagedState.items = []
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    function render(conv: ActiveConversation) {
        act(() => root.render(
            <MemoryRouter><TransportProvider value={{ sendCommand: vi.fn(async () => ({ success: true })) }}>
                <DashboardMobileChatRoom
                    selectedConversation={conv}
                    isStandalone
                    actionLogs={[]}
                    commands={{} as DashboardConversationCommands}
                    onBack={vi.fn()}
                    onOpenNativeConversation={vi.fn()}
                    onOpenMachine={vi.fn()}
                    onOpenHistory={vi.fn()}
                    onOpenRemote={vi.fn()}
                    cliViewMode="chat"
                    onSetCliViewMode={vi.fn()}
                />
            </TransportProvider></MemoryRouter>,
        ))
    }

    const stagedItem = { kind: 'memory', id: 'mem-1', createdAt: 0, origin: 'relay', action: 'add', target: 'memory', text: 'x' }

    it('renders the assistant through the shared pane, with the staged pill in the header', () => {
        stagedState.items = [stagedItem, { ...stagedItem, id: 'mem-2' }]
        render(assistantConv())
        const header = container.firstElementChild as HTMLElement
        expect(header.contains(container.querySelector('[data-testid="pane-group-content"]'))).toBe(false)
        expect(header.querySelector('[data-assistant-role="assistant"]')).not.toBeNull()
        expect(header.textContent).toContain('Assistant')
        const pill = header.querySelector('[data-assistant-staged-count]')
        expect(pill?.getAttribute('data-assistant-staged-count')).toBe('2')
        expect(pill?.textContent).toContain('2 pending')
        // The shared pane renders the transcript (relay cards, review chips,
        // tool-step default) — only its own copy of the pill is turned off.
        expect(paneGroupContentProps.at(-1)?.activeConv).toMatchObject({ tabKey: 'tab-assistant', assistant: true })
        expect(paneGroupContentProps.at(-1)?.showAssistantStagedWrites).toBe(false)
        expect(container.querySelectorAll('[data-assistant-staged-count]')).toHaveLength(1)
    })

    it('a non-assistant room gets no staged pill', () => {
        stagedState.items = [stagedItem]
        render(conversation())
        expect(container.querySelector('[data-assistant-staged-count]')).toBeNull()
    })
})
