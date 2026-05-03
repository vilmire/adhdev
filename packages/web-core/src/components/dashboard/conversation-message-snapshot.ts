import type { SessionChatTailSnapshot } from './session-chat-tail-controller'
import type { ActiveConversation, DashboardMessage } from './types'
import { getConversationDaemonRouteId } from './conversation-selectors'
import { getLiveMessageUpdateKeys, getMessageTimestamp } from './message-utils'
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

function hasDuplicateLiveMessageUpdateKeys(messages: DashboardMessage[]): boolean {
    const seen = new Set<string>()
    for (const message of messages) {
        for (const key of getLiveMessageUpdateKeys(message)) {
            if (seen.has(key)) return true
            seen.add(key)
        }
    }
    return false
}

function haveAnySharedLiveMessageUpdateKey(
    left: DashboardMessage | null | undefined,
    right: DashboardMessage | null | undefined,
): boolean {
    const leftKeys = new Set(getLiveMessageUpdateKeys(left))
    if (leftKeys.size === 0) return false
    return getLiveMessageUpdateKeys(right).some((key) => leftKeys.has(key))
}

function shouldPreferLiveSnapshotOverDuplicateConversation(
    conversationMessages: DashboardMessage[],
    snapshotMessages: DashboardMessage[],
): boolean {
    if (snapshotMessages.length === 0) return false
    if (!hasDuplicateLiveMessageUpdateKeys(conversationMessages)) return false
    if (hasDuplicateLiveMessageUpdateKeys(snapshotMessages)) return false
    return haveAnySharedLiveMessageUpdateKey(
        conversationMessages[conversationMessages.length - 1],
        snapshotMessages[snapshotMessages.length - 1],
    )
}

function shouldOverlayWarmLiveMessages(conversation: ActiveConversation, liveMessages: DashboardMessage[]): boolean {
    if (liveMessages.length === 0) return false
    const existingMessages = Array.isArray(conversation.messages) ? conversation.messages : []
    if (existingMessages.length === 0) return true

    const existingAt = getLatestMessageTimestamp(existingMessages)
    const liveAt = getLatestMessageTimestamp(liveMessages)
    if (existingAt > 0 && liveAt === existingAt && shouldPreferLiveSnapshotOverDuplicateConversation(existingMessages, liveMessages)) return true
    if (existingAt <= 0 || liveAt <= existingAt) return false

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
    const conversationMessages = Array.isArray(conversation.messages) ? conversation.messages : []
    const snapshotMessages = snapshot?.liveMessages || []
    if (snapshotMessages.length === 0) return conversationMessages
    if (conversationMessages.length === 0) return snapshotMessages

    const conversationAt = getLatestMessageTimestamp(conversationMessages)
    const snapshotAt = getLatestMessageTimestamp(snapshotMessages)
    if (conversationAt > 0 && (snapshotAt <= 0 || conversationAt > snapshotAt)) {
        return conversationMessages
    }
    if (conversationAt > 0 && conversationAt === snapshotAt) {
        if (shouldPreferLiveSnapshotOverDuplicateConversation(conversationMessages, snapshotMessages)) {
            return snapshotMessages
        }
        if (conversationMessages.length >= snapshotMessages.length) {
            return conversationMessages
        }
    }
    return snapshotMessages
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
