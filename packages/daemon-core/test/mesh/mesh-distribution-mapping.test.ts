import { describe, expect, it } from 'vitest';
import {
    resolveMaxReadonlyParallelTasks,
    DEFAULT_MESH_READONLY_MULTIPLIER,
} from '../../src/repo-mesh-types.js';

// NOTE: the 2-mode distribution façade (Smart ↔ fitness / In order ↔ first_eligible)
// is web-core only — the daemon-side façade was removed as dead code. The web-core
// mapping is covered by web-core/test/pages/repo-mesh-distribution-mapping.test.ts.

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
