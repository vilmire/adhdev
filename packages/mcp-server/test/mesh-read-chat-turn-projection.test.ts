import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshReadChat } from '../src/tools/mesh-tools.js';
import { readChat } from '../src/tools/read-chat.js';
import { slimTurnPresentation, compactChatPayload } from '../src/tools/chat-compact.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// STAGE6-CANARY follow-up: the daemon's read_chat already attaches the
// authoritative Stage 6 turn projection (`turn` block), but the MCP slim
// (compact) response dropped it — mesh_read_chat showed no attemptId/turnStage
// while mesh_status and the dashboard snapshot showed them. compactChatPayload
// now carries the projection's non-content identity/stage fields
// (preserveTurn), keeping the slim payload bounded and content-free. The
// provider-FSM fallback (no daemon `turn` block) keeps the old contract: no
// turn/attemptId/turnStage keys at all.

const TURN_BLOCK = {
  authority: 'turn_reducer',
  status: 'idle',
  stage: 'completed',
  terminalOutcome: 'completed',
  terminalReason: 'provider_event',
  meshId: 'mesh_turn_parity',
  taskId: 'task-1',
  attemptId: 'attempt-uuid-1',
  attemptSeq: 1,
  sessionId: 'sess-local',
  nodeId: 'node-local',
  providerType: 'kimi',
  acceptedAt: '2026-07-27T16:21:46.392Z',
  deliveredAt: '2026-07-27T16:21:48.336Z',
  consumedAt: '2026-07-27T16:21:49.407Z',
  terminalAt: '2026-07-27T16:22:00.449Z',
  updatedAt: '2026-07-27T16:22:00.449Z',
  projectionAgeMs: 3128,
};

function cleanupMesh(meshId: string): void {
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
}

function createLocalCtx(meshId: string, readChatResult: unknown) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const mesh = {
    id: meshId,
    name: 'Turn Projection Parity',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-local',
      workspace: '/tmp/local-repo',
      repoRoot: '/tmp/local-repo',
      daemonId: 'daemon-local',
      machineId: 'machine-local',
      userOverrides: {},
      policy: { providerPriority: ['kimi'] },
      sessions: [{ id: 'sess-local', providerType: 'kimi', status: 'idle' }],
    }],
  };
  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'read_chat') return readChatResult;
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async () => {
    throw new Error('local node must not use meshCommand');
  };
  return { ctx: { mesh, transport, localDaemonId: 'daemon-local', localMachineId: 'machine-local' } as any };
}

const REDUCER_READ_CHAT = {
  success: true,
  status: 'idle',
  providerSessionId: null,
  turn: TURN_BLOCK,
  messages: [
    { role: 'user', content: 'reply with CANARY_K3_OK_2' },
    { role: 'assistant', content: 'CANARY_K3_OK_2' },
    { role: 'tool', kind: 'tool', content: 'internal tool chatter' },
  ],
};

test('mesh_read_chat slim carries attemptId/turnStage + turn block from the daemon projection', async () => {
  const meshId = 'mesh_turn_parity';
  cleanupMesh(meshId);
  const { ctx } = createLocalCtx(meshId, REDUCER_READ_CHAT);

  const out = await meshReadChat(ctx, { node_id: 'node-local', session_id: 'sess-local' });
  const parsed = JSON.parse(out);

  // Flat identity fields mirror the mesh_status slim naming.
  assert.equal(parsed.attemptId, 'attempt-uuid-1');
  assert.equal(parsed.turnStage, 'completed');
  // Projection authority/status/terminal outcome preserved.
  assert.equal(parsed.turn.authority, 'turn_reducer');
  assert.equal(parsed.turn.status, 'idle');
  assert.equal(parsed.turn.stage, 'completed');
  assert.equal(parsed.turn.terminalOutcome, 'completed');
  assert.equal(parsed.turn.terminalReason, 'provider_event');
  assert.equal(parsed.turn.taskId, 'task-1');
  assert.equal(parsed.turn.providerType, 'kimi');
  // Projected status stays equivalent to the daemon's projected status.
  assert.equal(parsed.status, 'idle');
  // Compact filtering unchanged: tool chatter removed, bounded tail kept.
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.filteredMessages, 1);
  assert.equal(parsed.summary, 'CANARY_K3_OK_2');

  cleanupMesh(meshId);
});

