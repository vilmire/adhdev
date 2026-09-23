/**
 * Regression: an `agent:waiting_choice` event must carry the FULL structured
 * AskUserQuestion payload to the dashboard over P2P — and must NOT carry it to
 * the cloud server.
 *
 * Live defect: `buildServerStatusEvent`'s allow-list dropped
 * `interactivePrompt`/`promptId`/`multiSelect`, and the same object was sent on
 * both transports, so web-core's `hydrateInteractivePromptFromEvent` always
 * received undefined and silently no-oped — structurally dead code. Without the
 * hydration, a session whose P2P rich status sync was degraded fell back to the
 * raw approval banner, whose single-select injection cannot submit a checkbox
 * picker (MULTISELECT-REMOTE-DEADLOCK).
 *
 * Why P2P-only (server content boundary): `interactivePrompt` is agent-authored
 * free text (question text, option labels/descriptions). The server leg of
 * `status_event` is spread into EXTERNAL webhook dispatch by the server's
 * DaemonConnection.handleStatusEvent, and the server's own dashboard relay
 * (UserSession.buildDashboardStatusEvent) re-projects through an allow-list
 * that strips unlisted fields anyway — so putting the prompt on the
 * server-bound payload would leak content while never reaching a dashboard.
 * These tests pin BOTH halves of that contract.
 *
 * Moved onto status/status-event.ts's projectServerStatusEvent /
 * projectP2PStatusEvent (wiring-unification B5): these were private
 * DaemonStatusReporter methods (buildServerStatusEvent / buildP2PStatusEvent),
 * now the shared projection both hosts use.
 */
import { describe, expect, it } from 'vitest'
import { projectP2PStatusEvent, projectServerStatusEvent } from '../../src/status/status-event.js'

// Deliberately DIFFERENT text from modalMessage/modalButtons below: the modal
// fields are the approved push exception and DO cross to the server, so only
// text unique to the structured prompt proves the prompt itself did not leak.
const STRUCTURED_PROMPT = {
    promptId: 'tool_multi_1',
    origin: 'cli',
    providerType: 'claude-cli',
    createdAt: 1,
    questions: [{
        questionId: 'q1',
        question: 'Pick any colors?',
        multiSelect: true,
        options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
    }],
}

const CHOICE_EVENT = {
    event: 'agent:waiting_choice',
    targetSessionId: 'sess-1',
    providerType: 'claude-cli',
    modalMessage: 'Choose an option',
    modalButtons: ['Option 1', 'Option 2'],
    interactivePrompt: STRUCTURED_PROMPT,
    promptId: STRUCTURED_PROMPT.promptId,
    multiSelect: true,
}

describe('status_event interactivePrompt — P2P carriage, server boundary', () => {
    it('round-trips interactivePrompt/promptId/multiSelect on the P2P copy', () => {
        const server = projectServerStatusEvent(CHOICE_EVENT)!
        const p2pPayload = projectP2PStatusEvent(CHOICE_EVENT, server)

        expect(p2pPayload.event).toBe('agent:waiting_choice')
        expect(p2pPayload.targetSessionId).toBe('sess-1')
        expect(p2pPayload.interactivePrompt).toEqual(STRUCTURED_PROMPT)
        expect(p2pPayload.promptId).toBe('tool_multi_1')
        expect(p2pPayload.multiSelect).toBe(true)
    })

    it('keeps the server-bound copy free of agent-authored prompt content', () => {
        const payload = projectServerStatusEvent(CHOICE_EVENT)

        expect(payload).toBeTruthy()
        expect(payload).not.toHaveProperty('interactivePrompt')
        expect(payload).not.toHaveProperty('promptId')
        expect(payload).not.toHaveProperty('multiSelect')
        // Belt-and-braces: no text unique to the structured prompt anywhere on
        // the server wire, whatever shape a future refactor gives the leak.
        const wire = JSON.stringify(payload)
        for (const leaked of ['Pick any colors?', 'Red', 'Green', 'Blue', 'tool_multi_1']) {
            expect(wire, `server payload leaked: ${leaked}`).not.toContain(leaked)
        }
    })

    it('still sends the approved push-reduction (modalMessage/modalButtons) to the server', () => {
        const payload = projectServerStatusEvent(CHOICE_EVENT)!

        expect(payload.modalMessage).toBe('Choose an option')
        expect(payload.modalButtons).toEqual(['Option 1', 'Option 2'])
    })

    it('drops malformed prompt fields instead of forwarding them', () => {
        const malformed = {
            event: 'agent:waiting_choice',
            targetSessionId: 'sess-1',
            providerType: 'claude-cli',
            interactivePrompt: ['not', 'an', 'object'],
            promptId: 42,
            multiSelect: 'yes',
        }
        const server = projectServerStatusEvent(malformed)!
        const p2pPayload = projectP2PStatusEvent(malformed, server)

        expect(p2pPayload).not.toHaveProperty('interactivePrompt')
        expect(p2pPayload).not.toHaveProperty('promptId')
        expect(p2pPayload).not.toHaveProperty('multiSelect')
    })
})

