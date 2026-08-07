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
      // A second quiet peer on daemon-A. The per-daemon representative pin keeps ONE
      // node per daemon in full detail, so this one is what actually reaches the
      // minimal stub — the surface this test needs in order to prove the stub carries
      // dataFreshness through. (It is deliberately not a worktree: a clean online
      // worktree gets a "merge to base" nextStepHint, which makes it noteworthy and
      // therefore detailed.)
      { id: 'node-quiet', workspace: '/quiet', repoRoot: '/quiet', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
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

  // The bug this guards: minimalCompactNode dropped dataFreshness, so quiet nodes
  // read as null on the coordinator. The marker must survive at BOTH detail levels.
  //
  // Which nodes reach the stub changed with the per-daemon representative pin: one
  // representative per daemon is now kept in full detail so a deploy roster can never
  // lose a machine, and the second quiet peer on daemon-A (node-quiet) is what folds
  // instead. The stub contract is asserted there; self/live are asserted as detailed.
  const quiet = findNode(compact.nodes, 'node-quiet');
  assert.equal(quiet.folded, true, 'the quiet non-representative node is folded to the minimal stub');
  assert.equal(quiet.dataFreshness?.dataSource, 'self', 'the minimal stub must carry dataFreshness through');
  assert.equal(quiet.dataFreshness?.probeOk, true);
  assert.equal(quiet.dataFreshness?.staleness, 'fresh');

  assert.notEqual(self.folded, true, 'the daemon-A machine node is pinned to full detail');
  // A self node is direct-peer-truth by construction (isSelfNode short-circuits the
  // probe), and only a 'cached' dataSource projects as 'cached' — self projects
  // live_or_absent. Both fields are part of the freshness contract, so the stub must
  // carry them through verbatim rather than dropping them.
  assert.deepEqual(self.dataFreshness, {
    dataSource: 'self',
    probeOk: true,
    reachable: true,
    directPeerTruthSatisfied: true,
    projection: 'live_or_absent',
    lastProbeAt: null,
    ageMs: null,
    staleness: 'fresh',
  });

  assert.notEqual(live.folded, true, 'the daemon-B machine node is pinned to full detail');
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
