import assert from 'node:assert/strict';
import test from 'node:test';

import { compactMeshStatusNode, minimalCompactNode, summarizeNodeQuota, annotateQuotaSnapshotFreshness } from '../src/tools/mesh-compact.js';
import { extractReporterNodeFactsQuota } from '../src/tools/mesh-tools-internal-core.js';
import { DEFAULT_QUOTA_ROUTING_POLICY } from '@adhdev/daemon-core';

/**
 * An age past the routing staleness threshold, derived from the threshold
 * itself. These cases assert "a stale reading is LABELLED stale", not "31
 * minutes is stale" — and writing the literal is what made them silently
 * assert the opposite when the default widened from 30 to 60 min (2026-08-21).
 */
const STALE_AGE_MS = DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs + 60_000;
const STALE_AGE_MINUTES = Math.round(STALE_AGE_MS / 60_000);

// Provider quota now feeds ROUTING as well as observation (daemon-core
// mesh-quota-routing.ts consumes the same bundle these surfaces project).
// These tests pin the two properties that make the projection trustworthy:
// it must survive the compact fold
// (including on quiet nodes, which are exactly the idle machines with headroom
// worth knowing about), and a node that FAILED to read a quota must stay
// distinguishable from a node that never reported one.

const okQuota = {
  'claude-cli': {
    provider: 'claude-cli',
    status: 'ok',
    session: { usedPercent: 38.4, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 12.2, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1_700_000,
    error: null,
  },
  'codex-cli': {
    provider: 'codex-cli',
    status: 'unavailable',
    session: null,
    weekly: null,
    updatedAt: 1_700_000,
    error: 'Codex CLI could not be started',
    metadata: { failureKind: 'cli-unavailable' },
  },
};

test('summarizeNodeQuota folds ok windows to a labeled weekly-first pair with age', () => {
  // Shape: "7d <weekly>% · 5h <session>% · <age>". Weekly FIRST — it is the
  // provider-selection axis — and both axes carry labels so neither number can
  // be misread as the other. Age is always present: a reading without its age
  // is exactly how a 165-minute-old boot snapshot got read as current.
  const summary = summarizeNodeQuota(okQuota, 1_700_000 + 2 * 60_000)!;
  assert.equal(summary['claude-cli'], '7d 12% · 5h 38% · 2m');
});

test('summarizeNodeQuota flags a reading past the routing staleness threshold', () => {
  // Same threshold as the routing gate (DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs):
  // past it the gate fails open, so the surface must say "stale".
  const summary = summarizeNodeQuota(okQuota, 1_700_000 + STALE_AGE_MS)!;
  assert.equal(summary['claude-cli'], `7d 12% · 5h 38% · ${STALE_AGE_MINUTES}m stale`);
});

test('summarizeNodeQuota renders an unmeasured axis as —', () => {
  const quota = {
    'grok-cli': {
      provider: 'grok-cli',
      status: 'ok',
      session: null, // intentionally unmeasured for grok
      weekly: { usedPercent: 16, windowMinutes: 10080, resetsAt: null },
      updatedAt: 1_000_000,
      error: null,
    },
  };
  const summary = summarizeNodeQuota(quota, 1_000_000 + 60_000)!;
  assert.equal(summary['grok-cli'], '7d 16% · 5h — · 1m');
});

test('summarizeNodeQuota keeps last-good numbers visible while refreshing', () => {
  // carryForwardLastGoodWindows retains the previous good reading across a
  // transient failure (metadata.lastGoodWindows). The old fold dropped those
  // numbers to a bare "error:expired-token"; the numbers are the whole point
  // of carry-forward, so they stay, labeled "refreshing".
  const quota = {
    'grok-cli': {
      provider: 'grok-cli',
      status: 'error',
      session: null,
      weekly: { usedPercent: 16, windowMinutes: 10080, resetsAt: null },
      updatedAt: 1_000_000,
      error: 'token expired',
      metadata: { failureKind: 'expired-token', lastGoodWindows: true },
    },
  };
  const summary = summarizeNodeQuota(quota, 1_000_000 + 60_000)!;
  assert.equal(summary['grok-cli'], '7d 16% · 5h — · 1m · refreshing');
});

test('summarizeNodeQuota labels retained no-data windows stale, not refreshing', () => {
  const quota = {
    'claude-cli': {
      provider: 'claude-cli',
      status: 'error',
      session: { usedPercent: 30, windowMinutes: 300, resetsAt: 1_787_716_800_000 },
      weekly: { usedPercent: 99, windowMinutes: 10080, resetsAt: 1_787_698_800_000 },
      updatedAt: 1_787_681_820_000,
      error: 'Claude quota reading is stale (304 min old)',
      metadata: { source: 'statusline', failureKind: 'no-data', lastGoodWindows: true },
    },
  };
  const summary = summarizeNodeQuota(quota, 1_787_700_060_000)!;
  assert.equal(summary['claude-cli'], '7d 99% · 5h 30% · 304m stale');
  assert.equal(summary['claude-cli'].includes('refreshing'), false);
});

test('summarizeNodeQuota keeps failures visible with their failureKind', () => {
  // The whole point: "looked and could not tell" must not read the same as
  // "never told us". Today 2 of 3 providers fail on a typical machine, so a
  // fold that dropped failures would render most nodes as silent. Only a
  // snapshot with NO usable numbers at all degrades to the bare status word.
  const summary = summarizeNodeQuota(okQuota, 1_700_000)!;
  assert.equal(summary['codex-cli'], 'unavailable:cli-unavailable');
});

test('annotateQuotaSnapshotFreshness adds ageMs/stale without dropping fields', () => {
  const now = 1_700_000 + STALE_AGE_MS;
  const annotated = annotateQuotaSnapshotFreshness(okQuota, now);
  // Pure-additive: updatedAt (and every original field) survives.
  assert.equal(annotated['claude-cli'].updatedAt, 1_700_000);
  assert.equal(annotated['claude-cli'].session.usedPercent, 38.4);
  // Computed for the reader — no epoch-ms subtraction left to the coordinator.
  assert.equal(annotated['claude-cli'].ageMs, STALE_AGE_MS);
  assert.equal(annotated['claude-cli'].stale, true); // past the routing threshold
  const fresh = annotateQuotaSnapshotFreshness(okQuota, 1_700_000 + 60_000);
  assert.equal(fresh['claude-cli'].ageMs, 60_000);
  assert.equal(fresh['claude-cli'].stale, false);
});

test('summarizeNodeQuota returns undefined for a node that reported nothing', () => {
  assert.equal(summarizeNodeQuota(undefined), undefined);
  assert.equal(summarizeNodeQuota({}), undefined);
  assert.equal(summarizeNodeQuota('nonsense'), undefined);
});

test('compactMeshStatusNode folds quota instead of dropping or inlining it', () => {
  // updatedAt relative to Date.now(): compactMeshStatusNode stamps age at call
  // time, so a fixed epoch would render an ever-growing stale age here.
  const freshQuota = {
    ...okQuota,
    'claude-cli': { ...okQuota['claude-cli'], updatedAt: Date.now() - 2 * 60_000 },
  };
  const compacted = compactMeshStatusNode({ nodeId: 'n1', health: 'online', quota: freshQuota });
  assert.deepEqual(compacted.quota, {
    'claude-cli': '7d 12% · 5h 38% · 2m',
    'codex-cli': 'unavailable:cli-unavailable',
  });
  // Folded, not raw — the nested per-provider objects must not survive compact.
  assert.equal(JSON.stringify(compacted).includes('windowMinutes'), false);
});

test('quota survives the minimal stub for quiet nodes', () => {
  // An idle node is precisely the one whose spare quota a coordinator wants to
  // see, and quiet nodes degrade to minimalCompactNode. Registering quota in
  // MESH_COMPACT_PRESERVED_MARKER_FIELDS is what keeps it there; dropping it
  // from that list makes this fail.
  const stub = minimalCompactNode({ nodeId: 'n1', workspace: '/w', health: 'online', quota: { kimi: '5%/1%' } });
  assert.deepEqual(stub.quota, { kimi: '5%/1%' });
  assert.equal(stub.folded, true);
});

test('extractReporterNodeFactsQuota reads quota out of the git_status envelope', () => {
  const envelope = { result: { success: true, reporterNodeFacts: { schemaVersion: 1, reportedAt: 1, quota: okQuota } } };
  const quota = extractReporterNodeFactsQuota(envelope)!;
  assert.equal(quota['claude-cli'].status, 'ok');
});

test('extractReporterNodeFactsQuota returns undefined for a reporter without quota', () => {
  // A daemon predating the field, and one that has simply not cached anything
  // yet, both mean "never told us" — the caller omits the key entirely.
  assert.equal(extractReporterNodeFactsQuota({ result: { reporterNodeFacts: { schemaVersion: 1, reportedAt: 1 } } }), undefined);
  assert.equal(extractReporterNodeFactsQuota({ result: { reporterNodeFacts: { quota: {} } } }), undefined);
  assert.equal(extractReporterNodeFactsQuota({ result: {} }), undefined);
  assert.equal(extractReporterNodeFactsQuota(undefined), undefined);
});

// ★BUCKETS-ONLY PROVIDERS KEEP THEIR NUMBERS IN THE FOLD (owner report
// 2026-09-13). Antigravity measures on a per-pool `buckets` axis; its
// session/weekly are only a worst-bucket collapse of it and can BOTH be null
// while the buckets hold a perfectly good reading. Folding that shape to a bare
// "error:expired-token" threw away the very reading daemon-core's carry-forward
// had just preserved, and told a coordinator the node could not report when it
// could — the same class of misread the AGE ALWAYS / lastGoodWindows rules
// above exist to prevent.
const agyBucketsOnly = {
  'antigravity-cli': {
    provider: 'antigravity-cli',
    status: 'error',
    session: null,
    weekly: null,
    buckets: [
      { name: 'Gemini Models · 5h Limit Remaining', usedPercent: 62, windowMinutes: 300, resetsAt: null },
      { name: 'Claude/GPT Bundled Models · 5h Limit Remaining', usedPercent: 12, windowMinutes: 300, resetsAt: null },
    ],
    updatedAt: Date.now(),
    error: 'Antigravity access token expired — run `agy` once to refresh it, then quota will report again.',
    metadata: { source: 'oauth', failureKind: 'expired-token', lastGoodWindows: true },
  },
};

test('summarizeNodeQuota keeps a buckets-only reading instead of collapsing to error:expired-token', () => {
  const summary = summarizeNodeQuota(agyBucketsOnly);
  const line = summary?.['antigravity-cli'] ?? '';

  assert.ok(!line.startsWith('error:'), `expected retained numbers, got "${line}"`);
  // Worst pool's used% and how many pools reported — the headline routing gates on.
  assert.match(line, /^pool 62% \(2\)/);
});

test('an expired antigravity token is cued stale, never refreshing', () => {
  // The daemon never redeems this token, so nothing is in flight — only the
  // user running `agy` produces a new reading. Same class as no-data.
  const line = summarizeNodeQuota(agyBucketsOnly)?.['antigravity-cli'] ?? '';
  assert.match(line, /stale/);
  assert.ok(!line.includes('refreshing'), `expected stale, got "${line}"`);
});

test('a snapshot with no numbers on ANY axis still degrades to status:failureKind', () => {
  const none = {
    'antigravity-cli': {
      ...agyBucketsOnly['antigravity-cli'],
      buckets: [],
      metadata: { source: 'oauth', failureKind: 'expired-token' },
    },
  };
  assert.equal(summarizeNodeQuota(none)?.['antigravity-cli'], 'error:expired-token');
});

// ★HONEST FRESHNESS AFTER THE RETRY BUDGET (2026-10-10): the cue comes from the
// shared assessQuotaFreshness (same as the dashboards and `adhdev quota`).
// "refreshing" only while a retry is pending; a spent budget reads stale with
// the daemon's next check; codex no-data is a daemon re-read (next check), the
// aged-out Claude statusline needs a session (no daemon check promised).
const FRESH_NOW = 1_800_000_000_000;
const retainedKimi = (metadata: Record<string, unknown>, provider = 'kimi') => ({
  [provider]: {
    provider,
    status: 'error',
    session: { usedPercent: 31, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 12, windowMinutes: 10080, resetsAt: null },
    updatedAt: FRESH_NOW - 10 * 60_000,
    metadata: { fetchedAt: FRESH_NOW - 2 * 60_000, lastGoodWindows: true, failureKind: 'expired-token', ...metadata },
  },
});

test('retry pending keeps "refreshing"', () => {
  const line = summarizeNodeQuota(retainedKimi({ retryAtMs: FRESH_NOW + 240_000 }), FRESH_NOW)?.kimi ?? '';
  assert.match(line, /· refreshing$/);
});

test('a spent retry budget reads stale with the next check, never refreshing', () => {
  const line = summarizeNodeQuota(retainedKimi({ retryAtMs: FRESH_NOW - 20 * 60_000, retryExhausted: true }), FRESH_NOW)?.kimi ?? '';
  assert.match(line, /· stale · next check ≤58m$/, line);
  assert.ok(!line.includes('refreshing'), line);
});

test('codex no-data is stale with a daemon next check; claude no-data is plain stale', () => {
  const codex = summarizeNodeQuota(retainedKimi({ failureKind: 'no-data' }, 'codex-cli'), FRESH_NOW)?.['codex-cli'] ?? '';
  assert.match(codex, /· stale · next check ≤\d+m$/, codex);
  const claude = summarizeNodeQuota(retainedKimi({ failureKind: 'no-data' }, 'claude-cli'), FRESH_NOW)?.['claude-cli'] ?? '';
  assert.match(claude, /· stale$/, claude);
});
