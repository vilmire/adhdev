import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeNodeQuota } from '../src/tools/mesh-compact.js';
import { foldPerDaemonFields } from '../src/tools/mesh-status-sections.js';
import { applyHeldNodeGitToEntry } from '../src/tools/mesh-status-held-git.js';

const NOW = 1_800_000_000_000;
const snapshot = (usedPercent: number, updatedAt: number) => ({
  provider: 'grok-cli', status: 'ok', session: null,
  weekly: { usedPercent, windowMinutes: 10080, resetsAt: NOW + 86_400_000 },
  updatedAt, error: null, metadata: { source: 'oauth', fetchedAt: updatedAt },
});

test('verbose node quota labels the stale 76% remaining copy and the fresh 3% copy with their own age', () => {
  for (const [used, time, stale] of [[24, NOW - 3_663_172, true], [97, NOW, false]] as const) {
    const reading = snapshot(used, time);
    const entry: Record<string, any> = { daemonId: 'owner' };
    applyHeldNodeGitToEntry(entry, { mesh: {} as never, node: {} as never,
      held: { nodeFacts: { quota: { 'grok-cli': reading } } }, now: NOW });
    assert.equal(entry.quota['grok-cli'].stale, stale);
    assert.equal(entry.quota['grok-cli'].ageMs, NOW - time);
    assert.equal(entry.quota['grok-cli'].weekly.usedPercent, used);
    assert.equal(entry.quota['grok-cli'].session, null);
    assert.equal('stale' in reading, false, 'do not mutate held facts');
  }
});

test('stale success and its replacement propagate consistently to verbose node, daemon fold and compact summary', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const entry: Record<string, any> = { daemonId: 'owner' };
  const original = snapshot(24, NOW - 3_663_172);
  // A new attempt stamp must not rejuvenate the earlier measurement.
  original.metadata.fetchedAt = NOW;
  const held = { nodeFacts: { quota: { 'grok-cli': original } } };
  applyHeldNodeGitToEntry(entry, { mesh: {} as never, node: {} as never, held, now: NOW });
  const staleFold = foldPerDaemonFields([entry], { compact: false, includeSessions: false });
  assert.deepEqual(staleFold.daemonQuotas.owner, entry.quota);
  assert.equal(entry.quota['grok-cli'].stale, true);
  assert.equal(entry.quota['grok-cli'].ageMs, 3_663_172);
  assert.equal(entry.quota['grok-cli'].metadata.fetchedAt, NOW);
  assert.equal(entry.quota['grok-cli'].updatedAt, original.updatedAt);
  assert.equal(summarizeNodeQuota(entry.quota, NOW)?.['grok-cli'], '7d 24% · 5h — · 61m stale');

  const replacement = snapshot(97, NOW);
  held.nodeFacts.quota['grok-cli'] = replacement;
  applyHeldNodeGitToEntry(entry, { mesh: {} as never, node: {} as never, held, now: NOW });
  const freshFold = foldPerDaemonFields([entry], { compact: false, includeSessions: false });
  assert.deepEqual(freshFold.daemonQuotas.owner, entry.quota);
  assert.equal(entry.quota['grok-cli'].stale, false);
  assert.equal(entry.quota['grok-cli'].ageMs, 0);
  assert.equal(entry.quota['grok-cli'].weekly.usedPercent, 97);
  assert.equal(entry.quota['grok-cli'].session, null);
  assert.equal(summarizeNodeQuota(entry.quota, NOW)?.['grok-cli'], '7d 97% · 5h — · 0m');
  assert.equal(original.weekly.usedPercent, 24);
  assert.equal(original.updatedAt, NOW - 3_663_172);
  assert.equal('stale' in original, false);
});
