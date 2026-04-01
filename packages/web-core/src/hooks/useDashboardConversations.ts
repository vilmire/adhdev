import { useCallback, useMemo, useRef } from 'react'
import { buildIdeConversations, buildMachineNameMap, type LocalUserMessage } from '../components/dashboard/buildConversations'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'

type LocalMessageRef = {
    key: string
    ref: LocalUserMessage[] | undefined
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

function getCachedLocalMessageRefs(
    ide: DaemonData,
    localUserMessages: Record<string, LocalUserMessage[]>,
): LocalMessageRef[] {
    const refs: LocalMessageRef[] = []
    const nativeSessionId = (ide as any).sessionId || ide.instanceId
    refs.push({ key: ide.id, ref: localUserMessages[ide.id] })
    if (nativeSessionId) refs.push({ key: nativeSessionId, ref: localUserMessages[nativeSessionId] })

    for (const stream of ide.agentStreams || []) {
        const streamKey = stream.sessionId || stream.instanceId || stream.agentType
        const tabKey = `${ide.id}:${streamKey}`
        refs.push({ key: tabKey, ref: localUserMessages[tabKey] })
        if (stream.sessionId) refs.push({ key: stream.sessionId, ref: localUserMessages[stream.sessionId] })
        if (stream.instanceId) refs.push({ key: stream.instanceId, ref: localUserMessages[stream.instanceId] })
    }

    return refs
}

function sameLocalMessageRefs(prev: LocalMessageRef[], next: LocalMessageRef[]) {
    if (prev.length !== next.length) return false
    for (let i = 0; i < prev.length; i += 1) {
        if (prev[i].key !== next[i].key || prev[i].ref !== next[i].ref) return false
    }
    return true
}

type ConversationCacheEntry = {
    ide: DaemonData
    connectionState: string
    machineName?: string
    localRefs: LocalMessageRef[]
    conversations: ActiveConversation[]
}

export function useDashboardConversations({
    ides,
    connectionStates,
    localUserMessages,
    clearedTabs,
    hiddenTabs,
}: UseDashboardConversationsOptions) {
    const chatIdes = useMemo(() => dedupeChatIdes(ides), [ides])
    const machineNames = useMemo(() => buildMachineNameMap(ides), [ides])
    const cacheRef = useRef<Map<string, ConversationCacheEntry>>(new Map())

    const baseConversations = useMemo(() => {
        const nextCache = new Map<string, ConversationCacheEntry>()
        const nextConversations: ActiveConversation[] = []

        for (const ide of chatIdes) {
            const daemonId = ide.daemonId || ide.id?.split(':')[0] || ide.id
            const connectionState = connectionStates[daemonId] || 'new'
            const machineName = (ide.daemonId && machineNames[ide.daemonId]) || undefined
            const localRefs = getCachedLocalMessageRefs(ide, localUserMessages)
            const cached = cacheRef.current.get(ide.id)

            if (
                cached
                && cached.ide === ide
                && cached.connectionState === connectionState
                && cached.machineName === machineName
                && sameLocalMessageRefs(cached.localRefs, localRefs)
            ) {
                nextCache.set(ide.id, cached)
                nextConversations.push(...cached.conversations)
                continue
            }

            const conversations = buildIdeConversations(ide, localUserMessages, {
                machineName,
                connectionState,
            })
            const entry: ConversationCacheEntry = {
                ide,
                connectionState,
                machineName,
                localRefs,
                conversations,
            }
            nextCache.set(ide.id, entry)
            nextConversations.push(...conversations)
        }

        cacheRef.current = nextCache
        return nextConversations
    }, [chatIdes, localUserMessages, connectionStates, machineNames])

    const conversations = useMemo(
        () => applyClearedConversationState(baseConversations, clearedTabs),
        [baseConversations, clearedTabs],
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
