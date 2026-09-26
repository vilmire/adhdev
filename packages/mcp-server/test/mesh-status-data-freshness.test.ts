import assert from 'node:assert/strict';
import test from 'node:test';

import { meshStatus } from '../src/tools/mesh-tools.js';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { heldMeshStatusFromResponder } from './helpers/held-node-state.js';
// REGRESSION: the daemon-core `mesh_status` command stamps a per-node
// `dataFreshness` marker (live | self | cached | unreachable | …) via
// finalizeMeshNodeStatus. But the COORDINATOR-FACING mesh_status MCP tool
// (mesh-tools.ts::meshStatus) builds its node list independently — a fresh
// per-node git_status probe — and never went through that path, so every node
// came back WITHOUT dataFreshness (null on the live coordinator). The
// daemon-core unit test passed because it asserts on the raw router output, a
// surface the coordinator never sees. These tests drive the actual MCP tool so
// the marker is exercised end-to-end on the path that was broken.
//
// Since 2026-09-26 (coordinator-held node git) the MCP tool no longer probes
// nodes live: node git comes from the coordinator daemon's held state and
// dataFreshness is DERIVED from each node's gitObservation — a remote peer's
// held truth reads 'cached' (with its age), never 'live'.
const OBSERVED_AT = Date.parse('2026-09-26T00:00:00.000Z');

function buildCtx() {
  const mesh = {
    id: 'mesh-freshness', name: 'Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
    defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [
      // Same-machine coordinator node (matches localDaemonId) → dataSource 'self'.
      { id: 'node-self', workspace: '/self', repoRoot: '/self', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
      // Remote peer whose git the coordinator holds (member push) → dataSource 'cached'.
      { id: 'node-live', workspace: '/live', repoRoot: '/live', daemonId: 'daemon-B', machineId: 'machine-B', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
      // Remote peer with no held truth whose background refresh fails → 'unreachable'.
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
  const responder = (command: string, args?: any): any => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'mesh_status') return heldMeshStatusFromResponder(mesh, responder, { localDaemonId: 'daemon-A', observedAt: OBSERVED_AT });
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'git_status') {
      if (args?.workspace === '/unreachable') throw new Error('git_status failed: p2p relay timeout reaching peer');
      return { success: true, status: cleanGit };
    }
    return { success: true };
  };
  const transport: any = {};
  transport.command = async (c: string, a?: any) => { if (isTurnIpcCommand(c)) return answerTurnIpc(c, a ?? {} as Record<string, unknown>); return responder(c, a); };
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
  const { ageMs: selfAgeMs, ...selfFreshness } = self.dataFreshness;
  assert.equal(typeof selfAgeMs, 'number', 'ageMs = now - the held observation time');
  assert.deepEqual(selfFreshness, {
    dataSource: 'self',
    probeOk: true,
    reachable: true,
    directPeerTruthSatisfied: true,
    projection: 'live_or_absent',
    lastProbeAt: new Date(OBSERVED_AT).toISOString(),
    staleness: 'fresh',
  });
  assert.deepEqual(self.gitObservation, { source: 'self', observedAt: OBSERVED_AT, refreshing: false, unreachableSince: null });

  assert.notEqual(live.folded, true, 'the daemon-B machine node is pinned to full detail');
  // Held remote truth is 'cached' with its real age — never claimed as live.
  assert.equal(live.dataFreshness?.dataSource, 'cached');
  assert.equal(live.dataFreshness?.probeOk, false);
  assert.equal(live.dataFreshness?.projection, 'cached');
  assert.equal(live.dataFreshness?.lastProbeAt, new Date(OBSERVED_AT).toISOString());
  assert.equal(live.gitObservation?.source, 'member_push');
  assert.equal(live.gitObservation?.observedAt, OBSERVED_AT);
  assert.equal(live.health, 'online', 'held git still drives health');

  // Degraded (probe threw) node stays detailed; the marker separates it from idle.
  assert.equal(unreach.dataFreshness?.dataSource, 'unreachable');
  assert.equal(unreach.dataFreshness?.probeOk, false);
  assert.equal(unreach.dataFreshness?.reachable, false);
  assert.equal(typeof unreach.gitObservation?.unreachableSince, 'number');
  assert.equal(unreach.degradedReason, 'node_unreachable');
});

test('verbose mesh_status carries dataFreshness on every node', async () => {
  const { ctx } = buildCtx();
  const verbose = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
  assert.equal(verbose.payloadMode, 'full');

  assert.equal(findNode(verbose.nodes, 'node-self').dataFreshness?.dataSource, 'self');
  assert.equal(findNode(verbose.nodes, 'node-live').dataFreshness?.dataSource, 'cached');
  assert.equal(findNode(verbose.nodes, 'node-live').gitObservation?.source, 'member_push');
  const unreach = findNode(verbose.nodes, 'node-unreach');
  assert.equal(unreach.dataFreshness?.dataSource, 'unreachable');
  assert.equal(unreach.dataFreshness?.reachable, false);
});