/**
 * The prompt fields above are not the only agent-authored text on a raw event —
 * they were simply the ones with a live defect. Providers routinely emit
 * `chatTitle` (ide-provider-instance.ts, acp-provider-instance.ts) and
 * `finalSummary` (ide-provider-instance.ts, on `agent:generating_completed`),
 * and both are held back by this same allow-list alone.
 *
 * They had no canary, which made the boundary quieter than it looks: because
 * `projectServerStatusEvent` builds a fresh object field-by-field, these pass
 * today by OMISSION rather than by any assertion. One `payload.chatTitle = …`
 * line added for a plausible-sounding reason (a nicer push title) would ship
 * chat titles to the server and onward to EXTERNAL webhooks with nothing red.
 *
 * Paired with packages/server/test/daemon-connection-status-event-sanitize.test.ts,
 * which pins the server-side re-application of the same rule — the defense the
 * daemon-side allow-list cannot provide against a legacy or tampered daemon.
 */
describe('status_event — chatTitle/finalSummary must stay off the server wire', () => {
    const CHAT_TITLE = 'Refactor the billing module'
    const FINAL_SUMMARY = 'I removed the retry loop and updated 3 call sites.'

    const COMPLETED_EVENT = {
        event: 'agent:generating_completed',
        targetSessionId: 'sess-1',
        providerType: 'claude-cli',
        duration: 12,
        chatTitle: CHAT_TITLE,
        finalSummary: FINAL_SUMMARY,
    }

    it('★drops chatTitle and finalSummary from the server-bound payload', () => {
        const payload = projectServerStatusEvent(COMPLETED_EVENT)

        expect(payload).toBeTruthy()
        expect(payload).not.toHaveProperty('chatTitle')
        expect(payload).not.toHaveProperty('finalSummary')

        const wire = JSON.stringify(payload)
        for (const leaked of [CHAT_TITLE, FINAL_SUMMARY]) {
            expect(wire, `server payload leaked: ${leaked}`).not.toContain(leaked)
        }
    })

    it('★still forwards the routing metadata of the same event', () => {
        // Guards against "fixing" the leak by dropping the event wholesale —
        // the completion push and its webhook depend on these fields.
        const payload = projectServerStatusEvent(COMPLETED_EVENT)!

        expect(payload.event).toBe('agent:generating_completed')
        expect(payload.targetSessionId).toBe('sess-1')
        expect(payload.providerType).toBe('claude-cli')
        expect(payload.duration).toBe(12)
    })

    it('★drops provider:* events wholesale — they carry arbitrary UI text', () => {
        const payload = projectServerStatusEvent({
            event: 'provider:toast',
            targetSessionId: 'sess-1',
            message: 'ARBITRARY_PROVIDER_TEXT',
        })

        expect(payload).toBeNull()
    })
})
