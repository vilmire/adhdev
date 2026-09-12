// @vitest-environment jsdom
/**
 * (QUEUED-SEND-STUCK-FOREVER) The owner's report: "a message I sent long ago is
 * still pinned above the composer as 'Waiting to send', forever."
 *
 * ★ WHAT WAS ACTUALLY BROKEN — there was no echo-based retirement path at all.
 *
 * Echo matching existed, but only inside `withPendingLocalMessages`, which runs
 * while BUILDING THE RENDER: it skipped the bubble and returned. React state and
 * localStorage still held the entry. That was survivable while the only consumer
 * was the transcript (the skip hid it), and became a permanent defect once the
 * pinned strip was added, because the strip reads the STORE — so it kept
 * rendering rows the transcript had long since stopped showing. Worse, the
 * render-time match deliberately EXCLUDES queued rows, which are exactly the ones
 * the strip shows, so parked bodies had no echo path whatsoever.
 *
 * Every removal path that DID exist was wired to the browser's own send/cancel
 * round trip. Nothing was wired to the daemon saying "I delivered this". So when
 * the daemon's FIFO vanished without draining — `FsmDriver.shutdown()` logs
 * `DISCARDING n queued send(s)` and empties `pendingSends` while notifying no
 * surface — no echo and no cancel confirmation could ever arrive, and the row
 * stayed until a 24h age-out.
 *
 * ★ WHY HOOK-LEVEL. The pure reconciler can be perfectly correct while the hook
 * never calls it, and a render-level assertion cannot tell "removed from state"
 * from "hidden by the render" — which is the entire distinction being fixed.
 * These drive the real hook and then read the PERSISTED store back.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { useDashboardConversationCommands } from '../../src/hooks/useDashboardConversationCommands'
import {
    readPendingQueuedMessages,
    writePendingQueuedMessages,
    PENDING_QUEUED_MESSAGE_STALE_AFTER_MS,
} from '../../src/utils/pendingQueuedMessages'
import { retirePendingLocalMessages } from '../../src/components/dashboard/conversation-message-snapshot'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** What chat-commands-write.ts emits when the driver FIFO parks a send. */
const DAEMON_QUEUED_RESULT = { success: true, sent: false, queued: true, submitted: false }
/** What cancel_queued_chat emits when the FIFO does not hold the body. */
const DAEMON_CANCEL_NOTHING_HELD = { success: true, cancelled: 0, removed: false }
/** What it emits when it really removed the body. */
const DAEMON_CANCEL_OK = { success: true, cancelled: 1, removed: true }

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

/** A daemon transcript row — the echo shape the retirement matches against. */
function userEcho(content: string) {
    return { id: `echo-${content}`, role: 'user', kind: 'standard', content }
}

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

async function queueBodies(h: ReturnType<typeof renderHarness>, bodies: string[]) {
    for (const body of bodies) {
        await act(async () => { await h.get().handleSendChat(body) })
    }
}

/** What the store — not the render — holds for this conversation. */
function persisted(): ReturnType<typeof readPendingQueuedMessages> {
    return readPendingQueuedMessages(TAB_KEY)
}

