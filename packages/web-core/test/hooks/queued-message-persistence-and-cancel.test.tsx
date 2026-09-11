// @vitest-environment jsdom
/**
 * (QUEUED-SEND-RESTART-LOSS + MULTI-QUEUE + CANCEL) at the hook level.
 *
 * ★ The owner's report, and what each half of it actually was:
 *
 *   "queue a message, close and reopen the app, the queued message is not shown"
 *      → NOT data loss. The body stays parked in the daemon's `pendingSends`
 *        FIFO and drains normally. The UI forgot it, because the waiting bubble
 *        lived in a React `useState` slot and the daemon reports no queue depth.
 *
 *   "make multiple queued messages possible"
 *      → The daemon FIFO was ALWAYS an array. The UI slot was SINGLE, so a
 *        second send while busy overwrote the first bubble — the first message
 *        vanished from screen while still genuinely queued.
 *
 *   "allow cancel, not just Send now"
 *      → Needs to reach the daemon: hiding the bubble alone would let the agent
 *        answer a "cancelled" message later.
 *
 * ★ WHY HOOK-LEVEL (same reasoning as send-now-queued-bubble.test.tsx): the
 * store helpers can be perfectly correct while the hook never calls them. Only
 * driving the real hook observes the wiring.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { useDashboardConversationCommands } from '../../src/hooks/useDashboardConversationCommands'
import { readPendingQueuedMessages } from '../../src/utils/pendingQueuedMessages'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** What chat-commands-write.ts emits when the driver FIFO parks a send. */
const DAEMON_QUEUED_RESULT = { success: true, sent: false, queued: true, submitted: false }
/** What cancel_queued_chat emits when it really removed the body. */
const DAEMON_CANCEL_OK = { success: true, cancelled: 1, removed: true }
/** What it emits when the FIFO had already drained. */
const DAEMON_CANCEL_TOO_LATE = { success: true, cancelled: 0, removed: false }

const TAB_KEY = 'tab-1'

/**
 * A REAL in-memory localStorage. `test/setup.ts` installs an inert stub (to pin
 * i18n to `en`) whose setItem is a no-op — persistence would "pass" by never
 * writing, the precise false-green these tests exist to prevent.
 */
function installMemoryLocalStorage(): void {
    let data: Record<string, string> = {}
    const storage: Storage = {
        getItem: (key: string) => (key === 'lang' ? 'en' : (key in data ? data[key] : null)),
        setItem: (key: string, value: string) => { data[key] = String(value) },
        removeItem: (key: string) => { delete data[key] },
        clear: () => { data = {} },
        key: (index: number) => Object.keys(data)[index] ?? null,
        get length() { return Object.keys(data).length },
    }
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
    ;(globalThis as { localStorage?: Storage }).localStorage = storage
}

beforeEach(() => {
    installMemoryLocalStorage()
    window.localStorage.clear()
})

function renderHarness(sendDaemonCommand: ReturnType<typeof vi.fn>) {
    const container = document.createElement('div')
    const root = createRoot(container)
    let latest: any = null

    // Stable identity: the hook memoises on `activeConv`.
    const activeConv = {
        tabKey: TAB_KEY,
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

/** Queue N distinct bodies through the real hook, each parked by the daemon. */
async function queueBodies(h: ReturnType<typeof renderHarness>, bodies: string[]) {
    for (const body of bodies) {
        await act(async () => { await h.get().handleSendChat(body) })
    }
}

describe('MULTI-QUEUE — the UI keeps every parked body', () => {
    it('★ a second queued send does NOT overwrite the first (the single-slot defect)', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)

        await queueBodies(h, ['first body', 'second body', 'third body'])

        expect(h.get().pendingLocalMessages.map((e: any) => e.content))
            .toEqual(['first body', 'second body', 'third body'])
        expect(h.get().pendingLocalMessages.every((e: any) => e.queued === true)).toBe(true)
    })

    it('★ preserves FIFO order, matching the daemon drain order', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['alpha', 'beta', 'gamma'])

        expect(h.get().pendingLocalMessages.map((e: any) => e.content)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('gives every entry a distinct id, so per-item actions can address one', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['one', 'two'])

        const ids = h.get().pendingLocalMessages.map((e: any) => e.id)
        expect(new Set(ids).size).toBe(2)
        expect(ids.every((id: string) => typeof id === 'string' && id.length > 0)).toBe(true)
    })

    it('exposes the newest entry as pendingLocalMessage for unmigrated surfaces', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['older', 'newest'])

        expect(h.get().pendingLocalMessage).toMatchObject({ content: 'newest', queued: true })
    })
})

