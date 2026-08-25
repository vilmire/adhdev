import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_MESH_TOOLS,
  MESH_CLEANUP_SESSIONS_TOOL,
  MESH_LIST_PENDING_APPROVALS_TOOL,
} from '../src/tools/mesh-tools.js';
import { rejectUnknownMeshToolArgs, unknownToolArgsError } from '../src/tools/validate-tool-args.js';

// 2026-08-25 incident reproduction: a coordinator passed `session_id`
// (singular) to mesh_cleanup_sessions, whose schema declares `session_ids`
// (plural array). The unknown key was silently ignored and the remaining
// node_id matched every session on the node, deleting a live worker session.
// The gate must reject the call before dispatch and suggest the right key.
test('incident repro: mesh_cleanup_sessions(session_id) is rejected and suggests session_ids', () => {
  const error = rejectUnknownMeshToolArgs('mesh_cleanup_sessions', {
    node_id: 'node_4a0980c5',
    session_id: '3022b427',
  });
  assert.ok(error, 'call with unknown key must be rejected');
  assert.match(error, /Unknown parameter\(s\) for mesh_cleanup_sessions/);
  assert.match(error, /"session_id"/);
  assert.match(error, /did you mean "session_ids"\?/);
  assert.match(error, /Allowed parameters: .*session_ids/);
});

test('valid mesh_cleanup_sessions call with session_ids array passes the gate', () => {
  const error = rejectUnknownMeshToolArgs('mesh_cleanup_sessions', {
    node_id: 'node_4a0980c5',
    session_ids: ['3022b427'],
    dry_run: true,
  });
  assert.equal(error, null);
});

test('empty-args call passes for every published mesh tool', () => {
  for (const tool of ALL_MESH_TOOLS) {
    assert.equal(rejectUnknownMeshToolArgs(tool.name, {}), null, `${tool.name} should accept no-args`);
  }
});

test('every published mesh tool rejects a garbage key and lists its allowed parameters', () => {
  for (const tool of ALL_MESH_TOOLS) {
    const error = rejectUnknownMeshToolArgs(tool.name, { definitely_not_a_param: 1 });
    assert.ok(error, `${tool.name} should reject unknown key`);
    assert.match(error, /"definitely_not_a_param"/);
  }
});

test('zero-parameter tool (mesh_list_pending_approvals) says it takes no parameters', () => {
  assert.deepEqual(Object.keys(MESH_LIST_PENDING_APPROVALS_TOOL.inputSchema.properties as object), []);
  const error = rejectUnknownMeshToolArgs('mesh_list_pending_approvals', { node_id: 'x' });
  assert.ok(error);
  assert.match(error, /takes no parameters/);
});

test('protocol meta keys are whitelisted, not treated as unknown parameters', () => {
  const error = rejectUnknownMeshToolArgs('mesh_cleanup_sessions', {
    session_ids: ['3022b427'],
    _meta: { progressToken: 'tok' },
  });
  assert.equal(error, null);
});

test('unknown tool names fall through to the dispatcher (null, no rejection)', () => {
  assert.equal(rejectUnknownMeshToolArgs('mesh_not_a_tool', { anything: 1 }), null);
});

test('hidden 1-release aliases validate against their unified tool schema', () => {
  // node_id/config are legal on the unified mesh_refine_config schema.
  assert.equal(rejectUnknownMeshToolArgs('mesh_validate_refine_config', { node_id: 'n1' }), null);
  // A key the unified schema does not declare is still rejected on the alias.
  const error = rejectUnknownMeshToolArgs('mesh_refine_config_schema', { nod_id: 'n1' });
  assert.ok(error);
  assert.match(error, /did you mean "node_id"\?/);
});

test('suggestion matching is case/underscore-insensitive and distance-bounded', () => {
  const props = MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties as Record<string, unknown>;
  // camelCase variant of a snake_case key.
  const camel = unknownToolArgsError('mesh_cleanup_sessions', props, { sessionIds: ['x'] });
  assert.ok(camel);
  assert.match(camel, /did you mean "session_ids"\?/);
  // A key with no near neighbour gets no suggestion but is still rejected.
  const none = unknownToolArgsError('mesh_cleanup_sessions', props, { zzzzzzzz: 1 });
  assert.ok(none);
  assert.doesNotMatch(none, /did you mean/);
});
