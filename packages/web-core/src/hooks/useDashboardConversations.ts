import { useCallback, useMemo, useRef } from 'react'
import { buildMachineNameMap, buildScopedIdeConversations, getIdeConversationBuildContext } from '../components/dashboard/buildConversations'
import { buildConversationLookupKeys } from '../components/dashboard/conversation-identity'
import { compareConversationRecency, getConversationSortTimestamp, getPreferredConversationForIde } from '../components/dashboard/conversation-sort'
import type { ActiveConversation, DashboardMessage } from '../components/dashboard/types'
import type { DaemonData } from '../types'
import { normalizeTextContent } from '../utils/text'
import { isConversationHidden } from './useHiddenTabs'

interface UseDashboardConversationsOptions {
    ides: DaemonData[]
    connectionStates: Record<string, string>
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

function hashConversationText(value: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
}

function buildChatDataSignature(activeChat: DaemonData['activeChat'] | undefined) {
    if (!activeChat) return ''
    const messages = Array.isArray(activeChat.messages) ? activeChat.messages : []
    const lastMessage = messages[messages.length - 1]
    const lastMessageContentHash = lastMessage
        ? hashConversationText(normalizeTextContent(lastMessage.content))
        : ''
    return [
        activeChat.id || '',
        activeChat.title || '',
        activeChat.status || '',
        messages.length,
        String(lastMessage?.id || ''),
        String(lastMessage?.index ?? ''),
        String(lastMessage?.receivedAt ?? lastMessage?.timestamp ?? ''),
        lastMessageContentHash,
    ].join(':')
}

export function buildConversationSourceSignature(ide: DaemonData) {
    const childSessions = Array.isArray(ide.childSessions) ? ide.childSessions : []
    return [
        ide.id,
        ide.sessionId || '',
        ide.providerSessionId || '',
        ide.transport || '',
        ide.mode || '',
        ide.status || '',
        ide.workspace || '',
        ide.lastMessageHash || '',
        String(ide.lastUpdated || ''),
        buildChatDataSignature(ide.activeChat),
        ...childSessions.map((child) => [
            child.id || '',
            child.providerSessionId || '',
            child.transport || '',
            child.mode || '',
            child.status || '',
            child.title || '',
            child.lastMessageHash || '',
            String(child.lastUpdated || ''),
            buildChatDataSignature(child.activeChat),
        ].join(':')),
    ].join('|')
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

type ConversationCacheEntry = {
    ide: DaemonData
    sourceSignature: string
    connectionState: string
    machineName?: string
    conversations: ActiveConversation[]
}

type ConversationSortCacheEntry = {
    signature: string
    timestamp: number
}

export function buildConversationTargetMap(
    conversations: ActiveConversation[],
    preferredConversationByIdeId: Map<string, ActiveConversation>,
): Map<string, ActiveConversation> {
    const map = new Map<string, ActiveConversation>()
    for (const conversation of conversations) {
        const preferred = preferredConversationByIdeId.get(conversation.routeId) || conversation
        for (const lookupKey of buildConversationLookupKeys({ routeId: conversation.routeId })) {
            map.set(lookupKey, preferred)
        }
        for (const lookupKey of buildConversationLookupKeys({
            providerSessionId: conversation.providerSessionId,
            sessionId: conversation.sessionId,
        })) {
            map.set(lookupKey, conversation.streamSource === 'native' ? preferred : conversation)
        }
        for (const lookupKey of buildConversationLookupKeys({ tabKey: conversation.tabKey })) {
            map.set(lookupKey, conversation)
        }
    }
    return map
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
    clearedTabs,
    hiddenTabs,
}: UseDashboardConversationsOptions) {
    const chatIdes = useMemo(() => dedupeChatIdes(ides), [ides])
    const machineNames = useMemo(() => buildMachineNameMap(ides), [ides])
    const conversationsRef = useRef<ActiveConversation[]>([])
    const visibleConversationsRef = useRef<ActiveConversation[]>([])
    const visibleTabKeysRef = useRef<string[]>([])
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
            const sourceSignature = buildConversationSourceSignature(ide)
            const cached = cacheRef.current.get(ide.id)

            if (
                cached
                && cached.ide === ide
                && cached.sourceSignature === sourceSignature
                && cached.connectionState === connectionState
                && cached.machineName === machineName
            ) {
                nextCache.set(ide.id, cached)
                nextConversations.push(...cached.conversations)
                continue
            }

            const conversations = buildScopedIdeConversations(ide, {
                machineNames,
                connectionStates,
                defaultConnectionState: 'new',
            })
            const entry: ConversationCacheEntry = {
                ide,
                sourceSignature,
                connectionState,
                machineName,
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
    }, [chatIdes, connectionStates, machineNames])

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
            const preferred = preferredConversationByIdeId.get(conversation.routeId)
            const sessionTarget = conversation.streamSource === 'native' && preferred ? preferred : conversation
            for (const lookupKey of buildConversationLookupKeys({
                providerSessionId: conversation.providerSessionId,
                sessionId: conversation.sessionId,
            })) {
                map.set(lookupKey, sessionTarget)
            }
        }
        return map
    }, [conversations, preferredConversationByIdeId])
    const conversationTargetMap = useMemo(() => {
        return buildConversationTargetMap(conversations, preferredConversationByIdeId)
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
        const next = conversations.filter(conversation => !isConversationHidden(hiddenTabs, conversation))
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
