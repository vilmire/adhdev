import { useCallback, useEffect, useState } from 'react'
import {
    type DashboardLayoutProfile,
    getDashboardLayoutProfile,
    getEmptyDashboardStoredLayout,
    readDashboardStoredLayout,
    writeDashboardStoredLayout,
} from '../utils/dashboardLayoutStorage'

function sameIndexedTabOrder(current: string[] | undefined, next: string[]) {
    if (!current) return next.length === 0
    return current.length === next.length && current.every((tabKey, index) => tabKey === next[index])
}

export function useDashboardGroupState() {
    const [layoutProfile] = useState(() =>
        getDashboardLayoutProfile(typeof window !== 'undefined' ? window.innerWidth : 1280)
    )
    const [groupAssignments, setGroupAssignments] = useState<Map<string, number>>(() => new Map())
    const [focusedGroup, setFocusedGroup] = useState(0)
    const [groupActiveTabIds, setGroupActiveTabIds] = useState<Record<number, string | null>>({})
    const [groupTabOrders, setGroupTabOrders] = useState<Record<number, string[]>>({})
    const [groupSizes, setGroupSizes] = useState<number[]>([])
    const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)
    const [hasHydratedStoredLayout, setHasHydratedStoredLayout] = useState(false)

    const hydrateStoredLayout = useCallback(() => {
        if (hasHydratedStoredLayout) return

        const stored = readDashboardStoredLayout(layoutProfile) ?? getEmptyDashboardStoredLayout()
        setGroupAssignments(new Map(stored.groupAssignments))
        setFocusedGroup(stored.focusedGroup)
        setGroupActiveTabIds(stored.groupActiveTabIds)
        setGroupTabOrders(stored.groupTabOrders)
        setGroupSizes(stored.groupSizes)
        setHasHydratedStoredLayout(true)
    }, [hasHydratedStoredLayout, layoutProfile])

    useEffect(() => {
        if (!hasHydratedStoredLayout) return
        writeDashboardStoredLayout(layoutProfile, {
            groupAssignments: [...groupAssignments.entries()],
            focusedGroup,
            groupActiveTabIds,
            groupTabOrders,
            groupSizes,
        })
    }, [
        hasHydratedStoredLayout,
        layoutProfile,
        groupAssignments,
        focusedGroup,
        groupActiveTabIds,
        groupTabOrders,
        groupSizes,
    ])

    useEffect(() => {
        const mq = window.matchMedia('(max-width: 767px)')
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
        mq.addEventListener('change', handler)
        return () => mq.removeEventListener('change', handler)
    }, [])

    const updateGroupAssignments = useCallback((next: Map<string, number> | ((prev: Map<string, number>) => Map<string, number>)) => {
        setGroupAssignments(next)
    }, [])

    const updateFocusedGroup = useCallback((next: number | ((prev: number) => number)) => {
        setFocusedGroup(next)
    }, [])

    const updateGroupActiveTabIds = useCallback((
        next: Record<number, string | null> | ((prev: Record<number, string | null>) => Record<number, string | null>),
    ) => {
        setGroupActiveTabIds(next)
    }, [])

    const updateGroupTabOrders = useCallback((
        next: Record<number, string[]> | ((prev: Record<number, string[]>) => Record<number, string[]>),
    ) => {
        setGroupTabOrders(next)
    }, [])

    const updateGroupSizes = useCallback((next: number[] | ((prev: number[]) => number[])) => {
        setGroupSizes(next)
    }, [])

    const focusGroup = useCallback((groupIndex: number) => {
        updateFocusedGroup(groupIndex)
    }, [updateFocusedGroup])

    const setGroupActiveTab = useCallback((groupIndex: number, tabKey: string | null) => {
        setGroupActiveTabIds(prev => {
            if ((prev[groupIndex] ?? null) === (tabKey ?? null)) return prev
            return { ...prev, [groupIndex]: tabKey }
        })
    }, [])

    const setGroupTabOrder = useCallback((groupIndex: number, order: string[]) => {
        setGroupTabOrders(prev => {
            const current = prev[groupIndex]
            if (sameIndexedTabOrder(current, order)) return prev
            return { ...prev, [groupIndex]: order }
        })
    }, [])

    const focusConversationTab = useCallback((tabKey: string, groupAssignments: Map<string, number>) => {
        const targetGroup = groupAssignments.get(tabKey) ?? 0
        setGroupActiveTab(targetGroup, tabKey)
        focusGroup(targetGroup)
        return targetGroup
    }, [focusGroup, setGroupActiveTab])

    return {
        layoutProfile: layoutProfile as DashboardLayoutProfile,
        groupAssignments,
        updateGroupAssignments,
        focusedGroup,
        updateFocusedGroup,
        focusGroup,
        groupActiveTabIds,
        updateGroupActiveTabIds,
        setGroupActiveTab,
        groupTabOrders,
        updateGroupTabOrders,
        setGroupTabOrder,
        groupSizes,
        updateGroupSizes,
        isMobile,
        hasHydratedStoredLayout,
        hydrateStoredLayout,
        focusConversationTab,
    }
}
