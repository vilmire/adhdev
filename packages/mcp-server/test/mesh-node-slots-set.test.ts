import assert from 'node:assert/strict';
import test from 'node:test';

import { meshNodeSlotsSet, meshNodeSlotsList } from '../src/tools/mesh-tools.js';

/**
 * mesh_node_slots_set — the orchestrator's propose→approve surface for node
 * capability slots (ORCHESTRATION_NODE_SLOTS.md §5). These assert the approval
 * gate: dry-run by default (no mutation), and write=true routes an
 * update_mesh_node({ policy: { slots } }) to the node's daemon.
 */

const NODE = 'node_alpha';

function recordingTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  return {
    commands,
    command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
    getStatus: async () => ({ sessions: [] }),
  } as any;
}

function makeCtx(transport: any, nodeSlots?: any[]) {
  return {
    mesh: {
      id: 'mesh_test',
      name: 'mesh_test',
      nodes: [
        { id: NODE, workspace: '/repo/alpha', daemonId: 'daemon_alpha', policy: nodeSlots ? { slots: nodeSlots } : {} },
      ],
    },
    transport,
  } as any;
}

test('dry-run (default) returns current-vs-proposed and writes nothing', async () => {
  const transport = recordingTransport();
  const ctx = makeCtx(transport, [{ provider: 'codex-cli', difficulty: ['easy'] }]);

  const out = JSON.parse(await meshNodeSlotsSet(ctx, {
    node_id: NODE,
    slots: [{ provider: 'claude-cli', model: 'opus', difficulty: ['difficult'] }],
    reason: 'route difficult tasks to opus',
  }));

  assert.equal(out.success, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.reason, 'route difficult tasks to opus');
  // current reflects the node's existing slot; proposed reflects the (normalized) new one.
  assert.deepEqual(out.currentSlots, [{ provider: 'codex-cli', difficulty: ['easy'] }]);
  assert.equal(out.proposedSlots[0].provider, 'claude-cli');
  assert.equal(out.proposedSlots[0].model, 'opus');
  assert.deepEqual(out.proposedSlots[0].difficulty, ['difficult']);
  // NOTHING was written.
  assert.equal(transport.commands.length, 0);
});

test('write=true applies via update_mesh_node with the normalized slots', async () => {
  const transport = recordingTransport();
  const ctx = makeCtx(transport, [{ provider: 'codex-cli' }]);

  const out = JSON.parse(await meshNodeSlotsSet(ctx, {
    node_id: NODE,
    slots: [{ provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 2 }],
    write: true,
  }));

  assert.equal(out.success, true);
  assert.equal(out.written, true);
  // Exactly one update_mesh_node command routed to the node.
  assert.equal(transport.commands.length, 1);
  const cmd = transport.commands[0];
  assert.equal(cmd.cmd, 'update_mesh_node');
  assert.equal(cmd.args.meshId, 'mesh_test');
  assert.equal(cmd.args.nodeId, NODE);
  // Slots are sent under policy.slots (shallow-merged by the daemon), normalized.
  assert.deepEqual(cmd.args.policy.slots, [
    { provider: 'claude-cli', model: 'opus', difficulty: ['difficult'], maxParallel: 2 },
  ]);
});

test('a provider-less slot is dropped by normalization (never persisted)', async () => {
  const transport = recordingTransport();
  const ctx = makeCtx(transport, []);

  const out = JSON.parse(await meshNodeSlotsSet(ctx, {
    node_id: NODE,
    slots: [{ model: 'opus' }, { provider: 'claude-cli' }], // first has no provider
    write: true,
  }));

  assert.equal(out.written, true);
  assert.deepEqual(transport.commands[0].args.policy.slots, [{ provider: 'claude-cli' }]);
});

test('missing node_id is a clean error', async () => {
  const ctx = makeCtx(recordingTransport());
  const out = JSON.parse(await meshNodeSlotsSet(ctx, { slots: [] } as any));
  assert.equal(out.success, false);
  assert.match(out.error, /node_id required/);
});

test('list returns the node\'s normalized slots (read-only)', async () => {
  const transport = recordingTransport();
  const ctx = makeCtx(transport, [{ provider: 'claude-cli', model: 'opus' }, { provider: 'codex-cli' }]);
  const out = JSON.parse(await meshNodeSlotsList(ctx, { node_id: NODE }));
  assert.equal(out.success, true);
  assert.equal(out.slots.length, 2);
  assert.equal(out.slots[0].provider, 'claude-cli');
  assert.equal(transport.commands.length, 0); // read-only
});
