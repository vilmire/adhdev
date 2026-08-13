import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask, meshQueueCancel, meshSendTask } from '../src/tools/mesh-tools.js';
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
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'pinned work', target_node: NODE_MAC,
    difficulty: 'medium',
} as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_MAC, 'target_node must resolve to a hard targetNodeId');
  // The persisted task row carries the pin so the claim tier can enforce it.
  assert.equal(getQueue(meshId)[0]?.targetNodeId, NODE_MAC);
});

test('fix1: camelCase targetNode alias also resolves', async () => {
  const ctx = makeCtx(nextMeshId(), recordingTransport());
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'pinned', targetNode: NODE_WIN,
    difficulty: 'medium',
} as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_WIN);
});

test('fix1: an unresolvable target is REJECTED, never enqueued unpinned', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingTransport());
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'oops', target_node: 'node_does_not_exist',
    difficulty: 'medium',
} as any));
  assert.equal(res.success, false);
  assert.equal(res.code, 'target_node_not_found');
  // It must NOT have created a queue task (no silent unpinned fall-through).
  assert.equal(getQueue(meshId).length, 0, 'rejected enqueue must not write a task');
});

test('fix1: no target stays unpinned (existing behavior unchanged)', async () => {
  const ctx = makeCtx(nextMeshId(), recordingTransport());
  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'anyone',
    difficulty: 'medium',
} as any));
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, undefined, 'no target → no pin');
});

test('COORD-EVENT-MISROUTE: untargeted meshSendTask enqueue-fallback stamps the coordinator session anchor', async () => {
  const meshId = nextMeshId();
  // A local node (recording transport → not IpcTransport) with NO session_id drives the
  // untargeted queue-pull fallback. Without the fix the queued task carried no
  // sourceCoordinatorSessionId → the completion later lost its session anchor and fanned out
  // to every local coordinator (the misroute). The fix stamps ctx.coordinatorSessionId exactly
  // as the sibling meshEnqueueTask does.
  const COORDINATOR_SESSION = 'coordinator_sess_anchor';
  const ctx = makeCtx(meshId, recordingTransport(), COORDINATOR_SESSION);
  const res = JSON.parse(await meshSendTask(ctx, { node_id: NODE_MAC, message: 'untargeted work',
    difficulty: 'medium',
} as any));
  assert.equal(res.success, true);
  assert.equal(res.source, 'queue', 'no session_id → untargeted queue-pull fallback');
  const queued = getQueue(meshId).find(t => t.id === res.taskId);
  assert.ok(queued, 'the fallback enqueued a task row');
  assert.equal(
    (queued as any).sourceCoordinatorSessionId,
    COORDINATOR_SESSION,
    'the queued task must carry the originating coordinator session anchor',
  );
});

test('COORD-EVENT-MISROUTE: untargeted enqueue-fallback with no coordinator session stays unanchored (no fabrication)', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId, recordingTransport()); // no coordinatorSessionId
  const res = JSON.parse(await meshSendTask(ctx, { node_id: NODE_WIN, message: 'anon work',
    difficulty: 'medium',
} as any));
  assert.equal(res.success, true);
  const queued = getQueue(meshId).find(t => t.id === res.taskId);
  assert.ok(queued, 'the fallback enqueued a task row');
  assert.equal((queued as any).sourceCoordinatorSessionId, undefined, 'no coordinator session → no fabricated anchor');
});

test('fix2: cancelling an ASSIGNED task stops the assigned worker session', async () => {
  const meshId = nextMeshId();
  // Genuine assignment via the real claim path: enqueue then claim onto a worker session.
  const task = enqueueTask(meshId, 'assigned work', { difficulty: 'medium' });
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
  enqueueTask(meshId, 'self assigned', { difficulty: 'medium' });
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
  const task = enqueueTask(meshId, 'pending work', { difficulty: 'medium' }); // stays pending, no assignment
  const transport = recordingTransport();
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: task.id } as any));
  assert.equal(res.success, true);
  assert.equal(res.workerStop?.attempted, false);
  const stopCmd = transport.commands.find((c: any) => c.cmd === 'agent_command' && c.args?.action === 'stop');
  assert.equal(stopCmd, undefined);
});

// CANCEL-STOP false-positive fix: meshQueueCancel now AWAITs the stop and reports its REAL
// outcome instead of pre-stamping attempted:true on a fire-and-forget call.

test('false-positive fix: a confirmed stop reflects stopped:true', async () => {
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'work', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, NODE_WIN, 'worker_sess_ok', [], { providerType: 'claude-cli' });
  assert.ok(claimed);
  // Worker daemon confirms the stop landed.
  const transport = {
    commands: [] as any[],
    command: async (cmd: string, args: any) => {
      transport.commands.push({ cmd, args });
      if (cmd === 'agent_command' && args?.action === 'stop') return { success: true, stopped: true };
      return { success: true };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: task.id } as any));
  assert.equal(res.success, true);
  assert.equal(res.workerStop?.attempted, true);
  assert.equal(res.workerStop?.stopped, true, 'a confirmed worker stop must report stopped:true');
});

test('false-positive fix: an unreached worker reports stopped:false + reason (no silent attempted:true)', async () => {
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'work', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, NODE_WIN, 'worker_sess_gone', [], { providerType: 'claude-cli' });
  assert.ok(claimed);
  // Router forward could not reach the owning worker daemon — the real failure surface.
  const transport = {
    commands: [] as any[],
    command: async (cmd: string, args: any) => {
      transport.commands.push({ cmd, args });
      if (cmd === 'agent_command' && args?.action === 'stop') {
        return { success: false, error: 'no response from remote worker daemon' };
      }
      return { success: true };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: task.id } as any));
  // cancel itself still succeeds (queue 'cancelled' committed) — only the report tells the truth.
  assert.equal(res.success, true);
  assert.equal(res.workerStop?.attempted, true);
  assert.equal(res.workerStop?.stopped, false, 'an unreached worker must NOT report stopped:true');
  assert.equal(res.workerStop?.reason, 'no response from remote worker daemon');
});

test('best-effort: a thrown stop never fails the cancel', async () => {
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'work', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, NODE_WIN, 'worker_sess_throw', [], { providerType: 'claude-cli' });
  assert.ok(claimed);
  const transport = {
    commands: [] as any[],
    command: async (cmd: string, args: any) => {
      transport.commands.push({ cmd, args });
      if (cmd === 'agent_command' && args?.action === 'stop') throw new Error('transport boom');
      return { success: true };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: task.id } as any));
  assert.equal(res.success, true, 'cancel must succeed even when the worker stop throws');
  assert.equal(getQueue(meshId).find((t: any) => t.id === task.id)?.status, 'cancelled');
  assert.equal(res.workerStop?.stopped, false);
  assert.equal(res.workerStop?.reason, 'transport boom');
});
