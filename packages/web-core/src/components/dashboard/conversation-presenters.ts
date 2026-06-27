import { formatIdeType } from '../../utils/daemon-utils'
import type { ActiveConversation } from './types'
import { getConversationViewStates } from './DashboardMobileChatShared'
import {
    AGENT_GENERATING_PREVIEW_TEXT,
    getConversationDisplayLabel,
    getConversationHostIdeType,
    getConversationLastMessagePreview,
    getConversationMetaParts,
    getConversationNotificationLabel as getConversationNotificationDisplayLabel,
    getConversationProviderLabel,
    isConversationAwaitingAssistantReply,
} from './conversation-selectors'

export function getConversationTitle(conversation: ActiveConversation): string {
    return getConversationDisplayLabel(conversation)
}

export function getConversationMetaText(conversation: ActiveConversation): string {
    return getConversationMetaParts(conversation).join(' · ')
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

export function getConversationPreviewText(conversation: ActiveConversation): string {
    // While the agent is mid-turn the inbox snapshot transcript can still end at the
    // user's prompt (the streamed reply only reaches the open chat via the live
    // agent-stream channel). Surface a generating placeholder instead of echoing the
    // user's own message back — but only until a real assistant reply becomes visible.
    const { isGenerating } = getConversationViewStates(conversation)
    if (isGenerating && isConversationAwaitingAssistantReply(conversation)) {
        return AGENT_GENERATING_PREVIEW_TEXT
    }
    const preview = getConversationLastMessagePreview(conversation)
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
    return getConversationNotificationDisplayLabel(conversation)
}

export function getRemotePanelTitle(conversation: ActiveConversation | null | undefined): string {
    if (!conversation) return 'Remote'
    return `Remote · ${getConversationTitle(conversation) || conversation.workspaceName || 'Session'}`
}
