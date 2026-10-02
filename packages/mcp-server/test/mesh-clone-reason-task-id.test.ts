import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshCloneNode } from '../src/tools/mesh-tools.js';
import { MESH_CLONE_NODE_TOOL } from '../src/tools/mesh-tool-schemas-admin.js';

// The daemon refuses a clone shortly after an idle-mission reminder unless the
// request carries `reason` or `taskId`. The tool exposed neither, so a coordinator
// could only satisfy the guard by enqueueing the task first — which left it
// untargeted long enough for the base node to claim it and run in the main
// checkout (2026-10-02 demo mesh).

function ctxCapturing(seen: Array<Record<string, unknown>>) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const source = { id: 'node-src', workspace: '/repo/main', repoRoot: '/repo', daemonId: 'd1', userOverrides: {}, policy: {} };
  const mesh = { id: 'mesh-x', name: 'x', repoIdentity: 'r', policy: {}, coordinator: {}, createdAt: '', updatedAt: '', nodes: [source] };
  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_d, command, args = {}) => {
    if (command === 'plan_mesh_onboarding') return { success: true, plan: { operation: 'clone_worktree' } };
    if (command === 'clone_mesh_node') {
      seen.push(args);
      return { success: true, node: { id: 'node-new', workspace: '/repo/wt', daemonId: 'd1', isLocalWorktree: true, worktreeBranch: 'feat/a', clonedFromNodeId: 'node-src', userOverrides: {}, policy: {} } };
    }
    if (command === 'git_status') return { success: true, status: { isGitRepo: true, branch: 'main' } };
    throw new Error(`unexpected mesh command: ${command}`);
  };
  return { mesh, transport };
}

test('mesh_clone_node schema exposes reason and task_id', () => {
  const props = MESH_CLONE_NODE_TOOL.inputSchema.properties as Record<string, unknown>;
  assert.ok(props.reason, 'reason');
  assert.ok(props.task_id, 'task_id');
});

test('mesh_clone_node forwards reason / task_id to clone_mesh_node', async () => {
  const seen: Array<Record<string, unknown>> = [];
  await meshCloneNode(ctxCapturing(seen) as any, { source_node_id: 'node-src', branch: 'feat/a', reason: 'user asked for two parallel features', task_id: 't-1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.reason, 'user asked for two parallel features');
  assert.equal(seen[0]!.taskId, 't-1');
});
