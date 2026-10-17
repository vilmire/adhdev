import assert from 'node:assert/strict';
import test from 'node:test';
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
