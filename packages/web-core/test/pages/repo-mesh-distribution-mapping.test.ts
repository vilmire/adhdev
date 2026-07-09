import { describe, expect, it } from 'vitest'
import {
    distributionToStrategy,
    strategyToDistribution,
    DISTRIBUTION_OPTIONS,
} from '../../src/pages/repo-mesh/types'

/**
 * The Distribution façade (Smart / Spread / In order) maps 1:1 onto the raw
 * scheduling strategies the daemon stores. 'Smart' is the fitness strategy —
 * without this mapping the fitness scorer is unreachable from the UI.
 */
describe('mesh distribution ↔ strategy mapping', () => {
    it('exposes exactly Smart, Spread, In order', () => {
        expect(DISTRIBUTION_OPTIONS.map(o => o.value)).toEqual(['smart', 'spread', 'in_order'])
    })

    it('distributionToStrategy maps each mode to its raw strategy', () => {
        expect(distributionToStrategy('smart')).toBe('fitness')
        expect(distributionToStrategy('spread')).toBe('least_loaded')
        expect(distributionToStrategy('in_order')).toBe('first_eligible')
    })

    it('strategyToDistribution round-trips the primary strategies', () => {
        expect(strategyToDistribution('fitness')).toBe('smart')
        expect(strategyToDistribution('least_loaded')).toBe('spread')
        expect(strategyToDistribution('round_robin')).toBe('spread')
        expect(strategyToDistribution('first_eligible')).toBe('in_order')
    })

    it('priority_only shows as spread only when a node priority is configured', () => {
        expect(strategyToDistribution('priority_only', { priorityConfigured: true })).toBe('spread')
        expect(strategyToDistribution('priority_only', { priorityConfigured: false })).toBe('in_order')
    })

    it('unset / unknown strategy defaults to in_order (no accidental smart)', () => {
        expect(strategyToDistribution(undefined)).toBe('in_order')
        expect(strategyToDistribution('' as any)).toBe('in_order')
    })
})
