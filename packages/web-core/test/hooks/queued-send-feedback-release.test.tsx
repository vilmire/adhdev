// @vitest-environment jsdom
/**
 * (QUEUED-SEND-STICKY) The parked-send notice must be released when the agent
 * stops generating.
 *
 * Before this fix `sendFeedbackMessage` was cleared by exactly two things — the
 * next send attempt and a tab switch — so an owner who sent into a busy session
 * and then walked away kept seeing "the agent is still working" on a session
 * that had long gone idle. The message was correct when written; the defect was
 * that nothing ever released it.
 *
 * These tests cover BOTH levels deliberately:
 *  - the pure release predicate, and
 *  - the real hook rendered through react-dom, asserting the value the render
 *    sites actually consume. A previous defect in this area survived because
 *    only hook-internal logic was tested while a render site went unwired, so
 *    the wiring is asserted here rather than assumed.
 *
 * Both visible surfaces (the input placeholder and the status line below it)
 * read this single `sendFeedbackMessage` value — ChatPane.tsx builds
 * `chatInputStatusMessage` and `inlineStatusMessage` from it, and
 * CliTerminalPane.tsx builds `inputStatusMessage`/`inputInlineMessage` from it —
 * so both are asserted through the composition those files perform.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import {
    QUEUED_SEND_MESSAGE,
    shouldReleaseQueuedSendFeedback,
    useDashboardConversationCommands,
} from '../../src/hooks/useDashboardConversationCommands'
import { SEND_BLOCKED_PLACEHOLDER } from '../../src/hooks/dashboardCommandUtils'
import { buildBusyChatInputStatusMessage } from '../../src/components/dashboard/ChatPane'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('shouldReleaseQueuedSendFeedback', () => {
    it('releases the queued notice once the session is no longer generating', () => {
        expect(shouldReleaseQueuedSendFeedback({
            feedbackMessage: QUEUED_SEND_MESSAGE,
            lastSendQueued: true,
            isGenerating: false,
        })).toBe(true)
    })

    it('keeps the notice while the agent is still generating', () => {
        expect(shouldReleaseQueuedSendFeedback({
            feedbackMessage: QUEUED_SEND_MESSAGE,
            lastSendQueued: true,
            isGenerating: true,
        })).toBe(false)
    })

    it('never releases a send FAILURE — idling does not make a failed send succeed', () => {
        expect(shouldReleaseQueuedSendFeedback({
            feedbackMessage: 'Unable to send message right now.',
            lastSendQueued: false,
            isGenerating: false,
        })).toBe(false)
    })
})

/**
 * Render the real hook and drive it exactly as the dashboard does: send into a
 * generating conversation, then let that conversation transition to idle.
 */
function renderQueuedSendScenario() {
    const container = document.createElement('div')
    const root = createRoot(container)
    const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true, sent: false, queued: true })
    let latest: any = null

    function Harness({ status }: { status: string }) {
        latest = useDashboardConversationCommands({
            sendDaemonCommand,
            activeConv: {
                tabKey: 'tab-1',
                routeId: 'daemon-1:session-1',
                daemonId: 'daemon-1',
                sessionId: 'session-1',
                status,
            } as any,
            setActionLogs: () => {},
            isStandalone: false,
        })
        return null
    }

    return {
        get current() { return latest },
        render(status: string) {
            act(() => { root.render(createElement(Harness, { status })) })
        },
        unmount() { act(() => { root.unmount() }) },
    }
}

describe('useDashboardConversationCommands queued-send release (render site)', () => {
    it('clears the queued notice when the conversation transitions to idle', async () => {
        const scenario = renderQueuedSendScenario()
        scenario.render('generating')

        await act(async () => { await scenario.current.handleSendChat('deploy the branch') })
        expect(scenario.current.sendFeedbackMessage).toBe(QUEUED_SEND_MESSAGE)

        scenario.render('idle')
        expect(scenario.current.sendFeedbackMessage).toBeNull()
        expect(scenario.current.lastSendQueued).toBe(false)
        scenario.unmount()
    })

    it('keeps the notice across a finalizing turn — finalizing still counts as working', async () => {
        const scenario = renderQueuedSendScenario()
        scenario.render('generating')

        await act(async () => { await scenario.current.handleSendChat('deploy the branch') })
        scenario.render('finalizing')

        expect(scenario.current.sendFeedbackMessage).toBe(QUEUED_SEND_MESSAGE)
        scenario.unmount()
    })

    it('clears BOTH visible surfaces — placeholder and status line — on idle', async () => {
        const scenario = renderQueuedSendScenario()
        scenario.render('generating')
        await act(async () => { await scenario.current.handleSendChat('deploy the branch') })

        // Mirrors the composition in ChatPane.tsx / CliTerminalPane.tsx with no
        // send block active and the CLI runtime ready.
        const sendBlockMessage: string | null = null
        const placeholder = (status: string, feedback: string | null) =>
            (sendBlockMessage ? SEND_BLOCKED_PLACEHOLDER : null)
            || feedback
            || buildBusyChatInputStatusMessage({ status } as any)
        const statusLine = (feedback: string | null) => feedback || null

        const busyFeedback = scenario.current.sendFeedbackMessage
        expect(placeholder('generating', busyFeedback)).toBe(QUEUED_SEND_MESSAGE)
        expect(statusLine(busyFeedback)).toBe(QUEUED_SEND_MESSAGE)

        scenario.render('idle')
        const idleFeedback = scenario.current.sendFeedbackMessage

        // An idle session has no busy copy either, so the placeholder falls
        // through to null rather than swapping one stale line for another.
        expect(placeholder('idle', idleFeedback)).toBeNull()
        expect(statusLine(idleFeedback)).toBeNull()
        scenario.unmount()
    })

    it('does not clear a send failure when the conversation goes idle', async () => {
        const container = document.createElement('div')
        const root = createRoot(container)
        const sendDaemonCommand = vi.fn().mockResolvedValue({ success: false, error: 'provider failed' })
        let latest: any = null

        function Harness({ status }: { status: string }) {
            latest = useDashboardConversationCommands({
                sendDaemonCommand,
                activeConv: { tabKey: 'tab-1', routeId: 'daemon-1:session-1', daemonId: 'daemon-1', sessionId: 'session-1', status } as any,
                setActionLogs: () => {},
                isStandalone: false,
            })
            return null
        }

        act(() => { root.render(createElement(Harness, { status: 'generating' })) })
        await act(async () => { await latest.handleSendChat('deploy the branch') })
        const failureMessage = latest.sendFeedbackMessage
        expect(failureMessage).toBeTruthy()

        act(() => { root.render(createElement(Harness, { status: 'idle' })) })
        expect(latest.sendFeedbackMessage).toBe(failureMessage)
        act(() => { root.unmount() })
    })
})
