import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshCloneNode } from '../src/tools/mesh-tools.js';
import { resolveMeshDispatchRoute } from '../src/tools/mesh-tools-internal.js';

// A clone onto a remote member goes straight to that member, so the coordinator daemon's
// own clone handler (which persists a forwarded clone) never runs. The tool must ask the
// coordinator daemon to learn the node from its owner, or the roster keeps it in memory only.

function makeCtx(direct: Array<{ command: string; args: Record<string, unknown> }>) {
  const transport = new IpcTransport() as IpcTransport & {
    command: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    meshCommand: (daemonId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const source = { id: 'node-src', workspace: '/repo/main', repoRoot: '/repo', daemonId: 'd-remote', userOverrides: {}, policy: {} };
  const mesh = { id: 'mesh-x', name: 'x', repoIdentity: 'r', policy: {}, coordinator: {}, createdAt: '', updatedAt: '', nodes: [source] };
  transport.command = async (command, args = {}) => {
    direct.push({ command, args });
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'mesh_adopt_member_worktree') return { success: true, adopted: true };
    throw new Error(`unexpected direct command: ${command}`);
  };
  transport.meshCommand = async (_d, command) => {
    if (command === 'plan_mesh_onboarding') return { success: true, plan: { operation: 'clone_worktree' } };
    if (command === 'clone_mesh_node') {
      return { success: true, node: { id: 'node-new', workspace: '/remote/wt', daemonId: 'd-remote', isLocalWorktree: true, worktreeBranch: 'feat/a', clonedFromNodeId: 'node-src', userOverrides: {}, policy: {} } };
    }
    if (command === 'git_status') return { success: true, status: { isGitRepo: true, branch: 'main' } };
    throw new Error(`unexpected mesh command: ${command}`);
  };
  return { mesh, transport };
}

test('mesh_clone_node on a remote member asks the coordinator daemon to adopt the node from its owner', async () => {
  const direct: Array<{ command: string; args: Record<string, unknown> }> = [];
  await meshCloneNode(makeCtx(direct) as any, { source_node_id: 'node-src', branch: 'feat/a' });
  const adopt = direct.find((c) => c.command === 'mesh_adopt_member_worktree');
  assert.ok(adopt, 'mesh_adopt_member_worktree was requested');
  assert.deepEqual(adopt!.args, { meshId: 'mesh-x', nodeId: 'node-new', ownerDaemonId: 'd-remote' });
});

test('mesh_dispatch_route refusal keeps its code and action for the caller', async () => {
  const ctx: any = {
    mesh: { id: 'mesh-x', nodes: [] },
    transport: {
      command: async (command: string) => {
        if (command === 'mesh_dispatch_route') return { success: false, code: 'mesh_node_unknown', error: 'Node x is not on the roster', action: 'Run mesh_status' };
        throw new Error(`unexpected: ${command}`);
      },
    },
  };
  const route = await resolveMeshDispatchRoute(ctx, 'node-src');
  assert.deepEqual(route, { route: 'error', reason: 'Node x is not on the roster', code: 'mesh_node_unknown', action: 'Run mesh_status' });
});
