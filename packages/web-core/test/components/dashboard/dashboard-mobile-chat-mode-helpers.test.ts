import { describe, expect, it } from 'vitest'
import type { DaemonData } from '../../../src/types'
import type { MobileConversationListItem } from '../../../src/components/dashboard/DashboardMobileChatShared'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import {
    buildMobileMachineCards,
    buildSelectedMachineRecentLaunches,
    getMobileMachineConnectionLabel,
    groupMobileInboxItems,
    sortMobileInboxItems,
    sortStableMobileLiveItems,
} from '../../../src/components/dashboard/dashboard-mobile-chat-mode-helpers'

function createMachine(overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id: 'machine-1',
        type: 'adhdev-daemon',
        status: 'online',
        daemonMode: true,
        platform: 'darwin',
        hostname: 'Studio Mac',
        recentLaunches: [],
        ...overrides,
    } as DaemonData
}

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        ideId: 'machine-1:ide:cursor-1',
        sessionId: 'cursor-1',
        transport: 'cdp-page',
        daemonId: 'machine-1',
        agentName: 'Codex',
        agentType: 'codex',
        status: 'idle',
        title: '',
        messages: [],
        ideType: 'cursor',
        workspaceName: 'repo',
        displayPrimary: 'repo',
        displaySecondary: 'Cursor · Codex',
        streamSource: 'native',
        tabKey: 'cursor-1',
        machineName: 'Studio Mac',
        connectionState: 'connected',
        ...overrides,
    } as ActiveConversation
}

function createItem(
    tabKey: string,
    timestamp: number,
    overrides: Partial<MobileConversationListItem> = {},
): MobileConversationListItem {
    const machineId = overrides.conversation?.daemonId || 'machine-1'
    const { conversation: conversationOverrides, ...itemOverrides } = overrides
    return {
        conversation: createConversation({
            tabKey,
            sessionId: tabKey,
            displayPrimary: tabKey,
            daemonId: machineId,
            ideId: `${machineId}:ide:cursor-1`,
            ...conversationOverrides,
        }),
        timestamp,
        preview: `${tabKey} preview`,
        unread: false,
        requiresAction: false,
        isWorking: true,
        inboxBucket: 'working',
        ...itemOverrides,
    }
}

