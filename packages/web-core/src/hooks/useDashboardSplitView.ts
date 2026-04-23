import { useCallback, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import type { ActiveConversation } from '../components/dashboard/types'
import {
    arraysEqual,
    deriveNormalizedGroupLayout,
    indexedRecordEqual,
    mapsEqual,
    normalizeGroupSizes,
    remapFocusedGroup,
    remapIndexedRecord,
} from '../components/dashboard/groupLayout'

interface UseDashboardSplitViewOptions {
    groupAssignments: Map<string, number>
    updateGroupAssignments: (next: Map<string, number> | ((prev: Map<string, number>) => Map<string, number>)) => void
    updateFocusedGroup: (next: number | ((prev: number) => number)) => void
    updateGroupActiveTabIds: (
        next: Record<number, string | null> | ((prev: Record<number, string | null>) => Record<number, string | null>),
    ) => void
    updateGroupTabOrders: (
        next: Record<number, string[]> | ((prev: Record<number, string[]>) => Record<number, string[]>),
    ) => void
    groupSizes: number[]
    updateGroupSizes: (next: number[] | ((prev: number[]) => number[])) => void
    isMobile: boolean
    visibleConversations: ActiveConversation[]
    visibleTabKeys: string[]
}

function shiftIndexedRecordRight<T>(prev: Record<number, T>, insertIndex: number) {
    const next: Record<number, T> = {}
    for (const [key, value] of Object.entries(prev)) {
        const idx = Number(key)
        next[idx >= insertIndex ? idx + 1 : idx] = value
    }
    return next
}

function buildDefaultSizes(count: number) {
    return Array(count).fill(100 / count)
}

export function useDashboardSplitView({
    groupAssignments,
    updateGroupAssignments,
    updateFocusedGroup,
    updateGroupActiveTabIds,
    updateGroupTabOrders,
    groupSizes,
    updateGroupSizes,
    isMobile,
    visibleConversations,
    visibleTabKeys,
}: UseDashboardSplitViewOptions) {
    const containerRef = useRef<HTMLDivElement>(null)

    const normalizedGroupLayout = useMemo(
        () => deriveNormalizedGroupLayout(groupAssignments, visibleTabKeys),
        [groupAssignments, visibleTabKeys],
    )
    const normalizedGroupAssignments = normalizedGroupLayout.assignments

    const numGroups = useMemo(() => {
        if (isMobile) return 1
        return normalizedGroupLayout.groupCount
    }, [normalizedGroupLayout.groupCount, isMobile])

    const isSplitMode = numGroups > 1

    const moveTabToGroup = useCallback((tabKey: string, targetGroup: number) => {
        updateGroupAssignments(prev => {
            const next = new Map(deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments)
            if (targetGroup === 0) next.delete(tabKey)
            else next.set(tabKey, targetGroup)
            return next
        })
        updateGroupActiveTabIds(prev => ({ ...prev, [targetGroup]: tabKey }))
        updateFocusedGroup(targetGroup)
    }, [updateGroupAssignments, visibleTabKeys, updateGroupActiveTabIds, updateFocusedGroup])

    const closeGroup = useCallback((groupIdx: number) => {
        updateGroupAssignments(prev => {
            const current = deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments
            const next = new Map<string, number>()
            for (const [key, g] of current) {
                if (g === groupIdx) continue
                if (g > groupIdx) next.set(key, g - 1)
                else next.set(key, g)
            }
            return next
        })
        updateGroupSizes(prev => {
            if (prev.length <= 1) return []
            const next = [...prev]
            next.splice(groupIdx, 1)
            const total = next.reduce((sum, size) => sum + size, 0)
            return total > 0 ? next.map(size => (size / total) * 100) : []
        })
        updateFocusedGroup(0)
    }, [updateGroupAssignments, visibleTabKeys, updateGroupSizes, updateFocusedGroup])

    const handleResizeStart = useCallback((dividerIdx: number, e: ReactMouseEvent) => {
        e.preventDefault()
        const container = containerRef.current
        if (!container) return

        const startX = e.clientX
        const totalWidth = container.offsetWidth
        const startSizes = groupSizes.length === numGroups
            ? [...groupSizes]
            : buildDefaultSizes(numGroups)

        const onMove = (ev: MouseEvent) => {
            const dx = ev.clientX - startX
            const pctDelta = (dx / totalWidth) * 100
            const next = [...startSizes]
            next[dividerIdx] = Math.max(15, startSizes[dividerIdx] + pctDelta)
            next[dividerIdx + 1] = Math.max(15, startSizes[dividerIdx + 1] - pctDelta)
            updateGroupSizes(next)
        }

        const onUp = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
        }

        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
    }, [groupSizes, numGroups, updateGroupSizes])

    const splitTabRelative = useCallback((tabKey: string, targetGroup: number, side: 'left' | 'right') => {
        if (numGroups >= 4) return

        const insertIndex = side === 'left' ? targetGroup : targetGroup + 1

        updateGroupAssignments(prev => {
            const current = deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments
            const next = new Map<string, number>()
            for (const conv of visibleConversations) {
                const currentGroup = current.get(conv.tabKey) ?? 0
                const shiftedGroup = currentGroup >= insertIndex ? currentGroup + 1 : currentGroup
                if (shiftedGroup > 0) next.set(conv.tabKey, shiftedGroup)
            }
            if (insertIndex > 0) next.set(tabKey, insertIndex)
            return next
        })

        updateGroupSizes(prev => {
            const base = prev.length === numGroups ? [...prev] : buildDefaultSizes(numGroups)
            const targetSize = base[targetGroup] ?? (100 / numGroups)
            const kept = Math.max(15, targetSize / 2)
            const inserted = Math.max(15, targetSize / 2)
            const next = [...base]
            next[targetGroup] = kept
            next.splice(insertIndex, 0, inserted)
            const total = next.reduce((sum, size) => sum + size, 0)
            return next.map(size => (size / total) * 100)
        })

        updateGroupActiveTabIds(prev => {
            const next = shiftIndexedRecordRight(prev, insertIndex)
            next[insertIndex] = tabKey
            return next
        })

        updateGroupTabOrders(prev => {
            const next = shiftIndexedRecordRight(prev, insertIndex)
            next[insertIndex] = [tabKey]
            return next
        })

        updateFocusedGroup(insertIndex)
    }, [
        numGroups,
        updateGroupAssignments,
        visibleTabKeys,
        visibleConversations,
        updateGroupSizes,
        updateGroupActiveTabIds,
        updateGroupTabOrders,
        updateFocusedGroup,
    ])

    useEffect(() => {
        if (mapsEqual(groupAssignments, normalizedGroupAssignments)) return
        updateGroupAssignments(normalizedGroupAssignments)
    }, [groupAssignments, normalizedGroupAssignments, updateGroupAssignments])

    useEffect(() => {
        const { mapping, usedGroups } = normalizedGroupLayout

        updateGroupActiveTabIds(prev => {
            const next = remapIndexedRecord(prev, mapping)
            return indexedRecordEqual(prev, next) ? prev : next
        })

        updateGroupTabOrders(prev => {
            const next = remapIndexedRecord(prev, mapping)
            return indexedRecordEqual(prev, next) ? prev : next
        })

        updateFocusedGroup(prev => {
            const next = isMobile ? 0 : remapFocusedGroup(prev, usedGroups, mapping)
            return prev === next ? prev : next
        })

        updateGroupSizes(prev => {
            const next = isMobile ? [] : normalizeGroupSizes(prev, usedGroups, normalizedGroupLayout.groupCount)
            return arraysEqual(prev, next) ? prev : next
        })
    }, [
        normalizedGroupLayout,
        isMobile,
        updateGroupActiveTabIds,
        updateGroupTabOrders,
        updateFocusedGroup,
        updateGroupSizes,
    ])

    const groupedConvs = useMemo(() => {
        const groups: ActiveConversation[][] = Array.from({ length: numGroups }, () => [])
        for (const conv of visibleConversations) {
            const g = normalizedGroupAssignments.get(conv.tabKey) ?? 0
            const idx = Math.min(g, numGroups - 1)
            groups[idx].push(conv)
        }
        return groups
    }, [visibleConversations, normalizedGroupAssignments, numGroups])

    const clearAllSplits = useCallback(() => {
        updateGroupAssignments(new Map())
        updateFocusedGroup(0)
    }, [updateGroupAssignments, updateFocusedGroup])

    return {
        containerRef,
        normalizedGroupAssignments,
        numGroups,
        isSplitMode,
        groupedConvs,
        moveTabToGroup,
        closeGroup,
        handleResizeStart,
        splitTabRelative,
        clearAllSplits,
    }
}
