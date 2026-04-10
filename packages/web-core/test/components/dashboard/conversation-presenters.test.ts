import { describe, expect, it } from 'vitest'
import {
    getConversationHistorySubtitle,
    getConversationMetaText,
    getConversationMachineCardPreview,
    getConversationNotificationLabel,
    getConversationPreviewText,
    getConversationStatusHint,
    getConversationStopDialogLabel,
    getConversationTabMetaText,
    getConversationTitle,
    getMachineConversationCardSubtitle,
    getRemotePanelTitle,
} from '../../../src/components/dashboard/conversation-presenters'
import type { ActiveConversation } from '../../../src/components/dashboard/types'

function createConversation(overrides: Partial<ActiveConversation> = {}): ActiveConversation {
    return {
        ideId: 'machine-1:ide:cursor-1',
        sessionId: 'cursor-1',
        transport: 'cdp-page',
        daemonId: 'machine-1',
        agentName: 'Codex',
        agentType: 'codex',
        status: 'idle',
        title: '',
        messages: [],
        ideType: 'cursor',
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

describe('conversation presenters', () => {
    it('formats title and meta text consistently', () => {
        const conversation = createConversation()
        expect(getConversationTitle(conversation)).toBe('repo')
        expect(getConversationMetaText(conversation)).toBe('Cursor · Codex · Studio Mac')
        expect(getConversationPreviewText(conversation)).toBe('Cursor · Codex · Studio Mac')
        expect(getConversationTabMetaText(conversation)).toBe('Cursor · Codex · Studio Mac')
        expect(getConversationMachineCardPreview(conversation)).toBe('repo · Cursor · Codex · Studio Mac')
        expect(getMachineConversationCardSubtitle(conversation, { timestampLabel: '2m ago' }))
            .toBe('Chat · Cursor · Codex · Studio Mac · 2m ago')
        expect(getConversationHistorySubtitle(conversation)).toBe('repo — Cursor')
        expect(getConversationStopDialogLabel(conversation)).toBe('Codex')
        expect(getConversationNotificationLabel(conversation)).toBe('Codex')
        expect(getRemotePanelTitle(conversation)).toBe('Remote · repo')
    })

    it('prefers connection hints before action-needed hints', () => {
        expect(getConversationStatusHint(createConversation({ connectionState: 'failed' }), { requiresAction: true }))
            .toBe('Reconnecting…')
        expect(getConversationTabMetaText(createConversation({ connectionState: 'failed' })))
            .toBe('Reconnecting…')
        expect(getConversationStatusHint(createConversation({ connectionState: 'connecting' })))
            .toBe('Connecting…')
        expect(getConversationStatusHint(createConversation(), { requiresAction: true }))
            .toBe('Action needed')
    })

    it('prefers message previews and conversation titles when available', () => {
        const withMessage = createConversation({
            messages: [{ role: 'assistant', content: 'Generated answer', timestamp: 1 }],
        })
        const withTitle = createConversation({
            title: 'Named thread',
            agentName: '',
        })

        expect(getConversationPreviewText(withMessage)).toBe('Generated answer')
        expect(getConversationPreviewText(withTitle)).toBe('Named thread')
        expect(getConversationNotificationLabel(withTitle)).toBe('Named thread')
    })
})
