/**
 * (QUEUED-SEND-RESTART-LOSS) Durable store for the owner's PARKED chat bodies.
 *
 * ★ WHAT WAS ACTUALLY BROKEN — the body was never lost, the UI's memory of it was.
 *
 * When the agent is busy the daemon parks the body in `FsmDriver.pendingSends`
 * (a real FIFO array, in the daemon process) and answers `{queued:true}`. That
 * FIFO drains on its own and the message IS eventually delivered. But the
 * dashboard rendered the waiting bubble from `useState<PendingLocalMessage>` —
 * pure React memory — and the daemon never reports queue depth back to any
 * surface. So reloading the dashboard erased every trace of the wait: the owner
 * saw their message simply gone while it was still sitting in the daemon queue,
 * which reads as "my message was lost" and provokes a resend.
 *
 * ★ WHY localStorage and NOT the server.
 *
 * These bodies are chat content the OWNER TYPED. `CLAUDE.md`'s server content
 * boundary is explicit that the status path carries no user chat content, and
 * the two standing exceptions (approval-modal text for push actionability,
 * Beacon's topic-name keys) are both narrow and both were decided deliberately.
 * Persisting drafts server-side would open a third, far wider hole — the full
 * body of arbitrary user prompts — for a purely local presentation concern.
 * localStorage keeps the text on the machine that typed it and travels through
 * no transport at all, so this change cannot touch that boundary.
 *
 * ★ Why not sessionStorage: the reported case is closing and reopening the app,
 * which is exactly what sessionStorage does not survive.
 */

const PENDING_QUEUED_MESSAGES_KEY = 'adhdev-pending-queued-messages-v1'

/**
 * Per-conversation cap. The daemon's own FIFO is unbounded, but a runaway local
 * store would be a silent quota leak, and a queue this deep is already a
 * pathological state the owner should see and clear rather than accumulate.
 */
export const MAX_PENDING_QUEUED_MESSAGES = 20

/**
 * Upper bound on how long a persisted entry may survive.
 *
 * Restart persistence has no echo-matching until the pane remounts and the
 * transcript loads, so a body whose delivery we never observed would otherwise
 * be pinned forever. A day is far above any plausible queue drain while still
 * guaranteeing the store self-empties.
 */
export const PENDING_QUEUED_MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * (QUEUED-SEND-STUCK-FOREVER) How long a body may wait before the UI stops
 * claiming it is still going to be delivered.
 *
 * ★ Defined HERE, in the dependency-free leaf, and re-exported from
 * `conversation-message-snapshot` — not the other way round. This module is
 * imported by that one, so owning the constant in the component module would
 * point the dependency backwards (util → components) just to share a number.
 *
 * See the re-export site for why the threshold exists and why it is an order of
 * magnitude below the 24h store bound above.
 */
export const PENDING_QUEUED_MESSAGE_STALE_AFTER_MS = 10 * 60 * 1000

export interface PendingQueuedMessage {
    /**
     * Stable per-entry identity, minted at submit.
     *
     * ★ Required for MULTI-QUEUE. The pre-existing single-slot state keyed the
     * bubble by `sentAt` alone; with several entries in flight that is both a
     * collision risk (two sends inside the same millisecond) and useless as a
     * React key. Per-item Send now / Cancel both address an entry by this id, so
     * acting on the second queued message can never hit the first.
     */
    id: string
    /** Exact text submitted — used to render, to match the echo, and to cancel. */
    content: string
    /** `Date.now()` at submit. Orders the queue (FIFO) and bounds its lifetime. */
    sentAt: number
    /** True once the daemon answered `queued` (parked, not yet written to the PTY). */
    queued?: boolean
    /**
     * (QUEUED-SEND-STUCK-FOREVER) True once the body waited past
     * `PENDING_QUEUED_MESSAGE_STALE_AFTER_MS` without the daemon echoing it back.
     *
     * ★ PERSISTED, unlike `settled`. The two look similar and must not be
     * conflated: `settled` describes a live `send_chat` promise, which cannot
     * survive a reload, so it is forced true on read. `stale` describes the
     * BODY's history — how long it has gone undelivered — which is exactly what
     * does survive a reload, and is the whole reason a restored row can be shown
     * honestly instead of being re-announced as freshly waiting.
     */
    stale?: boolean
    /**
     * (CANCEL-INFLIGHT-LEAK) True once the `send_chat` round trip has RESOLVED —
     * whichever way it went. False/absent means the outcome is still unknown.
     *
     * ★ Why `queued` alone cannot answer "is anything parked daemon-side?".
     *
     * `queued` is only set AFTER the round trip answers. Before that it is
     * falsy for two states that demand opposite handling: a send that already
     * failed (nothing parked — a local drop is correct) and a send still in
     * flight (the daemon may be parking the body right now). Cancelling on the
     * second one used to drop the bubble locally and issue no command at all,
     * so the daemon kept the body, drained it minutes later, and the agent
     * answered a message the owner had watched disappear — the owner's
     * "취소한거까지 같이 감" report. Queueing happens exactly when the owner is
     * firing messages at a busy agent, and Cancel sits inside that bubble, so
     * the window is small but routinely hit.
     *
     * Not persisted as `true` by default on read: an entry restored from a
     * previous page load can have no round trip outstanding in THIS one, so
     * `sanitizeEntries` settles it — an unsettled flag would otherwise survive
     * a reload forever and force a daemon call for a body nothing is tracking.
     */
    settled?: boolean
}

interface PendingQueuedMessagesStore {
    byKey: Record<string, PendingQueuedMessage[]>
}

