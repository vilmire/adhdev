export function mapsEqual(a: Map<string, number>, b: Map<string, number>) {
    if (a.size !== b.size) return false
    for (const [key, value] of a) {
        if (b.get(key) !== value) return false
    }
    return true
}

export function arraysEqual(a: number[], b: number[]) {
    if (a.length !== b.length) return false
    return a.every((value, idx) => value === b[idx])
}

export function indexedRecordEqual<T>(a: Record<number, T>, b: Record<number, T>) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(key => b[Number(key)] === a[Number(key)])
}

export function deriveNormalizedGroupLayout(assignments: Map<string, number>, visibleTabKeys: string[]) {
    const validKeys = new Set(visibleTabKeys)
    const usedGroups = visibleTabKeys.length > 0 ? [0] : []

    for (const [tabKey, groupIndex] of assignments) {
        if (!validKeys.has(tabKey) || groupIndex <= 0 || usedGroups.includes(groupIndex)) continue
        usedGroups.push(groupIndex)
    }

    usedGroups.sort((a, b) => a - b)

    const mapping: Record<number, number> = {}
    usedGroups.forEach((groupIndex, nextIndex) => {
        mapping[groupIndex] = nextIndex
    })

    if (usedGroups.length === 0) {
        mapping[0] = 0
    }

    const normalizedAssignments = new Map<string, number>()
    for (const [tabKey, groupIndex] of assignments) {
        if (!validKeys.has(tabKey) || groupIndex <= 0) continue
        const nextIndex = mapping[groupIndex]
        if (typeof nextIndex === 'number' && nextIndex > 0) {
            normalizedAssignments.set(tabKey, nextIndex)
        }
    }

    return {
        assignments: normalizedAssignments,
        groupCount: Math.max(1, usedGroups.length),
        mapping,
        usedGroups,
    }
}

export function remapIndexedRecord<T>(prev: Record<number, T>, mapping: Record<number, number>) {
    const next: Record<number, T> = {}
    for (const [key, value] of Object.entries(prev)) {
        const mapped = mapping[Number(key)]
        if (typeof mapped === 'number') next[mapped] = value
    }
    return next
}

export function remapFocusedGroup(current: number, usedGroups: number[], mapping: Record<number, number>) {
    if (usedGroups.length === 0) return 0
    if (typeof mapping[current] === 'number') return mapping[current]
    const fallbackOldGroup = [...usedGroups].reverse().find(groupIndex => groupIndex < current)
        ?? usedGroups[0]
    return mapping[fallbackOldGroup] ?? 0
}

export function normalizeGroupSizes(prev: number[], usedGroups: number[], fallbackCount: number) {
    if (usedGroups.length <= 1) return []

    const next = usedGroups.map(groupIndex => prev[groupIndex]).filter((size): size is number => Number.isFinite(size))
    const base = next.length === usedGroups.length
        ? next
        : Array(fallbackCount).fill(100 / fallbackCount)

    const total = base.reduce((sum, size) => sum + size, 0)
    return total > 0
        ? base.map(size => (size / total) * 100)
        : Array(fallbackCount).fill(100 / fallbackCount)
}
