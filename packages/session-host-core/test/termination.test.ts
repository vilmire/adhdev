import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTermination } from '../src/termination.js';

const AT = 1_700_000_000_000;

test('exit 0 classifies as a clean stop', () => {
  const t = classifyTermination({ exitCode: 0, signal: null, terminatedAt: AT });
  assert.equal(t.exitCode, 0);
  assert.equal(t.signal, null);
  assert.equal(t.reason, 'exit');
  assert.equal(t.lifecycle, 'stopped');
});

test('nonzero exit code classifies as failed', () => {
  const t = classifyTermination({ exitCode: 1, signal: null, terminatedAt: AT });
  assert.equal(t.exitCode, 1);
  assert.equal(t.reason, 'failed');
  assert.equal(t.lifecycle, 'failed');
});

test('null exit code is unknown and MUST NOT collapse to exit 0', () => {
  const t = classifyTermination({ exitCode: null, signal: null, terminatedAt: AT });
  // Regression guard for the old `exitCode ?? 0` collapse.
  assert.equal(t.exitCode, null, 'null exitCode must be preserved, never fabricated to 0');
  assert.equal(t.reason, 'unknown');
  assert.equal(t.lifecycle, 'failed', 'unknown must stay distinguishable from a clean stop');
  assert.notEqual(t.lifecycle, 'stopped');
});

test('signal termination classifies as signal/failed and preserves the signal', () => {
  // SIGHUP = 1 (the codex RCA scenario: OS teardown, no exit code)
  const t = classifyTermination({ exitCode: null, signal: 1, terminatedAt: AT });
  assert.equal(t.signal, 1);
  assert.equal(t.exitCode, null);
  assert.equal(t.reason, 'signal');
  assert.equal(t.lifecycle, 'failed');
});

test('a signal wins over a coincidental exit code', () => {
  const t = classifyTermination({ exitCode: 0, signal: 9, terminatedAt: AT });
  assert.equal(t.reason, 'signal');
  assert.equal(t.lifecycle, 'failed');
  assert.equal(t.signal, 9);
});

test('context fields (osPid, previousLifecycle, lastOutputAt, requestedStop) are carried through', () => {
  const t = classifyTermination({
    exitCode: null,
    signal: 1,
    osPid: 30573,
    previousLifecycle: 'running',
    lastOutputAt: AT - 3600,
    requestedStop: 'stop',
    terminatedAt: AT,
  });
  assert.equal(t.osPid, 30573);
  assert.equal(t.previousLifecycle, 'running');
  assert.equal(t.lastOutputAt, AT - 3600);
  assert.equal(t.requestedStop, 'stop');
  assert.equal(t.terminatedAt, AT);
});

test('optional context fields are omitted when not provided', () => {
  const t = classifyTermination({ exitCode: 0, terminatedAt: AT });
  assert.equal('osPid' in t, false);
  assert.equal('previousLifecycle' in t, false);
  assert.equal('lastOutputAt' in t, false);
  assert.equal('requestedStop' in t, false);
  assert.equal(t.signal, null, 'absent signal normalizes to null');
});
