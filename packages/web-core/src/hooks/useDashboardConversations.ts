import { useCallback, useMemo, useRef } from 'react'
import { buildMachineNameMap, buildScopedIdeConversations, getIdeConversationBuildContext, type LocalUserMessage } from '../components/dashboard/buildConversations'
import { compareConversationRecency, getConversationSortTimestamp, getPreferredConversationForIde } from '../components/dashboard/conversation-sort'
import type { ActiveConversation, DashboardMessage } from '../components/dashboard/types'
import type { DaemonData } from '../types'
import { normalizeTextContent } from '../utils/text'

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

        const existingRichness = (existing.workspace ? 1 : 0) + (existing.activeChat ? 1 : 0)
        const incomingRichness = (ide.workspace ? 1 : 0) + (ide.activeChat ? 1 : 0)
        if (incomingRichness > existingRichness || (ide.timestamp || 0) > (existing.timestamp || 0)) {
            seen.set(ide.id, ide)
        }
    }

    return Array.from(seen.values())
}

function sameArrayRefs<T>(prev: T[], next: T[]) {
    if (prev.length !== next.length) return false
    for (let i = 0; i < prev.length; i += 1) {
        if (prev[i] !== next[i]) return false
    }
    return true
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
    const nativeSessionId = ide.sessionId || ide.instanceId
    refs.push({ key: ide.id, ref: localUserMessages[ide.id] })
    if (nativeSessionId) refs.push({ key: nativeSessionId, ref: localUserMessages[nativeSessionId] })

    for (const child of ide.childSessions || []) {
        const streamKey = child.id || child.providerType
        const tabKey = `${ide.id}:${streamKey}`
        refs.push({ key: tabKey, ref: localUserMessages[tabKey] })
        refs.push({ key: child.id, ref: localUserMessages[child.id] })
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

type ConversationSortCacheEntry = {
    signature: string
    timestamp: number
}

function getLastConversationMessage(conversation: ActiveConversation): DashboardMessage | undefined {
    return [...conversation.messages].reverse().find((message) => !message?._localId)
        || conversation.messages[conversation.messages.length - 1]
}

function getConversationSortSignature(conversation: ActiveConversation) {
    const lastMessage = getLastConversationMessage(conversation)
    if (!lastMessage) return `empty:${conversation.messages.length}`
    if (lastMessage.id) return `id:${String(lastMessage.id)}`
    if (lastMessage._localId) return `local:${String(lastMessage._localId)}`

    const role = String(lastMessage.role || '')
    const content = normalizeTextContent(lastMessage.content).slice(0, 240)
    return `${conversation.messages.length}:${role}:${content}`
}

export function useDashboardConversations({
    ides,
    connectionStates,
    localUserMessages,
    clearedTabs,
    hiddenTabs,
}: UseDashboardConversationsOptions) {
    const chatIdesRef = useRef<DaemonData[]>([])
    const conversationsRef = useRef<ActiveConversation[]>([])
    const visibleConversationsRef = useRef<ActiveConversation[]>([])
    const visibleTabKeysRef = useRef<string[]>([])
    const chatIdes = useMemo(() => {
        const next = dedupeChatIdes(ides)
        if (sameArrayRefs(chatIdesRef.current, next)) return chatIdesRef.current
        chatIdesRef.current = next
        return next
    }, [ides])
    const machineNames = useMemo(() => buildMachineNameMap(ides), [ides])
    const cacheRef = useRef<Map<string, ConversationCacheEntry>>(new Map())
    const sortCacheRef = useRef<Map<string, ConversationSortCacheEntry>>(new Map())

    const baseConversations = useMemo(() => {
        const nextCache = new Map<string, ConversationCacheEntry>()
        const nextConversations: ActiveConversation[] = []

        for (const ide of chatIdes) {
            const { connectionState = 'new', machineName } = getIdeConversationBuildContext(ide, {
                machineNames,
                connectionStates,
                defaultConnectionState: 'new',
            })
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

            const conversations = buildScopedIdeConversations(ide, localUserMessages, {
                machineNames,
                connectionStates,
                defaultConnectionState: 'new',
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
        const nextSortCache = new Map<string, ConversationSortCacheEntry>()
        const getStableSortTimestamp = (conversation: ActiveConversation) => {
            const signature = getConversationSortSignature(conversation)
            const previous = sortCacheRef.current.get(conversation.tabKey)
            if (previous && previous.signature === signature) {
                nextSortCache.set(conversation.tabKey, previous)
                return previous.timestamp
            }

            const nextEntry = {
                signature,
                timestamp: getConversationSortTimestamp(conversation) || previous?.timestamp || 0,
            }
            nextSortCache.set(conversation.tabKey, nextEntry)
            return nextEntry.timestamp
        }

        const sorted = [...nextConversations].sort((left, right) => (
            compareConversationRecency(left, right, getStableSortTimestamp)
        ))
        sortCacheRef.current = nextSortCache
        return sorted
    }, [chatIdes, localUserMessages, connectionStates, machineNames])

    const conversations = useMemo(() => {
        const next = applyClearedConversationState(baseConversations, clearedTabs)
        if (sameArrayRefs(conversationsRef.current, next)) return conversationsRef.current
        conversationsRef.current = next
        return next
    }, [baseConversations, clearedTabs])
    const preferredConversationByIdeId = useMemo(() => {
        const map = new Map<string, ActiveConversation>()
        const routeIds = Array.from(new Set(conversations.map(conversation => conversation.routeId)))
        for (const routeId of routeIds) {
            const preferred = getPreferredConversationForIde(conversations, routeId)
            if (preferred) map.set(routeId, preferred)
        }
        return map
    }, [conversations])
    const conversationBySessionId = useMemo(() => {
        const map = new Map<string, ActiveConversation>()
        for (const conversation of conversations) {
            if (conversation.sessionId) map.set(conversation.sessionId, conversation)
            if (conversation.streamSource === 'native' && conversation.sessionId) {
                const preferred = preferredConversationByIdeId.get(conversation.routeId)
                if (preferred) {
                    map.set(conversation.sessionId, preferred)
                }
            }
        }
        return map
    }, [conversations, preferredConversationByIdeId])
    const conversationTargetMap = useMemo(() => {
        const map = new Map<string, ActiveConversation>()
        for (const conversation of conversations) {
            if (conversation.sessionId) map.set(conversation.sessionId, conversation)
            map.set(conversation.routeId, preferredConversationByIdeId.get(conversation.routeId) || conversation)
            map.set(conversation.tabKey, conversation)
        }
        return map
    }, [conversations, preferredConversationByIdeId])

    const resolveConversationBySessionId = useCallback((sessionId: string | null | undefined) => {
        if (!sessionId) return undefined
        return conversationBySessionId.get(sessionId)
    }, [conversationBySessionId])

    const resolveConversationByTarget = useCallback((target: string | null | undefined) => {
        if (!target) return undefined
        return conversationTargetMap.get(target)
    }, [conversationTargetMap])

    const visibleConversations = useMemo(() => {
        const next = conversations.filter(conversation => !hiddenTabs.has(conversation.tabKey))
        if (sameArrayRefs(visibleConversationsRef.current, next)) return visibleConversationsRef.current
        visibleConversationsRef.current = next
        return next
    }, [conversations, hiddenTabs])

    const visibleTabKeys = useMemo(() => {
        const next = visibleConversations.map(conversation => conversation.tabKey)
        if (sameArrayRefs(visibleTabKeysRef.current, next)) return visibleTabKeysRef.current
        visibleTabKeysRef.current = next
        return next
    }, [visibleConversations])

    return {
        chatIdes,
        conversations,
        visibleConversations,
        visibleTabKeys,
        resolveConversationBySessionId,
        resolveConversationByTarget,
    }
}
