import { describe, expect, it } from 'vitest'
import { buildConversationSourceSignature, buildConversationTargetMap, dedupeChatIdes } from '../../src/hooks/useDashboardConversations'
import { buildMachineNameMap, buildScopedIdeConversations } from '../../src/components/dashboard/buildConversations'
import type { ActiveConversation } from '../../src/components/dashboard/types'
import type { DaemonData } from '../../src/types'

function createCliEntry(overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id: 'machine-1:cli:hermes-1',
        daemonId: 'machine-1',
        sessionId: 'hermes-1',
        providerSessionId: 'provider-1',
        type: 'hermes-cli',
        transport: 'pty',
        mode: 'chat',
        status: 'generating',
        workspace: '/repo',
        activeChat: {
            id: 'chat-1',
            title: 'Hermes Agent',
            status: 'generating',
            messages: [
                {
                    id: 'msg-1',
                    role: 'user',
                    content: 'hello',
                    index: 0,
                    timestamp: 1,
                    receivedAt: 1,
                },
            ],
            activeModal: null,
        },
        childSessions: [],
        lastMessageHash: 'hash-1',
        lastUpdated: 1,
        ...overrides,
    }
}

describe('dedupeChatIdes', () => {
    it('keeps duplicate raw CLI session ids when entries belong to different daemons', () => {
        const first = createCliEntry({
            id: 'machine-1:cli:shared-session',
            daemonId: 'machine-1',
            sessionId: 'shared-session',
        })
        const second = createCliEntry({
            id: 'machine-2:cli:shared-session',
            daemonId: 'machine-2',
            sessionId: 'shared-session',
        })

        expect(dedupeChatIdes([first, second]).map(entry => entry.id)).toEqual([
            'machine-1:cli:shared-session',
            'machine-2:cli:shared-session',
        ])
    })

    it('collapses the two arrivals of a single mesh-owned session into one entry', () => {
        // The SAME worker session arrives twice: coordinator-reported (prefixed with the
        // coordinator daemon, but owned by the worker) and worker-reported (prefixed with
        // the worker daemon, no owner attribution). They must dedupe to a single entry,
        // otherwise the dashboard renders a duplicate "ghost" tab.
        const coordinatorReported = createCliEntry({
            id: 'coord-daemon:cli:remote-session',
            daemonId: 'coord-daemon',
            sessionId: 'remote-session',
            ownerDaemonId: 'worker-daemon',
            workspace: '/repo',
            timestamp: 2,
        })
        const workerReported = createCliEntry({
            id: 'worker-daemon:cli:remote-session',
            daemonId: 'worker-daemon',
            sessionId: 'remote-session',
            activeChat: null,
            workspace: undefined,
            timestamp: 1,
        })

        const deduped = dedupeChatIdes([coordinatorReported, workerReported])
        expect(deduped).toHaveLength(1)
        // The richer coordinator-reported entry survives, retaining owner attribution.
        expect(deduped[0]?.ownerDaemonId).toBe('worker-daemon')
    })
})

describe('mesh ghost-tab dedup → build pipeline', () => {
    const machineDaemons: DaemonData[] = [
        { id: 'coord-daemon', daemonId: 'coord-daemon', type: 'adhdev-daemon', machineNickname: 'vilmireui-MacBookAir-4' } as unknown as DaemonData,
        { id: 'worker-daemon', daemonId: 'worker-daemon', type: 'adhdev-daemon', machineNickname: 'M1-Server' } as unknown as DaemonData,
    ]

    it('renders exactly one tab labeled with the remote worker machine for a duplicated mesh session', () => {
        const coordinatorReported = createCliEntry({
            id: 'coord-daemon:cli:d9363213',
            daemonId: 'coord-daemon',
            sessionId: 'd9363213',
            type: 'antigravity-cli',
            cliName: 'Antigravity',
            ownerDaemonId: 'worker-daemon',
            settings: { meshNodeFor: 'mesh-x', launchedByCoordinator: true },
            workspace: '/repo',
            timestamp: 2,
        })
        const workerReported = createCliEntry({
            id: 'worker-daemon:cli:d9363213',
            daemonId: 'worker-daemon',
            sessionId: 'd9363213',
            type: 'antigravity-cli',
            cliName: 'Antigravity',
            activeChat: null,
            workspace: undefined,
            timestamp: 1,
        })

        const machineNames = buildMachineNameMap([...machineDaemons, coordinatorReported, workerReported])
        const deduped = dedupeChatIdes([coordinatorReported, workerReported])
        const conversations = deduped.flatMap(ide => buildScopedIdeConversations(ide, { machineNames }))

        // Exactly one tab — no ghost duplicate.
        expect(conversations).toHaveLength(1)
        // Labeled with the REMOTE worker machine, never the coordinator's local machine.
        expect(conversations[0]?.machineName).toBe('M1-Server')
        expect(conversations[0]?.machineName).not.toBe('vilmireui-MacBookAir-4')
    })

    it('keeps a genuine local session labeled with its own machine and as its own tab', () => {
        // Two distinct local sessions on two daemons sharing only the raw session id must
        // remain two tabs, each with its own machine name.
        const localOnCoordinator = createCliEntry({
            id: 'coord-daemon:cli:local-x',
            daemonId: 'coord-daemon',
            sessionId: 'local-x',
            type: 'claude-cli',
            cliName: 'Claude Cli',
        })
        const localOnWorker = createCliEntry({
            id: 'worker-daemon:cli:local-x',
            daemonId: 'worker-daemon',
            sessionId: 'local-x',
            type: 'claude-cli',
            cliName: 'Claude Cli',
        })

        const machineNames = buildMachineNameMap([...machineDaemons, localOnCoordinator, localOnWorker])
        const deduped = dedupeChatIdes([localOnCoordinator, localOnWorker])
        const conversations = deduped.flatMap(ide => buildScopedIdeConversations(ide, { machineNames }))

        expect(conversations).toHaveLength(2)
        const byMachine = conversations.map(c => c.machineName).sort()
        expect(byMachine).toEqual(['M1-Server', 'vilmireui-MacBookAir-4'])
    })
})

