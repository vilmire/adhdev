import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshQueueCancel } from '../src/tools/mesh-tools.js';
import {
  enqueueTask,
  getQueue,
  claimNextTask,
  getLedgerDir,
  getPendingMeshCoordinatorEvents,
  clearPendingMeshCoordinatorEvents,
  findTasksOrphanedBySessionStop,
} from '@adhdev/daemon-core';

// CANCEL-ORPHANS-PINNED-TASK — the live incident (2026-08-16, reproduced in this mesh):
//   1. Task A dispatched to worker session S → S generating.
//   2. Task B sent to the SAME session while busy → mesh_send_task's busy branch enqueues B
//      PINNED to S (targetSessionId=S), promising it auto-delivers when S goes idle.
//   3. Coordinator cancels A → mesh_queue_cancel propagates agent_command(action:'stop').
//      That is a HARD stop: CliManager.stopSession removes the instance, so S ceases to exist.
//   4. B is stranded: undeliverable (session gone) AND un-launchable (the pin makes auto-launch
//      skip with 'target_session_constraint'). Observed live: 12 min, zero generating sessions.
//
// The fix detects this at the cancel — the one moment the coordinator KNOWS which session it
// just killed — and pages it over the existing coordinator-addressed `mesh:dispatch_blocked`
// channel with the exact requeue call. Notify-only: the pin is NOT auto-cleared, because a pin
// usually encodes required context continuity.

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_orphanpin_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

