import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { meshEnqueueBatch } from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { enqueueTask, getQueue, updateTaskStatus } from '@adhdev/daemon-core';

// G5 — mesh_enqueue_batch: atomic multi-task graph submission.
//   The tool must (a) insert ALL tasks or NONE (a mid-batch cycle / unknown ref /
//   invalid difficulty rolls the batch back), (b) resolve batch-local refs to the
//   generated task ids with forward references allowed, and (c) on the cloud
//   IpcTransport path eager-push ONLY the roots — dependents stay gated by the
//   same taskDependenciesSatisfied predicate as the queue claim
//   (DEPENDSON-GATE-SYMMETRY).

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';

function nextMeshId(): string {
  return `mesh_enqueue_batch_${randomUUID().slice(0, 8)}`;
}

// Same recording double as mesh-dependson-eager-push-gate.test.ts: passes the
// `instanceof IpcTransport` branch selector without a real websocket.
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

// A local (non-IPC) transport: only the queue trigger runs, no eager push branch.
function recordingLocalTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  return {
    commands,
    command: async (cmd: string, args: any) => { commands.push({ cmd, args }); return { success: true }; },
    getStatus: async () => ({ sessions: [] }),
  } as any;
}

function makeCtx(meshId: string, transport: any) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' },
        { id: NODE_WIN, workspace: '/repo/win', daemonId: 'daemon_win' },
      ],
    },
    transport,
  } as any;
}

test('happy path: refs resolve (forward references allowed), all tasks persisted', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      // Scrambled on purpose: the first entry depends on a ref defined later.
      { ref: 'verify', message: 'verify the fix', depends_on: ['fix'], difficulty: 'easy' },
      { ref: 'fix', message: 'apply the fix', depends_on: ['investigate'], difficulty: 'easy' },
      { ref: 'investigate', message: 'find the bug', difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, true);
  assert.equal(res.atomic, true);
  assert.equal(res.enqueued, 3);
  const byRef = new Map(res.tasks.map((t: any) => [t.ref, t]));
  const verify = byRef.get('verify') as any;
  const fix = byRef.get('fix') as any;
  const investigate = byRef.get('investigate') as any;
  assert.deepEqual(verify.dependsOn, [fix.taskId], 'verify must depend on the generated id of fix');
  assert.deepEqual(fix.dependsOn, [investigate.taskId]);
  assert.equal(investigate.dependsOn, undefined);
  assert.equal(getQueue(meshId).length, 3);
});

test('atomic rollback: an unknown dependency in a later entry inserts NOTHING', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'ok', message: 'valid first entry', difficulty: 'easy' },
      { message: 'broken second entry', depends_on: ['no-such-ref'], difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'unknown_dependency');
  assert.equal(res.enqueued, 0);
  assert.equal(getQueue(meshId).length, 0, 'the valid first entry must have been rolled back');
});

test('atomic rollback: an intra-batch cycle inserts NOTHING', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'a', message: 'a depends on b', depends_on: ['b'], difficulty: 'easy' },
      { ref: 'b', message: 'b depends on a', depends_on: ['a'], difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'dependency_cycle_detected');
  assert.equal(getQueue(meshId).length, 0);
});

test('pre-insert validation: a bad target node in ANY entry refuses the whole batch', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'ok', message: 'valid entry', difficulty: 'easy' },
      { ref: 'bad', message: 'bad target', target_node_id: 'node_that_does_not_exist', difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'target_node_not_found');
  assert.equal(res.taskIndex, 1);
  assert.equal(res.ref, 'bad');
  assert.equal(getQueue(meshId).length, 0);
});

test('top-level mission_id applies to every entry; a per-entry override wins', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    mission_id: 'mission_batch',
    tasks: [
      { ref: 'a', message: 'inherits batch mission', difficulty: 'easy' },
      { ref: 'b', message: 'overrides mission', mission_id: 'mission_override', difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, true);
  const rows = getQueue(meshId);
  const a = rows.find(t => t.message === 'inherits batch mission');
  const b = rows.find(t => t.message === 'overrides mission');
  assert.equal(a?.missionId, 'mission_batch');
  assert.equal(b?.missionId, 'mission_override');
});

test('IpcTransport: only ROOTS are eager-pushed; dependents are deferred (gate symmetry)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'root', message: 'independent root work', difficulty: 'easy' },
      { ref: 'child', message: 'dependent work', depends_on: ['root'], difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, true);
  assert.equal(res.eagerPushDeferred, 1, 'exactly the dependent must be deferred');
  assert.equal(res.eagerPushDeferredReason, 'dependencies_unsatisfied');
  const rootTaskId = (res.tasks.find((t: any) => t.ref === 'root') as any).taskId;
  // Every remote-dispatch attempt must reference the ROOT task only — the dependent
  // must never reach a remote session before its prerequisite completes.
  for (const mc of transport.meshCommands) {
    const taskId = mc?.args?.meshContext?.taskId;
    if (taskId) assert.equal(taskId, rootTaskId);
  }
});

test('a dependency on an already-COMPLETED existing task counts as satisfied for the push gate', async () => {
  const meshId = nextMeshId();
  const done = enqueueTask(meshId, 'already finished prerequisite', { difficulty: 'easy' });
  updateTaskStatus(meshId, done.id, 'completed');

  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'next', message: 'runs right away', depends_on: [done.id], difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, true);
  assert.equal(res.eagerPushDeferred, undefined, 'a satisfied dependency must not defer the push');
});

test('empty and over-shaped input fail loudly without touching the queue', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());

  const empty = JSON.parse(await meshEnqueueBatch(ctx, { tasks: [] } as any));
  assert.equal(empty.success, false);
  assert.equal(empty.code, 'empty_task_graph');

  const missingMessage = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [{ ref: 'x', difficulty: 'easy' }],
  } as any));
  assert.equal(missingMessage.success, false);
  assert.equal(missingMessage.code, 'invalid_message');
  assert.match(missingMessage.error, /mesh_enqueue_batch task 'x'/);

  assert.equal(getQueue(meshId).length, 0);
});