describe('RESTART — the queue is restored from durable storage', () => {
    it('★ queued bodies reappear after a full unmount/remount (app restart)', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const first = renderHarness(send)
        await queueBodies(first, ['survive me', 'and me too'])

        // Closing the app tears down all React state but keeps localStorage.
        first.unmount()

        const afterRestart = renderHarness(vi.fn())
        expect(afterRestart.get().pendingLocalMessages.map((e: any) => e.content))
            .toEqual(['survive me', 'and me too'])
        expect(afterRestart.get().pendingLocalMessages.every((e: any) => e.queued === true)).toBe(true)
    })

    it('★ the bodies really are written to durable storage, not just React state', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['persisted body'])

        // Read the store directly — independent of the hook's own state.
        expect(readPendingQueuedMessages(TAB_KEY).map(e => e.content)).toEqual(['persisted body'])
    })

    it('a failed send leaves nothing behind to restore', async () => {
        const send = vi.fn().mockRejectedValue(new Error('daemon unreachable'))
        const h = renderHarness(send)
        await act(async () => { await h.get().handleSendChat('never delivered') })

        expect(h.get().pendingLocalMessages).toEqual([])
        expect(readPendingQueuedMessages(TAB_KEY)).toEqual([])
    })
})

describe('CANCEL — per-item withdrawal', () => {
    it('★ cancels ONE entry and leaves the others queued', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['keep me', 'cancel me', 'keep me too'])

        const target = h.get().pendingLocalMessages.find((e: any) => e.content === 'cancel me')
        send.mockResolvedValueOnce(DAEMON_CANCEL_OK)
        await act(async () => { await h.get().handleCancelQueued(target.id) })

        expect(h.get().pendingLocalMessages.map((e: any) => e.content)).toEqual(['keep me', 'keep me too'])
    })

    it('★ asks the DAEMON to drop the body — a local-only removal would be a lie', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['withdraw this'])

        const target = h.get().pendingLocalMessages[0]
        send.mockResolvedValueOnce(DAEMON_CANCEL_OK)
        await act(async () => { await h.get().handleCancelQueued(target.id) })

        const cancelCall = send.mock.calls.find(call => call[1] === 'cancel_queued_chat')
        expect(cancelCall).toBeTruthy()
        // Content-keyed: the body identifies the FIFO entry to claim.
        expect(cancelCall![2]).toMatchObject({ message: 'withdraw this' })
    })

    it('★ clears the durable store too, so a restart cannot resurrect it', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['cancel me'])
        expect(readPendingQueuedMessages(TAB_KEY)).toHaveLength(1)

        const target = h.get().pendingLocalMessages[0]
        send.mockResolvedValueOnce(DAEMON_CANCEL_OK)
        await act(async () => { await h.get().handleCancelQueued(target.id) })

        expect(readPendingQueuedMessages(TAB_KEY)).toEqual([])

        // And a restart genuinely shows nothing.
        h.unmount()
        expect(renderHarness(vi.fn()).get().pendingLocalMessages).toEqual([])
    })

    it('★ KEEPS the bubble when the daemon says the body already drained', async () => {
        // The race: the agent went idle and consumed the body mid-decision.
        // Removing the bubble here would hide a message the agent is answering.
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['too late to stop'])

        const target = h.get().pendingLocalMessages[0]
        send.mockResolvedValueOnce(DAEMON_CANCEL_TOO_LATE)
        let outcome: boolean | undefined
        await act(async () => { outcome = await h.get().handleCancelQueued(target.id) })

        expect(outcome).toBe(false)
        expect(h.get().pendingLocalMessages.map((e: any) => e.content)).toEqual(['too late to stop'])
        expect(readPendingQueuedMessages(TAB_KEY)).toHaveLength(1)
    })

    it('keeps the bubble when the cancel command itself fails', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['body'])

        const target = h.get().pendingLocalMessages[0]
        send.mockRejectedValueOnce(new Error('p2p down'))
        await act(async () => { await h.get().handleCancelQueued(target.id) })

        expect(h.get().pendingLocalMessages).toHaveLength(1)
    })

    it('a RESOLVED not-parked entry is dropped locally without a daemon call', async () => {
        // The send has answered "submitted": nothing is in the daemon FIFO, so
        // there is no remote state to contradict and no command should issue.
        //
        // ★ "resolved" is load-bearing. The same check without it also matched
        // sends still in flight, whose bodies the daemon may be parking — see
        // the CANCEL-INFLIGHT-LEAK block below.
        const send = vi.fn().mockResolvedValue({ success: true, sent: true, submitted: true })
        const h = renderHarness(send)
        await queueBodies(h, ['delivered immediately'])

        const entry = h.get().pendingLocalMessages[0]
        expect(entry.queued).toBeFalsy()
        expect(entry.settled).toBe(true)

        send.mockClear()
        await act(async () => { await h.get().handleCancelQueued(entry.id) })

        expect(h.get().pendingLocalMessages).toEqual([])
        expect(send.mock.calls.some(call => call[1] === 'cancel_queued_chat')).toBe(false)
    })

    it('ignores a cancel for an unknown id', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['still here'])

        let outcome: boolean | undefined
        await act(async () => { outcome = await h.get().handleCancelQueued('no-such-id') })

        expect(outcome).toBe(false)
        expect(h.get().pendingLocalMessages).toHaveLength(1)
    })
})

