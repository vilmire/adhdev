import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshCloneNode, meshLaunchSession, meshRemoveNode, meshStatus, meshListNodes, ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';

test('mesh worktree tools route clone/remove to the source node daemon and refresh MCP mesh context', async () => {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const calls: Array<{ daemonId: string; command: string; args: Record<string, unknown> }> = [];
  transport.command = async (command) => {
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (daemonId, command, args = {}) => {
    calls.push({ daemonId, command, args });
    if (command === 'clone_mesh_node') {
      return {
        success: true,
        node: {
          id: 'node-worktree',
          workspace: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
          repoRoot: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
          daemonId,
          userOverrides: {},
          policy: { canPush: true },
          isLocalWorktree: true,
          worktreeBranch: 'feat/x',
          clonedFromNodeId: 'node-source',
        },
        worktreePath: '/repo-parent/.adhdev-worktrees/mesh/feat-x',
        branch: 'feat/x',
      };
    }
    if (command === 'launch_cli') {
      return { success: true, sessionId: 'session-worktree' };
    }
    if (command === 'remove_mesh_node') {
      return { success: true, removed: true };
    }
    throw new Error(`unexpected mesh command: ${command}`);
  };

  const mesh = {
    id: 'mesh-worktree-flow',
    name: 'Worktree Flow',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [{
      id: 'node-source',
      workspace: '/repo',
      repoRoot: '/repo',
      daemonId: 'daemon-source',
      userOverrides: {},
      policy: { canPush: true },
    }],
  };
  const ctx = { mesh, transport };

  const cloneText = await meshCloneNode(ctx, { source_node_id: 'node-source', branch: 'feat/x' });
  assert.equal(JSON.parse(cloneText).success, true);
  assert.ok(ctx.mesh.nodes.some(node => node.id === 'node-worktree'));
  assert.equal(calls[0].daemonId, 'daemon-source');
  assert.equal(calls[0].command, 'clone_mesh_node');
  assert.equal(calls[0].args.meshId, 'mesh-worktree-flow');
  assert.equal(calls[0].args.sourceNodeId, 'node-source');
  assert.equal(calls[0].args.branch, 'feat/x');
  assert.equal(calls[0].args.baseBranch, undefined);
  assert.equal((calls[0].args.inlineMesh as typeof mesh).id, 'mesh-worktree-flow');

  const launchText = await meshLaunchSession(ctx, { node_id: 'node-worktree', type: 'hermes-cli' });
  assert.equal(JSON.parse(launchText).sessionId, 'session-worktree');
  assert.equal(calls[1].daemonId, 'daemon-source');
  assert.equal(calls[1].command, 'launch_cli');

  const removeText = await meshRemoveNode(ctx, { node_id: 'node-worktree' });
  assert.equal(JSON.parse(removeText).success, true);
  assert.ok(!ctx.mesh.nodes.some(node => node.id === 'node-worktree'));
  assert.equal(calls[2].daemonId, 'daemon-source');
  assert.equal(calls[2].command, 'remove_mesh_node');
});

test('mesh_git_status and mesh_remove_node refresh ctx.mesh from daemon cache when node was added by clone in another MCP process', async () => {
  // Simulates the live bug: clone_mesh_node ran in a different MCP server process,
  // so the new node exists in the daemon's inlineMeshCache but not in this process's ctx.mesh.
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  const newNode = {
    id: 'node-worktree-new',
    workspace: '/repo/.adhdev-worktrees/mesh/test-branch',
    repoRoot: '/repo/.adhdev-worktrees/mesh/test-branch',
    daemonId: 'daemon-source',
    userOverrides: {},
    policy: {},
    isLocalWorktree: true,
    worktreeBranch: 'test/branch',
    clonedFromNodeId: 'node-source',
  };

  const meshCommands: string[] = [];
  // Daemon has the new node in its cache (get_mesh returns it)
  transport.command = async (cmd, args = {}) => {
    if (cmd === 'get_mesh') {
      return {
        success: true,
        mesh: {
          id: 'mesh-stale',
          name: 'Stale Mesh',
          nodes: [
            { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
            newNode,
          ],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    throw new Error(`unexpected direct command: ${cmd}`);
  };
  transport.meshCommand = async (daemonId, command) => {
    meshCommands.push(command);
    if (command === 'git_status') return {
      success: true,
      result: {
        success: true,
        result: {
          status: {
            workspace: '/repo/.adhdev-worktrees/mesh/test-branch',
            repoRoot: '/repo/.adhdev-worktrees/mesh/test-branch',
            isGitRepo: true,
            branch: 'test/branch',
            staged: 0,
            modified: 1,
            untracked: 0,
            deleted: 0,
            renamed: 0,
            hasConflicts: false,
            conflictFiles: [],
          },
        },
      },
    };
    if (command === 'git_diff_summary') return {
      success: true,
      result: {
        success: true,
        result: {
          diffSummary: { files: [{ path: 'changed.ts', status: 'modified' }], totalInsertions: 2, totalDeletions: 0 },
        },
      },
    };
    if (command === 'remove_mesh_node') return { success: true, removed: true };
    throw new Error(`unexpected mesh command: ${command}`);
  };

  // ctx.mesh does NOT have node-worktree-new (stale snapshot from process start)
  const mesh = {
    id: 'mesh-stale',
    name: 'Stale Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'node-source', workspace: '/repo', repoRoot: '/repo', daemonId: 'daemon-source', userOverrides: {}, policy: {} },
    ],
  };
  const ctx = { mesh, transport };

  // mesh_status and mesh_list_nodes should refresh too; coordinators rely on
  // these surfaces to see/select a clone created by a previous MCP process.
  const statusText = await meshStatus(ctx as any);
  const status = JSON.parse(statusText);
  const statusNode = status.nodes.find((n: any) => n.nodeId === 'node-worktree-new');
  assert.ok(statusNode, 'mesh_status should include refreshed worktree node');
  assert.equal(statusNode.health, 'dirty', 'mesh_status should unwrap relayed git_status payload before deriving health');
  assert.equal(statusNode.branch, 'test/branch');
  assert.equal(statusNode.isDirty, true);
  assert.equal(statusNode.uncommittedChanges, 1);
  assert.ok(ctx.mesh.nodes.some(n => n.id === 'node-worktree-new'), 'ctx.mesh refreshed by mesh_status');

  const listText = await meshListNodes(ctx as any);
  const listed = JSON.parse(listText);
  assert.ok(listed.nodes.some((n: any) => n.nodeId === 'node-worktree-new'), 'mesh_list_nodes should include refreshed worktree node');

  // mesh_git_status on the new node should refresh and succeed
  const { meshGitStatus, meshRemoveNode } = await import('../src/tools/mesh-tools.js');
  const gitStatusText = await meshGitStatus(ctx, { node_id: 'node-worktree-new' });
  const gitStatus = JSON.parse(gitStatusText);
  assert.equal(gitStatus.nodeId, 'node-worktree-new', 'git_status should succeed after mesh refresh');
  assert.equal(gitStatus.status.branch, 'test/branch', 'git_status should unwrap nested relayed status payload');
  assert.equal(gitStatus.status.modified, 1);
  assert.deepEqual(gitStatus.diff.files, [{ path: 'changed.ts', status: 'modified' }]);
  // ctx.mesh should now include the new node
  assert.ok(ctx.mesh.nodes.some(n => n.id === 'node-worktree-new'), 'ctx.mesh refreshed with new node');

  // mesh_remove_node on the new node should also succeed
  const removeText = await meshRemoveNode(ctx, { node_id: 'node-worktree-new' });
  assert.equal(JSON.parse(removeText).success, true, 'remove_node should succeed after mesh refresh');
  assert.ok(!ctx.mesh.nodes.some(n => n.id === 'node-worktree-new'), 'node removed from ctx.mesh after remove');
  assert.ok(meshCommands.includes('remove_mesh_node'), 'remove_mesh_node relayed to daemon');
});

test('mesh tool registry documents the 10 exposed mesh tools including worktree clone/remove', () => {
  assert.equal(ALL_MESH_TOOLS.length, 10);
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_clone_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_remove_node'));
});
