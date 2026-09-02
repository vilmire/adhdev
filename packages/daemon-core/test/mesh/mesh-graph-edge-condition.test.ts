/**
 * `describeEdgeCondition` — the structured summary of a conditional edge's
 * `run_if`, drawn on the blueprint.
 *
 * Why this exists: `condition_json` stopped at the store and never reached
 * `MeshGraphEdgeView`, so the canvas could say THAT an edge was conditional
 * but never on WHAT. It is reduced to structure rather than a sentence,
 * because the grammar is a closed set and the UI lays each clause out as its
 * own element — a rendered string would have to be truncated to fit an edge
 * label (measured: a 200px label over a 120px gap overlapped both neighbours).
 *
 * Properties pinned:
 *  - each leaf operator yields subject / op / value
 *  - JSON Pointer selectors flatten to dotted paths
 *  - all/any set the combinator; not sets `negated`
 *  - clause count is capped and the overflow is flagged, never silently lost
 *  - unusable input yields undefined, never a half-condition
 */
import { describe, expect, it } from 'vitest';
import { describeEdgeCondition } from '../../src/mesh/mesh-graph-view';

const json = (value: unknown) => JSON.stringify(value);

describe('describeEdgeCondition', () => {
    it('reduces each leaf operator to subject / op / value', () => {
        expect(describeEdgeCondition(json({ from: 'review', select: '/outcome', op: 'eq', value: 'rejected' })))
            .toEqual({ combinator: 'single', negated: false, truncated: false, clauses: [{ subject: 'review.outcome', op: 'eq', value: 'rejected' }] });
        expect(describeEdgeCondition(json({ from: 'ci', select: '/status', op: 'exists' })!)!.clauses[0])
            .toEqual({ subject: 'ci.status', op: 'exists' });
        expect(describeEdgeCondition(json({ from: 'ci', select: '/status', op: 'in', value: ['red', 'flaky'] }))!.clauses[0])
            .toEqual({ subject: 'ci.status', op: 'in', value: 'red, flaky' });
    });

    it('flattens a nested JSON Pointer selector to a dotted path', () => {
        expect(describeEdgeCondition(json({ from: 'build', select: '/result/exit_code', op: 'ne', value: 0 }))!.clauses[0])
            .toEqual({ subject: 'build.result.exit_code', op: 'ne', value: '0' });
    });

    it('carries the combinator for all/any', () => {
        const cond = {
            all: [
                { from: 'review', select: '/outcome', op: 'eq', value: 'rejected' },
                { from: 'ci', select: '/status', op: 'eq', value: 'red' },
            ],
        };
        const out = describeEdgeCondition(json(cond))!;
        expect(out.combinator).toBe('all');
        expect(out.clauses).toHaveLength(2);
        expect(out.truncated).toBe(false);
    });

    it('marks a negated expression instead of dropping the not', () => {
        const out = describeEdgeCondition(json({ not: { from: 'review', select: '/outcome', op: 'exists' } }))!;
        expect(out.negated).toBe(true);
        expect(out.clauses[0]).toEqual({ subject: 'review.outcome', op: 'exists' });
    });

    it('caps the clause count and flags the overflow rather than losing it silently', () => {
        const cond = { any: Array.from({ length: 6 }, (_, i) => ({ from: `step${i}`, select: '/outcome', op: 'eq', value: 'x' })) };
        const out = describeEdgeCondition(json(cond))!;
        expect(out.clauses).toHaveLength(3);
        expect(out.truncated).toBe(true);
    });

    it('flags a nested combinator as truncated instead of expanding it inline', () => {
        const cond = {
            all: [
                { from: 'review', select: '/outcome', op: 'eq', value: 'rejected' },
                { any: [{ from: 'ci', select: '/status', op: 'eq', value: 'red' }] },
            ],
        };
        const out = describeEdgeCondition(json(cond))!;
        expect(out.clauses).toHaveLength(1);
        expect(out.truncated).toBe(true);
    });

    it('returns undefined rather than a partial condition for unusable input', () => {
        expect(describeEdgeCondition(undefined)).toBeUndefined();
        expect(describeEdgeCondition('')).toBeUndefined();
        expect(describeEdgeCondition('{not json')).toBeUndefined();
        expect(describeEdgeCondition(json({ from: 'x', select: '/y', op: 'regex' }))).toBeUndefined();
        expect(describeEdgeCondition(json({ all: [] }))).toBeUndefined();
    });
});