function readStore(): PendingQueuedMessagesStore {
    if (typeof window === 'undefined') return { byKey: {} }
    try {
        const parsed = JSON.parse(
            window.localStorage.getItem(PENDING_QUEUED_MESSAGES_KEY) || '{}',
        ) as Partial<PendingQueuedMessagesStore>
        return { byKey: parsed.byKey && typeof parsed.byKey === 'object' ? parsed.byKey : {} }
    } catch {
        return { byKey: {} }
    }
}

function writeStore(store: PendingQueuedMessagesStore): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(PENDING_QUEUED_MESSAGES_KEY, JSON.stringify(store))
    } catch {
        /* quota / private mode — persistence is best-effort, never a send blocker */
    }
}

/**
 * Drop malformed and expired rows.
 *
 * Applied on every read as well as every write, so a store written by an older
 * build (or hand-edited) can never crash the pane or resurrect an ancient body.
 */
function sanitizeEntries(raw: unknown, now: number): PendingQueuedMessage[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const entries: { entry: PendingQueuedMessage; index: number }[] = []
    let index = 0
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const candidate = item as Partial<PendingQueuedMessage>
        const content = typeof candidate.content === 'string' ? candidate.content : ''
        const sentAt = typeof candidate.sentAt === 'number' && Number.isFinite(candidate.sentAt)
            ? candidate.sentAt
            : 0
        const id = typeof candidate.id === 'string' && candidate.id ? candidate.id : ''
        if (!content.trim() || !sentAt || !id) continue
        if (now - sentAt > PENDING_QUEUED_MESSAGE_MAX_AGE_MS) continue
        if (seen.has(id)) continue
        seen.add(id)
        // `settled: true` on every restored row. The in-flight state it guards
        // is a property of a live `send_chat` promise, and no promise survives a
        // reload — a row read back from the store has no round trip pending by
        // construction, whatever the tab that wrote it was doing at the time.
        // ★ (QUEUED-SEND-STUCK-FOREVER) Staleness is DERIVED on read, not merely
        // carried. A row restored from a previous session has by definition been
        // waiting since `sentAt`, and the tab that wrote it is gone — so nothing
        // else will ever mark it. Deriving here is what makes an already-pinned
        // body honest the instant the pane mounts, rather than announcing it as
        // freshly "waiting to send" and then correcting itself once a transcript
        // arrives (which, for a torn-down session, it may never do).
        const stale = candidate.stale === true || (now - sentAt > PENDING_QUEUED_MESSAGE_STALE_AFTER_MS)
        entries.push({ entry: { id, content, sentAt, queued: candidate.queued === true, settled: true, stale }, index })
        index += 1
    }
    // FIFO: oldest first, matching the daemon's own drain order so the rendered
    // order is the order the bodies will actually be delivered in.
    //
    // ★ The tie-break is ARRAY POSITION, not the id. Two sends inside the same
    // millisecond share a `sentAt` — common, since queueing happens exactly when
    // the user is firing messages at a busy agent — and ids are random UUIDs, so
    // breaking ties by id sorts same-millisecond entries into random order and
    // silently scrambles the queue across a reload. Position is the only key
    // that carries the real insertion order.
    entries.sort((a, b) => (a.entry.sentAt - b.entry.sentAt) || (a.index - b.index))
    return entries.map(e => e.entry).slice(-MAX_PENDING_QUEUED_MESSAGES)
}

/**
 * Mint an entry id.
 *
 * `crypto.randomUUID` where available; otherwise a timestamp+counter fallback,
 * because the id only has to be unique within one browser's store — it is never
 * sent anywhere and the daemon never sees it.
 */
let idCounter = 0
export function createPendingQueuedMessageId(now: number = Date.now()): string {
    try {
        const cryptoRef = (typeof globalThis !== 'undefined' ? globalThis.crypto : undefined) as
            | { randomUUID?: () => string }
            | undefined
        if (typeof cryptoRef?.randomUUID === 'function') return cryptoRef.randomUUID()
    } catch {
        /* fall through */
    }
    idCounter += 1
    return `pq-${now}-${idCounter}`
}

export function readPendingQueuedMessages(
    storeKey: string,
    now: number = Date.now(),
): PendingQueuedMessage[] {
    const key = String(storeKey || '').trim()
    if (!key) return []
    return sanitizeEntries(readStore().byKey[key], now)
}

/**
 * Replace one conversation's queue wholesale.
 *
 * The hook owns the array and treats React state as the authority, so writes are
 * whole-list rather than incremental — that keeps the persisted copy and the
 * rendered copy from drifting apart, which is the failure mode that produced
 * this defect in the first place.
 */
export function writePendingQueuedMessages(
    storeKey: string,
    entries: PendingQueuedMessage[],
    now: number = Date.now(),
): void {
    const key = String(storeKey || '').trim()
    if (!key) return
    const store = readStore()
    const sanitized = sanitizeEntries(entries, now)
    if (sanitized.length > 0) {
        store.byKey[key] = sanitized
    } else {
        // Never leave an empty array behind: an emptied conversation should stop
        // occupying the store at all.
        delete store.byKey[key]
    }
    writeStore(store)
}

/** Drop every persisted queue whose newest entry has aged out. Cheap store hygiene. */
export function prunePendingQueuedMessages(now: number = Date.now()): void {
    const store = readStore()
    let changed = false
    for (const key of Object.keys(store.byKey)) {
        const sanitized = sanitizeEntries(store.byKey[key], now)
        if (sanitized.length === 0) {
            delete store.byKey[key]
            changed = true
        } else if (sanitized.length !== (store.byKey[key] || []).length) {
            store.byKey[key] = sanitized
            changed = true
        }
    }
    if (changed) writeStore(store)
}
