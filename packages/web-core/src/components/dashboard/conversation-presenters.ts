import { formatIdeType } from '../../utils/daemon-utils'
import { normalizeTextContent } from '../../utils/text'
import type { ActiveConversation } from './types'
import { getConversationViewStates } from './DashboardMobileChatShared'
import {
    getConversationDisplayLabel,
    getConversationHostIdeType,
    getConversationMetaParts,
    getConversationProviderLabel,
} from './conversation-selectors'

export function getConversationTitle(conversation: ActiveConversation): string {
    return getConversationDisplayLabel(conversation)
}

export function getConversationMetaText(conversation: ActiveConversation): string {
    return getConversationMetaParts(conversation).join(' · ')
}

export function getConversationPreviewText(conversation: ActiveConversation): string {
    if (conversation.lastMessagePreview) return conversation.lastMessagePreview
    const lastMessage = [...conversation.messages].reverse().find((message) => !message?._localId)
        || conversation.messages[conversation.messages.length - 1]
    const preview = normalizeTextContent(lastMessage?.content)
    if (preview) return preview
    if (conversation.title) return conversation.title
    return getConversationMetaText(conversation) || 'No messages yet'
}

export function getConversationStatusHint(
    conversation: ActiveConversation,
    options?: { requiresAction?: boolean },
): string | null {
    const { isReconnecting, isConnecting } = getConversationViewStates(conversation)
    if (isReconnecting) return 'Reconnecting…'
    if (isConnecting) return 'Connecting…'
    if (options?.requiresAction) return 'Action needed'
    return null
}

export function getMachineConversationCardSubtitle(
    conversation: ActiveConversation,
    options?: { timestampLabel?: string | null },
): string {
    const parts = ['Chat', ...getConversationMetaParts(conversation)]
    if (options?.timestampLabel) parts.push(options.timestampLabel)
    return parts.filter(Boolean).join(' · ')
}

export function getConversationTabMetaText(conversation: ActiveConversation): string {
    return getConversationStatusHint(conversation) || getConversationMetaText(conversation)
}

export function getConversationMachineCardPreview(conversation: ActiveConversation): string {
    return `${getConversationTitle(conversation)} · ${getConversationPreviewText(conversation)}`
}

export function getConversationHistorySubtitle(conversation: ActiveConversation): string {
    const hostIdeType = getConversationHostIdeType(conversation)
    const label = hostIdeType
        ? formatIdeType(hostIdeType)
        : getConversationProviderLabel(conversation)
    return `${getConversationTitle(conversation)} — ${label || 'Agent'}`
}

export function getConversationStopDialogLabel(conversation: ActiveConversation): string {
    return getConversationProviderLabel(conversation) || 'CLI'
}

export function getConversationNotificationLabel(conversation: ActiveConversation): string {
    return conversation.title || getConversationProviderLabel(conversation) || conversation.routeId
}

export function getRemotePanelTitle(conversation: ActiveConversation | null | undefined): string {
    if (!conversation) return 'Remote'
    return `Remote · ${getConversationTitle(conversation) || conversation.workspaceName || 'Session'}`
}
