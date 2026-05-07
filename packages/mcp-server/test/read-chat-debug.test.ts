import assert from 'node:assert/strict';
import test from 'node:test';

import { formatChatDebugResult, readChatDebug } from '../src/tools/read-chat-debug.js';

test('readChatDebug local mode collects daemon_file bundle without browser/frontend snapshot', async () => {
  const commands: Array<{ type: string; args: Record<string, unknown> }> = [];
  const localTransport = {
    async command(type: string, args: Record<string, unknown>) {
      commands.push({ type, args });
      return {
        success: true,
        delivery: 'daemon_file',
        bundleId: 'chat-debug-test',
        savedPath: '/tmp/chat-debug-test.json',
        sizeBytes: 1234,
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: {
          readChatStatus: 'idle',
          readChatTotalMessages: 87,
          cliStatus: 'idle',
          cliMessageCount: 90,
        },
      };
    },
  } as any;

  const output = await readChatDebug(localTransport, {
    session_id: 'session-1',
    agent_type: 'hermes-cli',
    limit: 25,
  });

  assert.deepEqual(commands, [
    {
      type: 'get_chat_debug_bundle',
      args: {
        targetSessionId: 'session-1',
        tailLimit: 25,
        agentType: 'hermes-cli',
        providerType: 'hermes-cli',
        delivery: 'daemon_file',
      },
    },
  ]);
  assert.match(output, /ADHDev chat debug bundle saved on daemon/);
  assert.match(output, /saved_path: \/tmp\/chat-debug-test\.json/);
  assert.match(output, /read_chat_total_messages: 87/);
});

test('readChatDebug inline mode does not force daemon_file delivery', async () => {
  const commands: Array<{ type: string; args: Record<string, unknown> }> = [];
  const localTransport = {
    async command(type: string, args: Record<string, unknown>) {
      commands.push({ type, args });
      return { success: true, bundle: { version: 1, frontend: null }, text: 'inline bundle text' };
    },
  } as any;

  const output = await readChatDebug(localTransport, {
    session_id: 'session-inline',
    delivery: 'inline',
  });

  assert.equal(commands[0].type, 'get_chat_debug_bundle');
  assert.equal('delivery' in commands[0].args, false);
  assert.equal(output, 'inline bundle text');
});

test('formatChatDebugResult returns machine-readable json when requested', () => {
  const text = formatChatDebugResult(
    { success: true, delivery: 'daemon_file', savedPath: '/tmp/a.json' },
    { sessionId: 'session-json', delivery: 'daemon_file', format: 'json' },
  );
  assert.equal(JSON.parse(text).savedPath, '/tmp/a.json');
});
