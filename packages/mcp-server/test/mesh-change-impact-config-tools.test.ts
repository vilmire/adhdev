import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_MESH_TOOLS,
  MESH_CHANGE_IMPACT_CONFIG_TOOL,
} from '../src/tools/mesh-tools.js';

// The three former standalone change-impact-config tools (mesh_change_impact_config_schema /
// mesh_validate_change_impact_config / mesh_suggest_change_impact_config) were consolidated
// into the single mode-dispatched mesh_change_impact_config tool (symmetric to Part 8-4).
// They survive only as hidden dispatch aliases and are no longer published in ALL_MESH_TOOLS.

test('unified mesh_change_impact_config is registered; the former standalone names are not', () => {
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_change_impact_config'), true, 'mesh_change_impact_config not registered');
  for (const name of [
    'mesh_change_impact_config_schema',
    'mesh_validate_change_impact_config',
    'mesh_suggest_change_impact_config',
  ]) {
    assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === name), false, `${name} should no longer be published`);
  }
});

test('mesh_change_impact_config requires a schema|validate|suggest mode enum', () => {
  const props = MESH_CHANGE_IMPACT_CONFIG_TOOL.inputSchema.properties as any;
  assert.equal(MESH_CHANGE_IMPACT_CONFIG_TOOL.name, 'mesh_change_impact_config');
  assert.equal(MESH_CHANGE_IMPACT_CONFIG_TOOL.inputSchema.type, 'object');
  assert.deepEqual(props.mode.enum, ['schema', 'validate', 'suggest']);
  assert.deepEqual((MESH_CHANGE_IMPACT_CONFIG_TOOL.inputSchema as any).required, ['mode']);
  // Change-impact config is declarative — parsed, never executed.
  assert.match(MESH_CHANGE_IMPACT_CONFIG_TOOL.description, /never executed|never executes|parsed, never executed|nothing is executed/i);
});

test('mesh_change_impact_config exposes node_id + inline config for the validate/suggest modes', () => {
  const props = MESH_CHANGE_IMPACT_CONFIG_TOOL.inputSchema.properties as any;
  assert.equal(props.node_id.type, 'string');
  assert.equal(props.config.type, 'object');
  // The suggest operation stays scaffold-only in the unified description.
  assert.match(MESH_CHANGE_IMPACT_CONFIG_TOOL.description, /scaffold|reviewed and saved|never executed/i);
});
