import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask } from '../src/tools/mesh-tools.js';
import { IpcTransport } from '../src/transports/ipc.js';
import { getActiveTurnLedger, getQueue, recordDirectDispatchTask } from '@adhdev/daemon-core';

import { answerTurnIpc, armTestTurnLedger, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

// rc.37 Finding B — a task the claim gates leave `pending` must never reach a session.
//
// LIVE (preview, 2026-09-24). Task 2cb0ab79 was mesh_send_task'd to MainPC session
// db6935bd and was mid-turn. The coordinator then mesh_enqueue_task'd 5470f2e1 pinned
// to the same node. The daemon's claim path answered correctly —
// queueTrigger `pending_no_idle_mesh_session`, auto-launch `node_has_active_assignment`
// — but the mcp-server's IpcTransport "enqueue-and-push" then P2P-sent 5470f2e1's body
// straight to db6935bd (worker log: `dispatchSource=mesh-tools-internal:
// ipcDispatchToRemoteAgent`, no messageId/policy/attempt). It re-stamped the busy
// session's mesh assignment to 5470f2e1 (so BOTH of the worker's forwarded reports
// claimed 5470f2e1 and were refused — Finding A's live trigger), queued behind the
// running turn, and then executed — while the queue row stayed `pending` and no
// attempt was ever opened for it.
//
// The fix retires the enqueue-and-push: every enqueued task reaches a session only
// through the daemon's claim (tryAssignQueueTask), which opens the attempt
// (dispatch_accepted) before it sends the body.

const NODE_MAINPC = 'node_695e6d077c0142c09de01170b5dbca34';
const NODE_MAC = 'node_mac_base';
const BUSY_SESSION = 'db6935bd-c237-4403-9dd3-ac53ef20c34e';

function nextMeshId(): string {
  return `mesh_claim_only_${randomUUID().slice(0, 8)}`;
}

/**
 * Passes `instanceof IpcTransport` (the branch that used to push) without a socket.
 * The remote node reports ONE live session — the busy worker — so a push, had it
 * happened, would have had a session to land on (exactly the live shape).
 */
function recordingIpcTransport(sessionStatus: 'generating' | 'idle' = 'generating') {
  const commands: Array<{ cmd: string; args: any }> = [];
  const turnCommands: Array<{ cmd: string; args: any }> = [];
  const meshCommands: Array<{ daemonId: string; cmd: string; args: any }> = [];
  const t = {
    commands,
    turnCommands,
    meshCommands,
    command: async (cmd: string, args: any) => {
      if (isTurnIpcCommand(cmd)) {
        turnCommands.push({ cmd, args });
        return answerTurnIpc(cmd, args ?? {} as Record<string, unknown>);
      }
      commands.push({ cmd, args });
      return { success: true };
    },
    meshCommand: async (daemonId: string, cmd: string, args: any) => {
      meshCommands.push({ daemonId, cmd, args });
      if (cmd === 'get_status_metadata') {
        return {
          success: true,
          sessions: [{
            id: BUSY_SESSION, sessionId: BUSY_SESSION, providerType: 'claude-cli', status: sessionStatus,
            settings: { meshNodeFor: 'x', meshNodeId: NODE_MAINPC, meshActiveTaskId: 'task-in-flight' },
          }],
        };
      }
      return { success: true, sessionId: args?.targetSessionId || BUSY_SESSION };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  Object.setPrototypeOf(t, IpcTransport.prototype);
  return t;
}

function makeCtx(meshId: string, transport: any) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac', policy: { providerPriority: ['claude-cli'] } },
        {
          id: NODE_MAINPC, workspace: 'C:/repo', daemonId: 'daemon_mach_ab349e9e520044a388be5f5122a240c6',
          reportedPlatform: 'win32', policy: { providerPriority: ['claude-cli'] },
        },
      ],
    },
    transport,
  } as any;
}

const agentCommands = (transport: any) => transport.meshCommands.filter((c: any) => c.cmd === 'agent_command');

test('★LIVE SHAPE: a pinned enqueue while the node has an active assignment sends NO body, stays pending, opens NO attempt', async () => {
  const ledger = armTestTurnLedger();
  try {
    const meshId = nextMeshId();
    // Task 1: the in-flight direct dispatch that owns the busy session.
    recordDirectDispatchTask(meshId, 'task one — in flight', {
      id: `direct-${randomUUID().slice(0, 8)}`,
      assignedNodeId: NODE_MAINPC, assignedSessionId: BUSY_SESSION,
      taskMode: 'code_change', difficulty: 'medium', ownedPaths: ['README.md'],
    });
    const transport = recordingIpcTransport();
    const ctx = makeCtx(meshId, transport);

    const res = JSON.parse(await meshEnqueueTask(ctx, {
      message: 'task two — pinned to the busy node', target_node_id: NODE_MAINPC,
      owned_paths: ['README.md'], task_mode: 'code_change', difficulty: 'medium',
    } as any));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(res.targetNodeId, NODE_MAINPC);
    assert.deepEqual(agentCommands(transport), [], 'no task body may reach any session at enqueue');
    const row = getQueue(meshId).find(t => t.id === res.taskId)!;
    assert.equal(row.status, 'pending', 'the row stays pending until a session claims it');
    assert.equal(row.assignedSessionId, undefined);
    assert.equal(
      getActiveTurnLedger()!.store.findLatestAttemptForTask(meshId, res.taskId) ?? null, null,
      'no attempt is opened for an unclaimed task',
    );
    assert.equal(
      transport.turnCommands.filter((c: any) => c.cmd === 'turn_observe' && c.args?.evidence?.taskId === res.taskId).length, 0,
      'no dispatch_accepted is observed for an unclaimed task',
    );
    // The daemon's claim path is still asked to drain (it is the only delivery route).
    assert.ok(transport.commands.some((c: any) => c.cmd === 'trigger_mesh_queue'), 'the queue drain is still triggered');
    // H1: the owned_paths declaration now survives mesh_enqueue_task.
    assert.deepEqual(row.ownedPaths?.paths.map(p => p.path), ['README.md'], 'mesh_enqueue_task forwards owned_paths');
  } finally {
    ledger.dispose();
  }
});

test('an UNTARGETED enqueue on IpcTransport sends nothing even when a remote node has an IDLE session', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport('idle');
  const ctx = makeCtx(meshId, transport);

  const res = JSON.parse(await meshEnqueueTask(ctx, { message: 'untargeted work', difficulty: 'medium' } as any));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.success, true);
  assert.equal(res.status, 'pending');
  assert.deepEqual(agentCommands(transport), []);
  assert.equal(res.eagerPushDeferred, undefined, 'the retired push leaves no response field behind');
});

test('a readonly enqueue is treated identically (no readonly exemption)', async () => {
  const meshId = nextMeshId();
  const transport = recordingIpcTransport('idle');
  const ctx = makeCtx(meshId, transport);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'readonly look', readonly: true, task_mode: 'live_debug', difficulty: 'medium',
  } as any));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.success, true);
  assert.deepEqual(agentCommands(transport), []);
});
