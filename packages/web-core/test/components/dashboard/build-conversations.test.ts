import { describe, expect, it } from 'vitest'
import { buildScopedIdeConversations, getIdeConversationBuildContext } from '../../../src/components/dashboard/buildConversations'
import type { DaemonData } from '../../../src/types'

function createIdeEntry(overrides: Partial<DaemonData> = {}): DaemonData {
    return {
        id: 'machine-1:ide:cursor-1',
        daemonId: 'machine-1',
        sessionId: 'cursor-1',
        type: 'cursor',
        transport: 'cdp-page',
        status: 'online',
        workspace: '/repo',
        chats: [],
        activeChat: {
            id: 'chat-1',
            title: 'Cursor Chat',
            status: 'idle',
            messages: [],
            activeModal: null,
        },
        childSessions: [],
        ...overrides,
    }
}

describe('build conversations shared context', () => {
    it('derives machine name and connection state consistently', () => {
        const ide = createIdeEntry()
        expect(getIdeConversationBuildContext(ide, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })).toEqual({
            machineName: 'Studio Mac',
            connectionState: 'connected',
        })
    })

    it('builds conversations through the shared scoped helper', () => {
        const ide = createIdeEntry()
        const conversations = buildScopedIdeConversations(ide, {}, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations).toHaveLength(1)
        expect(conversations[0]).toMatchObject({
            routeId: 'machine-1:ide:cursor-1',
            machineName: 'Studio Mac',
            connectionState: 'connected',
            tabKey: 'cursor-1',
        })
    })
})
