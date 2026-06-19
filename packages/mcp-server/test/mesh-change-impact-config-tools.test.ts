import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_MESH_TOOLS,
  MESH_CHANGE_IMPACT_CONFIG_SCHEMA_TOOL,
  MESH_VALIDATE_CHANGE_IMPACT_CONFIG_TOOL,
  MESH_SUGGEST_CHANGE_IMPACT_CONFIG_TOOL,
} from '../src/tools/mesh-tools.js';

test('change-impact config tools are registered in ALL_MESH_TOOLS', () => {
  for (const name of [
    'mesh_change_impact_config_schema',
    'mesh_validate_change_impact_config',
    'mesh_suggest_change_impact_config',
  ]) {
    assert.equal(ALL_MESH_TOOLS.some(tool => tool.name === name), true, `${name} not registered`);
  }
});

test('mesh_change_impact_config_schema exposes an empty-input schema like the refine sibling', () => {
  assert.equal(MESH_CHANGE_IMPACT_CONFIG_SCHEMA_TOOL.name, 'mesh_change_impact_config_schema');
  assert.equal(MESH_CHANGE_IMPACT_CONFIG_SCHEMA_TOOL.inputSchema.type, 'object');
  assert.deepEqual(MESH_CHANGE_IMPACT_CONFIG_SCHEMA_TOOL.inputSchema.properties, {});
  assert.match(MESH_CHANGE_IMPACT_CONFIG_SCHEMA_TOOL.description, /never executed|never executes|never executed\.|parsed, never executed/i);
});

test('mesh_validate_change_impact_config accepts node_id + inline config like the refine sibling', () => {
  const props = MESH_VALIDATE_CHANGE_IMPACT_CONFIG_TOOL.inputSchema.properties as any;
  assert.equal(MESH_VALIDATE_CHANGE_IMPACT_CONFIG_TOOL.name, 'mesh_validate_change_impact_config');
  assert.equal(props.node_id.type, 'string');
  assert.equal(props.config.type, 'object');
});

test('mesh_suggest_change_impact_config exposes node_id and stays scaffold-only', () => {
  const props = MESH_SUGGEST_CHANGE_IMPACT_CONFIG_TOOL.inputSchema.properties as any;
  assert.equal(MESH_SUGGEST_CHANGE_IMPACT_CONFIG_TOOL.name, 'mesh_suggest_change_impact_config');
  assert.equal(props.node_id.type, 'string');
  assert.match(MESH_SUGGEST_CHANGE_IMPACT_CONFIG_TOOL.description, /scaffold only|never executed|reviewed and saved/i);
});