test('mesh_read_chat slim turn block is content-free (bounded scalar allowlist)', async () => {
  const meshId = 'mesh_turn_parity';
  cleanupMesh(meshId);
  const poisoned = {
    ...REDUCER_READ_CHAT,
    turn: { ...TURN_BLOCK, transcript: 'SECRET TRANSCRIPT', prompt: 'SECRET PROMPT' },
  };
  const { ctx } = createLocalCtx(meshId, poisoned);

  const out = await meshReadChat(ctx, { node_id: 'node-local', session_id: 'sess-local' });
  const parsed = JSON.parse(out);

  assert.equal(parsed.turn.transcript, undefined);
  assert.equal(parsed.turn.prompt, undefined);
  assert.equal(parsed.turn.projectionAgeMs, undefined, 'age gauges are read-time gauges, not identity');
  assert.doesNotMatch(out, /SECRET/);

  cleanupMesh(meshId);
});

test('provider-FSM fallback (no daemon turn block) keeps the legacy slim contract', async () => {
  const meshId = 'mesh_turn_parity_fallback';
  cleanupMesh(meshId);
  const fallbackResult = {
    success: true,
    status: 'generating',
    messages: [{ role: 'assistant', content: 'working on it' }],
  };
  const { ctx } = createLocalCtx(meshId, fallbackResult);

  const out = await meshReadChat(ctx, { node_id: 'node-local', session_id: 'sess-local' });
  const parsed = JSON.parse(out);

  assert.equal(parsed.status, 'generating', 'provider FSM status passes through unchanged');
  assert.equal(parsed.turn, undefined, 'no fabricated projection on fallback');
  assert.equal(parsed.attemptId, undefined);
  assert.equal(parsed.turnStage, undefined);

  cleanupMesh(meshId);
});

test('slimTurnPresentation returns null for non-object / empty turns', () => {
  assert.equal(slimTurnPresentation(null), null);
  assert.equal(slimTurnPresentation(undefined), null);
  assert.equal(slimTurnPresentation('completed'), null);
  assert.equal(slimTurnPresentation({}), null);
  assert.equal(slimTurnPresentation([1, 2]), null);
});

test('compactChatPayload without preserveTurn keeps the legacy shape (magi/review paths unchanged)', () => {
  const compact = compactChatPayload(REDUCER_READ_CHAT, { sessionId: 'sess-local', limit: 10 });
  assert.equal(compact.turn, undefined);
  assert.equal(compact.attemptId, undefined);
  assert.equal(compact.turnStage, undefined);
  assert.equal(compact.status, 'idle');
});

test('local read_chat (json+compact) carries the same projection identity as the daemon', async () => {
  const transport = {
    command: async (command: string) => {
      if (command === 'read_chat') return REDUCER_READ_CHAT;
      throw new Error(`unexpected command: ${command}`);
    },
  } as any;

  const out = await readChat(transport, { session_id: 'sess-local', format: 'json', compact: true });
  const parsed = JSON.parse(out);

  assert.equal(parsed.attemptId, 'attempt-uuid-1');
  assert.equal(parsed.turnStage, 'completed');
  assert.equal(parsed.turn.authority, 'turn_reducer');
  assert.equal(parsed.status, 'idle', 'local and daemon read_chat projected status stay equivalent');
});

test('local read_chat fallback session omits turn fields consistently', async () => {
  const transport = {
    command: async () => ({
      success: true,
      status: 'generating',
      messages: [{ role: 'assistant', content: 'thinking' }],
    }),
  } as any;

  const out = await readChat(transport, { session_id: 'sess-local', format: 'json', compact: true });
  const parsed = JSON.parse(out);

  assert.equal(parsed.status, 'generating');
  assert.equal(parsed.turn, undefined);
  assert.equal(parsed.attemptId, undefined);
  assert.equal(parsed.turnStage, undefined);
});
