import assert from 'node:assert/strict';
import test from 'node:test';

import { READ_CHAT_TOOL, readChat } from '../src/tools/read-chat.js';
import { clearRapidReadChatAdvisoryStateForTests } from '../src/tools/read-chat-polling-advisory.js';
import { summarizeToolMessage, compactChatPayload, dedupeSummaryFromTail } from '../src/tools/chat-compact.js';

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
  // Leak #1: the final assistant bubble must NOT re-carry the summary body in compact.
  // It is replaced by a content-free stub flagged _sameAsSummary; body lives in summary.
  assert.deepEqual(
    parsed.messages.map((message: { content: string }) => message.content),
    ['please summarize', ''],
  );
  const finalBubble = parsed.messages[parsed.messages.length - 1];
  assert.equal(finalBubble.role, 'assistant');
  assert.equal(finalBubble._sameAsSummary, true);
  // The report body appears exactly once across the whole compact payload.
  assert.equal(output.split('Final summary only').length - 1, 1);
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
  // Non-compact JSON path: no dedup, bodies intact.
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
  // This is compact-less JSON (no compact flag), so no dedup applies — bodies intact.
  assert.deepEqual(
    parsed.messages.map((message: { content: string }) => message.content),
    ['message-4', 'message-5'],
  );
});

test('summarizeToolMessage returns bash summary with exit code', () => {
  const msg = { role: 'assistant', kind: 'terminal', command: 'npm test', exitCode: 0 };
  assert.equal(summarizeToolMessage(msg), '[Bash] npm test → exit 0');
});

test('summarizeToolMessage returns bash summary without exit code', () => {
  const msg = { role: 'assistant', kind: 'bash', command: 'git status' };
  assert.equal(summarizeToolMessage(msg), '[Bash] git status');
});

test('summarizeToolMessage returns tool call name', () => {
  const msg = { role: 'assistant', kind: 'tool_call', name: 'Read' };
  assert.equal(summarizeToolMessage(msg), '[Tool] Read');
});

test('summarizeToolMessage returns null for messages without useful info', () => {
  assert.equal(summarizeToolMessage({ role: 'system', content: 'noise' }), null);
  assert.equal(summarizeToolMessage({ role: 'assistant', meta: { internal: true }, content: 'internal' }), null);
});

test('compact payload includes toolSummaries for filtered tool/bash messages', () => {
  const payload = {
    success: true,
    messages: [
      { role: 'user', content: 'please do X' },
      { role: 'assistant', kind: 'terminal', command: 'npm test', exitCode: 0 },
      { role: 'assistant', kind: 'tool_call', name: 'Read' },
      { role: 'assistant', content: 'Done.' },
    ],
  };
  const result = compactChatPayload(payload, { limit: 10 });
  assert.equal(result.compact, true);
  assert.equal(result.visibleMessages, 2);
  assert.equal(result.filteredMessages, 2);
  assert.equal(result.omittedMessages, 2);
  assert.deepEqual(result.toolSummaries, ['[Bash] npm test → exit 0', '[Tool] Read']);
  // 'Done.' is the final assistant bubble === summary, so it is deduped to a stub.
  assert.deepEqual(
    result.messages.map((m: any) => m.content),
    ['please do X', ''],
  );
  assert.equal(result.summary, 'Done.');
  assert.equal(result.messages[result.messages.length - 1]._sameAsSummary, true);
});

test('compact payload omittedMessages counts tail-sliced visible messages too', () => {
  // 4 visible messages but limit=2, so 2 are sliced off
  const payload = {
    success: true,
    messages: [
      { role: 'user', content: 'msg1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'msg3' },
      { role: 'assistant', content: 'msg4' },
    ],
  };
  const result = compactChatPayload(payload, { limit: 2 });
  assert.equal(result.totalMessages, 4);
  assert.equal(result.visibleMessages, 4);
  assert.equal(result.filteredMessages, 0);
  // omittedMessages = totalMessages - returned messages count = 4 - 2 = 2
  assert.equal(result.omittedMessages, 2);
  assert.equal(result.messages.length, 2);
});

test('dedupeSummaryFromTail blanks an assistant bubble matching the summary (whitespace-insensitive)', () => {
  const messages = [
    { role: 'user', content: 'do it' },
    // Differs from summary only by interior whitespace/newlines.
    { role: 'assistant', content: '  Report\n\n  body   here ' },
  ];
  const out = dedupeSummaryFromTail(messages, 'Report body here');
  assert.equal(out[0].content, 'do it');
  assert.equal(out[1].content, '');
  assert.equal(out[1]._sameAsSummary, true);
  // Role/position preserved.
  assert.equal(out[1].role, 'assistant');
});

test('dedupeSummaryFromTail leaves non-matching assistant bubbles intact', () => {
  const messages = [
    { role: 'assistant', content: 'different body' },
  ];
  const out = dedupeSummaryFromTail(messages, 'the summary');
  assert.equal(out[0].content, 'different body');
  assert.equal(out[0]._sameAsSummary, undefined);
});

test('leak #1: compact read_chat carries a long report body exactly once (byte win)', () => {
  const longReport = 'COMPLETION REPORT: '.repeat(400).trim(); // ~7.6KB
  const payload = {
    success: true,
    status: 'idle',
    summary: longReport,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: longReport },
    ],
  };

  // Before-fix behavior simulated: summary + verbatim final bubble (no dedup).
  const beforeMessages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: longReport },
  ];
  const before = JSON.stringify({ summary: longReport, messages: beforeMessages });

  const after = JSON.stringify(compactChatPayload(payload, { limit: 10 }));

  // The report body must appear exactly once in the deduped payload.
  assert.equal(after.split(longReport).length - 1, 1, 'report body must appear exactly once');
  assert.equal(before.split(longReport).length - 1, 2, 'pre-fix shape carried it twice');
  // After must be meaningfully smaller than the duplicated shape.
  assert.ok(after.length < before.length, `after (${after.length}) must be < before (${before.length})`);
  // The body still recoverable from summary.
  assert.equal(JSON.parse(after).summary, longReport);
});
