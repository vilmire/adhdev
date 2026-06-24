import assert from 'node:assert/strict';
import test from 'node:test';

import { meshStatus } from '../src/tools/mesh-tools.js';

// REGRESSION: the daemon-core `mesh_status` command stamps a per-node
// `dataFreshness` marker (live | self | cached | unreachable | …) via
// finalizeMeshNodeStatus. But the COORDINATOR-FACING mesh_status MCP tool
// (mesh-tools.ts::meshStatus) builds its node list independently — a fresh
// per-node git_status probe — and never went through that path, so every node
// came back WITHOUT dataFreshness (null on the live coordinator). The
// daemon-core unit test passed because it asserts on the raw router output, a
// surface the coordinator never sees. These tests drive the actual MCP tool so
// the marker is exercised end-to-end on the path that was broken.

function buildCtx() {
  const mesh = {
    id: 'mesh-freshness', name: 'Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
    defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [
      // Same-machine coordinator node (matches localDaemonId) → dataSource 'self'.
      { id: 'node-self', workspace: '/self', repoRoot: '/self', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
      // Reachable remote peer whose fresh probe succeeds → dataSource 'live'.
      { id: 'node-live', workspace: '/live', repoRoot: '/live', daemonId: 'daemon-B', machineId: 'machine-B', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
      // Remote peer whose probe throws (no held truth) → dataSource 'unreachable'.
      { id: 'node-unreach', workspace: '/unreachable', repoRoot: '/unreachable', daemonId: 'daemon-C', machineId: 'machine-C', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
    ],
  };
  const cleanGit = { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc', ahead: 0, behind: 0, submodules: [] };
  const responder = (command: string, args?: any) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'git_status') {
      if (args?.workspace === '/unreachable') throw new Error('git_status failed: p2p relay timeout reaching peer');
      return { success: true, status: cleanGit };
    }
    return { success: true };
  };
  const transport: any = {};
  transport.command = async (c: string, a?: any) => responder(c, a);
  transport.meshCommand = async (_d: string, c: string, a?: any) => responder(c, a);
  return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' } };
}

function findNode(nodes: any[], id: string) {
  const n = nodes.find((node: any) => node.nodeId === id);
  assert.ok(n, `node ${id} present in response`);
  return n;
}

test('compact mesh_status stamps dataFreshness on every node — including quiet/stubbed ones', async () => {
  const { ctx } = buildCtx();
  const compact = JSON.parse(await meshStatus(ctx as any));
  assert.equal(compact.payloadMode, 'compact');

  const self = findNode(compact.nodes, 'node-self');
  const live = findNode(compact.nodes, 'node-live');
  const unreach = findNode(compact.nodes, 'node-unreach');

  // The clean, online, non-worktree self/live nodes are "quiet" → folded to the
  // minimal stub. The bug was that minimalCompactNode dropped dataFreshness, so
  // exactly these nodes read as null on the coordinator. Assert the stub keeps it.
  assert.equal(self.folded, true, 'quiet self node is folded to the minimal stub');
  assert.deepEqual(self.dataFreshness, {
    dataSource: 'self', probeOk: true, reachable: true, lastProbeAt: null, ageMs: null, staleness: 'fresh',
  });

  assert.equal(live.folded, true, 'quiet live node is folded to the minimal stub');
  assert.equal(live.dataFreshness?.dataSource, 'live');
  assert.equal(live.dataFreshness?.probeOk, true);
  assert.equal(live.dataFreshness?.reachable, true);
  assert.equal(live.dataFreshness?.staleness, 'fresh');

  // Degraded (probe threw) node stays detailed; the marker separates it from idle.
  assert.equal(unreach.dataFreshness?.dataSource, 'unreachable');
  assert.equal(unreach.dataFreshness?.probeOk, false);
  assert.equal(unreach.dataFreshness?.reachable, false);
});

test('verbose mesh_status carries dataFreshness on every node', async () => {
  const { ctx } = buildCtx();
  const verbose = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
  assert.equal(verbose.payloadMode, 'full');

  assert.equal(findNode(verbose.nodes, 'node-self').dataFreshness?.dataSource, 'self');
  assert.equal(findNode(verbose.nodes, 'node-live').dataFreshness?.dataSource, 'live');
  const unreach = findNode(verbose.nodes, 'node-unreach');
  assert.equal(unreach.dataFreshness?.dataSource, 'unreachable');
  assert.equal(unreach.dataFreshness?.reachable, false);
});
