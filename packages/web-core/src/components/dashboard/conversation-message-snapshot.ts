import type { SessionChatTailSnapshot } from './session-chat-tail-controller'
import type { ActiveConversation, DashboardMessage } from './types'
import { getConversationDaemonRouteId } from './conversation-selectors'
import { getMessageTimestamp } from './message-utils'

export function getConversationMessageAuthorityKey(conversation: ActiveConversation): string {
    const daemonId = getConversationDaemonRouteId(conversation)
    const sessionId = conversation.sessionId || ''
    return daemonId && sessionId ? `${daemonId}::${sessionId}` : ''
}

export function getConversationLiveMessages(
    conversation: ActiveConversation,
    snapshot?: Pick<SessionChatTailSnapshot, 'liveMessages' | 'hasLiveSnapshot'> | null,
): DashboardMessage[] {
    if (snapshot?.hasLiveSnapshot) {
        // Once the session.chat_tail subscription has produced any snapshot, it is the
        // transcript authority for the pane. Do not fall back to conversation.messages
        // based on length: long CLI sessions intentionally send a bounded recent tail,
        // and the fallback can be stale/empty relative to the daemon parser. Older rows
        // are recovered through explicit history paging instead.
        return snapshot.liveMessages || []
    }
    return Array.isArray(conversation.messages) ? conversation.messages : []
}

/**
 * (OPTIMISTIC-USER-BUBBLE) A locally-appended user bubble, shown between the
 * moment the owner hits send and the moment the daemon's echo arrives.
 *
 * WHY: `send_chat` only resolves after a full round trip, and when the agent is
 * busy the daemon parks the body in a FIFO and answers `queued` — the echo then
 * lands whenever the queue drains (observed at 35.5s, unbounded in principle).
 * Until then the owner's own message was simply not on screen, which reads as
 * "my message was lost" and provokes a resend.
 */
export interface PendingLocalMessage {
    /**
     * Stable per-entry identity (MULTI-QUEUE). Optional so a caller holding a
     * legacy single entry still type-checks; `withPendingLocalMessages` falls
     * back to `sentAt` for the bubble id when it is absent.
     */
    id?: string
    /** Exact text submitted, used both to render and to match the echo. */
    content: string
    /** `Date.now()` at submit — orders the bubble and bounds its lifetime. */
    sentAt: number
    /** True when the daemon reported `queued` (parked, not yet written to the PTY). */
    queued?: boolean
}

/**
 * Upper bound on how long an unmatched optimistic bubble may linger.
 *
 * Not a correctness mechanism — the echo match below is. This only stops a
 * bubble whose echo never arrives at all (send failed after the daemon accepted
 * it, session torn down mid-queue) from being pinned to the pane forever. Set
 * well above the 35.5s queue drain actually observed, since dropping a real
 * pending message early is the worse failure.
 */
export const PENDING_LOCAL_MESSAGE_MAX_AGE_MS = 120_000

