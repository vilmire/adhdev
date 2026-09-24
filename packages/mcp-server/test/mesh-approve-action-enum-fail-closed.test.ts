import test from 'node:test';
import assert from 'node:assert/strict';

import { enumValueError, validateMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { APPROVE_TOOL } from '../src/tools/approve.js';
import { MESH_APPROVE_TOOL } from '../src/tools/mesh-tool-schemas.js';

/**
 * approve / mesh_approve `action` failed OPEN — any value other than exactly
 * 'reject' (e.g. 'deny', 'rejected', a typo) was silently treated as
 * 'approve' by the handler (`a.action === 'reject' ? 'reject' : 'approve'`,
 * server.ts / mesh-tools-session.ts), so a caller meaning to DECLINE an
 * action could have it approved instead with no error. The unknown-arg gate
 * (validate-tool-args.ts) only ever checked KEYS, never enum VALUES — this
 * pins the new `enumValueError` check that runs before dispatch in both
 * standard mode (`approve`) and mesh mode (`mesh_approve`, via
 * validateMeshToolArgs), so a bad value is refused instead of silently
 * approved.
 */

test('enumValueError: rejects an out-of-vocabulary action value for the standard "approve" tool', () => {
    const err = enumValueError('approve', APPROVE_TOOL.inputSchema.properties, { action: 'deny' });
    assert.ok(err, 'expected a refusal for action:"deny"');
    assert.match(err!, /Invalid value for "action"/);
    assert.match(err!, /"approve", "reject"/);
});

test('enumValueError: accepts each declared action value for "approve"', () => {
    assert.equal(enumValueError('approve', APPROVE_TOOL.inputSchema.properties, { action: 'approve' }), null);
    assert.equal(enumValueError('approve', APPROVE_TOOL.inputSchema.properties, { action: 'reject' }), null);
});

test('validateMeshToolArgs: mesh_approve refuses action:"deny" before dispatch', () => {
    const err = validateMeshToolArgs('mesh_approve', { node_id: 'n1', session_id: 's1', action: 'deny' });
    assert.ok(err, 'expected mesh_approve to refuse action:"deny"');
    assert.match(err!, /Invalid value for "action"/);
});

test('validateMeshToolArgs: mesh_approve still accepts "approve" and "reject"', () => {
    assert.equal(validateMeshToolArgs('mesh_approve', { node_id: 'n1', session_id: 's1', action: 'approve' }), null);
    assert.equal(validateMeshToolArgs('mesh_approve', { node_id: 'n1', session_id: 's1', action: 'reject' }), null);
});

test('MESH_APPROVE_TOOL and APPROVE_TOOL both declare the same action vocabulary (sanity)', () => {
    assert.deepEqual(APPROVE_TOOL.inputSchema.properties.action.enum, ['approve', 'reject']);
    assert.deepEqual(MESH_APPROVE_TOOL.inputSchema.properties.action.enum, ['approve', 'reject']);
});
