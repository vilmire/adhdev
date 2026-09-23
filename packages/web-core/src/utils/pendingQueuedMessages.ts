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
 *
 * ─── Wiring-unification Phase D-web (docs/design/2026-09-23-wiring-unification.md
 * §6 D4) ───
 *
 * `id` is now the literal `OutboundMessage.messageId` sent over the wire (see
 * `@adhdev/mesh-shared`'s `outbound-message.ts`), not a purely local key — a
 * comment further down used to say "it is never sent anywhere and the daemon
 * never sees it"; that is corrected where it appears below.
 *
 * `content` stays the primary field (every existing consumer outside this
 * workstream — `PendingQueueStrip.tsx`, the bubble renderers — reads it
 * directly and is out of scope here). `input`, added below, is the richer
 * `InputEnvelope` (attachments included) that `send-now` needs to resubmit
 * the EXACT same body policy `queue`→`send_now` requires (§4.3 of the plan):
 * re-deriving a structured envelope from `content` alone would lose any
 * attachment, which is the "triple-bubble" class of bug the design doc's D
 * section exists to close. `content` and `input.textFallback` are kept equal
 * by construction (`sanitizeEntries` below derives one from the other).
 */

const PENDING_QUEUED_MESSAGES_KEY = 'adhdev-pending-queued-messages-v1'

/**
 * Cap on how many bytes of attachment `data` (base64) one entry may carry in
 * the persisted `input.parts`. localStorage is typically quota-limited to a
 * few MB per origin shared across every key this app uses, and an owner
 * queuing several image sends to a busy agent could otherwise blow that
 * quota silently (writes are best-effort — see `writeStore` — so the failure
 * mode would be "the store silently stops updating", not a visible error).
 *
 * Beyond this cap the entry's `input` keeps its text parts (cheap, and
 * needed for `content`/display) but drops attachment `data`, replacing each
 * oversized part with `{omitted: true, partTypes}` (see `OmittedInputParts`)
 * so a restart still shows the truth: "you sent an image here, it was too
 * large to keep across a reload, send-now will fall back to text-only for
 * this entry until it is naturally retired by echo or staleness."
 */
export const PENDING_QUEUED_MESSAGE_MAX_INPUT_BYTES = 256 * 1024

/** One non-text input part, reduced to what fits under the size cap. */
export interface PendingInputPart {
    type: string
    text?: string
    mimeType?: string
    uri?: string
    /** base64 payload — present only when the whole entry is under the cap. */
    data?: string
    alt?: string
}

/**
 * The structured body of a pending entry. Optional on `PendingQueuedMessage`
 * so an entry restored from a pre-D4 store (which only ever wrote `content`)
 * still reads correctly — see `sanitizeEntries`'s migration branch.
 */
export interface PendingInputEnvelope {
    parts: PendingInputPart[]
    textFallback: string
    /**
     * Present only when one or more attachment parts were dropped for size.
     * `partTypes` names what was omitted (e.g. `['image']`) so a restored
     * row can say what it lost instead of silently rendering as text-only.
     */
    omitted?: { omitted: true; partTypes: string[] }
}

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
    /**
     * (Phase D-web) The full structured body, attachments included, when the
     * send carried one. Optional — a text-only send has no reason to carry a
     * second copy of `content` wrapped in an envelope, and a row restored
     * from a pre-D4 store never had one. When present, `input.textFallback`
     * always equals `content` (kept in sync by `sanitizeEntries`); send-now
     * (§4.3) resubmits `input` when present, `content` otherwise — so an
     * old-format restored row degrades to a text-only resend rather than
     * failing outright.
     */
    input?: PendingInputEnvelope
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
 * Reduce a candidate `input` envelope to what is safe to persist: text parts
 * pass through unchanged (cheap, and needed for display/matching), and
 * attachment `data` is kept only while the running byte total across the
 * entry's parts stays under `PENDING_QUEUED_MESSAGE_MAX_INPUT_BYTES`. Once
 * the cap is crossed, every remaining non-text part is replaced by a bare
 * `{type, mimeType?}` marker and the envelope is flagged `omitted` so a
 * restored row can say what it lost instead of silently degrading.
 *
 * Returns `undefined` for anything that does not look like an envelope at
 * all (`sanitizeEntries` falls back to deriving a text-only one from
 * `content` in that case — the pre-D4 migration path).
 */
function capPendingInputEnvelope(raw: unknown, fallbackText: string): PendingInputEnvelope | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const candidate = raw as { parts?: unknown; textFallback?: unknown; omitted?: unknown }
    if (!Array.isArray(candidate.parts)) return undefined

    let usedBytes = 0
    // ★ IDEMPOTENCY: this function runs on every read AND every write (both go
    // through `sanitizeEntries`), so an entry already capped on a previous pass
    // arrives here with its oversized parts' `data` already stripped. Without
    // seeding from an existing `omitted` marker, the second pass would see
    // "no data on this part" and take the harmless-looking `!data` branch,
    // silently DROPPING the marker it had just set — the restored row would
    // then claim nothing was ever omitted, which is a lie the owner has no way
    // to detect. Carrying the prior marker's `partTypes` forward makes the
    // capping stable under repeated application.
    const omittedTypes = new Set<string>(
        candidate.omitted && typeof candidate.omitted === 'object' && Array.isArray((candidate.omitted as { partTypes?: unknown }).partTypes)
            ? ((candidate.omitted as { partTypes: unknown[] }).partTypes.filter((t): t is string => typeof t === 'string'))
            : [],
    )
    const parts: PendingInputPart[] = []
    for (const rawPart of candidate.parts) {
        if (!rawPart || typeof rawPart !== 'object') continue
        const part = rawPart as Record<string, unknown>
        const type = typeof part.type === 'string' ? part.type : ''
        if (!type) continue
        if (type === 'text') {
            parts.push({ type: 'text', text: typeof part.text === 'string' ? part.text : '' })
            continue
        }
        const data = typeof part.data === 'string' ? part.data : undefined
        const dataBytes = data ? data.length : 0
        if (data && usedBytes + dataBytes <= PENDING_QUEUED_MESSAGE_MAX_INPUT_BYTES) {
            usedBytes += dataBytes
            parts.push({
                type,
                mimeType: typeof part.mimeType === 'string' ? part.mimeType : undefined,
                uri: typeof part.uri === 'string' ? part.uri : undefined,
                data,
                alt: typeof part.alt === 'string' ? part.alt : undefined,
            })
            continue
        }
        // Over budget (or the part carried a `uri` instead of inline `data`,
        // which is small and fine to keep, minus the payload we cannot afford):
        // keep the part's identity, drop the payload.
        if (!data) {
            parts.push({
                type,
                mimeType: typeof part.mimeType === 'string' ? part.mimeType : undefined,
                uri: typeof part.uri === 'string' ? part.uri : undefined,
                alt: typeof part.alt === 'string' ? part.alt : undefined,
            })
            continue
        }
        omittedTypes.add(type)
        parts.push({
            type,
            mimeType: typeof part.mimeType === 'string' ? part.mimeType : undefined,
            alt: typeof part.alt === 'string' ? part.alt : undefined,
        })
    }

    const textFallback = typeof candidate.textFallback === 'string' ? candidate.textFallback : fallbackText
    return {
        parts,
        textFallback,
        ...(omittedTypes.size > 0 ? { omitted: { omitted: true, partTypes: [...omittedTypes] } } : {}),
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
        // (Phase D-web migration) An entry written by a pre-D4 build has only
        // ever had `content` — no `input` key exists in its stored JSON. Cap
        // whatever IS present; `capPendingInputEnvelope` returns `undefined`
        // for a missing/malformed `input`, and the field is simply omitted —
        // that IS the migration, not a separate code path, because a missing
        // `input` was already the documented "degrade to text-only" case
        // (§4.1's `PendingQueuedMessage.input` doc comment).
        const input = capPendingInputEnvelope(candidate.input, content)
        entries.push({
            entry: {
                id,
                content,
                sentAt,
                queued: candidate.queued === true,
                settled: true,
                stale,
                ...(input ? { input } : {}),
            },
            index,
        })
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
 * `crypto.randomUUID` where available; otherwise a timestamp+counter fallback.
 *
 * ★ (Phase D-web, 2026-09-23) CORRECTION to this comment's previous claim: this
 * id is no longer purely local. `useDashboardConversationCommands.ts` passes it
 * as the `send_chat` command's `messageId` field — the same identifier
 * `@adhdev/mesh-shared`'s `OutboundMessage.messageId` names — so the daemon
 * DOES see it now, and it is what a daemon build past Phase D-daemon will use
 * to key its own send queue instead of matching by text. It still only has to
 * be unique within one browser tab's store, which `crypto.randomUUID` and the
 * fallback both satisfy; nothing about minting changed, only what happens to
 * the value afterward.
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
