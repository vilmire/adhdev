import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import type { ActiveConversation } from '../components/dashboard/types'
import type { DaemonData } from '../types'

interface UseDashboardPageEffectsOptions {
    urlActiveTab: string | null
    conversations: ActiveConversation[]
    resolveConversationByTarget: (target: string | null | undefined) => ActiveConversation | undefined
    normalizedGroupAssignments: Map<string, number>
    setGroupActiveTabIds: Dispatch<SetStateAction<Record<number, string | null>>>
    setFocusedGroup: Dispatch<SetStateAction<number>>
    setSearchParams: SetURLSearchParams
    historyModalOpen: boolean
    activeConv: ActiveConversation | undefined
    isRefreshingHistory: boolean
    ides: DaemonData[]
    handleRefreshHistory: () => void | Promise<void>
    isSplitMode: boolean
    splitTabRelative: (tabKey: string, targetGroup: number, side: 'left' | 'right') => void
    numGroups: number
    clearAllSplits: () => void
}

export function useDashboardPageEffects({
    urlActiveTab,
    conversations,
    resolveConversationByTarget,
    normalizedGroupAssignments,
    setGroupActiveTabIds,
    setFocusedGroup,
    setSearchParams,
    historyModalOpen,
    activeConv,
    isRefreshingHistory,
    ides,
    handleRefreshHistory,
    isSplitMode,
    splitTabRelative,
    numGroups,
    clearAllSplits,
}: UseDashboardPageEffectsOptions) {
    const urlTabAppliedRef = useRef(false)
    const historyRefreshedRef = useRef(false)

    useEffect(() => {
        if (!urlActiveTab || urlTabAppliedRef.current || conversations.length === 0) return

        const match = resolveConversationByTarget(urlActiveTab)
        if (!match) return

        const targetGroup = normalizedGroupAssignments.get(match.tabKey) ?? 0
        setGroupActiveTabIds(prev => ({ ...prev, [targetGroup]: match.tabKey }))
        setFocusedGroup(targetGroup)
        urlTabAppliedRef.current = true

        setSearchParams(prev => {
            const next = new URLSearchParams(prev)
            next.delete('activeTab')
            return next
        }, { replace: true })
    }, [
        urlActiveTab,
        conversations,
        resolveConversationByTarget,
        normalizedGroupAssignments,
        setGroupActiveTabIds,
        setFocusedGroup,
        setSearchParams,
    ])

    useEffect(() => {
        if (!historyModalOpen) {
            historyRefreshedRef.current = false
            return
        }
        if (!activeConv || historyRefreshedRef.current || isRefreshingHistory) return

        const ide = ides.find(entry => entry.id === activeConv.ideId)
        if (ide && (!ide.chats || ide.chats.length === 0)) {
            historyRefreshedRef.current = true
            void handleRefreshHistory()
        }
    }, [historyModalOpen, activeConv, isRefreshingHistory, ides, handleRefreshHistory])

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (event.ctrlKey && event.key === '\\') {
                event.preventDefault()
                if (isSplitMode) {
                    clearAllSplits()
                } else {
                    const second = conversations[1]
                    if (second) splitTabRelative(second.tabKey, 0, 'right')
                }
                return
            }

            if (event.ctrlKey && (event.key === '[' || event.key === ']') && isSplitMode) {
                event.preventDefault()
                setFocusedGroup(prev => {
                    if (event.key === ']') return Math.min(prev + 1, numGroups - 1)
                    return Math.max(prev - 1, 0)
                })
            }
        }

        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [isSplitMode, conversations, splitTabRelative, numGroups, clearAllSplits, setFocusedGroup])

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
