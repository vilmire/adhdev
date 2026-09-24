/**
 * mesh_read_chat replica hop — `provider_session_id` and `tail` (same-axis audit C).
 *
 * The replica is keyed by (owner daemon, runtime session) and always holds that
 * session's CURRENT provider conversation. Before this fix an explicit
 * provider_session_id was ignored on the replica hop (a different conversation's
 * transcript was returned with no warning), and compact:false ignored `tail`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshReadChat } from '../src/tools/mesh-tools.js';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

function msg(i: number) {
  return { role: i % 2 ? 'assistant' : 'user', kind: 'standard', content: `M${i}`, receivedAt: i, timestamp: i, turnKey: `t${i}`, bubbleState: 'final', senderName: null, toolName: null, streaming: null };
}

const SNAPSHOT = {
  schemaVersion: 1, sessionId: 'sess-remote', historySessionId: null, providerType: 'claude-cli',
  providerSessionId: 'psid-current', producerDaemonId: 'daemon-remote', producerWriterId: 'w', producerEpoch: 'e',
  revision: 3, observedAt: '2026-09-02T00:00:00.000Z', status: 'idle', providerObservedStatus: 'idle', title: null,
  activeModal: null, activeInteractivePrompt: null, turn: null,
  provenance: { messageSource: 'native_history', transcriptProvenance: null },
  messages: [0, 1, 2, 3, 4, 5].map(msg),
  terminalMarkers: [],
  coverage: { mode: 'full', totalMessageCount: 6, returnedMessageCount: 6, omittedBefore: false },
};

function createRemoteCtx(meshId: string) {
  const liveCalls: Array<Record<string, unknown>> = [];
  const transport = new IpcTransport() as any;
  const mesh = {
    id: meshId, name: 'Replica PSID', repoIdentity: 'example/repo', policy: {}, coordinator: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-remote', workspace: '/tmp/remote-repo', repoRoot: '/tmp/remote-repo', daemonId: 'daemon-remote',
      machineId: 'machine-remote', userOverrides: {}, policy: { providerPriority: ['claude-cli'] },
      sessions: [{ id: 'sess-remote', providerType: 'claude-cli', status: 'idle' }],
    }],
  };
  transport.command = async (command: string, args: Record<string, unknown> = {}) => {
    if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'ensure_transcript_subscription') return { success: true, ready: true };
    if (command === 'read_transcript_replica') return { success: true, available: true, snapshot: SNAPSHOT, identity: { revision: 3 } };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_d: string, command: string, args: Record<string, unknown> = {}) => {
    if (command === 'read_chat') {
      liveCalls.push(args);
      return { success: true, status: 'idle', providerSessionId: args.providerSessionId, messages: [{ role: 'assistant', content: 'OLD_CONVERSATION' }] };
    }
    throw new Error(`unexpected relay command: ${command}`);
  };
  return { liveCalls, ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' } as any };
}

function cleanup(meshId: string) { __clearLocalRecordsForTests(meshId); __clearMeshPendingEventsForTests(meshId); }

test('an explicit provider_session_id the replica does not hold falls back to the live read (forwarded) with a warning', async () => {
  const meshId = 'mesh_replica_psid_mismatch';
  const { ctx, liveCalls } = createRemoteCtx(meshId);
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', provider_session_id: 'psid-old' }));
    assert.equal(liveCalls.length, 1, 'the live read_chat runs');
    assert.equal(liveCalls[0]!.providerSessionId, 'psid-old', 'and receives the requested provider session');
    assert.equal(parsed.transcriptFallbackReason, 'provider_session_mismatch');
    assert.match(String(parsed.providerSessionWarning), /psid-current.*psid-old/);
    assert.match(JSON.stringify(parsed), /OLD_CONVERSATION/);
  } finally { cleanup(meshId); }
});

test('a provider_session_id that matches the replica is served from the replica', async () => {
  const meshId = 'mesh_replica_psid_match';
  const { ctx, liveCalls } = createRemoteCtx(meshId);
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', provider_session_id: 'psid-current' }));
    assert.equal(liveCalls.length, 0);
    assert.equal(parsed.transcriptReadSource, 'replica');
  } finally { cleanup(meshId); }
});

test('compact:false honours tail on a replica-served read', async () => {
  const meshId = 'mesh_replica_full_tail';
  const { ctx } = createRemoteCtx(meshId);
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: false, tail: 2 }));
    assert.equal(parsed.messages.length, 2);
    assert.deepEqual(parsed.messages.map((m: any) => m.content), ['M4', 'M5']);
    assert.equal(parsed.tailOmittedMessageCount, 4);
  } finally { cleanup(meshId); }
});
