// @vitest-environment jsdom
/**
 * (FORCE-SEND-QUEUED-MISCLASSIFICATION) The force path classified a send the
 * daemon had ACCEPTED as a failure, and that misclassification is what produced
 * the reported triple-send.
 *
 * The daemon answers a parked force send with
 * `{success:true, sent:false, queued:true, forceSent:true}` — "received, and
 * parked in the driver FIFO". `handleForceSendChat` checked `res.sent === false`
 * with no queued branch ahead of it, so it threw, rendered "Send failed", and —
 * the damaging part — ran `clearRecentSendOnFailure`, dropping the dedup record
 * that would otherwise have suppressed the user's retry. The owner saw a false
 * error, pressed again, and each press parked another copy.
 *
 * ★ WHY THESE ARE HOOK-LEVEL TESTS, not helper tests. The sibling file
 * `queued-send-and-optimistic-bubble.test.ts` already asserts `isQueuedSendResult`
 * and `withPendingLocalMessage` in isolation, and both were correct and passing
 * throughout — the defect lived entirely in whether `handleForceSendChat` CALLED
 * them. Only driving the real hook can observe that, which is precisely the gap
 * that let this ship. Do not "simplify" these back into helper assertions.
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

/** The exact shape chat-commands-write.ts emits for a parked FORCE send. */
const DAEMON_QUEUED_FORCE_RESULT = { success: true, sent: false, queued: true, forceSent: true }

function renderHarness(sendDaemonCommand: ReturnType<typeof vi.fn>) {
    const container = document.createElement('div')
    const root = createRoot(container)
    let latest: any = null

    // Stable identity: the hook's handlers are memoised on `activeConv`, and a
    // fresh literal per render would silently defeat the dedup ref under test.
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

describe('★ force send — a QUEUED result is acceptance, not failure', () => {
    it('★ does not render "Send failed" when the daemon parks a force send', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_FORCE_RESULT)
        const h = renderHarness(send)

        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleForceSendChat('urgent: stop') })

        // Reported to the caller as success...
        expect(accepted).toBe(true)
        // ...and surfaced as a WAITING state, never as an error.
        expect(h.get().sendFeedbackMessage).toBe(QUEUED_SEND_MESSAGE)
        expect(String(h.get().sendFeedbackMessage)).not.toMatch(/fail/i)
        expect(h.get().lastSendQueued).toBe(true)
        h.unmount()
    })

    it('★ does NOT clear the dedup record — the retry that produced the triple-send', async () => {
        // This is the assertion that maps directly to the reported harm. The
        // dedup record is not readable from outside the hook, so we observe it
        // the way the user did: by pressing again and counting daemon calls.
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_FORCE_RESULT)
        const h = renderHarness(send)

        await act(async () => { await h.get().handleForceSendChat('urgent: stop') })
        expect(send).toHaveBeenCalledTimes(1)

        // The owner, seeing no error now, presses the same text again anyway.
        // The retained attempt must suppress it inside the dedup window.
        await act(async () => { await h.get().handleForceSendChat('urgent: stop') })
        expect(send).toHaveBeenCalledTimes(1)

        h.unmount()
    })

    it('a genuine failure still fails, and still clears the record for retry', async () => {
        // The queued branch must not swallow real errors: `sent:false` WITHOUT
        // `queued` is still a failure, and there the retry must go through.
        const send = vi.fn().mockResolvedValue({ success: false, sent: false, error: 'no route' })
        const h = renderHarness(send)

        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleForceSendChat('will fail') })
        expect(accepted).toBe(false)
        expect(h.get().sendFeedbackMessage).toBeTruthy()
        expect(h.get().lastSendQueued).toBe(false)
        // Optimistic bubble retired — nothing was delivered, so nothing may show.
        expect(h.get().pendingLocalMessage).toBeNull()

        // A retry after a real failure is NOT suppressed.
        await act(async () => { await h.get().handleForceSendChat('will fail') })
        expect(send).toHaveBeenCalledTimes(2)
        h.unmount()
    })
})

describe('★ force send — the optimistic bubble (immediate feedback)', () => {
    it('★ appears BEFORE the daemon answers, not after the round trip', async () => {
        // The force button is pressed precisely when the agent is busy, i.e.
        // when the round trip is slowest. A bubble that waits for the response
        // is the silence that invited repeated presses.
        let release: (v: unknown) => void = () => {}
        const send = vi.fn().mockReturnValue(new Promise(res => { release = res }))
        const h = renderHarness(send)

        let pending: Promise<boolean>
        act(() => { pending = h.get().handleForceSendChat('urgent: stop')! })

        // Mid-flight: the daemon has NOT replied yet, and the bubble is already up.
        expect(h.get().pendingLocalMessage).toMatchObject({ content: 'urgent: stop' })

        await act(async () => { release(DAEMON_QUEUED_FORCE_RESULT); await pending })

        // Still shown after a queued reply — the body was accepted and will land.
        expect(h.get().pendingLocalMessage).toMatchObject({ content: 'urgent: stop', queued: true })
        h.unmount()
    })
})
