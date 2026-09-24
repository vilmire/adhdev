import assert from 'node:assert/strict';
import test from 'node:test';

import { unwrapCommandPayload, unwrapOneLevel } from '../src/tools/mesh-session-helpers.js';

// Break-once: `result ?? payload` (the old unwrapCommandPayload body) stops at
// a non-null non-object `result` — e.g. `true`, a boolean success flag some
// commands return — even when `payload` right next to it is a perfectly good
// object. The replica modules' local `unwrap` already got this right
// (`payload` preferred first); unwrapCommandPayload disagreed with them.

test('unwrapOneLevel prefers an object payload over a non-object result', () => {
  const wrapped = { result: true, payload: { sessions: ['a'] } };
  assert.deepEqual(unwrapOneLevel(wrapped), { sessions: ['a'] });
});

test('unwrapOneLevel prefers an object payload over an object result too', () => {
  const wrapped = { result: { stale: true }, payload: { fresh: true } };
  assert.deepEqual(unwrapOneLevel(wrapped), { fresh: true });
});

test('unwrapOneLevel falls back to an object result when there is no object payload', () => {
  const wrapped = { result: { sessions: ['a'] } };
  assert.deepEqual(unwrapOneLevel(wrapped), { sessions: ['a'] });
});

test('unwrapOneLevel returns the input unchanged when neither payload nor result is an object', () => {
  const wrapped = { result: true, ok: 1 };
  assert.deepEqual(unwrapOneLevel(wrapped), wrapped);
});

test('unwrapCommandPayload (multi-level) also prefers payload over a non-object result at each level', () => {
  const wrapped = { result: true, payload: { result: false, payload: { sessions: ['a'] } } };
  assert.deepEqual(unwrapCommandPayload(wrapped), { sessions: ['a'] });
});

test('unwrapCommandPayload stops descending once neither key is an object', () => {
  const flat = { sessions: ['a'] };
  assert.deepEqual(unwrapCommandPayload(flat), flat);
});
