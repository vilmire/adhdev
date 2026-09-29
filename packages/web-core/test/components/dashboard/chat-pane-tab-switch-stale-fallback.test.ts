import { beforeEach, describe, expect, it } from 'vitest'
import type { ReplicatedTranscriptViewV2 } from '@adhdev/daemon-core'
import { buildChatPaneControllerOptions } from '../../../src/components/dashboard/ChatPane'
import {
    getDefaultVisibleLiveMessages,
    getRememberedVisibleLiveCount,
    rememberVisibleLiveCount,
    resetVisibleLiveCountMemoryForTest,
} from '../../../src/components/dashboard/chat-visibility'
import { getConversationLiveMessages } from '../../../src/components/dashboard/conversation-message-snapshot'
import {
    applyTranscriptViewToControllers,
    getOrCreateSessionChatController,
    resetSessionChatControllersForTest,
} from '../../../src/components/dashboard/session-chat-controller'
import type { ActiveConversation, DashboardMessage } from '../../../src/components/dashboard/types'

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
    } as ActiveConversation
}

function message(id: string, role: 'user' | 'assistant', content: string): DashboardMessage {
    return { id, role, content, timestamp: 1 } as unknown as DashboardMessage
}

/** Deliver one committed keyed view with plain bubbles. */
function deliver(sessionId: string, bubbles: Array<[string, 'user' | 'assistant', string]>): void {
    const view = {
        schemaVersion: 2, sessionId, historySessionId: null, providerType: 'hermes-cli', providerSessionId: null,
        producerDaemonId: 'machine-1', producerWriterId: 'w', epoch: 'e', frame: 1, observedAt: '2026-09-29T00:00:00.000Z',
        status: 'idle', providerObservedStatus: null, title: null, activeModal: null, activeInteractivePrompt: null, turn: null,
        provenance: { messageSource: null, transcriptProvenance: null }, terminalMarkers: [],
        coverage: { mode: 'full', totalMessageCount: bubbles.length, returnedMessageCount: bubbles.length, omittedBefore: false },
        messages: bubbles.map(([id, role, content], i) => ({
            role, kind: 'standard', content, receivedAt: 1, timestamp: 1, turnKey: 't', bubbleState: 'final',
            senderName: null, toolName: null, streaming: null, messageId: id, ord: `a${i}`, rev: 1, expandable: false, srcId: null,
        })),
    } as unknown as ReplicatedTranscriptViewV2
    applyTranscriptViewToControllers('machine-1', sessionId, view)
}

function createLiveController(sessionId: string) {
    const controller = getOrCreateSessionChatController({
        daemonId: 'machine-1',
        sessionId,
        historySessionId: 'provider-1',
        sendData: () => true,
        fallbackRecentCount: 0,
    })
    return { controller }
}

beforeEach(() => {
    resetSessionChatControllersForTest()
    resetVisibleLiveCountMemoryForTest()
})

describe('① panel visibility must not tear down the chat controller', () => {
    it('keeps the controller enabled while the pane is hidden', () => {
        // TARGET: reverting ① (enabled: isVisible && !!sessionId) makes this false,
        // which drops the controller and hands the pane the stale fallback below.
        expect(buildChatPaneControllerOptions({ sessionId: 'session-1', isVisible: false }).enabled).toBe(true)
    })

    it('is enabled whenever a session exists, and disabled without one', () => {
        expect(buildChatPaneControllerOptions({ sessionId: 'session-1', isVisible: true })).toEqual({ enabled: true })
        expect(buildChatPaneControllerOptions({ sessionId: undefined, isVisible: true }).enabled).toBe(false)
    })

    it('renders the LIVE window rather than the stale status-meta fallback across a hide/show cycle', () => {
        const { controller } = createLiveController('session-1')
        controller.retain()

        // The committed keyed view: the current, correct transcript.
        deliver('session-1', [['m1', 'user', 'ask'], ['m2', 'assistant', 'fresh live answer']])

        // status-meta carries an OLDER list — this is what the pane fell back to
        // when the controller was torn down on hide.
        const conversation = createConversation({
            messages: [message('stale', 'assistant', 'stale meta answer')],
        })

        const snapshot = controller.getSnapshot()
        expect(snapshot.hasLiveSnapshot).toBe(true)

        // TARGET: with ① reverted the pane holds an EMPTY snapshot while hidden
        // (hasLiveSnapshot: false), and this resolves to the stale meta list.
        const live = getConversationLiveMessages(conversation, snapshot)
        expect(live.map(m => (m as { content: string }).content)).toEqual(['ask', 'fresh live answer'])
        expect(live.map(m => (m as { content: string }).content)).not.toContain('stale meta answer')

        controller.release()
    })
})

describe('② control group — a real session switch must not leak the previous transcript', () => {
    it('gives each session its own controller and live window', () => {
        const first = createLiveController('session-1')
        first.controller.retain()
        deliver('session-1', [['a1', 'assistant', 'session one answer']])

        const second = createLiveController('session-2')
        second.controller.retain()

        // Distinct controller instances — keeping session-1 subscribed cannot put
        // its content in front of session-2.
        expect(second.controller).not.toBe(first.controller)

        const secondSnapshot = second.controller.getSnapshot()
        expect(secondSnapshot.liveMessages).toEqual([])
        expect(secondSnapshot.hasLiveSnapshot).toBe(false)

        // And session-2's pane resolves to ITS OWN conversation meta, never
        // session-1's live window.
        const secondConversation = createConversation({
            sessionId: 'session-2',
            routeId: 'machine-1:cli:session-2',
            tabKey: 'machine-1:session:session-2',
            messages: [message('b1', 'assistant', 'session two meta')],
        })
        const live = getConversationLiveMessages(secondConversation, secondSnapshot)
        expect(live.map(m => (m as { content: string }).content)).toEqual(['session two meta'])
        expect(live.map(m => (m as { content: string }).content)).not.toContain('session one answer')

        first.controller.release()
        second.controller.release()
    })
})

describe('② visibleLiveCount is remembered per tab', () => {
    it('defaults on first open and restores an expanded window for the same tab', () => {
        const fallback = getDefaultVisibleLiveMessages({ isCliLike: true })

        expect(getRememberedVisibleLiveCount('tab-a', fallback)).toBe(fallback)

        rememberVisibleLiveCount('tab-a', fallback + 60)

        // TARGET: reverting ② resets to `fallback` here, so the visible range
        // shrinks then re-grows on every switch back — the residual "jump".
        expect(getRememberedVisibleLiveCount('tab-a', fallback)).toBe(fallback + 60)
    })

    it('does not carry one tab\'s expansion into another tab', () => {
        const fallback = getDefaultVisibleLiveMessages({ isCliLike: true })
        rememberVisibleLiveCount('tab-a', fallback + 120)

        expect(getRememberedVisibleLiveCount('tab-b', fallback)).toBe(fallback)
    })

    it('never shrinks below the current default when the default grows', () => {
        rememberVisibleLiveCount('tab-a', 50)
        // CLI (50) → standard (60) view-mode flip: the larger default wins.
        expect(getRememberedVisibleLiveCount('tab-a', 60)).toBe(60)
    })

    it('ignores an empty tab key rather than colliding on it', () => {
        rememberVisibleLiveCount('', 999)
        expect(getRememberedVisibleLiveCount('', 60)).toBe(60)
    })
})
