import type { SerializedDockview } from 'dockview'

export type DashboardLayoutProfile = 'desktop-wide' | 'desktop-narrow' | 'mobile'

export interface DashboardStoredLayout {
    groupAssignments: [string, number][]
    focusedGroup: number
    groupActiveTabIds: Record<number, string | null>
    groupTabOrders: Record<number, string[]>
    groupSizes: number[]
}

export interface DashboardStoredDockviewLayout {
    activeTabId?: string | null
    layout: SerializedDockview
}

const STORAGE_PREFIX = 'adhdev_dashboardLayout_v1'
const DOCKVIEW_STORAGE_PREFIX = 'adhdev_dashboardDockview_v1'

const EMPTY_LAYOUT: DashboardStoredLayout = {
    groupAssignments: [],
    focusedGroup: 0,
    groupActiveTabIds: {},
    groupTabOrders: {},
    groupSizes: [],
}

function safeRead<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) as T : fallback
    } catch {
        return fallback
    }
}

export function getDashboardLayoutProfile(width: number): DashboardLayoutProfile {
    if (width < 768) return 'mobile'
    if (width < 1280) return 'desktop-narrow'
    return 'desktop-wide'
}

export function getDashboardLayoutStorageKey(profile: DashboardLayoutProfile) {
    return `${STORAGE_PREFIX}:${profile}`
}

export function readDashboardStoredLayout(profile: DashboardLayoutProfile): DashboardStoredLayout | null {
    const key = getDashboardLayoutStorageKey(profile)
    return safeRead<DashboardStoredLayout | null>(key, null)
}

export function writeDashboardStoredLayout(
    profile: DashboardLayoutProfile,
    layout: DashboardStoredLayout,
) {
    try {
        const isEmpty = (
            layout.groupAssignments.length === 0 &&
            layout.focusedGroup === 0 &&
            Object.keys(layout.groupActiveTabIds).length === 0 &&
            Object.keys(layout.groupTabOrders).length === 0 &&
            layout.groupSizes.length === 0
        )

        const key = getDashboardLayoutStorageKey(profile)
        if (isEmpty) {
            localStorage.removeItem(key)
            return
        }

        localStorage.setItem(key, JSON.stringify(layout))
    } catch {
        // noop
    }
}

export function getDashboardDockviewStorageKey(profile: DashboardLayoutProfile) {
    return `${DOCKVIEW_STORAGE_PREFIX}:${profile}`
}

export function readDashboardDockviewStoredLayout(profile: DashboardLayoutProfile): DashboardStoredDockviewLayout | null {
    const key = getDashboardDockviewStorageKey(profile)
    return safeRead<DashboardStoredDockviewLayout | null>(key, null)
}

export function writeDashboardDockviewStoredLayout(
    profile: DashboardLayoutProfile,
    layout: DashboardStoredDockviewLayout | null,
) {
    try {
        const key = getDashboardDockviewStorageKey(profile)
        if (!layout) {
            localStorage.removeItem(key)
            return
        }
        localStorage.setItem(key, JSON.stringify(layout))
    } catch {
        // noop
    }
}

export function getEmptyDashboardStoredLayout(): DashboardStoredLayout {
    return {
        groupAssignments: [...EMPTY_LAYOUT.groupAssignments],
        focusedGroup: EMPTY_LAYOUT.focusedGroup,
        groupActiveTabIds: { ...EMPTY_LAYOUT.groupActiveTabIds },
        groupTabOrders: { ...EMPTY_LAYOUT.groupTabOrders },
        groupSizes: [...EMPTY_LAYOUT.groupSizes],
    }
}
