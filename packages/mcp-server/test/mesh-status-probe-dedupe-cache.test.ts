import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectLiveStatusProbe,
  probeStatusMetadataForNode,
  __resetStatusMetadataProbeCacheForTests,
} from '../src/tools/mesh-tools-internal.js';
import { meshStatus } from '../src/tools/mesh-tools.js';

import { answerTurnIpc, isTurnIpcCommand } from './helpers/turn-ledger-ipc.js';
import { fakeCoordinatorTransport } from './helpers/fake-coordinator-tool-answers.js';
// AUDIT #7 / P7 (IPC load audit, 2026-09-23): mesh_status / mesh_view_queue /
// mesh_list_pending_approvals each iterated every MESH NODE and probed
// get_status_metadata per node, even though the probe is a DAEMON-WIDE
// snapshot — N worktree nodes sharing one daemon issued N identical probes.
// These tests pin the fix: probeStatusMetadataForNode (mesh-tools-internal.ts)
// dedupes concurrent callers onto the daemon's canonical id and caches the
// settled result for a short TTL, with `refresh: true` bypassing both.

function buildMesh(nodeDaemonPairs: Array<{ id: string; daemonId: string }>) {
  return {
    id: 'mesh-probe-dedupe',
    name: 'Probe Dedupe',
    repoIdentity: 'vilmire/adhdev',
    policy: {},
    coordinator: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: nodeDaemonPairs.map(({ id, daemonId }) => ({
      id,
      workspace: `/${id}`,
      repoRoot: `/${id}`,
      daemonId,
      machineId: `machine-for-${daemonId}`,
      userOverrides: {},
      policy: { providerPriority: ['hermes-cli'] },
    })),
  };
}

