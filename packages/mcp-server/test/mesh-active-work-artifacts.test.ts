import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshEnqueueTask, meshQueueCancel, meshSendTask, meshStatus, meshTaskHistory, meshViewQueue } from '../src/tools/mesh-tools.js';
import { appendLedgerEntry, buildTaskCompletionEvidence, enqueueTask, getLedgerDir, queuePendingMeshCoordinatorEvent, readLedgerEntries, updateTaskStatus } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';

function cleanupMesh(meshId: string): void {
  __clearMeshQueueForTests(meshId);
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
    assert.equal(status.pollingGuidance.activeGeneratingWork, true);
    assert.equal(status.pollingGuidance.generatingCount, 1);
    assert.match(status.pollingGuidance.message, /Do not repeatedly poll mesh_status\/mesh_view_queue\/mesh_read_chat/i);
    assert.match(status.pollingGuidance.nextRecommendedAction, /wait for pendingCoordinatorEvents|completion events/i);
    assert.equal(status.pollingGuidance.eventSurface, 'pendingCoordinatorEvents');
    assert.equal(typeof status.pollingGuidance.doNotPollBefore, 'string');

    const activeView = JSON.parse(await meshViewQueue(ctx as any, { view: 'active' }));
    assert.equal(activeView.visibleHistoricalCount, 0);
    assert.ok(activeView.activeWork.some((entry: any) => entry.source === 'direct' && entry.taskId === send.taskId));
    assert.equal(activeView.pollingGuidance.activeGeneratingWork, true);
    assert.equal(activeView.pollingGuidance.generatingCount, 1);
    assert.match(activeView.pollingGuidance.message, /Do not repeatedly poll mesh_status\/mesh_view_queue\/mesh_read_chat/i);
    assert.match(activeView.pollingGuidance.nextRecommendedAction, /wait for pendingCoordinatorEvents|completion events/i);
    assert.equal(activeView.pollingGuidance.eventSurface, 'pendingCoordinatorEvents');
    assert.equal(typeof activeView.pollingGuidance.doNotPollBefore, 'string');
    assert.ok(calls.some(call => call.command === 'agent_command'));
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_view_queue refreshes live mesh sessions before classifying direct work', async () => {
  const meshId = 'mesh-view-queue-refresh-direct-test';
  cleanupMesh(meshId);
  const { ctx, calls } = createRemoteCtx(meshId);
  const staleCtx = {
    ...ctx,
    mesh: {
      ...(ctx as any).mesh,
      nodes: (ctx as any).mesh.nodes.map((node: any) => ({ ...node, sessions: [] })),
    },
  };

  try {
    appendLedgerEntry(meshId, {
      kind: 'task_dispatched',
      nodeId: 'node-remote',
      sessionId: 'sess-direct',
      providerType: 'hermes-cli',
      payload: {
        taskId: 'direct-refresh-task',
        message: 'Keep direct work active after coordinator refresh',
        source: 'direct',
        via: 'p2p_direct',
      },
    });

    const activeView = JSON.parse(await meshViewQueue(staleCtx as any, { view: 'active' }));
    assert.ok(calls.some(call => call.command === 'get_mesh'), 'mesh_view_queue should refresh mesh state before active/stale classification');
    assert.ok(activeView.activeWork.some((entry: any) => entry.source === 'direct' && entry.taskId === 'direct-refresh-task'));
    assert.equal(activeView.staleDirectWork.some((entry: any) => entry.taskId === 'direct-refresh-task'), false);
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

test('stale direct ledger tasks are separated from active work when queue is empty and sessions are not live', async () => {
  const meshId = 'mesh-stale-direct-active-work-test';
  cleanupMesh(meshId);
  const mesh = {
    id: meshId,
    name: 'Stale Direct Work',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-live',
      workspace: '/tmp/live-repo',
      repoRoot: '/tmp/live-repo',
      daemonId: 'daemon-live',
      machineLabel: 'Live workspace',
      userOverrides: {},
      policy: { providerPriority: ['hermes-cli'] },
      sessions: [],
    }],
  };
  const transport = new IpcTransport() as any;
  transport.command = async (command: string) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    return { success: false };
  };
  transport.meshCommand = async (_daemonId: string, command: string) => {
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'git_status') return { success: false, error: 'not live' };
    if (command === 'get_pending_mesh_events') return { events: [] };
    return { success: false };
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' };

  try {
    appendLedgerEntry(meshId, {
      kind: 'task_dispatched',
      nodeId: 'node-live',
      sessionId: 'sess-missing',
      providerType: 'hermes-cli',
      payload: { taskId: 'direct-missing-session', message: 'old direct task', source: 'direct', via: 'p2p_direct' },
    });
    appendLedgerEntry(meshId, {
      kind: 'task_approval_needed',
      nodeId: 'node-live',
      sessionId: 'sess-missing',
      providerType: 'hermes-cli',
      payload: { taskId: 'direct-missing-session' },
    });
    appendLedgerEntry(meshId, {
      kind: 'task_dispatched',
      nodeId: 'node-removed-worktree',
      sessionId: 'sess-removed',
      providerType: 'hermes-cli',
      payload: { taskId: 'direct-removed-node', message: 'removed worktree direct task', source: 'direct', via: 'p2p_direct' },
    });

    const activeView = JSON.parse(await meshViewQueue(ctx as any, { view: 'active' }));
    assert.equal(activeView.activeCount, 0);
    assert.deepEqual(activeView.queue, []);
    assert.equal(activeView.activeWorkSummary.totalActiveCount, 0);
    assert.equal(activeView.activeWorkSummary.directActiveCount, 0);
    assert.equal(activeView.activeWorkSummary.staleDirectCount, 2);
    assert.equal(activeView.pollingGuidance, undefined);
    assert.deepEqual(activeView.staleDirectWork.map((entry: any) => entry.taskId).sort(), [
      'direct-missing-session',
      'direct-removed-node',
    ]);
    assert.equal(activeView.staleDirectWork.find((entry: any) => entry.taskId === 'direct-missing-session')?.status, 'awaiting_approval');
    assert.match(activeView.staleDirectWork.find((entry: any) => entry.taskId === 'direct-missing-session')?.staleReason, /not present in live session/);
    assert.match(activeView.staleDirectWork.find((entry: any) => entry.taskId === 'direct-removed-node')?.staleReason, /no longer in the live mesh/);

    const cancel = JSON.parse(await meshQueueCancel(ctx as any, { task_id: 'direct-missing-session' }));
    assert.equal(cancel.success, false);
    assert.match(cancel.error, /not found/);

    const status = JSON.parse(await meshStatus(ctx as any));
    assert.equal(status.activeWorkSummary.totalActiveCount, 0);
    assert.equal(status.activeWorkSummary.directActiveCount, 0);
    assert.equal(status.activeWorkSummary.staleDirectCount, 2);
    assert.equal(status.pollingGuidance, undefined);
    assert.equal(status.staleDirectWork, undefined);
    assert.equal(status.staleDirectWorkSummary.count, 2);
    assert.deepEqual(status.staleDirectWorkSummary.sample.map((entry: any) => entry.taskId).sort(), [
      'direct-missing-session',
      'direct-removed-node',
    ]);

    const detailedStatus = JSON.parse(await meshStatus(ctx as any, { includeStaleDirectWorkDetails: true }));
    assert.deepEqual(detailedStatus.staleDirectWork.map((entry: any) => entry.taskId).sort(), [
      'direct-missing-session',
      'direct-removed-node',
    ]);
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_task_history returns pending async refine failure events instead of discarding them', async () => {
  const meshId = 'mesh-refine-pending-history-test';
  cleanupMesh(meshId);
  const mesh = {
    id: meshId,
    name: 'Refine Event Surfacing',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-refine',
      workspace: '/tmp/refine-worktree',
      repoRoot: '/tmp/refine-worktree',
      daemonId: 'daemon-refine',
      machineLabel: 'Refine worker',
      userOverrides: {},
      policy: { providerPriority: ['hermes-cli'] },
    }],
  };
  const ctx = {
    mesh,
    transport: {
      command: async (command: string) => {
        if (command === 'get_pending_mesh_events') {
          const { drainPendingMeshCoordinatorEvents } = await import('@adhdev/daemon-core');
          return { success: true, events: drainPendingMeshCoordinatorEvents(meshId) };
        }
        return { success: false };
      },
    },
    localDaemonId: 'daemon-coordinator',
    localMachineId: 'machine-coordinator',
  };
  const jobId = 'refine_ix_mpmavtun_zya19p';
  const result = {
    success: false,
    code: 'validation_failed',
    convergenceStatus: 'blocked_review',
    error: 'Refinery validation gate failed; merge/refine was not attempted.',
    finalBranchConvergenceState: {
      status: 'blocked_review',
      nextStep: 'Fix validation, then rerun mesh_refine_node.',
    },
  };

  try {
    appendLedgerEntry(meshId, {
      kind: 'task_failed',
      nodeId: 'node-refine',
      payload: {
        source: 'refine_mesh_node_async_job',
        refineJob: { jobId, interactionId: 'ix-test', status: 'failed', meshId, nodeId: 'node-refine' },
        async: true,
        success: false,
        result,
        finalBranchConvergenceState: result.finalBranchConvergenceState,
      },
    });
    queuePendingMeshCoordinatorEvent({
      event: 'refine:failed',
      meshId,
      nodeLabel: 'node-refine',
      nodeId: 'node-refine',
      workspace: '/tmp/refine-worktree',
      metadataEvent: {
        source: 'refine_mesh_node_async_job',
        jobId,
        interactionId: 'ix-test',
        meshId,
        nodeId: 'node-refine',
        status: 'failed',
        result,
      },
      queuedAt: Date.now(),
    });

    const first = JSON.parse(await meshTaskHistory(ctx as any, { tail: 5 }));
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].kind, 'task_failed');
    assert.equal(first.entries[0].payload.result.code, 'validation_failed');
    assert.equal(first.pendingCoordinatorEvents.length, 1);
    assert.equal(first.pendingCoordinatorEvents[0].event, 'refine:failed');
    assert.equal(first.pendingCoordinatorEvents[0].metadataEvent.jobId, jobId);
    assert.equal(first.pendingCoordinatorEvents[0].metadataEvent.result.convergenceStatus, 'blocked_review');

    const second = JSON.parse(await meshTaskHistory(ctx as any, { tail: 5 }));
    assert.equal(second.pendingCoordinatorEvents, undefined);
    assert.equal(second.entries.length, 1);
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
