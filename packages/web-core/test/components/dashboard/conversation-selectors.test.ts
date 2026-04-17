import { describe, expect, it } from 'vitest'
import {
    getConversationActiveTabTarget,
    getConversationControlsContext,
    getConversationDaemonRouteId,
    getConversationIdeChipLabel,
    getConversationMachineLabel,
    getConversationMetaParts,
    getConversationNativeTargetSessionId,
    getConversationNotificationLabel,
    getConversationNotificationPreview,
    getConversationProviderLabel,
    getConversationProviderType,
    getConversationRemoteTabKey,
} from '../../../src/components/dashboard/conversation-selectors'
import type { ActiveConversation } from '../../../src/components/dashboard/types'
import type { DaemonData } from '../../../src/types'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        routeId: 'machine-1:ide:cursor-1',
        sessionId: 'cursor-1',
        nativeSessionId: 'cursor-1',
        transport: 'cdp-page',
        daemonId: 'machine-1',
        agentName: 'Codex',
        agentType: 'codex',
        status: 'idle',
        title: '',
        messages: [],
        hostIdeType: 'cursor',
        workspaceName: 'repo',
        displayPrimary: 'repo',
        displaySecondary: 'Cursor · Codex',
        streamSource: 'native',
        tabKey: 'cursor-1',
        machineName: 'Studio Mac',
        connectionState: 'connected',
        ...overrides,
    }
}

describe('conversation selectors', () => {
    it('derives route, labels, and native target from shared selectors', () => {
        const conversation = createConversation({
            streamSource: 'agent-stream',
            sessionId: 'agent-1',
            nativeSessionId: 'cursor-1',
            displaySecondary: 'Cursor · Codex',
        })

        expect(getConversationDaemonRouteId(conversation)).toBe('machine-1')
        expect(getConversationMachineLabel(conversation)).toBe('Studio Mac')
        expect(getConversationProviderType(conversation)).toBe('codex')
        expect(getConversationProviderLabel(conversation)).toBe('Codex')
        expect(getConversationIdeChipLabel(conversation)).toBe('Cursor')
        expect(getConversationNativeTargetSessionId(conversation)).toBe('cursor-1')
        expect(getConversationRemoteTabKey(conversation)).toBe('cursor-1')
        expect(getConversationActiveTabTarget(conversation)).toBe('agent-1')
        expect(getConversationMetaParts(conversation)).toEqual(['Cursor · Codex', 'Studio Mac'])
    })

    it('centralizes notification label and preview fallbacks', () => {
        expect(getConversationNotificationLabel(createConversation({
            title: '',
            displayPrimary: '',
            agentName: '',
            tabKey: '',
            routeId: 'machine-1:ide:cursor-1',
        }))).toBe('machine-1:ide:cursor-1')

        expect(getConversationNotificationLabel(createConversation({
            title: '',
            displayPrimary: 'Fix reconnect race',
            agentName: 'Codex',
        }))).toBe('Fix reconnect race')

        expect(getConversationNotificationPreview(createConversation({
            lastMessagePreview: '',
            displaySecondary: 'Cursor · Codex',
        }))).toBe('Cursor · Codex')
    })

    it('preserves provider casing for native CLI controls labels', () => {
        const cliEntry: DaemonData = {
            id: 'machine-1:cli:cli-1',
            type: 'codex-cli',
            cliName: 'Codex CLI',
            transport: 'pty',
            status: 'idle',
            providerControls: [{ id: 'model', type: 'select', label: 'Model', placement: 'bar' }],
        }

        const context = getConversationControlsContext(createConversation({
            transport: 'pty',
            streamSource: 'native',
            agentName: 'Codex CLI',
            agentType: 'codex-cli',
            hostIdeType: undefined,
        }), cliEntry)

        expect(context).toMatchObject({
            isNativeConversation: true,
            isCli: true,
            providerType: 'codex-cli',
            displayLabel: 'Codex CLI',
        })
    })

    it('resolves controls context against the matching child session', () => {
        const ideEntry: DaemonData = {
            id: 'machine-1:ide:cursor-1',
            type: 'cursor',
            status: 'online',
            childSessions: [
                {
                    id: 'agent-1',
                    parentId: 'cursor-1',
                    providerType: 'codex',
                    providerName: 'Codex',
                    kind: 'agent',
                    transport: 'cdp-webview',
                    status: 'idle',
                    title: 'Agent',
                    workspace: '/repo',
                    activeChat: null,
                    capabilities: [],
                    providerControls: [{ id: 'model', type: 'select', label: 'Model', placement: 'bar' }],
                },
            ],
            providerControls: [{ id: 'theme', type: 'select', label: 'Theme', placement: 'bar' }],
        }

        const context = getConversationControlsContext(createConversation({
            streamSource: 'agent-stream',
            sessionId: 'agent-1',
            transport: 'cdp-webview',
        }), ideEntry)

        expect(context).toMatchObject({
            isNativeConversation: false,
            providerType: 'codex',
            displayLabel: 'Codex',
        })
        expect(context.targetEntry?.providerControls).toEqual([{ id: 'model', type: 'select', label: 'Model', placement: 'bar' }])
    })
})
