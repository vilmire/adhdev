/**
 * Remote-node relay is a transport CAPABILITY (transports/mode.ts), not the
 * IpcTransport class. A standalone coordinator (LocalTransport → the standalone
 * daemon's HTTP API) used to fail every `instanceof IpcTransport` gate, so a
 * remote member's launch / read_chat / targeted send / git verb ran on the HOST
 * — and `mesh_read_chat` of a member session returned the host's empty answer
 * (live standalone multi-machine test, 2026-10-07).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { LocalTransport } from '../src/transports/local.js';
import { supportsMeshRelay } from '../src/transports/mode.js';
import { commandForNode } from '../src/tools/mesh-tools-internal.js';
import { meshReadChat } from '../src/tools/mesh-tools.js';
import { normalizeCommandEnvelope } from '../../daemon-standalone/src/standalone-command-envelope.js';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

test('both daemon transports relay; a bare command-only object does not', () => {
  assert.equal(supportsMeshRelay(new IpcTransport()), true);
  assert.equal(supportsMeshRelay(new LocalTransport({ port: 3847 })), true);
  // Prototype-built doubles (the suite's IPC fakes) keep the capability.
  assert.equal(supportsMeshRelay(Object.create(IpcTransport.prototype)), true);
  assert.equal(supportsMeshRelay(Object.create(LocalTransport.prototype)), true);
  assert.equal(supportsMeshRelay({ command: async () => ({}) }), false);
  assert.equal(supportsMeshRelay({ supportsMeshRelay: true }), false);
  assert.equal(supportsMeshRelay(null), false);
});

test('LocalTransport.meshCommand posts mesh_relay_command through the standalone envelope intact', async () => {
  let sentBody: any = null;
  let sentUrl = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    sentUrl = String(url);
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ success: true, ranOn: 'member' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  let result: any;
  try {
    result = await new LocalTransport({ port: 3999 }).meshCommand('standalone_mach_member', 'git_status', { workspace: '/m', id: 'keep' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sentUrl, 'http://localhost:3999/api/v1/command');
  const { type, payload } = normalizeCommandEnvelope(sentBody);
  assert.equal(type, 'mesh_relay_command');
  assert.deepEqual(payload, { targetDaemonId: 'standalone_mach_member', command: 'git_status', args: { workspace: '/m', id: 'keep' } });
  assert.deepEqual(result, { success: true, ranOn: 'member' });
});

function standaloneCtx(meshId: string, opts: { liveReadChat?: any } = {}) {
  const calls: string[] = [];
  const transport = new LocalTransport({ port: 3999 }) as LocalTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const mesh = {
    id: meshId,
    name: 'Standalone relay',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: { preferredNodeId: 'node-host' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'node-host', workspace: '/tmp/sa-relay-host', repoRoot: '/tmp/sa-relay-host', daemonId: 'standalone_mach_host', userOverrides: {}, policy: {} },
      {
        id: 'node-member', workspace: '/tmp/sa-relay-member-not-here', repoRoot: '/tmp/sa-relay-member-not-here', daemonId: 'standalone_mach_member',
        userOverrides: {}, policy: { providerPriority: ['claude-cli'] },
        sessions: [{ id: 'sess-member', providerType: 'claude-cli', status: 'idle' }],
      },
    ],
  };
  // Every wire call — including LocalTransport.meshCommand's own
  // `this.command('mesh_relay_command', …)` — lands here.
  transport.command = async (command, args: Record<string, unknown> = {}) => {
    if (isTurnIpcCommand(command)) return answerTurnIpc(command, args);
    if (command === 'mesh_relay_command') {
      const relayed = String(args.command);
      calls.push(`relay:${relayed}@${String(args.targetDaemonId)}`);
      if (relayed === 'read_chat') return opts.liveReadChat ?? { success: true, status: 'idle', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'MEMBER_ANSWER' }] };
      return { success: true, answeredBy: args.targetDaemonId, command: relayed };
    }
    calls.push(`local:${command}`);
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'ensure_transcript_subscription') return { success: true, ready: false, reason: 'ipc_unavailable' };
    if (command === 'read_transcript_replica') return { success: true, available: false, reason: 'no_subscription' };
    // The bug: the HOST answering a member session's read_chat with nothing.
    if (command === 'read_chat') return { success: true, status: 'idle', messages: [] };
    return { success: true, answeredBy: 'host', command };
  };
  return { calls, ctx: { mesh, transport, localDaemonId: 'standalone_mach_host', localMachineId: 'mach_host' } as any };
}

function cleanup(meshId: string): void {
  __clearLocalRecordsForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
}

test('commandForNode relays a remote node over a LocalTransport and keeps a local node bare', async () => {
  const meshId = 'mesh_sa_relay_cmd';
  const { ctx, calls } = standaloneCtx(meshId);
  try {
    const [hostNode, memberNode] = ctx.mesh.nodes;
    const remote = await commandForNode(ctx, memberNode, 'git_status', { workspace: memberNode.workspace });
    assert.deepEqual(remote, { success: true, answeredBy: 'standalone_mach_member', command: 'git_status' });
    const local = await commandForNode(ctx, hostNode, 'git_status', { workspace: hostNode.workspace });
    assert.equal(local.answeredBy, 'host');
    assert.ok(calls.includes('relay:git_status@standalone_mach_member'), calls.join(','));
    assert.ok(calls.includes('local:git_status'), calls.join(','));
  } finally {
    cleanup(meshId);
  }
});

test('mesh_read_chat of a member session reads the MEMBER (replica first, then the relayed read_chat)', async () => {
  const meshId = 'mesh_sa_relay_read';
  const { ctx, calls } = standaloneCtx(meshId);
  try {
    const parsed = JSON.parse(await meshReadChat(ctx, { node_id: 'node-member', session_id: 'sess-member' }));
    assert.equal(parsed.summary, 'MEMBER_ANSWER', JSON.stringify(parsed));
    assert.equal(parsed.transcriptReadSource, 'legacy_read_chat');
    assert.equal(parsed.transcriptFallbackReason, 'ipc_unavailable');
    // The replica hop runs on the coordinator daemon, the live read on the member.
    assert.ok(calls.includes('local:ensure_transcript_subscription'), calls.join(','));
    assert.ok(calls.includes('relay:read_chat@standalone_mach_member'), calls.join(','));
    assert.ok(!calls.includes('local:read_chat'), `the host must not answer a member session: ${calls.join(',')}`);
  } finally {
    cleanup(meshId);
  }
});
