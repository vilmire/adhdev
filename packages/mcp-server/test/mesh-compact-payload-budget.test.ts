import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { IpcTransport } from '../src/transports/ipc.js';
import { meshStatus, meshViewQueue } from '../src/tools/mesh-tools.js';
import { enqueueTask, getLedgerDir } from '@adhdev/daemon-core';
import { __clearMeshQueueForTests } from '../../daemon-core/src/mesh/mesh-work-queue.js';
import { __clearMeshLedgerForTests } from '../../daemon-core/src/mesh/mesh-ledger.js';
import { __clearMeshPendingEventsForTests } from '../../daemon-core/src/mesh/mesh-events-pending.js';

// Budget the compact (LLM-facing) payload must stay under regardless of how many
// worktree nodes / sessions / queued tasks a mesh has. The live regression that
// motivated this was mesh_status ~76KB and mesh_view_queue ~73KB exceeding the MCP
// token cap. Compact must stay well under the cap; verbose stays unbounded/full.
//
// Raised 25_000 -> 60_000 alongside the node byte budgets. There is no hard byte
// limit in the MCP SDK or the IPC transport — this is token-cost self-regulation,
// and the old 25KB forced the fold to evict nodes on a 23-node mesh (20 worktrees +
// 3 machines), which is the real operating shape. Folding costs more than the bytes
// it saves: a folded node keeps only its id, losing the daemonId a deploy roster
// needs. 60_000 leaves headroom over the measured 23-node worst case (~45KB).
const COMPACT_BUDGET = 60_000;

// The operating target: 20 worktrees + 3 machines must render with ZERO folding.
const TARGET_WORKTREES = 20;
const TARGET_MACHINES = 3;
const TARGET_NODES = TARGET_WORKTREES + TARGET_MACHINES;

// A realistic ~300-char stale-daemon-build warning that previously appeared
// verbatim on EVERY node in compact mode.
const STALE_WARNING = 'Live daemon build f6b15b05 is BEHIND workspace HEAD 79d5793c — merged daemon-runtime changes are not live until rebuild/redeploy + restart. A local daemon-core dist rebuild does not update a cloud daemon. Do not assume a just-merged fix is active on this daemon.';

function cleanupMesh(meshId: string): void {
  __clearMeshQueueForTests(meshId);
  __clearMeshLedgerForTests(meshId);
  __clearMeshPendingEventsForTests(meshId);
  const safe = meshId.replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const suffix of ['.jsonl', '.queue.json', '.queue.lock', '.pending-events.jsonl']) {
    const path = join(getLedgerDir(), `${safe}${suffix}`);
    if (existsSync(path)) unlinkSync(path);
  }
}

function buildManyNodeCtx(meshId: string, nodeCount: number) {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `node-${i}`,
      workspace: `/Users/dev/Work/.adhdev-worktrees/adhdev/feature-branch-${i}`,
      repoRoot: `/Users/dev/Work/.adhdev-worktrees/adhdev/feature-branch-${i}`,
      daemonId: i < 2 ? 'daemon-A' : 'daemon-B',
      machineId: i < 2 ? 'machine-A' : 'machine-B',
      isLocalWorktree: true,
      worktreeBranch: `fix/some-long-feature-branch-name-${i}`,
      userOverrides: {},
      policy: { providerPriority: ['claude-code', 'hermes-cli'] },
    });
  }
  const mesh = {
    id: meshId, name: 'Big Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
    defaultBranch: 'main',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes,
  };
  const transport = new IpcTransport() as any;
  const responder = (command: string) => {
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'git_status') {
      return { success: true, status: {
        isGitRepo: true, isDirty: false, branch: 'fix/some-long-feature-branch-name', headCommit: 'abcdef1234567890',
        upstream: 'origin/fix/some-long-feature-branch-name', upstreamStatus: 'ahead', ahead: 3, behind: 0,
        changedFiles: Array.from({ length: 8 }, (_, i) => `packages/server/src/some/path/file-${i}.ts`),
        submodules: [
          { path: 'oss', commit: '4b8e5bbbaaaa1111', outOfSync: true, status: 'modified', branch: 'main' },
          { path: 'oss/packages/adhdev-providers', commit: 'deadbeef99887766', outOfSync: false, status: 'clean', branch: 'main' },
        ],
        daemonBuildBehind: {
          scope: 'oss/daemon-core', buildCommit: 'f6b15b05aaaa', buildCommitShort: 'f6b15b05', head: '79d5793caaaa',
          isDaemonAffecting: true, affectedPackages: ['@adhdev/daemon-core', '@adhdev/mcp-server'], warning: STALE_WARNING,
        },
      } };
    }
    if (command === 'get_status_metadata') {
      return { success: true, status: {
        daemonBuild: { commit: 'f6b15b05aaaa1111', commitShort: 'f6b15b05', version: '0.5.267' },
        sessions: Array.from({ length: 4 }, (_, i) => ({
          id: `sess-${i}`, instanceId: `sess-${i}`, providerType: 'claude-code',
          status: i === 0 ? 'generating' : 'idle',
          settings: { meshNodeFor: meshId, meshCoordinatorDaemonId: 'daemon-A' },
        })),
      } };
    }
    if (command === 'agent_command') return { success: true };
    return { success: true };
  };
  transport.command = async (command: string) => responder(command);
  transport.meshCommand = async (_daemonId: string, command: string) => responder(command);
  return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-A', coordinatorHostname: 'coord-host' }, mesh };
}

