import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildMachineNameMap, buildScopedIdeConversations, type LocalUserMessage } from '../components/dashboard/buildConversations'
import { conversationMatchesTarget } from '../components/dashboard/conversation-identity'
import { getConversationNotificationLabel } from '../components/dashboard/conversation-presenters'
import { getPreferredConversationForIde } from '../components/dashboard/conversation-sort'
import type { DaemonData } from '../types'

interface UseIdeConversationsOptions {
    ideData: DaemonData | undefined
    allIdes: DaemonData[]
    connectionStates: Record<string, string>
    localUserMessages: Record<string, LocalUserMessage[]>
    ideName: string
    preferredTabKey?: string
}

export function useIdeConversations({
    ideData,
    allIdes,
    connectionStates,
    localUserMessages,
    ideName,
    preferredTabKey,
}: UseIdeConversationsOptions) {
    const [activeChatTab, setActiveChatTab] = useState<string>(() => preferredTabKey || 'native')
    const machineNames = useMemo(() => buildMachineNameMap(allIdes), [allIdes])

    const conversations = useMemo(() => {
        if (!ideData) return []
        return buildScopedIdeConversations(ideData, localUserMessages, {
            machineNames,
            connectionStates,
            defaultConnectionState: 'new',
        })
    }, [ideData, localUserMessages, machineNames, connectionStates])

    const nativeConv = useMemo(
        () => conversations.find(conversation => conversation.streamSource === 'native'),
        [conversations],
    )

    const streamConvs = useMemo(
        () => conversations.filter(conversation => conversation.streamSource === 'agent-stream'),
        [conversations],
    )
    const preferredConversation = useMemo(
        () => (ideData ? getPreferredConversationForIde(conversations, ideData.id) : null),
        [conversations, ideData],
    )

    useEffect(() => {
        if (!preferredTabKey) return
        setActiveChatTab(preferredTabKey)
    }, [preferredTabKey])

    useEffect(() => {
        if (preferredTabKey || !preferredConversation) return
        const preferredTab = preferredConversation.streamSource === 'native'
            ? 'native'
            : preferredConversation.tabKey
        if (!preferredTab || activeChatTab === preferredTab) return
        if (activeChatTab !== 'native') return
        setActiveChatTab(preferredTab)
    }, [activeChatTab, preferredConversation, preferredTabKey])

    useEffect(() => {
        if (activeChatTab === 'native') return
        if (!streamConvs.some(conversation => conversation.tabKey === activeChatTab)) {
            setActiveChatTab(streamConvs[0]?.tabKey || 'native')
        }
    }, [activeChatTab, streamConvs])

    useEffect(() => {
        if (activeChatTab !== 'native') return
        if (nativeConv) return
        if (streamConvs[0]) setActiveChatTab(streamConvs[0].tabKey)
    }, [activeChatTab, nativeConv, streamConvs])

    const activeConv = useMemo(() => {
        if (activeChatTab === 'native' && nativeConv) return nativeConv
        return streamConvs.find(conversation => conversation.tabKey === activeChatTab)
            || preferredConversation
            || nativeConv
            || streamConvs[0]
    }, [activeChatTab, nativeConv, preferredConversation, streamConvs])

    const extensionTabs = useMemo(
        () => streamConvs.map(conversation => ({
            tabKey: conversation.tabKey,
            title: getConversationNotificationLabel(conversation) || ideName,
            status: conversation.status,
        })),
        [streamConvs, ideName],
    )

    const resolveConversationByTarget = useCallback((target: string | null | undefined) => {
        if (!target) return undefined
        return conversations.find(conversation => conversationMatchesTarget(conversation, { sessionId: target, routeId: target, tabKey: target, providerSessionId: target }))
    }, [conversations])

    return {
        activeChatTab,
        setActiveChatTab,
        activeConv,
        conversations,
        extensionTabs,
        hasExtensions: extensionTabs.length > 0,
        resolveConversationByTarget,
    }
}
