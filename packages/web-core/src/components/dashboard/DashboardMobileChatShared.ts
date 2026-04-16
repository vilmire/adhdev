import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import type { RecentSessionBucket } from '@adhdev/daemon-core'
import type { DashboardNotificationSessionState } from '../../utils/dashboard-notifications'

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
    latestConversation: ActiveConversation | null
    latestTimestamp?: number
    fallbackActivityAt?: number
    preview: string
}

export interface MobileMachineActionState {
    state: 'idle' | 'loading' | 'done' | 'error'
    message: string
}

export interface LiveSessionInboxState {
    sessionId: string
    unread: boolean
    lastSeenAt: number
    lastUpdated: number
    inboxBucket: RecentSessionBucket
    surfaceHidden: boolean
}

export interface ConversationInboxSurfaceState {
    unread: boolean
    requiresAction: boolean
    isWorking: boolean
    isReconnecting: boolean
    isConnecting: boolean
    isGenerating: boolean
    isWaiting: boolean
    inboxBucket: RecentSessionBucket
}

function normalizeInboxState(source: {
    unread?: boolean
    lastSeenAt?: number
    lastUpdated?: number
    inboxBucket?: RecentSessionBucket
    surfaceHidden?: boolean
}) {
    return {
        unread: !!source.unread,
        lastSeenAt: source.lastSeenAt || 0,
        lastUpdated: source.lastUpdated || 0,
        inboxBucket: source.inboxBucket || 'idle',
        surfaceHidden: !!source.surfaceHidden,
    }
}

export function getConversationViewStates(conversation: { status?: string, connectionState?: string }) {
    const isReconnecting = conversation.connectionState === 'failed' || conversation.connectionState === 'closed'
    const isConnecting = conversation.connectionState === 'connecting' || conversation.connectionState === 'new'
    const isGenerating = conversation.status === 'generating'
    const isWaiting = conversation.status === 'waiting_approval'
    return { isReconnecting, isConnecting, isGenerating, isWaiting }
}

export function buildLiveSessionInboxStateMap(ides: DaemonData[]) {
    const stateBySessionId = new Map<string, LiveSessionInboxState>()

    const register = (
        sessionId: string | undefined,
        source: {
            unread?: boolean
            lastSeenAt?: number
            lastUpdated?: number
            inboxBucket?: RecentSessionBucket
            surfaceHidden?: boolean
        },
    ) => {
        if (!sessionId) return
        stateBySessionId.set(sessionId, {
            sessionId,
            ...normalizeInboxState(source),
        })
    }

    for (const entry of ides) {
        if (entry.type === 'adhdev-daemon') continue
        register(entry.sessionId, entry)
        for (const child of entry.childSessions || []) {
            register(child.id, child)
        }
    }

    return stateBySessionId
}

export function getConversationLiveInboxState(
    conversation: ActiveConversation,
    stateBySessionId: Map<string, LiveSessionInboxState>,
) {
    if (conversation.sessionId) {
        const liveState = stateBySessionId.get(conversation.sessionId)
        if (liveState) return liveState
    }
    return {
        sessionId: conversation.sessionId || conversation.tabKey,
        unread: false,
        lastSeenAt: 0,
        lastUpdated: 0,
        inboxBucket: 'idle',
        surfaceHidden: false,
    }
}

export function getConversationInboxSurfaceState(
    conversation: ActiveConversation,
    stateBySessionId: Map<string, LiveSessionInboxState>,
    options?: {
        hideOpenTaskCompleteUnread?: boolean
        isOpenConversation?: boolean
        notificationStateBySessionId?: Map<string, DashboardNotificationSessionState>
    },
): ConversationInboxSurfaceState {
    const liveState = getConversationLiveInboxState(conversation, stateBySessionId)
    const viewStates = getConversationViewStates(conversation)
    const notificationState = (conversation.sessionId && options?.notificationStateBySessionId?.get(conversation.sessionId))
        || (conversation.providerSessionId && options?.notificationStateBySessionId?.get(conversation.providerSessionId))
        || options?.notificationStateBySessionId?.get(conversation.tabKey)
    
    const isReconnecting = viewStates.isReconnecting
    const isConnecting = viewStates.isConnecting
    const isGenerating = viewStates.isGenerating
    const isWaiting = viewStates.isWaiting

    const requiresAction = liveState.inboxBucket === 'needs_attention' || conversation.status === 'needs_attention' || conversation.status === 'waiting_for_user_input' || isWaiting
    const isWorking = liveState.inboxBucket === 'working' || isGenerating
    const taskCompleteUnread = liveState.inboxBucket === 'task_complete'
        && (notificationState ? notificationState.unreadCount > 0 : liveState.unread)
    const unread = (
        taskCompleteUnread
        && !(options?.hideOpenTaskCompleteUnread && options?.isOpenConversation)
    )

    return {
        unread,
        requiresAction,
        isWorking,
        isReconnecting,
        isConnecting,
        isGenerating,
        isWaiting,
        inboxBucket: requiresAction
            ? 'needs_attention'
            : isWorking
                ? 'working'
                : unread
                    ? 'task_complete'
                    : 'idle',
    }
}

export function isConversationTaskCompleteUnread(
    conversation: ActiveConversation,
    stateBySessionId: Map<string, LiveSessionInboxState>,
    options?: { isOpenConversation?: boolean },
) {
    return getConversationInboxSurfaceState(conversation, stateBySessionId, {
        hideOpenTaskCompleteUnread: true,
        isOpenConversation: options?.isOpenConversation,
    }).unread
}

export function isHiddenNativeIdeParentConversation(
    conversation: ActiveConversation,
    _conversations: ActiveConversation[],
    stateBySessionId?: Map<string, LiveSessionInboxState>,
) {
    return getConversationLiveInboxState(conversation, stateBySessionId || new Map()).surfaceHidden
}

export { formatRelativeCompact as formatRelativeTime } from '../../utils/time'
