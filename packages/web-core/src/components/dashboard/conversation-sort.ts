import type { ActiveConversation, DashboardMessage } from './types'
import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'

function parseMessageTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return 0
}

export function getConversationTimestamp(conversation: ActiveConversation): number {
    const lastMessage: DashboardMessage | undefined = [...conversation.messages].reverse().find((message) => !message?._localId)
        || conversation.messages[conversation.messages.length - 1]
    return (
        parseMessageTimestamp(lastMessage?.receivedAt)
        || 0
    )
}

export function getConversationActivityAt(conversation: ActiveConversation, lastUpdated = 0): number {
    return getConversationTimestamp(conversation) || conversation.lastUpdated || lastUpdated || 0
}

export function getConversationSortTimestamp(conversation: ActiveConversation): number {
    return getConversationTimestamp(conversation) || conversation.lastUpdated || 0
}

export function compareConversationRecency(
    left: ActiveConversation,
    right: ActiveConversation,
    getSortTimestamp: (conversation: ActiveConversation) => number = getConversationSortTimestamp,
): number {
    const activityDiff = getSortTimestamp(right) - getSortTimestamp(left)
    if (activityDiff !== 0) return activityDiff

    const machineDiff = (left.machineName || '').localeCompare(right.machineName || '')
    if (machineDiff !== 0) return machineDiff

    const primaryDiff = left.displayPrimary.localeCompare(right.displayPrimary)
    if (primaryDiff !== 0) return primaryDiff

    const secondaryDiff = left.displaySecondary.localeCompare(right.displaySecondary)
    if (secondaryDiff !== 0) return secondaryDiff

    return left.tabKey.localeCompare(right.tabKey)
}

function isConversationWorking(conversation: ActiveConversation): boolean {
    const status = normalizeManagedStatus(conversation.status, {
        activeModal: conversation.modalButtons?.length
            ? { buttons: conversation.modalButtons }
            : null,
    })
    return status === 'generating' || status === 'waiting_approval'
}

function isConversationEmptyShell(conversation: ActiveConversation): boolean {
    return conversation.messages.length === 0
        && !conversation.modalButtons?.length
        && !isConversationWorking(conversation)
        && !conversation.title.trim()
}

function getPreferredStreamConversation(streams: ActiveConversation[]): ActiveConversation | null {
    if (streams.length === 0) return null
    return [...streams].sort((left, right) => {
        const workingDiff = Number(isConversationWorking(right)) - Number(isConversationWorking(left))
        if (workingDiff !== 0) return workingDiff

        const messageDiff = right.messages.length - left.messages.length
        if (messageDiff !== 0) return messageDiff

        return compareConversationRecency(left, right)
    })[0] || null
}

export function getPreferredConversationForIde(
    conversations: ActiveConversation[],
    routeId: string,
): ActiveConversation | null {
    const ideConversations = conversations.filter(conversation => conversation.routeId === routeId)
    if (ideConversations.length === 0) return null

    const nativeConversation = ideConversations.find(conversation => conversation.streamSource === 'native') || null
    const streamConversations = ideConversations.filter(conversation => conversation.streamSource === 'agent-stream')
    const preferredStream = getPreferredStreamConversation(streamConversations)

    if (!nativeConversation) return preferredStream || ideConversations[0] || null
    if (!preferredStream) return nativeConversation

    return isConversationEmptyShell(nativeConversation) ? preferredStream : nativeConversation
}
