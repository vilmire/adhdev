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
        const ide = createIdeEntry({
            inboxBucket: 'task_complete',
            completionMarker: 'done-1',
        })
        const conversations = buildScopedIdeConversations(ide, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations).toHaveLength(1)
        expect(conversations[0]).toMatchObject({
            routeId: 'machine-1:ide:cursor-1',
            machineName: 'Studio Mac',
            connectionState: 'connected',
            tabKey: 'machine-1:ide:cursor-1',
            sessionCapabilities: ['read_chat', 'open_panel'],
            inboxBucket: 'task_complete',
            completionMarker: 'done-1',
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

        const conversations = buildScopedIdeConversations(ide, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations[0]).toMatchObject({
            title: 'Fix reconnect race',
            displayPrimary: 'Fix reconnect race',
        })
    })

    // OPENCODE-TITLE: when a CLI/ACP provider has no meaningful chat title AND no
    // workspace, the tab must fall back to the provider label (agentName). The
    // provider display name must be distinct from formatIdeType(type) — otherwise
    // isGenericAgentTitle treats a name-only title as generic. opencode's original
    // name/displayName was the lowercase "opencode" (== its type); "Opencode Code"
    // (spec fix) is distinct from both the type and formatIdeType('opencode')=
    // "Opencode", so it renders as a clean provider label like kimi ("Kimi Code")
    // and cursor ("Cursor Agent") rather than collapsing to the bare type.
    it('renders the provider label for a workspace-less CLI session using the fixed opencode display name', () => {
        const ide = createIdeEntry({
            id: 'machine-1:ide:opencode-1',
            sessionId: 'opencode-1',
            type: 'opencode',
            transport: 'pty',
            mode: 'chat',
            workspace: null,
            cliName: 'Opencode Code',
            activeChat: {
                id: 'chat-1',
                title: '',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
        })

        const conversations = buildScopedIdeConversations(ide, {
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        // No workspace + no chat title → falls to agentName = provider label.
        expect(conversations[0].agentName).toBe('Opencode Code')
        expect(conversations[0].displayPrimary).toBe('Opencode Code')
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

        const conversations = buildScopedIdeConversations(ide, {
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

        const conversations = buildScopedIdeConversations(ide, {
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

        const conversations = buildScopedIdeConversations(cli, {
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

    it('uses daemon-scoped tab keys for native CLI conversations with duplicate runtime session ids', () => {
        const first = createIdeEntry({
            id: 'machine-1:cli:shared-session',
            daemonId: 'machine-1',
            sessionId: 'shared-session',
            providerSessionId: 'provider-shared',
            type: 'hermes-cli',
            transport: 'pty',
            cliName: 'Hermes Agent',
            mode: 'chat',
        })
        const second = createIdeEntry({
            id: 'machine-2:cli:shared-session',
            daemonId: 'machine-2',
            sessionId: 'shared-session',
            providerSessionId: 'provider-shared',
            type: 'hermes-cli',
            transport: 'pty',
            cliName: 'Hermes Agent',
            mode: 'chat',
        })

        const firstConversation = buildScopedIdeConversations(first)[0]
        const secondConversation = buildScopedIdeConversations(second)[0]

        expect(firstConversation).toMatchObject({
            sessionId: 'shared-session',
            providerSessionId: 'provider-shared',
            tabKey: 'machine-1:cli:shared-session',
        })
        expect(secondConversation).toMatchObject({
            sessionId: 'shared-session',
            providerSessionId: 'provider-shared',
            tabKey: 'machine-2:cli:shared-session',
        })
        expect(firstConversation?.tabKey).not.toBe(secondConversation?.tabKey)
    })

    it('uses the active chat id as the native conversation history target without replacing provider identity', () => {
        const cli = createIdeEntry({
            id: 'machine-1:cli:runtime-1',
            sessionId: 'runtime-1',
            providerSessionId: 'chat-old',
            type: 'hermes-cli',
            transport: 'pty',
            cliName: 'Hermes Agent',
            mode: 'chat',
            activeChat: {
                id: 'chat-new',
                title: '',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
        })

        const conversation = buildScopedIdeConversations(cli)[0]

        expect(conversation).toMatchObject({
            sessionId: 'runtime-1',
            providerSessionId: 'chat-old',
            historySessionId: 'chat-new',
            messages: [],
        })
    })

    it('rejects a generic CLI active chat id as a native history target', () => {
        const cli = createIdeEntry({
            id: 'machine-1:cli:runtime-1',
            sessionId: 'runtime-1',
            providerSessionId: undefined,
            type: 'codex-cli',
            transport: 'pty',
            cliName: 'Codex CLI',
            mode: 'chat',
            activeChat: {
                id: 'codex-cli',
                title: '',
                status: 'idle',
                messages: [],
                activeModal: null,
            },
        })

        const conversation = buildScopedIdeConversations(cli)[0]

        expect(conversation).toMatchObject({
            sessionId: 'runtime-1',
            providerSessionId: undefined,
            historySessionId: undefined,
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
            machineNames: { 'machine-1': 'Studio Mac' },
            connectionStates: { 'machine-1': 'connected' },
            defaultConnectionState: 'new',
        })

        expect(conversations).toHaveLength(1)
        expect(conversations[0]?.messages).toEqual([
            { role: 'assistant', content: 'Existing reply', receivedAt: 1000 },
        ])
    })

    it('attributes a mesh delegated session to the owning worker daemon machine, not the coordinator', () => {
        // Entry lives under the coordinator's daemonId (machine-1) but carries owner attribution
        // for the worker daemon (machine-2 = Windows node).
        const meshSession = createIdeEntry({
            id: 'machine-1:cli:remote-1',
            daemonId: 'machine-1',
            sessionId: 'remote-1',
            type: 'claude-cli',
            transport: 'pty',
            cliName: 'Claude Cli',
            ownerDaemonId: 'machine-2',
            settings: { meshNodeFor: 'mesh-x', meshNodeId: 'node-win', launchedByCoordinator: true },
        })

        const context = getIdeConversationBuildContext(meshSession, {
            machineNames: { 'machine-1': 'Studio Mac', 'machine-2': 'Windows DST' },
        })
        // Machine resolves to the worker (machine-2), NOT the coordinator (machine-1).
        expect(context.machineName).toBe('Windows DST')

        const conversation = buildScopedIdeConversations(meshSession, {
            machineNames: { 'machine-1': 'Studio Mac', 'machine-2': 'Windows DST' },
        })[0]
        expect(conversation?.machineName).toBe('Windows DST')
        // Mesh node tab keeps its provider identity; title is not a generic "Terminal".
        expect(conversation?.agentName).toContain('Claude Cli')
        expect(conversation?.agentName).toContain('(Mesh Node)')
        expect(conversation?.agentName).not.toContain('Terminal')
    })

    it('falls back to ownerMachineName when the owning worker daemon is not aggregated', () => {
        const meshSession = createIdeEntry({
            id: 'machine-1:cli:remote-2',
            daemonId: 'machine-1',
            sessionId: 'remote-2',
            type: 'claude-cli',
            transport: 'pty',
            cliName: 'Claude Cli',
            ownerDaemonId: 'machine-2',
            ownerMachineName: 'Windows DST',
            settings: { meshNodeFor: 'mesh-x', meshNodeId: 'node-win', launchedByCoordinator: true },
        })

        // machineNames lacks machine-2 (worker daemon not in the aggregate) → use the explicit fallback.
        const context = getIdeConversationBuildContext(meshSession, {
            machineNames: { 'machine-1': 'Studio Mac' },
        })
        expect(context.machineName).toBe('Windows DST')
    })

    it('keeps coordinator/local sessions attributed to the snapshot daemon machine', () => {
        const localCli = createIdeEntry({
            id: 'machine-1:cli:local-1',
            daemonId: 'machine-1',
            sessionId: 'local-1',
            type: 'claude-cli',
            transport: 'pty',
            cliName: 'Claude Cli',
        })
        const context = getIdeConversationBuildContext(localCli, {
            machineNames: { 'machine-1': 'Studio Mac', 'machine-2': 'Windows DST' },
        })
        expect(context.machineName).toBe('Studio Mac')
    })
})
