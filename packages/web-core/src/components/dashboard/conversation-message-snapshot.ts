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
 * (ANTIGRAVITY-TAIL-USER-ONLY) Pull the latest assistant answer back into the
 * initial live window when the raw tail slice buried it.
 *
 * The visible window is `liveMessages.slice(-visibleLiveCount)` — a RAW count that
 * spends its budget on EVERY bubble, including non-substantive tool/thought/system
 * activity rows that `ChatMessageList` later hides. A MAGI coordinator emits dozens
 * of such activity bubbles per turn, so the last-N window can be almost entirely
 * activity + a trailing `user` dispatch echo, with the actual `assistant` answer
 * pushed just above the window into `hiddenLiveMessages`. The user then sees ONLY
 * their prompt until they click "Load older".
 *
 * The old guard bailed the moment the visible window contained ANY anchor — and a
 * trailing `user` bubble IS an anchor — so it never rescued the stranded assistant.
 * We instead rescue specifically when the visible window shows NO substantive
 * ASSISTANT answer while the hidden tail does: walk the hidden tail newest→oldest
 * to the most recent assistant answer and pull it (plus the user turn that prompted
 * it, when that user isn't already visible) forward, in order. This is deliberately
 * asymmetric — a window that already shows the assistant answer but hides an OLDER
 * user prompt is a legitimately-scrolled-back state, not the reported bug, and is
 * left untouched (the user recovers it via "Load older"). Bounded to a few
 * substantive bubbles so it can never unbound-grow the initial render.
 */
const MAX_RESCUED_ANCHOR_MESSAGES = 4

function getConversationAnchorMessages(
    hiddenLiveMessages: DashboardMessage[],
    visibleLiveMessages: DashboardMessage[],
): DashboardMessage[] {
    if (hiddenLiveMessages.length === 0) return []

    const visibleRoles = new Set<string>()
    for (const message of visibleLiveMessages) {
        const role = conversationAnchorRole(message)
        if (role) visibleRoles.add(role)
    }
    // Only rescue the user-only failure mode: the visible window is missing the
    // substantive assistant ANSWER. If the assistant answer is already on screen,
    // leave the window as-is (a hidden older user prompt is normal back-scroll).
    if (visibleRoles.has('assistant')) return []

    // Walk the hidden tail newest→oldest to the most recent assistant answer,
    // pulling it — and the user turn that prompted it, unless that user is already
    // visible — forward in order. Bounded by the cap so the initial render stays
    // small even on a pathological hidden tail.
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
            if (!visibleRoles.has('user')) rescued.unshift(message)
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
