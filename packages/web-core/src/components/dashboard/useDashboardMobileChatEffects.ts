import { useCallback, useEffect, useRef } from 'react'
import type { DashboardMobileSection } from './DashboardMobileBottomNav'
import { getConversationLiveInboxState, type LiveSessionInboxState, type MobileConversationListItem } from './DashboardMobileChatShared'
import type { ActiveConversation } from './types'
import { getConversationTimestamp } from './conversation-sort'
import { getConversationMachineId } from './conversation-selectors'
import { getConversationTitle } from './conversation-presenters'

type MobileChatScreen = 'inbox' | 'chat' | 'machine'

interface UseDashboardMobileChatEffectsOptions {
    conversations: ActiveConversation[]
    machineEntries: Array<{ id: string }>
    items: MobileConversationListItem[]
    selectedConversation: ActiveConversation | null
    selectedTabKey: string | null
    screen: MobileChatScreen
    liveSessionInboxState: Map<string, LiveSessionInboxState>
    sendDaemonCommand: (id: string, type: string, data: Record<string, unknown>) => Promise<any>
    requestedActiveTabKey?: string | null
    onRequestedActiveTabConsumed?: () => void
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
    machineEntries,
    items,
    selectedConversation,
    selectedTabKey,
    screen,
    liveSessionInboxState,
    sendDaemonCommand,
    requestedActiveTabKey,
    onRequestedActiveTabConsumed,
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
        void sendDaemonCommand(getConversationMachineId(conversation) || conversation.ideId, 'mark_session_seen', {
            sessionId: conversation.sessionId,
            seenAt: readAt,
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
            setScreen('inbox')
            setSelectedTabKey(conversations[0]?.tabKey || null)
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
    }, [conversations, markConversationRead, screen, selectedConversation, setScreen, setSelectedTabKey])

    useEffect(() => {
        if (!requestedActiveTabKey) return
        const matched = conversations.find(conversation => conversation.tabKey === requestedActiveTabKey)
        if (!matched) return
        setSelectedTabKey(matched.tabKey)
        setScreen('chat')
        onRequestedActiveTabConsumed?.()
    }, [conversations, onRequestedActiveTabConsumed, requestedActiveTabKey, setScreen, setSelectedTabKey])

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
