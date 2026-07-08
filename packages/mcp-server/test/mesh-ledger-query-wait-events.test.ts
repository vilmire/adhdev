import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { meshLedgerQuery, meshWaitEvents } from '../src/tools/mesh-tools.js';
import { appendLedgerEntry, getLedgerDir, queuePendingMeshCoordinatorEvent, loadConfig } from '@adhdev/daemon-core';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// The stdio MCP coordinator runs ON its own daemon/machine, so its localDaemonId is
// this machine's id — the same id an ownerless (self-fallback) terminal broadcast is
// stamped under. Use the real machineId so the machine-level self-fallback delivery
// (deliver an ownerless terminal event to a coordinator on the SAME machine, while a
// foreign-machine coordinator is still routed away — MAGI-REPLICA leak guard) resolves
// exactly as it does in production. A hard-coded foreign string here would model a
// coordinator on a different machine and (correctly) never receive refine:* events.
const SELF_MACHINE_ID = loadConfig().machineId;

// A plain-object transport (NOT an IpcTransport) makes drainCoordinatorPendingEvents
// take the in-process local drain path (drainPendingMeshCoordinatorEvents), so these
// tests exercise the real drain the reconcile loop uses without a live daemon.
function makeCtx(meshId: string) {
  return {
    mesh: { id: meshId, nodes: [] },
    transport: { command: async () => ({ success: false }) },
    localDaemonId: SELF_MACHINE_ID,
    localMachineId: SELF_MACHINE_ID,
  } as any;
}

function cleanup(meshId: string) {
  // Clear SQLite-primary state AND the JSONL export artifact — otherwise the
  // JSONL is re-imported on the next process/run and doubles the ledger.
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

test('mesh_ledger_query filters by kind, node, and tail (AND-composed)', async () => {
  const meshId = 'mesh_ledger_query_filters';
  cleanup(meshId);
  try {
    appendLedgerEntry(meshId, { kind: 'task_dispatched', nodeId: 'mach_alpha', payload: { i: 0 } });
    appendLedgerEntry(meshId, { kind: 'task_failed', nodeId: 'mach_alpha', payload: { i: 1 } });
    appendLedgerEntry(meshId, { kind: 'task_failed', nodeId: 'mach_beta', payload: { i: 2 } });
    appendLedgerEntry(meshId, { kind: 'task_completed', nodeId: 'mach_alpha', payload: { i: 3 } });

    // kind (comma list) + node compose as AND.
    const alphaTerminal = JSON.parse(await meshLedgerQuery(makeCtx(meshId), {
      kind: 'task_failed,task_completed',
      node: 'mach_alpha',
    }));
    assert.equal(alphaTerminal.count, 2);
    assert.equal(alphaTerminal.entries.every((e: any) => e.nodeId === 'mach_alpha'), true);
    assert.equal(alphaTerminal.entries.every((e: any) => e.kind !== 'task_dispatched'), true);

    // node filter is identity-form-agnostic.
    const prefixed = JSON.parse(await meshLedgerQuery(makeCtx(meshId), { node: 'daemon_mach_beta' }));
    assert.equal(prefixed.count, 1);
    assert.equal(prefixed.entries[0].payload.i, 2);

    // tail caps the most-recent N.
    const tailed = JSON.parse(await meshLedgerQuery(makeCtx(meshId), { tail: 1 }));
    assert.equal(tailed.count, 1);
    assert.equal(tailed.entries[0].payload.i, 3);
    assert.equal(tailed.query.tail, 1);
  } finally {
    cleanup(meshId);
  }
});

test('mesh_ledger_query clamps tail to 500 and echoes the resolved query', async () => {
  const meshId = 'mesh_ledger_query_clamp';
  cleanup(meshId);
  try {
    appendLedgerEntry(meshId, { kind: 'task_dispatched', payload: {} });
    const res = JSON.parse(await meshLedgerQuery(makeCtx(meshId), { tail: 99999 }));
    assert.equal(res.query.tail, 500);
    // default tail when unspecified is 50.
    const res2 = JSON.parse(await meshLedgerQuery(makeCtx(meshId), {}));
    assert.equal(res2.query.tail, 50);
  } finally {
    cleanup(meshId);
  }
});

test('mesh_wait_events returns immediately when events are already pending', async () => {
  const meshId = 'mesh_wait_events_immediate';
  cleanup(meshId);
  try {
    queuePendingMeshCoordinatorEvent({
      event: 'session:completed',
      meshId,
      nodeLabel: 'node-a',
      nodeId: 'node-a',
      metadataEvent: { source: 'test', event: 'session:completed' },
      queuedAt: Date.now(),
    });
    const started = Date.now();
    const res = JSON.parse(await meshWaitEvents(makeCtx(meshId), { timeoutMs: 30000 }));
    const elapsed = Date.now() - started;
    assert.equal(res.timedOut, false);
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].event, 'session:completed');
    // Also surfaced under the canonical pendingCoordinatorEvents key.
    assert.equal(res.pendingCoordinatorEvents.length, 1);
    // Immediate: must not have waited anywhere near the timeout.
    assert.equal(elapsed < 1000, true);
  } finally {
    cleanup(meshId);
  }
});

test('mesh_wait_events times out with an empty array when no events arrive', async () => {
  const meshId = 'mesh_wait_events_timeout';
  cleanup(meshId);
  try {
    const started = Date.now();
    // timeoutMs clamps up to the 1000ms floor.
    const res = JSON.parse(await meshWaitEvents(makeCtx(meshId), { timeoutMs: 10 }));
    const elapsed = Date.now() - started;
    assert.equal(res.timedOut, true);
    assert.deepEqual(res.events, []);
    assert.equal(res.pendingCoordinatorEvents, undefined);
    assert.equal(res.timeoutMs, 1000);
    // Honored the clamped floor rather than returning after 10ms.
    assert.equal(elapsed >= 900, true);
  } finally {
    cleanup(meshId);
  }
});

test('mesh_wait_events wakes up when an event arrives mid-wait', async () => {
  const meshId = 'mesh_wait_events_wake';
  cleanup(meshId);
  try {
    // Enqueue an event ~1.2s into a 5s wait; the poll loop (1s cadence) should
    // pick it up and return well before the deadline.
    setTimeout(() => {
      queuePendingMeshCoordinatorEvent({
        event: 'refine:completed',
        meshId,
        nodeLabel: 'node-b',
        nodeId: 'node-b',
        metadataEvent: { source: 'test', event: 'refine:completed' },
        queuedAt: Date.now(),
      });
    }, 1200);
    const started = Date.now();
    const res = JSON.parse(await meshWaitEvents(makeCtx(meshId), { timeoutMs: 5000 }));
    const elapsed = Date.now() - started;
    assert.equal(res.timedOut, false);
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].event, 'refine:completed');
    assert.equal(elapsed < 5000, true);
  } finally {
    cleanup(meshId);
  }
});
