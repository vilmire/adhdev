import { describe, expect, it } from 'vitest'
import {
    getSessionHostRecoveryLabel,
    partitionSessionHostRecords,
} from '../../src/utils/session-host-surface'

describe('session host surface helpers', () => {
    it('groups live, recovery, and inactive records separately', () => {
        const result = partitionSessionHostRecords([
            { lifecycle: 'running', meta: { providerSessionId: 'live-1' } },
            { lifecycle: 'failed', meta: { restoredFromStorage: true, runtimeRecoveryState: 'resume_failed' } },
            { lifecycle: 'stopped', meta: {} },
        ])

        expect(result.liveRuntimes).toHaveLength(1)
        expect(result.recoverySnapshots).toHaveLength(1)
        expect(result.inactiveRecords).toHaveLength(1)
    })

    it('formats orphan snapshots with a user-facing recovery label', () => {
        expect(getSessionHostRecoveryLabel({ runtimeRecoveryState: 'orphan_snapshot' })).toBe('snapshot recovered')
    })
})
