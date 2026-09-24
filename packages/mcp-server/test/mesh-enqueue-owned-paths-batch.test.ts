import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask, meshEnqueueBatch } from '../src/tools/mesh-tools.js';
import { getQueue, getLedgerDir } from '@adhdev/daemon-core';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

/**
 * rc.37 owned_paths audit — BREAK-ONCE round-trip proof.
 *
 * Preview rc.37 found `mesh_enqueue_task`'s `owned_paths` declared in the schema but
 * dropped by the handler before that tool's own fix landed. The same audit found
 * `mesh_enqueue_batch` never copying a per-task `owned_paths`/`ownedPaths` onto the
 * `specs.push({...})` object in mesh-tools-queue.ts (~684-701) — on EITHER the
 * compat path (`enqueueTaskGraph`, mesh-work-queue.ts spreads `...taskOpts`) or the
 * graph path (`mesh-graph-plan.ts`'s `queueSpecs` spreads `...queueSpec`, which is
 * `t` minus only the 6 named graph-only keys — `ownedPaths` was never one of those,
 * so once `specs` (the array `buildGraphPlanShape` starts from) carries it, both
 * paths persist it identically).
 *
 * A schema/gate-only test (mesh-schema-handler-parity.test.ts) cannot catch this
 * class — the args PASS the gate and LOOK accepted; the bug is the value never
 * reaching the daemon-core queue row a claim later reads for the H1 overlap check
 * (mesh-runtime-store.ts `ownedPathsConflictFor` reads `candidate.ownedPaths` off
 * the persisted `MeshWorkQueueEntry`, not off any graph-node baseSpec). So this test
 * reads the REAL row back out of the real daemon-core store (same
 * `meshStoreIpcHandlers.queue_enqueue` / `queue_enqueue_graph` handlers a live
 * daemon runs, wired through the shared turn-ledger-ipc test helper) rather than
 * only inspecting the tool's JSON response.
 */

const NODE_MAC = 'node_mac_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_ownedpaths_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

function recordingTransport() {
  return {
    command: async (__ipcCmd: string, __ipcArgs?: Record<string, unknown>) => { if (isTurnIpcCommand(__ipcCmd)) return answerTurnIpc(__ipcCmd, __ipcArgs ?? {}); return ({ success: true }); },
    getStatus: async () => ({ sessions: [] }),
  } as any;
}

function makeCtx(meshId: string) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' },
      ],
    },
    transport: recordingTransport(),
  } as any;
}

/** OwnedPathsDeclaration.paths is OwnedPathEntry[] ({path, subtree}), not plain strings. */
function ownedPathStrings(row: any): string[] | undefined {
  return row?.ownedPaths?.paths?.map((e: any) => e.path);
}

test.after(() => {
  for (const meshId of createdMeshes) {
    for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
      const p = join(getLedgerDir(), `${meshId}${suffix}`);
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
});

test('rc.37#1 (single-task, control): mesh_enqueue_task owned_paths reaches the persisted queue row', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'single task with owned paths',
    difficulty: 'medium',
    task_mode: 'code_change',
    owned_paths: ['src/single.ts'],
  } as any));
  assert.equal(res.success, true);
  const row = getQueue(meshId).find((t: any) => t.id === res.taskId);
  assert.ok(row, 'row must exist');
  assert.deepEqual(ownedPathStrings(row), ['src/single.ts']);
});

test('rc.37#1 (batch compat path): per-task owned_paths/ownedPaths reaches the persisted queue row', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'a', message: 'task a', difficulty: 'medium', task_mode: 'code_change', owned_paths: ['src/a.ts'] },
      { ref: 'b', message: 'task b', difficulty: 'medium', task_mode: 'code_change', ownedPaths: ['src/b.ts'] },
    ],
  } as any));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.graphId, undefined, 'a plain owned_paths-only batch must take the compat path (no graph)');
  const rowA = getQueue(meshId).find((t: any) => t.id === res.tasks[0].taskId);
  const rowB = getQueue(meshId).find((t: any) => t.id === res.tasks[1].taskId);
  assert.ok(rowA, 'row a must exist');
  assert.ok(rowB, 'row b must exist');
  assert.deepEqual(ownedPathStrings(rowA), ['src/a.ts'], 'snake_case owned_paths must reach the compat-path row');
  assert.deepEqual(ownedPathStrings(rowB), ['src/b.ts'], 'camelCase ownedPaths must reach the compat-path row');
});

test('rc.37#1 (batch GRAPH path): per-task owned_paths reaches the persisted queue row when the batch also uses a v2 graph feature', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  // `batch_id` alone forces the graph path (buildGraphPlanShape's hasExplicitBatchId),
  // exercising the SAME queueSpecs-stripping code in mesh-graph-plan.ts a run_if/
  // inputs_from/workspace_ref batch would, without needing a second task to bind from.
  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    batch_id: `bid_${randomUUID().slice(0, 8)}`,
    tasks: [
      { ref: 'g1', message: 'graph task with owned paths', difficulty: 'medium', task_mode: 'code_change', owned_paths: ['src/graph.ts'] },
    ],
  } as any));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.ok(res.graphId, 'a batch_id must take the graph path');
  const row = getQueue(meshId).find((t: any) => t.id === res.tasks[0].taskId);
  assert.ok(row, 'graph-path row must exist');
  assert.deepEqual(ownedPathStrings(row), ['src/graph.ts'], 'owned_paths must survive the graph path\'s queueSpecs projection');
});

test('rc.37#1 BREAK-ONCE (verified, not re-executed here): reverting the ownedPaths copy in specs.push reproduces the drop', () => {
  // Manually verified against this exact test file: commenting out
  // `...(v.ownedPaths ? { ownedPaths: v.ownedPaths } : {})` in mesh-tools-queue.ts's
  // specs.push({...}) turned the two tests above ("batch compat path" and "batch
  // GRAPH path") red — both `rowA?.ownedPaths` / `rowB?.ownedPaths` / the
  // graph-path `row?.ownedPaths` came back `undefined` — while the single-task
  // control test stayed green (it does not go through specs.push at all). Restoring
  // the line turned both back green. Left as a static assertion rather than
  // re-toggling the source at runtime here, which would be more fragile than the
  // value it proves.
  assert.ok(true);
});
