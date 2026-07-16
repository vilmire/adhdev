import type { DaemonData, SessionEntry } from '../../types'
import { formatIdeType } from '../../utils/daemon-utils'
import { normalizeTextContent } from '../../utils/text'
import { getConversationLiveMessages } from './conversation-message-snapshot'
import type { SessionChatTailSnapshot } from './session-chat-tail-controller'
import { isAcpConv, isCliConv, isCliTerminalConv, type ActiveConversation, type DashboardMessage } from './types'

/**
 * (B2) The live chat_tail snapshot the warm controller already holds for a
 * conversation, passed through the preview selectors so the inbox/card previews
 * derive their last message from the SAME transcript authority ChatPane renders
 * (getConversationLiveMessages). Optional everywhere — omitted (or without a live
 * snapshot) the selectors fall back to conversation.messages exactly as before.
 */
export type ConversationPreviewSnapshot = Pick<SessionChatTailSnapshot, 'liveMessages' | 'hasLiveSnapshot'>

export const DASHBOARD_NOTIFICATION_PREVIEW_MAX_CHARS = 180

type ConversationTargetEntry = Pick<
    DaemonData,
    'type' | 'providerControls' | 'controlValues' | 'muted'
> | Pick<
    SessionEntry,
    'providerType' | 'providerControls' | 'controlValues' | 'muted'
>

export function isNativeConversation(conversation: ActiveConversation): boolean {
    return conversation.streamSource !== 'agent-stream'
}

export function getConversationMachineId(conversation: ActiveConversation): string {
    return conversation.daemonId || conversation.routeId?.split(':')[0] || conversation.routeId || ''
}

/**
 * Coordinator routing hint for a session-scoped dashboard command targeting a REMOTE
 * mesh-worker session.
 *
 * A worker session's owning daemon (`getConversationMachineId`) has no direct command
 * channel to the dashboard, so web-cloud must relay the command through the coordinator
 * that mirrors the session. The coordinator stamps its own id onto the mirrored session
 * settings as `meshCoordinatorDaemonId` (see daemon-cloud adhdev-daemon-mesh-owned-sessions),
 * and web-cloud's relay guard uses it to pick the right coordinator even when several
 * command-channel daemons are connected — instead of refusing unless exactly one exists.
 *
 * Returns `{ meshCoordinatorDaemonId }` when the hint is present, else an empty object,
 * so callers can spread it directly into a command payload:
 *   sendDaemonCommand(daemonId, cmd, { ...payload, ...getCoordinatorRoutingHint(conv) })
 * Local (non-mesh) sessions carry no hint and spread nothing, preserving prior behavior.
 */
export function getCoordinatorRoutingHint(
    conversation: ActiveConversation,
): { meshCoordinatorDaemonId?: string } {
    const coordinatorDaemonId = typeof conversation.settings?.meshCoordinatorDaemonId === 'string'
        ? conversation.settings.meshCoordinatorDaemonId
        : undefined
    return coordinatorDaemonId ? { meshCoordinatorDaemonId: coordinatorDaemonId } : {}
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

function getConversationLastMessage(
    conversation: ActiveConversation,
    snapshot?: ConversationPreviewSnapshot | null,
): DashboardMessage | undefined {
    // (B2) When the warm chat_tail snapshot is available, derive the last message
    // from the SAME authority ChatPane uses (getConversationLiveMessages), so the
    // inbox/card preview and the opened chat body agree on the latest bubble. Falls
    // back to conversation.messages when no live snapshot has arrived yet.
    const messages = getConversationLiveMessages(conversation, snapshot)
    return [...messages].reverse().find((message) => !message?._localId)
        || messages[messages.length - 1]
}

export function getConversationLastMessagePreview(
    conversation: ActiveConversation,
    snapshot?: ConversationPreviewSnapshot | null,
): string {
    const lastMessage = getConversationLastMessage(conversation, snapshot)
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