describe('dashboard mobile chat mode helpers', () => {
    it('sorts regular mobile inbox items by latest timestamp', () => {
        const sorted = sortMobileInboxItems([
            createItem('agent-a', 100),
            createItem('agent-b', 300),
        ])

        expect(sorted.map(item => item.conversation.tabKey)).toEqual(['agent-b', 'agent-a'])
    })

    it('keeps live mobile inbox order stable when only chat timestamps change', () => {
        const sorted = sortStableMobileLiveItems([
            createItem('agent-a', 100),
            createItem('agent-b', 300),
        ], ['agent-a', 'agent-b'])

        expect(sorted.map(item => item.conversation.tabKey)).toEqual(['agent-a', 'agent-b'])
    })

    it('uses recency sort when a new live mobile inbox item appears', () => {
        const sorted = sortStableMobileLiveItems([
            createItem('agent-a', 100),
            createItem('agent-b', 300),
        ], ['agent-a'])

        expect(sorted.map(item => item.conversation.tabKey)).toEqual(['agent-b', 'agent-a'])
    })

    it('treats only p2p connected machines as connected', () => {
        expect(getMobileMachineConnectionLabel(createMachine({ p2p: { available: true, state: 'connected', peers: 1 } }))).toBe('Connected')
        expect(getMobileMachineConnectionLabel(createMachine({ p2p: { available: true, state: 'connecting', peers: 0 } }))).toBe('Connecting')
        expect(getMobileMachineConnectionLabel(createMachine({ status: 'online', p2p: { available: true, state: 'disconnected', peers: 0 } }))).toBe('Offline')
    })

    it('prefers daemon recent launches when available', () => {
        const machine = createMachine({
            recentLaunches: [{
                id: 'launch-1',
                providerType: 'claude-code',
                providerName: 'Claude Code',
                kind: 'cli',
                title: 'CLI Launch',
                providerSessionId: 'ps-1',
                workspace: '/repo',
                summaryMetadata: { items: [{ id: 'model', value: 'sonnet' }] },
                lastLaunchedAt: 123,
            }],
        })

        expect(buildSelectedMachineRecentLaunches(machine, [])).toEqual([{
            id: 'launch-1',
            label: 'CLI Launch',
            kind: 'cli',
            providerType: 'claude-code',
            providerSessionId: 'ps-1',
            subtitle: 'sonnet',
            workspace: '/repo',
            summaryMetadata: { items: [{ id: 'model', value: 'sonnet' }] },
        }])
    })

    it('builds machine cards from grouped conversation items', () => {
        const items: MobileConversationListItem[] = [{
            conversation: createConversation(),
            timestamp: 123,
            preview: 'done',
            unread: true,
            requiresAction: false,
            isWorking: false,
            inboxBucket: 'task_complete',
        }]

        const cards = buildMobileMachineCards([createMachine()], items)

        expect(cards).toHaveLength(1)
        expect(cards[0]).toMatchObject({
            id: 'machine-1',
            label: 'Studio Mac',
            // Standalone fixture: status 'online' with no P2P telemetry → the connection
            // label falls back to the reported daemon status ('Connected'), not 'Offline'.
            // See getMobileMachineConnectionLabel's no-P2P-telemetry fallback.
            subtitle: 'darwin · Connected',
            unread: 1,
            total: 1,
            preview: 'repo · Cursor · Codex · Studio Mac',
        })
    })

    it('uses live summary metadata for ACP fallback recent-launch subtitles', () => {
        const machine = createMachine({ recentLaunches: [] })
        const sessions = [
            {
                id: 'machine-1:acp:acp-1',
                daemonId: 'machine-1',
                type: 'claude-code',
                transport: 'acp',
                status: 'running',
                cliName: 'Claude Code',
                workspace: '/repo',
                activeChat: { messages: [] },
                summaryMetadata: {
                    items: [
                        { id: 'profile', label: 'Profile', value: 'Reasoning', order: 10 },
                        { id: 'model', label: 'Model', value: 'Sonnet', order: 20 },
                    ],
                },
            },
        ] as DaemonData[]

        expect(buildSelectedMachineRecentLaunches(machine, sessions)).toEqual([
            {
                id: 'acp:claude-code:/repo',
                label: 'Claude Code',
                kind: 'acp',
                providerType: 'claude-code',
                providerSessionId: undefined,
                subtitle: 'Reasoning · Sonnet',
                workspace: '/repo',
            },
        ])
    })

    describe('groupMobileInboxItems bucketing', () => {
        it('places muted requiresAction items in attentionItems and no other bucket', () => {
            const mutedAttention = createItem('muted-attention', 100, {
                unread: true,
                requiresAction: true,
                isWorking: false,
                inboxBucket: 'action_needed',
            })
            const buckets = groupMobileInboxItems([mutedAttention])

            expect(buckets.attentionItems.map(item => item.conversation.tabKey)).toEqual(['muted-attention'])
            expect(buckets.unreadItems).toHaveLength(0)
            expect(buckets.workingItems).toHaveLength(0)
            expect(buckets.completedItems).toHaveLength(0)
        })

        it('places muted unread items in unreadItems and no other bucket', () => {
            const mutedUnread = createItem('muted-unread', 200, {
                unread: true,
                requiresAction: false,
                isWorking: false,
                inboxBucket: 'unread',
            })
            const buckets = groupMobileInboxItems([mutedUnread])

            expect(buckets.attentionItems).toHaveLength(0)
            expect(buckets.unreadItems.map(item => item.conversation.tabKey)).toEqual(['muted-unread'])
            expect(buckets.workingItems).toHaveLength(0)
            expect(buckets.completedItems).toHaveLength(0)
        })

        it('buckets every visible conversation into exactly one list', () => {
            const items = [
                createItem('attention-muted', 100, { unread: true, requiresAction: true, isWorking: false, inboxBucket: 'action_needed' }),
                createItem('attention-unmuted', 110, { unread: false, requiresAction: true, isWorking: false, inboxBucket: 'action_needed' }),
                createItem('unread-muted', 200, { unread: true, requiresAction: false, isWorking: false, inboxBucket: 'unread' }),
                createItem('unread-unmuted', 210, { unread: true, requiresAction: false, isWorking: false, inboxBucket: 'unread' }),
                createItem('working-muted', 300, { unread: false, requiresAction: false, isWorking: true, inboxBucket: 'working' }),
                createItem('working-unmuted', 310, { unread: false, requiresAction: false, isWorking: true, inboxBucket: 'working' }),
                createItem('completed-muted', 400, { unread: false, requiresAction: false, isWorking: false, inboxBucket: 'idle' }),
                createItem('completed-unmuted', 410, { unread: false, requiresAction: false, isWorking: false, inboxBucket: 'idle' }),
            ]

            const buckets = groupMobileInboxItems(items)
            const bucketed = [
                ...buckets.attentionItems,
                ...buckets.unreadItems,
                ...buckets.workingItems,
                ...buckets.completedItems,
            ]

            expect(bucketed).toHaveLength(items.length)
            expect(new Set(bucketed.map(item => item.conversation.tabKey)).size).toBe(items.length)
            expect(buckets.attentionItems.map(item => item.conversation.tabKey).sort()).toEqual(['attention-muted', 'attention-unmuted'])
            expect(buckets.unreadItems.map(item => item.conversation.tabKey).sort()).toEqual(['unread-muted', 'unread-unmuted'])
            expect(buckets.workingItems.map(item => item.conversation.tabKey).sort()).toEqual(['working-muted', 'working-unmuted'])
            expect(buckets.completedItems.map(item => item.conversation.tabKey).sort()).toEqual(['completed-muted', 'completed-unmuted'])
        })

        it('reconciles Chats bucket totals with machine card totals including muted rows', () => {
            const machineA = createMachine({ id: 'machine-a', hostname: 'Mac A' })
            const machineB = createMachine({ id: 'machine-b', hostname: 'Mac B' })
            const items = [
                createItem('a-attention-muted', 100, {
                    conversation: { daemonId: 'machine-a' },
                    unread: true,
                    requiresAction: true,
                    isWorking: false,
                    inboxBucket: 'action_needed',
                }),
                createItem('a-unread-unmuted', 110, {
                    conversation: { daemonId: 'machine-a' },
                    unread: true,
                    requiresAction: false,
                    isWorking: false,
                    inboxBucket: 'unread',
                }),
                createItem('a-working-muted', 120, {
                    conversation: { daemonId: 'machine-a' },
                    unread: false,
                    requiresAction: false,
                    isWorking: true,
                    inboxBucket: 'working',
                }),
                createItem('b-completed-unmuted', 200, {
                    conversation: { daemonId: 'machine-b' },
                    unread: false,
                    requiresAction: false,
                    isWorking: false,
                    inboxBucket: 'idle',
                }),
            ]

            const buckets = groupMobileInboxItems(items)
            const visibleTotal = [
                ...buckets.attentionItems,
                ...buckets.unreadItems,
                ...buckets.workingItems,
                ...buckets.completedItems,
            ].length

            const cards = buildMobileMachineCards([machineA, machineB], items)
            const machineTotal = cards.reduce((sum, card) => sum + card.total, 0)
            const machineUnread = cards.reduce((sum, card) => sum + card.unread, 0)
            const chatsUnread = buckets.attentionItems.length + buckets.unreadItems.length

            expect(visibleTotal).toBe(items.length)
            expect(machineTotal).toBe(items.length)
            expect(machineUnread).toBe(chatsUnread)
            expect(machineUnread).toBe(2)
        })
    })
})
