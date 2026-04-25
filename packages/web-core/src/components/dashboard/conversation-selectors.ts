import type { DaemonData, SessionEntry } from '../../types'
import { formatIdeType } from '../../utils/daemon-utils'
import { normalizeTextContent } from '../../utils/text'
import { isAcpConv, isCliConv, isCliTerminalConv, type ActiveConversation, type DashboardMessage } from './types'

type ConversationTargetEntry = Pick<
    DaemonData,
    'type' | 'providerControls' | 'controlValues'
> | Pick<
    SessionEntry,
    'providerType' | 'providerControls' | 'controlValues'
>

export function isNativeConversation(conversation: ActiveConversation): boolean {
    return conversation.streamSource !== 'agent-stream'
}

export function getConversationMachineId(conversation: ActiveConversation): string {
    return conversation.daemonId || conversation.routeId?.split(':')[0] || conversation.routeId || ''
}

export function getConversationMachineLabel(conversation: ActiveConversation): string {
    return conversation.machineName || ''
}

export function getConversationDaemonRouteId(conversation: ActiveConversation): string {
    return getConversationMachineId(conversation)
}

export function getConversationProviderType(conversation: ActiveConversation): string {
    return conversation.agentType || ''
}

export function getConversationHostIdeType(conversation: ActiveConversation): string {
    return conversation.hostIdeType || ''
}

export function getConversationDisplayLabel(conversation: ActiveConversation): string {
    return conversation.displayPrimary || conversation.agentName || 'Agent'
}

export function getConversationNotificationLabel(conversation: ActiveConversation): string {
    return conversation.title
        || conversation.displayPrimary
        || conversation.agentName
        || conversation.tabKey
        || conversation.routeId
        || 'Session'
}

function getConversationLastMessage(conversation: ActiveConversation): DashboardMessage | undefined {
    return [...conversation.messages].reverse().find((message) => !message?._localId)
        || conversation.messages[conversation.messages.length - 1]
}

function parseConversationMessageTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return 0
}

function getConversationMessageActivityAt(message: DashboardMessage | undefined): number {
    return parseConversationMessageTimestamp(message?.receivedAt)
        || parseConversationMessageTimestamp(message?.timestamp)
        || 0
}

export function getConversationLastMessagePreview(conversation: ActiveConversation): string {
    const lastMessage = getConversationLastMessage(conversation)
    const messagePreview = normalizeTextContent(lastMessage?.content)
    const messageAt = getConversationMessageActivityAt(lastMessage)
    const summaryPreview = normalizeTextContent(conversation.lastMessagePreview)
    const summaryAt = typeof conversation.lastMessageAt === 'number' && Number.isFinite(conversation.lastMessageAt)
        ? conversation.lastMessageAt
        : 0

    if (summaryPreview && !messagePreview) return summaryPreview
    if (messagePreview && !summaryPreview) return messagePreview
    if (summaryPreview && messagePreview && summaryAt > 0 && messageAt > 0 && summaryAt > messageAt) return summaryPreview
    if (messagePreview) return messagePreview
    if (summaryPreview) return summaryPreview
    return ''
}

export function getConversationNotificationPreview(conversation: ActiveConversation): string {
    return getConversationLastMessagePreview(conversation) || conversation.displaySecondary || ''
}

export function getConversationMetaParts(conversation: ActiveConversation): string[] {
    return [conversation.displaySecondary, getConversationMachineLabel(conversation)].filter(Boolean)
}

export function getConversationProviderLabel(conversation: ActiveConversation): string {
    return conversation.agentName || formatIdeType(getConversationProviderType(conversation))
}

export function getConversationIdeChipLabel(conversation: ActiveConversation): string {
    if (!isNativeConversation(conversation)) {
        const parentIdeLabel = conversation.displaySecondary?.split('·')[0]?.trim()
        if (parentIdeLabel) return parentIdeLabel
    }
    return formatIdeType(getConversationHostIdeType(conversation) || getConversationProviderType(conversation))
}

export function getConversationNativeTargetSessionId(conversation: ActiveConversation): string | undefined {
    return isNativeConversation(conversation)
        ? conversation.sessionId
        : conversation.nativeSessionId
}

export function getConversationRemoteTabKey(conversation: ActiveConversation): string {
    return isNativeConversation(conversation) ? 'native' : conversation.tabKey
}

export function getConversationActiveTabTarget(conversation: ActiveConversation): string | undefined {
    return conversation.sessionId
}

export function resolveConversationTargetEntry(
    conversation: ActiveConversation,
    ideEntry?: DaemonData,
): ConversationTargetEntry | undefined {
    if (!ideEntry) return undefined
    if (isNativeConversation(conversation) || !ideEntry.childSessions) return ideEntry

    return ideEntry.childSessions.find(
        (session) => session.id === conversation.sessionId || session.providerType === conversation.agentType,
    ) || ideEntry
}

export function getConversationControlsContext(
    conversation: ActiveConversation,
    ideEntry?: DaemonData,
) {
    const providerType = getConversationProviderType(conversation)
    const isNative = isNativeConversation(conversation)
    const isCliLike = isCliConv(conversation) || isAcpConv(conversation)
    const displayLabel = isNative
        ? (isCliLike
            ? (getConversationProviderLabel(conversation)
                || ideEntry?.cliName
                || formatIdeType(getConversationHostIdeType(conversation) || providerType))
            : (ideEntry?.type
                ? formatIdeType(ideEntry.type)
                : formatIdeType(getConversationHostIdeType(conversation) || providerType)))
        : getConversationProviderLabel(conversation)

    return {
        isNativeConversation: isNative,
        isCli: isCliConv(conversation),
        isAcp: isAcpConv(conversation),
        isCliTerminal: isCliTerminalConv(conversation),
        providerType,
        displayLabel,
        targetEntry: resolveConversationTargetEntry(conversation, ideEntry),
    }
}
