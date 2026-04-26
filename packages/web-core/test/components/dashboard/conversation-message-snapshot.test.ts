import { describe, expect, it } from 'vitest'
import {
    applyConversationMessageSnapshots,
    buildVisibleConversationMessages,
    getConversationLiveMessages,
    getConversationMessageAuthorityKey,
} from '../../../src/components/dashboard/conversation-message-snapshot'
import { getConversationNotificationPreview } from '../../../src/components/dashboard/conversation-selectors'
import { getConversationPreviewText } from '../../../src/components/dashboard/conversation-presenters'
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
        cursor: { knownMessageCount: messages.length, lastMessageSignature: 'sig', tailLimit: 60 },
        historyMessages: [],
        historyOffset: 0,
        hasMoreHistory: true,
        historyError: null,
    }
}

describe('conversation message authority snapshot', () => {
    it('feeds mobile and notification previews from the same live chat-tail message snapshot', () => {
        const conversation = createConversation({
            messages: [{ role: 'assistant', content: 'old row message', id: 'old-1', receivedAt: 1000 }],
            lastMessagePreview: 'stale compact preview',
            lastMessageAt: 3000,
        })
        const snapshots = new Map([
            [getConversationMessageAuthorityKey(conversation), createSnapshot([
                { role: 'assistant', content: 'actual last message in chat', id: 'new-1', receivedAt: 2000 },
            ])],
        ])

        const [authoritative] = applyConversationMessageSnapshots([conversation], snapshots)

        expect(authoritative?.messages).toEqual([
            { role: 'assistant', content: 'actual last message in chat', id: 'new-1', receivedAt: 2000 },
        ])
        expect(authoritative?.lastMessagePreview).toBe('actual last message in chat')
        expect(authoritative?.lastMessageAt).toBe(2000)
        expect(getConversationPreviewText(authoritative!)).toBe('actual last message in chat')
        expect(getConversationNotificationPreview(authoritative!)).toBe('actual last message in chat')
    })

    it('does not let an older warm snapshot replace a newer conversation transcript', () => {
        const conversation = createConversation({
            messages: [{ role: 'assistant', content: 'newer conversation message', id: 'new-1', receivedAt: 3000 }],
            lastMessagePreview: 'newer conversation message',
            lastMessageAt: 3000,
        })
        const snapshots = new Map([
            [getConversationMessageAuthorityKey(conversation), createSnapshot([
                { role: 'assistant', content: 'older warm message', id: 'old-1', receivedAt: 1000 },
            ])],
        ])

        const result = applyConversationMessageSnapshots([conversation], snapshots)

        expect(result).toBeInstanceOf(Array)
        expect(result[0]).toBe(conversation)
        expect(getConversationPreviewText(result[0]!)).toBe('newer conversation message')
    })

    it('keeps the rich conversation transcript when a warm snapshot has the same timestamp', () => {
        const conversation = createConversation({
            messages: [{ role: 'assistant', content: 'rich transcript body', id: 'rich-1', receivedAt: 3000 }],
            lastMessagePreview: 'rich transcript body',
            lastMessageAt: 3000,
        })
        const snapshots = new Map([
            [getConversationMessageAuthorityKey(conversation), createSnapshot([
                { role: 'assistant', content: 'same-time warm snapshot body', id: 'warm-1', receivedAt: 3000 },
            ])],
        ])

        const result = applyConversationMessageSnapshots([conversation], snapshots)

        expect(result[0]).toBe(conversation)
        expect(result[0]?.messages).toEqual([
            { role: 'assistant', content: 'rich transcript body', id: 'rich-1', receivedAt: 3000 },
        ])
        expect(getConversationPreviewText(result[0]!)).toBe('rich transcript body')
        expect(getConversationNotificationPreview(result[0]!)).toBe('rich transcript body')
    })

    it('keeps the rich conversation transcript when a warm snapshot has no provably newer timestamp', () => {
        const conversation = createConversation({
            messages: [{ role: 'assistant', content: 'rich transcript without timestamp', id: 'rich-1' }],
            lastMessagePreview: 'rich transcript without timestamp',
        })
        const snapshots = new Map([
            [getConversationMessageAuthorityKey(conversation), createSnapshot([
                { role: 'assistant', content: 'untimed warm snapshot body', id: 'warm-1' },
            ])],
        ])

        const result = applyConversationMessageSnapshots([conversation], snapshots)

        expect(result[0]).toBe(conversation)
        expect(result[0]?.messages).toEqual([
            { role: 'assistant', content: 'rich transcript without timestamp', id: 'rich-1' },
        ])
        expect(getConversationPreviewText(result[0]!)).toBe('rich transcript without timestamp')
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
})
