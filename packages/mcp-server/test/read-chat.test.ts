import assert from 'node:assert/strict';
import test from 'node:test';

import { readChat } from '../src/tools/read-chat.js';

test('readChat local mode sends tailLimit and caps formatted output to requested limit', async () => {
  const commands: Array<{ type: string; args: Record<string, unknown> }> = [];
  const localTransport = {
    async command(type: string, args: Record<string, unknown>) {
      commands.push({ type, args });
      return {
        success: true,
        messages: [
          { role: 'user', content: 'message-1', timestamp: 1 },
          { role: 'assistant', content: 'message-2', timestamp: 2 },
          { role: 'user', content: 'message-3', timestamp: 3 },
          { role: 'assistant', content: 'message-4', timestamp: 4 },
          { role: 'user', content: 'message-5', timestamp: 5 },
        ],
      };
    },
  } as any;

  const output = await readChat(localTransport, {
    session_id: 'session-1',
    limit: 2,
    format: 'json',
  });

  assert.deepEqual(commands, [
    {
      type: 'read_chat',
      args: { targetSessionId: 'session-1', tailLimit: 2 },
    },
  ]);

  const parsed = JSON.parse(output);
  assert.equal(parsed.session_id, 'session-1');
  assert.deepEqual(
    parsed.messages.map((message: { content: string }) => message.content),
    ['message-4', 'message-5'],
  );
});
