import assert from 'node:assert/strict';
import test from 'node:test';

import { MESH_LAUNCH_SESSION_TOOL } from '../src/tools/mesh-tools.js';

test('mesh_launch_session schema explicitly maps Hermes to hermes-cli', () => {
  const description = `${MESH_LAUNCH_SESSION_TOOL.description} ${MESH_LAUNCH_SESSION_TOOL.inputSchema.properties.type.description}`;

  assert.match(description, /Hermes\s*=\s*hermes-cli|Hermes.*hermes-cli/);
  assert.match(description, /Do not default to claude-cli/);
});
