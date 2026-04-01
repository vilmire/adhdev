import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildConversations } from '../components/dashboard/buildConversations'
import type { DaemonData } from '../types'

type LocalUserMessage = {
    role: string
    content: string
    timestamp: number
    _localId: string
}

interface UseIdeConversationsOptions {
    ideData: DaemonData | undefined
    allIdes: DaemonData[]
    connectionStates: Record<string, string>
    localUserMessages: Record<string, LocalUserMessage[]>
    ideName: string
}

export function useIdeConversations({
    ideData,
    allIdes,
    connectionStates,
    localUserMessages,
    ideName,
}: UseIdeConversationsOptions) {
    const [activeChatTab, setActiveChatTab] = useState<string>('native')

    const conversations = useMemo(() => {
        if (!ideData) return []
        return buildConversations([ideData], localUserMessages, allIdes, connectionStates)
    }, [ideData, localUserMessages, allIdes, connectionStates])

    const nativeConv = useMemo(
        () => conversations.find(conversation => conversation.streamSource === 'native'),
        [conversations],
    )

    const streamConvs = useMemo(
        () => conversations.filter(conversation => conversation.streamSource === 'agent-stream'),
        [conversations],
    )

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
            || nativeConv
            || streamConvs[0]
    }, [activeChatTab, nativeConv, streamConvs])

    const extensionTabs = useMemo(
        () => streamConvs.map(conversation => ({
            tabKey: conversation.tabKey,
            title: conversation.title || conversation.agentName || ideName,
            status: conversation.status,
        })),
        [streamConvs, ideName],
    )

    const resolveConversationByTarget = useCallback((target: string | null | undefined) => {
        if (!target) return undefined
        return conversations.find(conversation =>
            conversation.sessionId === target
            || conversation.ideId === target
            || conversation.tabKey === target
            || conversation.ideType === target
            || conversation.agentType === target,
        )
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
