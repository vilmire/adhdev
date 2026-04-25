import { formatIdeType } from '../../utils/daemon-utils'
import { normalizeTextContent } from '../../utils/text'
import type { ActiveConversation, DashboardMessage } from './types'
import { getConversationViewStates } from './DashboardMobileChatShared'
import {
    getConversationDisplayLabel,
    getConversationHostIdeType,
    getConversationMetaParts,
    getConversationNotificationLabel as getConversationNotificationDisplayLabel,
    getConversationProviderLabel,
} from './conversation-selectors'

function parseConversationMessageTimestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return 0
}

function getLastNonLocalMessage(messages: DashboardMessage[]): DashboardMessage | undefined {
    return [...messages].reverse().find((message) => !message?._localId)
        || messages[messages.length - 1]
}

function getMessageActivityAt(message: DashboardMessage | undefined): number {
    return parseConversationMessageTimestamp(message?.receivedAt)
        || parseConversationMessageTimestamp(message?.timestamp)
        || 0
}

export function getConversationTitle(conversation: ActiveConversation): string {
    return getConversationDisplayLabel(conversation)
}

export function getConversationMetaText(conversation: ActiveConversation): string {
    return getConversationMetaParts(conversation).join(' · ')
}

export function getConversationPreviewText(conversation: ActiveConversation): string {
    const lastMessage = getLastNonLocalMessage(conversation.messages)
    const messagePreview = normalizeTextContent(lastMessage?.content)
    const messageAt = getMessageActivityAt(lastMessage)
    const summaryPreview = normalizeTextContent(conversation.lastMessagePreview)
    const summaryAt = typeof conversation.lastMessageAt === 'number' && Number.isFinite(conversation.lastMessageAt)
        ? conversation.lastMessageAt
        : 0

    if (summaryPreview && !messagePreview) return summaryPreview
    if (messagePreview && !summaryPreview) return messagePreview
    if (summaryPreview && messagePreview && summaryAt > 0 && messageAt > 0 && summaryAt > messageAt) return summaryPreview
    if (messagePreview) return messagePreview
    if (summaryPreview) return summaryPreview
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
    return getConversationNotificationDisplayLabel(conversation)
}

export function getRemotePanelTitle(conversation: ActiveConversation | null | undefined): string {
    if (!conversation) return 'Remote'
    return `Remote · ${getConversationTitle(conversation) || conversation.workspaceName || 'Session'}`
}
