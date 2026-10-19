import { useCallback, useEffect, useRef } from 'react'
import type { DaemonData } from '../../types'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationLiveInboxState, type LiveSessionInboxState, type MobileConversationListItem } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import { getConversationTimestamp } from './conversation-sort'
import { getConversationMachineId } from './conversation-selectors'
import { getConversationTitle } from './conversation-presenters'

export type MobileChatScreen = 'inbox' | 'chat' | 'machine'

export function shouldReturnToInboxWhenSelectedConversationIsMissing(screen: MobileChatScreen) {
    return screen === 'chat'
}

export interface MobileConversationLookupTarget {
    targetKey?: string | null
    nodeId?: string | null
    sessionId?: string | null
}

export interface MobileConversationLookupMatch {
    conversation: ActiveConversation
    isHidden: boolean
}

const RESERVED_CONVERSATION_KEY_PREFIXES = new Set([
    'session',
    'tab',
    'route',
    'provider',
    'history',
    'native',
    'unknown',
])

function extractCandidateMachinePrefix(key: string | null | undefined): string | undefined {
    if (typeof key !== 'string' || !key.includes(':')) return undefined
    const prefix = key.split(':')[0]?.trim() || ''
    if (!prefix || RESERVED_CONVERSATION_KEY_PREFIXES.has(prefix.toLowerCase())) return undefined
    return prefix
}

function getConversationCandidateNodeIds(
    conversation: ActiveConversation,
    ides?: DaemonData[],
): string[] {
    const ide = ides?.find(entry => entry.id === conversation.routeId)
    const routePrefix = extractCandidateMachinePrefix(conversation.routeId)
    const tabPrefix = extractCandidateMachinePrefix(conversation.tabKey)
    return Array.from(new Set(
        [
            conversation.daemonId,
            ide?.ownerDaemonId,
            ide?.daemonId,
            ide?.machineId,
            routePrefix,
            tabPrefix,
        ]
            .map(value => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean),
    ))
}

function conversationMatchesSessionId(
    conversation: ActiveConversation,
    sessionId: string,
): boolean {
    const normalized = sessionId.trim()
    if (!normalized) return false
    const currentRuntimeSessionId = typeof conversation.sessionId === 'string'
        ? conversation.sessionId.trim()
        : ''
    if (currentRuntimeSessionId) {
        return currentRuntimeSessionId === normalized
    }
    if (
        conversation.providerSessionId === normalized
        || conversation.nativeSessionId === normalized
        || conversation.historySessionId === normalized
        || conversation.tabKey === normalized
        || conversation.routeId === normalized
    ) {
        return true
    }
    if (conversation.tabKey?.endsWith(`:${normalized}`) || conversation.routeId?.endsWith(`:${normalized}`)) {
        return true
    }
    return false
}

function matchByNodeAndSession(
    entries: MobileConversationLookupMatch[],
    nodeId: string | null | undefined,
    sessionId: string,
    ides?: DaemonData[],
): MobileConversationLookupMatch | null {
    const normalizedNodeId = typeof nodeId === 'string' ? nodeId.trim() : ''
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return null

    if (normalizedNodeId) {
        const exactMatch = entries.find(entry => {
            if (!conversationMatchesSessionId(entry.conversation, normalizedSessionId)) return false
            const candidateNodeIds = getConversationCandidateNodeIds(entry.conversation, ides)
            return candidateNodeIds.includes(normalizedNodeId)
        })
        return exactMatch || null
    }

    const unscopedMatch = entries.find(entry => conversationMatchesSessionId(entry.conversation, normalizedSessionId))
    return unscopedMatch || null
}

