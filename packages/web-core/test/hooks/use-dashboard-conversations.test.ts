import { describe, expect, it } from 'vitest'
import { buildConversationSourceSignature } from '../../src/hooks/useDashboardConversations'
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
})
