import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildIdeConversations, buildMachineNameMap, type LocalUserMessage } from '../components/dashboard/buildConversations'
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
        const daemonId = ideData.daemonId || ideData.id?.split(':')[0] || ideData.id
        return buildIdeConversations(ideData, localUserMessages, {
            machineName: (ideData.daemonId && machineNames[ideData.daemonId]) || undefined,
            connectionState: connectionStates[daemonId] || 'new',
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

    useEffect(() => {
        if (!preferredTabKey) return
        setActiveChatTab(preferredTabKey)
    }, [preferredTabKey])

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
