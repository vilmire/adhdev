import type { DaemonData } from '../../types'
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
    latestConversation: ActiveConversation | null
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
        if ((entry as any).daemonMode) continue
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

export function isHiddenNativeIdeParentConversation(
    conversation: ActiveConversation,
    _conversations: ActiveConversation[],
    stateBySessionId?: Map<string, LiveSessionInboxState>,
) {
    return getConversationLiveInboxState(conversation, stateBySessionId || new Map()).surfaceHidden
}

export { formatRelativeCompact as formatRelativeTime } from '../../utils/time'
