import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask, meshQueueCancel } from '../src/tools/mesh-tools.js';
import { enqueueTask, getQueue, claimNextTask, getLedgerDir } from '@adhdev/daemon-core';

// MESH-DISPATCH-MISROUTE — mcp-server tool-layer fixes.
//   Fix 1 (enqueue): a `target_node` / `targetNode` alias must resolve to a HARD targetNodeId
//     (previously only target_node_id / targetNodeId were read, so `target_node` was silently
//     dropped → an UNPINNED task any node, including a different machine, could claim). An
//     unresolvable target must FAIL LOUDLY (target_node_not_found), never enqueue unpinned.
//   Fix 2 (cancel): cancelling an ASSIGNED task must propagate an agent_command(action:'stop')
//     to the assigned worker session — never to the coordinator's own session.

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_misroute_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

function recordingTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  return {
    commands,
    command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
    getStatus: async () => ({ sessions: [] }),
  } as any;
}

function makeCtx(meshId: string, transport: any, coordinatorSessionId?: string) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' },
        { id: NODE_WIN, workspace: '/repo/win', daemonId: 'daemon_win' },
      ],
    },
    transport,
    ...(coordinatorSessionId ? { coordinatorSessionId } : {}),
  } as any;
}

test.after(() => {
  for (const meshId of createdMeshes) {
    for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
      const p = join(getLedgerDir(), `${meshId}${suffix}`);
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
});

test('fix1: target_node alias resolves to a hard targetNodeId pin', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingTransport());
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'pinned work', target_node: NODE_MAC } as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_MAC, 'target_node must resolve to a hard targetNodeId');
  // The persisted task row carries the pin so the claim tier can enforce it.
  assert.equal(getQueue(meshId)[0]?.targetNodeId, NODE_MAC);
});

test('fix1: camelCase targetNode alias also resolves', async () => {
  const ctx = makeCtx(nextMeshId(), recordingTransport());
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'pinned', targetNode: NODE_WIN } as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_WIN);
});

test('fix1: an unresolvable target is REJECTED, never enqueued unpinned', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingTransport());
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'oops', target_node: 'node_does_not_exist' } as any));
  assert.equal(res.success, false);
  assert.equal(res.code, 'target_node_not_found');
  // It must NOT have created a queue task (no silent unpinned fall-through).
  assert.equal(getQueue(meshId).length, 0, 'rejected enqueue must not write a task');
});

test('fix1: no target stays unpinned (existing behavior unchanged)', async () => {
  const ctx = makeCtx(nextMeshId(), recordingTransport());
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'anyone' } as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, undefined, 'no target → no pin');
});

test('fix2: cancelling an ASSIGNED task stops the assigned worker session', async () => {
  const meshId = nextMeshId();
  // Genuine assignment via the real claim path: enqueue then claim onto a worker session.
  const task = enqueueTask(meshId, 'assigned work', {});
  const claimed = claimNextTask(meshId, NODE_MAC, 'worker_sess_1', [], { providerType: 'claude-cli' });
  assert.ok(claimed, 'task must claim onto the worker session');
  assert.equal(claimed.id, task.id);
  assert.equal(claimed.assignedSessionId, 'worker_sess_1');

  const transport = recordingTransport();
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: task.id } as any));
  assert.equal(res.success, true);
  assert.equal(res.workerStop?.attempted, true);
  assert.equal(res.workerStop?.sessionId, 'worker_sess_1');

  const stopCmd = transport.commands.find((c: any) => c.cmd === 'agent_command' && c.args?.action === 'stop');
  assert.ok(stopCmd, 'a stop agent_command must be issued for the assigned worker');
  assert.equal(stopCmd.args.targetSessionId, 'worker_sess_1');
  assert.equal(stopCmd.args.cliType, 'claude-cli');
  assert.equal(stopCmd.args.meshContext?.nodeId, NODE_MAC);
});

test('fix2: cancel does NOT stop the coordinator self session (guard)', async () => {
  const meshId = nextMeshId();
  enqueueTask(meshId, 'self assigned', {});
  // Claim onto a session whose id == the coordinator's own session id.
  const claimed = claimNextTask(meshId, NODE_MAC, 'coordinator_sess', [], { providerType: 'claude-cli' });
  assert.ok(claimed);

  const transport = recordingTransport();
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: claimed.id } as any));
  assert.equal(res.success, true);
  assert.equal(res.workerStop?.attempted, false);
  const stopCmd = transport.commands.find((c: any) => c.cmd === 'agent_command' && c.args?.action === 'stop');
  assert.equal(stopCmd, undefined, 'must NOT stop the coordinator self session');
});

test('fix2: cancelling a PENDING task issues no worker stop', async () => {
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'pending work', {}); // stays pending, no assignment
  const transport = recordingTransport();
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: task.id } as any));
  assert.equal(res.success, true);
  assert.equal(res.workerStop?.attempted, false);
  const stopCmd = transport.commands.find((c: any) => c.cmd === 'agent_command' && c.args?.action === 'stop');
  assert.equal(stopCmd, undefined);
});
