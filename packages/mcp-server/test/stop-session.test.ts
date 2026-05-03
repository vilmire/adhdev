import assert from 'node:assert/strict';
import test from 'node:test';

import { stopSession } from '../src/tools/stop-session.js';

test('stopSession local mode resolves type from session status when omitted', async () => {
  const commands: Array<{ type: string; args: Record<string, unknown> }> = [];
  const localTransport = {
    async getStatus() {
      return {
        sessions: [
          { id: 'session-1', providerType: 'hermes-cli' },
        ],
      };
    },
    async command(type: string, args: Record<string, unknown>) {
      commands.push({ type, args });
      return { success: true };
    },
  } as any;

  const output = await stopSession(localTransport, { session_id: 'session-1' });

  assert.equal(output, 'Session session-1 stopped.');
  assert.deepEqual(commands, [
    {
      type: 'stop_cli',
      args: { targetSessionId: 'session-1', cliType: 'hermes-cli' },
    },
  ]);
});

test('stopSession local mode surfaces explicit type resolution errors', async () => {
  const localTransport = {
    async getStatus() {
      return { sessions: [] };
    },
    async command() {
      throw new Error('command should not be called without a resolved type');
    },
  } as any;

  const output = await stopSession(localTransport, { session_id: 'missing-session' });

  assert.equal(
    output,
    'Error: could not resolve session type for missing-session. Pass type= explicitly.',
  );
});

test('stopSession cloud mode sends session id and omits unresolved type', async () => {
  const calls: Array<{ daemonId: string; opts: Record<string, unknown> }> = [];
  const cloudTransport = {
    async getStatus() {
      throw new Error('cloud getStatus(targetId) must not be used for stop_session');
    },
    async stop(daemonId: string, opts: Record<string, unknown>) {
      calls.push({ daemonId, opts });
      return { success: true };
    },
  } as any;

  const output = await stopSession(cloudTransport, {
    daemon_id: 'daemon-cloud-1',
    session_id: 'session-1',
  });

  assert.equal(output, 'Session session-1 stopped.');
  assert.deepEqual(calls, [
    { daemonId: 'daemon-cloud-1', opts: { id: 'session-1' } },
  ]);
});