function normalizeForEchoMatch(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (value == null) return ''
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

/**
 * ★ DUPLICATE PREVENTION — the whole risk of the optimistic bubble.
 *
 * The daemon ALREADY renders the owner's bubble: `recordAcknowledgedUserInput`
 * (cli-provider-instance.ts) appends a `runtime_input_ack` user message and it
 * arrives through the normal transcript lane. So the optimistic bubble is a
 * *stand-in* for that echo, never an addition to it — if both rendered, the
 * owner would see their message twice, which is worse than seeing it late.
 *
 * The match is on trimmed CONTENT and role, deliberately, not on an id: the
 * client cannot know the id the daemon will mint, and the daemon's own 60s
 * dedup window (USER_INPUT_ACK_DEDUP_WINDOW_MS) is likewise content-keyed, so
 * content is the only identity the two sides share.
 *
 * Suppression is one-directional and conservative: ANY matching user bubble in
 * the live tail retires the pending one. A false match (the owner sent the same
 * text twice in quick succession) collapses to one bubble — the same behaviour
 * the daemon's own content-keyed window already produces for a redelivery, so
 * this does not introduce a new class of loss.
 */
export function hasEchoedPendingMessage(
    liveMessages: DashboardMessage[],
    pending: PendingLocalMessage,
): boolean {
    const target = pending.content.trim()
    if (!target) return true
    for (let i = liveMessages.length - 1; i >= 0; i -= 1) {
        const message = liveMessages[i]
        if (String(message.role || '').toLowerCase() !== 'user') continue
        if (normalizeForEchoMatch(message.content) === target) return true
    }
    return false
}

/**
 * How many live echoes match this body?
 *
 * MULTI-QUEUE needs a COUNT, not the boolean `hasEchoedPendingMessage` answers.
 * With several queued entries the owner can legitimately queue the same text
 * twice ("continue", "continue"); a boolean would let ONE echo retire BOTH
 * bubbles, hiding a body that is still parked in the daemon FIFO — reproducing
 * the very disappearance this change exists to fix, just one message later.
 * Counting lets each echo retire exactly one entry.
 */
function countEchoedMessages(liveMessages: DashboardMessage[], target: string): number {
    if (!target) return 0
    let count = 0
    for (const message of liveMessages) {
        if (String(message.role || '').toLowerCase() !== 'user') continue
        if (normalizeForEchoMatch(message.content) === target) count += 1
    }
    return count
}

function buildPendingBubble(pending: PendingLocalMessage): DashboardMessage {
    return {
        // Per-entry id so React keys stay unique across a multi-entry queue.
        // `sentAt` alone collided when two sends landed in the same millisecond.
        id: `pending-local:${pending.id || pending.sentAt}`,
        role: 'user',
        kind: 'standard',
        content: pending.content,
        senderName: 'User',
        timestamp: pending.sentAt,
        receivedAt: pending.sentAt,
        // Read by the renderer to show a "sending"/"queued" affordance. The
        // bubble is real text the owner typed, so it renders as a normal user
        // message; only the affordance distinguishes it. `pendingId` is what the
        // per-item Send now / Cancel handlers address.
        meta: {
            pendingLocal: true,
            queued: pending.queued === true,
            pendingId: pending.id || String(pending.sentAt),
        },
    } as unknown as DashboardMessage
}

/**
 * Append every still-waiting optimistic bubble to the END of the live tail.
 *
 * ★ BOTTOM PINNING is structural, not a scroll trick. These bubbles are appended
 * after `liveMessages`, and `buildVisibleConversationMessages` runs its
 * chronological sort BEFORE they are added — so nothing can reorder a waiting
 * message above delivered history. A queued body is, by definition, the newest
 * thing in the conversation until it is delivered, and it stays visible at the
 * bottom no matter where the owner has scrolled.
 *
 * Entries are emitted in FIFO order (oldest first), matching the daemon's own
 * drain order, so the displayed order is the delivery order.
 *
 * Returns the input array unchanged in every no-op case so React reference
 * equality still short-circuits renders on the common path.
 */
export function withPendingLocalMessages(
    liveMessages: DashboardMessage[],
    pending: readonly PendingLocalMessage[] | null | undefined,
    now: number = Date.now(),
): DashboardMessage[] {
    if (!pending || pending.length === 0) return liveMessages

    // Echo budget per distinct body: each live echo retires at most one entry.
    const echoBudget = new Map<string, number>()
    const bubbles: DashboardMessage[] = []

    for (const entry of pending) {
        const target = entry.content.trim()
        if (!target) continue
        if (now - entry.sentAt > PENDING_LOCAL_MESSAGE_MAX_AGE_MS) continue
        if (!echoBudget.has(target)) echoBudget.set(target, countEchoedMessages(liveMessages, target))
        const remaining = echoBudget.get(target) || 0
        if (remaining > 0) {
            // This entry is accounted for by an echo already on screen — retire it
            // rather than rendering the owner's message twice.
            echoBudget.set(target, remaining - 1)
            continue
        }
        bubbles.push(buildPendingBubble(entry))
    }

    if (bubbles.length === 0) return liveMessages
    return [...liveMessages, ...bubbles]
}

/**
 * Single-entry compatibility wrapper.
 *
 * Kept because the read-only share viewer and older call sites pass one entry,
 * and because the dedup contract documented above is easier to reason about in
 * its original one-message form.
 */
export function withPendingLocalMessage(
    liveMessages: DashboardMessage[],
    pending: PendingLocalMessage | null | undefined,
    now: number = Date.now(),
): DashboardMessage[] {
    if (!pending) return liveMessages
    return withPendingLocalMessages(liveMessages, [pending], now)
}

function isConversationAnchorMessage(message: DashboardMessage): boolean {
    const role = String(message.role || '').toLowerCase()
    if (role !== 'user' && role !== 'assistant') return false
    const kind = String((message as { kind?: unknown }).kind || 'standard').toLowerCase()
    return kind === '' || kind === 'standard'
}

function conversationAnchorRole(message: DashboardMessage): 'user' | 'assistant' | '' {
    if (!isConversationAnchorMessage(message)) return ''
    return String(message.role || '').toLowerCase() as 'user' | 'assistant'
}

/**
 * (ANTIGRAVITY-TAIL-USER-ONLY + CHAT-ASSISTANT-ANCHOR-PRESERVE) Keep the LATEST
 * substantive assistant answer pinned into the initial live window whenever the raw
 * tail slice buried it.
 *
 * The visible window is `liveMessages.slice(-visibleLiveCount)` — a RAW count that
 * spends its budget on EVERY bubble, including non-substantive tool/thought/system
 * activity rows that `ChatMessageList` later hides. A MAGI coordinator emits dozens
 * of such activity bubbles per turn, so the last-N window can be almost entirely
 * activity + a trailing `user` dispatch echo, with the actual `assistant` answer
 * pushed just above the window into `hiddenLiveMessages`.
 *
 * The reported flicker: in a LONG conversation, sending a user prompt appends the
 * user echo plus a burst of hidden activity bubbles. That burst shifts the raw
 * slice window forward, pushing the just-finished substantive assistant answer out
 * of the visible tail into `hiddenLiveMessages` — while the fresh trailing user echo
 * stays near the tail and remains visible. The result is a role-selective drop: the
 * user bubble stays, the assistant bubble vanishes for a beat.
 *
 * INVARIANT (CHAT-ASSISTANT-ANCHOR-PRESERVE): the newest substantive assistant answer
 * must be inside the visible window whenever the live tail carries one, so it never
 * drops for even one frame when a user-send activity flood shifts the raw slice. This
 * is decided by POSITION, not by "does the window contain any assistant": `liveMessages`
 * is chronological ascending and the window is the newest suffix (`slice(-N)`), so
 * `hiddenLiveMessages` is strictly older than `visibleLiveMessages`. Therefore the
 * newest assistant is visible IFF the visible slice contains ANY assistant — an older
 * hidden assistant can never be newer than a visible one. We rescue exactly when the
 * visible slice has NO assistant while the hidden tail does: pull the freshest hidden
 * assistant — plus the user turn that prompted it, when that user isn't already visible
 * — forward in order at build time, assembling the correct window in one pass. Bounded
 * to a few substantive bubbles so it can never unbound-grow the initial render.
 */
const MAX_RESCUED_ANCHOR_MESSAGES = 4

function getConversationAnchorMessages(
    hiddenLiveMessages: DashboardMessage[],
    visibleLiveMessages: DashboardMessage[],
): DashboardMessage[] {
    if (hiddenLiveMessages.length === 0) return []

    // Locate the newest substantive assistant answer in the FULL live tail. Since
    // `hiddenLiveMessages` positionally precedes `visibleLiveMessages`, the newest
    // assistant across both is: the last assistant in the visible slice if one exists,
    // otherwise the last assistant in the hidden tail.
    for (let i = visibleLiveMessages.length - 1; i >= 0; i -= 1) {
        if (conversationAnchorRole(visibleLiveMessages[i]) === 'assistant') {
            // The freshest assistant answer is already inside the visible window, so
            // the raw slice preserved it — nothing to pin.
            return []
        }
    }

    const visibleUserVisible = visibleLiveMessages.some(
        message => conversationAnchorRole(message) === 'user',
    )

    // No substantive assistant answer is inside the visible window while the freshest
    // one sits just above it in the hidden tail — the exact role-selective drop that
    // an activity flood on user-send produces (user echo stays, assistant answer is
    // pushed out). Walk the hidden tail newest→oldest to that answer and pull it —
    // plus the user turn that prompted it, unless that user is already visible —
    // forward in order at build time, so the assistant bubble never drops for even one
    // frame. Bounded by the cap so the initial render stays small even on a
    // pathological hidden tail.
    const rescued: DashboardMessage[] = []
    let capturedAssistant = false
    for (let i = hiddenLiveMessages.length - 1; i >= 0 && rescued.length < MAX_RESCUED_ANCHOR_MESSAGES; i -= 1) {
        const message = hiddenLiveMessages[i]
        const role = conversationAnchorRole(message)
        if (!role) continue
        if (!capturedAssistant && role === 'assistant') {
            rescued.unshift(message)
            capturedAssistant = true
            continue
        }
        if (capturedAssistant && role === 'user') {
            // Preceding user prompt for the rescued answer — include it for pairing
            // unless the visible window already shows a user bubble.
            if (!visibleUserVisible) rescued.unshift(message)
            break
        }
    }
    return rescued
}

/**
 * Order the already-selected visible set chronologically.
 *
 * The history + live window are assembled by POSITIONAL concatenation
 * (`[...historyMessages, ...liveWindow]`), which renders as "all history, then
 * all live". For native-history sessions (antigravity/MAGI) the assistant answer
 * for the current turn lives in `historyMessages` while the user's dispatch echo
 * lives in `liveMessages`; positional order then buries that assistant turn above
 * the initial window, so the pane opens showing only the user prompt in scrambled
 * order until "Load older". Re-sort the combined set by message time so render
 * order follows chronology regardless of which source a bubble came from.
 *
 * This ONLY reorders the already-selected messages — the window/slice/anchor
 * selection above is untouched. The sort is total and STABLE: the primary key is
 * `getMessageTimestamp` (the same `receivedAt || timestamp` accessor ChatPane uses
 * for its receivedAt map), and the original array index is an explicit tie-break so
 * messages sharing a timestamp — or carrying none (key 0) — keep their original
 * relative order instead of being reordered or dropped.
 */
function sortMessagesChronologically(messages: DashboardMessage[]): DashboardMessage[] {
    // Fast path: the input is ALREADY in the exact order this sort produces, so
    // return the same array reference and let downstream `useMemo`/memo
    // comparisons short-circuit on reference equality instead of diffing a
    // freshly allocated array with identical contents. The common live-tail case
    // (chronological daemon transcript, no native-history interleave) hits this.
    //
    // Semantics are preserved exactly: the comparator's keys are (timestamp,
    // original index), so a non-descending timestamp sequence is already at its
    // unique sorted position under that stable tie-break — the sort would return
    // these same messages in this same order. Note `>` (not `>=`): equal
    // timestamps are ordered by original index, which ascending input satisfies.
    let isSorted = true
    for (let i = 1; i < messages.length; i += 1) {
        if (getMessageTimestamp(messages[i - 1]) > getMessageTimestamp(messages[i])) {
            isSorted = false
            break
        }
    }
    if (isSorted) return messages
    return messages
        .map((message, index) => ({ message, index, ts: getMessageTimestamp(message) }))
        .sort((a, b) => (a.ts - b.ts) || (a.index - b.index))
        .map(entry => entry.message)
}

export function buildVisibleConversationMessages(options: {
    historyMessages: DashboardMessage[]
    liveMessages: DashboardMessage[]
    visibleLiveCount: number
}): DashboardMessage[] {
    const { historyMessages, liveMessages, visibleLiveCount } = options
    const hiddenLiveCount = Math.max(0, liveMessages.length - visibleLiveCount)
    const hiddenLiveMessages = hiddenLiveCount > 0
        ? liveMessages.slice(0, hiddenLiveCount)
        : []
    const visibleLiveMessages = hiddenLiveCount > 0
        ? liveMessages.slice(-visibleLiveCount)
        : liveMessages
    const anchorMessages = getConversationAnchorMessages(hiddenLiveMessages, visibleLiveMessages)
    const liveWindow = anchorMessages.length > 0
        ? [...anchorMessages, ...visibleLiveMessages]
        : visibleLiveMessages
    const combined = historyMessages.length === 0
        ? liveWindow
        : [...historyMessages, ...liveWindow]
    return sortMessagesChronologically(combined)
}
