/**
 * §8 unit 6 — `mesh_read_chat` remote display cutover.
 *
 * Pins the three things the design's acceptance list names for this consumer:
 *   1. fixed fallback order `replica → live P2P read_chat → cached summary`
 *   2. compact/full parity (both branches over ONE renderer, ONE payload shape)
 *   3. unchanged local `read_chat` / provider-scope / cached-summary semantics
 *
 * The `mesh-read-chat-cache-fallback` and `mesh-read-chat-turn-projection`
 * suites already cover hops 2 and 3 in isolation; this file covers the hop the
 * cutover ADDS and, critically, that adding it did not move the others.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshReadChat } from '../src/tools/mesh-tools.js';
import { readTranscriptReplicaForDisplay } from '../src/tools/mesh-transcript-replica-read.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

const SNAPSHOT = {
  schemaVersion: 1,
  sessionId: 'sess-remote',
  historySessionId: null,
  providerType: 'claude-cli',
  providerSessionId: 'psid-1',
  producerDaemonId: 'daemon-remote',
  producerWriterId: 'writer-1',
  producerEpoch: 'epoch-1',
  revision: 12,
  observedAt: '2026-09-02T00:00:00.000Z',
  status: 'idle',
  providerObservedStatus: 'idle',
  title: null,
  activeModal: null,
  activeInteractivePrompt: null,
  turn: null,
  provenance: { messageSource: 'native_history', transcriptProvenance: null },
  messages: [
    { role: 'user', kind: 'standard', content: 'run the tests', receivedAt: 1, timestamp: 1, turnKey: 't1', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
    { role: 'assistant', kind: 'standard', content: 'REPLICA_ANSWER', receivedAt: 2, timestamp: 2, turnKey: 't2', bubbleState: 'final', senderName: null, toolName: null, streaming: null },
  ],
  terminalMarkers: [],
  coverage: { mode: 'full', totalMessageCount: 2, returnedMessageCount: 2, omittedBefore: false },
};

const LIVE_READ_CHAT = {
  success: true,
  status: 'idle',
  providerSessionId: 'psid-1',
  messages: [
    { role: 'user', content: 'run the tests' },
    { role: 'assistant', content: 'LIVE_ANSWER' },
  ],
};

function cleanupMesh(meshId: string): void {
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
}

/**
 * A REMOTE node (daemonId !== localDaemonId) — the only shape the replica hop
 * runs for. `replicaAnswers` controls whether the coordinator daemon's
 * `read_transcript_replica` can serve, so one helper drives every hop.
 */
function createRemoteCtx(
  meshId: string,
  opts: { replicaAnswers: boolean; ensureReady?: boolean; liveThrows?: Error; readReplicaThrows?: boolean } = { replicaAnswers: false },
) {
  const calls: string[] = [];
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const mesh = {
    id: meshId,
    name: 'Replica Cutover',
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
      policy: { providerPriority: ['claude-cli'] },
      sessions: [{ id: 'sess-remote', providerType: 'claude-cli', status: 'idle' }],
    }],
  };
  transport.command = async (command) => {
    calls.push(`local:${command}`);
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'ensure_transcript_subscription') {
      return opts.ensureReady === false || (!opts.replicaAnswers && opts.ensureReady === undefined)
        ? { success: true, ready: false, reason: 'ipc_unavailable' }
        : { success: true, ready: true };
    }
    if (command === 'read_transcript_replica') {
      if (opts.readReplicaThrows) throw new Error('ipc down');
      return opts.replicaAnswers
        ? { success: true, available: true, snapshot: SNAPSHOT, identity: { revision: 12 } }
        : { success: true, available: false, reason: 'no_subscription' };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command) => {
    calls.push(`relay:${command}`);
    if (command === 'read_chat') {
      if (opts.liveThrows) throw opts.liveThrows;
      return LIVE_READ_CHAT;
    }
    if (command === 'get_pending_mesh_events') return { events: [] };
    throw new Error(`unexpected relay command: ${command}`);
  };
  return {
    calls,
    ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' } as any,
  };
}

// ── hop 1: the replica answers ────────────────────────────────────────────────

test('mesh_read_chat serves from the replica and never issues the live P2P read_chat', async () => {
  const meshId = 'mesh_replica_hit';
  const { ctx, calls } = createRemoteCtx(meshId, { replicaAnswers: true });
  try {
    const raw = await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' });
    const parsed = JSON.parse(raw);

    assert.equal(parsed.transcriptReadSource, 'replica');
    assert.equal(parsed.summary, 'REPLICA_ANSWER');
    assert.equal(parsed.compact, true);
    // The whole point of the cutover: no per-read P2P round trip.
    assert.ok(!calls.includes('relay:read_chat'), `live read_chat must not run; calls=${calls.join(',')}`);
    assert.ok(calls.includes('local:read_transcript_replica'));
    // The subscription is ensured on the COORDINATOR daemon (local), never relayed.
    assert.ok(calls.includes('local:ensure_transcript_subscription'));
    assert.ok(!calls.some((c) => c === 'relay:ensure_transcript_subscription'));
  } finally {
    cleanupMesh(meshId);
  }
});

