import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshSendTask } from '../src/tools/mesh-tools.js';
import { getLedgerDir, getQueue } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// MESH-IMAGE-DISPATCH busy path (wiring-unification A5-2).
//
// mesh_send_task to a BUSY session routes through enqueueTask (queued_delivery).
// Before A3 that call dropped `taskInput`, so an image sent to a busy worker was
// queued as text only and the screenshot silently vanished. This drives
// meshSendTask() itself — same local-ctx IpcTransport-mock pattern as
// mesh-send-task-interrupt-dispatch.test.ts — and asserts the queued row carries
// the envelope the direct-dispatch path would have forwarded.
//
// NOTE: `getQueue`/`enqueueTask` here come from the daemon-core DIST; this test
// is only meaningful once dist reflects mesh-work-queue.ts's `input` field.

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
    id: 'sess-busy-claude',
    providerType: 'claude-cli',
    status: 'generating',
    settings: {
      meshNodeFor: meshId,
      meshNodeId: 'node-local',
      meshCoordinatorDaemonId: 'daemon-coordinator',
    },
  };
  const mesh = {
    id: meshId,
    name: 'Busy Input Queued',
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
      policy: { providerPriority: ['claude-cli'] },
      sessions: [busySession],
    }],
  };
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const agentCommands: Array<Record<string, unknown>> = [];
  transport.command = async (command, args = {}) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [busySession] } };
    if (command === 'agent_command') { agentCommands.push(args); return { success: true }; }
    throw new Error(`unexpected local command in busy-input test: ${command}`);
  };
  return { ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' }, agentCommands };
}

const IMAGE_INPUT = {
  parts: [
    { type: 'text', text: 'What is wrong with this screen?' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ],
};

test('an image sent to a BUSY session is queued WITH its input envelope (when_idle default)', async () => {
  const meshId = 'mesh-busy-input-queued';
  cleanupMesh(meshId);
  const { ctx, agentCommands } = createLocalBusyCtx(meshId);
  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-claude',
      message: 'What is wrong with this screen?',
      input: IMAGE_INPUT,
      difficulty: 'medium',
    } as any));

    assert.equal(send.success, true, JSON.stringify(send));
    assert.equal(send.dispatched, false);
    assert.equal(send.decision, 'queued_delivery');
    assert.equal(typeof send.taskId, 'string');
    // Nothing was injected into the busy session — the queue funnel owns delivery.
    assert.equal(agentCommands.filter(c => c.action === 'send_chat').length, 0);

    const queued = getQueue(meshId).find(t => t.id === send.taskId);
    assert.ok(queued, 'the queued task must exist');
    assert.equal(queued.status, 'pending');
    assert.equal(queued.targetSessionId, 'sess-busy-claude');
    assert.deepEqual(queued.input, IMAGE_INPUT, 'the envelope must ride on the queued row');
  } finally {
    cleanupMesh(meshId);
  }
});

test('a text-only busy send queues a row with no input key', async () => {
  const meshId = 'mesh-busy-text-queued';
  cleanupMesh(meshId);
  const { ctx } = createLocalBusyCtx(meshId);
  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-claude',
      message: 'text only',
      difficulty: 'easy',
    } as any));
    assert.equal(send.decision, 'queued_delivery');
    const queued = getQueue(meshId).find(t => t.id === send.taskId);
    assert.ok(queued);
    assert.equal('input' in queued, false);
  } finally {
    cleanupMesh(meshId);
  }
});
