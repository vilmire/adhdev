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

test('mesh_clone_node returns an accepted/async response instead of hiding a background clone behind a caller timeout', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const source = { id: 'node-src', workspace: '/repo/main', repoRoot: '/repo', daemonId: 'd1', userOverrides: {}, policy: {} };
  const backgroundClonedNode = {
    id: 'node-bg-clone',
    workspace: '/repo/.adhdev-worktrees/mesh-x/feat-bg',
    repoRoot: '/repo/.adhdev-worktrees/mesh-x/feat-bg',
    daemonId: 'd1',
    isLocalWorktree: true,
    worktreeBranch: 'feat/bg',
    clonedFromNodeId: 'node-src',
    userOverrides: {},
    policy: {},
  };
  const mesh = { id: 'mesh-x', name: 'x', repoIdentity: 'r', policy: {}, coordinator: {}, createdAt: '', updatedAt: '', nodes: [source] };

  transport.command = async (command) => {
    if (command === 'get_mesh') {
      return { success: true, mesh: { ...mesh, nodes: [source, backgroundClonedNode] } };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_d, command) => {
    if (command === 'plan_mesh_onboarding') {
      return { success: true, plan: { operation: 'clone_worktree' }, warnings: ['Source workspace has 1 uncommitted change(s).'] };
    }
    if (command === 'clone_mesh_node') {
      throw new Error('Daemon IPC mesh_command timed out after 120s (requestId=req-bg-1)');
    }
    if (command === 'git_status') {
      return { success: true, status: { isGitRepo: true, branch: 'main' } };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const parsed = JSON.parse(await meshCloneNode({ mesh, transport } as any, {
    source_node_id: 'node-src',
    branch: 'feat/bg',
  }));

  assert.equal(parsed.success, true);
  assert.equal(parsed.async, true);
  assert.equal(parsed.status, 'accepted');
  assert.equal(parsed.node?.id, 'node-bg-clone');
  assert.ok(mesh.nodes.some((n: any) => n.id === 'node-bg-clone'), 'recovered background clone node must be synced into ctx.mesh.nodes');
  assert.deepEqual(parsed.warnings, ['Source workspace has 1 uncommitted change(s).']);
});

test('mesh_clone_node does not treat arbitrary non-IPC timeout strings as recoverable clone timeouts', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const source = { id: 'node-src', workspace: '/repo/main', repoRoot: '/repo', daemonId: 'd1', userOverrides: {}, policy: {} };
  const mesh = { id: 'mesh-x', name: 'x', repoIdentity: 'r', policy: {}, coordinator: {}, createdAt: '', updatedAt: '', nodes: [source] };

  transport.command = async () => {
    throw new Error('get_mesh must not be called for non-IPC timeout');
  };
  transport.meshCommand = async (_d, command) => {
    if (command === 'plan_mesh_onboarding') {
      return { success: true, plan: { operation: 'clone_worktree' } };
    }
    if (command === 'clone_mesh_node') {
      throw new Error('git pre-worktree hook timed out while contacting internal mirror');
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  await assert.rejects(
    () => meshCloneNode({ mesh, transport } as any, { source_node_id: 'node-src', branch: 'feat/hook-err' }),
    /git pre-worktree hook timed out/,
  );
});

test('mesh_clone_node returns success:false with mesh_status instruction when IPC times out and get_mesh has no matching cloned node', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const source = { id: 'node-src', workspace: '/repo/main', repoRoot: '/repo', daemonId: 'd1', userOverrides: {}, policy: {} };
  const preExistingSameBranch = {
    id: 'node-preexisting',
    workspace: '/repo/wt-old',
    repoRoot: '/repo/wt-old',
    daemonId: 'd1',
    isLocalWorktree: true,
    worktreeBranch: 'feat/unverified',
    clonedFromNodeId: 'node-src',
    userOverrides: {},
    policy: {},
  };
  const wrongSourceNode = {
    id: 'node-other-src',
    workspace: '/repo/wt-other',
    repoRoot: '/repo/wt-other',
    daemonId: 'd1',
    isLocalWorktree: true,
    worktreeBranch: 'feat/unverified',
    clonedFromNodeId: 'node-different-source',
    userOverrides: {},
    policy: {},
  };
  const missingClonedFromNode = {
    id: 'node-no-cloned-from',
    workspace: '/repo/wt-manual',
    repoRoot: '/repo/wt-manual',
    daemonId: 'd1',
    isLocalWorktree: true,
    worktreeBranch: 'feat/unverified',
    userOverrides: {},
    policy: {},
  };
  const mesh = {
    id: 'mesh-x',
    name: 'x',
    repoIdentity: 'r',
    policy: {},
    coordinator: {},
    createdAt: '',
    updatedAt: '',
    nodes: [source, preExistingSameBranch],
  };

  transport.command = async (command) => {
    if (command === 'get_mesh') {
      return {
        success: true,
        mesh: {
          ...mesh,
          nodes: [source, preExistingSameBranch, wrongSourceNode, missingClonedFromNode],
        },
      };
    }
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_d, command) => {
    if (command === 'plan_mesh_onboarding') {
      return { success: true, plan: { operation: 'clone_worktree' } };
    }
    if (command === 'clone_mesh_node') {
      throw new Error('Daemon IPC mesh_command timed out after 120s (requestId=req-unverified-1)');
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const parsed = JSON.parse(await meshCloneNode({ mesh, transport } as any, {
    source_node_id: 'node-src',
    branch: 'feat/unverified',
  }));

  assert.equal(parsed.success, false);
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.status, 'unknown');
  assert.equal(parsed.node, undefined);
  assert.match(String(parsed.action || parsed.message || parsed.error || ''), /mesh_status/);
});


