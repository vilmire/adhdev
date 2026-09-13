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

// ── MULTISELECT-REMOTE-DEADLOCK: structured-prompt hydration ────────────────
//
// This arm used to be toast-ONLY: the event's full `interactivePrompt` was
// discarded. `activeInteractivePrompt` therefore arrived only on the P2P rich
// status sync, and when that sync was degraded (WS-only / replicaDegraded) the
// field stayed empty — so the session resolved to `waiting_approval` and fell
// back to the raw ApprovalBanner, whose single-select `'{index}\r'` injection
// cannot submit a multi-select checkbox picker. The owner could not answer from
// mobile at all. Hydrating here removes that "structured prompt missing"
// precondition at its root.

const MULTISELECT_PROMPT = {
    promptId: 'tool_multi_1',
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{
        questionId: 'q1',
        question: 'Pick any colors?',
        header: 'Colors',
        multiSelect: true,
        options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
    }],
}

function choiceEventWithPrompt(sessionId: string, timestamp: number, prompt: unknown) {
    return {
        ...waitingChoiceEvent(sessionId, timestamp),
        interactivePrompt: prompt,
        multiSelect: true,
    } as any
}

describe('EventManager agent:waiting_choice — hydrates activeInteractivePrompt', () => {
    function captureHydrations(): { calls: Array<{ sessionId: string; promptId: string }>; restore: () => void } {
        const calls: Array<{ sessionId: string; promptId: string }> = []
        eventManager.setHydrateInteractivePrompt((sessionId, prompt) => {
            calls.push({ sessionId, promptId: prompt.promptId })
        })
        // Leave a no-op registered afterwards so later tests in this file (and any
        // other file sharing the eventManager singleton) see a clean manager.
        return { calls, restore: () => eventManager.setHydrateInteractivePrompt(() => {}) }
    }

    it('forwards the event prompt to the session-state writer', () => {
        eventManager.setIdes([{ id: 'wc-hyd', sessionId: 'wc-hyd', type: 'claude-cli' } as any])
        const { calls, restore } = captureHydrations()

        eventManager.handleRawEvent(choiceEventWithPrompt('wc-hyd', 51000, MULTISELECT_PROMPT), 'ws')
        restore()

        expect(calls).toEqual([{ sessionId: 'wc-hyd', promptId: 'tool_multi_1' }])
    })

    it('hydrates on the WS transport too — the whole point is P2P-independence', () => {
        eventManager.setIdes([{ id: 'wc-hyd-ws', sessionId: 'wc-hyd-ws', type: 'claude-cli' } as any])
        const { calls, restore } = captureHydrations()

        // 'ws' is exactly the degraded case that produced the deadlock.
        eventManager.handleRawEvent(choiceEventWithPrompt('wc-hyd-ws', 52000, MULTISELECT_PROMPT), 'ws')
        restore()

        expect(calls.length).toBe(1)
    })

    it('hydrates even for a MUTED conversation (a question cannot be auto-answered)', () => {
        eventManager.setIdes([{ id: 'wc-hyd-muted', sessionId: 'wc-hyd-muted', type: 'claude-cli', muted: true } as any])
        const { calls, restore } = captureHydrations()

        eventManager.handleRawEvent(choiceEventWithPrompt('wc-hyd-muted', 53000, MULTISELECT_PROMPT), 'p2p')
        restore()

        expect(calls.length).toBe(1)
    })

    it('hydrates on a DUPLICATE copy of the event (state is not gated by toast dedup)', () => {
        // isDuplicate exists to suppress duplicate NOTIFICATIONS within 5s. The
        // same choice event legitimately arrives on both WS and P2P, and dropping
        // the second copy must never leave the session without its prompt.
        eventManager.setIdes([{ id: 'wc-hyd-dup', sessionId: 'wc-hyd-dup', type: 'claude-cli' } as any])
        const { calls, restore } = captureHydrations()

        const ev = choiceEventWithPrompt('wc-hyd-dup', 54000, MULTISELECT_PROMPT)
        eventManager.handleRawEvent(ev, 'p2p')
        eventManager.handleRawEvent(ev, 'ws') // same dedup key → toast suppressed
        restore()

        expect(calls.length).toBe(2)
    })

    it('drops a malformed prompt rather than rendering an unanswerable modal', () => {
        eventManager.setIdes([{ id: 'wc-hyd-bad', sessionId: 'wc-hyd-bad', type: 'claude-cli' } as any])
        const { calls, restore } = captureHydrations()

        // No questions → normalizeInteractivePromptPrompt rejects it.
        eventManager.handleRawEvent(
            choiceEventWithPrompt('wc-hyd-bad', 55000, { ...MULTISELECT_PROMPT, questions: [] }), 'p2p')
        // No prompt at all (a legacy daemon that never sent the structured payload).
        eventManager.handleRawEvent(waitingChoiceEvent('wc-hyd-bad', 56000), 'p2p')
        restore()

        expect(calls).toEqual([])
    })

    it('drops a session-less choice event (nothing to attach a modal to)', () => {
        const { calls, restore } = captureHydrations()
        const ev = choiceEventWithPrompt('unused', 57000, MULTISELECT_PROMPT)
        delete ev.targetSessionId
        eventManager.handleRawEvent(ev, 'p2p')
        restore()
        expect(calls).toEqual([])
    })

    it('does NOT hydrate on agent:waiting_approval (that arm keeps its raw-button path)', () => {
        eventManager.setIdes([{ id: 'wc-hyd-appr', sessionId: 'wc-hyd-appr', type: 'claude-cli' } as any])
        const { calls, restore } = captureHydrations()

        eventManager.handleRawEvent({
            event: 'agent:waiting_approval',
            timestamp: 58000,
            targetSessionId: 'wc-hyd-appr',
            modalMessage: 'Run this command?',
            modalButtons: ['Run', 'Cancel'],
            interactivePrompt: MULTISELECT_PROMPT,
        } as any, 'p2p')
        restore()

        expect(calls).toEqual([])
    })
})
