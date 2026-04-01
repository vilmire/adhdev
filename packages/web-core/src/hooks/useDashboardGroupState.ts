import { useCallback, useEffect, useState } from 'react'
import {
    getDashboardLayoutProfile,
    getEmptyDashboardStoredLayout,
    readDashboardStoredLayout,
    writeDashboardStoredLayout,
} from '../utils/dashboardLayoutStorage'

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

    return {
        groupAssignments,
        setGroupAssignments,
        focusedGroup,
        setFocusedGroup,
        groupActiveTabIds,
        setGroupActiveTabIds,
        groupTabOrders,
        setGroupTabOrders,
        groupSizes,
        setGroupSizes,
        isMobile,
        hasHydratedStoredLayout,
        hydrateStoredLayout,
    }
}
