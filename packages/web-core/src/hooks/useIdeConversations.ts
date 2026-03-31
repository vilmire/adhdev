import { useEffect, useMemo, useState } from 'react'
import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'
import { deriveStreamConversationStatus, getAgentDisplayName } from '../utils/daemon-utils'

interface UseIdeConversationsOptions {
    ideId: string
    doId: string
    ideData: DaemonData | undefined
    ideType: string | undefined
    ideName: string
}

function getStreamKey(stream: { sessionId?: string; instanceId?: string; agentType: string }) {
    return stream.sessionId || stream.instanceId || stream.agentType
}

export function useIdeConversations({
    ideId,
    doId,
    ideData,
    ideType,
    ideName,
}: UseIdeConversationsOptions) {
    const [activeChatTab, setActiveChatTab] = useState<string>('native')
    const activeChat = ideData?.activeChat || null
    const agentStreams = ideData?.agentStreams || []
    const derivedStatus = normalizeManagedStatus(activeChat?.status, {
        activeModal: activeChat?.activeModal,
    })

    const nativeConv: ActiveConversation = useMemo(() => ({
        ideId,
        sessionId: (ideData as any)?.sessionId || ideData?.instanceId,
        daemonId: doId,
        agentName: getAgentDisplayName(ideType || ''),
        agentType: ideType || '',
        status: derivedStatus,
        title: activeChat?.title || '',
        messages: activeChat?.messages || [],
        ideType: ideType || '',
        workspaceName: (ideData as any)?.workspaceName || '',
        displayPrimary: ideName,
        displaySecondary: (ideData as any)?.workspaceName || '',
        cdpConnected: true,
        modalButtons: activeChat?.activeModal?.buttons,
        modalMessage: activeChat?.activeModal?.message,
        streamSource: 'native',
        tabKey: `ide-${ideId}`,
    }), [ideId, ideData, doId, ideType, ideName, derivedStatus, activeChat])

    const streamConvs: ActiveConversation[] = useMemo(
        () => agentStreams.map(stream => {
            const streamStatus = deriveStreamConversationStatus(stream)
            const streamKey = getStreamKey(stream as any)
            return {
                ideId,
                sessionId: (stream as any).sessionId || (stream as any).instanceId,
                daemonId: doId,
                agentName: stream.agentName,
                agentType: stream.agentType,
                status: streamStatus,
                title: (stream as any).title || '',
                messages: stream.messages.map((message: any, index: number) => ({
                    role: message.role,
                    content: message.content,
                    kind: (message as any).kind,
                    id: `${streamKey}-${index}`,
                    receivedAt: message.timestamp,
                })),
                ideType: stream.agentType,
                workspaceName: '',
                displayPrimary: (stream as any).title || stream.agentName,
                displaySecondary: '',
                cdpConnected: true,
                modalButtons: stream.activeModal?.buttons,
                modalMessage: stream.activeModal?.message,
                streamSource: 'agent-stream',
                tabKey: `agent-stream-${streamKey}`,
            }
        }),
        [agentStreams, ideId, doId],
    )

    useEffect(() => {
        if (activeChatTab === 'native') return
        if (!streamConvs.some(conversation => conversation.tabKey === activeChatTab)) {
            setActiveChatTab(streamConvs[0]?.tabKey || 'native')
        }
    }, [activeChatTab, streamConvs])

    const activeConv = useMemo(() => {
        if (activeChatTab === 'native') return nativeConv
        return streamConvs.find(conversation => conversation.tabKey === activeChatTab) || nativeConv
    }, [activeChatTab, nativeConv, streamConvs])

    const extensionTabs = useMemo(
        () => agentStreams.map(stream => {
            const streamKey = getStreamKey(stream as any)
            return {
                tabKey: `agent-stream-${streamKey}`,
                title: (stream as any).title || stream.agentName,
                status: deriveStreamConversationStatus(stream),
            }
        }),
        [agentStreams],
    )

    return {
        activeChatTab,
        setActiveChatTab,
        activeConv,
        extensionTabs,
        hasExtensions: extensionTabs.length > 0,
    }
}