export function findMatchingMobileConversation(
    conversations: ActiveConversation[],
    hiddenConversations: ActiveConversation[] = [],
    target: MobileConversationLookupTarget,
    ides?: DaemonData[],
): MobileConversationLookupMatch | null {
    const entries: MobileConversationLookupMatch[] = [
        ...conversations.map(conversation => ({ conversation, isHidden: false })),
        ...hiddenConversations.map(conversation => ({ conversation, isHidden: true })),
    ]
    if (entries.length === 0) return null

    const explicitSessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : ''
    const explicitNodeId = typeof target.nodeId === 'string' ? target.nodeId.trim() : ''
    if (explicitSessionId) {
        return matchByNodeAndSession(entries, explicitNodeId, explicitSessionId, ides)
    }

    const rawKey = typeof target.targetKey === 'string' ? target.targetKey.trim() : ''
    if (!rawKey) return null

    if (rawKey.startsWith('session:')) {
        const rest = rawKey.slice('session:'.length).trim()
        if (!rest) return null
        const colonIndex = rest.indexOf(':')
        if (colonIndex > 0) {
            const candidateNodeId = rest.slice(0, colonIndex).trim()
            const candidateSessionId = rest.slice(colonIndex + 1).trim()
            return matchByNodeAndSession(entries, candidateNodeId, candidateSessionId, ides)
        }
        return matchByNodeAndSession(entries, null, rest, ides)
    }

    if (rawKey.startsWith('provider:')) {
        const providerId = rawKey.slice('provider:'.length).trim()
        if (!providerId) return null
        return entries.find(({ conversation }) => conversation.providerSessionId === providerId) || null
    }

    const exactKeyMatch = entries.find(({ conversation }) => (
        conversation.tabKey === rawKey
        || conversation.routeId === rawKey
        || `tab:${conversation.tabKey}` === rawKey
        || `route:${conversation.routeId}` === rawKey
    ))
    if (exactKeyMatch) return exactKeyMatch

    const colonIndex = rawKey.indexOf(':')
    if (colonIndex > 0) {
        const candidateNodeId = rawKey.slice(0, colonIndex).trim()
        const lastColonIndex = rawKey.lastIndexOf(':')
        const candidateSessionId = rawKey.slice(lastColonIndex + 1).trim()
        return matchByNodeAndSession(entries, candidateNodeId, candidateSessionId, ides)
    }

    return matchByNodeAndSession(entries, null, rawKey, ides)
}

interface UseDashboardMobileChatEffectsOptions {
    conversations: ActiveConversation[]
    hiddenConversations?: ActiveConversation[]
    ides?: DaemonData[]
    machineEntries: Array<{ id: string }>
    items: MobileConversationListItem[]
    selectedConversation: ActiveConversation | null
    selectedTabKey: string | null
    screen: MobileChatScreen
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    requestedActiveTabKey?: string | null
    onRequestedActiveTabConsumed?: () => void
    onRestoreHiddenConversation?: (conversation: ActiveConversation) => void
    onShowHiddenConversation?: (conversation: ActiveConversation) => void
    requestedMachineId?: string | null
    onRequestedMachineConsumed?: () => void
    requestedMobileSection?: DashboardMobileSection | null
    onRequestedMobileSectionConsumed?: () => void
    setSelectedTabKey: (value: string | null) => void
    setScreen: (value: MobileChatScreen) => void
    setSelectedMachineId: (value: string | null) => void
    setSection: (value: DashboardMobileSection) => void
    setMachineBackTarget: (value: 'inbox' | 'chat') => void
    resetMachineAction: () => void
}

function logMobileReadDebug(event: string, payload: Record<string, unknown>) {
    if (typeof window === 'undefined') return
    try {
        const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } }
        const debugEnabled = !!meta.env?.DEV || window.localStorage.getItem('adhdev_mobile_debug') === '1'
        if (!debugEnabled) return
        console.debug(`[mobile-read] ${event}`, payload)
    } catch {
        // noop
    }
}

