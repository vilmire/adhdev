import { describe, expect, it } from 'vitest'
import {
    DEBUG_TRACE_FILTERS,
    buildDebugTraceQuery,
    filterDebugTraceEntries,
} from '../../src/utils/logs-trace-filters'

describe('logs trace filters', () => {
    it('keeps the default trace query broad when all categories are selected', () => {
        expect(buildDebugTraceQuery({ count: 120, since: 42, category: 'all' })).toEqual({
            count: 120,
            since: 42,
        })
    })

    it('requests only session_host trace entries when the quick filter is active', () => {
        expect(buildDebugTraceQuery({ count: 120, since: 42, category: 'session_host' })).toEqual({
            count: 120,
            since: 42,
            category: 'session_host',
        })
    })

    it('filters mixed trace buffers down to session_host entries for the quick filter', () => {
        const filtered = filterDebugTraceEntries([
            { id: 'trace-1', ts: 1, category: 'command', stage: 'received', level: 'info' },
            { id: 'trace-2', ts: 2, category: 'session_host', stage: 'action_requested', level: 'info' },
            { id: 'trace-3', ts: 3, category: 'session_host', stage: 'action_result', level: 'info' },
        ], 'session_host')

        expect(filtered).toEqual([
            { id: 'trace-2', ts: 2, category: 'session_host', stage: 'action_requested', level: 'info' },
            { id: 'trace-3', ts: 3, category: 'session_host', stage: 'action_result', level: 'info' },
        ])
    })

    it('advertises the all/session_host quick filters in priority order', () => {
        expect(DEBUG_TRACE_FILTERS).toEqual([
            { value: 'all', label: 'All trace' },
            { value: 'session_host', label: 'Session host' },
        ])
    })
})
