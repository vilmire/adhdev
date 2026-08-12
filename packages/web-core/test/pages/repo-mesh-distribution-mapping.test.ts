import { describe, expect, it } from 'vitest'
import {
    distributionToStrategy,
    strategyToDistribution,
    DISTRIBUTION_OPTIONS,
} from '../../src/pages/repo-mesh/types'

/**
 * The Distribution façade (Smart / In order) maps 1:1 onto the raw scheduling
 * strategies the daemon stores. 'Smart' is the fitness strategy — without this
 * mapping the fitness scorer is unreachable from the UI. The old 'Spread' mode
 * was removed: Smart subsumes it (fitness with no task in scope degrades to the
 * same priority/load spread ordering).
 */
describe('mesh distribution ↔ strategy mapping', () => {
    it('exposes exactly Smart and In order', () => {
        expect(DISTRIBUTION_OPTIONS.map(o => o.value)).toEqual(['smart', 'in_order'])
    })

    it('distributionToStrategy maps each mode to its raw strategy', () => {
        expect(distributionToStrategy('smart')).toBe('fitness')
        expect(distributionToStrategy('in_order')).toBe('first_eligible')
    })

    it('strategyToDistribution round-trips the primary strategies', () => {
        expect(strategyToDistribution('fitness')).toBe('smart')
        expect(strategyToDistribution('first_eligible')).toBe('in_order')
    })

    it('the deprecated least_loaded/round_robin stored values show as smart (daemon normalizes them to fitness)', () => {
        expect(strategyToDistribution('least_loaded')).toBe('smart')
        expect(strategyToDistribution('round_robin')).toBe('smart')
    })

    it('priority_only shows as smart only when a node priority is configured', () => {
        expect(strategyToDistribution('priority_only', { priorityConfigured: true })).toBe('smart')
        expect(strategyToDistribution('priority_only', { priorityConfigured: false })).toBe('in_order')
    })

    it('unset / unknown strategy defaults to in_order (no accidental smart)', () => {
        expect(strategyToDistribution(undefined)).toBe('in_order')
        expect(strategyToDistribution('' as any)).toBe('in_order')
    })
})
