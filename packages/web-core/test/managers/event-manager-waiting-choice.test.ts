import { describe, expect, it } from 'vitest'
import { eventManager, type ToastConfig } from '../../src/managers/EventManager'

// agent:waiting_choice (AskUserQuestion picker parked) notification behavior.
//
// The event previously produced NO toast at all — a session parked on a
// question looked silently "generating" and the owner never knew input was
// needed (the live "coordinator's questions never notify" complaint).
//
// Mute rule is DELIBERATELY different from agent:waiting_approval: a muted
// conversation (e.g. a coordinator-spawned mesh session) auto-approves its
// consent modals locally, so approval toasts are noise — but a question
// cannot be auto-answered, so the toast fires EVEN when the conversation is
// muted. See EventManager.handleRawEvent's agent:waiting_choice branch.

function collectToasts(): { toasts: ToastConfig[]; stop: () => void } {
    const toasts: ToastConfig[] = []
    const stop = eventManager.onToast(t => toasts.push(t))
    return { toasts, stop }
}

function waitingChoiceEvent(sessionId: string, timestamp: number) {
    return {
        event: 'agent:waiting_choice',
        timestamp,
        targetSessionId: sessionId,
        providerSessionId: sessionId,
        promptId: 'tool_abc123',
        modalMessage: 'Colors: Pick any colors?',
        modalButtons: ['Red', 'Green', 'Blue'],
    } as any
}

describe('EventManager agent:waiting_choice toast', () => {
    it('emits a warning toast carrying the question text for an unmuted conversation', () => {
        eventManager.setIdes([{ id: 'wc-unmuted', sessionId: 'wc-unmuted', type: 'kimi' } as any])
        const { toasts, stop } = collectToasts()
        eventManager.handleRawEvent(waitingChoiceEvent('wc-unmuted', 41000), 'p2p')
        stop()
        const toast = toasts.find(t => t.type === 'warning')
        expect(toast).toBeDefined()
        expect(toast!.message).toContain('❓')
        expect(toast!.message).toContain('Pick any colors?')
        // No inline action buttons — a question is answered via the picker /
        // mesh_answer_question, never a yes/no resolve_action.
        expect(toast!.actions).toBeUndefined()
    })

    it('STILL fires for a muted conversation (deliberate coordinator-question override)', () => {
        eventManager.setIdes([{ id: 'wc-muted', sessionId: 'wc-muted', type: 'kimi', muted: true } as any])
        const { toasts, stop } = collectToasts()
        eventManager.handleRawEvent(waitingChoiceEvent('wc-muted', 42000), 'p2p')
        stop()
        expect(toasts.some(t => t.message.includes('Pick any colors?'))).toBe(true)
    })

    it('control: the approval toast for the SAME muted session stays suppressed', () => {
        eventManager.setIdes([{ id: 'wc-muted-approval', sessionId: 'wc-muted-approval', type: 'kimi', muted: true } as any])
        const { toasts, stop } = collectToasts()
        eventManager.handleRawEvent({
            event: 'agent:waiting_approval',
            timestamp: 43000,
            targetSessionId: 'wc-muted-approval',
            providerSessionId: 'wc-muted-approval',
            modalMessage: 'Run this command?',
            modalButtons: ['Run', 'Cancel'],
        } as any, 'p2p')
        stop()
        expect(toasts.length).toBe(0)
    })
})
