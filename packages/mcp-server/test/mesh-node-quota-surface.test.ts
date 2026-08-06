import assert from 'node:assert/strict';
import test from 'node:test';

import { compactMeshStatusNode, minimalCompactNode, summarizeNodeQuota } from '../src/tools/mesh-compact.js';
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

test('summarizeNodeQuota folds ok windows to a terse session/weekly pair', () => {
  const summary = summarizeNodeQuota(okQuota)!;
  assert.equal(summary['claude-cli'], '38%/12%');
});

test('summarizeNodeQuota keeps failures visible with their failureKind', () => {
  // The whole point: "looked and could not tell" must not read the same as
  // "never told us". Today 2 of 3 providers fail on a typical machine, so a
  // fold that dropped failures would render most nodes as silent.
  const summary = summarizeNodeQuota(okQuota)!;
  assert.equal(summary['codex-cli'], 'unavailable:cli-unavailable');
});

test('summarizeNodeQuota returns undefined for a node that reported nothing', () => {
  assert.equal(summarizeNodeQuota(undefined), undefined);
  assert.equal(summarizeNodeQuota({}), undefined);
  assert.equal(summarizeNodeQuota('nonsense'), undefined);
});

test('compactMeshStatusNode folds quota instead of dropping or inlining it', () => {
  const compacted = compactMeshStatusNode({ nodeId: 'n1', health: 'online', quota: okQuota });
  assert.deepEqual(compacted.quota, {
    'claude-cli': '38%/12%',
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
