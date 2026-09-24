import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { drainCoordinatorPendingEvents } from '../src/tools/mesh-tools-internal.js';
import { resolveMeshToolHandler } from '../src/tools/mesh-tool-dispatch.js';
import { runMeshToolWithPendingEvents } from '../src/tools/mesh-pending-events-attach.js';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

// Coordinator notices ride EVERY mesh tool response as `pendingCoordinatorEvents`
// (server.ts CallTool post-processing), not only the five tools that drained
// inline; and an MCP client that is NOT a PTY-hosted coordinator never claims
// notices a live CLI coordinator on the same daemon would receive (NOTICE-THEFT).
//
// The fake daemon answers `get_pending_mesh_events` with the real handler's
// contract (daemon-core commands/high-family/mesh-events.ts): a live CLI
// coordinator + no `selfCoordinatorInboxRead` → empty, `deliveredByCursor`;
// otherwise the notices are returned AND acked.

function buildCtx(meshId: string, opts: { hasLiveCliCoordinator: boolean; coordinatorSessionId?: string }) {
  const mesh = {
    id: meshId, name: 'Notice Mesh', repoIdentity: 'example/repo', policy: {}, coordinator: {},
    defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-0', workspace: '/tmp/notice-repo', repoRoot: '/tmp/notice-repo', daemonId: 'daemon-A', machineId: 'machine-A',
      userOverrides: {}, policy: { providerPriority: ['claude-cli'] },
    }],
  };
  let pending = [{
    eventId: 'notice-1', writer: 'w', seq: 1, meshId, event: 'agent:generating_completed', notify: 'completed',
    nodeLabel: 'node-0', coordinatorMessage: '[System] node-0 completed task t1', queuedAt: Date.now(), taskId: 't1',
  }];
  const drainArgs: Array<Record<string, unknown>> = [];
  const responder = (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'get_pending_mesh_events') {
      drainArgs.push(args);
      if (opts.hasLiveCliCoordinator && args.selfCoordinatorInboxRead !== true) {
        return { success: true, events: [], hasLiveCliCoordinator: true, source: 'turn.notify', deliveredByCursor: true };
      }
      const events = pending;
      if (args.ack !== false) pending = [];
      return { success: true, events, hasLiveCliCoordinator: opts.hasLiveCliCoordinator, surfacedForSelfCoordinator: true, source: 'turn.notify' };
    }
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'git_status') return { success: true, status: { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc1234' } };
    return { success: true };
  };
  const transport = new IpcTransport() as any;
  transport.command = async (command: string, args?: Record<string, unknown>) => {
    if (isTurnIpcCommand(command)) return answerTurnIpc(command, args ?? {});
    return responder(command, args ?? {});
  };
  transport.meshCommand = async (_daemonId: string, command: string, args?: Record<string, unknown>) => responder(command, args ?? {});
  const ctx: any = {
    mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A',
    ...(opts.coordinatorSessionId ? { coordinatorSessionId: opts.coordinatorSessionId } : {}),
  };
  return { ctx, drainArgs, pendingCount: () => pending.length };
}

function cleanup(meshId: string): void {
  __clearMeshQueueForTests(meshId);
  __clearLocalRecordsForTests(meshId);
}

const viewQueue = resolveMeshToolHandler('mesh_view_queue')!;

test('NOTICE-THEFT: a client with no coordinator session does not send selfCoordinatorInboxRead / sessionId', async () => {
  const { ctx, drainArgs } = buildCtx('mesh-theft-args', { hasLiveCliCoordinator: false });
  await drainCoordinatorPendingEvents(ctx);
  assert.deepEqual(drainArgs, [{ meshId: 'mesh-theft-args', coordinatorDaemonId: 'daemon-A' }]);
});

