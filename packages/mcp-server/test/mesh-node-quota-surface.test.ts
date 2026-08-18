import assert from 'node:assert/strict';
import test from 'node:test';

import { compactMeshStatusNode, minimalCompactNode, summarizeNodeQuota, annotateQuotaSnapshotFreshness } from '../src/tools/mesh-compact.js';
import { extractReporterNodeFactsQuota } from '../src/tools/mesh-tools-internal.js';

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
  // Same threshold as the routing gate (DEFAULT_QUOTA_ROUTING_POLICY.staleAfterMs,
  // 30 min): past it the gate fails open, so the surface must say "stale".
  const summary = summarizeNodeQuota(okQuota, 1_700_000 + 31 * 60_000)!;
  assert.equal(summary['claude-cli'], '7d 12% · 5h 38% · 31m stale');
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

test('summarizeNodeQuota keeps failures visible with their failureKind', () => {
  // The whole point: "looked and could not tell" must not read the same as
  // "never told us". Today 2 of 3 providers fail on a typical machine, so a
  // fold that dropped failures would render most nodes as silent. Only a
  // snapshot with NO usable numbers at all degrades to the bare status word.
  const summary = summarizeNodeQuota(okQuota, 1_700_000)!;
  assert.equal(summary['codex-cli'], 'unavailable:cli-unavailable');
});

test('annotateQuotaSnapshotFreshness adds ageMs/stale without dropping fields', () => {
  const now = 1_700_000 + 31 * 60_000;
  const annotated = annotateQuotaSnapshotFreshness(okQuota, now);
  // Pure-additive: updatedAt (and every original field) survives.
  assert.equal(annotated['claude-cli'].updatedAt, 1_700_000);
  assert.equal(annotated['claude-cli'].session.usedPercent, 38.4);
  // Computed for the reader — no epoch-ms subtraction left to the coordinator.
  assert.equal(annotated['claude-cli'].ageMs, 31 * 60_000);
  assert.equal(annotated['claude-cli'].stale, true); // past the 30-min routing threshold
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
