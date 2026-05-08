import assert from 'node:assert/strict';
import test from 'node:test';

import {
  annotateRapidReadChatAdvisory,
  clearRapidReadChatAdvisoryStateForTests,
} from '../src/tools/read-chat-polling-advisory.js';

test('rapid read_chat advisory is added for repeated generating reads within the cooldown window', () => {
  clearRapidReadChatAdvisoryStateForTests();

  const first = annotateRapidReadChatAdvisory({ status: 'generating' }, {
    key: 'mesh:node-a:session-a',
    now: 1_000,
    toolName: 'mesh_read_chat',
    completionCallbackExpected: true,
  });
  assert.equal(first.pollingAdvisory, undefined);

  const second = annotateRapidReadChatAdvisory({ status: 'generating' }, {
    key: 'mesh:node-a:session-a',
    now: 3_000,
    toolName: 'mesh_read_chat',
    completionCallbackExpected: true,
  });

  assert.equal(second.pollingAdvisory?.type, 'rapid_read_chat_polling');
  assert.equal(second.pollingAdvisory?.elapsedMs, 2_000);
  assert.equal(second.pollingAdvisory?.nextSuggestedReadAt, 6_000);
  assert.equal(second.pollingAdvisory?.completionCallbackExpected, true);
  assert.match(second.pollingAdvisory?.message ?? '', /completion callback\/status event/i);
});

test('rapid read_chat advisory is not added after the window or for idle sessions', () => {
  clearRapidReadChatAdvisoryStateForTests();

  annotateRapidReadChatAdvisory({ status: 'generating' }, {
    key: 'read_chat:session-b',
    now: 1_000,
    toolName: 'read_chat',
  });

  const later = annotateRapidReadChatAdvisory({ status: 'generating' }, {
    key: 'read_chat:session-b',
    now: 7_000,
    toolName: 'read_chat',
  });
  assert.equal(later.pollingAdvisory, undefined);

  const idle = annotateRapidReadChatAdvisory({ status: 'idle' }, {
    key: 'read_chat:session-b',
    now: 8_000,
    toolName: 'read_chat',
  });
  assert.equal(idle.pollingAdvisory, undefined);

  const activeAfterIdle = annotateRapidReadChatAdvisory({ status: 'generating' }, {
    key: 'read_chat:session-b',
    now: 9_000,
    toolName: 'read_chat',
  });
  assert.equal(activeAfterIdle.pollingAdvisory, undefined);
});
