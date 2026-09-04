import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshQueueCancel } from '../src/tools/mesh-tools.js';
import { enqueueTask, claimNextTask, getLedgerDir } from '@adhdev/daemon-core';

// CANCEL-STOP-TASK-SCOPE — the tool-layer half.
//
// The daemon can only scope its hard stop to a task if the cancel actually SENDS the task id.
// Previously meshQueueCancel attached meshContext (and with it taskId) only when the queue row
// carried an assignedNodeId, so a node-less assignment produced an UNSCOPED stop — which the
// daemon fails open on, reproducing the defect: a session that had moved to another task gets
// killed. This suite pins (1) taskId rides unconditionally, and (2) a daemon refusal is
// reported as a deliberate skip rather than an unreachable-worker failure.

const NODE_MAC = 'node_mac_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_stopscope_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

function makeCtx(meshId: string, transport: any, coordinatorSessionId?: string) {
  return {
    mesh: {
      id: meshId,
      nodes: [{ id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' }],
    },
    transport,
    ...(coordinatorSessionId ? { coordinatorSessionId } : {}),
  } as any;
}

function transportReturning(stopResult: any) {
  const commands: Array<{ cmd: string; args: any }> = [];
  return {
    commands,
    command: async (cmd: string, args: any) => {
      commands.push({ cmd, args });
      if (cmd === 'agent_command' && args?.action === 'stop') return stopResult;
      return { success: true };
    },
    getStatus: async () => ({ sessions: [] }),
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

test('the cancel stop always carries meshContext.taskId so the daemon can scope it', async () => {
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'assigned work', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, NODE_MAC, 'worker_sess_1', [], { providerType: 'claude-cli' });
  assert.ok(claimed);

  const transport = transportReturning({ success: true, stopped: true });
  const res = JSON.parse(await meshQueueCancel(makeCtx(meshId, transport, 'coordinator_sess'), { task_id: task.id } as any));
  assert.equal(res.success, true);

  const stopCmd = transport.commands.find((c: any) => c.cmd === 'agent_command' && c.args?.action === 'stop');
  assert.ok(stopCmd, 'an assigned task still propagates a stop (original intent)');
  assert.equal(stopCmd.args.meshContext?.taskId, task.id, 'the stop must name the cancelled task');
  assert.equal(stopCmd.args.meshContext?.meshId, meshId);
});

test('taskId rides even when the queue row has NO assignedNodeId', async () => {
  // The regression this closes: the old code gated the WHOLE meshContext on assignedNodeId,
  // so a node-less assignment sent an unscoped stop the daemon could not task-check.
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'nodeless work', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, '', 'worker_sess_nodeless', [], { providerType: 'claude-cli' });
  assert.ok(claimed, 'claim onto a session without a node id');

  const transport = transportReturning({ success: true, stopped: true });
  const res = JSON.parse(await meshQueueCancel(makeCtx(meshId, transport, 'coordinator_sess'), { task_id: task.id } as any));
  assert.equal(res.success, true);

  const stopCmd = transport.commands.find((c: any) => c.cmd === 'agent_command' && c.args?.action === 'stop');
  assert.ok(stopCmd, 'a node-less assignment still gets a stop');
  assert.equal(stopCmd.args.meshContext?.taskId, task.id, 'taskId must NOT be gated on assignedNodeId');
  assert.equal(stopCmd.args.meshContext?.nodeId, undefined, 'nodeId stays optional (its own guard)');
});

test('a daemon task-mismatch refusal is reported as a deliberate skip, not a worker failure', async () => {
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'stale row work', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, NODE_MAC, 'worker_sess_moved_on', [], { providerType: 'claude-cli' });
  assert.ok(claimed);

  // The daemon spared the session: it is alive and working a DIFFERENT task.
  const transport = transportReturning({
    success: false, stopped: false, reason: 'stop_task_mismatch',
    requestedTaskId: task.id, sessionTaskId: 'task_something_else',
    error: 'stop refused to avoid killing unrelated work',
  });
  const res = JSON.parse(await meshQueueCancel(makeCtx(meshId, transport, 'coordinator_sess'), { task_id: task.id } as any));

  // The cancel itself still succeeds — the queue transition already committed.
  assert.equal(res.success, true);
  assert.equal(res.workerStop?.attempted, true);
  assert.equal(res.workerStop?.stopped, false);
  assert.equal(res.workerStop?.skipped, 'session_moved_to_other_task');
  assert.equal(res.workerStop?.sessionTaskId, 'task_something_else');

  // No session died, so nothing pinned to it is orphaned. Paging the coordinator here would
  // be a false alarm telling it to requeue work that is running fine.
  assert.equal(res.orphanedPinnedTasks, undefined, 'a spared session must not raise orphan pins');
  assert.equal(res.orphanedPinnedTasksWarning, undefined);
});

test('a genuine unreachable-worker failure is NOT relabelled as a skip', async () => {
  // Control: only reason === 'stop_task_mismatch' is a skip. Real failures must stay failures
  // so the coordinator still escalates.
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'unreachable work', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, NODE_MAC, 'worker_sess_dead', [], { providerType: 'claude-cli' });
  assert.ok(claimed);

  const transport = transportReturning({ success: false, error: 'no response from remote worker daemon' });
  const res = JSON.parse(await meshQueueCancel(makeCtx(meshId, transport, 'coordinator_sess'), { task_id: task.id } as any));

  assert.equal(res.workerStop?.stopped, false);
  assert.equal(res.workerStop?.skipped, undefined, 'an unreachable worker is not a deliberate skip');
  assert.equal(res.workerStop?.reason, 'no response from remote worker daemon');
});
