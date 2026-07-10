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
