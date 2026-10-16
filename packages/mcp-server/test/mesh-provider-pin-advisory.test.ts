import assert from 'node:assert/strict';
import test from 'node:test';
import { withProviderPinWarning, requestedProviderPins } from '../src/tools/mesh-provider-pin-advisory.js';

test('request warning preserves existing fields and warnings, and identifies all requested pins', () => {
  const response = { success: false, warning: 'existing', warnings: ['existing-array'], providerPinWarnings: [{ code: 'existing' }], sessionId: 'continuation' };
  const result = withProviderPinWarning(response, ['codex-cli', 'claude-cli', 'codex-cli']);
  assert.equal(result.warning, response.warning);
  assert.deepEqual(result.warnings, response.warnings);
  assert.equal(result.sessionId, response.sessionId);
  assert.equal(result.success, false);
  assert.equal(result.providerPinWarnings?.length, 2);
  assert.deepEqual((result.providerPinWarnings?.[1] as any).requestedProviders, ['codex-cli', 'claude-cli']);
  assert.equal(response.providerPinWarnings.length, 1);
});

test('automatic assignment and named-session continuation are not requested pins', () => {
  const response = { success: true, providerType: 'claude-cli', resolvedProviderType: 'claude-cli', sessionId: 'same-issue' };
  assert.equal(withProviderPinWarning(response, []), response);
  assert.deepEqual(requestedProviderPins({ required_tags: ['worktree=fix/example', 'node=node-a'] }), []);
  assert.deepEqual(requestedProviderPins(null), []);
  assert.deepEqual(requestedProviderPins({ required_tags: [], requiredTags: ['provider=claude-cli'] }), []);
});
