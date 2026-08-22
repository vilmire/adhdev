// STALE-SNAPSHOT-TARGET-REJECT — mesh_enqueue_task / mesh_enqueue_batch must
// refresh the mesh snapshot from the daemon BEFORE validating target_node_id.
//
// Live symptom (2026-08-22): a worktree node cloned after the coordinator's MCP
// process started was fully registered (meshes.json + daemon inline cache +
// worktree_bootstrap_complete notification), yet mesh_enqueue_task with
// target_node_id pinned to it hard-failed with target_node_not_found and an
// availableNodeIds list missing the node. Every other membership-reading tool
// calls refreshMeshFromDaemon first; enqueue alone validated against the frozen
// startup snapshot. The batch path is worse: it is atomic, so one stale-target
// rejection rolls back ALL entries.
//
// These tests pin the fix: a target known to the daemon but absent from the
// MCP process's (stale) snapshot must validate. Reverting the
// refreshMeshFromDaemon call in meshEnqueueTask/meshEnqueueBatch turns them red.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { meshEnqueueBatch, meshEnqueueTask } from '../src/tools/mesh-tools.js';

const NODE_BASE = 'node_base_stale_snapshot';
const NODE_NEW = 'node_cloned_after_mcp_start';

function nextMeshId(): string {
  return `mesh_enqueue_refresh_${randomUUID().slice(0, 8)}`;
}

// The coordinator's snapshot holds ONLY the base node (frozen at MCP process
// start); the daemon's get_mesh already reports the post-start clone.
function makeCtx(meshId: string) {
  const commands: Array<{ cmd: string; args: any }> = [];
  const baseNode = { id: NODE_BASE, workspace: '/repo/base', daemonId: 'daemon_local' };
  const newNode = {
    id: NODE_NEW,
    workspace: '/repo/worktree',
    daemonId: 'daemon_local',
    isLocalWorktree: true,
    worktreeBranch: 'feat/new',
    clonedFromNodeId: NODE_BASE,
  };
  const transport = {
    commands,
    command: async (cmd: string, args: any) => {
      commands.push({ cmd, args });
      if (cmd === 'get_mesh') {
        return { success: true, mesh: { id: meshId, name: 't', nodes: [baseNode, newNode], updatedAt: '2026-08-22T00:00:00.000Z' } };
      }
      return { success: true };
    },
    getStatus: async () => ({ sessions: [] }),
  } as any;
  const ctx = {
    mesh: { id: meshId, name: 't', nodes: [{ ...baseNode }] },
    transport,
  } as any;
  return { ctx, commands };
}

test('mesh_enqueue_task accepts a target the daemon knows but the stale snapshot does not', async () => {
  const meshId = nextMeshId();
  const { ctx, commands } = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'work on the fresh worktree',
    target_node_id: NODE_NEW,
    difficulty: 'easy',
  } as any));

  assert.ok(
    commands.some(c => c.cmd === 'get_mesh'),
    'enqueue must refresh the snapshot from the daemon before validating the target',
  );
  assert.equal(res.code, undefined, `unexpected failure code: ${res.code} — ${res.error}`);
  assert.equal(res.success, true);
  assert.equal(res.targetNodeId, NODE_NEW);
});

test('mesh_enqueue_batch accepts a pinned target the daemon knows but the stale snapshot does not', async () => {
  const meshId = nextMeshId();
  const { ctx, commands } = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueBatch(ctx, {
    tasks: [
      { ref: 'isolated', message: 'work on the fresh worktree', target_node_id: NODE_NEW, difficulty: 'easy' },
    ],
  } as any));

  assert.ok(
    commands.some(c => c.cmd === 'get_mesh'),
    'batch enqueue must refresh the snapshot from the daemon before validating targets',
  );
  assert.equal(res.code, undefined, `unexpected failure code: ${res.code} — ${res.error}`);
  assert.equal(res.success, true);
  assert.equal(res.enqueued, 1);
});

test('CONTROL: a target no daemon knows still fails loudly after the refresh', async () => {
  const meshId = nextMeshId();
  const { ctx } = makeCtx(meshId);

  const res = JSON.parse(await meshEnqueueTask(ctx, {
    message: 'work nowhere',
    target_node_id: 'node_truly_unknown',
    difficulty: 'easy',
  } as any));

  assert.equal(res.success, false);
  assert.equal(res.code, 'target_node_not_found');
  assert.ok(!res.availableNodeIds.includes('node_truly_unknown'));
});
