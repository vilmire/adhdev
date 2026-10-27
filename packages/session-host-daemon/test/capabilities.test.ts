import './setup-env.js';
import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_HOST_SUPPORTED_REQUEST_TYPES } from '@adhdev/session-host-core'
import { SessionHostServer } from '../src/server.js'

test('advertises delete_session as a supported request type for cleanup compatibility probes', async () => {
  const server = new SessionHostServer({ appName: `adhdev-capabilities-${process.pid}` })

  const response = await server.handleRequest({
    type: 'get_host_diagnostics',
    payload: { includeSessions: false },
  })

  assert.equal(response.success, true)
  assert.ok((response.result as any).supportedRequestTypes.includes('delete_session'))
  assert.deepEqual((response.result as any).supportedRequestTypes, [...SESSION_HOST_SUPPORTED_REQUEST_TYPES])
})


test('advertises guarded attach and rejects a stale pin before granting a socket subscription or registry capability', async () => {
  const server = new SessionHostServer({ appName: `adhdev-guarded-attach-${process.pid}` }) as any;
  const initial = server.registry.createSession({ sessionId: 'retained', providerType: 'test', category: 'cli', workspace: '/fixture',
    launchCommand: { command: 'fixture', args: [] }, clientId: 'replacement-writer', clientType: 'daemon' });
  server.registry.restoreSession({ ...initial, startedAt: 456, lifecycle: 'running' });
  server.registry.acquireWrite({ sessionId: 'retained', clientId: 'replacement-writer', ownerType: 'agent', force: false });
  const before = server.registry.getSession('retained');
  const diagnostics = await server.handleRequest({ type: 'get_host_diagnostics', payload: { includeSessions: false } });
  assert.ok(diagnostics.result.supportedRequestTypes.includes('attach_session_if_incarnation'));
  const replies: any[] = [];
  const socket = { destroyed: false, writable: true, write: (data: string) => { replies.push(JSON.parse(data)); } };
  await server.handleIncomingRequest(socket, { kind: 'request', requestId: 'stale-pin', request: {
    type: 'attach_session_if_incarnation', payload: { sessionId: 'retained', clientId: 'stale-daemon', clientType: 'daemon',
      expectedIncarnation: { sessionId: 'retained', runtimeKey: initial.runtimeKey, startedAt: 123 } },
  } });
  assert.equal(replies[0].response.success, false);
  assert.match(replies[0].response.error, /incarnation changed/);
  assert.equal(server.socketSessions.has(socket), false);
  assert.deepEqual(server.registry.getSession('retained'), before);
  // A successful guarded attach subscribes only after the atomic comparison.
  server.schedulePersist = () => {};
  await server.handleIncomingRequest(socket, { kind: 'request', requestId: 'valid-pin', request: {
    type: 'attach_session_if_incarnation', payload: { sessionId: 'retained', clientId: 'replacement-writer', clientType: 'daemon',
      expectedIncarnation: { sessionId: 'retained', runtimeKey: initial.runtimeKey, startedAt: 456 } },
  } });
  assert.equal(replies[1].response.success, true);
  assert.equal(server.socketSessions.get(socket)?.has('retained'), true);
  assert.equal(server.registry.getSession('retained').writeOwner.clientId, 'replacement-writer');
});