/**
 * (CANCEL-INFLIGHT-LEAK) The owner's 2026-09-11 report: "취소하고나서 다른 메세지
 * 보내니 취소한거까지 같이 감" — with "다 보였음 취소도 잘 되었음", i.e. the UI showed a
 * clean cancellation and the agent answered the message anyway.
 *
 * ★ The window. `queued` is only set AFTER `send_chat` resolves, so between
 * submit and that answer the entry is un-queued but NOT harmless: the daemon may
 * be parking the body right then. The old cancel treated un-queued as "nothing
 * to withdraw", dropped the bubble locally and issued NO command — so the body
 * stayed in `FsmDriver.pendingSends` and drained minutes later. Queueing happens
 * precisely when the owner is firing messages at a busy agent and Cancel lives
 * inside that bubble, so this is ordinary use, not a contrived interleaving.
 *
 * ★ These assert the DAEMON was asked, not merely that the bubble went away.
 * A test that only checked local state is what let this ship.
 */
describe('CANCEL-INFLIGHT-LEAK — a cancel during an unresolved send still reaches the daemon', () => {
    /** Hold `send_chat` open so the cancel lands mid-round-trip. */
    function deferredSend() {
        let release: (value: unknown) => void = () => {}
        const gate = new Promise(resolve => { release = resolve })
        const send = vi.fn().mockImplementation((_target: unknown, command: string) => {
            if (command === 'send_chat') return gate
            return Promise.resolve(DAEMON_CANCEL_OK)
        })
        return { send, release: () => release(DAEMON_QUEUED_RESULT) }
    }

    it('★ issues cancel_queued_chat for a body whose send has not answered yet', async () => {
        const { send, release } = deferredSend()
        const h = renderHarness(send)

        // Submit without awaiting: the round trip is still open.
        let sendPromise: Promise<boolean> | undefined
        await act(async () => {
            sendPromise = h.get().handleSendChat('WITHDRAW ME')
            await Promise.resolve()
        })
        const entry = h.get().pendingLocalMessages[0]
        expect(entry.queued).toBeFalsy()
        expect(entry.settled).toBeFalsy()

        // Cancel now, then let the daemon answer that it PARKED the body.
        let cancelPromise: Promise<boolean> | undefined
        await act(async () => {
            cancelPromise = h.get().handleCancelQueued(entry.id)
            await Promise.resolve()
            release()
            await sendPromise
            await cancelPromise
        })

        // ★ The assertion the live defect needed: the daemon was told.
        const cancelCall = send.mock.calls.find(call => call[1] === 'cancel_queued_chat')
        expect(cancelCall).toBeTruthy()
        expect(cancelCall![2]).toMatchObject({ message: 'WITHDRAW ME' })
        expect(h.get().pendingLocalMessages).toEqual([])
    })

    it('★ waits for the send to resolve before claiming, so the claim can find the body', async () => {
        // Ordering, not just presence. `cancel_queued_chat` claims from a FIFO
        // the body has to be IN — firing it while send_chat is still travelling
        // answers `cancelled: 0` for a message that gets parked a moment later,
        // which reports "too late" and then delivers it anyway.
        const order: string[] = []
        let release: (value: unknown) => void = () => {}
        const gate = new Promise(resolve => { release = resolve })
        const send = vi.fn().mockImplementation((_target: unknown, command: string) => {
            if (command === 'send_chat') return gate.then(v => { order.push('send_chat:resolved'); return v })
            order.push('cancel_queued_chat:issued')
            return Promise.resolve(DAEMON_CANCEL_OK)
        })
        const h = renderHarness(send)

        let sendPromise: Promise<boolean> | undefined
        await act(async () => {
            sendPromise = h.get().handleSendChat('ORDERED BODY')
            await Promise.resolve()
        })
        const entry = h.get().pendingLocalMessages[0]

        let cancelPromise: Promise<boolean> | undefined
        await act(async () => {
            cancelPromise = h.get().handleCancelQueued(entry.id)
            await Promise.resolve()
            release(DAEMON_QUEUED_RESULT)
            await sendPromise
            await cancelPromise
        })

        expect(order).toEqual(['send_chat:resolved', 'cancel_queued_chat:issued'])
    })

    it('★ a send that resolves as DELIVERED needs no claim — and the bubble still goes', async () => {
        // The other side of the wait: once the send answers "submitted", nothing
        // is parked, so a cancel command would be noise. Guards against
        // over-correcting into a claim on every cancel.
        let release: (value: unknown) => void = () => {}
        const gate = new Promise(resolve => { release = resolve })
        const send = vi.fn().mockImplementation((_target: unknown, command: string) => {
            if (command === 'send_chat') return gate
            return Promise.resolve(DAEMON_CANCEL_OK)
        })
        const h = renderHarness(send)

        let sendPromise: Promise<boolean> | undefined
        await act(async () => {
            sendPromise = h.get().handleSendChat('ALREADY DELIVERED')
            await Promise.resolve()
        })
        const entry = h.get().pendingLocalMessages[0]

        let cancelPromise: Promise<boolean> | undefined
        await act(async () => {
            cancelPromise = h.get().handleCancelQueued(entry.id)
            await Promise.resolve()
            release({ success: true, sent: true, submitted: true })
            await sendPromise
            await cancelPromise
        })

        expect(send.mock.calls.some(call => call[1] === 'cancel_queued_chat')).toBe(false)
        expect(h.get().pendingLocalMessages).toEqual([])
    })

    it('★ a restored entry is settled, so cancelling it never waits on a promise that cannot exist', async () => {
        // No `send_chat` survives a reload. An entry read back unsettled would
        // stall every cancel for the full timeout before doing the right thing.
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const first = renderHarness(send)
        await queueBodies(first, ['survives reload'])
        first.unmount()

        const reopened = renderHarness(send)
        const restored = reopened.get().pendingLocalMessages[0]
        expect(restored.settled).toBe(true)
        expect(restored.queued).toBe(true)

        send.mockResolvedValueOnce(DAEMON_CANCEL_OK)
        await act(async () => { await reopened.get().handleCancelQueued(restored.id) })
        expect(reopened.get().pendingLocalMessages).toEqual([])
    })
})

describe('SEND-NOW stays correct with several entries queued', () => {
    it('★ targets the pressed entry, not merely the first queued one', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['first', 'second'])

        const second = h.get().pendingLocalMessages.find((e: any) => e.content === 'second')
        send.mockResolvedValueOnce({ success: true, sent: true, submitted: true, interrupted: true })
        await act(async () => { await h.get().handleSendNowQueued(second.id) })

        const interruptCall = send.mock.calls.reverse().find(call => call[1] === 'send_chat' && call[2]?.interrupt === true)
        expect(interruptCall).toBeTruthy()
        expect(interruptCall![2].message).toBe('second')
    })

    it('falls back to the oldest queued entry when no id is given (legacy callers)', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['oldest', 'newest'])

        send.mockResolvedValueOnce({ success: true, sent: true, submitted: true, interrupted: true })
        await act(async () => { await h.get().handleSendNowQueued() })

        const interruptCall = send.mock.calls.reverse().find(call => call[1] === 'send_chat' && call[2]?.interrupt === true)
        expect(interruptCall![2].message).toBe('oldest')
    })
})