function stoppingTransport() {
  const commands: Array<{ cmd: string; args: any }> = [];
  return {
    commands,
    command: async (cmd: string, args: any) => {
      commands.push({ cmd, args });
      if (cmd === 'agent_command' && args?.action === 'stop') return { success: true, stopped: true };
      return { success: true };
    },
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

/** Pending `mesh:dispatch_blocked` events emitted by the orphaned-pin detector. */
function orphanPinEvents(meshId: string): any[] {
  return (getPendingMeshCoordinatorEvents(meshId) as any[]).filter(
    e => e?.event === 'mesh:dispatch_blocked'
      && (e?.metadataEvent as any)?.source === 'mesh_session_stop_orphaned_pins',
  );
}

test.after(() => {
  for (const meshId of createdMeshes) {
    try { clearPendingMeshCoordinatorEvents(meshId); } catch { /* best-effort */ }
    for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
      const p = join(getLedgerDir(), `${meshId}${suffix}`);
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
});

// ── The core repro ─────────────────────────────────────────────────────────

test('repro: cancelling task A orphans task B pinned to the same session → coordinator is notified', async () => {
  const meshId = nextMeshId();
  const WORKER_SESSION = 'worker_sess_shared';

  // (1) Task A claims onto the worker session — it is the one that gets cancelled.
  enqueueTask(meshId, 'task A: the work being cancelled', { difficulty: 'medium' });
  const taskA = claimNextTask(meshId, NODE_MAC, WORKER_SESSION, [], { providerType: 'claude-cli' });
  assert.ok(taskA, 'task A must claim onto the worker session');

  // (2) Task B is enqueued PINNED to that same (busy) session — the mesh_send_task busy branch.
  const taskB = enqueueTask(meshId, 'task B: the follow-up delta that gets orphaned', {
    difficulty: 'medium',
    targetNodeId: NODE_MAC,
    targetSessionId: WORKER_SESSION,
  });
  assert.equal(getQueue(meshId).find(t => t.id === taskB.id)?.status, 'pending');

  // (3) Cancel A → the worker stop kills the session B is pinned to.
  const transport = stoppingTransport();
  const ctx = makeCtx(meshId, transport, 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: taskA.id } as any));

  assert.equal(res.success, true);
  assert.equal(res.workerStop?.stopped, true, 'the worker session was stopped');

  // (4) The orphan must be reported inline on the cancel response.
  assert.ok(Array.isArray(res.orphanedPinnedTasks), 'cancel response must list the orphaned tasks');
  assert.equal(res.orphanedPinnedTasks.length, 1);
  assert.equal(res.orphanedPinnedTasks[0].taskId, taskB.id);
  assert.equal(res.orphanedPinnedTasks[0].targetSessionId, WORKER_SESSION);

  // The notice must name WHAT, WHY and HOW — the coordinator has to act from this text alone.
  const warning: string = res.orphanedPinnedTasksWarning;
  assert.match(warning, /ORPHANED/, 'notice states the tasks are orphaned');
  assert.ok(warning.includes(taskB.id), 'notice names the orphaned task id');
  assert.match(warning, /task B: the follow-up delta/, 'notice includes the task title');
  assert.match(warning, /target_session_constraint/, 'notice explains the auto-launch block');
  assert.match(warning, /mesh_queue_requeue/, 'notice gives the concrete fix call');
  assert.ok(warning.includes(WORKER_SESSION), 'notice names the stopped session');

  // (5) And it must reach the coordinator over the existing pending-event channel.
  const events = orphanPinEvents(meshId);
  assert.equal(events.length, 1, 'exactly one coordinator alert must be queued');
  const ev = events[0];
  assert.equal(ev.metadataEvent.reason, 'pinned_session_stopped');
  assert.deepEqual(ev.metadataEvent.orphanedTaskIds, [taskB.id]);
  assert.equal(ev.metadataEvent.stoppedSessionId, WORKER_SESSION);
  assert.equal(
    ev.targetCoordinatorSessionId,
    'coordinator_sess',
    'the alert is addressed to the coordinator session that issued the cancel',
  );
  assert.ok(String(ev.coordinatorMessage).includes(taskB.id));
});

test('notify-only: the orphaned task keeps its pin and stays pending (no silent re-homing)', async () => {
  const meshId = nextMeshId();
  const WORKER_SESSION = 'worker_sess_keep_pin';

  enqueueTask(meshId, 'task A', { difficulty: 'medium' });
  const taskA = claimNextTask(meshId, NODE_MAC, WORKER_SESSION, [], { providerType: 'claude-cli' });
  assert.ok(taskA);
  const taskB = enqueueTask(meshId, 'task B pinned', {
    difficulty: 'medium', targetNodeId: NODE_MAC, targetSessionId: WORKER_SESSION,
  });

  const ctx = makeCtx(meshId, stoppingTransport(), 'coordinator_sess');
  await meshQueueCancel(ctx, { task_id: taskA.id } as any);

  // The pin is a deliberate context-continuity signal — clearing it automatically could land a
  // follow-up on work it was never about. The coordinator decides; the daemon only reports.
  const rowB = getQueue(meshId).find(t => t.id === taskB.id);
  assert.equal(rowB?.status, 'pending', 'the orphaned task is not cancelled or failed');
  assert.equal(rowB?.targetSessionId, WORKER_SESSION, 'the session pin is NOT auto-cleared');
  assert.equal(rowB?.targetNodeId, NODE_MAC, 'the node pin is NOT auto-cleared');
});

test('an ATTEMPTED but unconfirmed stop still notifies (the uncertain case is the dangerous one)', async () => {
  const meshId = nextMeshId();
  const WORKER_SESSION = 'worker_sess_unreachable';
  enqueueTask(meshId, 'task A', { difficulty: 'medium' });
  const taskA = claimNextTask(meshId, NODE_WIN, WORKER_SESSION, [], { providerType: 'claude-cli' });
  assert.ok(taskA);
  const taskB = enqueueTask(meshId, 'task B pinned', {
    difficulty: 'medium', targetNodeId: NODE_WIN, targetSessionId: WORKER_SESSION,
  });

  // The worker daemon could not be reached, so the stop is unconfirmed. Either it landed
  // (pins dead) or the daemon is unreachable (pins equally undeliverable) — both strand the
  // task, so the coordinator must be told rather than left to guess.
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
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: taskA.id } as any));
  assert.equal(res.workerStop?.attempted, true);
  assert.equal(res.workerStop?.stopped, false, 'the stop was NOT confirmed');
  assert.equal(res.orphanedPinnedTasks?.length, 1, 'an unconfirmed stop must still report the orphan');
  assert.equal(res.orphanedPinnedTasks[0].taskId, taskB.id);
  assert.equal(orphanPinEvents(meshId).length, 1, 'and must still page the coordinator');
});

