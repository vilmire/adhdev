import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_MESH_TOOLS, MESH_NOTIFY_WORKER_TOOL, meshNotifyWorker } from '../src/tools/mesh-tools.js';
import { rejectUnknownMeshToolArgs } from '../src/tools/validate-tool-args.js';
import { ALL_WORKER_TOOLS, drainMailbox, peerContextPull } from '../src/tools/worker-tools.js';

// ─── E-T0: byte-identical publication when the gate is off ────────────────

test('mesh_notify_worker is NOT in ALL_MESH_TOOLS — server.ts publishes it only when the flag is on', () => {
  assert.ok(!ALL_MESH_TOOLS.some(t => t.name === 'mesh_notify_worker'));
  assert.equal(MESH_NOTIFY_WORKER_TOOL.name, 'mesh_notify_worker');
});

test('mesh_notify_worker still validates its args even though it is unpublished (alias-map registration)', () => {
  const error = rejectUnknownMeshToolArgs('mesh_notify_worker', { node_id: 'n', task_id: 't', bogus_key: 1 });
  assert.ok(error);
  assert.match(error, /bogus_key/);

  const ok = rejectUnknownMeshToolArgs('mesh_notify_worker', { node_id: 'n', task_id: 't', message: 'hi' });
  assert.equal(ok, null);
});

// ─── D: peer_context_pull toolset shape ────────────────────────────────────

test('peer_context_pull is a worker tool and takes no task id (attribution stays token-derived)', () => {
  const names = ALL_WORKER_TOOLS.map(t => t.name);
  assert.ok(names.includes('peer_context_pull'));
  const tool = ALL_WORKER_TOOLS.find(t => t.name === 'peer_context_pull')!;
  const props = Object.keys(tool.inputSchema.properties ?? {});
  for (const forbidden of ['task_id', 'taskId', 'attempt_id', 'attemptId', 'session_id', 'sessionId']) {
    assert.ok(!props.includes(forbidden), `peer_context_pull must not accept ${forbidden}`);
  }
});

// ─── meshNotifyWorker: routes to the target node via the mesh RPC layer ───

function fakeTransport(reply: any, capture?: { command?: string; args?: any }) {
  return {
    async command(command: string, args: any) {
      if (capture) { capture.command = command; capture.args = args; }
      return reply;
    },
    async ping() { return true; },
  } as any;
}

function fakeMeshCtx(nodeId: string, transport: any) {
  return {
    mesh: {
      id: 'mesh_1',
      name: 'Test Mesh',
      nodes: [{ id: nodeId, workspace: '/tmp/repo', repoRoot: '/tmp/repo' }],
    },
    transport,
  } as any;
}

test('meshNotifyWorker rejects missing required fields before touching the transport', async () => {
  const capture: { command?: string } = {};
  const result = JSON.parse(await meshNotifyWorker(fakeMeshCtx('node-1', fakeTransport({}, capture)), { node_id: 'node-1' }));
  assert.equal(result.success, false);
  assert.equal(result.error, 'invalid_input');
  assert.equal(capture.command, undefined);
});

test('meshNotifyWorker reports node_not_found for an unknown node id', async () => {
  const result = JSON.parse(await meshNotifyWorker(fakeMeshCtx('node-1', fakeTransport({})), {
    node_id: 'node-does-not-exist', task_id: 't1', message: 'hi',
  }));
  assert.equal(result.success, false);
  assert.equal(result.error, 'node_not_found');
});

test('meshNotifyWorker deposits via deposit_worker_mailbox routed through the target node', async () => {
  const capture: { command?: string; args?: any } = {};
  const transport = fakeTransport({ success: true, messageId: 'msg1', pending: 1 }, capture);
  const result = JSON.parse(await meshNotifyWorker(fakeMeshCtx('node-1', transport), {
    node_id: 'node-1', task_id: 't1', message: 'stop the refactor, spec changed',
  }));
  assert.equal(capture.command, 'deposit_worker_mailbox');
  assert.deepEqual(capture.args, { meshId: 'mesh_1', taskId: 't1', text: 'stop the refactor, spec changed' });
  assert.equal(result.success, true);
  assert.equal(result.messageId, 'msg1');
  assert.match(result.note, /next MCP tool response/);
});

test('meshNotifyWorker relays a daemon-side refusal (e.g. flag off, or task not known locally) verbatim', async () => {
  const transport = fakeTransport({ success: false, error: 'task_not_found_locally', detail: 'no local queue row' });
  const result = JSON.parse(await meshNotifyWorker(fakeMeshCtx('node-1', transport), {
    node_id: 'node-1', task_id: 't1', message: 'hi',
  }));
  assert.equal(result.success, false);
  assert.equal(result.error, 'task_not_found_locally');
  assert.equal(result.detail, 'no local queue row');
});

// ─── E-T0: the piggyback helper (drainMailbox), which server.ts's worker
// mode wraps EVERY tool response with ───────────────────────────────────────

test('drainMailbox renders pending messages and never throws on a bad transport', async () => {
  const withMessages = await drainMailbox(fakeTransport({
    success: true,
    messages: [{ id: 'm1', text: 'stop and wait for review' }, { id: 'm2', text: 'also check the tests' }],
  }), { bind: 'wsb_x' });
  assert.match(withMessages!, /Urgent messages from the coordinator/);
  assert.match(withMessages!, /1\. stop and wait for review/);
  assert.match(withMessages!, /2\. also check the tests/);

  const empty = await drainMailbox(fakeTransport({ success: true, messages: [] }), { bind: 'wsb_x' });
  assert.equal(empty, null);

  const refused = await drainMailbox(fakeTransport({ success: false, error: 'unauthenticated' }), { bind: 'wsb_x' });
  assert.equal(refused, null);

  const throwing = {
    async command() { throw new Error('transport down'); },
    async ping() { return true; },
  } as any;
  const survived = await drainMailbox(throwing, { bind: 'wsb_x' });
  assert.equal(survived, null);
});

// ─── D: peerContextPull wire shape ──────────────────────────────────────────

test('peerContextPull renders peers and surfaces a refusal with its hint', async () => {
  const ok = await peerContextPull(fakeTransport({
    success: true,
    meshId: 'mesh_1',
    scope: 'mesh',
    peers: [{ taskId: 't2', status: 'completed' }],
  }), { bind: 'wsb_x' }, {});
  assert.equal(ok.isError, undefined);
  assert.match(ok.text, /1 sibling task\(s\)/);

  const refused = await peerContextPull(fakeTransport({ success: false, error: 'unauthenticated', hint: 'No live task is bound.' }), { bind: 'wsb_x' }, {});
  assert.equal(refused.isError, true);
  assert.match(refused.text, /unauthenticated/);
  assert.match(refused.text, /No live task is bound/);
});
