import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeNodeQuota } from '../src/tools/mesh-compact.js';

/**
 * rc12 (2026-10-13): cursor-cli reports ONLY a 30-day `monthly` axis. The
 * compact `mesh_status` fold looked at session/weekly/buckets alone, so a
 * healthy (or retained) cursor reading collapsed to a bare status word and
 * told the coordinator the node could not report. Synthetic data only.
 */
const NOW = 1_800_000_000_000;

const cursor = (overrides: Record<string, unknown> = {}) => ({
  provider: 'cursor-cli',
  status: 'ok',
  session: null,
  weekly: null,
  monthly: { usedPercent: 41.4, windowMinutes: 43200, resetsAt: null },
  updatedAt: NOW - 3 * 60_000,
  error: null,
  metadata: { source: 'api' },
  ...overrides,
});

test('a monthly-only reading renders an honest 30d axis, not a bare status', () => {
  const out = summarizeNodeQuota({ 'cursor-cli': cursor() }, NOW);
  assert.match(out!['cursor-cli']!, /^30d 41% · 3m/);
  assert.doesNotMatch(out!['cursor-cli']!, /7d|5h/);
});

test('a retained monthly-only reading keeps its numbers with the refreshing cue', () => {
  const out = summarizeNodeQuota({
    'cursor-cli': cursor({ status: 'error', metadata: { failureKind: 'network', lastGoodWindows: true, retryAtMs: NOW + 60_000 } }),
  }, NOW);
  assert.match(out!['cursor-cli']!, /^30d 41% · 3m · refreshing$/);
});

test('an unknown monthly percentage stays unknown — never rendered as 0%', () => {
  const out = summarizeNodeQuota({
    'cursor-cli': cursor({ status: 'error', monthly: { usedPercent: null, windowMinutes: 43200, resetsAt: null }, metadata: { failureKind: 'network' } }),
  }, NOW);
  assert.equal(out!['cursor-cli'], 'error:network');
});

test('a provider with weekly/session keeps the established 7d/5h line', () => {
  const out = summarizeNodeQuota({
    'claude-cli': {
      provider: 'claude-cli', status: 'ok', updatedAt: NOW - 60_000, error: null,
      session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
      weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null },
    },
  }, NOW);
  assert.match(out!['claude-cli']!, /^7d 20% · 5h 10% · 1m$/);
});
