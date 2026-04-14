import type { DaemonData, SessionEntry } from '../../types'
import { formatIdeType } from '../../utils/daemon-utils'
import { isAcpConv, isCliConv, isCliTerminalConv, type ActiveConversation } from './types'

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
    const displayLabel = isNativeConversation(conversation)
        ? (ideEntry?.type ? formatIdeType(ideEntry.type) : formatIdeType(getConversationHostIdeType(conversation) || providerType))
        : getConversationProviderLabel(conversation)

    return {
        isNativeConversation: isNativeConversation(conversation),
        isCli: isCliConv(conversation),
        isAcp: isAcpConv(conversation),
        isCliTerminal: isCliTerminalConv(conversation),
        providerType,
        displayLabel,
        targetEntry: resolveConversationTargetEntry(conversation, ideEntry),
    }
}