describe('(a) echo retirement removes the entry from STATE, not just from the render', () => {
    it('★ a daemon echo retires a PARKED entry from state AND localStorage', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['deliver me'])

        // Precondition: parked, rendered, and persisted.
        expect(h.get().pendingLocalMessages).toHaveLength(1)
        expect(h.get().pendingLocalMessages[0].queued).toBe(true)
        expect(persisted()).toHaveLength(1)

        // The daemon drains the FIFO and the body comes back as a real turn.
        act(() => { h.get().retireEchoedPendingMessages([userEcho('deliver me')]) })

        // ★ The whole fix: gone from state, and gone from the durable copy — so a
        // reload cannot resurrect it and the pinned strip has nothing to render.
        expect(h.get().pendingLocalMessages).toHaveLength(0)
        expect(persisted()).toHaveLength(0)
    })

    it('★ covers QUEUED rows — the ones the render-time path excluded entirely', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['parked body'])
        expect(h.get().pendingLocalMessages[0].queued).toBe(true)

        act(() => { h.get().retireEchoedPendingMessages([userEcho('parked body')]) })

        // `withPendingLocalMessages({excludeQueued:true})` would never have retired
        // this one: it skips queued rows before reaching its echo check, because the
        // strip renders them. State-level retirement is not subject to that skip.
        expect(persisted()).toHaveLength(0)
    })

    it('retires only the entries the echoes account for, leaving the rest parked', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['first', 'second', 'third'])

        act(() => { h.get().retireEchoedPendingMessages([userEcho('first'), userEcho('third')]) })

        expect(h.get().pendingLocalMessages.map((e: any) => e.content)).toEqual(['second'])
        expect(persisted().map(e => e.content)).toEqual(['second'])
    })

    it('★ one echo retires exactly ONE of two identical bodies', async () => {
        // Seeded rather than sent twice: `handleSendChat` suppresses an identical
        // resend inside 2s, so the two-identical-bodies queue is reached by waiting
        // out that window — which is exactly what the owner does when they type
        // "continue" again minutes later at a still-busy agent.
        const sentAt = Date.now() - 60_000
        writePendingQueuedMessages(TAB_KEY, [
            { id: 'dup-1', content: 'continue', sentAt, queued: true } as any,
            { id: 'dup-2', content: 'continue', sentAt: sentAt + 5_000, queued: true } as any,
        ])
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        expect(h.get().pendingLocalMessages).toHaveLength(2)

        act(() => { h.get().retireEchoedPendingMessages([userEcho('continue')]) })

        // A boolean "was it echoed?" would retire BOTH and hide a body still
        // parked in the daemon FIFO — the same disappearance, one message later.
        // The surviving entry is the SECOND: the daemon drains FIFO, so the echo
        // accounts for the older one.
        expect(h.get().pendingLocalMessages).toHaveLength(1)
        expect(h.get().pendingLocalMessages[0].id).toBe('dup-2')
        expect(persisted()).toHaveLength(1)
    })

    it('does not retire on an unrelated transcript, and writes nothing when nothing matched', async () => {
        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        await queueBodies(h, ['still waiting'])
        const before = h.get().pendingLocalMessages

        act(() => {
            h.get().retireEchoedPendingMessages([
                userEcho('a different message'),
                { id: 'a1', role: 'assistant', kind: 'standard', content: 'still waiting' },
            ])
        })

        expect(persisted().map(e => e.content)).toEqual(['still waiting'])
        // Identity is preserved on a no-op pass, so a tail tick that retires
        // nothing costs no re-render and no localStorage write.
        expect(h.get().pendingLocalMessages).toBe(before)
    })

    it('ignores an assistant message that happens to quote the body back', () => {
        const entries = [{ id: 'e1', content: 'run the tests', sentAt: 1_000 }]
        const result = retirePendingLocalMessages(
            entries,
            [{ id: 'a', role: 'assistant', kind: 'standard', content: 'run the tests' } as any],
            2_000,
        )
        // Only the owner's OWN echoed turn is evidence of delivery.
        expect(result.changed).toBe(false)
        expect(result.entries).toHaveLength(1)
    })
})

