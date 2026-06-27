import type { DaemonData, SessionEntry } from '../../types'
import { formatIdeType } from '../../utils/daemon-utils'
import { normalizeTextContent } from '../../utils/text'
import { isAcpConv, isCliConv, isCliTerminalConv, type ActiveConversation, type DashboardMessage } from './types'

export const DASHBOARD_NOTIFICATION_PREVIEW_MAX_CHARS = 180

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

export function getConversationLastMessagePreview(conversation: ActiveConversation): string {
    const lastMessage = getConversationLastMessage(conversation)
    const messagePreview = normalizeTextContent(lastMessage?.content)
    const summaryPreview = normalizeTextContent(conversation.lastMessagePreview)

    // Mesh worker sessions: the coordinator-side transcript ends with the user task,
    // but the daemon derives the worker's latest assistant reply into lastMessagePreview
    // (with lastMessageRole === 'assistant'). Prefer the daemon summary in that case so the
    // inbox shows the assistant response instead of getting stuck on the user message.
    if (
        summaryPreview &&
        conversation.lastMessageRole === 'assistant' &&
        lastMessage?.role === 'user'
    ) {
        return summaryPreview
    }

    // Inbox/card/notification previews must describe the same transcript that
    // ChatPane can render. Compact summaries are metadata-only and may be newer
    // than the local transcript, but showing them while the opened chat still
    // renders the older message makes the inbox and chat appear out of sync.
    if (messagePreview) return messagePreview
    if (summaryPreview) return summaryPreview
    return ''
}

/** Inbox/card placeholder shown while the agent is mid-turn with no visible reply yet. */
export const AGENT_GENERATING_PREVIEW_TEXT = 'Agent is generating…'

/**
 * True when the latest message we can surface for this conversation is still the
 * user's own prompt — i.e. the agent has not produced a visible reply yet.
 *
 * During generation the assistant's streamed reply only reaches the open ChatPane
 * through the live agent-stream channel; the inbox status snapshot's transcript
 * (and the daemon-derived lastMessageRole computed from it) can still end at the
 * user message. Echoing that user message back as the conversation "preview" is
 * the stale-inbox bug, so callers pair this with the generating status to swap in
 * AGENT_GENERATING_PREVIEW_TEXT. Returns false the moment an assistant reply is
 * visible (transcript tail or daemon summary), so a real reply always wins.
 */
export function isConversationAwaitingAssistantReply(conversation: ActiveConversation): boolean {
    if (normalizeTextContent(conversation.lastMessagePreview) && conversation.lastMessageRole === 'assistant') {
        return false
    }
    const lastMessage = getConversationLastMessage(conversation)
    return lastMessage?.role !== 'assistant'
}

export function compactConversationNotificationPreview(
    value: string,
    maxChars = DASHBOARD_NOTIFICATION_PREVIEW_MAX_CHARS,
): string {
    const normalized = normalizeTextContent(value)
    if (!normalized || maxChars <= 0) return ''

    const chars = Array.from(normalized)
    if (chars.length <= maxChars) return normalized

    return `${chars.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd()}…`
}

export function getConversationNotificationPreview(conversation: ActiveConversation): string {
    return compactConversationNotificationPreview(
        getConversationLastMessagePreview(conversation) || conversation.displaySecondary || '',
    )
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