// ── Negative cases: the detector must not fire when there is no orphan ──────

test('no orphan: a task pinned to a DIFFERENT session is untouched and triggers no alert', async () => {
  const meshId = nextMeshId();
  enqueueTask(meshId, 'task A', { difficulty: 'medium' });
  const taskA = claimNextTask(meshId, NODE_MAC, 'worker_sess_cancelled', [], { providerType: 'claude-cli' });
  assert.ok(taskA);
  // Pinned to a session that is NOT the one being stopped.
  enqueueTask(meshId, 'unrelated pinned task', {
    difficulty: 'medium', targetNodeId: NODE_WIN, targetSessionId: 'worker_sess_other',
  });

  const ctx = makeCtx(meshId, stoppingTransport(), 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: taskA.id } as any));
  assert.equal(res.success, true);
  assert.equal(res.orphanedPinnedTasks, undefined, 'no orphan → no orphan field on the response');
  assert.equal(orphanPinEvents(meshId).length, 0, 'no orphan → no coordinator alert');
});

test('no orphan: cancelling a PENDING task issues no stop, so nothing can be orphaned', async () => {
  const meshId = nextMeshId();
  const task = enqueueTask(meshId, 'pending work', { difficulty: 'medium' });
  // A task pinned to some session exists, but no stop happens — so no session dies.
  enqueueTask(meshId, 'pinned bystander', {
    difficulty: 'medium', targetNodeId: NODE_MAC, targetSessionId: 'worker_sess_alive',
  });

  const ctx = makeCtx(meshId, stoppingTransport(), 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: task.id } as any));
  assert.equal(res.workerStop?.attempted, false);
  assert.equal(res.orphanedPinnedTasks, undefined, 'no worker stop → no orphan scan result');
  assert.equal(orphanPinEvents(meshId).length, 0);
});

test('no orphan: the cancelled task itself is never reported as its own orphan', async () => {
  const meshId = nextMeshId();
  const WORKER_SESSION = 'worker_sess_self';
  // A task that is BOTH assigned to the session and pinned to it — claimNextTask stamps
  // targetSessionId on direct-dispatch rows, so this shape occurs in practice.
  enqueueTask(meshId, 'only task', {
    difficulty: 'medium', targetNodeId: NODE_MAC, targetSessionId: WORKER_SESSION,
  });
  const claimed = claimNextTask(meshId, NODE_MAC, WORKER_SESSION, [], { providerType: 'claude-cli' });
  assert.ok(claimed);

  const ctx = makeCtx(meshId, stoppingTransport(), 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: claimed.id } as any));
  assert.equal(res.success, true);
  assert.equal(res.orphanedPinnedTasks, undefined, 'the cancelled task must be excluded from its own orphan set');
  assert.equal(orphanPinEvents(meshId).length, 0);
});

test('no orphan: the coordinator self-session guard suppresses the stop AND the orphan scan', async () => {
  const meshId = nextMeshId();
  const COORDINATOR = 'coordinator_sess';
  enqueueTask(meshId, 'self assigned', { difficulty: 'medium' });
  const claimed = claimNextTask(meshId, NODE_MAC, COORDINATOR, [], { providerType: 'claude-cli' });
  assert.ok(claimed);
  // A task pinned to the coordinator session. No stop is issued (self-guard), so it is NOT orphaned.
  enqueueTask(meshId, 'pinned to coordinator', {
    difficulty: 'medium', targetNodeId: NODE_MAC, targetSessionId: COORDINATOR,
  });

  const ctx = makeCtx(meshId, stoppingTransport(), COORDINATOR);
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: claimed.id } as any));
  assert.equal(res.workerStop?.attempted, false, 'the coordinator session is never stopped');
  assert.equal(res.orphanedPinnedTasks, undefined, 'no stop → no orphans');
  assert.equal(orphanPinEvents(meshId).length, 0);
});

// ── Detector-level behaviour ───────────────────────────────────────────────