export function useDashboardMobileChatEffects({
    conversations,
    hiddenConversations = [],
    ides,
    machineEntries,
    items,
    selectedConversation,
    selectedTabKey,
    screen,
    liveSessionInboxState,
    sendDaemonCommand,
    requestedActiveTabKey,
    onRequestedActiveTabConsumed,
    onRestoreHiddenConversation,
    onShowHiddenConversation,
    requestedMachineId,
    onRequestedMachineConsumed,
    requestedMobileSection,
    onRequestedMobileSectionConsumed,
    setSelectedTabKey,
    setScreen,
    setSelectedMachineId,
    setSection,
    setMachineBackTarget,
    resetMachineAction,
}: UseDashboardMobileChatEffectsOptions) {
    const lastAutoReadKeyRef = useRef<string | null>(null)

    const markConversationRead = useCallback((conversation: ActiveConversation | null) => {
        if (!conversation?.sessionId) return
        lastAutoReadKeyRef.current = `${conversation.tabKey}:${conversation.sessionId || ''}`
        const liveState = getConversationLiveInboxState(conversation, liveSessionInboxState)
        const readAt = Math.max(Date.now(), getConversationTimestamp(conversation), liveState.lastUpdated || 0)
        logMobileReadDebug('mark_read:start', {
            tabKey: conversation.tabKey,
            sessionId: conversation.sessionId,
            displayPrimary: getConversationTitle(conversation),
            inboxBucket: liveState.inboxBucket,
            unread: liveState.unread,
            lastSeenAt: liveState.lastSeenAt,
            lastUpdated: liveState.lastUpdated,
            activityAt: getConversationTimestamp(conversation),
            readAt,
        })
        void sendDaemonCommand(getConversationMachineId(conversation) || conversation.routeId, 'mark_session_seen', {
            sessionId: conversation.sessionId,
            providerSessionId: conversation.providerSessionId,
            seenAt: readAt,
            completionMarker: liveState.completionMarker,
        }).then((result) => {
            logMobileReadDebug('mark_read:result', {
                tabKey: conversation.tabKey,
                sessionId: conversation.sessionId,
                result,
            })
        }).catch((error) => {
            logMobileReadDebug('mark_read:error', {
                tabKey: conversation.tabKey,
                sessionId: conversation.sessionId,
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }, [liveSessionInboxState, sendDaemonCommand])

    useEffect(() => {
        if (!selectedConversation) {
            if (shouldReturnToInboxWhenSelectedConversationIsMissing(screen)) {
                setScreen('inbox')
            }
            if (!requestedActiveTabKey) {
                setSelectedTabKey(conversations[0]?.tabKey || null)
            }
            lastAutoReadKeyRef.current = null
            return
        }
        if (screen !== 'chat') {
            lastAutoReadKeyRef.current = null
            return
        }
        const autoReadKey = `${selectedConversation.tabKey}:${selectedConversation.sessionId || ''}`
        if (lastAutoReadKeyRef.current === autoReadKey) return
        lastAutoReadKeyRef.current = autoReadKey
        markConversationRead(selectedConversation)
    }, [conversations, markConversationRead, requestedActiveTabKey, screen, selectedConversation, setScreen, setSelectedTabKey])

    useEffect(() => {
        if (!requestedActiveTabKey) return
        const matched = findMatchingMobileConversation(
            conversations,
            hiddenConversations,
            { targetKey: requestedActiveTabKey },
            ides,
        )
        if (!matched) return
        if (matched.isHidden) {
            if (onRestoreHiddenConversation) {
                onRestoreHiddenConversation(matched.conversation)
            } else if (onShowHiddenConversation) {
                onShowHiddenConversation(matched.conversation)
            }
        }
        setSelectedTabKey(matched.conversation.tabKey)
        setScreen('chat')
        onRequestedActiveTabConsumed?.()
    }, [
        conversations,
        hiddenConversations,
        ides,
        onRequestedActiveTabConsumed,
        onRestoreHiddenConversation,
        onShowHiddenConversation,
        requestedActiveTabKey,
        setScreen,
        setSelectedTabKey,
    ])

    useEffect(() => {
        if (!requestedMachineId) return
        const matched = machineEntries.find(machine => machine.id === requestedMachineId)
        if (!matched) return
        setSelectedMachineId(matched.id)
        resetMachineAction()
        setSection('machines')
        setMachineBackTarget('inbox')
        setScreen('machine')
        onRequestedMachineConsumed?.()
    }, [machineEntries, onRequestedMachineConsumed, requestedMachineId, resetMachineAction, setMachineBackTarget, setScreen, setSection, setSelectedMachineId])

    useEffect(() => {
        if (!requestedMobileSection) return
        setSection(requestedMobileSection)
        setScreen('inbox')
        onRequestedMobileSectionConsumed?.()
    }, [onRequestedMobileSectionConsumed, requestedMobileSection, setScreen, setSection])

    useEffect(() => {
        const taskCompleteItems = items.filter(item => item.inboxBucket === 'task_complete' || item.unread)
        if (taskCompleteItems.length === 0) return
        logMobileReadDebug('inbox_state', {
            screen,
            selectedTabKey,
            items: taskCompleteItems.map(item => {
                const liveState = getConversationLiveInboxState(item.conversation, liveSessionInboxState)
                return {
                    liveState,
                    tabKey: item.conversation.tabKey,
                    sessionId: item.conversation.sessionId,
                    displayPrimary: getConversationTitle(item.conversation),
                    serverBucket: liveState.inboxBucket,
                    computedBucket: item.inboxBucket,
                    serverUnread: liveState.unread,
                    computedUnread: item.unread,
                    lastSeenAt: liveState.lastSeenAt,
                    lastUpdated: liveState.lastUpdated,
                    activityAt: getConversationTimestamp(item.conversation),
                }
            }),
        })
    }, [items, liveSessionInboxState, screen, selectedTabKey])

    return {
        markConversationRead,
    }
}
