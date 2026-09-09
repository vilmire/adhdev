import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshLaunchSession } from '../src/tools/mesh-tools.js';
import { getLedgerDir, readLedgerEntries } from '@adhdev/daemon-core';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';

// LAUNCH-ACCOUNTING (P4) single-writer dedup: a current daemon appends the
// `session_launched` audit entry itself in its launch_cli funnel (cli-manager) and
// answers `ledgerLaunchRecorded: true`. mesh_launch_session must then SKIP its own
// coordinator-side append — otherwise the same launch is counted twice (immediately for a
// co-located node, after P2P ledger replication for a remote one). For a version-skewed
// OLDER daemon that neither appends nor sets the flag, the coordinator-side append stays
// as a fallback so no launch goes unrecorded.

function makeCtx(meshId: string, launchResult: Record<string, unknown>) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const launchCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command, args = {}) => {
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'trigger_mesh_queue') return { success: true, trigger: { success: true } };
    if (command === 'detect_provider') return { success: true, detected: true };
    if (command === 'launch_cli') {
      launchCalls.push({ command, args });
      return launchResult;
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  const mesh = {
    id: meshId,
    name: 'Ledger Dedup Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-mac',
      workspace: '/repo',
      repoRoot: '/repo',
      // No daemonId → local control-plane node; launch goes through transport.command.
      userOverrides: {},
      policy: { providerPriority: ['codex-cli'] },
    }],
  };
  const ctx = { mesh, transport, localDaemonId: 'daemon-mac' } as any;
  return { ctx, launchCalls };
}

function sessionLaunchedEntries(meshId: string) {
  return readLedgerEntries(meshId, { tail: 50 }).filter((e: any) => e.kind === 'session_launched');
}

function cleanup(meshId: string) {
  __clearMeshLedgerForTests(meshId);
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = join(getLedgerDir(), `${safe}.jsonl`);
  if (existsSync(path)) unlinkSync(path);
}

test('daemon that recorded the launch (ledgerLaunchRecorded) → coordinator does NOT append a duplicate', async () => {
  const meshId = 'mesh_launch_dedup_new_daemon';
  cleanup(meshId);
  try {
    const { ctx, launchCalls } = makeCtx(meshId, {
      success: true, sessionId: 'sess-1', ledgerLaunchRecorded: true,
    });
    const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' }));
    assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);

    // The worker envelope carries the path discriminator for the daemon-side funnel.
    const launch = launchCalls.find(c => c.command === 'launch_cli');
    assert.ok(launch, 'launch_cli was issued');
    assert.equal((launch!.args.settings as any)?.meshLaunchSource, 'mesh_launch_session');

    // Single-writer: the daemon recorded it; the coordinator must not double-count.
    assert.equal(sessionLaunchedEntries(meshId).length, 0);
  } finally {
    cleanup(meshId);
  }
});

test('older daemon without the flag → coordinator-side fallback append still records the launch', async () => {
  const meshId = 'mesh_launch_dedup_old_daemon';
  cleanup(meshId);
  try {
    const { ctx } = makeCtx(meshId, { success: true, sessionId: 'sess-1' });
    const result = JSON.parse(await meshLaunchSession(ctx, { node_id: 'node-mac', type: 'codex-cli' }));
    assert.equal(result.success !== false, true, `launch should succeed: ${JSON.stringify(result)}`);

    const entries = sessionLaunchedEntries(meshId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].nodeId, 'node-mac');
    assert.equal(entries[0].sessionId, 'sess-1');
    assert.equal((entries[0].payload as any)?.source, 'mesh_launch_session_coordinator_fallback');
  } finally {
    cleanup(meshId);
  }
});
