// @vitest-environment jsdom
/**
 * SEND-NOW at the hook level.
 *
 * This replaces `force-send-queued-not-failure.test.tsx`. That file tested
 * `handleForceSendChat`, which took the DRAFT text and asked the daemon to
 * `force` it — a path whose daemon-side implementation (`forceSendMessage`)
 * never existed in src, so every adapter silently fell through to a plain send.
 * The button was wired to nothing.
 *
 * `handleSendNowQueued` replaces it with the only honest semantics: re-send the
 * ALREADY-PARKED body with `interrupt: true`, which makes the daemon press the
 * provider's own stop key, wait for busy→idle, and deliver it as a real turn.
 *
 * ★ WHY THESE ARE HOOK-LEVEL TESTS (inherited from the file this replaces, and
 * still the point): the sibling helper tests for `isQueuedSendResult` and
 * `withPendingLocalMessage` were correct and passing throughout the original
 * defect — which lived entirely in whether the hook CALLED them. Only driving
 * the real hook can observe that. Do not reduce these to helper assertions.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import {
    useDashboardConversationCommands,
    QUEUED_SEND_MESSAGE,
} from '../../src/hooks/useDashboardConversationCommands'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** What chat-commands-write.ts emits when the driver FIFO parks a send. */
const DAEMON_QUEUED_RESULT = { success: true, sent: false, queued: true, submitted: false }
/** What it emits when the interrupt landed and the body was written as a turn. */
const DAEMON_INTERRUPT_DELIVERED = {
    success: true, sent: true, submitted: true, interrupted: true,
    interruptKey: 'Ctrl-C', interruptConfidence: 'proven',
}

function renderHarness(sendDaemonCommand: ReturnType<typeof vi.fn>) {
    const container = document.createElement('div')
    const root = createRoot(container)
    let latest: any = null

    // Stable identity: the hook memoises on `activeConv`, and a fresh literal
    // per render would silently defeat the refs under test.
    const activeConv = {
        tabKey: 'tab-1',
        routeId: 'daemon-1:sess-1',
        daemonId: 'daemon-1',
        sessionId: 'sess-1',
        status: 'generating',
    }

    function Harness() {
        latest = useDashboardConversationCommands({
            sendDaemonCommand,
            activeConv,
            setActionLogs: () => {},
            isStandalone: false,
        } as any)
        return null
    }

    act(() => { root.render(createElement(Harness)) })
    return { get: () => latest, unmount: () => act(() => { root.unmount() }) }
}

/** Drive the hook into the state a Send now press acts on: a parked bubble. */
async function withParkedBubble(send: ReturnType<typeof vi.fn>) {
    const h = renderHarness(send)
    await act(async () => { await h.get().handleSendChat('urgent: stop') })
    expect(h.get().pendingLocalMessage).toMatchObject({ content: 'urgent: stop', queued: true })
    return h
}

describe('SEND-NOW — handleSendNowQueued', () => {
    it('★ asks the daemon to INTERRUPT, and re-sends the parked body verbatim', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_INTERRUPT_DELIVERED)
        const h = await withParkedBubble(send)

        await act(async () => { await h.get().handleSendNowQueued() })

        expect(send).toHaveBeenCalledTimes(2)
        const [, type, payload] = send.mock.calls[1]
        expect(type).toBe('send_chat')
        // ★ The flag is what routes the daemon to interrupt→idle→deliver. Without
        // it the daemon would simply park the body a second time.
        expect(payload).toMatchObject({ message: 'urgent: stop', interrupt: true })
        // ★ And it must NOT carry the retired force-inject spelling as its own
        // request — `force` now aliases to the same path, but the dashboard
        // should be asking for what it actually means.
        expect(payload.force).toBeUndefined()
        h.unmount()
    })

    it('★ clears the queued badge once the interrupt delivered it as a real turn', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_INTERRUPT_DELIVERED)
        const h = await withParkedBubble(send)

        await act(async () => { await h.get().handleSendNowQueued() })

        expect(h.get().lastSendQueued).toBe(false)
        expect(h.get().sendFeedbackMessage).toBeNull()
        // The bubble STAYS — it is retired by the daemon's echo, exactly like a
        // normal send. Only the queued marking is dropped.
        expect(h.get().pendingLocalMessage).toMatchObject({ content: 'urgent: stop', queued: false })
        h.unmount()
    })

    it('★ a re-parked result keeps the bubble queued rather than claiming delivery', async () => {
        // The session can re-enter busy between the daemon's idle observation
        // and its write. Reporting that as delivered would be the same class of
        // lie the retired force path told.
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
        const h = await withParkedBubble(send)

        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleSendNowQueued() })

        expect(accepted).toBe(true)
        expect(h.get().lastSendQueued).toBe(true)
        expect(h.get().sendFeedbackMessage).toBe(QUEUED_SEND_MESSAGE)
        expect(h.get().pendingLocalMessage).toMatchObject({ queued: true })
        h.unmount()
    })

    it('★ a refused interrupt keeps the bubble queued and surfaces why', async () => {
        // No stop key / not generating / idle never observed. The body was NOT
        // written, so the bubble must stay queued for the ordinary drain.
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce({
                success: false, sent: false, interrupted: false,
                reason: 'stop_keys_empty', error: 'declares a stop control with an EMPTY key sequence',
            })
        const h = await withParkedBubble(send)

        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleSendNowQueued() })

        expect(accepted).toBe(false)
        expect(h.get().sendFeedbackMessage).toBeTruthy()
        // ★ The bubble must NOT be retired: the message is still parked and will
        // still be delivered when the agent finishes on its own.
        expect(h.get().pendingLocalMessage).toMatchObject({ content: 'urgent: stop' })
        h.unmount()
    })

    it('is a no-op when there is no parked message to send', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_INTERRUPT_DELIVERED)
        const h = renderHarness(send)

        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleSendNowQueued() })

        expect(accepted).toBe(false)
        expect(send).not.toHaveBeenCalled()
        h.unmount()
    })

    it('is a no-op when the bubble exists but was already SUBMITTED', async () => {
        // Nothing is parked, so there is no turn to interrupt on its behalf.
        const send = vi.fn().mockResolvedValue({ success: true, sent: true, submitted: true })
        const h = renderHarness(send)
        await act(async () => { await h.get().handleSendChat('already delivered') })
        expect(h.get().pendingLocalMessage).toMatchObject({ content: 'already delivered' })
        expect(h.get().pendingLocalMessage.queued).toBeFalsy()

        await act(async () => { await h.get().handleSendNowQueued() })

        expect(send).toHaveBeenCalledTimes(1)
        h.unmount()
    })

    it('★ is NOT suppressed by the recent-duplicate guard', async () => {
        // Send now re-sends the SAME text as the original send, by design. If
        // the dedup guard applied, every press would be silently swallowed —
        // which is exactly how a button appears "wired to nothing".
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_INTERRUPT_DELIVERED)
        const h = await withParkedBubble(send)

        await act(async () => { await h.get().handleSendNowQueued() })

        expect(send).toHaveBeenCalledTimes(2)
        h.unmount()
    })
})
