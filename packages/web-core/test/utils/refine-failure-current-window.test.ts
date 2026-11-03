import { describe, expect, it } from 'vitest'
import { countCurrentFailedRefineJobs, REFINE_FAILURE_CURRENT_WINDOW_MS } from '../../src/utils/mesh-visualization'

describe('current refine failure window', () => {
    const now = Date.parse('2026-11-02T12:00:00.000Z')

    it('counts only failed jobs inside the 30 minute window', () => {
        const count = countCurrentFailedRefineJobs([
            { status: 'failed', lastUpdatedAt: new Date(now - 5 * 60 * 1000).toISOString() },
            { status: 'failed', completedAt: new Date(now - REFINE_FAILURE_CURRENT_WINDOW_MS - 1000).toISOString() },
            { status: 'failed' },
            { status: 'completed', lastUpdatedAt: new Date(now).toISOString() },
            { status: 'running', startedAt: new Date(now).toISOString() },
        ], now)
        expect(count).toBe(1)
    })
})
