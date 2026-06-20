import { describe, expect, it } from 'vitest'
import {
    autoMuteConversationIfCoordinator,
    isConversationMutedNow,
    muteConversation,
    unmuteConversation,
} from '../../src/hooks/useMutedConversations'

// The mute store is a module-level singleton; tests use unique providerSessionIds
// so they never contaminate one another's state.

function coordinatorConversation(provider: string) {
    return {
        providerSessionId: provider,
        sessionId: `runtime-${provider}`,
        tabKey: `tab-${provider}`,
        routeId: `machine-1:${provider}`,
        settings: {
            launchedByCoordinator: true,
            meshNodeFor: 'mesh-1',
            spawnedSessionVisibility: 'hidden' as const,
        },
    }
}

describe('useMutedConversations store', () => {
    it('(a) auto-mutes a coordinator-spawned hidden session on first sight', () => {
        const conv = coordinatorConversation('coord-a')
        expect(isConversationMutedNow(conv)).toBe(false)
        autoMuteConversationIfCoordinator(conv)
        expect(isConversationMutedNow(conv)).toBe(true)
    })

    it('(b) preserves a manual unmute — never re-auto-mutes the same session', () => {
        const conv = coordinatorConversation('coord-b')
        autoMuteConversationIfCoordinator(conv)
        expect(isConversationMutedNow(conv)).toBe(true)

        // User manually unmutes.
        unmuteConversation(conv)
        expect(isConversationMutedNow(conv)).toBe(false)

        // A later auto-mute pass (e.g. on reconnect) must NOT re-mute it.
        autoMuteConversationIfCoordinator(conv)
        expect(isConversationMutedNow(conv)).toBe(false)
    })

    it('(c) never auto-mutes a non-coordinator session', () => {
        const visibleCoordinator = {
            providerSessionId: 'coord-c-visible',
            settings: { launchedByCoordinator: true, meshNodeFor: 'mesh-1', spawnedSessionVisibility: 'visible' as const },
        }
        const plainUserSession = {
            providerSessionId: 'user-c',
            sessionId: 'runtime-user-c',
            settings: {},
        }
        autoMuteConversationIfCoordinator(visibleCoordinator)
        autoMuteConversationIfCoordinator(plainUserSession)
        expect(isConversationMutedNow(visibleCoordinator)).toBe(false)
        expect(isConversationMutedNow(plainUserSession)).toBe(false)
    })

    it('matches a muted session by stable provider identity across runtime/tab churn', () => {
        const conv = coordinatorConversation('coord-d')
        muteConversation(conv)
        // Same provider identity, different runtime session + tab keys.
        expect(isConversationMutedNow({
            providerSessionId: 'coord-d',
            sessionId: 'runtime-churned',
            tabKey: 'tab-churned',
        })).toBe(true)
    })

    it('manual mute/unmute toggles independently of coordinator markers', () => {
        const conv = { providerSessionId: 'manual-e', sessionId: 'runtime-e' }
        muteConversation(conv)
        expect(isConversationMutedNow(conv)).toBe(true)
        unmuteConversation(conv)
        expect(isConversationMutedNow(conv)).toBe(false)
    })
})
