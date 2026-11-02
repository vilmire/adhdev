import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_MESH_TOOL_NAMES, ASSISTANT_TOOLS, ASSISTANT_TOOL_VERBS } from '@adhdev/mesh-shared';
import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { meshFileTransfer } from '../src/tools/mesh-tools-transfer.js';
import { resolveAssistantModeTools, callAssistantTool } from '../src/tools/assistant-tools.js';
import { validateMeshToolArgs } from '../src/tools/validate-tool-args.js';

function ctx(commands: Array<{ type: string; args: any }>, reply: any = { success: true, transferId: 't1' }) {
  return {
    mesh: { id: 'mesh-1', name: 'm', nodes: [{ id: 'node-b', daemonId: 'daemon_mach_b', workspace: '/srv/b' }] },
    transport: { command: async (type: string, args: any) => { commands.push({ type, args }); return reply; } },
  } as any;
}

test('mesh_file_transfer is a published coordinator tool with an owner-approval description and no approve action', () => {
  assert.ok((CANONICAL_MESH_TOOL_NAMES as readonly string[]).includes('mesh_file_transfer'));
  const tool = ALL_MESH_TOOLS.find((t) => t.name === 'mesh_file_transfer')!;
  assert.ok(tool);
  assert.deepEqual((tool.inputSchema.properties as any).action.enum, ['request', 'status', 'cancel']);
  assert.match(tool.description, /YOU CANNOT APPROVE/);
  assert.ok(JSON.stringify(tool).length < 3500, 'schema stays small');
});

test('request resolves a node id to its machine and workspace and calls only project_transfer_agent', async () => {
  const calls: Array<{ type: string; args: any }> = [];
  const out = JSON.parse(await meshFileTransfer(ctx(calls), { action: 'request', from_workspace: 'src', selected: ['a'], to_node_id: 'node-b', final_name: 'in' } as any));
  assert.equal(out.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'project_transfer_agent');
  assert.deepEqual(calls[0].args, { action: 'request', fromWorkspace: 'src', selected: ['a'], toDaemonId: 'daemon_mach_b', toWorkspace: '/srv/b', finalName: 'in' });
});

test('request can name another machine as the source (node id or daemon id) and status routes by machine', async () => {
  const calls: Array<{ type: string; args: any }> = [];
  const c = ctx(calls);
  await meshFileTransfer(c, { action: 'request', from_node_id: 'node-b', selected: ['a'], to_daemon_id: 'daemon_mach_z', to_workspace: 'w', final_name: 'in' } as any);
  assert.equal(calls[0].args.fromDaemonId, 'daemon_mach_b');
  assert.equal(calls[0].args.fromWorkspace, '/srv/b');
  await meshFileTransfer(c, { action: 'request', from_daemon_id: 'daemon_mach_q', from_workspace: 'src', selected: ['a'], to_daemon_id: 'daemon_mach_z', final_name: 'in' } as any);
  assert.equal(calls[1].args.fromDaemonId, 'daemon_mach_q');
  await meshFileTransfer(c, { action: 'status', transfer_id: 't', from_daemon_id: 'daemon_mach_q' } as any);
  assert.deepEqual(calls[2].args, { action: 'status', transferId: 't', fromDaemonId: 'daemon_mach_q' });
  const props = (ALL_MESH_TOOLS.find((t) => t.name === 'mesh_file_transfer')!.inputSchema.properties as any);
  assert.ok(props.from_node_id && props.from_daemon_id);
  assert.equal(validateMeshToolArgs('mesh_file_transfer', { action: 'request', fromDaemonId: 'x' }), null);
});

test('status and cancel forward the transfer id; daemon refusals surface as failures', async () => {
  const calls: Array<{ type: string; args: any }> = [];
  await meshFileTransfer(ctx(calls), { action: 'cancel', transfer_id: 'abc' });
  assert.deepEqual(calls[0].args, { action: 'cancel', transferId: 'abc' });
  const refused = JSON.parse(await meshFileTransfer(ctx([], { success: false, code: 'transfer_agent_not_allowed', error: 'no' }), { action: 'status' }));
  assert.deepEqual(refused, { success: false, error: 'no', code: 'transfer_agent_not_allowed' });
});

test('argument gate: unknown arguments are rejected, camelCase aliases accepted', () => {
  assert.match(validateMeshToolArgs('mesh_file_transfer', { action: 'status', approve: true }) ?? '', /approve/);
  assert.equal(validateMeshToolArgs('mesh_file_transfer', { action: 'status', transferId: 'x' }), null);
});

test('assistant file_transfer maps to its verb, carries the session credential and is a write tool', async () => {
  assert.ok((ASSISTANT_TOOLS as readonly string[]).includes('file_transfer'));
  assert.equal(ASSISTANT_TOOL_VERBS.file_transfer, 'assistant_file_transfer');
  const tool = resolveAssistantModeTools().find((t) => t.name === 'file_transfer')!;
  assert.equal(tool.annotations?.readOnlyHint, false);
  process.env.ADHDEV_MCP_SESSION_CREDENTIAL = 'mcp_sess_test';
  const calls: any[] = [];
  await callAssistantTool({ command: async (type: string, args: any) => { calls.push({ type, args }); return { success: true }; } } as any, 'file_transfer', { project: 'p', action: 'status' }, 'sess-1');
  delete process.env.ADHDEV_MCP_SESSION_CREDENTIAL;
  assert.equal(calls[0].type, 'assistant_file_transfer');
  assert.equal(calls[0].args.mcpSessionCredential, 'mcp_sess_test');
});
