import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshCloneNode, meshLaunchSession, meshRemoveNode, ALL_MESH_TOOLS } from '../src/tools/mesh-tools.js';

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

test('mesh tool registry documents the 10 exposed mesh tools including worktree clone/remove', () => {
  assert.equal(ALL_MESH_TOOLS.length, 10);
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_clone_node'));
  assert.ok(ALL_MESH_TOOLS.some(tool => tool.name === 'mesh_remove_node'));
});
