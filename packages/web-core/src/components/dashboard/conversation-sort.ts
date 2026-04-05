import type { ActiveConversation } from './types'

function parseMessageTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return 0
}

export function getConversationTimestamp(conversation: ActiveConversation): number {
    const lastMessage = [...conversation.messages].reverse().find((message: any) => !(message as any)?._localId) as any
        || conversation.messages[conversation.messages.length - 1] as any
    return (
        parseMessageTimestamp(lastMessage?.timestamp)
        || parseMessageTimestamp(lastMessage?.receivedAt)
        || parseMessageTimestamp(lastMessage?.createdAt)
        || 0
    )
}

export function getConversationActivityAt(conversation: ActiveConversation, lastUpdated = 0): number {
    return getConversationTimestamp(conversation) || lastUpdated || 0
}

export function getConversationSortTimestamp(conversation: ActiveConversation): number {
    return getConversationTimestamp(conversation)
}

export function compareConversationRecency(left: ActiveConversation, right: ActiveConversation): number {
    const activityDiff = getConversationSortTimestamp(right) - getConversationSortTimestamp(left)
    if (activityDiff !== 0) return activityDiff

    const machineDiff = (left.machineName || '').localeCompare(right.machineName || '')
    if (machineDiff !== 0) return machineDiff

    const primaryDiff = left.displayPrimary.localeCompare(right.displayPrimary)
    if (primaryDiff !== 0) return primaryDiff

    const secondaryDiff = left.displaySecondary.localeCompare(right.displaySecondary)
    if (secondaryDiff !== 0) return secondaryDiff

    return left.tabKey.localeCompare(right.tabKey)
}
