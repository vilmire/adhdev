import type { SessionChatTailSnapshot } from './session-chat-tail-controller'
import type { ActiveConversation, DashboardMessage } from './types'
import { getConversationDaemonRouteId } from './conversation-selectors'
import { getMessageTimestamp } from './message-utils'
import { normalizeTextContent } from '../../utils/text'

function buildChatSnapshotSignature(messages: DashboardMessage[], status?: string): string {
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage) return `empty:${status || ''}`

    let content = ''
    try {
        content = JSON.stringify(lastMessage.content ?? '')
    } catch {
        content = String(lastMessage.content ?? '')
    }

    return [
        status || '',
        messages.length,
        String(lastMessage.id || ''),
        String(lastMessage.index ?? ''),
        String(lastMessage.receivedAt ?? lastMessage.timestamp ?? ''),
        content,
    ].join('|')
}

function getLatestMessageTimestamp(messages: DashboardMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const ts = getMessageTimestamp(messages[i])
        if (ts > 0) return ts
    }
    return 0
}

export function getConversationMessageAuthorityKey(conversation: ActiveConversation): string {
    const daemonId = getConversationDaemonRouteId(conversation)
    const sessionId = conversation.sessionId || ''
    return daemonId && sessionId ? `${daemonId}::${sessionId}` : ''
}

function shouldOverlayWarmLiveMessages(conversation: ActiveConversation, liveMessages: DashboardMessage[]): boolean {
    if (liveMessages.length === 0) return false
    const existingMessages = Array.isArray(conversation.messages) ? conversation.messages : []
    if (existingMessages.length === 0) return true

    const existingAt = getLatestMessageTimestamp(existingMessages)
    const liveAt = getLatestMessageTimestamp(liveMessages)
    if (existingAt > 0 && liveAt > 0 && liveAt < existingAt) return false

    const existingSignature = buildChatSnapshotSignature(existingMessages, conversation.status)
    const liveSignature = buildChatSnapshotSignature(liveMessages, conversation.status)
    return existingSignature !== liveSignature
}

function overlayConversationMessages(
    conversation: ActiveConversation,
    liveMessages: DashboardMessage[],
): ActiveConversation {
    const lastLiveMessage = liveMessages[liveMessages.length - 1]
    const lastLiveMessageAt = getMessageTimestamp(lastLiveMessage)
    const lastLiveMessagePreview = normalizeTextContent(lastLiveMessage?.content)
    return {
        ...conversation,
        messages: liveMessages,
        ...(lastLiveMessagePreview ? { lastMessagePreview: lastLiveMessagePreview } : {}),
        ...(lastLiveMessageAt > 0 ? { lastMessageAt: lastLiveMessageAt } : {}),
    }
}

export function getConversationLiveMessages(
    conversation: ActiveConversation,
    snapshot?: Pick<SessionChatTailSnapshot, 'liveMessages'> | null,
): DashboardMessage[] {
    const snapshotMessages = snapshot?.liveMessages || []
    return snapshotMessages.length > 0 ? snapshotMessages : conversation.messages
}

export function buildVisibleConversationMessages(options: {
    historyMessages: DashboardMessage[]
    liveMessages: DashboardMessage[]
    visibleLiveCount: number
}): DashboardMessage[] {
    const { historyMessages, liveMessages, visibleLiveCount } = options
    const hiddenLiveCount = Math.max(0, liveMessages.length - visibleLiveCount)
    const visibleLiveMessages = hiddenLiveCount > 0
        ? liveMessages.slice(-visibleLiveCount)
        : liveMessages
    return historyMessages.length === 0
        ? visibleLiveMessages
        : [...historyMessages, ...visibleLiveMessages]
}

export function applyConversationMessageSnapshots(
    conversations: ActiveConversation[],
    snapshots: Map<string, SessionChatTailSnapshot>,
): ActiveConversation[] {
    if (snapshots.size === 0 || conversations.length === 0) return conversations

    let changed = false
    const merged = conversations.map((conversation) => {
        const key = getConversationMessageAuthorityKey(conversation)
        if (!key) return conversation
        const liveMessages = snapshots.get(key)?.liveMessages || []
        if (!shouldOverlayWarmLiveMessages(conversation, liveMessages)) return conversation
        changed = true
        return overlayConversationMessages(conversation, liveMessages)
    })

    return changed ? merged : conversations
}