describe('(b) age cutoff — a body stops claiming it is still on its way', () => {
    it('★ marks an entry stale past the threshold instead of pinning it forever', () => {
        const sentAt = 1_000_000
        const result = retirePendingLocalMessages(
            [{ id: 'e1', content: 'orphaned body', sentAt, queued: true }],
            [],
            sentAt + PENDING_QUEUED_MESSAGE_STALE_AFTER_MS + 1,
        )

        expect(result.changed).toBe(true)
        expect(result.markedStale).toBe(1)
        expect(result.entries[0].stale).toBe(true)
        // ★ MARKED, NOT DROPPED. A body the daemon discarded on teardown is one
        // the owner most likely wants to resend, and they cannot resend what they
        // cannot see. Deleting their text on a timer is the worse failure.
        expect(result.entries[0].content).toBe('orphaned body')
    })

    it('leaves a body inside the window alone — queue drains really do take tens of seconds', () => {
        const sentAt = 1_000_000
        const result = retirePendingLocalMessages(
            [{ id: 'e1', content: 'recent body', sentAt, queued: true }],
            [],
            sentAt + PENDING_QUEUED_MESSAGE_STALE_AFTER_MS - 1,
        )
        expect(result.changed).toBe(false)
        expect(result.entries[0].stale).toBeUndefined()
    })

    it('is idempotent — an already-stale row is not re-marked on every sweep', () => {
        const sentAt = 1_000_000
        const now = sentAt + PENDING_QUEUED_MESSAGE_STALE_AFTER_MS + 1
        const once = retirePendingLocalMessages([{ id: 'e1', content: 'x', sentAt, queued: true }], [], now)
        const twice = retirePendingLocalMessages(once.entries, [], now)
        expect(twice.changed).toBe(false)
        expect(twice.entries).toBe(once.entries)
    })

    it('★ an echo still wins over staleness — a late delivery retires, never lingers as stale', () => {
        const sentAt = 1_000_000
        const result = retirePendingLocalMessages(
            [{ id: 'e1', content: 'late but delivered', sentAt, queued: true }],
            [userEcho('late but delivered') as any],
            sentAt + PENDING_QUEUED_MESSAGE_STALE_AFTER_MS + 1,
        )
        expect(result.retiredByEcho).toBe(1)
        expect(result.entries).toHaveLength(0)
    })

    it('★ stale is DERIVED on read, so an already-pinned body is honest the moment the pane mounts', () => {
        const sentAt = Date.now() - PENDING_QUEUED_MESSAGE_STALE_AFTER_MS - 60_000
        // Exactly what the owner's browser holds right now: a row written by an
        // older build, with no `stale` field, for a session long since torn down.
        writePendingQueuedMessages(TAB_KEY, [
            { id: 'legacy-1', content: 'pinned since forever', sentAt, queued: true } as any,
        ])

        // No echo can ever arrive for it, so deriving on read is the only thing
        // that can resolve it. This is what makes the deployed fix clean up the
        // existing stuck rows on the next reload.
        expect(readPendingQueuedMessages(TAB_KEY)[0].stale).toBe(true)
    })

    it('the 24h store bound still applies on top of the stale mark', () => {
        const sentAt = Date.now() - (25 * 60 * 60 * 1000)
        writePendingQueuedMessages(TAB_KEY, [
            { id: 'ancient', content: 'a day old', sentAt, queued: true } as any,
        ])
        expect(readPendingQueuedMessages(TAB_KEY)).toHaveLength(0)
    })
})

