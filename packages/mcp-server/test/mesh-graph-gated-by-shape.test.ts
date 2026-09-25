import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGraphTaskFields } from '../src/tools/mesh-tools-graph.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

// Live regression 2026-09-25: `gated_by: "g1"` (a string, not a list) was silently
// dropped, so the gate got no edge and never auto-closed when its task was cancelled.

test('gated_by given as a single string is kept as one gate ref', () => {
    assert.deepEqual(readGraphTaskFields({ gated_by: 'g1' }), { gated_by: ['g1'] });
    assert.deepEqual(readGraphTaskFields({ gatedBy: 'g2' }), { gated_by: ['g2'] });
});

test('gated_by given as a list is unchanged, and absent stays absent', () => {
    assert.deepEqual(readGraphTaskFields({ gated_by: ['g1', 'g2'] }), { gated_by: ['g1', 'g2'] });
    assert.deepEqual(readGraphTaskFields({}), {});
});

test('a non-array, non-string gated_by is refused by the validator instead of dropped', () => {
    const err = validateMeshToolArgs('mesh_enqueue_batch', {
        tasks: [{ ref: 't1', message: 'x', gated_by: 7 }],
        gates: [{ ref: 'g1', instructions: 'y' }],
    });
    assert.ok(err, 'expected a validation error');
    assert.match(err!, /gated_by/);
    assert.match(err!, /expected an array of strings, got number/);
});

test('a well-formed batch with gated_by list or string passes the type check', () => {
    for (const gated_by of [['g1'], 'g1']) {
        const err = validateMeshToolArgs('mesh_enqueue_batch', {
            tasks: [{ ref: 't1', message: 'x', gated_by }],
            gates: [{ ref: 'g1', instructions: 'y' }],
        });
        assert.equal(err, null, `unexpected error for ${JSON.stringify(gated_by)}: ${err}`);
    }
});
