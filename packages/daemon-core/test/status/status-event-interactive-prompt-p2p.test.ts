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
 * `emitStatusEvent` is spread into EXTERNAL webhook dispatch by the server's
 * DaemonConnection.handleStatusEvent, and the server's own dashboard relay
 * (UserSession.buildDashboardStatusEvent) re-projects through an allow-list
 * that strips unlisted fields anyway — so putting the prompt on the
 * server-bound payload would leak content while never reaching a dashboard.
 * These tests pin BOTH halves of that contract.
 */
import { describe, expect, it, vi } from 'vitest'
import { DaemonStatusReporter } from '../../src/status/reporter.js'

function createReporter() {
    const sendMessage = vi.fn()
    const sendStatusEvent = vi.fn()

    const reporter = new DaemonStatusReporter({
        serverConn: { isConnected: () => true, sendMessage, getUserPlan: () => 'pro' },
        cdpManagers: new Map(),
        p2p: {
            isConnected: true,
            isAvailable: true,
            connectionState: 'connected',
            connectedPeerCount: 1,
            screenshotActive: false,
            sendStatus: vi.fn(),
            sendStatusEvent,
        },
        providerLoader: { resolve: () => null, getAll: () => [] },
        detectedIdes: [],
        instanceId: 'daemon-1',
        daemonVersion: '0.0.0-test',
        instanceManager: {
            collectAllStates: () => [],
            collectStatesByCategory: () => [],
            getInstance: () => undefined,
        },
        getScreenshotUsage: () => null,
    })

    return { reporter, sendMessage, sendStatusEvent }
}

/** The payload the daemon hands the cloud server. */
function serverPayload(sendMessage: ReturnType<typeof vi.fn>) {
    const call = sendMessage.mock.calls.find(([type]) => type === 'status_event')
    return call?.[1]
}

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

function emitChoiceEvent(reporter: DaemonStatusReporter) {
    reporter.emitStatusEvent({
        event: 'agent:waiting_choice',
        targetSessionId: 'sess-1',
        providerType: 'claude-cli',
        modalMessage: 'Choose an option',
        modalButtons: ['Option 1', 'Option 2'],
        interactivePrompt: STRUCTURED_PROMPT,
        promptId: STRUCTURED_PROMPT.promptId,
        multiSelect: true,
    })
}

describe('status_event interactivePrompt — P2P carriage, server boundary', () => {
    it('round-trips interactivePrompt/promptId/multiSelect on the P2P copy', () => {
        const { reporter, sendStatusEvent } = createReporter()

        emitChoiceEvent(reporter)

        expect(sendStatusEvent).toHaveBeenCalledTimes(1)
        const p2pPayload = sendStatusEvent.mock.calls[0][0]
        expect(p2pPayload.event).toBe('agent:waiting_choice')
        expect(p2pPayload.targetSessionId).toBe('sess-1')
        expect(p2pPayload.interactivePrompt).toEqual(STRUCTURED_PROMPT)
        expect(p2pPayload.promptId).toBe('tool_multi_1')
        expect(p2pPayload.multiSelect).toBe(true)
    })

    it('keeps the server-bound copy free of agent-authored prompt content', () => {
        const { reporter, sendMessage } = createReporter()

        emitChoiceEvent(reporter)

        const payload = serverPayload(sendMessage)
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
        const { reporter, sendMessage } = createReporter()

        emitChoiceEvent(reporter)

        const payload = serverPayload(sendMessage)
        expect(payload.modalMessage).toBe('Choose an option')
        expect(payload.modalButtons).toEqual(['Option 1', 'Option 2'])
    })

    it('drops malformed prompt fields instead of forwarding them', () => {
        const { reporter, sendStatusEvent } = createReporter()

        reporter.emitStatusEvent({
            event: 'agent:waiting_choice',
            targetSessionId: 'sess-1',
            providerType: 'claude-cli',
            interactivePrompt: ['not', 'an', 'object'],
            promptId: 42,
            multiSelect: 'yes',
        })

        const p2pPayload = sendStatusEvent.mock.calls[0][0]
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
 * `buildServerStatusEvent` builds a fresh object field-by-field, these pass
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

    function emitCompletedEvent(reporter: DaemonStatusReporter) {
        reporter.emitStatusEvent({
            event: 'agent:generating_completed',
            targetSessionId: 'sess-1',
            providerType: 'claude-cli',
            duration: 12,
            chatTitle: CHAT_TITLE,
            finalSummary: FINAL_SUMMARY,
        })
    }

    it('★drops chatTitle and finalSummary from the server-bound payload', () => {
        const { reporter, sendMessage } = createReporter()

        emitCompletedEvent(reporter)

        const payload = serverPayload(sendMessage)
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
        const { reporter, sendMessage } = createReporter()

        emitCompletedEvent(reporter)

        const payload = serverPayload(sendMessage)
        expect(payload.event).toBe('agent:generating_completed')
        expect(payload.targetSessionId).toBe('sess-1')
        expect(payload.providerType).toBe('claude-cli')
        expect(payload.duration).toBe(12)
    })

    it('★drops provider:* events wholesale — they carry arbitrary UI text', () => {
        const { reporter, sendMessage } = createReporter()

        reporter.emitStatusEvent({
            event: 'provider:toast',
            targetSessionId: 'sess-1',
            message: 'ARBITRARY_PROVIDER_TEXT',
        })

        expect(serverPayload(sendMessage)).toBeUndefined()
    })
})
