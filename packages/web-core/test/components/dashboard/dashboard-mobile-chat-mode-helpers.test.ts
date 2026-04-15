import { describe, expect, it } from 'vitest'
import type { DaemonData } from '../../../src/types'
import type { MobileConversationListItem } from '../../../src/components/dashboard/DashboardMobileChatShared'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import {
    buildMobileMachineCards,
    buildSelectedMachineRecentLaunches,
    getMobileMachineConnectionLabel,
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
    }
}

describe('dashboard mobile chat mode helpers', () => {
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
            subtitle: 'darwin · Offline',
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
})
