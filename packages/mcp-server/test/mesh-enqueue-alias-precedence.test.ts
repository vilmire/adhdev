import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask, meshEnqueueBatch } from '../src/tools/mesh-tools.js';
import { getQueue } from '@adhdev/daemon-core';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';

/**
 * CANONICAL-FIRST ALIAS PRECEDENCE (2026-09-25).
 *
 * `canonicalizeMeshToolArgs` (validate-tool-args.ts) has always renamed an
 * alias to its canonical key with "canonical already present wins" — but its
 * output was used ONLY for validation and then discarded: `server.ts`
 * dispatched every mesh tool handler with the RAW args, both spellings
 * intact when a caller sent both. `normalizeEnqueueTaskArgs` and
 * `meshEnqueueBatch` (mesh-tools-queue.ts) then read several aliased fields
 * camelCase-first (`args.dependsOn || args.depends_on`, `args.missionId ||
 * args.mission_id`, etc.) — the OPPOSITE of the validator's own precedence —
 * so a caller sending both spellings with DIFFERENT values silently got the
 * alias value, not the canonical one the validator implied would win.
 *
 * The fix has two layers, both exercised here by calling the handlers
 * directly (the same signature `server.ts`'s `handler(meshCtx, args)` call
 * uses in production):
 *   1. `mesh-tools-queue.ts` now canonicalizes its own inputs
 *      (`canonicalizeEnqueueTaskEntry` per task entry,
 *      `canonicalizeMeshTopLevelArgs` for each tool's own top-level scope)
 *      before reading any aliased field — correct regardless of caller.
 *   2. `server.ts` also dispatches with `canonicalizeMeshToolArgs`'s output
 *      instead of the raw args, as defense in depth for every mesh tool.
 *      (2) is not exercised by this test file, which calls the handlers
 *      directly like every other enqueue test in this package — see
 *      mesh-enqueue-target-refresh.test.ts / mesh-enqueue-owned-paths-batch.test.ts
 *      for the same direct-call pattern.
 *
 * BREAK-ONCE: reverting mesh-tools-queue.ts's alias reads to camelCase-first
 * (i.e. removing the canonicalizeEnqueueTaskEntry / canonicalizeMeshTopLevelArgs
 * calls added 2026-09-25) turns every assertion below that compares against
 * a `*_canonical` value red — it would instead read the `*_alias` value.
 */

const NODE_A = 'node_alias_precedence_a';
const NODE_B = 'node_alias_precedence_b';

function nextMeshId(): string {
  return `mesh_alias_precedence_${randomUUID().slice(0, 8)}`;
}

function recordingTransport() {
  return {
    command: async (cmd: string, args?: Record<string, unknown>) => {
      if (isTurnIpcCommand(cmd)) return answerTurnIpc(cmd, args ?? {});
      return { success: true };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
}

function makeCtx(meshId: string) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_A, workspace: '/repo/a', daemonId: 'daemon_a' },
        { id: NODE_B, workspace: '/repo/b', daemonId: 'daemon_b' },
      ],
    },
    transport: recordingTransport(),
  } as any;
}

test('mesh_enqueue_task: canonical snake_case wins over camelCase alias when both are sent with different values', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'canonical-first probe',
    difficulty: 'easy',
    depends_on: [], dependsOn: ['should-never-be-read'],
    target_node_id: NODE_A, targetNodeId: NODE_B,
    owned_paths: ['src/canonical.ts'], ownedPaths: ['src/alias.ts'],
    thinking_level: 'high', thinkingLevel: 'low',
    max_retries: 3, maxRetries: 99,
    required_tags: ['os=canonical'], requiredTags: ['os=alias'],
  } as any));

  assert.equal(res.code, undefined, `unexpected failure: ${res.code} — ${res.error}`);
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_A, 'target_node_id (canonical) must win over targetNodeId (alias)');

  const row: any = getQueue(meshId).find((r: any) => r.id === res.taskId);
  assert.ok(row, 'enqueued task must be in the queue');
  assert.deepEqual(
    row.ownedPaths?.paths?.map((e: any) => e.path),
    ['src/canonical.ts'],
    'owned_paths (canonical) must win over ownedPaths (alias)',
  );
});

test('mesh_enqueue_task: canonical mission_id wins over camelCase missionId alias', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);

  // No mission is created, so both spellings deliberately point at
  // NON-existent ids — the tool rejects loudly on an unresolvable mission_id
  // (MISSION-UPSERT-SILENT-CREATE), which is itself proof of which spelling
  // was read: the error must name the CANONICAL value, never the alias.
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'mission alias probe',
    difficulty: 'easy',
    mission_id: 'mission_canonical_probe', missionId: 'mission_alias_probe',
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'mission_not_found');
  assert.equal(res.extra?.missionId ?? res.missionId, 'mission_canonical_probe', 'the rejection must name the canonical mission_id, not the camelCase alias');
});

test('mesh_enqueue_batch: canonical wins at both the batch top level and inside each task entry', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    // Top-level scope: mission_id vs missionId (batchMissionId).
    mission_id: 'mission_batch_top_canonical', missionId: 'mission_batch_top_alias',
    tasks: [
      {
        ref: 'solo',
        message: 'batch alias probe',
        difficulty: 'easy',
        // Task-entry scope: same field names, different alias table (`tasks`
        // scope), must independently resolve canonical-first.
        target_node_id: NODE_A, targetNodeId: NODE_B,
        depends_on: [], dependsOn: ['should-never-be-read'],
      },
    ],
  } as any));

  // Both spellings of mission_id point at missions that do not exist, so the
  // batch-level existence check fires first — same proof-by-rejection as above.
  assert.equal(res.success, false);
  assert.equal(res.code, 'mission_not_found');
  assert.equal(res.missionId, 'mission_batch_top_canonical', 'batch-level mission_id (canonical) must win over missionId (alias)');
});

test('mesh_enqueue_batch: task-entry target_node_id (canonical) wins over targetNode alias, independent of mission checks', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      {
        ref: 'solo',
        message: 'batch task-scope alias probe',
        difficulty: 'easy',
        target_node_id: NODE_A, targetNodeId: NODE_B,
      },
    ],
  } as any));

  assert.equal(res.code, undefined, `unexpected failure: ${res.code} — ${res.error}`);
  assert.equal(res.success, true);
  assert.equal(res.enqueued, 1);
  const task = res.tasks?.[0];
  assert.equal(task?.targetNodeId, NODE_A, 'per-task target_node_id (canonical) must win over targetNodeId (alias)');
});
