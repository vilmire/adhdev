import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { meshLedgerQuery } from '../src/tools/mesh-tools.js';
import { appendLedgerEntry, getLedgerDir, loadConfig } from '@adhdev/daemon-core';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

const SELF_MACHINE_ID = loadConfig().machineId;

function makeCtx(meshId: string) {
  return {
    mesh: { id: meshId, nodes: [] },
    transport: { command: async () => ({ success: false }) },
    localDaemonId: SELF_MACHINE_ID,
    localMachineId: SELF_MACHINE_ID,
  } as any;
}

function cleanup(meshId: string) {
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
