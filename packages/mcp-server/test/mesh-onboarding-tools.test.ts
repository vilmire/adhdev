import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_MESH_TOOLS,
  MESH_INIT_TOOL,
  MESH_REINIT_TOOL,
  MESH_WRITE_MESH_JSON_CONFIG_TOOL,
  MESH_MAGI_KIND_PANEL_SET_TOOL,
  MESH_MAGI_KIND_PANEL_LIST_TOOL,
} from '../src/tools/mesh-tools.js';

test('mesh_init schema documents all three .adhdev/* config families + current-config echo', () => {
  assert.equal(MESH_INIT_TOOL.name, 'mesh_init');
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_init'), true);
  // change-impact is now covered alongside refine + worktree_bootstrap.
  assert.match(MESH_INIT_TOOL.description, /change-impact|change_impact/i);
  assert.match(MESH_INIT_TOOL.description, /refine/i);
  assert.match(MESH_INIT_TOOL.description, /bootstrap/i);
  assert.equal(MESH_INIT_TOOL.inputSchema.properties.write.type, 'boolean');
  assert.equal(MESH_INIT_TOOL.inputSchema.properties.overwrite.type, 'boolean');
});

test('mesh_reinit is registered and gates overwrite behind a current-vs-suggested diff', () => {
  assert.equal(MESH_REINIT_TOOL.name, 'mesh_reinit');
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_reinit'), true);
  // reinit must present a diff + get explicit approval; overwrite is wholesale.
  assert.match(MESH_REINIT_TOOL.description, /current-vs-suggested|diff/i);
  assert.match(MESH_REINIT_TOOL.description, /overwrite/i);
  assert.match(MESH_REINIT_TOOL.description, /approval/i);
  assert.equal(MESH_REINIT_TOOL.inputSchema.properties.write.type, 'boolean');
  assert.equal(MESH_REINIT_TOOL.inputSchema.properties.overwrite.type, 'boolean');
});

test('mesh_write_mesh_json_config is the gated write of the repo mesh.json', () => {
  assert.equal(MESH_WRITE_MESH_JSON_CONFIG_TOOL.name, 'mesh_write_mesh_json_config');
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_write_mesh_json_config'), true);
  assert.match(MESH_WRITE_MESH_JSON_CONFIG_TOOL.description, /mesh\.json/);
  assert.match(MESH_WRITE_MESH_JSON_CONFIG_TOOL.description, /REPO-COMMITTED|repo/i);
  assert.equal(MESH_WRITE_MESH_JSON_CONFIG_TOOL.inputSchema.properties.write.type, 'boolean');
  assert.equal(MESH_WRITE_MESH_JSON_CONFIG_TOOL.inputSchema.properties.overwrite.type, 'boolean');
});

test('mesh_magi_kind_panel_set exposes the kind-slot write with wholesale-replacement labeling', () => {
  assert.equal(MESH_MAGI_KIND_PANEL_SET_TOOL.name, 'mesh_magi_kind_panel_set');
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_magi_kind_panel_set'), true);
  assert.deepEqual(MESH_MAGI_KIND_PANEL_SET_TOOL.inputSchema.required, ['task_kind', 'slots']);
  // The write is a full slot-list replacement requiring explicit approval.
  assert.match(MESH_MAGI_KIND_PANEL_SET_TOOL.description, /WHOLESALE REPLACEMENT|replacement/i);
  assert.match(MESH_MAGI_KIND_PANEL_SET_TOOL.description, /approval/i);
  assert.match(MESH_MAGI_KIND_PANEL_SET_TOOL.description, /machine-local/i);
  // slots carry the provider (required) + model axis.
  const slotProps = (MESH_MAGI_KIND_PANEL_SET_TOOL.inputSchema.properties.slots as any).items.properties;
  assert.equal(slotProps.provider.type, 'string');
  assert.equal(slotProps.model.type, 'string');
  assert.deepEqual((MESH_MAGI_KIND_PANEL_SET_TOOL.inputSchema.properties.slots as any).items.required, ['provider']);
  assert.equal(MESH_MAGI_KIND_PANEL_SET_TOOL.inputSchema.properties.write.type, 'boolean');
});

test('mesh_magi_kind_panel_list is a read-only sibling', () => {
  assert.equal(MESH_MAGI_KIND_PANEL_LIST_TOOL.name, 'mesh_magi_kind_panel_list');
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_magi_kind_panel_list'), true);
  assert.equal(MESH_MAGI_KIND_PANEL_LIST_TOOL.inputSchema.properties.task_kind.type, 'string');
});
