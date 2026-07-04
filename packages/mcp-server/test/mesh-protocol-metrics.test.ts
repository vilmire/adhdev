import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizePendingEventProtocolMetrics } from '../src/tools/mesh-tools-status.js';

// T7 (B4): mesh_status surfaces mesh-protocol-v2 adoption metrics derived from the
// pending events drained in that call. summarizePendingEventProtocolMetrics is the
// pure core of that exposure — a read-only fold over the drained batch.

test('summarizePendingEventProtocolMetrics returns null for an empty drain', () => {
  assert.equal(summarizePendingEventProtocolMetrics([]), null);
  assert.equal(summarizePendingEventProtocolMetrics(undefined as unknown as any[]), null);
});

test('counts v2-stamped events and reports the adoption ratio', () => {
  const metrics = summarizePendingEventProtocolMetrics([
    { protocolVersion: '2.0', scope: 'unicast' },
    { protocolVersion: '2.0', scope: 'broadcast' },
    { /* v1 — unstamped */ },
    { protocolVersion: '2.0', scope: 'unicast' },
  ]);
  assert.ok(metrics);
  assert.equal(metrics.total, 4);
  assert.equal(metrics.v2, 3);
  assert.equal(metrics.v1, 1);
  assert.equal(metrics.v2Ratio, 0.75);
});

test('breaks down v2 events by scope (unspecified when a v2 event omits scope)', () => {
  const metrics = summarizePendingEventProtocolMetrics([
    { protocolVersion: '2.0', scope: 'unicast' },
    { protocolVersion: '2.0', scope: 'unicast' },
    { protocolVersion: '2.0', scope: 'system' },
    { protocolVersion: '2.0' },
  ]);
  assert.ok(metrics);
  assert.deepEqual(metrics.scopes, { unicast: 2, system: 1, unspecified: 1 });
});

test('all-v1 batch reports 0 ratio and an empty scope map (backward compatible)', () => {
  const metrics = summarizePendingEventProtocolMetrics([{}, {}, {}]);
  assert.ok(metrics);
  assert.equal(metrics.total, 3);
  assert.equal(metrics.v2, 0);
  assert.equal(metrics.v1, 3);
  assert.equal(metrics.v2Ratio, 0);
  assert.deepEqual(metrics.scopes, {});
});
