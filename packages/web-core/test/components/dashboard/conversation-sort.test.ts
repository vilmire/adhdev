import { describe, expect, it } from 'vitest'
import { getConversationTimestamp } from '../../../src/components/dashboard/conversation-sort'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1:cli:hermes-1',
        sessionId: 'session-1',
        daemonId: 'machine-1',
        agentName: 'Hermes Agent',
        agentType: 'hermes-cli',
        status: 'idle',
        title: 'Hermes Agent',
        messages: [],
        workspaceName: 'repo',
        displayPrimary: 'repo',
        displaySecondary: 'Hermes Agent',
        streamSource: 'native',
        tabKey: 'session-1',
        transport: 'pty',
        mode: 'chat',
        ...overrides,
    }
}

describe('conversation sort timestamp', () => {
    it('uses the transcript tail when compact lastMessageAt is stale', () => {
        const conversation = createConversation({
            lastMessageAt: 1000,
            messages: [
                { role: 'assistant', content: 'latest', receivedAt: 2000 },
            ],
        })

        expect(getConversationTimestamp(conversation)).toBe(2000)
    })

    it('uses compact lastMessageAt when it is newer than the transcript tail', () => {
        const conversation = createConversation({
            lastMessageAt: 3000,
            messages: [
                { role: 'assistant', content: 'older', receivedAt: 2000 },
            ],
        })

        expect(getConversationTimestamp(conversation)).toBe(3000)
    })
})
