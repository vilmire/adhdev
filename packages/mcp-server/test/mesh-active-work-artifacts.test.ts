import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshEnqueueTask, meshSendTask, meshStatus, meshViewQueue } from '../src/tools/mesh-tools.js';
import { appendLedgerEntry, buildTaskCompletionEvidence, enqueueTask, getLedgerDir, readLedgerEntries, updateTaskStatus } from '@adhdev/daemon-core';

function cleanupMesh(meshId: string): void {
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

function createRemoteCtx(meshId: string) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const mesh = {
    id: meshId,
    name: 'Active Work Artifacts',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-remote',
      workspace: '/tmp/remote-repo',
      repoRoot: '/tmp/remote-repo',
      daemonId: 'daemon-remote',
      machineId: 'machine-remote',
      userOverrides: {},
      policy: { providerPriority: ['hermes-cli'] },
      sessions: [{
        id: 'sess-direct',
        providerType: 'hermes-cli',
        status: 'generating',
        settings: {
          meshNodeFor: meshId,
          meshNodeId: 'node-remote',
          meshCoordinatorDaemonId: 'daemon-coordinator',
        },
      }],
    }],
  };
  const calls: Array<{ daemonId?: string; command: string; args: Record<string, unknown> }> = [];

  transport.command = async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    throw new Error(`unexpected direct command: ${command}`);
  };

  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'get_status_metadata') {
      return {
        success: true,
        status: {
          sessions: [{
            id: 'sess-direct',
            providerType: 'hermes-cli',
            status: 'generating',
            settings: {
              meshNodeFor: meshId,
              meshNodeId: 'node-remote',
              meshCoordinatorDaemonId: 'daemon-coordinator',
            },
          }],
        },
      };
    }
    if (command === 'agent_command') return { success: true };
    if (command === 'git_status') return { success: true, status: { isGitRepo: true, isDirty: false, branch: 'feat/direct-active' } };
    if (command === 'get_pending_mesh_events') return { events: [] };
    throw new Error(`unexpected mesh command: ${command}`);
  };

  return { ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' }, calls };
}

test('direct mesh_send_task is visible as source=direct active work in status and active queue view', async () => {
  const meshId = 'mesh-active-direct-test';
  cleanupMesh(meshId);
  const { ctx, calls } = createRemoteCtx(meshId);

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-remote',
      session_id: 'sess-direct',
      message: 'Implement direct active work visibility',
    } as any));
    assert.equal(send.success, true);
    assert.equal(send.source, 'direct');
    assert.equal(typeof send.taskId, 'string');

    const status = JSON.parse(await meshStatus(ctx as any));
    const direct = status.activeWork.find((entry: any) => entry.source === 'direct' && entry.taskId === send.taskId);
    assert.ok(direct, 'expected direct task in mesh_status.activeWork');
    assert.equal(direct.nodeId, 'node-remote');
    assert.equal(direct.sessionId, 'sess-direct');
    assert.equal(direct.providerType, 'hermes-cli');
    assert.equal(direct.status, 'generating');
    assert.equal(direct.taskTitle, 'Implement direct active work visibility');
    assert.equal(typeof direct.elapsedMs, 'number');
    assert.equal(status.activeWorkSummary.directActiveCount, 1);

    const activeView = JSON.parse(await meshViewQueue(ctx as any, { view: 'active' }));
    assert.equal(activeView.visibleHistoricalCount, 0);
    assert.ok(activeView.activeWork.some((entry: any) => entry.source === 'direct' && entry.taskId === send.taskId));
    assert.ok(calls.some(call => call.command === 'agent_command'));
  } finally {
    cleanupMesh(meshId);
  }
});

