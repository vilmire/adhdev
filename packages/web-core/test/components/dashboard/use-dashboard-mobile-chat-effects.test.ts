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

    it('refuses explicit machine target when candidate owner is unknown', () => {
        const unknownOwner = makeConv({
            tabKey: 'unscoped-tab',
            routeId: 'unscoped-route',
            sessionId: 'shared-session',
        })

        expect(findMatchingMobileConversation(
            [unknownOwner],
            [],
            { nodeId: 'daemon-b', sessionId: 'shared-session' },
        )).toBeNull()

        expect(findMatchingMobileConversation(
            [unknownOwner],
            [],
            { targetKey: 'session:daemon-b:shared-session' },
        )).toBeNull()

        // Deliberate unscoped session lookup still resolves when no machine owner was requested.
        expect(findMatchingMobileConversation(
            [unknownOwner],
            [],
            { targetKey: 'session:shared-session' },
        )).toEqual({
            conversation: unknownOwner,
            isHidden: false,
        })
    })

    it('refuses obsolete route or tab suffix when current runtime sessionId differs', () => {
        const replacedSession = makeConv({
            tabKey: 'daemon-b:old-session',
            routeId: 'daemon-b:old-session',
            daemonId: 'daemon-b',
            sessionId: 'replacement-session',
            providerSessionId: 'prov-replacement',
        })

        expect(findMatchingMobileConversation(
            [replacedSession],
            [],
            { nodeId: 'daemon-b', sessionId: 'old-session' },
        )).toBeNull()

        expect(findMatchingMobileConversation(
            [replacedSession],
            [],
            { targetKey: 'session:daemon-b:old-session' },
        )).toBeNull()

        expect(findMatchingMobileConversation(
            [replacedSession],
            [],
            { targetKey: 'session:old-session' },
        )).toBeNull()

        // Current runtime sessionId and deliberate provider lookup still resolve.
        expect(findMatchingMobileConversation(
            [replacedSession],
            [],
            { nodeId: 'daemon-b', sessionId: 'replacement-session' },
        )).toEqual({
            conversation: replacedSession,
            isHidden: false,
        })

        expect(findMatchingMobileConversation(
            [replacedSession],
            [],
            { targetKey: 'provider:prov-replacement' },
        )).toEqual({
            conversation: replacedSession,
            isHidden: false,
        })
    })
})