describe('buildConversationSourceSignature', () => {
    it('changes when the last assistant message content changes in place without a new id or timestamp', () => {
        const entry = createCliEntry({
            activeChat: {
                id: 'chat-1',
                title: 'Hermes Agent',
                status: 'idle',
                messages: [
                    {
                        id: 'msg-1',
                        role: 'assistant',
                        content: 'partial answer',
                        index: 0,
                        timestamp: 1,
                        receivedAt: 1,
                    },
                ],
                activeModal: null,
            },
        })
        const before = buildConversationSourceSignature(entry)

        if (entry.activeChat?.messages?.[0]) {
            entry.activeChat.messages[0].content = 'completed answer with final text'
        }

        const after = buildConversationSourceSignature(entry)
        expect(after).not.toBe(before)
    })

    it('changes when only content after the 240-character preview window changes', () => {
        const entry = createCliEntry({
            activeChat: {
                id: 'chat-1',
                title: 'Hermes Agent',
                status: 'idle',
                messages: [
                    {
                        id: 'msg-1',
                        role: 'assistant',
                        content: `${'A'.repeat(240)} tail-one`,
                        index: 0,
                        timestamp: 1,
                        receivedAt: 1,
                    },
                ],
                activeModal: null,
            },
        })
        const before = buildConversationSourceSignature(entry)

        if (entry.activeChat?.messages?.[0]) {
            entry.activeChat.messages[0].content = `${'A'.repeat(240)} tail-two`
        }

        const after = buildConversationSourceSignature(entry)
        expect(after).not.toBe(before)
    })

    it('changes when a stable entry reference gains a completed assistant message', () => {
        const entry = createCliEntry()
        const before = buildConversationSourceSignature(entry)

        entry.status = 'idle'
        entry.lastMessageHash = 'hash-2'
        entry.lastUpdated = 2
        if (entry.activeChat) {
            entry.activeChat.status = 'idle'
            entry.activeChat.messages = [
                ...(entry.activeChat.messages || []),
                {
                    id: 'msg-2',
                    role: 'assistant',
                    content: 'DONE',
                    index: 1,
                    timestamp: 2,
                    receivedAt: 2,
                },
            ]
        }

        const after = buildConversationSourceSignature(entry)
        expect(after).not.toBe(before)
    })

    it('changes when a stable entry reference gains a timestamp-only completed assistant message', () => {
        const entry = createCliEntry()
        const before = buildConversationSourceSignature(entry)

        entry.status = 'idle'
        entry.lastMessageHash = 'hash-2'
        entry.lastUpdated = 2
        if (entry.activeChat) {
            entry.activeChat.status = 'idle'
            entry.activeChat.messages = [
                ...(entry.activeChat.messages || []),
                {
                    id: 'msg-2',
                    role: 'assistant',
                    content: 'DONE',
                    index: 1,
                    timestamp: 2,
                },
            ]
        }

        const after = buildConversationSourceSignature(entry)
        expect(after).not.toBe(before)
    })

    it('changes when child session chat metadata changes even if parent reference is reused', () => {
        const entry = createCliEntry({
            transport: 'cdp-page',
            type: 'cursor',
            childSessions: [
                {
                    id: 'agent-1',
                    parentId: 'cursor-1',
                    providerType: 'codex',
                    providerName: 'Codex',
                    kind: 'agent',
                    transport: 'cdp-webview',
                    status: 'generating',
                    title: 'Codex',
                    workspace: '/repo',
                    activeChat: {
                        id: 'chat-2',
                        title: 'Codex',
                        status: 'generating',
                        messages: [{ id: 'child-1', role: 'assistant', content: 'working', index: 0, timestamp: 1, receivedAt: 1 }],
                        activeModal: null,
                    },
                    capabilities: [],
                    lastMessageHash: 'child-hash-1',
                    lastUpdated: 1,
                },
            ],
        })
        const before = buildConversationSourceSignature(entry)

        const child = entry.childSessions?.[0]
        if (!child) throw new Error('missing child session')
        child.status = 'idle'
        child.lastMessageHash = 'child-hash-2'
        child.lastUpdated = 2
        if (child.activeChat) {
            child.activeChat.status = 'idle'
            child.activeChat.messages = [
                ...(child.activeChat.messages || []),
                { id: 'child-2', role: 'assistant', content: 'done', index: 1, timestamp: 2, receivedAt: 2 },
            ]
        }

        const after = buildConversationSourceSignature(entry)
        expect(after).not.toBe(before)
    })
    it('changes when top-level compact last-message summary changes without transcript body', () => {
        const entry = createCliEntry({
            activeChat: undefined,
            lastMessagePreview: 'older preview',
            lastMessageAt: 1000,
            lastMessageHash: undefined,
            lastUpdated: undefined,
        })
        const before = buildConversationSourceSignature(entry)

        entry.lastMessagePreview = 'newer preview'
        entry.lastMessageAt = 2000

        const after = buildConversationSourceSignature(entry)
        expect(after).not.toBe(before)
    })

    it('changes when child compact last-message summary changes without transcript body', () => {
        const entry = createCliEntry({
            transport: 'cdp-page',
            type: 'cursor',
            activeChat: undefined,
            childSessions: [
                {
                    id: 'agent-1',
                    parentId: 'cursor-1',
                    providerType: 'codex',
                    providerName: 'Codex',
                    kind: 'agent',
                    transport: 'cdp-webview',
                    status: 'idle',
                    title: 'Codex',
                    workspace: '/repo',
                    activeChat: undefined,
                    capabilities: [],
                    lastMessagePreview: 'older child preview',
                    lastMessageAt: 1000,
                },
            ],
            lastMessageHash: undefined,
            lastUpdated: undefined,
        })
        const before = buildConversationSourceSignature(entry)

        const child = entry.childSessions?.[0]
        if (!child) throw new Error('missing child session')
        child.lastMessagePreview = 'newer child preview'
        child.lastMessageAt = 2000

        const after = buildConversationSourceSignature(entry)
        expect(after).not.toBe(before)
    })
})