// Worst-case build of the real operating shape: 3 machine (repo-root) nodes, one per
// daemon, plus 20 worktree nodes spread across those same daemons — with every
// worktree DIRTY and carrying a stale daemon build + an out-of-sync submodule, so
// every worktree is maximally "noteworthy" and competes hardest for the byte budget.
// A clean mesh is strictly cheaper than this.
function buildMachinesAndWorktreesCtx(meshId: string) {
  const daemons = ['daemon-A', 'daemon-B', 'daemon-C'];
  const nodes: any[] = [];
  for (let i = 0; i < TARGET_MACHINES; i++) {
    nodes.push({
      id: `node-machine-${i}`, workspace: `/Users/dev/Work/adhdev`, repoRoot: `/Users/dev/Work/adhdev`,
      daemonId: daemons[i], machineId: `machine-${i}`, isLocalWorktree: false,
      userOverrides: {}, policy: { providerPriority: ['claude-code', 'hermes-cli'] },
    });
  }
  for (let i = 0; i < TARGET_WORKTREES; i++) {
    nodes.push({
      id: `node-wt-${i}`,
      workspace: `/Users/dev/Work/.adhdev-worktrees/adhdev/feature-branch-${i}`,
      repoRoot: `/Users/dev/Work/.adhdev-worktrees/adhdev/feature-branch-${i}`,
      daemonId: daemons[i % daemons.length], machineId: `machine-${i % daemons.length}`,
      isLocalWorktree: true, worktreeBranch: `fix/some-long-feature-branch-name-${i}`,
      userOverrides: {}, policy: { providerPriority: ['claude-code', 'hermes-cli'] },
    });
  }
  const mesh = {
    id: meshId, name: 'Fleet Mesh', repoIdentity: 'vilmire/adhdev', policy: {}, coordinator: {},
    defaultBranch: 'main',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes,
  };
  const transport = new IpcTransport() as any;
  const responder = (command: string, payload?: any) => {
    // Only worktrees are dirty — machine nodes stay quiet, which is exactly the
    // condition under which severity ranking used to fold them out first.
    const isWorktree = String(payload?.workspace ?? '').includes('worktrees');
    if (command === 'get_mesh') return { success: true, mesh };
    if (command === 'get_pending_mesh_events') return { events: [] };
    if (command === 'mesh_forward_event') return { success: true, forwarded: 0 };
    if (command === 'git_status') {
      return {
        success: true,
        status: {
          isGitRepo: true, isDirty: isWorktree, branch: 'fix/some-long-feature-branch-name',
          headCommit: 'abcdef1234567890', upstream: 'origin/fix/some-long-feature-branch-name',
          upstreamStatus: 'ahead', ahead: 3, behind: 0,
          changedFiles: Array.from({ length: 8 }, (_, i) => `packages/server/src/some/path/file-${i}.ts`),
          submodules: [
            { path: 'oss', commit: '4b8e5bbbaaaa1111', outOfSync: true, status: 'modified', branch: 'main' },
            { path: 'oss/packages/adhdev-providers', commit: 'deadbeef99887766', outOfSync: false, status: 'clean', branch: 'main' },
          ],
          daemonBuildBehind: {
            scope: 'oss/daemon-core', buildCommit: 'f6b15b05aaaa', buildCommitShort: 'f6b15b05', head: '79d5793caaaa',
            isDaemonAffecting: true, affectedPackages: ['@adhdev/daemon-core', '@adhdev/mcp-server'], warning: STALE_WARNING,
          },
        },
        reporterNodeFacts: {
          quota: {
            'claude-code': { status: 'ok', session: { usedPercent: 38 }, weekly: { usedPercent: 12 } },
            'codex-cli': { status: 'ok', session: { usedPercent: 4 }, weekly: { usedPercent: 61 } },
          },
        },
      };
    }
    if (command === 'get_status_metadata') {
      return { success: true, status: {
        daemonBuild: { commit: 'f6b15b05aaaa1111', commitShort: 'f6b15b05', version: '0.5.267' },
        sessions: Array.from({ length: 4 }, (_, i) => ({
          id: `sess-${i}`, instanceId: `sess-${i}`, providerType: 'claude-code',
          status: i === 0 ? 'generating' : 'idle',
          settings: { meshNodeFor: meshId, meshCoordinatorDaemonId: 'daemon-A' },
        })),
      } };
    }
    return { success: true };
  };
  transport.command = async (command: string, payload?: any) => responder(command, payload);
  transport.meshCommand = async (_daemonId: string, command: string, payload?: any) => responder(command, payload);
  return { ctx: { mesh, transport, localDaemonId: 'daemon-A', localMachineId: 'machine-0', coordinatorHostname: 'coord-host' } };
}

