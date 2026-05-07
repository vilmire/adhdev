import { describe, expect, it } from 'vitest'
import {
    buildVisibleConversationMessages,
    getConversationLiveMessages,
} from '../../../src/components/dashboard/conversation-message-snapshot'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { SessionChatTailSnapshot } from '../../../src/components/dashboard/session-chat-tail-controller'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1:cli:session-1',
        sessionId: 'session-1',
        providerSessionId: 'provider-1',
        daemonId: 'machine-1',
        transport: 'pty',
        mode: 'chat',
        agentName: 'Hermes',
        agentType: 'hermes-cli',
        status: 'idle',
        title: 'Hermes Agent',
        messages: [],
        workspaceName: '/repo',
        displayPrimary: 'Hermes',
        displaySecondary: 'M4-L',
        streamSource: 'native',
        tabKey: 'machine-1:session:session-1',
        ...overrides,
    }
}

function createSnapshot(messages: ActiveConversation['messages']): SessionChatTailSnapshot {
    return {
        liveMessages: messages,
        hasLiveSnapshot: true,
        cursor: { tailLimit: 60 },
        historyMessages: [],
        historyOffset: 0,
        hasMoreHistory: true,
        historyError: null,
    }
}

describe('conversation message authority snapshot', () => {
    it('uses conversation fallback before any authoritative chat-tail snapshot hydrates', () => {
        const conversation = createConversation({
            messages: [
                { role: 'assistant', content: 'pre-hydration fallback', id: 'fallback-1', receivedAt: 1000 },
            ],
        })

        const liveMessages = getConversationLiveMessages(conversation, null)

        expect(liveMessages.map(message => message.content)).toEqual(['pre-hydration fallback'])
    })

    it('keeps authoritative chat-tail authority even when the live tail is shorter than stale cached conversation rows', () => {
        const conversation = createConversation({
            messages: [
                { role: 'user', content: 'stale cached prompt', id: 'fallback-1', receivedAt: 1000 },
                { role: 'assistant', content: 'stale cached answer', id: 'fallback-2', receivedAt: 2000 },
                { role: 'assistant', content: 'stale cached tool spam', id: 'fallback-3', receivedAt: 3000 },
            ],
        })
        const snapshot = createSnapshot([
            { role: 'assistant', content: 'authoritative recent live tail', id: 'live-1', receivedAt: 4000 },
        ])

        const liveMessages = getConversationLiveMessages(conversation, snapshot)

        expect(liveMessages.map(message => message.content)).toEqual(['authoritative recent live tail'])
    })

    it('respects an authoritative empty chat-tail snapshot instead of resurrecting stale fallback rows', () => {
        const conversation = createConversation({
            messages: [
                { role: 'assistant', content: 'stale fallback should stay hidden', id: 'fallback-1', receivedAt: 1000 },
            ],
        })
        const snapshot = createSnapshot([])

        const liveMessages = getConversationLiveMessages(conversation, snapshot)

        expect(liveMessages).toEqual([])
    })

    it('builds the chat pane visible feed from the same snapshot-selected live messages', () => {
        const conversation = createConversation({
            messages: [
                { role: 'assistant', content: 'compact fallback', id: 'fallback', receivedAt: 1000 },
            ],
        })
        const snapshot = createSnapshot([
            { role: 'assistant', content: 'live one', id: 'live-1', receivedAt: 2000 },
            { role: 'assistant', content: 'live two', id: 'live-2', receivedAt: 3000 },
        ])

        const liveMessages = getConversationLiveMessages(conversation, snapshot)
        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [{ role: 'user', content: 'history', id: 'history-1', receivedAt: 500 }],
            liveMessages,
            visibleLiveCount: 1,
        })

        expect(liveMessages.map(message => message.content)).toEqual(['live one', 'live two'])
        expect(visibleMessages.map(message => message.content)).toEqual(['history', 'live two'])
    })

    it('uses a longer chat-tail snapshot when the latest timestamp ties the conversation fallback', () => {
        const conversation = createConversation({
            messages: [
                { role: 'assistant', content: 'fallback latest only', id: 'fallback-1', receivedAt: 3000 },
            ],
        })
        const snapshot = createSnapshot([
            { role: 'user', content: 'snapshot earlier same turn', id: 'snapshot-1', receivedAt: 2000 },
            { role: 'assistant', content: 'snapshot latest tied timestamp', id: 'snapshot-2', receivedAt: 3000 },
        ])

        const liveMessages = getConversationLiveMessages(conversation, snapshot)

        expect(liveMessages.map(message => message.content)).toEqual([
            'snapshot earlier same turn',
            'snapshot latest tied timestamp',
        ])
    })

    it('uses an explicit chat-tail snapshot as ChatPane live authority when one exists', () => {
        const conversation = createConversation({
            messages: [
                { role: 'assistant', content: 'new transcript last message', id: 'new-1', receivedAt: 4000 },
            ],
            lastMessagePreview: 'new transcript last message',
            lastMessageAt: 4000,
        })
        const snapshot = createSnapshot([
            { role: 'assistant', content: 'middle stale message', id: 'old-1', receivedAt: 2000 },
        ])

        const liveMessages = getConversationLiveMessages(conversation, snapshot)

        expect(liveMessages.map(message => message.content)).toEqual(['middle stale message'])
    })

    it('keeps the latest conversational bubbles visible when a CLI activity flood fills the live tail window', () => {
        const liveMessages = [
            { role: 'user' as const, content: '고쳐줘', id: 'user-1', kind: 'standard', receivedAt: 1000 },
            { role: 'assistant' as const, content: '수정 완료 요약', id: 'assistant-1', kind: 'standard', receivedAt: 2000 },
            ...Array.from({ length: 60 }, (_, index) => ({
                role: 'assistant' as const,
                content: `tool activity ${index}`,
                id: `tool-${index}`,
                kind: index % 2 === 0 ? 'tool' : 'terminal',
                receivedAt: 3000 + index,
            })),
        ]

        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [],
            liveMessages,
            visibleLiveCount: 50,
        })

        expect(visibleMessages.map(message => message.content).slice(0, 2)).toEqual(['고쳐줘', '수정 완료 요약'])
        expect(visibleMessages).toHaveLength(52)
        expect(visibleMessages.slice(2).map(message => message.content)).toEqual(
            liveMessages.slice(-50).map(message => message.content),
        )
    })

    it('does not add conversational anchors when the visible live window already contains one', () => {
        const liveMessages = [
            { role: 'user' as const, content: 'older prompt', id: 'user-older', kind: 'standard', receivedAt: 1000 },
            ...Array.from({ length: 49 }, (_, index) => ({
                role: 'assistant' as const,
                content: `tool activity ${index}`,
                id: `tool-${index}`,
                kind: 'tool',
                receivedAt: 2000 + index,
            })),
            { role: 'assistant' as const, content: 'visible answer', id: 'assistant-visible', kind: 'standard', receivedAt: 3000 },
        ]

        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [],
            liveMessages,
            visibleLiveCount: 50,
        })

        expect(visibleMessages).toHaveLength(50)
        expect(visibleMessages[0]?.content).toBe('tool activity 0')
        expect(visibleMessages[49]?.content).toBe('visible answer')
    })
})
