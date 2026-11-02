/**
 * mesh_read_chat must not silently return fewer messages than asked.
 *
 * The transcript replica holds only the newest bubbles (`omittedBefore`). A
 * request that needs more than the replica holds used to be answered from it
 * anyway - at most the window, no live read, no hint. Now: decline the replica
 * and read live; when the live read cannot reach the node, return the replica's
 * window with an explicit `truncated` note. A replica that reaches the start of
 * the chat is complete and still answers directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshReadChat } from '../src/tools/mesh-tools.js';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

function msg(i: number) {
  return { messageId: `d.t.${i}`, ord: `a${String(i).padStart(4, '0')}`, rev: 1, expandable: false, srcId: null, role: i % 2 ? 'assistant' : 'user', kind: 'standard', content: `M${i}`, receivedAt: i, timestamp: i, turnKey: `t${i}`, bubbleState: 'final', senderName: null, toolName: null, streaming: null };
}

function snapshot(count: number, omittedBefore: boolean) {
  return {
    schemaVersion: 2, sessionId: 'sess-remote', historySessionId: null, providerType: 'claude-cli',
    providerSessionId: 'psid-1', producerDaemonId: 'daemon-remote', producerWriterId: 'w', epoch: 'e',
    frame: 3, observedAt: '2026-11-01T00:00:00.000Z', status: 'idle', providerObservedStatus: 'idle', title: null,
    activeModal: null, activeInteractivePrompt: null, turn: null,
    provenance: { messageSource: 'native_history', transcriptProvenance: null },
    messages: Array.from({ length: count }, (_, i) => msg(i)),
    terminalMarkers: [],
    coverage: { mode: 'full', totalMessageCount: count, returnedMessageCount: count, omittedBefore },
  };
}

function createCtx(meshId: string, view: unknown, live: 'ok' | 'p2p-down') {
  const liveCalls: Array<Record<string, unknown>> = [];
  const transport = new IpcTransport() as any;
  const mesh = {
    id: meshId, name: 'Replica window', repoIdentity: 'example/repo', policy: {}, coordinator: {},
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
    if (command === 'read_transcript_replica') return { success: true, available: true, view, identity: { frame: 3 } };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_d: string, command: string, args: Record<string, unknown> = {}) => {
    if (command !== 'read_chat') throw new Error(`unexpected relay command: ${command}`);
    liveCalls.push(args);
    if (live === 'p2p-down') throw new Error('P2P relay timeout: no response');
    const tail = Number(args.tailLimit);
    return { success: true, status: 'idle', providerSessionId: 'psid-1', messages: Array.from({ length: tail }, (_, i) => ({ role: 'assistant', content: `LIVE${i}` })) };
  };
  return { liveCalls, ctx: { mesh, transport, localDaemonId: 'daemon-coordinator', localMachineId: 'machine-coordinator' } as any };
}

function cleanup(meshId: string) { __clearLocalRecordsForTests(meshId); __clearMeshPendingEventsForTests(meshId); }

test('compact:false tail beyond what a truncated replica holds reads live', async () => {
  const meshId = 'mesh_replica_window_live';
  const { ctx, liveCalls } = createCtx(meshId, snapshot(200, true), 'ok');
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: false, tail: 500 }));
    assert.equal(liveCalls.length, 1, 'the replica declined and the live read ran');
    assert.equal(liveCalls[0]!.tailLimit, 500);
    assert.equal(parsed.transcriptFallbackReason, 'replica_window_too_small');
    assert.equal(parsed.messages.length, 500);
    assert.equal(parsed.truncated, undefined);
  } finally { cleanup(meshId); }
});

test('with the live read unreachable the replica window is returned and flagged truncated', async () => {
  const meshId = 'mesh_replica_window_down';
  const { ctx, liveCalls } = createCtx(meshId, snapshot(200, true), 'p2p-down');
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: false, tail: 500 }));
    assert.equal(liveCalls.length, 1);
    assert.equal(parsed.transcriptReadSource, 'replica');
    assert.equal(parsed.messages.length, 200);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.requestedTail, 500);
    assert.equal(parsed.returnedMessages, 200);
    assert.equal(parsed.omittedBefore, true);
    assert.equal(parsed.totalMessagesIsLowerBound, true);
    assert.match(String(parsed.truncatedReason), /live read was unavailable/);
  } finally { cleanup(meshId); }
});

test('a replica that holds enough still answers directly even though it omits older history', async () => {
  const meshId = 'mesh_replica_window_enough';
  const { ctx, liveCalls } = createCtx(meshId, snapshot(200, true), 'ok');
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: false, tail: 50 }));
    assert.equal(liveCalls.length, 0);
    assert.equal(parsed.transcriptReadSource, 'replica');
    assert.equal(parsed.messages.length, 50);
    assert.equal(parsed.truncated, undefined, 'asked 50, got 50: not truncated');
    assert.equal(parsed.totalMessagesIsLowerBound, true, 'but its total is a window count, not the chat');
  } finally { cleanup(meshId); }
});

test('a replica that reaches the start of the chat answers any tail without a live read', async () => {
  const meshId = 'mesh_replica_window_complete';
  const { ctx, liveCalls } = createCtx(meshId, snapshot(40, false), 'ok');
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', compact: false, tail: 500 }));
    assert.equal(liveCalls.length, 0);
    assert.equal(parsed.messages.length, 40);
    assert.equal(parsed.truncated, undefined);
    assert.equal(parsed.totalMessagesIsLowerBound, undefined);
  } finally { cleanup(meshId); }
});

test('compact reads (tail capped at 10) keep being served from a truncated replica', async () => {
  const meshId = 'mesh_replica_window_compact';
  const { ctx, liveCalls } = createCtx(meshId, snapshot(200, true), 'ok');
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote', tail: 50 }));
    assert.equal(liveCalls.length, 0);
    assert.equal(parsed.transcriptReadSource, 'replica');
    assert.equal(parsed.totalMessagesIsLowerBound, true);
    assert.equal(parsed.truncated, undefined);
  } finally { cleanup(meshId); }
});

test('a replica window with fewer prose messages than a compact read needs reads live', async () => {
  const meshId = 'mesh_replica_window_thin';
  const { ctx, liveCalls } = createCtx(meshId, snapshot(4, true), 'ok');
  try {
    await meshReadChat(ctx, { node_id: 'node-remote', session_id: 'sess-remote' });
    assert.equal(liveCalls.length, 1, 'default tail 10 > 4 held, and older messages exist');
  } finally { cleanup(meshId); }
});