test('detector: only PENDING rows are orphans — assigned/terminal rows are excluded', () => {
  const meshId = nextMeshId();
  const SESSION = 'worker_sess_detector';

  // Two rows pinned to the same session; one of them gets claimed. Which one claimNextTask
  // picks is a scheduling detail, so derive the expectation from the claim rather than
  // assuming an order.
  const first = enqueueTask(meshId, 'pinned row one', { difficulty: 'medium', targetSessionId: SESSION });
  const second = enqueueTask(meshId, 'pinned row two', { difficulty: 'medium', targetSessionId: SESSION });
  const assigned = claimNextTask(meshId, NODE_MAC, SESSION, [], { providerType: 'claude-cli' });
  assert.ok(assigned, 'one of the pinned rows must claim onto the session');
  const stillPendingId = assigned.id === first.id ? second.id : first.id;
  assert.equal(getQueue(meshId).find(t => t.id === assigned.id)?.status, 'assigned');
  assert.equal(getQueue(meshId).find(t => t.id === stillPendingId)?.status, 'pending');

  const orphans = findTasksOrphanedBySessionStop(meshId, SESSION);
  assert.deepEqual(
    orphans.map(o => o.taskId),
    [stillPendingId],
    'only the still-pending pinned row is an orphan — the assigned row is owned by the stop/reclaim path',
  );
});

test('detector: reports multiple orphans, and the notice caps the list without hiding the count', async () => {
  const meshId = nextMeshId();
  const SESSION = 'worker_sess_many';
  enqueueTask(meshId, 'task A', { difficulty: 'medium' });
  const taskA = claimNextTask(meshId, NODE_MAC, SESSION, [], { providerType: 'claude-cli' });
  assert.ok(taskA);

  const pinnedIds: string[] = [];
  for (let i = 0; i < 7; i++) {
    pinnedIds.push(enqueueTask(meshId, `pinned follow-up ${i}`, {
      difficulty: 'medium', targetNodeId: NODE_MAC, targetSessionId: SESSION,
    }).id);
  }

  const ctx = makeCtx(meshId, stoppingTransport(), 'coordinator_sess');
  const res = JSON.parse(await meshQueueCancel(ctx, { task_id: taskA.id } as any));
  assert.equal(res.orphanedPinnedTasks.length, 7, 'every pinned pending task is reported');
  assert.deepEqual(res.orphanedPinnedTasks.map((o: any) => o.taskId).sort(), [...pinnedIds].sort());
  // The message lists at most 5 but must still state the true total.
  assert.match(res.orphanedPinnedTasksWarning, /^\[System\] 7 queued mesh tasks are now ORPHANED/);
  assert.match(res.orphanedPinnedTasksWarning, /\.\.\.and 2 more\./);
});

test('detector: id comparison goes through sessionIdsEquivalent (trim-tolerant, never cross-matching)', () => {
  const meshId = nextMeshId();
  // Session ids are SINGLE-FORM by design (one canonical UUID carried verbatim across daemons),
  // so sessionIdsEquivalent is exact-match-after-trim rather than the multi-form normalization
  // daemon/node ids need. The detector routes through it anyway: it is the documented single
  // seam for session comparison, so any future aliasing lands here instead of in a raw `===`.
  const task = enqueueTask(meshId, 'pinned', { difficulty: 'medium', targetSessionId: 'worker_sess_exact' });
  // Padding is tolerated…
  assert.deepEqual(
    findTasksOrphanedBySessionStop(meshId, '  worker_sess_exact  ').map(o => o.taskId),
    [task.id],
    'surrounding whitespace must not defeat the match',
  );
  // …but a merely similar id must NEVER match, or a stop would orphan-report unrelated work.
  assert.deepEqual(findTasksOrphanedBySessionStop(meshId, 'worker_sess_exact_2'), []);
  assert.deepEqual(findTasksOrphanedBySessionStop(meshId, 'worker_sess'), []);
});

test('detector: an empty session id never matches (no blanket orphan sweep)', () => {
  const meshId = nextMeshId();
  enqueueTask(meshId, 'pinned', { difficulty: 'medium', targetSessionId: 'worker_sess_x' });
  enqueueTask(meshId, 'unpinned', { difficulty: 'medium' });
  assert.deepEqual(findTasksOrphanedBySessionStop(meshId, ''), []);
  assert.deepEqual(findTasksOrphanedBySessionStop(meshId, '   '), []);
});
