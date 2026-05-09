import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMcpHelpText } from '../src/help.js';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';

test('help text lists every registered mesh tool', () => {
  const help = buildMcpHelpText();
  for (const tool of ALL_MESH_TOOLS) {
    assert.match(help, new RegExp(`\\b${tool.name}\\b`));
  }
});
