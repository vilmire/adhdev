/**
 * mesh_send_task delivery_mode contract (axis A of M-INPUT-DELIVERY-MODE-AND-QUEUE).
 *
 * Delivery mode decides what happens when the target session is BUSY:
 *   'when_idle'  (default) — queue, deliver on the next idle transition
 *   'interrupt'            — abort the running turn, then deliver
 *
 * The properties pinned here are the ones whose regression would recreate the
 * defect this feature exists to remove — a steering attempt that reports
 * success while the session actually runs to completion on the old prompt:
 *
 *   (a) the DEFAULT stays when_idle and is never inferred as interrupt
 *   (b) an unsupported provider is REJECTED, never silently downgraded
 *   (c) the option is described honestly (the turn is discarded)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MESH_SEND_TASK_TOOL } from '../src/tools/mesh-tool-schemas.js';
import { resolveDeliveryDecision, normalizeDeliveryMode, DEFAULT_DELIVERY_MODE } from '@adhdev/daemon-core';

// ─── (1) The schema declares the option ──────────────────────────────────────

test('mesh_send_task schema exposes delivery_mode with exactly when_idle|interrupt', () => {
  const schema = MESH_SEND_TASK_TOOL.inputSchema as any;
  assert.deepEqual(schema.properties.delivery_mode.enum, ['when_idle', 'interrupt']);
  assert.deepEqual(schema.properties.deliveryMode.enum, ['when_idle', 'interrupt']);
});

test('delivery_mode is OPTIONAL — omitting it must remain valid (default when_idle)', () => {
  const schema = MESH_SEND_TASK_TOOL.inputSchema as any;
  assert.ok(!schema.required.includes('delivery_mode'));
  assert.ok(!schema.required.includes('deliveryMode'));
});

test('★ the schema warns that an interrupt DISCARDS in-flight work', () => {
  // The name and description must let a caller know the running turn is lost
  // before it picks the option — 'immediate' was rejected as a name precisely
  // because it reads like a harmless overlay.
  const desc = (MESH_SEND_TASK_TOOL.inputSchema as any).properties.delivery_mode.description as string;
  assert.match(desc, /DISCARDED|discard|lost/i);
  assert.match(desc, /REJECTED|reject/i, 'must state that an unsupported provider is rejected, not silently downgraded');
  assert.match(desc, /when_idle/, 'must name the default');
});

// ─── (2) The behaviour behind it ─────────────────────────────────────────────

test('★ (a) default delivery mode is when_idle', () => {
  assert.equal(DEFAULT_DELIVERY_MODE, 'when_idle');
  assert.equal(normalizeDeliveryMode(undefined).mode, 'when_idle');
});

test('★ (a) a busy session with no delivery_mode still queues', () => {
  const r = resolveDeliveryDecision('generating', { kind: 'task' });
  assert.equal(r.decision, 'queued');
});

test("★ (a) an unrecognized mode (e.g. 'immediate') degrades to when_idle AND is reported", () => {
  const r = normalizeDeliveryMode('immediate');
  assert.equal(r.mode, 'when_idle');
  assert.equal(r.unrecognized, 'immediate');
});

test('★ (b) interrupt on an unsupported provider is REJECTED, not queued', () => {
  const r = resolveDeliveryDecision('generating', {
    kind: 'task',
    deliveryMode: 'interrupt',
    interruptSupported: false,
  });
  assert.equal(r.decision, 'rejected');
  assert.notEqual(r.decision, 'queued');
  assert.equal(r.reason, 'interrupt_unsupported_for_provider');
});

test('(b) interrupt on a supported provider yields the interrupt decision', () => {
  const r = resolveDeliveryDecision('generating', {
    kind: 'task',
    deliveryMode: 'interrupt',
    interruptSupported: true,
  });
  assert.equal(r.decision, 'interrupt');
});

test('interrupt does not change idle or terminal handling', () => {
  const idle = resolveDeliveryDecision('idle', { kind: 'task', deliveryMode: 'interrupt', interruptSupported: true });
  assert.equal(idle.decision, 'immediate');
  const dead = resolveDeliveryDecision('stopped', { kind: 'task', deliveryMode: 'interrupt', interruptSupported: true });
  assert.equal(dead.decision, 'rejected');
  assert.equal(dead.reason, 'session_stopped_terminal');
});
