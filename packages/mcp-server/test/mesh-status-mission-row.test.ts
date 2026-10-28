import assert from 'node:assert/strict';
import test from 'node:test';

import { compactStatusMissionRow } from '../src/tools/mesh-status-sections.js';

// Structured missions (design 2026-10-28 §7): mesh_status shows summary (fallback goalPreview) + open decision count.
test('compact status row: summary replaces goalPreview and the open decision count is surfaced', () => {
  const row = compactStatusMissionRow({
    id: 'm1', title: 'T', status: 'active', goalPreview: 'long goal start', goalTruncated: true,
    summary: 'one line state', openItems: { remaining: 2, live_check: 0, decision: 3, evidence: 0 },
  });
  assert.equal(row.summary, 'one line state');
  assert.equal(row.goalPreview, undefined);
  assert.equal(row.goalTruncated, undefined);
  assert.equal(row.openDecisions, 3);
  // only the non-zero kinds are kept (evidence and zeros add no bytes to every poll)
  assert.deepEqual(row.openItems, { remaining: 2, decision: 3 });
});

test('compact status row: no summary keeps goalPreview; zero decisions adds no count; legacy rows pass through', () => {
  const noSummary = compactStatusMissionRow({ id: 'm', goalPreview: 'g', goalTruncated: false, openItems: { remaining: 1, live_check: 0, decision: 0, evidence: 0 } });
  assert.equal(noSummary.goalPreview, 'g');
  assert.equal(noSummary.openDecisions, undefined);
  assert.deepEqual(noSummary.openItems, { remaining: 1 });
  const nothingOpen = compactStatusMissionRow({ id: 'm', goalPreview: 'g', openItems: { remaining: 0, live_check: 0, decision: 0, evidence: 0 } });
  assert.equal(nothingOpen.openItems, undefined);
  const legacy = { id: 'm', title: 'T', goalPreview: 'g', goalTruncated: false };
  assert.deepEqual(compactStatusMissionRow(legacy), legacy);
});
