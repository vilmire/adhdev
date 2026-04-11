import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'

function isLikelyCollapsedHistoryResult(
    chats: DaemonData['chats'] | undefined,
    activeConv: ActiveConversation | undefined,
) {
    if (!Array.isArray(chats) || chats.length !== 1 || !activeConv) return false
    const onlyChat = chats[0]
    const activeIds = [activeConv.providerSessionId, activeConv.sessionId].filter((value): value is string => typeof value === 'string' && value.length > 0)
    return typeof onlyChat?.id === 'string' && activeIds.includes(onlyChat.id)
}

interface UseDashboardPageEffectsOptions {
    urlActiveTab: string | null
    conversations: ActiveConversation[]
    resolveConversationBySessionId: (sessionId: string | null | undefined) => ActiveConversation | undefined
    normalizedGroupAssignments: Map<string, number>
    hasHydratedStoredLayout: boolean
    hydrateStoredLayout: () => void
    setGroupActiveTabIds: Dispatch<SetStateAction<Record<number, string | null>>>
    setFocusedGroup: Dispatch<SetStateAction<number>>
    setSearchParams: SetURLSearchParams
    historyModalOpen: boolean
    activeConv: ActiveConversation | undefined
    isRefreshingHistory: boolean
    ides: DaemonData[]
    handleRefreshHistory: () => void | Promise<void>
}

export function useDashboardPageEffects({
    urlActiveTab,
    conversations,
    resolveConversationBySessionId,
    normalizedGroupAssignments,
    hasHydratedStoredLayout,
    hydrateStoredLayout,
    setGroupActiveTabIds,
    setFocusedGroup,
    setSearchParams,
    historyModalOpen,
    activeConv,
    isRefreshingHistory,
    ides,
    handleRefreshHistory,
}: UseDashboardPageEffectsOptions) {
    const urlTabAppliedRef = useRef(false)
    const initialLayoutAppliedRef = useRef(false)
    const urlFallbackTimerRef = useRef<number | null>(null)
    const historyRefreshedRef = useRef(false)

    useEffect(() => {
        if (!urlActiveTab || urlTabAppliedRef.current || conversations.length === 0) return

        if (!hasHydratedStoredLayout) {
            hydrateStoredLayout()
            return
        }

        const match = resolveConversationBySessionId(urlActiveTab)
        if (!match) return

        const targetGroup = normalizedGroupAssignments.get(match.tabKey) ?? 0
        setGroupActiveTabIds(prev => ({ ...prev, [targetGroup]: match.tabKey }))
        setFocusedGroup(targetGroup)
        urlTabAppliedRef.current = true
        initialLayoutAppliedRef.current = true

        if (urlFallbackTimerRef.current != null) {
            window.clearTimeout(urlFallbackTimerRef.current)
            urlFallbackTimerRef.current = null
        }

        setSearchParams(prev => {
            const next = new URLSearchParams(prev)
            next.delete('activeTab')
            return next
        }, { replace: true })
    }, [
        urlActiveTab,
        conversations,
        resolveConversationBySessionId,
        normalizedGroupAssignments,
        hasHydratedStoredLayout,
        hydrateStoredLayout,
        setGroupActiveTabIds,
        setFocusedGroup,
        setSearchParams,
    ])

    useEffect(() => {
        if (initialLayoutAppliedRef.current || hasHydratedStoredLayout) return
        if (conversations.length === 0) return

        if (!urlActiveTab) {
            hydrateStoredLayout()
            initialLayoutAppliedRef.current = true
            return
        }

        if (urlTabAppliedRef.current) {
            initialLayoutAppliedRef.current = true
            return
        }

        if (urlFallbackTimerRef.current != null) return
        urlFallbackTimerRef.current = window.setTimeout(() => {
            urlFallbackTimerRef.current = null
            if (initialLayoutAppliedRef.current || hasHydratedStoredLayout) return
            hydrateStoredLayout()
            initialLayoutAppliedRef.current = true
        }, 1500)

        return () => {
            if (urlFallbackTimerRef.current != null) {
                window.clearTimeout(urlFallbackTimerRef.current)
                urlFallbackTimerRef.current = null
            }
        }
    }, [
        urlActiveTab,
        conversations.length,
        hasHydratedStoredLayout,
        hydrateStoredLayout,
    ])

    useEffect(() => {
        if (!historyModalOpen) {
            historyRefreshedRef.current = false
            return
        }
        if (!activeConv || historyRefreshedRef.current || isRefreshingHistory) return

        const ide = ides.find(entry => entry.id === activeConv.routeId)
        if (ide && (!ide.chats || ide.chats.length === 0 || isLikelyCollapsedHistoryResult(ide.chats, activeConv))) {
            historyRefreshedRef.current = true
            void handleRefreshHistory()
        }
    }, [historyModalOpen, activeConv, isRefreshingHistory, ides, handleRefreshHistory])

    useEffect(() => {
        if (!activeConv) return

        let frame: number | null = null
        let attempts = 0
        let lastTotalHeight = -1
        let stableFrames = 0

        const scrollVisibleChatsToBottom = () => {
            frame = null
            const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-scroll]'))
                .filter(el => el.offsetParent !== null)

            if (containers.length === 0) {
                if (attempts < 18) {
                    attempts += 1
                    frame = requestAnimationFrame(scrollVisibleChatsToBottom)
                }
                return
            }

            let totalHeight = 0
            for (const el of containers) {
                el.scrollTop = el.scrollHeight
                totalHeight += el.scrollHeight
            }

            if (totalHeight === lastTotalHeight) {
                stableFrames += 1
            } else {
                stableFrames = 0
                lastTotalHeight = totalHeight
            }

            attempts += 1
            if (stableFrames >= 2 || attempts >= 18) return
            frame = requestAnimationFrame(scrollVisibleChatsToBottom)
        }

        frame = requestAnimationFrame(scrollVisibleChatsToBottom)
        return () => {
            if (frame != null) cancelAnimationFrame(frame)
        }
    }, [activeConv?.tabKey])
}
