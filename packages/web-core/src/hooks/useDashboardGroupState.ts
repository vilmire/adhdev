import { useEffect, useState } from 'react'

const STORAGE_KEYS = {
    splitGroups: 'adhdev_splitGroups',
    focusedGroup: 'adhdev_focusedGroup',
    groupActiveTabs: 'adhdev_groupActiveTabs',
    groupTabOrders: 'adhdev_groupTabOrders',
    splitSizes: 'adhdev_splitSizes',
} as const

function readJsonStorage<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) as T : fallback
    } catch {
        return fallback
    }
}

function writeStorage(key: string, value: string | null) {
    try {
        if (value == null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
    } catch { /* noop */ }
}

export function useDashboardGroupState() {
    const [groupAssignments, setGroupAssignments] = useState<Map<string, number>>(() => {
        const entries = readJsonStorage<[string, number][]>(STORAGE_KEYS.splitGroups, [])
        return new Map(entries)
    })
    const [focusedGroup, setFocusedGroup] = useState(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.focusedGroup)
            if (saved) return parseInt(saved, 10) || 0
        } catch { /* noop */ }
        return 0
    })
    const [groupActiveTabIds, setGroupActiveTabIds] = useState<Record<number, string | null>>(() =>
        readJsonStorage<Record<number, string | null>>(STORAGE_KEYS.groupActiveTabs, {})
    )
    const [groupTabOrders, setGroupTabOrders] = useState<Record<number, string[]>>(() =>
        readJsonStorage<Record<number, string[]>>(STORAGE_KEYS.groupTabOrders, {})
    )
    const [groupSizes, setGroupSizes] = useState<number[]>(() =>
        readJsonStorage<number[]>(STORAGE_KEYS.splitSizes, [])
    )
    const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)

    useEffect(() => {
        writeStorage(
            STORAGE_KEYS.splitGroups,
            groupAssignments.size === 0 ? null : JSON.stringify([...groupAssignments.entries()]),
        )
    }, [groupAssignments])

    useEffect(() => {
        writeStorage(
            STORAGE_KEYS.splitSizes,
            groupSizes.length > 0 ? JSON.stringify(groupSizes) : null,
        )
    }, [groupSizes])

    useEffect(() => {
        writeStorage(STORAGE_KEYS.focusedGroup, String(focusedGroup))
    }, [focusedGroup])

    useEffect(() => {
        writeStorage(STORAGE_KEYS.groupActiveTabs, JSON.stringify(groupActiveTabIds))
    }, [groupActiveTabIds])

    useEffect(() => {
        writeStorage(STORAGE_KEYS.groupTabOrders, JSON.stringify(groupTabOrders))
    }, [groupTabOrders])

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
    }
}