test('NOTICE-THEFT: an external client on a daemon hosting a live CLI coordinator claims nothing', async () => {
  const meshId = 'mesh-theft-live-coord';
  cleanup(meshId);
  const { ctx, pendingCount } = buildCtx(meshId, { hasLiveCliCoordinator: true });
  try {
    const text = await runMeshToolWithPendingEvents(ctx, () => viewQueue(ctx, { view: 'active' }));
    assert.equal('pendingCoordinatorEvents' in JSON.parse(text), false);
    assert.equal(pendingCount(), 1, 'the notice stays for the live coordinator cursor');
  } finally { cleanup(meshId); }
});

test('the PTY-hosted coordinator itself still reads its own inbox (self read, scoped to its session)', async () => {
  const meshId = 'mesh-self-coord';
  cleanup(meshId);
  const { ctx, drainArgs } = buildCtx(meshId, { hasLiveCliCoordinator: true, coordinatorSessionId: 'coord-1' });
  try {
    const text = await runMeshToolWithPendingEvents(ctx, () => viewQueue(ctx, { view: 'active' }));
    assert.deepEqual(JSON.parse(text).pendingCoordinatorEvents.map((e: any) => e.eventId), ['notice-1']);
    assert.equal(drainArgs[0].selfCoordinatorInboxRead, true);
    assert.equal(drainArgs[0].sessionId, 'coord-1');
  } finally { cleanup(meshId); }
});

test('mesh_view_queue (a tool with no inline drain) carries pendingCoordinatorEvents for an MCP-only coordinator, once', async () => {
  const meshId = 'mesh-every-tool-drain';
  cleanup(meshId);
  const { ctx, drainArgs, pendingCount } = buildCtx(meshId, { hasLiveCliCoordinator: false });
  try {
    const first = JSON.parse(await runMeshToolWithPendingEvents(ctx, () => viewQueue(ctx, { view: 'active' })));
    assert.deepEqual(first.pendingCoordinatorEvents.map((e: any) => e.eventId), ['notice-1']);
    assert.equal(first.pendingCoordinatorEvents[0].coordinatorMessage, '[System] node-0 completed task t1');
    assert.equal(pendingCount(), 0, 'surfaced notices are acked');
    assert.equal(drainArgs.length, 1);
    const second = JSON.parse(await runMeshToolWithPendingEvents(ctx, () => viewQueue(ctx, { view: 'active' })));
    assert.equal('pendingCoordinatorEvents' in second, false);
  } finally { cleanup(meshId); }
});

test('a tool that drained inline is not drained a second time in the same call', async () => {
  const { ctx, drainArgs, pendingCount } = buildCtx('mesh-no-double-drain', { hasLiveCliCoordinator: false });
  const text = await runMeshToolWithPendingEvents(ctx, async () => {
    await drainCoordinatorPendingEvents(ctx, { nodeIds: [] });
    // Simulates an inline drain whose events were already consumed elsewhere
    // (empty → the tool attaches no field).
    return JSON.stringify({ success: true });
  });
  assert.equal(drainArgs.length, 1);
  assert.equal(pendingCount(), 0);
  assert.deepEqual(JSON.parse(text), { success: true });
});

test('a response that already carries the field, or is not a JSON object, is left untouched (no drain)', async () => {
  const { ctx, drainArgs, pendingCount } = buildCtx('mesh-untouched', { hasLiveCliCoordinator: false });
  const withField = JSON.stringify({ success: true, pendingCoordinatorEvents: [] });
  assert.equal(await runMeshToolWithPendingEvents(ctx, async () => withField), withField);
  assert.equal(await runMeshToolWithPendingEvents(ctx, async () => 'plain text result'), 'plain text result');
  assert.equal(await runMeshToolWithPendingEvents(ctx, async () => '[1,2]'), '[1,2]');
  assert.equal(drainArgs.length, 0);
  assert.equal(pendingCount(), 1, 'nothing acked when there is nowhere to attach it');
});

test('server.ts mesh-mode CallTool routes every tool through the pendingCoordinatorEvents post-processor', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(src, /const text = await runMeshToolWithPendingEvents\(meshCtx, run\);/);
});
