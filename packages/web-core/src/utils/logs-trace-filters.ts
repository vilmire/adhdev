export type DebugTraceCategoryFilter = 'all' | 'session_host'

export interface DebugTraceEntryLike {
    category: string
}

export interface BuildDebugTraceQueryOptions {
    count: number
    since: number
    category: DebugTraceCategoryFilter
}

export const DEBUG_TRACE_FILTERS: Array<{ value: DebugTraceCategoryFilter, label: string }> = [
    { value: 'all', label: 'All trace' },
    { value: 'session_host', label: 'Session host' },
]

export function buildDebugTraceQuery({ count, since, category }: BuildDebugTraceQueryOptions): {
    count: number
    since: number
    category?: string
} {
    return {
        count,
        since,
        ...(category === 'all' ? {} : { category }),
    }
}

export function filterDebugTraceEntries<T extends DebugTraceEntryLike>(entries: T[], category: DebugTraceCategoryFilter): T[] {
    if (category === 'all') return entries
    return entries.filter((entry) => entry.category === category)
}
