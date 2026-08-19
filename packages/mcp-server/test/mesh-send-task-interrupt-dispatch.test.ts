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

// End-to-end coverage for the mesh_send_task delivery_mode:'interrupt' branch in
// mesh-tools-session.ts (axis A of M-INPUT-DELIVERY-MODE-AND-QUEUE). The unit
// layers (resolveDeliveryDecision, resolveInterruptCapability, SpecCliAdapter.
// interruptTurn) are covered elsewhere; this file is the one place that drives
// meshSendTask() itself through the full probe -> policy -> interrupt_turn ->
// enqueue sequence, following the same local-ctx IpcTransport-mock pattern as
// mesh-send-task-queued-delivery-autoflush.test.ts.

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

function createLocalBusyCtx(meshId: string, opts: {
  agentCommandHandler: (args: Record<string, unknown>) => any;
}) {
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
    name: 'Interrupt Dispatch',
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
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [busySession] } };
    if (command === 'agent_command') return opts.agentCommandHandler(args);
    throw new Error(`unexpected local command in interrupt-dispatch test: ${command}`);
  };
  return { ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' }, calls };
}

test('interrupt on a provider that supports it: probes capability, sends interrupt_turn, then enqueues pinned to the session', async () => {
  const meshId = 'mesh-interrupt-dispatch-supported';
  cleanupMesh(meshId);
  const { ctx, calls } = createLocalBusyCtx(meshId, {
    agentCommandHandler: (args) => {
      if (args.action === 'interrupt_capability') {
        return { success: true, supported: true, keyName: 'Ctrl-C', confidence: 'proven' };
      }
      if (args.action === 'interrupt_turn') {
        return { success: true, interrupted: true, keyName: 'Ctrl-C', bytes: 1, confidence: 'proven' };
      }
      throw new Error(`unexpected agent_command action: ${args.action}`);
    },
  });

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-claude',
      message: 'Steer this session onto the new plan',
      difficulty: 'medium',
      delivery_mode: 'interrupt',
    } as any));

    assert.equal(send.success, true);
    assert.equal(send.dispatched, false);
    assert.equal(send.decision, 'interrupted_and_queued');
    assert.equal(send.turnDiscarded, true);
    assert.equal(send.interrupt?.sent, true);
    assert.equal(send.interrupt?.key, 'Ctrl-C');
    assert.equal(typeof send.taskId, 'string');

    // The probe (read-only) and the actual interrupt were both sent, in that order.
    const actions = calls.filter(c => c.command === 'agent_command').map(c => c.args.action);
    assert.deepEqual(actions, ['interrupt_capability', 'interrupt_turn']);

    // The task actually landed pinned to this session, same funnel as when_idle queueing.
    const queued = getQueue(meshId).find(t => t.id === send.taskId);
    assert.ok(queued, 'interrupt dispatch must create a real queue row pinned to the session');
    assert.equal((queued as any).targetNodeId, 'node-local');
    assert.equal((queued as any).targetSessionId, 'sess-busy-claude');
  } finally {
    cleanupMesh(meshId);
  }
});

test('★ interrupt on an unsupported provider is REJECTED — no interrupt_turn call, no queue row created', async () => {
  const meshId = 'mesh-interrupt-dispatch-unsupported';
  cleanupMesh(meshId);
  const { ctx, calls } = createLocalBusyCtx(meshId, {
    agentCommandHandler: (args) => {
      if (args.action === 'interrupt_capability') {
        return {
          success: true,
          supported: false,
          reason: 'stop_keys_empty',
          message: "Provider 'claude-cli' declares a 'stop' control with an EMPTY key sequence.",
        };
      }
      throw new Error(`unexpected agent_command action for an unsupported probe: ${args.action}`);
    },
  });

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-claude',
      message: 'Steer this session onto the new plan',
      difficulty: 'medium',
      delivery_mode: 'interrupt',
    } as any));

    assert.equal(send.success, false);
    assert.equal(send.dispatched, false);
    assert.equal(send.decision, 'interrupt_unsupported');
    assert.equal(send.reason, 'interrupt_unsupported_for_provider');
    assert.match(send.message, /EMPTY key sequence/);
    assert.equal(send.taskId, undefined, 'no task handle — nothing was queued or dispatched');

    // Only the read-only probe fired; interrupt_turn must never be attempted.
    const actions = calls.filter(c => c.command === 'agent_command').map(c => c.args.action);
    assert.deepEqual(actions, ['interrupt_capability']);

    // No queue row was created for the rejected dispatch.
    assert.equal(getQueue(meshId).length, 0);
  } finally {
    cleanupMesh(meshId);
  }
});

test('interrupt_turn call itself failing (capability said yes, write refused) is reported as failure, not queued behind the still-running turn', async () => {
  const meshId = 'mesh-interrupt-dispatch-turn-fails';
  cleanupMesh(meshId);
  const { ctx, calls } = createLocalBusyCtx(meshId, {
    agentCommandHandler: (args) => {
      if (args.action === 'interrupt_capability') {
        return { success: true, supported: true, keyName: 'Ctrl-C', confidence: 'declared' };
      }
      if (args.action === 'interrupt_turn') {
        // e.g. the session raced to idle between the probe and the interrupt attempt.
        return { success: false, interrupted: false, reason: 'not_busy', error: 'Session is idle; nothing to interrupt.' };
      }
      throw new Error(`unexpected agent_command action: ${args.action}`);
    },
  });

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-claude',
      message: 'Steer this session onto the new plan',
      difficulty: 'medium',
      delivery_mode: 'interrupt',
    } as any));

    assert.equal(send.success, false);
    assert.equal(send.dispatched, false);
    assert.equal(send.decision, 'interrupt_failed');
    assert.equal(send.reason, 'not_busy');
    assert.equal(send.taskId, undefined, 'nothing must be queued behind a turn the interrupt failed to cancel');

    const actions = calls.filter(c => c.command === 'agent_command').map(c => c.args.action);
    assert.deepEqual(actions, ['interrupt_capability', 'interrupt_turn']);
    assert.equal(getQueue(meshId).length, 0);
  } finally {
    cleanupMesh(meshId);
  }
});

test('an unrecognized delivery_mode on a busy session queues (when_idle) and warns — it never reaches the interrupt probe', async () => {
  const meshId = 'mesh-interrupt-dispatch-typo';
  cleanupMesh(meshId);
  const { ctx, calls } = createLocalBusyCtx(meshId, {
    agentCommandHandler: (args) => {
      throw new Error(`agent_command must not be called for a typo'd delivery_mode: ${JSON.stringify(args)}`);
    },
  });

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-busy-claude',
      message: 'Steer this session onto the new plan',
      difficulty: 'medium',
      delivery_mode: 'immediate', // the tempting wrong name
    } as any));

    assert.equal(send.success, true);
    assert.equal(send.decision, 'queued_delivery');
    assert.match(send.deliveryModeWarning, /Unrecognized delivery_mode 'immediate'/);
    assert.match(send.deliveryModeWarning, /NOT interrupted/);

    // No agent_command was ever issued — the typo must not touch the interrupt path at all.
    assert.equal(calls.filter(c => c.command === 'agent_command').length, 0);
  } finally {
    cleanupMesh(meshId);
  }
});
