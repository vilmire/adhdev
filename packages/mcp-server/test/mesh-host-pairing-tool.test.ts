import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import { TOOL_ANNOTATIONS } from '../src/tools/tool-annotations.js';

const MEMBER = 'daemon_mach_00000000000000000000000000000b02';

function ctxWith(relay: boolean) {
  const calls: Array<{ kind: string; target?: string; type: string; args: Record<string, unknown> }> = [];
  const transport: any = {
    command: async (type: string, args: Record<string, unknown>) => { calls.push({ kind: 'local', type, args }); return { success: true, token: 'CODE' }; },
    ...(relay ? { supportsMeshRelay: true, meshCommand: async (target: string, type: string, args: Record<string, unknown>) => { calls.push({ kind: 'relay', target, type, args }); return { success: true, code: 'mesh_host_pin_applied' }; } } : {}),
  };
  return { calls, ctx: { mesh: { id: 'mesh_active' }, transport } as any };
}

test('mesh_host_pairing is published, a write tool, and takes no key material', () => {
  const tool: any = ALL_MESH_TOOLS.find(t => t.name === 'mesh_host_pairing');
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['action', 'code', 'target_daemon_id']);
  assert.equal(TOOL_ANNOTATIONS.mesh_host_pairing?.readOnlyHint, false);
  assert.equal(typeof resolveMeshToolHandler('mesh_host_pairing'), 'function');
});

test('create_code mints a code for the active mesh only', async () => {
  const { ctx, calls } = ctxWith(true);
  await resolveMeshToolHandler('mesh_host_pairing')!(ctx, { action: 'create_code', meshId: 'mesh_other' });
  assert.deepEqual(calls, [{ kind: 'local', type: 'create_mesh_host_pairing_token', args: { meshId: 'mesh_active' } }]);
});

test('pin_host_key relays pin_mesh_host_key to the exact member with the code and the active mesh', async () => {
  const { ctx, calls } = ctxWith(true);
  const out = JSON.parse(await resolveMeshToolHandler('mesh_host_pairing')!(ctx, { action: 'pin_host_key', target_daemon_id: MEMBER, code: 'CODE-1', hostAddress: '203.0.113.9:3847' }));
  assert.equal(out.success, true);
  assert.deepEqual(calls, [{ kind: 'relay', target: MEMBER, type: 'pin_mesh_host_key', args: { meshId: 'mesh_active', token: 'CODE-1' } }]);
});

test('pin_host_key refuses a malformed target, a missing code, and a transport that cannot relay', async () => {
  const { ctx, calls } = ctxWith(true);
  const run = async (c: any, a: any) => JSON.parse(await resolveMeshToolHandler('mesh_host_pairing')!(c, a));
  assert.equal((await run(ctx, { action: 'pin_host_key', target_daemon_id: 'member-a', code: 'x' })).code, 'INVALID_TARGET');
  assert.equal((await run(ctx, { action: 'pin_host_key', target_daemon_id: MEMBER })).code, 'mesh_host_pin_token_required');
  assert.equal((await run(ctxWith(false).ctx, { action: 'pin_host_key', target_daemon_id: MEMBER, code: 'x' })).code, 'mesh_relay_unavailable');
  assert.equal((await run(ctx, { action: 'nope' })).code, 'INVALID_ARGUMENTS');
  assert.equal(calls.length, 0);
});
