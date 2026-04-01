export type DashboardLayoutProfile = 'desktop-wide' | 'desktop-narrow' | 'mobile'

export interface DashboardStoredLayout {
    groupAssignments: [string, number][]
    focusedGroup: number
    groupActiveTabIds: Record<number, string | null>
    groupTabOrders: Record<number, string[]>
    groupSizes: number[]
}

const STORAGE_PREFIX = 'adhdev_dashboardLayout_v1'
const LEGACY_KEYS = {
    splitGroups: 'adhdev_splitGroups',
    focusedGroup: 'adhdev_focusedGroup',
    groupActiveTabs: 'adhdev_groupActiveTabs',
    groupTabOrders: 'adhdev_groupTabOrders',
    splitSizes: 'adhdev_splitSizes',
} as const

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

function safeReadString(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
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

function readLegacyDashboardLayout(): DashboardStoredLayout | null {
    const focusedGroupRaw = safeReadString(LEGACY_KEYS.focusedGroup)
    const groupAssignments = safeRead<[string, number][]>(LEGACY_KEYS.splitGroups, [])
    const groupActiveTabIds = safeRead<Record<number, string | null>>(LEGACY_KEYS.groupActiveTabs, {})
    const groupTabOrders = safeRead<Record<number, string[]>>(LEGACY_KEYS.groupTabOrders, {})
    const groupSizes = safeRead<number[]>(LEGACY_KEYS.splitSizes, [])

    const hasData = (
        focusedGroupRaw !== null ||
        groupAssignments.length > 0 ||
        Object.keys(groupActiveTabIds).length > 0 ||
        Object.keys(groupTabOrders).length > 0 ||
        groupSizes.length > 0
    )

    if (!hasData) return null

    return {
        groupAssignments,
        focusedGroup: focusedGroupRaw ? parseInt(focusedGroupRaw, 10) || 0 : 0,
        groupActiveTabIds,
        groupTabOrders,
        groupSizes,
    }
}

export function readDashboardStoredLayout(profile: DashboardLayoutProfile): DashboardStoredLayout | null {
    const key = getDashboardLayoutStorageKey(profile)
    const stored = safeRead<DashboardStoredLayout | null>(key, null)
    if (stored) return stored
    return readLegacyDashboardLayout()
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

export function getEmptyDashboardStoredLayout(): DashboardStoredLayout {
    return {
        groupAssignments: [...EMPTY_LAYOUT.groupAssignments],
        focusedGroup: EMPTY_LAYOUT.focusedGroup,
        groupActiveTabIds: { ...EMPTY_LAYOUT.groupActiveTabIds },
        groupTabOrders: { ...EMPTY_LAYOUT.groupTabOrders },
        groupSizes: [...EMPTY_LAYOUT.groupSizes],
    }
}
