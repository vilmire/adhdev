import assert from 'node:assert/strict';
import test from 'node:test';

import { READ_CHAT_TOOL, readChat } from '../src/tools/read-chat.js';
import { clearRapidReadChatAdvisoryStateForTests } from '../src/tools/read-chat-polling-advisory.js';

test('readChat schema exposes opt-in compact mode', () => {
  assert.equal((READ_CHAT_TOOL.inputSchema.properties as any).compact.type, 'boolean');
  assert.match((READ_CHAT_TOOL.inputSchema.properties as any).compact.description, /compact/i);
});

test('readChat compact json filters tool terminal and internal messages', async () => {
  const localTransport = {
    async command() {
      return {
        success: true,
        status: 'idle',
        messages: [
          { role: 'user', content: 'please summarize' },
          { role: 'assistant', kind: 'tool', content: 'tool bubble' },
          { role: 'assistant', kind: 'terminal', content: 'terminal bubble' },
          { role: 'assistant', meta: { internal: true }, content: 'internal bubble' },
          { role: 'system', content: 'system notification' },
          { role: 'assistant', content: 'Final summary only' },
        ],
      };
    },
  } as any;

  const output = await readChat(localTransport, {
    session_id: 'session-compact',
    limit: 10,
    format: 'json',
    compact: true,
  } as any);
  const parsed = JSON.parse(output);

  assert.equal(parsed.compact, true);
  assert.equal(parsed.visibleMessages, 2);
  assert.equal(parsed.omittedMessages, 4);
  assert.equal(parsed.summary, 'Final summary only');
  assert.deepEqual(
    parsed.messages.map((message: { content: string }) => message.content),
    ['please summarize'],
  );
});

test('readChat compact text shows summary separately without duplicating the final assistant bubble', async () => {
  const localTransport = {
    async command() {
      return {
        success: true,
        messages: [
          { role: 'user', content: 'visible user' },
          { role: 'assistant', content: 'visible assistant summary' },
        ],
      };
    },
  } as any;

  const output = await readChat(localTransport, {
    compact: true,
    format: 'text',
  } as any);

  assert.match(output, /\[User\] visible user/);
  assert.match(output, /\[Summary\] visible assistant summary/);
  assert.doesNotMatch(output, /\[Agent\] visible assistant summary/);
});

test('readChat compact text filters tool terminal and internal messages', async () => {
  const localTransport = {
    async command() {
      return {
        success: true,
        messages: [
          { role: 'user', content: 'visible user' },
          { role: 'assistant', kind: 'tool', content: 'hidden tool' },
          { role: 'assistant', content: 'visible assistant' },
        ],
      };
    },
  } as any;

  const output = await readChat(localTransport, {
    compact: true,
  } as any);

  assert.match(output, /visible user/);
  assert.match(output, /\[Summary\] visible assistant/);
  assert.doesNotMatch(output, /hidden tool/);
});

test('readChat json includes rapid polling advisory on repeated generating reads', async () => {
  clearRapidReadChatAdvisoryStateForTests();
  const localTransport = {
    async command() {
      return {
        success: true,
        status: 'generating',
        messages: [{ role: 'assistant', content: 'still working' }],
      };
    },
  } as any;

  await readChat(localTransport, {
    session_id: 'session-rapid',
    limit: 5,
    format: 'json',
  });
  const output = await readChat(localTransport, {
    session_id: 'session-rapid',
    limit: 5,
    format: 'json',
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.pollingAdvisory.type, 'rapid_read_chat_polling');
  assert.match(parsed.pollingAdvisory.message, /completion callback\/status event/i);
  assert.deepEqual(parsed.messages.map((message: { content: string }) => message.content), ['still working']);
});

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
