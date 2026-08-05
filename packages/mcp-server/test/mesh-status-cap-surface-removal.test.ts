import assert from 'node:assert/strict';
import test from 'node:test';

import { meshStatus } from '../src/tools/mesh-tools.js';

// MESH-CAP-SURFACE-REMOVAL: the coordinator-facing `mesh_status` response used to
// surface the mesh-wide global parallel-task cap (policy.maxParallelTasks,
// scheduling.maxParallelTasks, scheduling.maxReadonlyParallelTasks,
// scheduling.activeWriteAssigned, scheduling.activeReadonlyAssigned,
// scheduling.globalWriteCapReached, scheduling.globalReadonlyCapReached). That
// number does not represent real concurrency — actual scheduling is governed
// per-node/per-slot (nodes[].scheduling.providerRoles / capReasons, still present) —
// and a coordinator reading the mesh-wide number narrated it as "N of M slots free",
// which misrepresented actual capacity. This test locks the fields OUT of the
// response surface. It does not touch buildMeshSchedulingRuntime or the
// maxParallelTasks auto-launch gate itself — see mesh-scheduling-runtime.test.ts and
// mesh-readonly-parallel-cap.test.ts (daemon-core) for those, unaffected by this change.

function buildCtx(policyOverrides: Record<string, unknown> = {}) {
  const mesh = {
    id: 'mesh-capsurface', name: 'Mesh', repoIdentity: 'vilmire/adhdev',
    policy: { maxParallelTasks: 8, schedulingStrategy: 'least_loaded', ...policyOverrides },
    coordinator: {},
    defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'node-a', workspace: '/a', repoRoot: '/a', daemonId: 'daemon-A', machineId: 'machine-A', userOverrides: {}, policy: { providerPriority: ['hermes-cli'] } },
    ],
  };
  const cleanGit = { isGitRepo: true, isDirty: false, branch: 'main', headCommit: 'abc', ahead: 0, behind: 0, submodules: [] };
  const responder = (command: string, args?: any) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'get_status_metadata') return { success: true, status: { sessions: [] } };
    if (command === 'git_status') return { success: true, status: cleanGit };
    return { success: true };
  };
  const transport: any = {};
  transport.command = async (c: string, a?: any) => responder(c, a);
  transport.meshCommand = async (_d: string, c: string, a?: any) => responder(c, a);
  return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'h' } };
}

test('mesh_status: policy.maxParallelTasks is stripped from the echoed policy', async () => {
  const { ctx } = buildCtx();
  const res = JSON.parse(await meshStatus(ctx as any));
  assert.ok(res.policy, 'policy object is still present');
  assert.equal(res.policy.maxParallelTasks, undefined, 'maxParallelTasks must not be echoed');
  // Other policy fields are preserved — this is a targeted omission, not a wholesale drop.
  assert.equal(res.policy.schedulingStrategy, 'least_loaded');
});

test('mesh_status: scheduling block carries only strategy, no global-cap numbers', async () => {
  const { ctx } = buildCtx();
  const res = JSON.parse(await meshStatus(ctx as any));
  assert.ok(res.scheduling, 'scheduling object is still present');
  assert.equal(res.scheduling.strategy, 'least_loaded');
  assert.equal(res.scheduling.maxParallelTasks, undefined);
  assert.equal(res.scheduling.maxReadonlyParallelTasks, undefined);
  assert.equal(res.scheduling.activeWriteAssigned, undefined);
  assert.equal(res.scheduling.activeReadonlyAssigned, undefined);
  assert.equal(res.scheduling.globalWriteCapReached, undefined);
  assert.equal(res.scheduling.globalReadonlyCapReached, undefined);
});

test('mesh_status verbose: per-node scheduling detail (provider caps) is unaffected', async () => {
  const { ctx } = buildCtx();
  // verbose:true disables compact-mode healthy-node folding (which drops per-node
  // detail regardless of this change) so the untouched nodes[].scheduling surface
  // is actually observable here.
  ctx.mesh.nodes[0].policy = { providerPriority: ['hermes-cli'], slots: [{ provider: 'claude-cli', maxParallel: 2 }] } as any;
  const res = JSON.parse(await meshStatus(ctx as any, { verbose: true } as any));
  const node = res.nodes.find((n: any) => n.nodeId === 'node-a');
  assert.ok(node, 'node present');
  assert.ok(node.scheduling, 'per-node scheduling detail is still present — only the mesh-wide global-cap surface was removed');
  assert.equal(node.scheduling.providerRoles?.[0]?.providerType, 'claude-cli', 'per-(node,provider) cap detail is untouched by the global-cap surface removal');
});
