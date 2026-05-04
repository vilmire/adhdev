import type { SessionChatTailSnapshot } from './session-chat-tail-controller'
import type { ActiveConversation, DashboardMessage } from './types'
import { getConversationDaemonRouteId } from './conversation-selectors'

export function getConversationMessageAuthorityKey(conversation: ActiveConversation): string {
    const daemonId = getConversationDaemonRouteId(conversation)
    const sessionId = conversation.sessionId || ''
    return daemonId && sessionId ? `${daemonId}::${sessionId}` : ''
}

export function getConversationLiveMessages(
    conversation: ActiveConversation,
    snapshot?: Pick<SessionChatTailSnapshot, 'liveMessages'> | null,
): DashboardMessage[] {
    if (snapshot) return snapshot.liveMessages || []
    return Array.isArray(conversation.messages) ? conversation.messages : []
}

function isConversationAnchorMessage(message: DashboardMessage): boolean {
    const role = String(message.role || '').toLowerCase()
    if (role !== 'user' && role !== 'assistant') return false
    const kind = String((message as { kind?: unknown }).kind || 'standard').toLowerCase()
    return kind === '' || kind === 'standard'
}

function getConversationAnchorMessages(
    hiddenLiveMessages: DashboardMessage[],
    visibleLiveMessages: DashboardMessage[],
): DashboardMessage[] {
    if (hiddenLiveMessages.length === 0) return []
    if (visibleLiveMessages.some(isConversationAnchorMessage)) return []

    const anchors: DashboardMessage[] = []
    const seenRoles = new Set<string>()
    for (let i = hiddenLiveMessages.length - 1; i >= 0 && anchors.length < 2; i -= 1) {
        const message = hiddenLiveMessages[i]
        if (!message || !isConversationAnchorMessage(message)) continue
        const role = String(message.role || '').toLowerCase()
        if (seenRoles.has(role)) continue
        seenRoles.add(role)
        anchors.unshift(message)
    }
    return anchors
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
    return historyMessages.length === 0
        ? liveWindow
        : [...historyMessages, ...liveWindow]
}
