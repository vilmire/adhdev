import assert from 'node:assert/strict';
import test from 'node:test';

import { checkPending } from '../src/tools/check-pending.js';
import { listDaemons } from '../src/tools/list-daemons.js';
import { listSessions } from '../src/tools/list-sessions.js';

test('listDaemons uses cloud daemon list even though CloudTransport also exposes getStatus()', async () => {
  const calls: string[] = [];
  const cloudTransport = {
    async listDaemons() {
      calls.push('listDaemons');
      return {
        daemons: [
          {
            id: 'daemon-cloud-1',
            hostname: 'cloud-host',
            platform: 'darwin',
            p2p: { available: true },
          },
        ],
      };
    },
    async getStatus() {
      calls.push('getStatus');
      throw new Error('cloud getStatus(targetId) must not be used for list_daemons');
    },
  } as any;

  const output = await listDaemons(cloudTransport, { format: 'json' });
  const parsed = JSON.parse(output);

  assert.deepEqual(calls, ['listDaemons']);
  assert.equal(parsed.daemons[0].id, 'daemon-cloud-1');
  assert.equal(parsed.daemons[0].p2p_available, true);
});

test('listSessions cloud mode fetches daemon status directly when transport has getStatus()', async () => {
  const calls: string[] = [];
  const cloudTransport = {
    async listDaemons() {
      calls.push('listDaemons');
      return { daemons: [{ id: 'daemon-cloud-1' }] };
    },
    async getDaemonStatus(daemonId: string) {
      calls.push(`getDaemonStatus:${daemonId}`);
      return {
        sessions: [
          {
            id: 'session-1',
            providerType: 'hermes-cli',
            status: 'running',
            workspace: '/repo',
          },
        ],
      };
    },
    async getStatus() {
      calls.push('getStatus');
      throw new Error('cloud getStatus(targetId) must not be used for list_sessions');
    },
  } as any;

  const output = await listSessions(cloudTransport, { format: 'json' });
  const parsed = JSON.parse(output);

  assert.deepEqual(calls, ['listDaemons', 'getDaemonStatus:daemon-cloud-1']);
  assert.deepEqual(parsed.sessions, [
    {
      daemon_id: 'daemon-cloud-1',
      id: 'session-1',
      type: 'hermes-cli',
      status: 'running',
      workspace: '/repo',
    },
  ]);
});

test('checkPending cloud mode does not misclassify CloudTransport as local', async () => {
  const calls: string[] = [];
  const cloudTransport = {
    async getDaemonStatus(daemonId: string) {
      calls.push(`getDaemonStatus:${daemonId}`);
      return {
        sessions: [
          { id: 'session-pending', providerType: 'claude-cli', status: 'waiting_approval', workspace: '/repo' },
          { id: 'session-running', providerType: 'claude-cli', status: 'running', workspace: '/repo' },
        ],
      };
    },
    async getStatus() {
      calls.push('getStatus');
      throw new Error('cloud getStatus(targetId) must not be used for check_pending');
    },
  } as any;

  const output = await checkPending(cloudTransport, { daemon_id: 'daemon-cloud-1', format: 'json' });
  const parsed = JSON.parse(output);

  assert.deepEqual(calls, ['getDaemonStatus:daemon-cloud-1']);
  assert.deepEqual(parsed.pending, [
    {
      daemon_id: 'daemon-cloud-1',
      session_id: 'session-pending',
      workspace: '/repo',
      type: 'claude-cli',
      modal_message: null,
      buttons: [],
    },
  ]);
});