function buildTransport(onGetStatusMetadata: () => void) {
  const calls: Array<{ kind: 'command' | 'meshCommand'; command: string; daemonId?: string }> = [];
  const respond = (command: string) => {
    if (command === 'get_status_metadata') {
      onGetStatusMetadata();
      return { success: true, status: { instanceId: 'daemon_probe', sessions: [] } };
    }
    if (command === 'get_mesh') return { success: true, mesh: undefined };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'git_status') {
      return { success: true, status: { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc', ahead: 0, behind: 0, submodules: [] } };
    }
    return { success: true };
  };
  const transport: any = fakeCoordinatorTransport({
    command: async (command: string, _args?: any) => {
    if (isTurnIpcCommand(command)) return answerTurnIpc(command, _args ?? {} as Record<string, unknown>);
      calls.push({ kind: 'command', command });
      return respond(command);
    },
    meshCommand: async (daemonId: string, command: string, _args?: any) => {
      calls.push({ kind: 'meshCommand', command, daemonId });
      return respond(command);
    },
  });
  return { transport, calls };
}

test('probeStatusMetadataForNode: two nodes on the SAME daemon → one probe (dedupe)', async () => {
  __resetStatusMetadataProbeCacheForTests();
  let probeCount = 0;
  const { transport } = buildTransport(() => { probeCount += 1; });
  const mesh = buildMesh([
    { id: 'node-a', daemonId: 'daemon_mach_shared' },
    { id: 'node-b', daemonId: 'mach_shared' }, // same machine core, different id FORM
  ]);
  const ctx: any = { mesh, transport, localDaemonId: 'daemon_mach_coordinator', localMachineId: 'machine-coordinator' };

  const [a, b] = await Promise.all([
    collectLiveStatusProbe(ctx, mesh.nodes[0] as any),
    collectLiveStatusProbe(ctx, mesh.nodes[1] as any),
  ]);

  assert.equal(probeCount, 1, 'both nodes resolve to the same canonical daemon core and share one in-flight probe');
  assert.deepEqual(a, b, 'both callers observe the identical settled result');
});

test('probeStatusMetadataForNode: a second call within the TTL reuses the cached result (zero new probes)', async () => {
  __resetStatusMetadataProbeCacheForTests();
  let probeCount = 0;
  const { transport } = buildTransport(() => { probeCount += 1; });
  const mesh = buildMesh([{ id: 'node-a', daemonId: 'daemon_mach_shared' }]);
  const ctx: any = { mesh, transport, localDaemonId: 'daemon_mach_coordinator', localMachineId: 'machine-coordinator' };

  await probeStatusMetadataForNode(ctx, mesh.nodes[0] as any);
  assert.equal(probeCount, 1);

  // A second, sequential call (simulating a coordinator poll 5-30s later, well
  // inside the TTL) must NOT issue a second get_status_metadata.
  await probeStatusMetadataForNode(ctx, mesh.nodes[0] as any);
  assert.equal(probeCount, 1, 'cached result reused — no re-probe within the TTL window');
});

test('probeStatusMetadataForNode: refresh:true bypasses both the in-flight share and the cache', async () => {
  __resetStatusMetadataProbeCacheForTests();
  let probeCount = 0;
  const { transport } = buildTransport(() => { probeCount += 1; });
  const mesh = buildMesh([{ id: 'node-a', daemonId: 'daemon_mach_shared' }]);
  const ctx: any = { mesh, transport, localDaemonId: 'daemon_mach_coordinator', localMachineId: 'machine-coordinator' };

  await probeStatusMetadataForNode(ctx, mesh.nodes[0] as any);
  assert.equal(probeCount, 1);

  await probeStatusMetadataForNode(ctx, mesh.nodes[0] as any, { refresh: true });
  assert.equal(probeCount, 2, 'refresh:true forces a fresh probe even inside the TTL window');
});

test('probeStatusMetadataForNode: a rejected probe is not cached — the next call retries', async () => {
  __resetStatusMetadataProbeCacheForTests();
  let attempt = 0;
  const transport: any = {
    command: async (command: string, __ipcArgs?: Record<string, unknown>) => {
    if (isTurnIpcCommand(command)) return answerTurnIpc(command, __ipcArgs ?? {});
      if (command === 'get_status_metadata') {
        attempt += 1;
        if (attempt === 1) throw new Error('transient p2p relay timeout');
        return { success: true, status: { instanceId: 'daemon_probe', sessions: [] } };
      }
      return { success: true };
    },
    meshCommand: async () => { throw new Error('not used in this test'); },
  };
  const mesh = buildMesh([{ id: 'node-a', daemonId: 'daemon_mach_shared' }]);
  const ctx: any = { mesh, transport, localDaemonId: 'daemon_mach_coordinator', localMachineId: 'machine-coordinator' };

  await assert.rejects(() => probeStatusMetadataForNode(ctx, mesh.nodes[0] as any));
  assert.equal(attempt, 1);

  // The failed probe must not poison the cache for the TTL window — the very next
  // call (still "within 5s") should retry rather than replaying the rejection.
  const result = await probeStatusMetadataForNode(ctx, mesh.nodes[0] as any);
  assert.equal(attempt, 2, 'rejected probes are evicted immediately, not cached for the TTL');
  assert.equal((result as any)?.success, true);
});

test('end-to-end mesh_status: N remote nodes sharing one daemon are never probed — one local status read per call', async () => {
  __resetStatusMetadataProbeCacheForTests();
  let probeCount = 0;
  const mesh = buildMesh([
    { id: 'node-1', daemonId: 'daemon_mach_shared' },
    { id: 'node-2', daemonId: 'daemon_mach_shared' },
    { id: 'node-3', daemonId: 'daemon_mach_shared' },
  ]);
  const { transport } = buildTransport(() => { probeCount += 1; });
  transport.command = async (command: string, _args?: any) => {
    if (isTurnIpcCommand(command)) return answerTurnIpc(command, _args ?? {} as Record<string, unknown>);
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_status_metadata') {
      probeCount += 1;
      return { success: true, status: { instanceId: 'daemon_probe', sessions: [] } };
    }
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'git_status') {
      return { success: true, status: { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc', ahead: 0, behind: 0, submodules: [] } };
    }
    return { success: true };
  };
  const ctx: any = { mesh, transport, localDaemonId: 'daemon_mach_coordinator', localMachineId: 'machine-coordinator' };

  // Since the data-path audit (P1-6) mesh_status is ONE mesh_status_view: the
  // coordinator reads ITS OWN status once per call; the 3 remote nodes sharing a
  // daemon render from held state and are never probed (no per-node, no per-daemon read).
  const first = JSON.parse(await meshStatus(ctx));
  assert.equal(first.nodes.length, 3);
  assert.equal(probeCount, 1, 'one (local) get_status_metadata per call, never one per remote node/daemon');
  await meshStatus(ctx);
  assert.equal(probeCount, 2);
  await meshStatus(ctx, { refresh: true } as any);
  assert.equal(probeCount, 3, 'refresh:true does not add remote probes either');
  for (const node of first.nodes) assert.notEqual(node.runtimeObservation?.source, 'local_read', `${node.nodeId} is remote: held only`);
});
