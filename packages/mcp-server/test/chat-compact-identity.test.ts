import assert from 'node:assert/strict';
import test from 'node:test';
import { compactChatPayload } from '../src/tools/chat-compact.js';
test('compact pending read preserves requested/result identity and provenance', () => {
  const messageSource = { selected: 'pty-parser', runtimeMappingSafe: false, nativeHandle: 'synthetic-unconfirmed-candidate' };
  const payload = { success: true, pending: true, sessionId: 'synthetic-result-runtime',
    reason: 'native_history_not_safely_available', reasons: ['live_adapter_not_found', 'native_history_not_safely_available'],
    code: 'native_history_not_safely_available', messages: [], messageSource, transcriptProvenance: messageSource };
  const result = compactChatPayload(payload, { sessionId: 'synthetic-requested-runtime' });
  assert.equal(result.sessionId, 'synthetic-requested-runtime'); assert.equal(result.resultSessionId, 'synthetic-result-runtime');
  assert.equal(result.providerSessionId, null); assert.equal(result.pending, true); assert.equal(result.reason, payload.reason);
  assert.equal(result.code, payload.code); assert.deepEqual(result.reasons, payload.reasons);
  assert.deepEqual(result.messageSource, messageSource); assert.deepEqual(result.transcriptProvenance, messageSource);
  assert.deepEqual(result.messages, []); assert.equal(result.summary, '');
});
