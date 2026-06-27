import { describe, expect, it } from 'vitest'
import {
    getConversationHistorySubtitle,
    getConversationMeshRoleLabels,
    getConversationMeshRoleTitle,
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
        routeId: 'machine-1:ide:cursor-1',
        sessionId: 'cursor-1',
        transport: 'cdp-page',
        daemonId: 'machine-1',
        agentName: 'Cursor',
        agentType: 'cursor',
        status: 'idle',
        title: 'Cursor Chat',
        messages: [],
        hostIdeType: 'cursor',
        workspaceName: 'repo',
        displayPrimary: 'repo',
        displaySecondary: 'Cursor',
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
        expect(getConversationMetaText(conversation)).toBe('Cursor · Studio Mac')
        expect(getConversationPreviewText(conversation)).toBe('Cursor Chat')
        expect(getConversationTabMetaText(conversation)).toBe('Cursor · Studio Mac')
        expect(getConversationMachineCardPreview(conversation)).toBe('repo · Cursor Chat')
        expect(getMachineConversationCardSubtitle(conversation, { timestampLabel: '2m ago' }))
            .toBe('Chat · Cursor · Studio Mac · 2m ago')
        expect(getConversationHistorySubtitle(conversation)).toBe('repo — Cursor')
        expect(getConversationStopDialogLabel(conversation)).toBe('Cursor')
        expect(getConversationNotificationLabel(conversation)).toBe('Cursor Chat')
        expect(getRemotePanelTitle(conversation)).toBe('Remote · repo')
    })

    it('preserves provider casing in history subtitles for CLI conversations', () => {
        const conversation = createConversation({
            transport: 'pty',
            hostIdeType: undefined,
            agentName: 'Codex CLI',
            agentType: 'codex-cli',
            displaySecondary: 'Codex CLI',
        })

        expect(getConversationHistorySubtitle(conversation)).toBe('repo — Codex CLI')
        expect(getConversationStopDialogLabel(conversation)).toBe('Codex CLI')
    })

    it('formats compact mesh role labels with detailed tooltip metadata', () => {
        const conversation = createConversation({
            settings: {
                meshNodeFor: 'mesh-1',
                meshCoordinatorFor: 'mesh-1',
            },
            coordinator: { meshId: 'mesh-1', role: 'coordinator' },
            meshQueueStats: {
                pending: 2,
                assigned: 1,
                completed: 4,
                failed: 0,
            },
        })

        expect(getConversationMeshRoleLabels(conversation)).toEqual(['Mesh node', 'Coordinator'])
        expect(getConversationMeshRoleTitle(conversation)).toBe(
            'Mesh node: mesh-1 · Coordinator: mesh-1 · Queue: 2 pending, 1 assigned, 4 completed, 0 failed',
        )
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

    it('uses richer transcript text when stale compact preview is older than the latest message', () => {
        const conversation = createConversation({
            lastMessagePreview: 'Older compact preview',
            lastMessageAt: 1000,
            messages: [
                { role: 'assistant', content: 'Latest transcript bubble', receivedAt: 2000 },
            ],
        })

        expect(getConversationPreviewText(conversation)).toBe('Latest transcript bubble')
    })

    it('keeps inbox/card preview aligned with the rendered chat transcript even when compact preview is newer', () => {
        const conversation = createConversation({
            lastMessagePreview: 'Newest compact preview',
            lastMessageAt: 3000,
            messages: [
                { role: 'assistant', content: 'Older transcript bubble', receivedAt: 2000 },
            ],
        })

        expect(getConversationPreviewText(conversation)).toBe('Older transcript bubble')
    })

    it('shows a generating placeholder instead of echoing the user prompt while the agent is mid-turn', () => {
        // Inbox snapshot transcript still ends at the user prompt (the streamed reply
        // only reaches the open chat via the live agent-stream channel), and the
        // daemon-derived role tracks that same user message — the stale-inbox bug.
        const generatingFromUser = createConversation({
            status: 'generating',
            messages: [
                { role: 'user', content: 'Update and restart done. Verify the mission.' },
            ],
            lastMessageRole: 'user',
            lastMessagePreview: 'Update and restart done. Verify the mission.',
        })

        expect(getConversationPreviewText(generatingFromUser)).toBe('Agent is generating…')
    })

    it('prefers a visible assistant reply over the generating placeholder', () => {
        // Once any assistant text is visible (transcript tail or daemon summary) the
        // real reply must win even while the status is still generating.
        const generatingWithReply = createConversation({
            status: 'generating',
            messages: [
                { role: 'user', content: 'Verify the mission.' },
                { role: 'assistant', content: "I'll start by checking the mission state." },
            ],
        })
        const generatingWithSummary = createConversation({
            status: 'streaming',
            messages: [
                { role: 'user', content: 'Verify the mission.' },
            ],
            lastMessageRole: 'assistant',
            lastMessagePreview: 'Checking the mission state and node health.',
        })

        expect(getConversationPreviewText(generatingWithReply)).toBe("I'll start by checking the mission state.")
        expect(getConversationPreviewText(generatingWithSummary)).toBe('Checking the mission state and node health.')
    })

    it('keeps echoing the user prompt only for idle (non-generating) conversations', () => {
        const idleFromUser = createConversation({
            status: 'idle',
            messages: [
                { role: 'user', content: 'Standing by.' },
            ],
        })

        expect(getConversationPreviewText(idleFromUser)).toBe('Standing by.')
    })

    it('prefers the rich transcript tail over compact preview when transcript time is missing or tied', () => {
        const missingTimestamp = createConversation({
            lastMessagePreview: 'User prompt from compact status',
            lastMessageAt: 3000,
            messages: [
                { role: 'assistant', content: 'Assistant reply without timestamp' },
            ],
        })
        const tiedTimestamp = createConversation({
            lastMessagePreview: 'User prompt from compact status',
            lastMessageAt: 3000,
            messages: [
                { role: 'assistant', content: 'Assistant reply at same timestamp', receivedAt: 3000 },
            ],
        })

        expect(getConversationPreviewText(missingTimestamp)).toBe('Assistant reply without timestamp')
        expect(getConversationPreviewText(tiedTimestamp)).toBe('Assistant reply at same timestamp')
    })
})
