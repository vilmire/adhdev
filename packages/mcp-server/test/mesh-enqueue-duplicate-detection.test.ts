import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { meshEnqueueTask } from '../src/tools/mesh-tools.js';
import { getQueue, getLedgerDir } from '@adhdev/daemon-core';

// MESH-PRIMITIVES-GAPS WT-C / G4 — enqueue duplicate detection.
//   TASKBUBBLE-DUP structural defense: enqueueing a task whose (normalized message +
//   resolved target) matches an in-flight (pending/assigned) task is flagged. Default is
//   warn-only (task still enqueues, response carries duplicateSuspect); block_duplicate=true
//   refuses; allow_duplicate=true suppresses the check.

const NODE_MAC = 'node_mac_base';
const NODE_WIN = 'node_win_base';

const createdMeshes: string[] = [];
function nextMeshId(): string {
  const id = `mesh_g4dup_${randomUUID().slice(0, 8)}`;
  createdMeshes.push(id);
  return id;
}

function recordingTransport() {
  return {
    command: async () => ({ success: true }),
    getStatus: async () => ({ sessions: [] }),
  } as any;
}

function makeCtx(meshId: string) {
  return {
    mesh: {
      id: meshId,
      nodes: [
        { id: NODE_MAC, workspace: '/repo/mac', daemonId: 'daemon_mac' },
        { id: NODE_WIN, workspace: '/repo/win', daemonId: 'daemon_win' },
      ],
    },
    transport: recordingTransport(),
  } as any;
}

test.after(() => {
  for (const meshId of createdMeshes) {
    for (const suffix of ['.queue.json', '.jsonl', '.pending-events.jsonl']) {
      const p = join(getLedgerDir(), `${meshId}${suffix}`);
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
});

test('G4 default warn-only: a same-message re-enqueue still enqueues but flags duplicateSuspect', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const first = JSON.parse(await meshEnqueueTask(ctx, { message: 'fix the bug',
    difficulty: 'medium',
} as any));
  assert.equal(first.success, true);
  assert.equal(first.duplicateSuspect, undefined, 'first enqueue is not a duplicate');

  const second = JSON.parse(await meshEnqueueTask(ctx, { message: '  Fix   the   bug  ',
    difficulty: 'medium',
} as any));
  assert.equal(second.success, true, 'warn-only: the duplicate still enqueues');
  assert.equal(second.duplicateSuspect?.taskId, first.taskId, 'flags the in-flight original (normalized match)');
  assert.equal(getQueue(meshId).length, 2, 'both tasks are present (warn-only did not drop)');
});

test('G4 block_duplicate: refuses the second enqueue with code duplicate_suspect', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const first = JSON.parse(await meshEnqueueTask(ctx, { message: 'deploy preview',
    difficulty: 'medium',
} as any));
  assert.equal(first.success, true);
  const blocked = JSON.parse(await meshEnqueueTask(ctx, { message: 'deploy preview', block_duplicate: true,
    difficulty: 'medium',
} as any));
  assert.equal(blocked.success, false);
  assert.equal(blocked.code, 'duplicate_suspect');
  assert.equal(blocked.duplicateOf?.taskId, first.taskId);
  assert.equal(getQueue(meshId).length, 1, 'blocked enqueue must not write a second task');
});

test('G4 allow_duplicate: suppresses the check entirely', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  await meshEnqueueTask(ctx, { message: 'same task',
    difficulty: 'medium',
} as any);
  const allowed = JSON.parse(await meshEnqueueTask(ctx, { message: 'same task', allow_duplicate: true,
    difficulty: 'medium',
} as any));
  assert.equal(allowed.success, true);
  assert.equal(allowed.duplicateSuspect, undefined, 'allow_duplicate silences the warning');
  assert.equal(getQueue(meshId).length, 2);
});

test('G4 target-scoped: same message to DIFFERENT nodes is not a duplicate', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const a = JSON.parse(await meshEnqueueTask(ctx, { message: 'per-node task', target_node: NODE_MAC,
    difficulty: 'medium',
} as any));
  assert.equal(a.success, true);
  const b = JSON.parse(await meshEnqueueTask(ctx, { message: 'per-node task', target_node: NODE_WIN,
    difficulty: 'medium',
} as any));
  assert.equal(b.success, true);
  assert.equal(b.duplicateSuspect, undefined, 'same message pinned to a different node is not a duplicate');
});

test('G4 target-scoped: same message to the SAME node IS a duplicate', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const a = JSON.parse(await meshEnqueueTask(ctx, { message: 'node task', target_node: NODE_MAC,
    difficulty: 'medium',
} as any));
  const b = JSON.parse(await meshEnqueueTask(ctx, { message: 'node task', target_node: NODE_MAC,
    difficulty: 'medium',
} as any));
  assert.equal(b.success, true);
  assert.equal(b.duplicateSuspect?.taskId, a.taskId);
});

test('G4/G6/G7/P3 echo: priority, notBefore, and maxRetries round-trip in the response', async () => {
  const meshId = nextMeshId();
  const ctx = makeCtx(meshId);
  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'scheduled urgent capped task',
    priority: 'high',
    not_before: 60_000, // relative ms → held in the future
    max_retries: 3,
    difficulty: 'medium',
  } as any));
  assert.equal(res.success, true);
  assert.equal(res.priority, 'high');
  assert.equal(res.maxRetries, 3);
  assert.ok(res.notBefore, 'notBefore echoed as a resolved ISO timestamp');
  assert.ok(Date.parse(res.notBefore) > Date.now(), 'a relative not_before resolves to the future');
  const row = getQueue(meshId).find((t: any) => t.id === res.taskId);
  assert.equal(row?.priority, 'high');
  assert.equal(row?.maxRetries, 3);
  assert.ok(row?.notBefore);
});