describe('buildScopedIdeConversations', () => {
    it('uses the top-level CLI status when compact live metadata has no activeChat transcript', () => {
        const entry = createCliEntry({
            status: 'generating',
            activeChat: null,
        })

        const conversations = buildScopedIdeConversations(entry)

        expect(conversations).toHaveLength(1)
        expect(conversations[0]?.status).toBe('generating')
    })

    it('keeps active top-level CLI status ahead of a stale idle activeChat status', () => {
        const entry = createCliEntry({
            status: 'generating',
            activeChat: {
                id: 'chat-1',
                title: 'Hermes Agent',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
        })

        const conversations = buildScopedIdeConversations(entry)

        expect(conversations).toHaveLength(1)
        expect(conversations[0]?.status).toBe('generating')
    })

    it('keeps activeChat status ahead of stale top-level CLI status', () => {
        const entry = createCliEntry({
            status: 'idle',
            activeChat: {
                id: 'chat-1',
                title: 'Hermes Agent',
                status: 'waiting_approval',
                messages: [],
                activeModal: { message: 'approve?', buttons: ['Yes'] },
            },
        })

        const conversations = buildScopedIdeConversations(entry)

        expect(conversations).toHaveLength(1)
        expect(conversations[0]?.status).toBe('waiting_approval')
    })
})

describe('buildConversationTargetMap', () => {
    it('keeps route ids pointed at the preferred conversation instead of the last stream encountered', () => {
        const nativeConversation: ActiveConversation = {
            routeId: 'machine-1:ide:cursor-1',
            sessionId: 'native-1',
            providerSessionId: 'provider-native',
            nativeSessionId: 'native-1',
            transport: 'cdp-page',
            daemonId: 'machine-1',
            agentName: 'Cursor',
            agentType: 'cursor',
            status: 'idle',
            title: 'Repo',
            messages: [],
            hostIdeType: 'cursor',
            workspaceName: 'repo',
            displayPrimary: 'Repo',
            displaySecondary: 'Cursor',
            streamSource: 'native',
            tabKey: 'native-tab',
        }
        const preferredConversation: ActiveConversation = {
            ...nativeConversation,
            sessionId: 'agent-1',
            providerSessionId: 'provider-agent',
            transport: 'cdp-webview',
            agentName: 'Codex',
            agentType: 'codex',
            displaySecondary: 'Cursor · Codex',
            streamSource: 'agent-stream',
            tabKey: 'agent-tab',
        }
        const otherStream: ActiveConversation = {
            ...nativeConversation,
            sessionId: 'agent-2',
            providerSessionId: 'provider-other',
            transport: 'cdp-webview',
            agentName: 'Claude',
            agentType: 'claude-code',
            displaySecondary: 'Cursor · Claude',
            streamSource: 'agent-stream',
            tabKey: 'other-tab',
        }

        const targetMap = buildConversationTargetMap(
            [nativeConversation, preferredConversation, otherStream],
            new Map([[nativeConversation.routeId, preferredConversation]]),
        )

        expect(targetMap.get('machine-1:ide:cursor-1')?.tabKey).toBe('agent-tab')
        expect(targetMap.get('route:machine-1:ide:cursor-1')?.tabKey).toBe('agent-tab')
    })
})
