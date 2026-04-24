import { describe, expect, it } from 'vitest'
import { buildConversationSourceSignature, buildConversationTargetMap } from '../../src/hooks/useDashboardConversations'
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
