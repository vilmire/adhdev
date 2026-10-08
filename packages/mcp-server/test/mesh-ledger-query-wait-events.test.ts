import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { meshLedgerQuery, meshTaskHistory, ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';
import { getLedgerDir, loadConfig } from '@adhdev/daemon-core';
import { __clearLocalRecordsForTests } from '@adhdev/daemon-core';
import { __clearMeshPendingEventsForTests } from './helpers/pending-notices.js';
import { makeFakeTurnIpcTransport } from './fake-turn-ipc-transport.js';

import { seedLocalRecord } from './helpers/local-records.js';
const SELF_MACHINE_ID = loadConfig().machineId;

function makeCtx(meshId: string) {
  return {
    mesh: { id: meshId, nodes: [] },
    // C-W9b: meshLedgerQuery now reads via the `ledger_query` IPC command
    // (see fake-turn-ipc-transport.ts's PENDING_C_W9A_HANDLERS — no landed
    // daemon-side handler yet, so the fixture calls the same in-process
    // `readLocalRecords`/`getLedgerSummary` this test seeds via `appendLedgerEntry`).
    transport: makeFakeTurnIpcTransport(),
    localDaemonId: SELF_MACHINE_ID,
    localMachineId: SELF_MACHINE_ID,
  } as any;
}

function cleanup(meshId: string) {
  __clearLocalRecordsForTests(meshId);
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
    seedLocalRecord(meshId, { kind: 'task_dispatched', nodeId: 'mach_alpha', payload: { i: 0 } });
    seedLocalRecord(meshId, { kind: 'task_failed', nodeId: 'mach_alpha', payload: { i: 1 } });
    seedLocalRecord(meshId, { kind: 'task_failed', nodeId: 'mach_beta', payload: { i: 2 } });
    seedLocalRecord(meshId, { kind: 'task_completed', nodeId: 'mach_alpha', payload: { i: 3 } });

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
    seedLocalRecord(meshId, { kind: 'task_dispatched', payload: {} });
    const res = JSON.parse(await meshLedgerQuery(makeCtx(meshId), { tail: 99999 }));
    assert.equal(res.query.tail, 500);
    // default tail when unspecified is 50.
    const res2 = JSON.parse(await meshLedgerQuery(makeCtx(meshId), {}));
    assert.equal(res2.query.tail, 50);
  } finally {
    cleanup(meshId);
  }
});

// 2026-10-08: mesh_task_history absorbed the kind-list / since / node axes; mesh_ledger_query
// is a deprecated alias for one release.
test('mesh_task_history composes kind list + node + since (the absorbed mesh_ledger_query axes)', async () => {
  const meshId = 'mesh_task_history_axes';
  cleanup(meshId);
  try {
    seedLocalRecord(meshId, { kind: 'task_dispatched', nodeId: 'mach_alpha', payload: { i: 0 } });
    seedLocalRecord(meshId, { kind: 'task_failed', nodeId: 'mach_alpha', payload: { i: 1 } });
    seedLocalRecord(meshId, { kind: 'task_failed', nodeId: 'mach_beta', payload: { i: 2 } });
    seedLocalRecord(meshId, { kind: 'task_completed', nodeId: 'mach_alpha', payload: { i: 3 } });

    const alphaTerminal = JSON.parse(await meshTaskHistory(makeCtx(meshId), {
      kind: 'task_failed, task_completed',
      node: 'daemon_mach_alpha',
    }));
    assert.equal(alphaTerminal.payloadMode, 'compact');
    assert.equal(alphaTerminal.count, 2);
    assert.deepEqual(alphaTerminal.entries.map((e: any) => e.payload.i), [1, 3]);
    assert.deepEqual(alphaTerminal.query, { kind: ['task_failed', 'task_completed'], node: 'daemon_mach_alpha', tail: 20 });

    // since in the future excludes everything; since in the past keeps everything.
    const future = JSON.parse(await meshTaskHistory(makeCtx(meshId), { since: new Date(Date.now() + 60_000).toISOString() }));
    assert.equal(future.count, 0);
    const past = JSON.parse(await meshTaskHistory(makeCtx(meshId), { since: String(Date.now() - 60_000) }));
    assert.equal(past.count, 4);

    // Tail clamps: compact 30 (20 past 50), verbose 500.
    assert.equal(JSON.parse(await meshTaskHistory(makeCtx(meshId), { tail: 40 })).query.tail, 30);
    assert.equal(JSON.parse(await meshTaskHistory(makeCtx(meshId), { tail: 99999 })).query.tail, 20);
    assert.equal(JSON.parse(await meshTaskHistory(makeCtx(meshId), { tail: 99999, verbose: true })).query.tail, 500);
  } finally {
    cleanup(meshId);
  }
});

test('mesh_ledger_query is a published deprecated alias that returns full payloads', async () => {
  const tool = ALL_MESH_TOOLS.find(t => t.name === 'mesh_ledger_query');
  assert.ok(tool, 'alias stays published for one release');
  assert.match(tool!.description, /^Deprecated alias of mesh_task_history/);
  const history = ALL_MESH_TOOLS.find(t => t.name === 'mesh_task_history')!;
  // Every alias argument is accepted by the surviving tool.
  for (const arg of Object.keys((tool!.inputSchema as any).properties)) {
    assert.ok(Object.prototype.hasOwnProperty.call((history.inputSchema as any).properties, arg), `mesh_task_history lacks ${arg}`);
  }

  const meshId = 'mesh_ledger_query_alias';
  cleanup(meshId);
  try {
    seedLocalRecord(meshId, { kind: 'task_completed', nodeId: 'mach_alpha', payload: { taskId: 't1', finalSummary: 'x'.repeat(1000) } });
    const res = JSON.parse(await meshLedgerQuery(makeCtx(meshId), {}));
    assert.equal(res.payloadMode, 'full');
    assert.equal(res.entries[0].payload.finalSummary.length, 1000);
  } finally {
    cleanup(meshId);
  }
});
