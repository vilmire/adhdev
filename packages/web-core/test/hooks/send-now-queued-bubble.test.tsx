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
 * `handleSendNowQueued` replaces it with honest semantics. It now re-sends the
 * ALREADY-PARKED body with `sendNow: true` (SEND-NOW-AGENT-QUEUE), which makes
 * the daemon perform a SPLIT write — body, gap, submit key — into the generating
 * composer, so the CLI's own input queue takes it and answers it as the next
 * turn. The turn in flight is NOT interrupted and its answer is not lost.
 *
 * ★ That is still not the retired force-inject. 6cca365b measured an ATOMIC
 * `text + '\r'` write being ignored mid-turn; the 2026-09-12 live A/B showed the
 * split shape IS consumed. The distinction is the write shape, and it is pinned
 * at the daemon level by
 * daemon-core/test/commands/send-now-agent-queue-split-write.test.ts.
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
/**
 * What it emits when the split write landed and the CLI's own input queue took
 * the body (SEND-NOW-AGENT-QUEUE).
 *
 * ★ `submitted` is deliberately FALSE: the bytes are in the agent's queue, not
 * answered. Reporting a submit here would repeat the exact lie 6cca365b was
 * retired for. `queuedWithAgent` is the field that says where the body actually
 * is, and it is distinct from `queued` (which means the DAEMON's FIFO parked it
 * and nothing was written at all).
 */
const DAEMON_AGENT_QUEUED = {
    success: true, sent: true, submitted: false, queuedWithAgent: true, claimed: 1,
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
    it('★ asks the daemon for the AGENT QUEUE (not an interrupt), and re-sends the parked body verbatim', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_AGENT_QUEUED)
        const h = await withParkedBubble(send)

        await act(async () => { await h.get().handleSendNowQueued() })

        expect(send).toHaveBeenCalledTimes(2)
        const [, type, payload] = send.mock.calls[1]
        expect(type).toBe('send_chat')
        // ★ SEND-NOW-AGENT-QUEUE. The flag routes the daemon to the split write
        // that the CLI's own input queue takes, leaving the turn in flight
        // running. Without it the daemon would simply park the body again.
        expect(payload).toMatchObject({ message: 'urgent: stop', sendNow: true })
        // ★ And it must NOT ask to interrupt. The two flags mean materially
        // different things — one preserves the running turn, the other destroys
        // it — so sending both would let the daemon pick the outcome in which
        // the owner loses the answer they are waiting for.
        expect(payload.interrupt).toBeUndefined()
        // ★ Nor the retired force-inject spelling, which aliases to interrupt.
        expect(payload.force).toBeUndefined()
        h.unmount()
    })

    it('★ clears the queued badge once the agent queue took the body', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_AGENT_QUEUED)
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

    it('★ a refused write keeps the bubble queued and surfaces why', async () => {
        // Not generating / a previous send still submitting / win32. The body was
        // NOT written, so the bubble must stay queued for the ordinary drain.
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce({
                success: false, sent: false, queuedWithAgent: false, restored: true,
                reason: 'not_generating', error: 'The agent is not generating right now.',
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

    it('★ a win32 refusal does NOT retry as an interrupt — the running turn is never killed', async () => {
        // ★ The safety property of this whole feature. `sendNow` and `interrupt`
        // request materially different outcomes: one preserves the turn in
        // flight, the other destroys it. So a refusal must be REPORTED, never
        // silently escalated — an owner who pressed Send now to add a follow-up
        // thought would otherwise lose the answer they were waiting for, which
        // is precisely the outcome they avoided by not pressing stop.
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce({
                success: false, sent: false, queuedWithAgent: false, restored: true,
                reason: 'platform_unsupported',
                error: 'Send now without interrupting is not available on Windows yet.',
            })
        const h = await withParkedBubble(send)

        let accepted: boolean | undefined
        await act(async () => { accepted = await h.get().handleSendNowQueued() })

        expect(accepted).toBe(false)
        // Exactly TWO calls: the original send and the refused sendNow. A third
        // would be the silent interrupt escalation this test forbids.
        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls.some(call => call[2]?.interrupt === true)).toBe(false)
        expect(send.mock.calls.some(call => call[2]?.force === true)).toBe(false)
        // The body is still parked with the daemon, so the ordinary idle drain
        // will deliver it — the bubble is telling the truth by staying queued.
        expect(h.get().pendingLocalMessage).toMatchObject({ content: 'urgent: stop' })
        expect(h.get().sendFeedbackMessage).toBeTruthy()
        h.unmount()
    })

    it('is a no-op when there is no parked message to send', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_AGENT_QUEUED)
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
            .mockResolvedValueOnce(DAEMON_AGENT_QUEUED)
        const h = await withParkedBubble(send)

        await act(async () => { await h.get().handleSendNowQueued() })

        expect(send).toHaveBeenCalledTimes(2)
        h.unmount()
    })
})
