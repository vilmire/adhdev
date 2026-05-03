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

    it('prefers a shorter chat-tail snapshot over a duplicate streaming fallback with the same latest bubble identity', () => {
        const duplicateUnitKey = 'hermes-cli:turn_1:assistant:standard:0'
        const conversation = createConversation({
            messages: [
                { role: 'user', content: 'hello', id: 'msg-1', receivedAt: 1000 },
                { role: 'assistant', content: 'partial', id: 'hermes_1m3osyj', bubbleId: 'hermes_1m3osyj', providerUnitKey: duplicateUnitKey, bubbleState: 'streaming', receivedAt: 3000 },
                { role: 'assistant', content: 'partial longer', id: 'hermes_1m3osyj', bubbleId: 'hermes_1m3osyj', providerUnitKey: duplicateUnitKey, bubbleState: 'streaming', receivedAt: 3000 },
                { role: 'assistant', content: 'partial longer final', id: 'hermes_1m3osyj', bubbleId: 'hermes_1m3osyj', providerUnitKey: duplicateUnitKey, bubbleState: 'final', receivedAt: 3000 },
            ],
        })
        const snapshot = createSnapshot([
            { role: 'user', content: 'hello', id: 'msg-1', receivedAt: 1000 },
            { role: 'assistant', content: 'partial longer final', id: 'hermes_1m3osyj', bubbleId: 'hermes_1m3osyj', providerUnitKey: duplicateUnitKey, bubbleState: 'final', receivedAt: 3000 },
        ])

        const liveMessages = getConversationLiveMessages(conversation, snapshot)
        const [authoritative] = applyConversationMessageSnapshots([conversation], new Map([
            [getConversationMessageAuthorityKey(conversation), snapshot],
        ]))

        expect(liveMessages.map(message => message.content)).toEqual(['hello', 'partial longer final'])
        expect(authoritative?.messages.map(message => message.content)).toEqual(['hello', 'partial longer final'])
    })

    it('prefers a same-length clean chat-tail snapshot over a duplicate streaming conversation fallback', () => {
        const duplicateUnitKey = 'hermes-cli:turn_1_4ms0i2:assistant:standard:0'
        const conversation = createConversation({
            messages: [
                { role: 'user', content: 'first prompt', id: 'user-0', receivedAt: 1000 },
                { role: 'assistant', content: 'prior answer', id: 'prior-1', receivedAt: 2000 },
                { role: 'user', content: '확실히 이제 제한에 대한 버그는 잡은거지?', id: 'user-1', receivedAt: 3000 },
                { role: 'assistant', content: '응, “이번에 말한 제한 버그” 범위에서는 잡혔다고 봐도 됨. 확인된 것:', id: 'hermes_olooqs', bubbleId: 'hermes_olooqs', providerUnitKey: duplicateUnitKey, bubbleState: 'streaming', receivedAt: 4000 },
                { role: 'assistant', content: '응, “이번에 말한 제한 버그” 범위에서는 잡혔다고 봐도 됨. 확인된 것:', id: 'hermes_olooqs', bubbleId: 'hermes_olooqs', providerUnitKey: duplicateUnitKey, bubbleState: 'streaming', receivedAt: 4000 },
            ],
        })
        const snapshot = createSnapshot([
            { role: 'user', content: 'older prompt restored by read_chat', id: 'user-restored', receivedAt: 500 },
            { role: 'user', content: 'first prompt', id: 'user-0', receivedAt: 1000 },
            { role: 'assistant', content: 'prior answer', id: 'prior-1', receivedAt: 2000 },
            { role: 'user', content: '확실히 이제 제한에 대한 버그는 잡은거지?', id: 'user-1', receivedAt: 3000 },
            { role: 'assistant', content: '응, “이번에 말한 제한 버그” 범위에서는 잡혔다고 봐도 됨. 확인된 것:', id: 'hermes_olooqs', bubbleId: 'hermes_olooqs', providerUnitKey: duplicateUnitKey, bubbleState: 'streaming', receivedAt: 4000 },
        ])

        const liveMessages = getConversationLiveMessages(conversation, snapshot)
        const [authoritative] = applyConversationMessageSnapshots([conversation], new Map([
            [getConversationMessageAuthorityKey(conversation), snapshot],
        ]))

        expect(liveMessages.map(message => message.content)).toEqual([
            'older prompt restored by read_chat',
            'first prompt',
            'prior answer',
            '확실히 이제 제한에 대한 버그는 잡은거지?',
            '응, “이번에 말한 제한 버그” 범위에서는 잡혔다고 봐도 됨. 확인된 것:',
        ])
        expect(authoritative?.messages).toBe(snapshot.liveMessages)
    })

    it('does not let a stale chat-tail controller snapshot mask a newer conversation transcript in ChatPane', () => {
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

        expect(liveMessages.map(message => message.content)).toEqual(['new transcript last message'])
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
