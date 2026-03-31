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
}
