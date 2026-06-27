import { describe, expect, it } from 'vitest';
import {
    distributionToStrategy,
    strategyToDistribution,
    normalizeMeshDistribution,
    resolveMaxReadonlyParallelTasks,
    DEFAULT_MESH_READONLY_MULTIPLIER,
} from '../../src/repo-mesh-types.js';

describe('distribution ↔ strategy mapping (2-mode façade over the raw 4-union)', () => {
    // The six canonical mapping cases the SCHED-REARCH design pins down.
    it('distributionToStrategy: spread → least_loaded', () => {
        expect(distributionToStrategy('spread')).toBe('least_loaded');
    });
    it('distributionToStrategy: in_order → first_eligible', () => {
        expect(distributionToStrategy('in_order')).toBe('first_eligible');
    });
    it('strategyToDistribution: first_eligible → in_order', () => {
        expect(strategyToDistribution('first_eligible')).toBe('in_order');
    });
    it('strategyToDistribution: least_loaded → spread', () => {
        expect(strategyToDistribution('least_loaded')).toBe('spread');
    });
    it('strategyToDistribution: round_robin → spread (rotation absorbed into spread)', () => {
        expect(strategyToDistribution('round_robin')).toBe('spread');
    });
    it('strategyToDistribution: priority_only → spread iff a priority is configured, else in_order', () => {
        expect(strategyToDistribution('priority_only', { priorityConfigured: true })).toBe('spread');
        expect(strategyToDistribution('priority_only', { priorityConfigured: false })).toBe('in_order');
        expect(strategyToDistribution('priority_only')).toBe('in_order');
    });

    it('round-trips spread/in_order through strategy and back', () => {
        expect(strategyToDistribution(distributionToStrategy('spread'))).toBe('spread');
        expect(strategyToDistribution(distributionToStrategy('in_order'))).toBe('in_order');
    });

    it('normalizeMeshDistribution defaults unknown/blank to spread, trims valid', () => {
        expect(normalizeMeshDistribution('spread')).toBe('spread');
        expect(normalizeMeshDistribution(' in_order ')).toBe('in_order');
        expect(normalizeMeshDistribution('nonsense')).toBe('spread');
        expect(normalizeMeshDistribution(undefined)).toBe('spread');
        expect(normalizeMeshDistribution(42)).toBe('spread');
    });

    it('strategyToDistribution treats unknown/missing strategy as first_eligible → in_order', () => {
        expect(strategyToDistribution(undefined)).toBe('in_order');
        expect(strategyToDistribution('garbage')).toBe('in_order');
    });
});

describe('resolveMaxReadonlyParallelTasks — single source for the read-only cap', () => {
    it('defaults to the historical max(2, write × 2) when no multiplier given', () => {
        expect(DEFAULT_MESH_READONLY_MULTIPLIER).toBe(2);
        expect(resolveMaxReadonlyParallelTasks(1)).toBe(2);
        expect(resolveMaxReadonlyParallelTasks(2)).toBe(4);
        expect(resolveMaxReadonlyParallelTasks(4)).toBe(8);
    });
    it('floors at 2 even for a write cap of 1 with multiplier 1', () => {
        expect(resolveMaxReadonlyParallelTasks(1, 1)).toBe(2);
    });
    it('honors a custom multiplier', () => {
        expect(resolveMaxReadonlyParallelTasks(3, 3)).toBe(9);
    });
    it('falls back to the default multiplier for an invalid value', () => {
        expect(resolveMaxReadonlyParallelTasks(2, 0)).toBe(4);
        expect(resolveMaxReadonlyParallelTasks(2, -5)).toBe(4);
        expect(resolveMaxReadonlyParallelTasks(2, NaN)).toBe(4);
        expect(resolveMaxReadonlyParallelTasks(2, 'x')).toBe(4);
    });
});
