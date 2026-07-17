import { formatIdeType } from '../../utils/daemon-utils'
import type { ActiveConversation } from './types'
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

export function getConversationTitle(conversation: ActiveConversation): string {
    return getConversationDisplayLabel(conversation)
}

export function getConversationMetaText(conversation: ActiveConversation): string {
    return getConversationMetaParts(conversation).join(' · ')
}

export function isMeshGraphConversation(conversation: ActiveConversation): boolean {
    // Shared mesh-chat predicate reused by the mobile inbox (inline mesh icon)
    // and the desktop tab header (mesh icon overlay). A conversation is treated
    // as a mesh chat when it is bound to a daemon and carries a coordinator mesh
    // id or a settings-level mesh-coordinator marker.
    return !!conversation.daemonId
        && !!(conversation.coordinator?.meshId
            || (typeof conversation.settings?.meshCoordinatorFor === 'string'
                && conversation.settings.meshCoordinatorFor.trim().length > 0))
}

export function getConversationMeshRoleLabels(conversation: ActiveConversation): string[] {
    const labels: string[] = []
    const isMeshNode = typeof conversation.settings?.meshNodeFor === 'string'
        && conversation.settings.meshNodeFor.trim().length > 0
    const isMeshCoordinator = !!conversation.coordinator?.meshId
        || (typeof conversation.settings?.meshCoordinatorFor === 'string'
            && conversation.settings.meshCoordinatorFor.trim().length > 0)

    if (isMeshNode) labels.push('Mesh node')
    if (isMeshCoordinator) labels.push('Coordinator')
    return labels
}

export function getConversationMeshRoleTitle(conversation: ActiveConversation): string {
    const details: string[] = []
    const meshNodeFor = typeof conversation.settings?.meshNodeFor === 'string'
        ? conversation.settings.meshNodeFor.trim()
        : ''
    const coordinatorMeshId = typeof conversation.coordinator?.meshId === 'string'
        ? conversation.coordinator.meshId.trim()
        : ''
    const settingsCoordinatorFor = typeof conversation.settings?.meshCoordinatorFor === 'string'
        ? conversation.settings.meshCoordinatorFor.trim()
        : ''
    const coordinatorFor = coordinatorMeshId || settingsCoordinatorFor

    if (meshNodeFor) details.push(`Mesh node: ${meshNodeFor}`)
    if (coordinatorFor) details.push(`Coordinator: ${coordinatorFor}`)
    if (conversation.meshQueueStats) {
        const { pending, assigned, completed, failed } = conversation.meshQueueStats
        details.push(`Queue: ${pending} pending, ${assigned} assigned, ${completed} completed, ${failed} failed`)
    }
    return details.join(' · ')
}

export function getConversationPreviewText(
    conversation: ActiveConversation,
    snapshot?: ConversationPreviewSnapshot | null,
): string {
    // (B3) The preview always surfaces the actual final answer (last assistant
    // message) rather than an "Agent is generating…" placeholder — the generating
    // state is conveyed by the inbox 'Live' badge instead. (B2) When the warm
    // chat_tail snapshot is passed, the last message is derived from the same
    // transcript authority ChatPane renders, keeping inbox and chat in sync.
    const preview = getConversationLastMessagePreview(conversation, snapshot)
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
    return getConversationProviderLabel(conversation) || 'CLI'
}

export function getConversationNotificationLabel(conversation: ActiveConversation): string {
    return getConversationNotificationDisplayLabel(conversation)
}

export function getRemotePanelTitle(conversation: ActiveConversation | null | undefined): string {
    if (!conversation) return 'Remote'
    return `Remote · ${getConversationTitle(conversation) || conversation.workspaceName || 'Session'}`
}
