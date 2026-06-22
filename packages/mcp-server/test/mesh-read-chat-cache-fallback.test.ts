import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshReadChat } from '../src/tools/mesh-tools.js';
import { appendLedgerEntry, getLedgerDir } from '@adhdev/daemon-core';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// mesh_read_chat used to hard-fail at the 30s P2P timeout against a saturated/unreachable
// remote worker — even though the coordinator already holds the worker's latest assistant
// text from the completion/status events it surfaced (the same data the mobile dashboard
// renders). mesh_status degraded its P2P probe gracefully (collectLiveStatusProbe);
// read_chat had no catch. These tests pin the cache fallback: a remote P2P transport
// failure now surfaces the cached coordinator-side summary + a clear advisory, while local
// reads and genuine (non-transport) errors keep their existing behavior.

function cleanupMesh(meshId: string): void {
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

function createRemoteCtx(meshId: string, opts: { readChatError?: Error; readChatResult?: unknown; localCoordinator?: boolean } = {}) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const mesh = {
    id: meshId,
    name: 'Read Chat Cache Fallback',
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
      sessions: [{ id: 'sess-remote', providerType: 'hermes-cli', status: 'generating' }],
    }],
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    // Local-coordinator variant routes read_chat through transport.command.
    if (command === 'read_chat') {
      if (opts.readChatError) throw opts.readChatError;
      return opts.readChatResult ?? { success: true, messages: [] };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };

  transport.meshCommand = async (_daemonId, command) => {
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'read_chat') {
      if (opts.readChatError) throw opts.readChatError;
      return opts.readChatResult ?? { success: true, messages: [] };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  // localCoordinator: make node-remote resolve as the local control-plane node so
  // commandForNode takes the LOCAL path (transport.command) and the fallback is skipped.
  const localDaemonId = opts.localCoordinator ? 'daemon-remote' : 'daemon-coordinator';
  const localMachineId = opts.localCoordinator ? 'machine-remote' : 'machine-coordinator';
  return { ctx: { mesh, transport, localDaemonId, localMachineId } as any };
}

function seedCompletionSummary(meshId: string, summary: string): void {
  appendLedgerEntry(meshId, {
    kind: 'task_completed',
    nodeId: 'node-remote',
    sessionId: 'sess-remote',
    providerType: 'hermes-cli',
    payload: { event: 'agent:generating_completed', finalSummary: summary },
  });
}

const REQUEST_TIMEOUT_ERROR = new Error(
  "P2P mesh command 'read_chat' to daemon-remot timed out after 30000ms",
);
const ACK_TIMEOUT_ERROR = new Error(
  "P2P mesh command 'read_chat' to daemon-remot was not acknowledged within 8000ms (delivery failure)",
);

test('remote read_chat P2P REQUEST_TIMEOUT falls back to cached summary (saturated peer)', async () => {
  const meshId = 'mesh_readchat_saturated';
  cleanupMesh(meshId);
  seedCompletionSummary(meshId, 'Worker finished refactor; 3 files changed, tests pass.');
  const { ctx } = createRemoteCtx(meshId, { readChatError: REQUEST_TIMEOUT_ERROR });

  const out = await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' });
  const parsed = JSON.parse(out);

  assert.equal(parsed.success, true);
  assert.equal(parsed.source, 'coordinator_cache_fallback');
  assert.equal(parsed.fallback, true);
  assert.equal(parsed.fullTranscriptRequiresP2p, true);
  assert.equal(parsed.transportFailure.cause, 'saturated');
  assert.match(parsed.advisory, /saturated/i);
  assert.match(parsed.advisory, /full transcript requires a live P2P read_chat/i);
  assert.equal(parsed.summary, 'Worker finished refactor; 3 files changed, tests pass.');
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].role, 'assistant');
  assert.equal(parsed.messages[0].cached, true);
  assert.equal(parsed.messages[0].content, 'Worker finished refactor; 3 files changed, tests pass.');
  assert.equal(parsed.cachedPreview.ledgerKind, 'task_completed');

  cleanupMesh(meshId);
});

test('remote read_chat ACK/delivery failure reports a not_connected cause', async () => {
  const meshId = 'mesh_readchat_notconnected';
  cleanupMesh(meshId);
  seedCompletionSummary(meshId, 'Latest worker reply.');
  const { ctx } = createRemoteCtx(meshId, { readChatError: ACK_TIMEOUT_ERROR });

  const out = await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' });
  const parsed = JSON.parse(out);

  assert.equal(parsed.source, 'coordinator_cache_fallback');
  assert.equal(parsed.transportFailure.cause, 'not_connected');
  assert.match(parsed.advisory, /not currently connected/i);
  assert.equal(parsed.summary, 'Latest worker reply.');

  cleanupMesh(meshId);
});

test('remote read_chat P2P failure with no cached summary returns a clear transport failure', async () => {
  const meshId = 'mesh_readchat_nocache';
  cleanupMesh(meshId);
  // No ledger entry seeded → no cached preview.
  const { ctx } = createRemoteCtx(meshId, { readChatError: REQUEST_TIMEOUT_ERROR });

  const out = await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' });
  const parsed = JSON.parse(out);

  assert.equal(parsed.success, false);
  assert.equal(parsed.cachedSummaryAvailable, false);
  assert.equal(parsed.fullTranscriptRequiresP2p, true);
  assert.equal(parsed.transport, 'p2p');
  assert.match(parsed.advisory, /no cached coordinator-side summary/i);

  cleanupMesh(meshId);
});

test('remote read_chat non-transport (provider/logic) error is NOT swallowed', async () => {
  const meshId = 'mesh_readchat_logicerr';
  cleanupMesh(meshId);
  seedCompletionSummary(meshId, 'should not be used');
  const { ctx } = createRemoteCtx(meshId, {
    readChatError: new Error('Provider rejected: session not found'),
  });

  await assert.rejects(
    () => meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' }),
    /session not found/,
  );

  cleanupMesh(meshId);
});

test('successful remote read_chat returns the full transcript unchanged (no fallback)', async () => {
  const meshId = 'mesh_readchat_success';
  cleanupMesh(meshId);
  const { ctx } = createRemoteCtx(meshId, {
    readChatResult: {
      success: true,
      status: 'idle',
      messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: 'done the thing' },
      ],
    },
  });

  const out = await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: false });
  const parsed = JSON.parse(out);

  assert.equal(parsed.fallback, undefined);
  assert.equal(parsed.source, undefined);
  assert.deepEqual(parsed.messages.map((m: any) => m.content), ['do the thing', 'done the thing']);

  cleanupMesh(meshId);
});

test('local read_chat transport failure is NOT diverted to the cache fallback', async () => {
  const meshId = 'mesh_readchat_local';
  cleanupMesh(meshId);
  seedCompletionSummary(meshId, 'cached summary that must not surface for a local read');
  // localCoordinator: node-remote resolves as the local control-plane node, so the read
  // takes the LOCAL path. A thrown timeout there must rethrow, not fall back.
  const { ctx } = createRemoteCtx(meshId, { readChatError: REQUEST_TIMEOUT_ERROR, localCoordinator: true });

  await assert.rejects(
    () => meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' }),
    /timed out after 30000ms/,
  );

  cleanupMesh(meshId);
});
