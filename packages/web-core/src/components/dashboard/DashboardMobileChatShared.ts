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
    _conversations: ActiveConversation[],
) {
    return !!conversation.surfaceHidden
}

export { formatRelativeCompact as formatRelativeTime } from '../../utils/time'
