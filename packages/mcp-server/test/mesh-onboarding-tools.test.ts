import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_MESH_TOOLS,
  MESH_INIT_TOOL,
  MESH_CONFIG_TOOL,
  MESH_CREATE_TOOL,
  MESH_MAGI_KIND_PANEL_TOOL,
  meshCreateOrPlan,
} from '../src/tools/mesh-tools.js';
import {
  meshAddNode,
  meshCreate,
  meshPlanOnboarding,
} from '../src/tools/mesh-tools-crud.js';
import { MESH_TOOL_ACTIONS, validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

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

test('mesh_init mode=reinit (was mesh_reinit) gates overwrite behind a current-vs-suggested diff', () => {
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_reinit'), false);
  assert.deepEqual((MESH_INIT_TOOL.inputSchema.properties as any).mode.enum, ['init', 'reinit']);
  // reinit must present a diff + get explicit approval; overwrite is wholesale.
  assert.match(MESH_INIT_TOOL.description, /mode="reinit"/);
  assert.match(MESH_INIT_TOOL.description, /current-vs-suggested|diff/i);
  assert.match(MESH_INIT_TOOL.description, /WHOLESALE replacement/);
  assert.match(MESH_INIT_TOOL.description, /EXPLICIT per-section approval/);
});

test('mesh_config kind=mesh_json (was mesh_write_mesh_json_config) is the gated write of the repo mesh.json', () => {
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_write_mesh_json_config'), false);
  assert.ok(((MESH_CONFIG_TOOL.inputSchema.properties as any).kind.enum as string[]).includes('mesh_json'));
  assert.match(MESH_CONFIG_TOOL.description, /mesh\.json/);
  assert.match(MESH_CONFIG_TOOL.description, /REPO-COMMITTED/);
  assert.equal((MESH_CONFIG_TOOL.inputSchema.properties as any).write.type, 'boolean');
  assert.equal((MESH_CONFIG_TOOL.inputSchema.properties as any).overwrite.type, 'boolean');
  assert.deepEqual([...MESH_TOOL_ACTIONS.mesh_config.actions.mesh_json.args].sort(), ['node_id', 'overwrite', 'workspace', 'write']);
});

test('mesh_magi_kind_panel action=set exposes the kind-slot write with wholesale-replacement labeling', () => {
  assert.equal(MESH_MAGI_KIND_PANEL_TOOL.name, 'mesh_magi_kind_panel');
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_magi_kind_panel'), true);
  assert.deepEqual(MESH_MAGI_KIND_PANEL_TOOL.inputSchema.required, ['action']);
  assert.deepEqual(MESH_TOOL_ACTIONS.mesh_magi_kind_panel.actions.set.required, ['task_kind', 'slots']);
  // The write is a full slot-list replacement requiring explicit approval.
  assert.match(MESH_MAGI_KIND_PANEL_TOOL.description, /WHOLESALE REPLACEMENT|replacement/i);
  assert.match(MESH_MAGI_KIND_PANEL_TOOL.description, /approval/i);
  assert.match(MESH_MAGI_KIND_PANEL_TOOL.description, /machine-local/i);
  // slots carry the provider (required) + model axis.
  const slotProps = (MESH_MAGI_KIND_PANEL_TOOL.inputSchema.properties.slots as any).items.properties;
  assert.equal(slotProps.provider.type, 'string');
  assert.equal(slotProps.model.type, 'string');
  assert.deepEqual((MESH_MAGI_KIND_PANEL_TOOL.inputSchema.properties.slots as any).items.required, ['provider']);
  assert.equal(MESH_MAGI_KIND_PANEL_TOOL.inputSchema.properties.write.type, 'boolean');
});

test('mesh_magi_kind_panel action=list is the read-only half', () => {
  assert.deepEqual((MESH_MAGI_KIND_PANEL_TOOL.inputSchema.properties as any).action.enum, ['list', 'set']);
  assert.equal(MESH_MAGI_KIND_PANEL_TOOL.inputSchema.properties.task_kind.type, 'string');
  assert.equal(validateMeshToolArgs('mesh_magi_kind_panel', { action: 'list', task_kind: 'rca' }), null);
  assert.match(validateMeshToolArgs('mesh_magi_kind_panel', { action: 'list', slots: [] }) ?? '', /"slots" \(belongs to action=set\)/);
});

test('onboarding planner core forwards only a read-only planning command', async () => {
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

// 2026-09-26 tool consolidation: mesh_plan_onboarding is mesh_create mode="plan".
// Drive both modes of the merged tool: plan must issue ONLY the read-only planning
// command (never create_mesh), and the default mode is still create.
test('mesh_create mode=plan runs only the read-only planner; the default mode still creates', async () => {
  assert.equal(ALL_MESH_TOOLS.some(t => t.name === 'mesh_plan_onboarding'), false);
  assert.deepEqual((MESH_CREATE_TOOL.inputSchema.properties as any).mode.enum, ['create', 'plan']);
  const calls: Array<{ type: string; args: any }> = [];
  const transport = {
    command: async (type: string, args: any) => {
      calls.push({ type, args });
      return { success: true, dryRun: true, plan: { kind: 'create_mesh_and_onboard' } };
    },
  } as any;
  const planned = JSON.parse(await meshCreateOrPlan(transport, { mode: 'plan', workspace: '/repo', operation: 'auto' }, 'mesh_active'));
  assert.equal(planned.dryRun, true);
  assert.deepEqual(calls, [{ type: 'plan_mesh_onboarding', args: { workspace: '/repo', meshId: 'mesh_active', operation: 'auto' } }]);

  // Per-mode argument sets: a create-only argument on a plan call is refused, and
  // plan requires workspace while create requires name.
  assert.match(validateMeshToolArgs('mesh_create', { mode: 'plan', workspace: '/repo', name: 'x' }) ?? '', /"name" \(belongs to mode=create\)/);
  assert.match(validateMeshToolArgs('mesh_create', { mode: 'plan' }) ?? '', /Missing required parameter\(s\) for mesh_create mode="plan": "workspace"/);
  assert.match(validateMeshToolArgs('mesh_create', {}) ?? '', /Missing required parameter\(s\) for mesh_create mode="create": "name"/);
});
