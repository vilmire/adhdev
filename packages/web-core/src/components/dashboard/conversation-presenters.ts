import { formatIdeType } from '../../utils/daemon-utils'
import { i18next } from '../../i18n/config'
import { isAssistantConversation } from './assistant-session'
import type { ActiveConversation } from './types'
import { isMeshGraphAvailableFor } from './conversation-mesh-role'
import { getConversationViewStates } from './DashboardMobileChatShared'
import {
    getConversationDisplayLabel,
    getConversationHostIdeType,
    getConversationLastMessagePreview,
    getConversationMetaParts,
    getConversationNotificationLabel as getConversationNotificationDisplayLabel,
    getConversationProviderLabel,
    type ConversationPreviewSnapshot,
} from './conversation-selectors'

/**
 * The assistant is "비서" / "Assistant" in the user's language everywhere it is
 * named (inbox entry, room header, tab, input placeholder); the stored
 * `displayPrimary` stays the language-neutral brand label it is matched by.
 */
export function getConversationTitle(conversation: ActiveConversation): string {
    if (isAssistantConversation(conversation)) return i18next.t('dashboard.assistant.label', { ns: 'common' })
    return getConversationDisplayLabel(conversation)
}

export function getConversationMetaText(conversation: ActiveConversation): string {
    return getConversationMetaParts(conversation).join(' · ')
}

/**
 * Mesh chat predicate (coordinator bound to a daemon). Kept as a named export
 * for existing importers; the rule itself lives in conversation-mesh-role.
 */
export function isMeshGraphConversation(conversation: ActiveConversation): boolean {
    return isMeshGraphAvailableFor(conversation)
}

export function getConversationPreviewText(
    conversation: ActiveConversation,
    snapshot?: ConversationPreviewSnapshot | null,
): string {
    // (B3) The preview always surfaces the actual final answer (last assistant
    // message) rather than an "Agent is generating…" placeholder — the generating
    // state is conveyed by the inbox 'Live' badge instead. (B2) When the warm
    // keyed-chat snapshot is passed, the last message is derived from the same
    // transcript authority ChatPane renders, keeping inbox and chat in sync.
    const preview = getConversationLastMessagePreview(conversation, snapshot)
    if (preview) return preview
    // The assistant's session title is its working folder ("assistant"), which
    // reads as noise under the "비서" name; an empty assistant says it is empty.
    if (isAssistantConversation(conversation)) return i18next.t('chatPane.noMessagesYet', { ns: 'common' })
    if (conversation.title) return conversation.title
    return getConversationMetaText(conversation) || i18next.t('chatPane.noMessagesYet', { ns: 'common' })
}

export function getConversationStatusHint(
    conversation: ActiveConversation,
    options?: { requiresAction?: boolean },
): string | null {
    const { isReconnecting, isConnecting, isErrored } = getConversationViewStates(conversation)
    if (isReconnecting) return i18next.t('mobileInbox.reconnectingItem', { ns: 'common' })
    if (isConnecting) return i18next.t('mobileInbox.connectingItem', { ns: 'common' })
    if (options?.requiresAction) return i18next.t('mobileInbox.actionNeeded', { ns: 'common' })
    // G8-10: surfaced only after the higher-priority connection/action hints
    // above — a session that's both reconnecting AND errored shows the more
    // actionable "Reconnecting…" first.
    if (isErrored) return i18next.t('mobileInbox.needsAttention', { ns: 'common' })
    return null
}

export function getMachineConversationCardSubtitle(
    conversation: ActiveConversation,
    options?: { timestampLabel?: string | null },
): string {
    const parts = [i18next.t('settings.appearance.chatLabel', { ns: 'common' }), ...getConversationMetaParts(conversation)]
    if (options?.timestampLabel) parts.push(options.timestampLabel)
    return parts.filter(Boolean).join(' · ')
}

export function getConversationTabMetaText(conversation: ActiveConversation): string {
    return getConversationStatusHint(conversation) || getConversationMetaText(conversation)
}

export function getConversationMachineCardPreview(
    conversation: ActiveConversation,
    snapshot?: ConversationPreviewSnapshot | null,
): string {
    return `${getConversationTitle(conversation)} · ${getConversationPreviewText(conversation, snapshot)}`
}

export function getConversationHistorySubtitle(conversation: ActiveConversation): string {
    const hostIdeType = getConversationHostIdeType(conversation)
    const label = hostIdeType
        ? formatIdeType(hostIdeType)
        : getConversationProviderLabel(conversation)
    return `${getConversationTitle(conversation)} — ${label || 'Agent'}`
}

export function getConversationStopDialogLabel(conversation: ActiveConversation): string {
    // The assistant by its name; others by CLI name without the English role suffix.
    if (isAssistantConversation(conversation)) return getConversationTitle(conversation)
    return (getConversationProviderLabel(conversation) || 'CLI').replace(/\s*\((?:Assistant|Coordinator|Mesh Node)\)$/, '')
}

export function getConversationNotificationLabel(conversation: ActiveConversation): string {
    return getConversationNotificationDisplayLabel(conversation)
}

export function getRemotePanelTitle(conversation: ActiveConversation | null | undefined): string {
    if (!conversation) return 'Remote'
    return `Remote · ${getConversationTitle(conversation) || conversation.workspaceName || 'Session'}`
}