test('active queue view keeps historical queue rows out while direct work is exposed separately', async () => {
  const meshId = 'mesh-active-only-separation-test';
  cleanupMesh(meshId);
  const { ctx } = createRemoteCtx(meshId);

  try {
    const pending = enqueueTask(meshId, 'pending queue task');
    const completed = enqueueTask(meshId, 'completed queue task');
    const failed = enqueueTask(meshId, 'failed queue task');
    updateTaskStatus(meshId, completed.id, 'completed');
    updateTaskStatus(meshId, failed.id, 'failed');
    appendLedgerEntry(meshId, {
      kind: 'task_dispatched',
      nodeId: 'node-remote',
      sessionId: 'sess-direct',
      providerType: 'hermes-cli',
      payload: {
        taskId: 'direct-ledger-task',
        message: 'Inspect live logs only',
        source: 'direct',
        via: 'p2p_direct',
      },
    });

    const activeView = JSON.parse(await meshViewQueue(ctx as any, { view: 'active' }));
    assert.deepEqual(activeView.queue.map((task: any) => task.id), [pending.id]);
    assert.equal(activeView.visibleHistoricalCount, 0);
    assert.equal(activeView.historicalQueue, undefined);
    assert.ok(activeView.activeWork.every((entry: any) => entry.source === 'queue' || entry.source === 'direct'));
    assert.ok(activeView.activeWork.some((entry: any) => entry.source === 'direct' && entry.taskId === 'direct-ledger-task'));
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_enqueue_task enqueue-and-push remains queue-sourced active work', async () => {
  const meshId = 'mesh-enqueue-push-source-test';
  cleanupMesh(meshId);
  const { ctx } = createRemoteCtx(meshId);

  try {
    const enqueued = JSON.parse(await meshEnqueueTask(ctx as any, {
      message: 'Queue-backed task that may be pushed to a remote idle session',
    } as any));
    assert.equal(enqueued.success, true);
    assert.equal(enqueued.source, 'queue');
    assert.equal(typeof enqueued.taskId, 'string');

    await new Promise(resolve => setImmediate(resolve));

    const dispatch = readLedgerEntries(meshId).find(entry => entry.kind === 'task_dispatched' && entry.payload?.taskId === enqueued.taskId);
    assert.ok(dispatch, 'expected enqueue-and-push dispatch ledger row');
    assert.equal(dispatch.payload.source, 'queue');
    assert.equal(dispatch.payload.via, 'p2p_direct');

    const status = JSON.parse(await meshStatus(ctx as any));
    assert.ok(status.activeWork.some((entry: any) => entry.source === 'queue' && entry.taskId === enqueued.taskId));
    assert.equal(status.activeWork.some((entry: any) => entry.source === 'direct' && entry.taskId === enqueued.taskId), false);
  } finally {
    cleanupMesh(meshId);
  }
});

test('task completion evidence normalizes structured worker result and process artifacts separately from final summary', () => {
  const evidence = buildTaskCompletionEvidence({
    event: 'agent:generating_completed',
    nodeId: 'node-remote',
    sessionId: 'sess-direct',
    providerType: 'hermes-cli',
    providerSessionId: 'provider-123',
    finalSummary: [
      'Human summary remains readable.',
      '```json',
      JSON.stringify({
        status: 'completed',
        classification: 'code_change',
        changedFiles: ['oss/packages/daemon-core/src/mesh/mesh-active-work.ts'],
        validationResults: [{ command: 'npm test', status: 'passed', durationMs: 1200 }],
        gitStatus: { branch: 'feat/repo-mesh-active-work-artifacts', dirty: false },
        processArtifacts: [{ kind: 'log', id: 'daemon-log', label: 'Daemon log', locator: '/tmp/daemon.log', keepRunning: true }],
        errors: [],
        nextAction: 'merge/refine',
        requiresUserAction: false,
      }),
      '```',
    ].join('\n'),
  } as any) as any;

  assert.equal(evidence.workerResult.status, 'completed');
  assert.equal(evidence.workerResult.classification, 'code_change');
  assert.deepEqual(evidence.workerResult.changedFiles, ['oss/packages/daemon-core/src/mesh/mesh-active-work.ts']);
  assert.equal(evidence.workerResult.validationResults[0].status, 'passed');
  assert.equal(evidence.workerResult.processArtifacts[0].kind, 'log');
  assert.equal(evidence.transcriptHandle.finalSummaryAvailable, true);
});

test('live_debug_readonly mode rejects obvious write/commit/push dispatches but allows inspection-only work', async () => {
  const meshId = 'mesh-live-debug-readonly-test';
  cleanupMesh(meshId);
  const { ctx, calls } = createRemoteCtx(meshId);

  try {
    const rejected = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-remote',
      session_id: 'sess-direct',
      task_mode: 'live_debug_readonly',
      message: 'Inspect logs, then edit src/index.ts, git commit, and push the fix.',
    } as any));
    assert.equal(rejected.success, false);
    assert.equal(rejected.code, 'live_debug_readonly_guardrail_violation');
    assert.equal(calls.some(call => call.command === 'agent_command'), false);

    const allowed = JSON.parse(await meshEnqueueTask(ctx as any, {
      task_mode: 'live_debug_readonly',
      message: 'Inspect live process logs, open ports, windows, and session status; report keep-running handles only.',
    } as any));
    assert.equal(allowed.success, true);
    assert.equal(allowed.source, 'queue');
    assert.equal(allowed.taskMode, 'live_debug_readonly');
  } finally {
    cleanupMesh(meshId);
  }
});
