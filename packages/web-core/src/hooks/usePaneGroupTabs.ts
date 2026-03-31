import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'

interface UsePaneGroupTabsOptions {
    conversations: ActiveConversation[]
    initialActiveTabId?: string | null
    initialTabOrder?: string[]
    onActiveTabChange?: (tabKey: string | null) => void
    onTabOrderChange?: (order: string[]) => void
}

function mergeTabOrder(prev: string[], conversations: ActiveConversation[]) {
    const currentKeys = new Set(conversations.map(conversation => conversation.tabKey))
    const existing = prev.filter(tabKey => currentKeys.has(tabKey))
    const newKeys = conversations
        .filter(conversation => !prev.includes(conversation.tabKey))
        .map(conversation => conversation.tabKey)
    return [...existing, ...newKeys]
}

export function usePaneGroupTabs({
    conversations,
    initialActiveTabId,
    initialTabOrder,
    onActiveTabChange,
    onTabOrderChange,
}: UsePaneGroupTabsOptions) {
    const [activeTabId, setActiveTabId] = useState<string | null>(initialActiveTabId ?? null)
    const [tabOrder, setTabOrder] = useState<string[]>(initialTabOrder ?? [])
    const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
    const previewOrderRef = useRef<string[] | null>(null)
    const draggingTabRef = useRef<string | null>(null)

    useEffect(() => {
        if (initialActiveTabId && initialActiveTabId !== activeTabId) {
            setActiveTabId(initialActiveTabId)
        }
    }, [initialActiveTabId, activeTabId])

    useEffect(() => {
        setTabOrder(prev => {
            const next = mergeTabOrder(prev, conversations)
            if (next.length === prev.length && next.every((tabKey, index) => tabKey === prev[index])) {
                return prev
            }
            return next
        })
    }, [conversations])

    const sortedConversations = useMemo(() => {
        const displayOrder = previewOrder ?? tabOrder
        if (displayOrder.length === 0) return conversations

        const orderMap = new Map(displayOrder.map((tabKey, index) => [tabKey, index]))
        return [...conversations].sort((left, right) => {
            const leftIndex = orderMap.get(left.tabKey) ?? 999
            const rightIndex = orderMap.get(right.tabKey) ?? 999
            return leftIndex - rightIndex
        })
    }, [conversations, previewOrder, tabOrder])

    useEffect(() => {
        if (sortedConversations.length === 0) {
            setActiveTabId(null)
            onActiveTabChange?.(null)
            return
        }

        if (activeTabId && sortedConversations.some(conversation => conversation.tabKey === activeTabId)) {
            return
        }

        const nextTabKey = sortedConversations[0].tabKey
        setActiveTabId(nextTabKey)
        onActiveTabChange?.(nextTabKey)
    }, [sortedConversations, activeTabId, onActiveTabChange])

    const activeConv = useMemo(
        () => sortedConversations.find(conversation => conversation.tabKey === activeTabId),
        [sortedConversations, activeTabId],
    )

    const selectTab = useCallback((tabKey: string) => {
        setActiveTabId(tabKey)
        onActiveTabChange?.(tabKey)
    }, [onActiveTabChange])

    const handleTabReorder = useCallback((draggedKey: string, targetKey: string, side: 'left' | 'right') => {
        setTabOrder(prev => {
            const next = prev.filter(tabKey => tabKey !== draggedKey)
            const targetIndex = next.indexOf(targetKey)
            if (targetIndex < 0) return prev

            const insertIndex = side === 'left' ? targetIndex : targetIndex + 1
            next.splice(insertIndex, 0, draggedKey)
            onTabOrderChange?.(next)
            return next
        })
        setPreviewOrder(null)
    }, [onTabOrderChange])

    const updatePreviewOrder = useCallback((draggedKey: string, targetKey: string, side: 'left' | 'right') => {
        const base = tabOrder.length > 0 ? tabOrder : conversations.map(conversation => conversation.tabKey)
        const next = base.filter(tabKey => tabKey !== draggedKey)
        const targetIndex = next.indexOf(targetKey)
        if (targetIndex < 0) return

        const insertIndex = side === 'left' ? targetIndex : targetIndex + 1
        next.splice(insertIndex, 0, draggedKey)
        previewOrderRef.current = next
        setPreviewOrder(next)
    }, [tabOrder, conversations])

    const commitPreviewOrder = useCallback(() => {
        const orderToCommit = previewOrderRef.current
        if (!orderToCommit) return

        setTabOrder(orderToCommit)
        onTabOrderChange?.(orderToCommit)
    }, [onTabOrderChange])

    const clearPreviewOrder = useCallback(() => {
        previewOrderRef.current = null
        setPreviewOrder(null)
    }, [])

    const moveTabToEnd = useCallback((tabKey: string) => {
        setTabOrder(prev => {
            const next = prev.filter(key => key !== tabKey)
            next.push(tabKey)
            onTabOrderChange?.(next)
            return next
        })
    }, [onTabOrderChange])

    return {
        activeTabId,
        activeConv,
        sortedConversations,
        previewOrderRef,
        draggingTabRef,
        selectTab,
        handleTabReorder,
        updatePreviewOrder,
        commitPreviewOrder,
        clearPreviewOrder,
        moveTabToEnd,
        setDraggingTabKey: (tabKey: string | null) => {
            draggingTabRef.current = tabKey
        },
    }
}
