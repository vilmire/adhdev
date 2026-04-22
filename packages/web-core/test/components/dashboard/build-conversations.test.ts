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
        sessionCapabilities: ['read_chat', 'open_panel'],
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
            sessionCapabilities: ['read_chat', 'open_panel'],
        })
    })

    it('prefers a native conversation title over workspace name when the title is meaningful', () => {
        const ide = createIdeEntry({
            workspace: '/repo',
            activeChat: {
                id: 'chat-1',
                title: 'Fix reconnect race',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
        })

        const conversations = buildScopedIdeConversations(ide, {}, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations[0]).toMatchObject({
            title: 'Fix reconnect race',
            displayPrimary: 'Fix reconnect race',
        })
    })

    it('prefers an extension conversation title over workspace or parent file title', () => {
        const ide = createIdeEntry({
            type: 'antigravity',
            activeChat: {
                id: 'chat-parent',
                title: 'approval-utils.ts',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
            childSessions: [{
                id: 'child-1',
                parentId: 'cursor-1',
                providerType: 'claude-code-vscode',
                providerName: 'Claude Code (VS Code)',
                kind: 'agent',
                transport: 'cdp-webview',
                status: 'idle',
                title: 'Actual Conversation Title',
                workspace: '/repo',
                activeChat: {
                    id: 'chat-child',
                    title: 'Actual Conversation Title',
                    status: 'idle',
                    messages: [],
                    activeModal: null,
                },
                capabilities: ['read_chat', 'open_panel'] as any,
            }],
        })

        const conversations = buildScopedIdeConversations(ide, {}, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations).toHaveLength(2)
        expect(conversations[1]).toMatchObject({
            agentName: 'Claude Code (VS Code)',
            title: 'Actual Conversation Title',
            displayPrimary: 'Actual Conversation Title',
            sessionCapabilities: ['read_chat', 'open_panel'],
        })
    })

    it('falls back to the provider label instead of the parent file title when an extension title is generic', () => {
        const ide = createIdeEntry({
            type: 'antigravity',
            workspace: null,
            activeChat: {
                id: 'chat-parent',
                title: 'approval-utils.ts',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
            childSessions: [{
                id: 'child-2',
                parentId: 'cursor-1',
                providerType: 'codex',
                providerName: 'Codex',
                kind: 'agent',
                transport: 'cdp-webview',
                status: 'idle',
                title: 'Codex',
                workspace: null,
                activeChat: {
                    id: 'chat-child-2',
                    title: 'Codex',
                    status: 'idle',
                    messages: [],
                    activeModal: null,
                },
                capabilities: ['read_chat'],
            }],
        })

        const conversations = buildScopedIdeConversations(ide, {}, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations).toHaveLength(2)
        expect(conversations[1]).toMatchObject({
            agentName: 'Codex',
            title: '',
            displayPrimary: 'Codex',
        })
    })

    it('preserves provider-supplied CLI casing for native conversations', () => {
        const cli = createIdeEntry({
            id: 'machine-1:cli:cli-1',
            sessionId: 'cli-1',
            type: 'codex-cli',
            transport: 'pty',
            cliName: 'Codex CLI',
            mode: 'chat',
            activeChat: {
                id: 'chat-1',
                title: 'Codex CLI',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
        })

        const conversations = buildScopedIdeConversations(cli, {}, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations).toHaveLength(1)
        expect(conversations[0]).toMatchObject({
            agentName: 'Codex CLI',
            displayPrimary: 'repo',
            displaySecondary: 'Codex CLI',
        })
    })

    it('renders only daemon-provided native CLI transcript messages without frontend local message overlays', () => {
        const cli = createIdeEntry({
            id: 'cli-2',
            daemonId: 'machine-1',
            type: 'hermes-cli',
            transport: 'pty',
            cliName: 'Hermes Agent',
            mode: 'chat',
            activeChat: {
                id: 'chat-2',
                title: 'Hermes Agent',
                status: 'idle',
                messages: [
                    { role: 'assistant', content: 'Existing reply', receivedAt: 1000 },
                ],
                activeModal: null,
            },
        })

        const conversations = buildScopedIdeConversations(cli, {
            'cli-2': [
                { role: 'user', content: 'Follow-up prompt', timestamp: 2000, _localId: 'local-cli-1' },
            ],
        }, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations).toHaveLength(1)
        expect(conversations[0]?.messages).toEqual([
            { role: 'assistant', content: 'Existing reply', receivedAt: 1000 },
        ])
    })
})

