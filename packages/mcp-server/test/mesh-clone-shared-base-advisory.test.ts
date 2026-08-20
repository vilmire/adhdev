import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshCloneNode } from '../src/tools/mesh-tools.js';

type NodeShape = Record<string, unknown>;

function cloneContext(options: {
  source: NodeShape;
  existingWorktrees?: NodeShape[];
  sourceBranches: Record<string, string>;
}) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const clonedNode = {
    id: 'node-cloned',
    workspace: '/repo/.adhdev-worktrees/mesh/second',
    repoRoot: '/repo/.adhdev-worktrees/mesh/second',
    daemonId: String(options.source.daemonId),
    userOverrides: {},
    policy: {},
    isLocalWorktree: true,
    worktreeBranch: 'feat/second',
    clonedFromNodeId: String(options.source.id),
  };
  const mesh = {
    id: 'mesh-shared-base-advisory',
    name: 'Shared base advisory',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [options.source, ...(options.existingWorktrees || [])],
  };
  const seenCommands: string[] = [];

  transport.command = async (command) => {
    if (command === 'get_mesh') return { success: true, mesh };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_daemonId, command, args = {}) => {
    seenCommands.push(command);
    if (command === 'plan_mesh_onboarding') return { success: true, plan: { operation: 'clone_worktree' } };
    if (command === 'clone_mesh_node') return { success: true, node: clonedNode };
    if (command === 'git_status') {
      const branch = options.sourceBranches[String(args.workspace)];
      if (!branch) throw new Error(`no branch configured for ${String(args.workspace)}`);
      return { success: true, status: { isGitRepo: true, branch } };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  return { ctx: { mesh, transport }, clonedNode, seenCommands };
}

const sourceMain = {
  id: 'node-source-main',
  workspace: '/repo/main-checkout',
  repoRoot: '/repo',
  daemonId: 'daemon-source',
  userOverrides: {},
  policy: {},
};

test('mesh_clone_node emits no shared-base advisory for the first worktree', async () => {
  const { ctx, seenCommands } = cloneContext({
    source: sourceMain,
    sourceBranches: { '/repo/main-checkout': 'main' },
  });

  const result = JSON.parse(await meshCloneNode(ctx as any, {
    source_node_id: 'node-source-main', branch: 'feat/second', base_branch: 'wrong-input-must-not-group',
  }));

  assert.equal(result.success, true);
  assert.equal(result.sharedBaseWorktreeAdvisory, undefined);
  assert.deepEqual(seenCommands, ['plan_mesh_onboarding', 'clone_mesh_node']);
});

test('mesh_clone_node advises when its second worktree shares the source checkout base', async () => {
  const { ctx } = cloneContext({
    source: sourceMain,
    existingWorktrees: [{
      id: 'node-first', workspace: '/repo/.adhdev-worktrees/mesh/first', repoRoot: '/repo/.adhdev-worktrees/mesh/first',
      daemonId: 'daemon-source', userOverrides: {}, policy: {}, isLocalWorktree: true,
      worktreeBranch: 'feat/first', clonedFromNodeId: 'node-source-main',
    }],
    sourceBranches: { '/repo/main-checkout': 'main' },
  });

  const result = JSON.parse(await meshCloneNode(ctx as any, {
    source_node_id: 'node-source-main', branch: 'feat/second', base_branch: 'intentionally-ignored',
  }));

  assert.equal(result.success, true, 'the advisory must not change clone success');
  assert.equal(result.sharedBaseWorktreeAdvisory.baseBranch, 'main');
  assert.deepEqual(result.sharedBaseWorktreeAdvisory.siblingWorktrees, [
    { nodeId: 'node-first', branch: 'feat/first' },
    { nodeId: 'node-cloned', branch: 'feat/second' },
  ]);
  assert.match(result.sharedBaseWorktreeAdvisory.submoduleGitlinkWarning, /gitlink/i);
  assert.match(result.sharedBaseWorktreeAdvisory.convergenceGuidance, /mesh_refine_batch/);
  assert.match(result.sharedBaseWorktreeAdvisory.convergenceGuidance, /do not repeatedly call mesh_refine_node/i);
});

test('mesh_clone_node does not advise across different source checkout branches', async () => {
  const sourceRelease = {
    id: 'node-source-release', workspace: '/repo/release-checkout', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {},
  };
  const { ctx } = cloneContext({
    source: sourceRelease,
    existingWorktrees: [sourceMain, {
      id: 'node-main-worktree', workspace: '/repo/.adhdev-worktrees/mesh/main-sibling', repoRoot: '/repo/.adhdev-worktrees/mesh/main-sibling',
      daemonId: 'daemon-source', userOverrides: {}, policy: {}, isLocalWorktree: true,
      worktreeBranch: 'feat/main-sibling', clonedFromNodeId: 'node-source-main',
    }],
    sourceBranches: {
      '/repo/main-checkout': 'main',
      '/repo/release-checkout': 'release',
    },
  });

  const result = JSON.parse(await meshCloneNode(ctx as any, {
    source_node_id: 'node-source-release', branch: 'feat/second', base_branch: 'main',
  }));

  assert.equal(result.success, true);
  assert.equal(result.sharedBaseWorktreeAdvisory, undefined, 'base_branch input must not cause a false positive');
});

test('shared-base advisory is additive and does not block an otherwise successful clone', async () => {
  const { ctx } = cloneContext({
    source: sourceMain,
    existingWorktrees: [{
      id: 'node-first', workspace: '/repo/.adhdev-worktrees/mesh/first', repoRoot: '/repo/.adhdev-worktrees/mesh/first',
      daemonId: 'daemon-source', userOverrides: {}, policy: {}, isLocalWorktree: true,
      worktreeBranch: 'feat/first', clonedFromNodeId: 'node-source-main',
    }],
    sourceBranches: { '/repo/main-checkout': 'main' },
  });

  const result = JSON.parse(await meshCloneNode(ctx as any, {
    source_node_id: 'node-source-main', branch: 'feat/second',
  }));

  assert.equal(result.success, true);
  assert.equal(result.node.id, 'node-cloned');
  assert.ok(result.sharedBaseWorktreeAdvisory);
});
