import { describe, expect, it } from 'vitest'
import {
    buildVisibleConversationMessages,
    getConversationLiveMessages,
} from '../../../src/components/dashboard/conversation-message-snapshot'
import { filterChatMessagesForDefaultTranscript } from '../../../src/components/dashboard/chat-activity-visibility'
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

    it('rescues the latest assistant answer when an activity flood + trailing user prompt bury it (ANTIGRAVITY-TAIL-USER-ONLY)', () => {
        // A MAGI/antigravity coordinator turn: user prompt, the assistant ANSWER,
        // then >50 non-substantive activity bubbles, then a trailing user dispatch
        // echo. The raw slice(-50) fills the window with activity + the trailing
        // user and pushes the answer into the hidden tail, so the pane would open
        // showing ONLY the user prompt until "Load older" is clicked.
        const liveMessages = [
            { role: 'user' as const, content: 'MAGI 테스트. RCA로 현재 깃 상태 확인', id: 'user-prompt', kind: 'standard', receivedAt: 1000 },
            { role: 'assistant' as const, content: 'MAGI RCA 완료 요약 (THE ANSWER)', id: 'assistant-answer', kind: 'standard', receivedAt: 2000 },
            ...Array.from({ length: 55 }, (_, index) => ({
                role: (index % 3 === 2 ? 'system' : 'assistant') as 'system' | 'assistant',
                content: `activity ${index}`,
                id: `activity-${index}`,
                kind: ['tool', 'thought', 'system'][index % 3],
                receivedAt: 3000 + index,
            })),
            { role: 'user' as const, content: 'Mission "MAGI: git status" dispatched', id: 'user-trailing', kind: 'standard', receivedAt: 4000 },
        ]

        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [],
            liveMessages,
            visibleLiveCount: 50,
        })

        const rendered = filterChatMessagesForDefaultTranscript(visibleMessages)
        const renderedRoles = rendered.map(message => message.role)
        // The buried answer is rescued to the front; the trailing user stays.
        expect(renderedRoles).toContain('assistant')
        expect(renderedRoles).toContain('user')
        expect(rendered[0]?.content).toBe('MAGI RCA 완료 요약 (THE ANSWER)')
    })

    it('sorts a native-history assistant turn chronologically instead of clumping it after all live rows (CHAT-VISIBLE-CHRONO-ORDER)', () => {
        // Antigravity/MAGI failure mode: the current turn's assistant answer lands
        // in historyMessages (native history) while the user's dispatch echo is a
        // live row. Positional concat renders [history..., live...], burying the
        // assistant answer above the initial window even though it is chronologically
        // BEFORE the live user echo. The chrono sort must interleave them by time.
        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [
                { role: 'user', content: 'user prompt', id: 'h-user', receivedAt: 1000 },
                { role: 'assistant', content: 'assistant answer (native history)', id: 'h-assistant', receivedAt: 2000 },
            ],
            liveMessages: [
                { role: 'user', content: 'live user echo', id: 'l-user', receivedAt: 3000 },
            ],
            visibleLiveCount: 5,
        })

        expect(visibleMessages.map(message => message.content)).toEqual([
            'user prompt',
            'assistant answer (native history)',
            'live user echo',
        ])
    })

    it('interleaves history and live rows by timestamp so an early live row is not clumped behind later history', () => {
        // Naive positional concat would render [history@t1, history@t4, live@t2, live@t3];
        // the chronological sort must produce t1,t2,t3,t4.
        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [
                { role: 'user', content: 't1 history', id: 'h1', receivedAt: 1000 },
                { role: 'assistant', content: 't4 history', id: 'h2', receivedAt: 4000 },
            ],
            liveMessages: [
                { role: 'user', content: 't2 live', id: 'l1', receivedAt: 2000 },
                { role: 'assistant', content: 't3 live', id: 'l2', receivedAt: 3000 },
            ],
            visibleLiveCount: 5,
        })

        expect(visibleMessages.map(message => message.content)).toEqual([
            't1 history',
            't2 live',
            't3 live',
            't4 history',
        ])
    })

    it('preserves original relative order for messages that share a timestamp or carry none (stable sort)', () => {
        // Two rows share receivedAt=1000 and two more carry no chronological key at
        // all (getMessageTimestamp -> 0). The sort must be total and stable: equal
        // keys keep their original relative order, and keyless rows are neither
        // dropped nor floated to the top.
        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [
                { role: 'user', content: 'tie A', id: 'a', receivedAt: 1000 },
                { role: 'assistant', content: 'tie B', id: 'b', receivedAt: 1000 },
                { role: 'system', content: 'no-ts C', id: 'c' },
            ],
            liveMessages: [
                { role: 'system', content: 'no-ts D', id: 'd' },
                { role: 'assistant', content: 'later E', id: 'e', receivedAt: 2000 },
            ],
            visibleLiveCount: 5,
        })

        // keyless rows (ts=0) sort first but keep their relative order (C before D),
        // then the tie pair in original order (A before B), then the later row.
        expect(visibleMessages.map(message => message.content)).toEqual([
            'no-ts C',
            'no-ts D',
            'tie A',
            'tie B',
            'later E',
        ])
    })

    it('places a rescued assistant answer in its correct chronological slot after the anchor-rescue fires', () => {
        // Compose the ANTIGRAVITY-TAIL-USER-ONLY rescue with the chrono sort: the
        // rescued answer (t2000) must land before the later activity/user rows, not
        // merely prepended, so the rescue path stays regression-safe under sorting.
        const liveMessages = [
            { role: 'user' as const, content: 'prompt', id: 'user-prompt', kind: 'standard', receivedAt: 1000 },
            { role: 'assistant' as const, content: 'THE ANSWER', id: 'assistant-answer', kind: 'standard', receivedAt: 2000 },
            ...Array.from({ length: 55 }, (_, index) => ({
                role: 'assistant' as const,
                content: `activity ${index}`,
                id: `activity-${index}`,
                kind: 'tool',
                receivedAt: 3000 + index,
            })),
            { role: 'user' as const, content: 'trailing echo', id: 'user-trailing', kind: 'standard', receivedAt: 4000 },
        ]

        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [],
            liveMessages,
            visibleLiveCount: 50,
        })

        // Rescued answer sits at its true time (2000) — before every t3000+ activity
        // row and before the t4000 trailing user echo.
        expect(visibleMessages[0]?.content).toBe('THE ANSWER')
        const answerIndex = visibleMessages.findIndex(m => m.content === 'THE ANSWER')
        const trailingIndex = visibleMessages.findIndex(m => m.content === 'trailing echo')
        expect(answerIndex).toBeLessThan(trailingIndex)
        const timestamps = visibleMessages.map(m => Number(m.receivedAt) || 0)
        const sorted = [...timestamps].sort((x, y) => x - y)
        expect(timestamps).toEqual(sorted)
    })

    it('keeps the just-finished assistant answer pinned when a user-send activity flood pushes it into the hidden tail (CHAT-ASSISTANT-ANCHOR-PRESERVE)', () => {
        // Reproduces the reported flicker: a LONG conversation whose visible window
        // (slice(-50)) is entirely older activity + older turns, then the user sends a
        // prompt. The daemon appends the user echo and a burst of hidden activity
        // bubbles, shifting the raw slice forward so the substantive assistant answer
        // that just landed is pushed OUT of the visible window into the hidden tail —
        // while the fresh trailing user echo stays visible. Without the pin the pane
        // would render the user bubble but drop the assistant answer for a beat.
        const liveMessages = [
            // Older tail already filling most of the slice budget (activity-heavy).
            ...Array.from({ length: 45 }, (_, index) => ({
                role: 'assistant' as const,
                content: `older activity ${index}`,
                id: `older-activity-${index}`,
                kind: 'tool',
                receivedAt: 1000 + index,
            })),
            // The turn the user was reading: prompt + the substantive answer.
            { role: 'user' as const, content: 'previous prompt', id: 'prev-user', kind: 'standard', receivedAt: 2000 },
            { role: 'assistant' as const, content: 'THE ANSWER I WAS READING', id: 'the-answer', kind: 'standard', receivedAt: 2100 },
            // User sends again -> echo + a flood of hidden activity that shoves the
            // answer above the slice(-50) window.
            { role: 'user' as const, content: 'new user prompt', id: 'new-user', kind: 'standard', receivedAt: 3000 },
            ...Array.from({ length: 12 }, (_, index) => ({
                role: 'assistant' as const,
                content: `dispatch activity ${index}`,
                id: `dispatch-activity-${index}`,
                kind: index % 2 === 0 ? 'tool' : 'thought',
                receivedAt: 3100 + index,
            })),
        ]

        const visibleMessages = buildVisibleConversationMessages({
            historyMessages: [],
            liveMessages,
            visibleLiveCount: 50,
        })

        const rendered = filterChatMessagesForDefaultTranscript(visibleMessages)
        const renderedContents = rendered.map(message => message.content)
        // The assistant answer the user was reading is still on screen (never dropped)...
        expect(renderedContents).toContain('THE ANSWER I WAS READING')
        // ...and the fresh user prompt is still on screen too (both substantive turns kept).
        expect(renderedContents).toContain('new user prompt')
        // The answer sorts before the newer user prompt (chronological slot preserved).
        expect(renderedContents.indexOf('THE ANSWER I WAS READING'))
            .toBeLessThan(renderedContents.indexOf('new user prompt'))
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
