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
import {
  meshAddNode,
  meshCreate,
  meshPlanOnboarding,
} from '../src/tools/mesh-tools-crud.js';

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

test('mesh_plan_onboarding forwards only a read-only planning command', async () => {
  const calls: Array<{ type: string; args: any }> = [];
  const transport = {
    command: async (type: string, args: any) => {
      calls.push({ type, args });
      return { success: true, dryRun: true, plan: { kind: 'create_mesh_and_onboard' } };
    },
  } as any;

  const result = JSON.parse(await meshPlanOnboarding(transport, {
    workspace: '/repo',
    operation: 'auto',
  }));
  assert.equal(result.dryRun, true);
  assert.deepEqual(calls, [{
    type: 'plan_mesh_onboarding',
    args: { workspace: '/repo', operation: 'auto' },
  }]);
});

test('mesh_create auto-detection refuses to create when a compatible mesh exists', async () => {
  const calls: Array<{ type: string; args: any }> = [];
  const transport = {
    command: async (type: string, args: any) => {
      calls.push({ type, args });
      return {
        success: true,
        dryRun: true,
        plan: { kind: 'add_existing_workspace', summary: 'Use existing mesh.' },
      };
    },
  } as any;

  const result = JSON.parse(await meshCreate(transport, { name: 'duplicate', workspace: '/repo' }));
  assert.equal(result.success, false);
  assert.equal(result.code, 'compatible_mesh_exists');
  assert.deepEqual(calls.map(call => call.type), ['plan_mesh_onboarding']);
});

test('mesh_add_node fails closed before the write when onboarding preflight fails', async () => {
  const calls: Array<{ type: string; args: any }> = [];
  const transport = {
    command: async (type: string, args: any) => {
      calls.push({ type, args });
      return {
        success: false,
        dryRun: true,
        code: 'unrelated_repo_identity',
        error: 'Repository does not match.',
        action: 'Choose the matching mesh.',
      };
    },
  } as any;

  const result = JSON.parse(await meshAddNode(transport, {
    mesh_id: 'mesh_a',
    workspace: '/repo',
  }));
  assert.equal(result.success, false);
  assert.equal(result.code, 'unrelated_repo_identity');
  assert.deepEqual(calls.map(call => call.type), ['plan_mesh_onboarding']);
});
