import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NavigateFunction, Location } from 'react-router-dom'
import type { DaemonData } from '../types'
import { getConversationRemoteTabKey } from '../components/dashboard/conversation-selectors'
import type { ActiveConversation } from '../components/dashboard/types'
import { getPreferredConversationForIde } from '../components/dashboard/conversation-sort'
import { isAcpConv, isCliConv } from '../components/dashboard/types'

interface UseDashboardRemoteDialogStateOptions {
    isMobile: boolean
    location: Location
    navigate: NavigateFunction
    requestedRemoteTabTarget: string | null
    requestedDesktopTabKey: string | null
    conversations: ActiveConversation[]
    ides: DaemonData[]
    resolveConversationByTarget: (target: string | null | undefined) => ActiveConversation | undefined
}

export function useDashboardRemoteDialogState({
    isMobile,
    location,
    navigate,
    requestedRemoteTabTarget,
    requestedDesktopTabKey,
    conversations,
    ides,
    resolveConversationByTarget,
}: UseDashboardRemoteDialogStateOptions) {
    const [remoteDialogState, setRemoteDialogState] = useState<{ ideId: string; tabKey: string } | null>(null)
    const [remoteDialogActiveConv, setRemoteDialogActiveConv] = useState<ActiveConversation | null>(null)

    const requestedRemoteConversation = useMemo(() => {
        if (isMobile || !requestedRemoteTabTarget) return null
        const target = resolveConversationByTarget(requestedRemoteTabTarget)
        return target && !isCliConv(target) && !isAcpConv(target) ? target : null
    }, [isMobile, requestedRemoteTabTarget, resolveConversationByTarget])

    const remoteDialogConv = useMemo(() => {
        const targetIdeId = remoteDialogState?.ideId
        if (!targetIdeId) return null
        const requestedConversation = remoteDialogState?.tabKey
            ? conversations.find(conversation => conversation.tabKey === remoteDialogState.tabKey)
            : requestedDesktopTabKey
                ? conversations.find(conversation => conversation.tabKey === requestedDesktopTabKey)
                : null
        if (requestedConversation?.ideId === targetIdeId) return requestedConversation
        return getPreferredConversationForIde(conversations, targetIdeId)
    }, [conversations, remoteDialogState, requestedDesktopTabKey])

    const remoteDialogIdeEntry = useMemo(() => {
        if (!remoteDialogConv) return undefined
        return ides.find(ide => ide.id === remoteDialogConv.ideId)
    }, [ides, remoteDialogConv])

    useEffect(() => {
        if (!requestedRemoteConversation) return
        setRemoteDialogState({
            ideId: requestedRemoteConversation.ideId,
            tabKey: getConversationRemoteTabKey(requestedRemoteConversation),
        })
        setRemoteDialogActiveConv(requestedRemoteConversation)
        navigate(
            {
                pathname: location.pathname,
                search: location.search,
            },
            {
                replace: true,
                state: null,
            },
        )
    }, [location.pathname, location.search, navigate, requestedRemoteConversation])

    const openRemoteDialog = useCallback((conversation: ActiveConversation | null | undefined) => {
        if (!conversation) return
        setRemoteDialogState({
            ideId: conversation.ideId,
            tabKey: getConversationRemoteTabKey(conversation),
        })
        setRemoteDialogActiveConv(conversation)
    }, [])

    const closeRemoteDialog = useCallback(() => {
        setRemoteDialogState(null)
        setRemoteDialogActiveConv(null)
    }, [])

    return {
        remoteDialogConv,
        remoteDialogIdeEntry,
        remoteDialogActiveConv,
        setRemoteDialogActiveConv,
        openRemoteDialog,
        closeRemoteDialog,
    }
}
