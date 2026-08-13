import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';
import { getLedgerDir, getQueue, claimNextTask } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// RC17-QUEUED-DELIVERY-STRANDED regression.
//
// Live evidence (/tmp/rc17-gate/audit-result.json): a mesh_send_task dispatch to a Codex
// session that was still `generating` ~10s after launch returned
// decision:'queued_delivery' with a deliveryId — but nothing in the codebase ever read
// getActiveSessionDeliveries() back to re-drive that row. The session went idle and the
// queued delivery never flushed/delivered; the coordinator's own subsequent polling
// (read_chat) never triggered a redrive either. The `queued_delivery` response's own
// nextAction text ("watch for session idle transition, or use mesh_enqueue_task") was the
// only real recourse — an entirely manual one.
//
// Fix: route the busy-session branch through enqueueTask with targetNodeId/targetSessionId
// pinned to this exact node+session (the same call untargeted meshSendTask already makes).
// claimNextTask's candidate query filters strictly on targetSessionId equivalence, and the
// existing agent:generating_completed / agent:ready mesh-event-forwarding handlers already
// call tryAssignQueueTask the instant this session goes idle — so the task now auto-flushes
// through the SAME battle-tested funnel that already delivers queue-pull tasks, with no new
// idle-transition wiring required.

function cleanupMesh(meshId: string): void {
  __clearMeshQueueForTests(meshId);
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

function createLocalBusyCtx(meshId: string) {
  const busySession = {
    id: 'sess-busy-codex',
    providerType: 'codex-cli',
    status: 'generating',
    settings: {
      meshNodeFor: meshId,
      meshNodeId: 'node-local',
      meshCoordinatorDaemonId: 'daemon-coordinator',
    },
  };
  const mesh = {
    id: meshId,
    name: 'Queued Delivery Autoflush',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-local',
      workspace: '/tmp/local-repo',
      repoRoot: '/tmp/local-repo',
      daemonId: 'daemon-coordinator',
      machineId: 'machine-coordinator',
      userOverrides: {},
      policy: { providerPriority: ['codex-cli'] },
      sessions: [busySession],
    }],
  };
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [busySession] } };
    throw new Error(`unexpected local command in busy-session test: ${command}`);
  };
  return { ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' }, calls };
}

test('a task sent to a busy (generating) explicit session enqueues a session-pinned task instead of a dead SessionDelivery row', async () => {
  const meshId = 'mesh-queued-delivery-autoflush-basic';
  cleanupMesh(meshId);
  const { ctx } = createLocalBusyCtx(meshId);

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-codex',
      message: 'Do the follow-up work once idle',
      difficulty: 'medium',
    } as any));

    assert.equal(send.success, true);
    assert.equal(send.dispatched, false);
    assert.equal(send.decision, 'queued_delivery');
    assert.equal(typeof send.taskId, 'string', 'response must carry a trackable taskId');
    assert.equal(send.deliveryId, undefined, 'no dead SessionDelivery id — the trackable handle is the queue task id');

    // The critical assertion: the task actually landed in the QUEUE, pinned to this
    // exact node+session, where the existing auto-claim funnel can find and flush it.
    const queued = getQueue(meshId).find(t => t.id === send.taskId);
    assert.ok(queued, 'busy-session dispatch must create a real queue row, not just a tracking record');
    assert.equal((queued as any).targetNodeId, 'node-local');
    assert.equal((queued as any).targetSessionId, 'sess-busy-codex');
    assert.equal((queued as any).status, 'pending');
  } finally {
    cleanupMesh(meshId);
  }
});

test('the queued task auto-claims onto the SAME session once it goes idle — the exact redrive the old dead delivery record never got', async () => {
  const meshId = 'mesh-queued-delivery-autoflush-claim';
  cleanupMesh(meshId);
  const { ctx } = createLocalBusyCtx(meshId);

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-codex',
      message: 'Do the follow-up work once idle',
      difficulty: 'medium',
    } as any));
    assert.equal(send.success, true);
    assert.equal(send.decision, 'queued_delivery');

    // Session transitions generating -> idle (the exact moment the live Codex repro
    // showed the old delivery record permanently stranded at 'queued'). Simulate the
    // mesh-event-forwarding idle-transition trigger by calling the SAME claim funnel
    // (tryAssignQueueTask) it invokes — claimNextTask is the primitive that funnel
    // ultimately calls to pull a pending, session-pinned row.
    const claimed = claimNextTask(meshId, 'node-local', 'sess-busy-codex', [], { providerType: 'codex-cli' });

    assert.ok(claimed, 'the session-pinned task must be claimable by the exact session it targeted once idle');
    assert.equal(claimed?.id, send.taskId);
    assert.equal(claimed?.message, 'Do the follow-up work once idle');
  } finally {
    cleanupMesh(meshId);
  }
});