describe('(c) cancelled:0 — a body the daemon does not hold must drop locally', () => {
    it('★ drops a STALE entry when the daemon reports nothing queued', async () => {
        const sentAt = Date.now() - PENDING_QUEUED_MESSAGE_STALE_AFTER_MS - 60_000
        writePendingQueuedMessages(TAB_KEY, [
            { id: 'orphan-1', content: 'ghost body', sentAt, queued: true } as any,
        ])
        const send = vi.fn().mockResolvedValue(DAEMON_CANCEL_NOTHING_HELD)
        const h = renderHarness(send)

        // Restored on mount, and already honest about not being delivered.
        expect(h.get().pendingLocalMessages).toHaveLength(1)
        expect(h.get().pendingLocalMessages[0].stale).toBe(true)

        let ok: boolean | undefined
        await act(async () => { ok = await h.get().handleCancelQueued('orphan-1') })

        // ★ The defect: this used to report "too late to cancel" and KEEP the row,
        // so the owner pressed Cancel on a message that existed nowhere and it
        // refused to go away. With no FIFO holding it, there is no remote state a
        // local drop can contradict.
        expect(ok).toBe(true)
        expect(h.get().pendingLocalMessages).toHaveLength(0)
        expect(persisted()).toHaveLength(0)
        expect(h.get().sendFeedbackMessage).not.toBe(
            'Too late to cancel — this message was already sent to the agent.',
        )
    })

    it('★ still reports "too late" for a FRESH body — that one really did reach the agent', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_CANCEL_NOTHING_HELD)
        const h = renderHarness(send)
        await queueBodies(h, ['just drained'])
        const id = h.get().pendingLocalMessages[0].id

        let ok: boolean | undefined
        await act(async () => { ok = await h.get().handleCancelQueued(id) })

        // The queue drained while the owner was deciding: the agent HAS this body
        // and will answer it. Dropping the row here would be the original silent
        // delivery in a new disguise, so the bubble stays and the owner is told.
        expect(ok).toBe(false)
        expect(h.get().pendingLocalMessages).toHaveLength(1)
        expect(h.get().sendFeedbackMessage).toBe(
            'Too late to cancel — this message was already sent to the agent.',
        )
    })

    it('an ordinary successful cancel is unaffected', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce(DAEMON_QUEUED_RESULT)
            .mockResolvedValueOnce(DAEMON_CANCEL_OK)
        const h = renderHarness(send)
        await queueBodies(h, ['withdraw me'])
        const id = h.get().pendingLocalMessages[0].id

        let ok: boolean | undefined
        await act(async () => { ok = await h.get().handleCancelQueued(id) })

        expect(ok).toBe(true)
        expect(persisted()).toHaveLength(0)
    })

    it('★ a stale entry is NOT dropped when the daemon confirms it still holds one', async () => {
        const sentAt = Date.now() - PENDING_QUEUED_MESSAGE_STALE_AFTER_MS - 60_000
        writePendingQueuedMessages(TAB_KEY, [
            { id: 'old-but-real', content: 'genuinely parked', sentAt, queued: true } as any,
        ])
        // A long but REAL wait: the daemon still has it, and answers cancelled:1.
        const send = vi.fn().mockResolvedValue(DAEMON_CANCEL_OK)
        const h = renderHarness(send)

        await act(async () => { await h.get().handleCancelQueued('old-but-real') })

        // Dropped because the DAEMON confirmed the removal, not because it was old
        // — staleness only decides how `cancelled: 0` is read.
        expect(send).toHaveBeenCalledWith(
            expect.any(String),
            'cancel_queued_chat',
            expect.objectContaining({ message: 'genuinely parked' }),
        )
        expect(persisted()).toHaveLength(0)
    })
})

describe('the deployed fix cleans up what is already stuck', () => {
    it('★ an existing pinned row retires by echo on the next reload, with no manual clear', async () => {
        // The owner's live state: a row written by the pre-fix build, for a body
        // the agent did receive and answer, which nothing could ever retire.
        const sentAt = Date.now() - 30 * 60 * 1000
        writePendingQueuedMessages(TAB_KEY, [
            { id: 'stuck-1', content: 'the stuck message', sentAt, queued: true } as any,
        ])

        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)
        expect(h.get().pendingLocalMessages).toHaveLength(1)

        // The pane loads the transcript, which contains the owner's turn.
        act(() => { h.get().retireEchoedPendingMessages([userEcho('the stuck message')]) })

        expect(h.get().pendingLocalMessages).toHaveLength(0)
        expect(persisted()).toHaveLength(0)
    })

    it('★ and one whose body was DISCARDED resolves by age, since no echo will ever come', async () => {
        const sentAt = Date.now() - PENDING_QUEUED_MESSAGE_STALE_AFTER_MS - 60_000
        writePendingQueuedMessages(TAB_KEY, [
            { id: 'stuck-2', content: 'never delivered', sentAt, queued: true } as any,
        ])

        const send = vi.fn().mockResolvedValue(DAEMON_QUEUED_RESULT)
        const h = renderHarness(send)

        // The session was torn down mid-queue, so its transcript is empty and will
        // never move again. Age is the only signal left.
        act(() => { h.get().retireEchoedPendingMessages([]) })

        const row = h.get().pendingLocalMessages[0]
        expect(row.stale).toBe(true)
        // Still readable and still cancellable — the owner can resend it.
        expect(row.content).toBe('never delivered')
    })
})