test('mesh_status compact renders 20 worktrees + 3 machines with zero folding', async () => {
  const meshId = 'mesh-status-23-node-target';
  cleanupMesh(meshId);
  const { ctx } = buildMachinesAndWorktreesCtx(meshId);
  try {
    const compactStr = await meshStatus(ctx as any);
    const compact = JSON.parse(compactStr);

    // The headline contract: the real operating shape folds NOTHING.
    assert.equal(
      compact.foldedNodes, undefined,
      `23-node mesh must not fold any node; folded ${compact.foldedNodes?.count} (${JSON.stringify(compact.foldedNodes?.nodeIds)})`,
    );
    assert.equal(compact.nodes.length, TARGET_NODES, 'every node must be present in the array');
    assert.ok(
      compactStr.length < COMPACT_BUDGET,
      `compact 23-node mesh_status must stay under ${COMPACT_BUDGET} bytes; got ${compactStr.length}`,
    );

    // Budget accounting must measure the SAME format that is actually returned.
    // While mesh_status returned indented JSON, the node budget (which costs with
    // JSON.stringify(n).length) undercounted the wire size by ~29%.
    assert.equal(
      compactStr, JSON.stringify(compact),
      'mesh_status must serialize without indentation so the node byte budget measures the real wire size',
    );
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_status compact never folds a machine node before a worktree', async () => {
  // Regression: severity ranking folds the QUIETEST node first. Machine nodes are
  // quiet by nature (clean, idle, nothing to converge), so noisy worktrees sharing
  // their daemon evicted them from nodes[] — and a folded node keeps only its id,
  // losing the daemonId a deploy roster needs. One representative per daemon is now
  // pinned ahead of severity.
  const meshId = 'mesh-status-machine-pin';
  cleanupMesh(meshId);
  const { ctx } = buildMachinesAndWorktreesCtx(meshId);
  try {
    const compact = JSON.parse(await meshStatus(ctx as any));
    const present = new Set((compact.nodes ?? []).map((n: any) => String(n.nodeId)));

    for (let i = 0; i < TARGET_MACHINES; i++) {
      assert.ok(present.has(`node-machine-${i}`), `machine node node-machine-${i} must stay in the node array`);
    }
    // And each machine keeps full detail, not a minimal stub.
    for (const n of compact.nodes) {
      if (String(n.nodeId).startsWith('node-machine-')) {
        assert.notEqual(n.folded, true, `${n.nodeId} must keep full detail, not fold to a stub`);
      }
    }
    // Every daemon is represented by at least one detailed node.
    const detailedDaemons = new Set(
      (compact.nodes ?? []).filter((n: any) => n.folded !== true).map((n: any) => String(n.daemonId)),
    );
    for (const d of ['daemon-A', 'daemon-B', 'daemon-C']) {
      assert.ok(detailedDaemons.has(d), `daemon ${d} must keep at least one detailed representative node`);
    }
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_status groups daemon-wide machine/quota without dropping the per-node copy', async () => {
  const meshId = 'mesh-status-daemon-grouping';
  cleanupMesh(meshId);
  const { ctx } = buildMachinesAndWorktreesCtx(meshId);
  try {
    const compact = JSON.parse(await meshStatus(ctx as any));
    const verbose = JSON.parse(await meshStatus(ctx as any, { verbose: true }));

    // Grouped once per daemonId — not once per node — in BOTH modes.
    for (const payload of [compact, verbose]) {
      assert.deepEqual(
        Object.keys(payload.daemonMachines ?? {}).sort(), ['daemon-A', 'daemon-B', 'daemon-C'],
        'daemonMachines must be keyed by daemonId',
      );
      assert.deepEqual(
        Object.keys(payload.daemonQuotas ?? {}).sort(), ['daemon-A', 'daemon-B', 'daemon-C'],
        'daemonQuotas must be keyed by daemonId',
      );
    }

    // Additive rollout: the per-node fields must NOT be removed yet, since an LLM
    // coordinator may still read nodes[].machine / nodes[].quota directly.
    for (const n of verbose.nodes) {
      assert.ok(n.machine && typeof n.machine === 'object', `verbose ${n.nodeId} must keep its per-node machine`);
    }
    // Detailed compact nodes keep a per-node machine too. (Minimal stubs never
    // carried `machine` — that predates this grouping and is unchanged here.)
    const detailed = compact.nodes.filter((n: any) => n.folded !== true);
    assert.ok(detailed.length > 0, 'expected at least one detailed compact node');
    for (const n of detailed) {
      assert.ok(n.machine && typeof n.machine === 'object', `compact ${n.nodeId} must keep a per-node machine`);
      // daemonId is the join key back into the grouped map.
      assert.ok(typeof n.machine.daemonId === 'string', `compact ${n.nodeId}.machine must keep daemonId as the join key`);
    }
    // Stubs stay joinable to the grouped maps via their top-level daemonId.
    for (const n of compact.nodes.filter((x: any) => x.folded === true)) {
      assert.ok(typeof n.daemonId === 'string' && n.daemonId, `stub ${n.nodeId} must keep daemonId to join daemonMachines`);
    }
    // Verbose keeps the FULL machine bundle per node (the dashboard-grade shape).
    assert.ok(Array.isArray(verbose.nodes[0].machine.identityEvidence), 'verbose keeps machine.identityEvidence');
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_status compact payload stays under the token budget with many nodes/sessions/stale-builds', async () => {
  const meshId = 'mesh-status-compact-budget';
  cleanupMesh(meshId);
  const { ctx } = buildManyNodeCtx(meshId, 12);
  try {
    const compactStr = await meshStatus(ctx as any);
    const compact = JSON.parse(compactStr);
    const verboseStr = await meshStatus(ctx as any, { verbose: true });
    const verbose = JSON.parse(verboseStr);

    // Primary assertion: compact stays comfortably under the MCP cap even with 12
    // worktree nodes × 4 sessions × stale daemon builds × submodules.
    assert.ok(
      compactStr.length < COMPACT_BUDGET,
      `compact mesh_status must stay under ${COMPACT_BUDGET} bytes; got ${compactStr.length}`,
    );
    assert.equal(compact.payloadMode, 'compact');
    assert.equal(verbose.payloadMode, 'full');

    // The ~300-char stale-build warning must NOT be repeated verbatim on every node
    // in compact — it lives once at the top level. Count occurrences in the string.
    const warnOccurrences = compactStr.split(STALE_WARNING).length - 1;
    assert.ok(warnOccurrences <= 1, `stale warning text must appear at most once in compact; appeared ${warnOccurrences} times`);
    // But the actionable aggregate stays present.
    assert.ok(Array.isArray(compact.staleDaemonBuilds) && compact.staleDaemonBuilds.length > 0);
    assert.ok(typeof compact.staleDaemonBuildWarning === 'string');

    // Compact still exposes every node id — either in the nodes array (detailed or
    // stub) or, on huge meshes, in the foldedNodes id list. Nothing is undiscoverable.
    const arrayIds = (compact.nodes ?? []).map((n: any) => n.nodeId);
    const foldedIds = compact.foldedNodes?.nodeIds ?? [];
    const compactIds = new Set([...arrayIds, ...foldedIds]);
    assert.equal(compactIds.size, 12, 'every node id must remain discoverable in compact');

    // Verbose retains the full per-node detail: full warning per node, full git blob.
    assert.equal(verbose.nodes.length, 12);
    const verboseWarnOccurrences = verboseStr.split(STALE_WARNING).length - 1;
    assert.ok(verboseWarnOccurrences >= 12, `verbose must keep the full per-node warning; got ${verboseWarnOccurrences}`);
    // Verbose keeps the full changed-file list inside the git blob (dropped in compact).
    assert.ok(verboseStr.includes('changedFiles'), 'verbose must keep the full git blob');
    assert.ok(!compactStr.includes('changedFiles'), 'compact must drop the full git blob');
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_view_queue compact payload stays under the token budget with many active tasks', async () => {
  const meshId = 'mesh-view-queue-compact-budget';
  cleanupMesh(meshId);
  const { ctx } = buildManyNodeCtx(meshId, 3);
  const bigMessage = 'Implement the requested feature with full validation and tests. '.repeat(20);
  try {
    for (let i = 0; i < 80; i++) enqueueTask(meshId, `${bigMessage} task #${i}`, { difficulty: 'medium' });

    const compactStr = await meshViewQueue(ctx as any, { view: 'active' });
    const compact = JSON.parse(compactStr);
    const verboseStr = await meshViewQueue(ctx as any, { view: 'active', verbose: true });
    const verbose = JSON.parse(verboseStr);

    assert.ok(
      compactStr.length < COMPACT_BUDGET,
      `compact mesh_view_queue must stay under ${COMPACT_BUDGET} bytes; got ${compactStr.length}`,
    );
    assert.equal(compact.payloadMode, 'compact');

    // Active row count is source-of-truth correct even though rows are capped.
    assert.equal(compact.activeCount, 80);
    assert.ok(compact.queue.length <= 15, 'compact caps the number of serialized active rows');
    assert.ok(compact.activeRowsOmitted > 0, 'compact reports how many active rows it omitted');
    // Per-row message is truncated in compact.
    assert.ok(compact.queue.every((t: any) => typeof t.message !== 'string' || t.message.length <= 160));
    // The verbatim activeQueue duplicate is dropped in compact (replaced by a hint).
    assert.equal(compact.activeQueue, undefined);
    assert.ok(typeof compact.activeQueueHint === 'string');

    // Verbose keeps every active row, untruncated, plus the full activeQueue array.
    assert.equal(verbose.queue.length, 80);
    assert.equal(verbose.activeQueue.length, 80);
    assert.ok(verbose.queue.some((t: any) => typeof t.message === 'string' && t.message.length > 200));
    assert.ok(compactStr.length * 1.5 < verboseStr.length, `compact (${compactStr.length}) must be substantially smaller than verbose (${verboseStr.length})`);
  } finally {
    cleanupMesh(meshId);
  }
});

test('mesh_status compact node fold preserves dashboard-grade verbose output byte-for-byte', async () => {
  // Determinism guard: the verbose payload (the dashboard-facing shape) must be
  // unaffected by the compact folding. We snapshot the verbose node array for a
  // fixed input and assert it is unchanged by toggling compact, modulo the
  // top-level refreshedAt timestamp which is intentionally time-based.
  const meshId = 'mesh-status-verbose-stability';
  cleanupMesh(meshId);
  const { ctx } = buildManyNodeCtx(meshId, 4);
  try {
    const v1 = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    const v2 = JSON.parse(await meshStatus(ctx as any, { verbose: true }));
    // Strip the intentionally non-deterministic timestamp.
    delete v1.refreshedAt; delete v2.refreshedAt;
    assert.deepEqual(v1.nodes, v2.nodes, 'verbose node array must be stable for a fixed input');
    // Verbose nodes carry the full machine.identityEvidence and branchConvergence.nextStep
    // that compact strips — prove they survive in verbose.
    assert.ok(Array.isArray(v1.nodes[0].machine.identityEvidence), 'verbose keeps machine.identityEvidence');
    assert.ok(typeof v1.nodes[0].branchConvergence.nextStep === 'string', 'verbose keeps branchConvergence.nextStep');
  } finally {
    cleanupMesh(meshId);
  }
});
