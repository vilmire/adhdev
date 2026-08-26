import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask } from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { enqueueTask, getQueue, getLedgerDir } from '@adhdev/daemon-core';

// EAGERPUSH-FANOUT-FENCE — mcp-server R1 + R3.
//
//   R1 (fan-out fence). The cloud "enqueue-and-push" path (IpcTransport) eagerly
//   P2P-dispatches a freshly enqueued task straight into a remote idle session,
//   bypassing the queue claim. It used to loop over EVERY remote node and push to each
//   one satisfying requiredTags, so an UNTARGETED task was broadcast to the whole fleet:
//   N machines each received the same taskId and each started it. Observed live — one
//   readonly task ran to completion on two machines. A write task would have been a
//   double commit, and it defeats daemon-core's write guards (nodeConflictAllows /
//   convergenceAllows) because those fence the queue-CLAIM inside ONE daemon process and
//   cannot see a push a different process already made. A task has one assignee, so the
//   push must name exactly one receiver — readonly and write alike.
//
//   R3 (status recheck). The local queue drain runs between enqueue and push, so a local
//   node may already have claimed the row. Pushing then injects an ALREADY-ASSIGNED task
//   into a second session — the same double execution by another route. Only a still
//   `pending` row may be eager-pushed.
//
// Red before the fix: 'exactly one remote node' asserted 2 (both remote daemons injected).

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';
const NODE_LNX = 'node_lnx_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_eager_fence_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

// A transport that records every command / meshCommand it receives AND passes
// `instanceof IpcTransport` (so meshEnqueueTask takes the cloud eager-push branch)
// WITHOUT opening a real websocket. meshCommand is the per-node injection signal —
// ipcDispatchToRemoteAgent calls it (get_status_metadata) to fetch remote session truth
// before dispatching, so one recorded daemonId == one node the push reached.
function recordingIpcTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  const meshCommands: Array<{ daemonId: string; cmd: string; args: any }> = [];
  const t = {
    commands,
    meshCommands,
    command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
    meshCommand: async (daemonId: string, cmd: string, args: any) => {
      meshCommands.push({ daemonId, cmd, args });
      return { success: true, sessions: [] };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  Object.setPrototypeOf(t, IpcTransport.prototype);
  return t;
}

/** Distinct remote daemons the eager push actually reached. */
function injectedDaemonIds(transport: any): string[] {
  return [...new Set(transport.meshCommands.map((c: any) => c.daemonId as string))];
}

function makeCtx(meshId: string, transport: any, nodes?: any[]) {
  return {
    mesh: {
      id: meshId,
      nodes: nodes ?? [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' },
        { id: NODE_WIN, workspace: '/repo/win', daemonId: 'daemon_win' },
        { id: NODE_LNX, workspace: '/repo/lnx', daemonId: 'daemon_lnx' },
      ],
    },
    transport,
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

test('R1: an UNTARGETED task is eager-pushed to exactly one remote node (no fleet broadcast)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'untargeted work', difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, undefined, 'this task must genuinely be untargeted');

  // Wait out the fire-and-forget dispatch promises.
  await new Promise(resolve => setImmediate(resolve));

  const injected = injectedDaemonIds(transport);
  assert.equal(
    injected.length, 1,
    `an untargeted task must reach exactly ONE remote node; reached ${injected.length} (${injected.join(', ')})`,
  );
  assert.ok(
    ['daemon_mac', 'daemon_win', 'daemon_lnx'].includes(injected[0]),
    'the single receiver must be one of the eligible remote nodes',
  );
});

test('R1: an UNTARGETED READONLY task is fenced identically (no readonly exemption)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'untargeted readonly work', readonly: true, task_mode: 'live_debug', difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  await new Promise(resolve => setImmediate(resolve));

  // The live incident was a READONLY task double-running, so the fence must not treat
  // readonly as safe-to-broadcast just because it does not commit.
  assert.equal(injectedDaemonIds(transport).length, 1, 'a readonly task must not be broadcast either');
});

test('R1: a TARGETED task still reaches only its target (pre-existing behavior preserved)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'pinned work', target_node_id: NODE_WIN, difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_WIN);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(injectedDaemonIds(transport), ['daemon_win'], 'a pinned task may only reach its target node');
});

test('R1: requiredTags still filter eligibility — the single receiver is a SATISFYING node', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  // Only the win node carries os=windows, so tag filtering must pick it even though
  // the mac node comes first in mesh order.
  const ctx = makeCtx(meshId, transport, [
    { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac', reportedPlatform: 'darwin' },
    { id: NODE_WIN, workspace: '/repo/win', daemonId: 'daemon_win', reportedPlatform: 'win32' },
  ]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'windows-only work', required_tags: ['os=win32'], difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(
    injectedDaemonIds(transport), ['daemon_win'],
    'the single receiver must be the node that satisfies requiredTags, not merely the first node',
  );
});

test('R1: no eligible remote node → 0 injections (task waits for the queue, no crash)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport, [
    { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac', reportedPlatform: 'darwin' },
  ]);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'unsatisfiable tags', required_tags: ['os=win32'], difficulty: 'medium',
  } as any));
  assert.equal(res.success, true, 'enqueue still succeeds — the eager push is only an accelerator');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(injectedDaemonIds(transport).length, 0, 'no node satisfies the tags, so nothing may be pushed');
});

test('R3: an ALREADY-ASSIGNED task is not eager-pushed (0 injections)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);

  // Simulate the drain claiming the row between enqueue and push: the local queue
  // trigger (trigger_mesh_queue, issued by meshEnqueueTask before the push) is where
  // that really happens, so hook it to move the freshly-inserted row out of `pending`.
  transport.command = async (cmd: string, args: any) => {
    transport.commands.push({ cmd, args });
    if (cmd === 'trigger_mesh_queue') {
      const row = getQueue(meshId).find(t => t.status === 'pending');
      if (row) {
        const { updateTaskStatus } = await import('@adhdev/daemon-core');
        updateTaskStatus(meshId, row.id, 'assigned');
      }
    }
    return { success: true };
  };

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'claimed before the push landed', difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  assert.equal(
    getQueue(meshId).find(t => t.id === res.taskId)?.status, 'assigned',
    'precondition: the drain must have claimed the row before the push ran',
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(
    injectedDaemonIds(transport).length, 0,
    'a task that is no longer pending belongs to its assignee — pushing it would double-execute it',
  );
});

test('R3: a still-pending task IS pushed (the recheck does not break the normal path)', async () => {
  const meshId = nextMeshId();
  // A pre-existing unrelated assigned row must not confuse the recheck — it reads
  // THIS task's row by id, not "any row".
  const other = enqueueTask(meshId, 'unrelated older task', { difficulty: 'medium' });
  const { updateTaskStatus } = await import('@adhdev/daemon-core');
  updateTaskStatus(meshId, other.id, 'assigned');

  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'normal pending work', difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  assert.equal(res.status, 'pending');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(injectedDaemonIds(transport).length, 1, 'a pending task must still be eager-pushed exactly once');
});
