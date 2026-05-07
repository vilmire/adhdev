import assert from 'node:assert/strict';
import test from 'node:test';

import { MESH_LAUNCH_SESSION_TOOL, MESH_READ_CHAT_TOOL, MESH_READ_DEBUG_TOOL } from '../src/tools/mesh-tools.js';

test('mesh_launch_session schema maps providers, keeps type optional, and has no claude default', () => {
  const description = `${MESH_LAUNCH_SESSION_TOOL.description} ${MESH_LAUNCH_SESSION_TOOL.inputSchema.properties.type.description}`;

  assert.match(description, /Hermes\s*=\s*hermes-cli|Hermes.*hermes-cli/);
  assert.deepEqual(MESH_LAUNCH_SESSION_TOOL.inputSchema.required, ['node_id']);
  assert.match(description, /Do not default to claude-cli/);
  assert.doesNotMatch(description, /default to claude-cli unless/i);
});

test('mesh_read_chat schema exposes provider_session_id for completed session history', () => {
  assert.equal(MESH_READ_CHAT_TOOL.inputSchema.properties.provider_session_id.type, 'string');
});

test('mesh_read_debug schema exposes browser-free daemon debug collection controls', () => {
  assert.equal(MESH_READ_DEBUG_TOOL.inputSchema.properties.provider_session_id.type, 'string');
  assert.equal(MESH_READ_DEBUG_TOOL.inputSchema.properties.delivery.enum.includes('daemon_file'), true);
  assert.match(MESH_READ_DEBUG_TOOL.description, /without opening the browser UI/);
});
