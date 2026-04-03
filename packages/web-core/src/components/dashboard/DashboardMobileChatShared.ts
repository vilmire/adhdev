import type { ActiveConversation } from './types'
import type { RecentSessionBucket } from '@adhdev/daemon-core'

export interface MobileConversationListItem {
    conversation: ActiveConversation
    timestamp: number
    preview: string
    unread: boolean
    requiresAction: boolean
    isWorking: boolean
    inboxBucket?: RecentSessionBucket
}

export interface MobileMachineCard {
    id: string
    label: string
    subtitle: string
    unread: number
    total: number
    latestConversation: ActiveConversation
}

export interface MobileMachineActionState {
    state: 'idle' | 'loading' | 'done' | 'error'
    message: string
}

export function isHiddenNativeIdeParentConversation(
    conversation: ActiveConversation,
    conversations: ActiveConversation[],
) {
    if (conversation.streamSource !== 'native' || conversation.transport !== 'cdp-page') return false
    return conversations.some(other => (
        other.ideId === conversation.ideId
        && other.tabKey !== conversation.tabKey
        && other.streamSource === 'agent-stream'
    ))
}

export { formatRelativeCompact as formatRelativeTime } from '../../utils/time'
