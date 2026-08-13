import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { computeIdleDispatchAckRisk, meshSendTask } from '../src/tools/mesh-tools.js';
import { getActiveDirectDispatches, getLedgerDir } from '@adhdev/daemon-core';
import { __clearDirectDispatchesForTests, __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// DISPATCH-ACK-RISK-STALE regression coverage.
//
// After the NOTIF-DROP / CANON-A fix (insertDirectDispatch atomically pre-records the
// dispatch row BEFORE inject), a direct dispatch to an idle session no longer loses its
// completion: sessionHasActiveAssignment becomes TRUE at completion time, so the
// prior-terminal providerSessionId dedup gate is skipped. The dispatch response must NOT
// keep emitting `dispatchAcknowledgementRisk:true` for that (now-safe) idle case — the
// stale warning made coordinators do needless verification polling. The warning is kept
// only for the GENUINE residual risk: an idle dispatch whose row did not survive pre-record.

function cleanupMesh(meshId: string): void {
  __clearMeshQueueForTests(meshId);
  __clearDirectDispatchesForTests(meshId);
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

// A LOCAL control-plane node (daemonId === ctx.localDaemonId) hosting a single idle,
// mesh-managed delegate session. This routes meshSendTask through the local direct-dispatch
// path (mesh-tools-session.ts) where insertDirectDispatch pre-records the row and the risk
// flag is computed — not the P2P remote path (which never attaches the risk flag).
function createLocalIdleCtx(meshId: string, opts: { agentCommandSucceeds: boolean }) {
  const idleSession = {
    id: 'sess-idle',
    providerType: 'claude-cli',
    status: 'idle',
    settings: {
      meshNodeFor: meshId,
      meshNodeId: 'node-local',
      meshCoordinatorDaemonId: 'daemon-coordinator',
    },
  };
  const mesh = {
    id: meshId,
    name: 'Dispatch Ack Risk',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-local',
      workspace: '/tmp/local-repo',
      repoRoot: '/tmp/local-repo',
      // daemonId matches ctx.localDaemonId below -> isLocalControlPlaneNode === true.
      daemonId: 'daemon-coordinator',
      machineId: 'machine-coordinator',
      userOverrides: {},
      policy: { providerPriority: ['claude-cli'] },
      sessions: [idleSession],
    }],
  };
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [idleSession] } };
    if (command === 'agent_command') return { success: opts.agentCommandSucceeds };
    throw new Error(`unexpected local command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    throw new Error(`unexpected mesh command on local node: ${command}`);
  };
  return { ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' }, calls };
}

test('idle-session direct dispatch with a successful pre-record reports NO acknowledgement risk', async () => {
  const meshId = 'mesh-dispatch-ack-risk-idle-prerecorded';
  cleanupMesh(meshId);
  const { ctx, calls } = createLocalIdleCtx(meshId, { agentCommandSucceeds: true });

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-idle',
      message: 'Direct task to a reused idle session',
      difficulty: 'medium',
    } as any));

    assert.equal(send.success, true);
    assert.equal(send.source, 'direct');
    assert.equal(typeof send.taskId, 'string');
    // The inject was accepted, so the dispatch row pre-record survived.
    assert.ok(calls.some(call => call.command === 'agent_command'));
    assert.ok(
      getActiveDirectDispatches(meshId).some(d => d.taskId === send.taskId),
      'expected the pre-recorded dispatch row to persist',
    );
    // Pre-record succeeded -> sessionHasActiveAssignment will be TRUE at completion ->
    // the dedup gate is skipped -> there is NO residual loss risk -> the stale warning
    // must be ABSENT (the whole point of this fix).
    assert.equal(send.dispatchAcknowledgementRisk, undefined);
    assert.equal(send.dispatchAcknowledgementRiskReason, undefined);
    assert.equal(send.dispatchAcknowledgementNote, undefined);
  } finally {
    cleanupMesh(meshId);
  }
});

test('idle-session direct dispatch whose inject is rejected rolls back the row and returns a failure (not a stale risk warning)', async () => {
  const meshId = 'mesh-dispatch-ack-risk-idle-rejected';
  cleanupMesh(meshId);
  const { ctx } = createLocalIdleCtx(meshId, { agentCommandSucceeds: false });

  try {
    const send = JSON.parse(await meshSendTask(ctx as any, {
      node_id: 'node-local',
      session_id: 'sess-idle',
      message: 'Direct task whose inject the agent rejects',
      difficulty: 'medium',
    } as any));

    // A rejected inject is a hard failure, not a success-with-warning. The pre-recorded
    // row is rolled back so it cannot masquerade as an active assignment later.
    assert.equal(send.success, false);
    assert.equal(getActiveDirectDispatches(meshId).length, 0, 'rejected inject must roll back the pre-recorded row');
  } finally {
    cleanupMesh(meshId);
  }
});

// The genuine residual-risk branch — idle session AND the dispatch row did not persist —
// is exercised directly through the pure decision helper. The daemon-core
// insertDirectDispatch wrapper swallows its own persistence errors and never throws, so a
// live persistence failure cannot be forced deterministically from the tool layer; the
// helper is the single source of truth for the risk decision, so unit-testing it pins the
// behavior precisely for both branches.
test('computeIdleDispatchAckRisk warns only for an idle dispatch whose pre-record did not persist', () => {
  // Genuine residual risk: idle + pre-record failed -> warn with the precise reason.
  const risk = computeIdleDispatchAckRisk(true, false, 'sess-idle');
  assert.equal(risk.dispatchAcknowledgementRisk, true);
  assert.equal(risk.dispatchAcknowledgementRiskReason, 'idle_dispatch_prerecord_failed');
  assert.match(String(risk.dispatchAcknowledgementNote), /could not be pre-recorded/);

  // Idle but pre-record succeeded -> NO risk (the stale-warning case this fix removes).
  assert.deepEqual(computeIdleDispatchAckRisk(true, true, 'sess-idle'), {});

  // Non-idle session -> never a risk regardless of pre-record state.
  assert.deepEqual(computeIdleDispatchAckRisk(false, false, 'sess-busy'), {});
  assert.deepEqual(computeIdleDispatchAckRisk(false, true, 'sess-busy'), {});
});
