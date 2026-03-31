import { useCallback, useMemo } from 'react'
import { buildConversations } from '../components/dashboard/buildConversations'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'

type LocalUserMessage = {
    role: string
    content: string
    timestamp: number
    _localId: string
}

interface UseDashboardConversationsOptions {
    ides: DaemonData[]
    connectionStates: Record<string, string>
    localUserMessages: Record<string, LocalUserMessage[]>
    clearedTabs: Record<string, number>
    hiddenTabs: Set<string>
}

function dedupeChatIdes(ides: DaemonData[]) {
    const filtered = ides.filter(ide => ide.type !== 'adhdev-daemon')
    const seen = new Map<string, DaemonData>()

    for (const ide of filtered) {
        const existing = seen.get(ide.id)
        if (!existing) {
            seen.set(ide.id, ide)
            continue
        }

        const existingRichness = (existing.workspace ? 1 : 0) + ((existing as any).activeChat ? 1 : 0)
        const incomingRichness = (ide.workspace ? 1 : 0) + ((ide as any).activeChat ? 1 : 0)
        if (incomingRichness > existingRichness || (ide.timestamp || 0) > (existing.timestamp || 0)) {
            seen.set(ide.id, ide)
        }
    }

    return Array.from(seen.values())
}

function applyClearedConversationState(conversations: ActiveConversation[], clearedTabs: Record<string, number>) {
    const now = Date.now()
    return conversations.map(conversation => {
        const clearedAt = clearedTabs[conversation.tabKey]
        if (!clearedAt) return conversation
        if (now - clearedAt < 5000) {
            return { ...conversation, messages: [], title: '' }
        }
        return conversation
    })
}

export function useDashboardConversations({
    ides,
    connectionStates,
    localUserMessages,
    clearedTabs,
    hiddenTabs,
}: UseDashboardConversationsOptions) {
    const chatIdes = useMemo(() => dedupeChatIdes(ides), [ides])

    const conversations = useMemo(() => {
        const next = buildConversations(chatIdes, localUserMessages, ides, connectionStates)
        return applyClearedConversationState(next, clearedTabs)
    }, [chatIdes, localUserMessages, ides, connectionStates, clearedTabs])

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

    const visibleConversations = useMemo(
        () => conversations.filter(conversation => !hiddenTabs.has(conversation.tabKey)),
        [conversations, hiddenTabs],
    )

    const visibleTabKeys = useMemo(
        () => visibleConversations.map(conversation => conversation.tabKey),
        [visibleConversations],
    )

    return {
        chatIdes,
        conversations,
        visibleConversations,
        visibleTabKeys,
        resolveConversationByTarget,
    }
}
