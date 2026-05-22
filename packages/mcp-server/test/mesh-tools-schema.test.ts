import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS, MESH_CLEANUP_SESSIONS_TOOL, MESH_FAST_FORWARD_NODE_TOOL, MESH_LAUNCH_SESSION_TOOL, MESH_READ_CHAT_TOOL, MESH_READ_DEBUG_TOOL, MESH_REMOVE_NODE_TOOL } from '../src/tools/mesh-tools.js';

test('mesh_fast_forward_node schema registers the safe direct fast-forward surface', () => {
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.name, 'mesh_fast_forward_node');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_fast_forward_node'), true);
  assert.deepEqual(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.required, ['node_id']);
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.execute.type, 'boolean');
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.dry_run.type, 'boolean');
  assert.equal(MESH_FAST_FORWARD_NODE_TOOL.inputSchema.properties.update_submodules.type, 'boolean');
  assert.match(MESH_FAST_FORWARD_NODE_TOOL.description, /Never pushes, rebases, resets, cleans/);
});

test('mesh_launch_session schema maps providers, keeps type optional, and has no claude default', () => {
  const description = `${MESH_LAUNCH_SESSION_TOOL.description} ${MESH_LAUNCH_SESSION_TOOL.inputSchema.properties.type.description}`;

  assert.match(description, /Hermes\s*=\s*hermes-cli|Hermes.*hermes-cli/);
  assert.deepEqual(MESH_LAUNCH_SESSION_TOOL.inputSchema.required, ['node_id']);
  assert.match(description, /Do not default to claude-cli/);
  assert.doesNotMatch(description, /default to claude-cli unless/i);
});

test('mesh_read_chat schema exposes provider_session_id and compact mode for completed session history', () => {
  assert.equal(MESH_READ_CHAT_TOOL.inputSchema.properties.provider_session_id.type, 'string');
  assert.equal(MESH_READ_CHAT_TOOL.inputSchema.properties.compact.type, 'boolean');
  assert.match(MESH_READ_CHAT_TOOL.description, /compact=true/);
});

test('mesh session cleanup tools expose explicit manual cleanup and remove-node policy override', () => {
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.name, 'mesh_cleanup_sessions');
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.mode.enum.includes('delete_stopped'), true);
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.mode.enum.includes('stop_and_delete'), true);
  assert.equal(MESH_CLEANUP_SESSIONS_TOOL.inputSchema.properties.dry_run.type, 'boolean');
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_cleanup_sessions'), true);

  assert.equal(MESH_REMOVE_NODE_TOOL.inputSchema.properties.session_cleanup_mode.enum.includes('preserve'), true);
  assert.match(MESH_REMOVE_NODE_TOOL.description, /sessionCleanupOnNodeRemove/);
});
