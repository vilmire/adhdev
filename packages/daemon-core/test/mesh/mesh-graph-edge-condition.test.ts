/**
 * `describeEdgeCondition` — the human-readable rendering of a conditional
 * edge's `run_if`.
 *
 * Why this exists: the blueprint could show THAT an edge was conditional but
 * never on WHAT, because `condition_json` stopped at the store and never
 * reached `MeshGraphEdgeView`. A bare "conditional" label reads as an
 * unexplained decoration; the whole point is answering "why did this branch
 * not run?" on the canvas.
 *
 * Properties pinned:
 *  - each leaf operator renders with its subject and comparand
 *  - all/any/not nest with parentheses, deeper levels bracketed
 *  - JSON Pointer selectors flatten to dotted paths
 *  - absent/!unparseable input yields undefined (render nothing, never a
 *    half-condition that would read as a different predicate)
 */
import { describe, expect, it } from 'vitest';
import { describeEdgeCondition } from '../../src/mesh/mesh-graph-view';

const json = (value: unknown) => JSON.stringify(value);

describe('describeEdgeCondition', () => {
    it('renders each leaf operator', () => {
        expect(describeEdgeCondition(json({ from: 'review', select: '/outcome', op: 'eq', value: 'rejected' })))
            .toBe('review.outcome == "rejected"');
        expect(describeEdgeCondition(json({ from: 'review', select: '/outcome', op: 'ne', value: 'approved' })))
            .toBe('review.outcome != "approved"');
        expect(describeEdgeCondition(json({ from: 'ci', select: '/status', op: 'exists' })))
            .toBe('ci.status exists');
        expect(describeEdgeCondition(json({ from: 'ci', select: '/status', op: 'in', value: ['red', 'flaky'] })))
            .toBe('ci.status in ["red", "flaky"]');
    });

    it('flattens a nested JSON Pointer selector to a dotted path', () => {
        expect(describeEdgeCondition(json({ from: 'build', select: '/result/exit_code', op: 'eq', value: 0 })))
            .toBe('build.result.exit_code == 0');
    });

    it('joins all/any and brackets nested groups', () => {
        const cond = {
            all: [
                { from: 'review', select: '/outcome', op: 'eq', value: 'rejected' },
                { any: [
                    { from: 'ci', select: '/status', op: 'eq', value: 'red' },
                    { from: 'ci', select: '/status', op: 'eq', value: 'timeout' },
                ] },
            ],
        };
        expect(describeEdgeCondition(json(cond)))
            .toBe('review.outcome == "rejected" and (ci.status == "red" or ci.status == "timeout")');
    });

    it('renders not', () => {
        expect(describeEdgeCondition(json({ not: { from: 'review', select: '/outcome', op: 'exists' } })))
            .toBe('not review.outcome exists');
    });

    it('returns undefined rather than a partial condition for unusable input', () => {
        expect(describeEdgeCondition(undefined)).toBeUndefined();
        expect(describeEdgeCondition('')).toBeUndefined();
        expect(describeEdgeCondition('{not json')).toBeUndefined();
        expect(describeEdgeCondition(json({ from: 'x', select: '/y', op: 'regex' }))).toBeUndefined();
        expect(describeEdgeCondition(json({ all: [] }))).toBeUndefined();
    });

    it('truncates a very long expression instead of unbounding the label', () => {
        const long = { all: Array.from({ length: 12 }, (_, i) => ({ from: `step${i}`, select: '/outcome', op: 'eq', value: `value-${i}` })) };
        const out = describeEdgeCondition(json(long))!;
        expect(out.length).toBeLessThanOrEqual(120);
        expect(out.endsWith('...')).toBe(true);
    });
});
