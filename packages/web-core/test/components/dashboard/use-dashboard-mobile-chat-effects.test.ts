import { describe, expect, it } from 'vitest'
import {
    findMatchingMobileConversation,
    shouldReturnToInboxWhenSelectedConversationIsMissing,
} from '../../../src/components/dashboard/useDashboardMobileChatEffects'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function makeConv(overrides: Partial<ActiveConversation> & { tabKey: string; routeId: string }): ActiveConversation {
    return {
        mode: 'chat',
        agentName: 'Codex',
        agentType: 'codex-cli',
        status: 'idle',
        title: 'Session',
        messages: [],
        displayPrimary: 'Session',
        displaySecondary: 'Codex',
        streamSource: 'native',
        ...overrides,
    }
}

describe('useDashboardMobileChatEffects', () => {
    it('only forces inbox fallback when the missing conversation was actively open in chat view', () => {
        expect(shouldReturnToInboxWhenSelectedConversationIsMissing('chat')).toBe(true)
        expect(shouldReturnToInboxWhenSelectedConversationIsMissing('inbox')).toBe(false)
        expect(shouldReturnToInboxWhenSelectedConversationIsMissing('machine')).toBe(false)
    })

    it('resolves both visible and hidden conversations and disambiguates by machine identity without falling back to the first conversation', () => {
        const visibleFirst = makeConv({
            tabKey: 'daemon-a:shared-session',
            routeId: 'daemon-a:shared-session',
            daemonId: 'daemon-a',
            sessionId: 'shared-session',
        })
        const hiddenWorker = makeConv({
            tabKey: 'daemon-b:shared-session',
            routeId: 'daemon-b:shared-session',
            daemonId: 'daemon-b',
            sessionId: 'shared-session',
        })
        const hiddenUnique = makeConv({
            tabKey: 'daemon-b:worker-only',
            routeId: 'daemon-b:worker-only',
            daemonId: 'daemon-b',
            sessionId: 'worker-only',
        })

        expect(findMatchingMobileConversation(
            [visibleFirst],
            [hiddenWorker, hiddenUnique],
            { nodeId: 'daemon-b', sessionId: 'shared-session' },
        )).toEqual({
            conversation: hiddenWorker,
            isHidden: true,
        })

        expect(findMatchingMobileConversation(
            [visibleFirst],
            [hiddenWorker, hiddenUnique],
            { targetKey: 'session:daemon-b:shared-session' },
        )).toEqual({
            conversation: hiddenWorker,
            isHidden: true,
        })

        expect(findMatchingMobileConversation(
            [visibleFirst],
            [hiddenWorker, hiddenUnique],
            { targetKey: 'session:worker-only' },
        )).toEqual({
            conversation: hiddenUnique,
            isHidden: true,
        })

        expect(findMatchingMobileConversation(
            [visibleFirst],
            [hiddenWorker, hiddenUnique],
            { nodeId: 'daemon-c', sessionId: 'shared-session' },
        )).toBeNull()

        expect(findMatchingMobileConversation(
            [visibleFirst],
            [hiddenWorker, hiddenUnique],
            { targetKey: 'session:missing-session' },
        )).toBeNull()
    })
})
