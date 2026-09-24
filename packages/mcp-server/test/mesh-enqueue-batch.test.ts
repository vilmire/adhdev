import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { meshEnqueueBatch } from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { getQueue, upsertMeshMission } from '@adhdev/daemon-core';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
// G5 — mesh_enqueue_batch: atomic multi-task graph submission.
//   The tool must (a) insert ALL tasks or NONE (a mid-batch cycle / unknown ref /
//   invalid difficulty rolls the batch back), (b) resolve batch-local refs to the
//   generated task ids with forward references allowed, and (c) on the cloud
//   IpcTransport path push NOTHING at enqueue — every task reaches a session only
//   through the daemon's queue claim (rc.37 Finding B).

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';

function nextMeshId(): string {
  return `mesh_enqueue_batch_${randomUUID().slice(0, 8)}`;
}

// A recording double that passes `instanceof IpcTransport` without a real websocket.
function recordingIpcTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  const meshCommands: Array<{ daemonId: string; cmd: string; args: any }> = [];
  const t = {
    commands,
    meshCommands,
    command: async (cmd: string, args: any) => {
    if (isTurnIpcCommand(cmd)) return answerTurnIpc(cmd, args ?? {} as Record<string, unknown>); commands.push({ cmd, args }); return { success: true }; },
    meshCommand: async (daemonId: string, cmd: string, args: any) => {
      meshCommands.push({ daemonId, cmd, args });
      return { success: true, sessions: [] };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  Object.setPrototypeOf(t, IpcTransport.prototype);
  return t;
}

// A local (non-IPC) transport: only the queue trigger runs.
function recordingLocalTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  return {
    commands,
    command: async (cmd: string, args: any) => {
    if (isTurnIpcCommand(cmd)) return answerTurnIpc(cmd, args ?? {} as Record<string, unknown>); commands.push({ cmd, args }); return { success: true }; },
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
  // MISSION-UPSERT-SILENT-CREATE: mission_id must resolve to a real mission (an
  // unresolvable id now rejects the whole batch) — both ids used below must exist.
  const batchMission = upsertMeshMission(meshId, { title: 'Batch mission' });
  const overrideMission = upsertMeshMission(meshId, { title: 'Override mission' });
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    mission_id: batchMission.id,
    tasks: [
      { ref: 'a', message: 'inherits batch mission', difficulty: 'easy' },
      { ref: 'b', message: 'overrides mission', mission_id: overrideMission.id, difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, true);
  const rows = getQueue(meshId);
  const a = rows.find(t => t.message === 'inherits batch mission');
  const b = rows.find(t => t.message === 'overrides mission');
  assert.equal(a?.missionId, batchMission.id);
  assert.equal(b?.missionId, overrideMission.id);
});

test('MISSION-UPSERT-SILENT-CREATE: an unresolvable top-level mission_id rejects the whole batch atomically', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    mission_id: 'not-a-real-mission-id',
    tasks: [
      { ref: 'a', message: 'should not enqueue', difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'mission_not_found');
  assert.equal(getQueue(meshId).length, 0, 'atomic — no task inserted for the unresolvable batch mission_id');
});

test('MISSION-UPSERT-SILENT-CREATE: an unresolvable per-entry mission_id rejects the whole batch atomically', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingLocalTransport());
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'a', message: 'valid entry', difficulty: 'easy' },
      { ref: 'b', message: 'bad mission ref', mission_id: 'not-a-real-mission-id', difficulty: 'easy' },
    ],
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'mission_not_found');
  assert.equal(getQueue(meshId).length, 0, 'atomic — the valid entry must not be inserted either');
});

// rc.37 Finding B: the IpcTransport "enqueue-and-push" is retired — a batch (roots
// included) reaches a session only through the daemon's queue claim, never as a
// direct P2P agent_command from the enqueue tool.
test('IpcTransport: a batch sends NO agent_command at enqueue — delivery is only through a claim', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport();
  const ctx = makeCtx(meshId, transport);
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'root', message: 'independent root work', difficulty: 'easy' },
      { ref: 'child', message: 'dependent work', depends_on: ['root'], difficulty: 'easy' },
    ],
  } as any));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.success, true);
  assert.equal(res.eagerPushDeferred, undefined, 'there is no eager push left to defer');
  assert.equal(
    transport.meshCommands.filter((c: any) => c.cmd === 'agent_command').length, 0,
    'no task body may reach a remote session before a claim opened its attempt',
  );
  for (const t of res.tasks) assert.equal(t.status, 'pending', `${t.ref} stays pending until a session claims it`);
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
