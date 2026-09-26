import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_MESH_TOOLS,
  MESH_CONFIG_TOOL,
} from '../src/tools/mesh-tools.js';

// The three former standalone change-impact-config tools (mesh_change_impact_config_schema /
// mesh_validate_change_impact_config / mesh_suggest_change_impact_config) were consolidated
// into a single mode-dispatched tool (symmetric to Part 8-4), which the 2026-09-26 tool
// consolidation folded into mesh_config as kind="change_impact". The per-mode names survive
// only as hidden dispatch aliases and are not published in ALL_MESH_TOOLS.

test('mesh_config (kind=change_impact) is registered; the former standalone names are not', () => {
  assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_config'), true, 'mesh_config not registered');
  for (const name of [
    'mesh_change_impact_config',
    'mesh_change_impact_config_schema',
    'mesh_validate_change_impact_config',
    'mesh_suggest_change_impact_config',
  ]) {
    assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === name), false, `${name} should no longer be published`);
  }
});

test('mesh_config carries change_impact as a kind with the schema|validate|suggest mode enum', () => {
  const props = MESH_CONFIG_TOOL.inputSchema.properties as any;
  assert.equal(MESH_CONFIG_TOOL.name, 'mesh_config');
  assert.equal(MESH_CONFIG_TOOL.inputSchema.type, 'object');
  assert.ok(props.kind.enum.includes('change_impact'));
  assert.deepEqual(props.mode.enum, ['schema', 'validate', 'suggest']);
  assert.deepEqual((MESH_CONFIG_TOOL.inputSchema as any).required, ['kind']);
  // Change-impact config is declarative — parsed, never executed.
  assert.match(MESH_CONFIG_TOOL.description, /never executed|never executes|parsed, never executed|nothing is executed/i);
});

test('mesh_config exposes node_id + inline config for the validate/suggest modes', () => {
  const props = MESH_CONFIG_TOOL.inputSchema.properties as any;
  assert.equal(props.node_id.type, 'string');
  assert.equal(props.config.type, 'object');
  // The suggest operation stays scaffold-only in the unified description.
  assert.match(MESH_CONFIG_TOOL.description, /scaffold|reviewed and saved|never executed/i);
});
