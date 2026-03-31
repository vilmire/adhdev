import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
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
    setGroupAssignments: Dispatch<SetStateAction<Map<string, number>>>
    focusedGroup: number
    setFocusedGroup: Dispatch<SetStateAction<number>>
    setGroupActiveTabIds: Dispatch<SetStateAction<Record<number, string | null>>>
    setGroupTabOrders: Dispatch<SetStateAction<Record<number, string[]>>>
    groupSizes: number[]
    setGroupSizes: Dispatch<SetStateAction<number[]>>
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
    setGroupAssignments,
    setFocusedGroup,
    setGroupActiveTabIds,
    setGroupTabOrders,
    groupSizes,
    setGroupSizes,
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
        setGroupAssignments(prev => {
            const next = new Map(deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments)
            if (targetGroup === 0) next.delete(tabKey)
            else next.set(tabKey, targetGroup)
            return next
        })
        setGroupActiveTabIds(prev => ({ ...prev, [targetGroup]: tabKey }))
        setFocusedGroup(targetGroup)
    }, [setGroupAssignments, visibleTabKeys, setGroupActiveTabIds, setFocusedGroup])

    const closeGroup = useCallback((groupIdx: number) => {
        setGroupAssignments(prev => {
            const current = deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments
            const next = new Map<string, number>()
            for (const [key, g] of current) {
                if (g === groupIdx) continue
                if (g > groupIdx) next.set(key, g - 1)
                else next.set(key, g)
            }
            return next
        })
        setGroupSizes(prev => {
            if (prev.length <= 1) return []
            const next = [...prev]
            next.splice(groupIdx, 1)
            const total = next.reduce((sum, size) => sum + size, 0)
            return total > 0 ? next.map(size => (size / total) * 100) : []
        })
        setFocusedGroup(0)
    }, [setGroupAssignments, visibleTabKeys, setGroupSizes, setFocusedGroup])

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
            setGroupSizes(next)
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
    }, [groupSizes, numGroups, setGroupSizes])

    const splitTabRelative = useCallback((tabKey: string, targetGroup: number, side: 'left' | 'right') => {
        if (numGroups >= 4) return

        const insertIndex = side === 'left' ? targetGroup : targetGroup + 1

        setGroupAssignments(prev => {
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

        setGroupSizes(prev => {
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

        setGroupActiveTabIds(prev => {
            const next = shiftIndexedRecordRight(prev, insertIndex)
            next[insertIndex] = tabKey
            return next
        })

        setGroupTabOrders(prev => {
            const next = shiftIndexedRecordRight(prev, insertIndex)
            next[insertIndex] = [tabKey]
            return next
        })

        setFocusedGroup(insertIndex)
    }, [
        numGroups,
        setGroupAssignments,
        visibleTabKeys,
        visibleConversations,
        setGroupSizes,
        setGroupActiveTabIds,
        setGroupTabOrders,
        setFocusedGroup,
    ])

    useEffect(() => {
        if (mapsEqual(groupAssignments, normalizedGroupAssignments)) return
        setGroupAssignments(normalizedGroupAssignments)
    }, [groupAssignments, normalizedGroupAssignments, setGroupAssignments])

    useEffect(() => {
        const { mapping, usedGroups } = normalizedGroupLayout

        setGroupActiveTabIds(prev => {
            const next = remapIndexedRecord(prev, mapping)
            return indexedRecordEqual(prev, next) ? prev : next
        })

        setGroupTabOrders(prev => {
            const next = remapIndexedRecord(prev, mapping)
            return indexedRecordEqual(prev, next) ? prev : next
        })

        setFocusedGroup(prev => {
            const next = isMobile ? 0 : remapFocusedGroup(prev, usedGroups, mapping)
            return prev === next ? prev : next
        })

        setGroupSizes(prev => {
            const next = isMobile ? [] : normalizeGroupSizes(prev, usedGroups, normalizedGroupLayout.groupCount)
            return arraysEqual(prev, next) ? prev : next
        })
    }, [
        normalizedGroupLayout,
        isMobile,
        setGroupActiveTabIds,
        setGroupTabOrders,
        setFocusedGroup,
        setGroupSizes,
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
        setGroupAssignments(new Map())
        setFocusedGroup(0)
    }, [setGroupAssignments, setFocusedGroup])

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