test('compact/full parity: both branches render the SAME replica payload', async () => {
  const meshId = 'mesh_replica_parity';
  const { ctx } = createRemoteCtx(meshId, { replicaAnswers: true });
  try {
    const compact = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: true }));
    const full = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: false }));

    // Both label their source identically — a divergence here would mean one
    // branch silently took a different hop.
    assert.equal(compact.transcriptReadSource, 'replica');
    assert.equal(full.transcriptReadSource, 'replica');
    // Same status/identity on both; full additionally keeps the untailed count
    // and the replica revision, compact keeps the lifted summary.
    assert.equal(compact.status, full.status);
    assert.equal(full.totalMessages, 2);
    assert.equal(full.replicaRevision, 12);
    assert.equal(compact.summary, 'REPLICA_ANSWER');
    // The full branch keeps every message; compact lifts the final assistant
    // bubble into `summary` and blanks its duplicate body (existing contract).
    assert.equal(full.messages.length, 2);
    assert.equal(full.messages[1].content, 'REPLICA_ANSWER');
  } finally {
    cleanupMesh(meshId);
  }
});

// ── hop 2: replica declines → live P2P read_chat, with the reason recorded ────

test('replica miss falls through to the live P2P read_chat and stamps the fallback reason', async () => {
  const meshId = 'mesh_replica_miss';
  const { ctx, calls } = createRemoteCtx(meshId, { replicaAnswers: false });
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' }));

    assert.equal(parsed.summary, 'LIVE_ANSWER');
    assert.equal(parsed.transcriptReadSource, 'legacy_read_chat');
    assert.equal(parsed.transcriptFallbackReason, 'ipc_unavailable');
    assert.ok(calls.includes('relay:read_chat'));
  } finally {
    cleanupMesh(meshId);
  }
});

test('a throwing replica IPC is not fatal — the live read still serves the transcript', async () => {
  const meshId = 'mesh_replica_throw';
  const { ctx } = createRemoteCtx(meshId, { replicaAnswers: false, ensureReady: true, readReplicaThrows: true });
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' }));
    assert.equal(parsed.summary, 'LIVE_ANSWER');
    assert.equal(parsed.transcriptReadSource, 'legacy_read_chat');
    assert.equal(parsed.transcriptFallbackReason, 'ipc_unavailable');
  } finally {
    cleanupMesh(meshId);
  }
});

// ── hop 3: replica miss + live transport failure → cached summary (unchanged) ─

test('fallback order is fixed: replica miss + P2P transport failure still reaches the cached summary', async () => {
  const meshId = 'mesh_replica_then_cache';
  const transportError: any = new Error('P2P connection timeout');
  transportError.code = 'P2P_TIMEOUT';
  const { ctx } = createRemoteCtx(meshId, { replicaAnswers: false, liveThrows: transportError });
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' }));
    // The cached-summary fallback's own contract is unchanged by this unit —
    // it still reports itself as a degraded, non-full-transcript answer.
    assert.notEqual(parsed.transcriptReadSource, 'replica');
    assert.ok(JSON.stringify(parsed).includes('fallback') || parsed.success === false,
      `expected a degraded cached-summary answer, got ${JSON.stringify(parsed).slice(0, 300)}`);
  } finally {
    cleanupMesh(meshId);
  }
});

// ── local node: the replica hop must not run at all ──────────────────────────

test('a LOCAL node never attempts the replica hop — local read_chat semantics unchanged', async () => {
  const meshId = 'mesh_replica_local';
  const calls: string[] = [];
  const transport = new IpcTransport() as any;
  const mesh = {
    id: meshId,
    name: 'Local',
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
      sessions: [{ id: 'sess-local', providerType: 'claude-cli', status: 'idle' }],
    }],
  };
  transport.command = async (command: string) => {
    calls.push(command);
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'read_chat') return LIVE_READ_CHAT;
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => { throw new Error('local node must not relay'); };
  const ctx = { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' } as any;
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-local', session_id: 'sess-local' }));
    assert.equal(parsed.summary, 'LIVE_ANSWER');
    assert.ok(!calls.includes('read_transcript_replica'), `calls=${calls.join(',')}`);
    assert.ok(!calls.includes('ensure_transcript_subscription'));
    // No source telemetry either — the hop was never attempted, so there is no
    // fallback to report (an unconditional label would misreport local reads).
    assert.equal(parsed.transcriptReadSource, undefined);
    assert.equal(parsed.transcriptFallbackReason, undefined);
  } finally {
    cleanupMesh(meshId);
  }
});

// ── the replica hop's own guards ─────────────────────────────────────────────

test('readTranscriptReplicaForDisplay refuses a structurally invalid snapshot rather than rendering it', async () => {
  const transport = {
    async command(type: string) {
      if (type === 'ensure_transcript_subscription') return { success: true, ready: true };
      // schemaVersion 1 but `messages` missing — a projection regression.
      const { messages, ...broken } = SNAPSHOT as any;
      return { success: true, available: true, snapshot: broken };
    },
  };
  const outcome = await readTranscriptReplicaForDisplay(transport, { ownerDaemonId: 'd', rawSessionId: 's' });
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'revision_invalid');
});

test('readTranscriptReplicaForDisplay requires both key parts', async () => {
  const transport = { async command() { throw new Error('must not be called'); } };
  const outcome = await readTranscriptReplicaForDisplay(transport, { ownerDaemonId: '', rawSessionId: 's' });
  assert.equal(outcome.payload, null);
  assert.equal(outcome.fallbackReason, 'no_node');
});
