import { describe, expect, it } from 'vitest'
import {
    getSessionHostAvailabilityBadge,
    getSessionHostRecoveryLabel,
    getSessionHostNextActionLabel,
    getSessionHostSectionHint,
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

    it('maps each runtime surface section to a primary next action', () => {
        expect(getSessionHostNextActionLabel('live')).toBe('Attach')
        expect(getSessionHostNextActionLabel('recovery')).toBe('Recover')
        expect(getSessionHostNextActionLabel('inactive')).toBe('Restart')
    })

    it('describes recovery and inactive sections with explicit attachability guidance', () => {
        expect(getSessionHostSectionHint('recovery')).toContain('not live attach targets')
        expect(getSessionHostSectionHint('inactive')).toContain('shown for reference')
    })

    it('labels successful diagnostics as managed even when there are no live runtimes', () => {
        expect(getSessionHostAvailabilityBadge({ diagnostics: { runtimeCount: 0 } })).toEqual({
            label: 'Managed',
            toneClass: 'bg-green-500/[0.08] text-green-500',
        })
    })

    it('distinguishes diagnostics delivery failures from full unavailability', () => {
        expect(getSessionHostAvailabilityBadge({ error: 'Payload too large' })).toEqual({
            label: 'Diagnostics issue',
            toneClass: 'bg-amber-500/[0.08] text-amber-400',
        })
        expect(getSessionHostAvailabilityBadge({ loading: true })).toEqual({
            label: 'Checking…',
            toneClass: 'bg-sky-500/[0.08] text-sky-400',
        })
        expect(getSessionHostAvailabilityBadge({})).toEqual({
            label: 'Unavailable',
            toneClass: 'bg-red-500/[0.08] text-red-400',
        })
    })
})
