import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendKeys } from '../src/tools/mesh-tools.js';

// MESH-SEND-KEYS (feature 3: key injection). The MCP handler enforces the
// DESTRUCTIVE double gate (confirm_destructive + mesh/node policy) BEFORE issuing
// the daemon send_keys command, and forwards non-destructive sequences through.

function makeCtx(meshPolicy: Record<string, unknown> = {}, nodePolicy: Record<string, unknown> = {}) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const sendKeysCalls: Array<Record<string, unknown>> = [];
  transport.command = async (command, args = {}) => {
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'get_mesh') return { success: true, mesh: (args as any).inlineMesh || mesh };
    if (command === 'send_keys') {
      sendKeysCalls.push(args);
      return { success: true, keys: ['ENTER'], submits: true, hasDestructive: false, bytes: 1 };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command, args = {}) => {
    if (command === 'get_status_metadata') return { success: true, result: { status: { sessions: [] } } };
    if (command === 'send_keys') { sendKeysCalls.push(args); return { success: true, result: { success: true } }; }
    return { success: true, result: { success: true } };
  };

  const mesh = {
    id: 'mesh-keys',
    name: 'Keys Mesh',
    repoIdentity: 'example/repo',
    policy: meshPolicy,
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-mac',
      workspace: '/repo',
      repoRoot: '/repo',
      userOverrides: {},
      policy: nodePolicy,
    }],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-mac' } as any;
  return { ctx, sendKeysCalls };
}

test('non-destructive sequence is forwarded to the daemon send_keys command', async () => {
  const { ctx, sendKeysCalls } = makeCtx();
  const result = JSON.parse(await meshSendKeys(ctx, {
    node_id: 'node-mac',
    session_id: 'sess-1',
    sequence: [{ text: 'ls' }, { key: 'ENTER' }],
  }));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(sendKeysCalls.length, 1, 'daemon send_keys issued once');
  assert.deepEqual(sendKeysCalls[0].sequence, [{ text: 'ls' }, { key: 'ENTER' }]);
});

test('destructive key WITHOUT confirm_destructive is refused before the daemon command', async () => {
  const { ctx, sendKeysCalls } = makeCtx({ allowSendKeysDestructive: true });
  const result = JSON.parse(await meshSendKeys(ctx, {
    node_id: 'node-mac',
    session_id: 'sess-1',
    sequence: [{ key: 'CTRL_C' }],
  }));
  assert.equal(result.success, false);
  assert.equal(result.refused, 'destructive_gate');
  assert.equal(sendKeysCalls.length, 0, 'no daemon command issued on refusal');
});

test('destructive key WITH confirm but WITHOUT policy opt-in is refused', async () => {
  const { ctx, sendKeysCalls } = makeCtx({ allowSendKeysDestructive: false });
  const result = JSON.parse(await meshSendKeys(ctx, {
    node_id: 'node-mac',
    session_id: 'sess-1',
    sequence: [{ key: 'CTRL_C' }],
    confirm_destructive: true,
  }));
  assert.equal(result.success, false);
  assert.equal(result.refused, 'destructive_gate');
  assert.equal(result.policyAllowsDestructive, false);
  assert.equal(sendKeysCalls.length, 0);
});

test('destructive key WITH confirm AND policy opt-in is forwarded', async () => {
  const { ctx, sendKeysCalls } = makeCtx({ allowSendKeysDestructive: true });
  const result = JSON.parse(await meshSendKeys(ctx, {
    node_id: 'node-mac',
    session_id: 'sess-1',
    sequence: [{ key: 'CTRL_C' }],
    confirm_destructive: true,
  }));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(sendKeysCalls.length, 1);
  assert.equal(sendKeysCalls[0].confirm_destructive, true);
});

test('a node policy opt-in overrides a mesh-level opt-out', async () => {
  const { ctx, sendKeysCalls } = makeCtx({ allowSendKeysDestructive: false }, { allowSendKeysDestructive: true });
  const result = JSON.parse(await meshSendKeys(ctx, {
    node_id: 'node-mac',
    session_id: 'sess-1',
    sequence: [{ key: 'ESC' }],
    confirm_destructive: true,
  }));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(sendKeysCalls.length, 1);
});

test('empty sequence is rejected', async () => {
  const { ctx, sendKeysCalls } = makeCtx();
  const result = JSON.parse(await meshSendKeys(ctx, { node_id: 'node-mac', session_id: 'sess-1', sequence: [] }));
  assert.equal(result.success, false);
  assert.equal(sendKeysCalls.length, 0);
});
