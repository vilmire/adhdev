import assert from 'node:assert/strict';
import test from 'node:test';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshListNodes, meshStatus } from '../src/tools/mesh-tools.js';
import { buildMeshNodeCapabilityTags } from '@adhdev/daemon-core';

// (B) Capability tag visibility — mesh_list_nodes / mesh_status must surface the
// computed capability tags a node can match against required_tags routing, so a
// coordinator can see which tags are routable before authoring required_tags.

function makeMesh() {
  return {
    id: 'mesh-cap',
    name: 'Capability Mesh',
    repoIdentity: 'example/repo',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        id: 'node-main',
        workspace: '/repo',
        repoRoot: '/repo',
        daemonId: 'daemon-main',
        userOverrides: {},
        capabilities: ['gpu', 'staging'],
        policy: { providerPriority: ['claude-cli', 'codex-cli'] },
      },
      {
        id: 'node-worktree',
        workspace: '/repo/.adhdev-worktrees/feat-x',
        repoRoot: '/repo/.adhdev-worktrees/feat-x',
        daemonId: 'daemon-main',
        userOverrides: {},
        policy: { providerPriority: ['claude-cli'] },
        isLocalWorktree: true,
        worktreeBranch: 'feat/x',
      },
    ],
  };
}

function stubGetMesh(transport: any, mesh: any) {
  transport.command = async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'get_mesh') return { success: true, mesh: args.inlineMesh || mesh };
    // mesh_status probes git_status / get_status_metadata per node; return benign
    // empty results so the per-node entry assembly completes without a daemon.
    if (command === 'git_status') return { success: true, status: { isGitRepo: true, branch: 'main' } };
    if (command === 'get_status_metadata') return { success: true, sessions: [] };
    return { success: true };
  };
  transport.meshCommand = async (_daemonId: string, command: string, args: Record<string, unknown> = {}) => {
    if (command === 'git_status') return { success: true, result: { status: { isGitRepo: true, branch: 'feat/x' } } };
    if (command === 'get_status_metadata') return { success: true, result: { sessions: [] } };
    return { success: true, result: { success: true } };
  };
}

test('mesh_list_nodes surfaces computed capabilityTags + per-provider sets + operator capabilities', async () => {
  const mesh = makeMesh();
  const transport = new IpcTransport() as any;
  stubGetMesh(transport, mesh);

  const listed = JSON.parse(await meshListNodes({ mesh, transport, localDaemonId: 'daemon-main' } as any));
  const main = listed.nodes.find((n: any) => n.nodeId === 'node-main');
  const worktree = listed.nodes.find((n: any) => n.nodeId === 'node-worktree');

  // capabilityTags must equal what the routing matcher itself computes.
  assert.deepEqual(main.capabilityTags, buildMeshNodeCapabilityTags(mesh.nodes[0]));
  assert.ok(main.capabilityTags.includes('provider=claude-cli'), 'first provider tag present');
  assert.ok(main.capabilityTags.includes('converge=fast_forward'), 'non-worktree converge tag');
  assert.ok(main.capabilityTags.includes('gpu') && main.capabilityTags.includes('staging'), 'operator labels folded in');

  // per-provider tag sets cover every providerPriority entry.
  assert.deepEqual(Object.keys(main.capabilityTagsByProvider).sort(), ['claude-cli', 'codex-cli']);
  assert.ok(main.capabilityTagsByProvider['codex-cli'].includes('provider=codex-cli'));
  assert.ok(!main.capabilityTagsByProvider['codex-cli'].includes('provider=claude-cli'));

  // raw operator-defined capabilities surfaced separately.
  assert.deepEqual(main.capabilities, ['gpu', 'staging']);

  // worktree node advertises converge=refine + worktree=<branch>.
  assert.ok(worktree.capabilityTags.includes('converge=refine'));
  assert.ok(worktree.capabilityTags.includes('worktree=feat/x'));
  // no operator labels → no capabilities field.
  assert.equal(worktree.capabilities, undefined);
});

test('mesh_status node payloads carry capabilityTags for routing planning', async () => {
  const mesh = makeMesh();
  const transport = new IpcTransport() as any;
  stubGetMesh(transport, mesh);

  const status = JSON.parse(await meshStatus({ mesh, transport, localDaemonId: 'daemon-main' } as any, { verbose: true }));
  const nodes = Array.isArray(status.nodes) ? status.nodes : [];
  const main = nodes.find((n: any) => n.nodeId === 'node-main');
  assert.ok(main, 'node-main present in mesh_status');
  assert.ok(Array.isArray(main.capabilityTags) && main.capabilityTags.includes('provider=claude-cli'));
  assert.deepEqual(main.capabilities, ['gpu', 'staging']);
});

test('mesh_status compact mode (default) still surfaces capabilityTags per node', async () => {
  const mesh = makeMesh();
  const transport = new IpcTransport() as any;
  stubGetMesh(transport, mesh);

  const status = JSON.parse(await meshStatus({ mesh, transport, localDaemonId: 'daemon-main' } as any));
  const nodes = Array.isArray(status.nodes) ? status.nodes : [];
  const main = nodes.find((n: any) => n.nodeId === 'node-main');
  assert.ok(main, 'node-main present in compact mesh_status');
  assert.ok(
    Array.isArray(main.capabilityTags) && main.capabilityTags.includes('provider=claude-cli'),
    'compact node retains capabilityTags for routing planning',
  );
});
